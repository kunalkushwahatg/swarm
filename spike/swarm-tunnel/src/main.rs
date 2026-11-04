// swarm-tunnel: relay raw GGML RPC bytes over an encrypted QUIC link.
//
// Two roles:
//   serve  - runs next to ggml-rpc-server; accepts QUIC streams and pipes
//            each one to a local TCP RPC endpoint.
//   dial   - runs next to the coordinator; listens on a local TCP port and
//            pipes each accepted connection into a QUIC stream.
//
// The coordinator and ggml-rpc-server are unchanged: they still speak plain
// TCP to 127.0.0.1. Only this process touches the network.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use iroh::endpoint::{presets, Connection, RecvStream, SendStream};
use iroh::{address_lookup, Endpoint, EndpointAddr, EndpointId, RelayUrl, SecretKey};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

const ALPN: &[u8] = b"swarm/rpc/1";
// Separate ALPN so latency probes never touch RPC state.
const PROBE_ALPN: &[u8] = b"swarm/probe/1";

// GGML RPC wire constants. See ggml-rpc.cpp.
const CMD_DEVICE_COUNT: u8 = 15;
const CMD_HELLO: u8 = 14;
const CONN_CAPS_SIZE: usize = 24;
const HELLO_RSP_SIZE: usize = 4 + CONN_CAPS_SIZE;

const USAGE: &str = "\
swarm-tunnel <command> [options]

Commands:
  serve --rpc <addr> [--key <path> | --pair-code <code>]
      Accept QUIC peers and pipe each stream to the local RPC server.
      Prints 'PAIR_CODE <code>', 'ENDPOINT_ID <id>', 'RELAY_URL <url>',
      'DIRECT_ADDR <ip>' then 'READY'.

  dial --peer <endpoint-id> [--relay <url>] [--direct <addr>] --listen <addr> [--key <path>]
  dial --pair-code <code> --listen <addr> [--relay <url>]
      Dial a peer by endpoint id (or by the shared pairing code) and expose
      it on a local TCP port. Prints 'LISTENING <addr>'.

  probe --tcp <addr> [--count N]
      Measure real GGML RPC round-trip latency on a TCP endpoint.

  probe --peer <endpoint-id> [--relay <url>] [--direct <addr>] [--count N]
  probe --pair-code <code> [--count N]
      Measure QUIC round-trip latency over the tunnel.

  echo [--key <path> | --pair-code <code>]
      Echo server used by 'probe --peer' to isolate tunnel overhead.

  id [--key <path> | --pair-code <code>]
      Print the endpoint id for a key or pairing code without starting anything.

  info [--key <path> | --pair-code <code>]
      Print the full discovered addresses (direct IPs + relay URLs).
";

fn main() -> Result<()> {
    tracing_subscriber::fmt::try_init().ok();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        print!("{USAGE}");
        return Ok(());
    }

    let num_threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
        .clamp(2, 4);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(num_threads)
        .enable_all()
        .build()?;

    runtime.block_on(async move {
        match args[0].as_str() {
            "serve" => {
                serve(
                    flag(&args, "--rpc")?,
                    key_flag(&args),
                    pair_code_flag(&args),
                )
                .await
            }
            "dial" => {
                let peer_addr = parse_peer_addr(&args)?;
                dial(
                    peer_addr,
                    flag(&args, "--listen")?,
                    key_flag(&args),
                    pair_code_flag(&args),
                )
                .await
            }
            "probe" => match optional_flag(&args, "--tcp") {
                Some(addr) => probe_tcp(addr, count_flag(&args)).await,
                None => {
                    probe_quic(
                        parse_peer_addr(&args)?,
                        count_flag(&args),
                        pair_code_flag(&args),
                    )
                    .await
                }
            },
            "echo" => echo(key_flag(&args), pair_code_flag(&args)).await,
            "id" => {
                let key = resolve_key(key_flag(&args).as_deref(), pair_code_flag(&args).as_deref())?;
                println!("{}", key.public());
                Ok(())
            }
            "info" => info(key_flag(&args), pair_code_flag(&args)).await,
            other => {
                print!("{USAGE}");
                bail!("unknown command: {other}");
            }
        }
    })
}

fn flag(args: &[String], name: &str) -> Result<String> {
    optional_flag(args, name).with_context(|| format!("missing required {name}"))
}

fn optional_flag(args: &[String], name: &str) -> Option<String> {
    let idx = args.iter().position(|a| a == name)?;
    args.get(idx + 1).cloned()
}

fn key_flag(args: &[String]) -> Option<PathBuf> {
    optional_flag(args, "--key").map(PathBuf::from)
}

fn count_flag(args: &[String]) -> u32 {
    optional_flag(args, "--count")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(40)
}

fn pair_code_flag(args: &[String]) -> Option<String> {
    optional_flag(args, "--pair-code")
        .map(|c| normalize_pair_code(&c))
        .filter(|c| !c.is_empty())
}

/// Pairing codes are typed by hand, so accept spaces, dashes and any casing.
fn normalize_pair_code(code: &str) -> String {
    code.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_uppercase()
}

/// Derives a stable Iroh identity from a short human-typed pairing code.
///
/// Both the phone and the desktop hash the same code, so they converge on the
/// same endpoint id without a rendezvous server, account, or external VPN. The
/// code is the shared secret; hashing only expands it into a 32-byte key.
fn pair_code_key(code: &str) -> SecretKey {
    let normalized = normalize_pair_code(code);
    let mut hasher = Sha256::new();
    hasher.update(b"swarm-pair-v1:");
    hasher.update(normalized.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&digest);
    SecretKey::from_bytes(&bytes)
}

fn parse_peer(value: &str) -> Result<EndpointId> {
    EndpointId::from_str(value).context("invalid endpoint id")
}

fn parse_peer_addr(args: &[String]) -> Result<EndpointAddr> {
    // A pairing code deterministically yields the peer's endpoint id, which
    // lets a desktop dial a phone behind CGNAT with nothing but six digits.
    let peer = match pair_code_flag(args) {
        Some(code) => pair_code_key(&code).public(),
        None => parse_peer(&flag(args, "--peer")?)?,
    };
    let mut addr = EndpointAddr::new(peer);
    if let Some(r) = optional_flag(args, "--relay") {
        let url: RelayUrl = r.parse().context("invalid --relay URL")?;
        addr = addr.with_relay_url(url);
    }
    if let Some(d) = optional_flag(args, "--direct") {
        let sock: SocketAddr = d.parse().context("invalid --direct address")?;
        addr = addr.with_ip_addr(sock);
    }
    Ok(addr)
}

// A stable key means a stable endpoint id across restarts. Without this the
// phone would get a new id every launch and the desktop could never dial it.
fn load_or_create_key(path: Option<&Path>) -> Result<SecretKey> {
    let Some(path) = path else {
        return Ok(SecretKey::generate());
    };
    if path.exists() {
        let bytes = std::fs::read(path)?;
        let arr: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .with_context(|| format!("key file {} must be 32 bytes", path.display()))?;
        return Ok(SecretKey::from_bytes(&arr));
    }
    let key = SecretKey::generate();
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::write(path, key.to_bytes())?;
    eprintln!("[tunnel] created new identity at {}", path.display());
    Ok(key)
}

/// Resolves the identity for this run. A pairing code wins over a key file so
/// the peer can reproduce the same endpoint id from the same short code.
fn resolve_key(key: Option<&Path>, pair_code: Option<&str>) -> Result<SecretKey> {
    match pair_code {
        Some(code) if !code.trim().is_empty() => Ok(pair_code_key(code)),
        _ => load_or_create_key(key),
    }
}

async fn bind_endpoint(
    accept_streams: bool,
    key: Option<&Path>,
    pair_code: Option<&str>,
) -> Result<Endpoint> {
    let mut builder = Endpoint::builder(presets::Minimal)
        .secret_key(resolve_key(key, pair_code)?)
        .relay_mode(iroh::endpoint::default_relay_mode())
        .address_lookup(address_lookup::PkarrPublisher::n0_dns())
        .address_lookup(address_lookup::PkarrResolver::n0_dns());

    #[cfg(target_os = "android")]
    {
        // Android has no usable /etc/resolv.conf and ndk-context is not
        // initialized for a plain binary, so iroh cannot use JNI resolution.
        // The worker service passes the live network's DNS servers via
        // SWARM_DNS; fall back to public resolvers when none are supplied.
        let mut dns_builder = iroh::dns::DnsResolver::builder();
        let mut configured = false;
        if let Ok(list) = std::env::var("SWARM_DNS") {
            for part in list.split(',') {
                let part = part.trim();
                if part.is_empty() {
                    continue;
                }
                if let Ok(ip) = part.parse::<std::net::IpAddr>() {
                    dns_builder = dns_builder
                        .add_nameserver_config(iroh::dns::NameserverConfig::udp(ip).with_port(53));
                    configured = true;
                }
            }
        }
        if !configured && std::env::var("SWARM_DISABLE_PUBLIC_DNS").is_err() {
            for ip in ["8.8.8.8", "1.1.1.1"] {
                dns_builder = dns_builder.add_nameserver_config(
                    iroh::dns::NameserverConfig::udp(ip.parse().unwrap()).with_port(53),
                );
            }
        }
        builder = builder.dns_resolver(dns_builder.build());
    }

    #[cfg(not(target_os = "android"))]
    {
        builder = builder.address_lookup(address_lookup::DnsAddressLookup::n0_dns());
    }

    if accept_streams {
        builder = builder.alpns(vec![ALPN.to_vec(), PROBE_ALPN.to_vec()]);
    }
    Ok(builder.bind().await?)
}

fn emit(line: &str) {
    println!("{line}");
    std::io::Write::flush(&mut std::io::stdout()).ok();
}

// Waiting on the relay forever would hide a working LAN path, so bound it.
async fn announce_online(endpoint: &Endpoint) {
    match tokio::time::timeout(Duration::from_secs(45), endpoint.online()).await {
        Ok(()) => eprintln!("[tunnel] online (relay reachable)"),
        Err(_) => eprintln!("[tunnel] relay probe still in progress; direct dial works immediately"),
    }
}

async fn serve(rpc: String, key: Option<PathBuf>, pair_code: Option<String>) -> Result<()> {
    let rpc_addr: SocketAddr = rpc
        .parse()
        .with_context(|| format!("invalid --rpc address: {rpc}"))?;

    let endpoint = bind_endpoint(true, key.as_deref(), pair_code.as_deref()).await?;

    if let Some(code) = &pair_code {
        emit(&format!("PAIR_CODE {code}"));
    }
    emit(&format!("ENDPOINT_ID {}", endpoint.id()));

    // Emit direct addresses immediately so local dial can start with zero delay.
    let my_addr = endpoint.addr();
    for ip in my_addr.ip_addrs() {
        emit(&format!("DIRECT_ADDR {ip}"));
    }
    emit("READY");

    // Discover relays and publish to pkarr in the background.
    tokio::spawn({
        let endpoint = endpoint.clone();
        async move {
            announce_online(&endpoint).await;
            let my_addr = endpoint.addr();
            for r in my_addr.relay_urls() {
                emit(&format!("RELAY_URL {r}"));
            }
        }
    });

    loop {
        let Some(incoming) = endpoint.accept().await else {
            break;
        };
        tokio::spawn(async move {
            let conn = match incoming.await {
                Ok(conn) => conn,
                Err(err) => {
                    eprintln!("[tunnel] handshake failed: {err}");
                    return;
                }
            };
            eprintln!(
                "[tunnel] peer connected: {} alpn={}",
                conn.remote_id(),
                String::from_utf8_lossy(conn.alpn())
            );
            let is_probe = conn.alpn() == PROBE_ALPN;

            loop {
                match conn.accept_bi().await {
                    Ok((send, recv)) => {
                        tokio::spawn(async move {
                            let result = if is_probe {
                                echo_stream(send, recv).await
                            } else {
                                pipe_to_tcp(send, recv, rpc_addr).await
                            };
                            if let Err(err) = result {
                                eprintln!("[tunnel] stream ended: {err:#}");
                            }
                        });
                    }
                    Err(err) => {
                        eprintln!("[tunnel] connection closed: {err}");
                        break;
                    }
                }
            }
        });
    }

    Ok(())
}

async fn dial(
    peer: EndpointAddr,
    listen: String,
    key: Option<PathBuf>,
    _pair_code: Option<String>,
) -> Result<()> {
    let listen_addr: SocketAddr = listen
        .parse()
        .with_context(|| format!("invalid --listen address: {listen}"))?;

    // The dialer keeps its own ephemeral identity; the pairing code only
    // identifies the peer. Using the same key on both ends would make Iroh
    // treat the connection as a self-dial.
    let endpoint = bind_endpoint(false, key.as_deref(), None).await?;
    let slot: Arc<Mutex<Option<Connection>>> = Arc::new(Mutex::new(None));

    // Bind and announce the local port before touching the network. The
    // coordinator may start immediately, and the phone may wake up later; a
    // slow relay handshake must never delay LISTENING.
    let listener = TcpListener::bind(listen_addr).await?;
    emit(&format!("LISTENING {listen_addr}"));

    // Warm the connection in the background as an optimisation only.
    tokio::spawn({
        let endpoint = endpoint.clone();
        let slot = slot.clone();
        let peer = peer.clone();
        async move {
            match tokio::time::timeout(
                Duration::from_secs(20),
                endpoint.connect(peer.clone(), ALPN),
            )
            .await
            {
                Ok(Ok(conn)) => {
                    eprintln!("[tunnel] connected to {}", peer.id);
                    *slot.lock().await = Some(conn);
                }
                Ok(Err(err)) => {
                    eprintln!("[tunnel] initial connect failed: {err}; will retry on demand")
                }
                Err(_) => {
                    eprintln!("[tunnel] initial connect timed out; will retry on demand")
                }
            }
        }
    });

    loop {
        let (tcp, from) = listener.accept().await?;
        let endpoint = endpoint.clone();
        let slot = slot.clone();
        let peer = peer.clone();
        tokio::spawn(async move {
            let pair = match open_stream(&endpoint, peer, &slot).await {
                Ok(pair) => pair,
                Err(err) => {
                    eprintln!("[tunnel] cannot open stream for {from}: {err:#}");
                    return;
                }
            };
            let (send, recv) = pair;
            if let Err(err) = pipe_from_tcp(tcp, send, recv).await {
                eprintln!("[tunnel] stream ended: {err:#}");
            }
        });
    }
}

async fn open_stream(
    endpoint: &Endpoint,
    peer: EndpointAddr,
    slot: &Mutex<Option<Connection>>,
) -> Result<(SendStream, RecvStream)> {
    {
        let guard = slot.lock().await;
        if let Some(conn) = guard.as_ref() {
            match conn.open_bi().await {
                Ok(pair) => return Ok(pair),
                Err(err) => eprintln!("[tunnel] cached connection unusable: {err}; redialing"),
            }
        }
    }
    let conn = {
        let mut last_err: Option<anyhow::Error> = None;
        let mut conn = None;
        for attempt in 0..3u64 {
            match endpoint.connect(peer.clone(), ALPN).await {
                Ok(c) => {
                    conn = Some(c);
                    break;
                }
                Err(err) => {
                    last_err = Some(err.into());
                    tokio::time::sleep(Duration::from_millis(350 * (attempt + 1))).await;
                }
            }
        }
        match conn {
            Some(c) => c,
            None => {
                let err = last_err.unwrap_or_else(|| anyhow::anyhow!("dial failed"));
                return Err(err.context("dial failed"));
            }
        }
    };
    let pair = conn.open_bi().await.context("open stream failed")?;
    eprintln!("[tunnel] connected to {}", peer.id);
    *slot.lock().await = Some(conn);
    Ok(pair)
}

async fn echo_stream(mut send: SendStream, mut recv: RecvStream) -> Result<()> {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match recv.read(&mut buf).await {
            Ok(Some(0)) | Ok(None) | Err(_) => break,
            Ok(Some(n)) => send.write_all(&buf[..n]).await?,
        }
    }
    let _ = send.finish();
    Ok(())
}

async fn pipe_to_tcp(mut send: SendStream, mut recv: RecvStream, rpc: SocketAddr) -> Result<()> {
    let tcp = TcpStream::connect(rpc)
        .await
        .with_context(|| format!("cannot reach local RPC server at {rpc}"))?;
    tcp.set_nodelay(true).ok();
    let (mut tcp_read, mut tcp_write) = tcp.into_split();

    let up = async {
        let n = tokio::io::copy(&mut tcp_read, &mut send).await?;
        send.finish()?;
        Ok::<u64, std::io::Error>(n)
    };
    let down = async {
        let n = tokio::io::copy(&mut recv, &mut tcp_write).await?;
        tcp_write.shutdown().await?;
        Ok::<u64, std::io::Error>(n)
    };

    let (up_res, down_res) = tokio::join!(up, down);
    up_res?;
    down_res?;
    Ok(())
}

async fn pipe_from_tcp(
    tcp: TcpStream,
    mut send: SendStream,
    mut recv: RecvStream,
) -> Result<()> {
    tcp.set_nodelay(true).ok();
    let (mut tcp_read, mut tcp_write) = tcp.into_split();

    let up = async {
        let n = tokio::io::copy(&mut tcp_read, &mut send).await?;
        send.finish()?;
        Ok::<u64, std::io::Error>(n)
    };
    let down = async {
        let n = tokio::io::copy(&mut recv, &mut tcp_write).await?;
        tcp_write.shutdown().await?;
        Ok::<u64, std::io::Error>(n)
    };

    let (up_res, down_res) = tokio::join!(up, down);
    up_res?;
    down_res?;
    Ok(())
}

fn report(target: &str, connect_ms: Option<f64>, hello_ms: Option<f64>, mut samples: Vec<f64>) {
    println!("target      : {target}");
    if let Some(ms) = connect_ms {
        println!("tcp connect : {ms:.3} ms");
    }
    if let Some(ms) = hello_ms {
        println!("rpc hello   : {ms:.3} ms");
    }
    if samples.is_empty() {
        println!("samples     : 0");
        return;
    }
    let n = samples.len();
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mean = samples.iter().sum::<f64>() / n as f64;
    let mad = samples.iter().map(|v| (v - mean).abs()).sum::<f64>() / n as f64;
    let p = |q: f64| samples[((n as f64 * q) as usize).min(n - 1)];

    println!("samples     : {n}");
    println!("min         : {:.3} ms", samples[0]);
    println!("mean        : {:.3} ms", mean);
    println!("p50         : {:.3} ms", p(0.50));
    println!("p90         : {:.3} ms", p(0.90));
    println!("p95         : {:.3} ms", p(0.95));
    println!("p99         : {:.3} ms", p(0.99));
    println!("max         : {:.3} ms", samples[n - 1]);
    println!("mean abs dev: {:.3} ms", mad);
}

// Measures the exact path the coordinator uses: TCP connect, GGML RPC hello,
// then repeated DEVICE_COUNT round trips. DEVICE_COUNT has no side effects.
async fn probe_tcp(addr: String, count: u32) -> Result<()> {
    let addr: SocketAddr = addr
        .parse()
        .with_context(|| format!("invalid --tcp address: {addr}"))?;

    let start = Instant::now();
    let mut tcp = TcpStream::connect(addr)
        .await
        .with_context(|| format!("cannot connect to {addr}"))?;
    let connect_ms = start.elapsed().as_secs_f64() * 1000.0;
    tcp.set_nodelay(true).ok();

    let mut hello = Vec::with_capacity(9 + CONN_CAPS_SIZE);
    hello.push(CMD_HELLO);
    hello.extend_from_slice(&(CONN_CAPS_SIZE as u64).to_le_bytes());
    hello.extend_from_slice(&[0u8; CONN_CAPS_SIZE]);

    let start = Instant::now();
    tcp.write_all(&hello).await?;
    let mut len = [0u8; 8];
    tcp.read_exact(&mut len).await?;
    let hello_len = u64::from_le_bytes(len) as usize;
    if hello_len != HELLO_RSP_SIZE {
        bail!("unexpected hello response size {hello_len}, expected {HELLO_RSP_SIZE}");
    }
    let mut body = vec![0u8; hello_len];
    tcp.read_exact(&mut body).await?;
    let hello_ms = start.elapsed().as_secs_f64() * 1000.0;

    let mut ping = Vec::with_capacity(9);
    ping.push(CMD_DEVICE_COUNT);
    ping.extend_from_slice(&0u64.to_le_bytes());

    let mut samples = Vec::with_capacity(count as usize);
    for i in 0..count {
        let start = Instant::now();
        tcp.write_all(&ping).await?;
        tcp.read_exact(&mut len).await?;
        let rsp_len = u64::from_le_bytes(len) as usize;
        if rsp_len != 4 {
            bail!("unexpected DEVICE_COUNT response size {rsp_len}, expected 4");
        }
        let mut count_bytes = [0u8; 4];
        tcp.read_exact(&mut count_bytes).await?;
        // First three are warmup and stay out of the stats.
        if i >= 3 {
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    report(&addr.to_string(), Some(connect_ms), Some(hello_ms), samples);
    Ok(())
}

async fn probe_quic(peer: EndpointAddr, count: u32, pair_code: Option<String>) -> Result<()> {
    // Local probe identity is ephemeral; the pairing code only names the peer.
    let _ = pair_code;
    let endpoint = bind_endpoint(false, None, None).await?;
    let start = Instant::now();
    let mut conn = None;
    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 0..3u64 {
        match endpoint.connect(peer.clone(), PROBE_ALPN).await {
            Ok(c) => {
                conn = Some(c);
                break;
            }
            Err(err) => {
                last_err = Some(err.into());
                tokio::time::sleep(Duration::from_millis(400 * (attempt + 1))).await;
            }
        }
    }
    let conn = match conn {
        Some(c) => c,
        None => {
            let err = last_err.unwrap_or_else(|| anyhow::anyhow!("connect failed"));
            return Err(err.context("failed to connect to peer"));
        }
    };
    let connect_ms = start.elapsed().as_secs_f64() * 1000.0;
    let (mut send, mut recv) = conn.open_bi().await?;

    let payload = [0u8; 8];
    let mut reply = [0u8; 8];
    let mut samples = Vec::with_capacity(count as usize);

    for i in 0..count {
        let start = Instant::now();
        send.write_all(&payload).await?;
        recv.read_exact(&mut reply).await?;
        if i >= 3 {
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    report(&peer.id.to_string(), Some(connect_ms), None, samples);
    Ok(())
}

async fn info(key: Option<PathBuf>, pair_code: Option<String>) -> Result<()> {
    let endpoint = bind_endpoint(false, key.as_deref(), pair_code.as_deref()).await?;
    if let Some(code) = &pair_code {
        println!("PAIR_CODE {code}");
    }
    println!("ENDPOINT_ID {}", endpoint.id());
    eprintln!("[tunnel] probing relays and network interfaces (timeout 30s)...");
    let _ = tokio::time::timeout(Duration::from_secs(30), endpoint.online()).await;
    let addr = endpoint.addr();
    for r in addr.relay_urls() {
        println!("RELAY_URL {r}");
    }
    for ip in addr.ip_addrs() {
        println!("DIRECT_ADDR {ip}");
    }
    let _ = endpoint.close().await;
    Ok(())
}

async fn echo(key: Option<PathBuf>, pair_code: Option<String>) -> Result<()> {
    let endpoint = bind_endpoint(true, key.as_deref(), pair_code.as_deref()).await?;
    if let Some(code) = &pair_code {
        emit(&format!("PAIR_CODE {code}"));
    }
    emit(&format!("ENDPOINT_ID {}", endpoint.id()));
    announce_online(&endpoint).await;
    emit("READY");

    loop {
        let Some(incoming) = endpoint.accept().await else {
            break;
        };
        tokio::spawn(async move {
            let Ok(conn) = incoming.await else {
                return;
            };
            loop {
                let Ok((send, recv)) = conn.accept_bi().await else {
                    break;
                };
                tokio::spawn(async move {
                    let _ = echo_stream(send, recv).await;
                });
            }
        });
    }

    Ok(())
}
