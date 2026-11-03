//! Remote worker registration, network discovery, and endpoint reachability probes.

use std::path::Path;
use std::time::{Duration, Instant};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::io::{Read, Write};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::types::*;
use crate::supervisor::paths::{
    load_remote_workers, save_remote_workers, read_telemetry_token_if_exists,
    RemoteWorkerConfig,
};
use crate::supervisor::tunnel;
use crate::supervisor::win32::get_local_ip_addresses;

/// Probes a remote worker TCP endpoint directly with customizable timeout.
/// Evaluates reachability, measures real socket latency, and returns actionable recovery guidance on failure.
fn parse_metric_ms(text: &str, label: &str) -> Option<u64> {
    for line in text.lines() {
        if line.contains(label) && line.contains(':') {
            let part = line.split(':').nth(1)?.trim();
            let num_str = part.split_whitespace().next()?;
            if let Ok(val) = num_str.parse::<f64>() {
                return Some(val.round() as u64);
            }
        }
    }
    None
}

fn probe_quic_endpoint(
    endpoint_id: &str,
    pairing_code: Option<&str>,
) -> Option<(u64, u64, u64)> {
    let current_exe = std::env::current_exe().ok()?;
    let exe_dir = current_exe.parent()?;
    let candidates = [
        exe_dir.join("swarm-tunnel.exe"),
        exe_dir.join(r"bin\swarm-tunnel.exe"),
        exe_dir.join(r"resources\bin\swarm-tunnel.exe"),
        std::path::PathBuf::from(r"spike\swarm-tunnel\target\release\swarm-tunnel.exe"),
        std::path::PathBuf::from(r"target\release\swarm-tunnel.exe"),
    ];
    let tunnel_exe = crate::supervisor::tunnel::resolve_tunnel_exe()
        .or_else(|| candidates.iter().find(|p| p.exists()).cloned())?;

    // A pairing code already identifies the peer. Let DNS/pkarr resolve the
    // phone's current relay instead of pinning a region that may not be ours.
    let mut args: Vec<String> = vec!["probe".into()];
    match pairing_code.map(str::trim).filter(|c| !c.is_empty()) {
        Some(code) => {
            args.push("--pair-code".into());
            args.push(code.to_string());
        }
        None => {
            args.push("--peer".into());
            args.push(endpoint_id.to_string());
            // Pass the Asia-Pacific relay for low latency and fast 3-sample warmup
            args.push("--relay".into());
            args.push("https://aps1-1.relay.n0.iroh.link./".into());
        }
    }
    args.push("--count".into());
    args.push("3".into());

    let mut cmd = std::process::Command::new(tunnel_exe);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::supervisor::win32::CREATE_NO_WINDOW);
    }
    let output = cmd.output().ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let p50 = parse_metric_ms(&stdout, "p50").or_else(|| parse_metric_ms(&stdout, "tcp connect"))?;
    let p95 = parse_metric_ms(&stdout, "p95").unwrap_or(p50);
    let jitter = parse_metric_ms(&stdout, "mean abs dev").unwrap_or(0);
    Some((p50, p95, jitter))
}

fn quic_probe_result(host: &str, port: u16, p50: u64, p95: u64, jitter: u64) -> WorkerProbeResult {
    let quic_candidate = crate::supervisor::commands::types::TransportCandidate {
        transport: "iroh".to_string(),
        name: "Internet (QUIC Tunnel)".to_string(),
        reachable: true,
        p50_ms: p50,
        p95_ms: p95,
        jitter_ms: jitter,
        quality: if p95 < 300 {
            "Good (Cellular/WAN)".to_string()
        } else {
            "Fair (High Latency WAN)".to_string()
        },
        is_recommended: true,
    };
    WorkerProbeResult {
        reachable: true,
        host: host.to_string(),
        port,
        latency_ms: p50,
        status_state: "REACHABLE".to_string(),
        message: format!(
            "Connected via Internet QUIC Tunnel (p50: {} ms, p95: {} ms, jitter: ±{} ms).",
            p50, p95, jitter
        ),
        actionable_recovery: None,
        protocol_version: Some("GGML RPC v7.0 (QUIC Tunnel)".to_string()),
        network_quality: Some(if p95 < 300 {
            "Good (Internet QUIC)".to_string()
        } else {
            "Fair (Cellular WAN)".to_string()
        }),
        link_type: Some("Encrypted Internet Tunnel (QUIC / Cellular)".to_string()),
        p50_ms: Some(p50),
        p95_ms: Some(p95),
        jitter_ms: Some(jitter),
        transport: Some("iroh".to_string()),
        candidates: Some(vec![quic_candidate]),
    }
}

fn describe_link_type(host: &str, is_usb: bool) -> String {
    if host == "127.0.0.1" || host == "localhost" {
        return "Local Loopback".to_string();
    }
    if is_usb {
        return "USB Tethering (Wired)".to_string();
    }
    match host.parse::<std::net::Ipv4Addr>() {
        Ok(ip) if ip.is_private() => "Private Wi-Fi / Hotspot LAN".to_string(),
        _ => "Routed Network".to_string(),
    }
}

pub fn probe_remote_worker_endpoint_internal(host: &str, port: u16, timeout_ms: u64) -> WorkerProbeResult {
    use std::net::ToSocketAddrs;
    let t0 = std::time::Instant::now();
    let trimmed_host = host.trim();
    let addr_str = format!("{}:{}", trimmed_host, port);
    let timeout = std::time::Duration::from_millis(timeout_ms.min(1000).max(250));

    // A paired worker is reached through a local tunnel dialer, so a plain TCP
    // connect only proves the dialer is alive. Probe the encrypted link itself
    // so the UI never reports an offline phone as online.
    if trimmed_host == "127.0.0.1" || trimmed_host == "localhost" {
        let workers = load_remote_workers(std::path::Path::new("."));
        if let Some(w) = workers.iter().find(|w| {
            w.is_active
                && w.transport == "iroh"
                && w.port == port
                && (w.endpoint_id.is_some() || w.pairing_code.is_some())
        }) {
            let endpoint_id = w.endpoint_id.clone().unwrap_or_default();
            if let Some((p50, p95, jitter)) =
                probe_quic_endpoint(&endpoint_id, w.pairing_code.as_deref())
            {
                return quic_probe_result(trimmed_host, port, p50, p95, jitter);
            }
            return WorkerProbeResult {
                reachable: false,
                host: trimmed_host.to_string(),
                port,
                latency_ms: t0.elapsed().as_millis() as u64,
                status_state: "TIMED_OUT".to_string(),
                message: format!(
                    "The encrypted tunnel to '{}' did not answer. Keep Share Compute running on the phone.",
                    w.name
                ),
                actionable_recovery: Some(
                    "Open Swarm on the phone → Share Compute → Start Sharing, then check that the pairing code still matches."
                        .to_string(),
                ),
                protocol_version: None,
                network_quality: None,
                link_type: Some("Encrypted Internet Tunnel (QUIC / Cellular)".to_string()),
                p50_ms: None,
                p95_ms: None,
                jitter_ms: None,
                transport: Some("iroh".to_string()),
                candidates: None,
            };
        }
    }

    match addr_str.to_socket_addrs() {
        Ok(mut addrs) => {
            if let Some(sock_addr) = addrs.next() {
                match std::net::TcpStream::connect_timeout(&sock_addr, timeout) {
                    Ok(stream) => {
                        let initial_latency = t0.elapsed().as_millis() as u64;
                        drop(stream);

                        // Take up to 4 more fast samples to compute true p50/p95 and jitter
                        let mut samples = vec![initial_latency as f64];
                        for _ in 0..4 {
                            let s_t0 = std::time::Instant::now();
                            if let Ok(s) = std::net::TcpStream::connect_timeout(&sock_addr, std::time::Duration::from_millis(300)) {
                                drop(s);
                                samples.push(s_t0.elapsed().as_secs_f64() * 1000.0);
                            }
                        }
                        samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                        let n = samples.len();
                        let p50 = samples[((n as f64 * 0.50) as usize).min(n - 1)].round() as u64;
                        let p95 = samples[((n as f64 * 0.95) as usize).min(n - 1)].round() as u64;
                        let mean = samples.iter().sum::<f64>() / n as f64;
                        let jitter = (samples.iter().map(|v| (v - mean).abs()).sum::<f64>() / n as f64).round() as u64;

                        let quality = if p95 < 15 {
                            "Excellent (< 15 ms)"
                        } else if p95 < 45 {
                            "Good (Optimal Wi-Fi)"
                        } else if p95 < 90 {
                            "Fair (Jittery Link)"
                        } else {
                            "Poor (High Latency)"
                        };
                        let is_usb = trimmed_host
                            .parse::<std::net::Ipv4Addr>()
                            .map(crate::supervisor::win32::is_usb_tether_address)
                            .unwrap_or(false);
                        let link_type = describe_link_type(trimmed_host, is_usb);
                        let transport_name = if is_usb {
                            "USB Tethering (Wired)"
                        } else {
                            "Direct Wi-Fi / LAN"
                        };

                        let tcp_candidate = crate::supervisor::commands::types::TransportCandidate {
                            transport: "tcp".to_string(),
                            name: transport_name.to_string(),
                            reachable: true,
                            p50_ms: p50,
                            p95_ms: p95,
                            jitter_ms: jitter,
                            quality: quality.to_string(),
                            is_recommended: p95 < 50,
                        };

                        WorkerProbeResult {
                            reachable: true,
                            host: trimmed_host.to_string(),
                            port,
                            latency_ms: p50,
                            status_state: "REACHABLE".to_string(),
                            message: format!("Connected in {} ms (p50: {} ms, p95: {} ms, jitter: ±{} ms).", initial_latency, p50, p95, jitter),
                            actionable_recovery: None,
                            protocol_version: Some("GGML RPC v7.0".to_string()),
                            network_quality: Some(quality.to_string()),
                            link_type: Some(link_type.to_string()),
                            p50_ms: Some(p50),
                            p95_ms: Some(p95),
                            jitter_ms: Some(jitter),
                            transport: Some("tcp".to_string()),
                            candidates: Some(vec![tcp_candidate]),
                        }
                    }
                    Err(e) => {
                        let elapsed = t0.elapsed().as_millis() as u64;

                        // Transport Auto-Handover: If direct TCP timed out or was refused on this IP,
                        // check if this worker has announced an alternate active IP via LAN UDP discovery (e.g. Wi-Fi).
                        let workers = load_remote_workers(std::path::Path::new("."));
                        let matching_worker = workers.iter().find(|w| w.host.trim() == trimmed_host || w.id.contains(&trimmed_host.replace('.', "-")));
                        if let Some(target_w) = matching_worker {
                            let discovered = crate::supervisor::discovery::discover_workers(400);
                            if let Some(live) = discovered.iter().find(|d| {
                                (target_w.endpoint_id.is_some() && d.endpoint_id == target_w.endpoint_id)
                                    || (!d.name.is_empty() && d.name == target_w.name)
                            }) {
                                if live.host != trimmed_host {
                                    // Target device found on alternate network interface! Probe new endpoint.
                                    let alt_res = probe_remote_worker_endpoint_internal(&live.host, live.port, timeout_ms);
                                    if alt_res.reachable {
                                        // Automatically update registered worker to the new live IP
                                        let mut updated = target_w.clone();
                                        updated.host = live.host.clone();
                                        let _ = register_worker_internal(std::path::Path::new("."), updated);
                                        return alt_res;
                                    }
                                }
                            }
                        }

                        // Fallback: If direct TCP timed out or was refused, check if there is a known iroh endpoint_id
                        // for this worker in registered remote workers.
                        if let Some(matching_worker) = workers.iter().find(|w| w.host.trim() == trimmed_host || w.id.contains(&trimmed_host.replace('.', "-"))) {
                            if let Some(ep_id) = &matching_worker.endpoint_id {
                                if let Some((p50, p95, jitter)) =
                                    probe_quic_endpoint(ep_id, matching_worker.pairing_code.as_deref())
                                {
                                    return quic_probe_result(trimmed_host, port, p50, p95, jitter);
                                }
                            }
                        }

                        let raw_err = e.raw_os_error();
                        let is_refused = e.kind() == std::io::ErrorKind::ConnectionRefused || raw_err == Some(10061);
                        let is_timeout = e.kind() == std::io::ErrorKind::TimedOut || raw_err == Some(10060);

                        let (status_state, msg, recovery) = if is_refused {
                            (
                                "CONNECTION_REFUSED".to_string(),
                                format!("Connection refused by {}:{}. Computer is reachable, but no process is listening on port {}.", trimmed_host, port, port),
                                Some(format!("Start the worker daemon on Computer B using: .\\Start-RemoteWorker.ps1 -CoordinatorUrl 'http://<HOST_IP>:8080' (or ggml-rpc-server.exe --host 0.0.0.0 --port {})", port)),
                            )
                        } else if is_timeout {
                            (
                                "TIMED_OUT".to_string(),
                                format!("Connection attempt to {}:{} timed out after {} ms. Host is unresponsive or blocking incoming packets.", trimmed_host, port, elapsed),
                                Some(format!("Ensure both computers are on the same Wi-Fi / VPN network, and allow inbound TCP port {} on Computer B's Windows Defender Firewall: New-NetFirewallRule -DisplayName 'Swarm GGML RPC' -Direction Inbound -LocalPort {} -Protocol TCP -Action Allow", port, port)),
                            )
                        } else {
                            (
                                "ERROR".to_string(),
                                format!("TCP probe error connecting to {}:{}: {}", trimmed_host, port, e),
                                Some("Verify IP address, network cable/Wi-Fi connection, and subnet routing.".to_string()),
                            )
                        };
                        WorkerProbeResult {
                            reachable: false,
                            host: trimmed_host.to_string(),
                            port,
                            latency_ms: elapsed,
                            status_state,
                            message: msg,
                            actionable_recovery: recovery,
                            protocol_version: None,
                            network_quality: None,
                            link_type: None,
                            p50_ms: None,
                            p95_ms: None,
                            jitter_ms: None,
                            transport: None,
                            candidates: None,
                        }
                    }
                }
            } else {
                WorkerProbeResult {
                    reachable: false,
                    host: trimmed_host.to_string(),
                    port,
                    latency_ms: t0.elapsed().as_millis() as u64,
                    status_state: "INVALID_ADDRESS".to_string(),
                    message: format!("Unable to resolve address '{}'", trimmed_host),
                    actionable_recovery: Some("Enter a valid IPv4 address (e.g. 192.168.1.100) or reachable hostname.".to_string()),
                    protocol_version: None,
                    network_quality: None,
                    link_type: None,
                    p50_ms: None,
                    p95_ms: None,
                    jitter_ms: None,
                    transport: None,
                    candidates: None,
                }
            }
        }
        Err(e) => WorkerProbeResult {
            reachable: false,
            host: trimmed_host.to_string(),
            port,
            latency_ms: t0.elapsed().as_millis() as u64,
            status_state: "INVALID_ADDRESS".to_string(),
            message: format!("Address resolution failed for '{}:{}': {}", trimmed_host, port, e),
            actionable_recovery: Some("Check for typos in the IP address or host name.".to_string()),
            protocol_version: None,
            network_quality: None,
            link_type: None,
            p50_ms: None,
            p95_ms: None,
            jitter_ms: None,
            transport: None,
            candidates: None,
        },
    }
}

pub fn get_host_network_info_internal() -> HostNetworkInfo {
    let ips = get_local_ip_addresses();
    let preferred_ip = ips.first().cloned().unwrap_or_else(|| "127.0.0.1".to_string());
    let token = read_telemetry_token_if_exists();
    let hostname = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Host-PC".to_string());

    HostNetworkInfo {
        ip_addresses: ips,
        preferred_ip,
        coordinator_port: 8080,
        telemetry_token: token,
        hostname,
    }
}

pub fn get_registered_workers_internal(workspace_root: &std::path::Path) -> Vec<RemoteWorkerConfig> {
    load_remote_workers(workspace_root)
}

pub fn register_worker_internal(
    workspace_root: &std::path::Path,
    worker: RemoteWorkerConfig,
) -> Result<Vec<RemoteWorkerConfig>, String> {
    let mut workers = load_remote_workers(workspace_root);
    if let Some(existing) = workers.iter_mut().find(|w| w.id == worker.id || (w.host == worker.host && w.port == worker.port)) {
        *existing = worker;
    } else {
        workers.push(worker);
    }
    save_remote_workers(workspace_root, &workers)?;
    Ok(workers)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Result of pairing a phone or remote machine with a short code.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairWorkerResult {
    pub success: bool,
    pub message: String,
    pub worker: Option<RemoteWorkerConfig>,
    pub probe: Option<WorkerProbeResult>,
    pub workers: Vec<RemoteWorkerConfig>,
}

enum PairingTarget {
    Code(String),
    EndpointId(String),
    Direct { host: String, port: u16 },
}

fn decode_query_value(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = &value[i + 1..i + 3];
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Accepts the three shapes the UI can produce:
///   - a short pairing code such as `742918`
///   - a `swarm://pair?...` link (QR payload)
///   - a bare endpoint id or `host:port` address
fn parse_pairing_target(raw: &str) -> Result<PairingTarget, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("Enter the pairing code shown on the phone.".to_string());
    }

    if let Some(rest) = text.strip_prefix("swarm://") {
        let query = rest.split_once('?').map(|(_, q)| q).unwrap_or(rest);
        let mut code = None;
        let mut endpoint = None;
        let mut host = None;
        let mut port = None;
        for pair in query.split('&') {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            let value = decode_query_value(value);
            match key {
                "code" | "pairing_code" | "pairCode" => code = Some(value),
                "endpoint_id" | "endpointId" | "eid" | "peer" => endpoint = Some(value),
                "host" => host = Some(value),
                "port" => port = value.parse::<u16>().ok(),
                _ => {}
            }
        }
        if let Some(code) = code.filter(|c| !c.is_empty()) {
            return Ok(PairingTarget::Code(code));
        }
        if let Some(endpoint) = endpoint.filter(|e| !e.is_empty()) {
            return Ok(PairingTarget::EndpointId(endpoint));
        }
        if let (Some(host), Some(port)) = (host, port) {
            return Ok(PairingTarget::Direct { host, port });
        }
        return Err("That pairing link does not contain a usable code.".to_string());
    }

    // `host:port` (IPv4 or hostname). Skip bare IPv6 for now; the UI never
    // generates it and the tunnel path does not need it.
    if let Some((host, port)) = text.rsplit_once(':') {
        if !host.contains(':') {
            if let Ok(port) = port.parse::<u16>() {
                if !host.is_empty() {
                    return Ok(PairingTarget::Direct {
                        host: host.to_string(),
                        port,
                    });
                }
            }
        }
    }

    let compact: String = text.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if compact.is_empty() {
        return Err("Enter the pairing code shown on the phone.".to_string());
    }
    if compact.len() >= 40 && compact.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(PairingTarget::EndpointId(compact.to_ascii_lowercase()));
    }
    if compact.len() <= 12 {
        return Ok(PairingTarget::Code(compact.to_ascii_uppercase()));
    }
    Err("That pairing code looks incomplete. Copy the six-digit code or the full link from the phone.".to_string())
}

pub fn pair_worker_internal(
    workspace_root: &Path,
    raw: &str,
    name: Option<String>,
) -> Result<PairWorkerResult, String> {
    let target = parse_pairing_target(raw)?;

    let (host, port, transport, endpoint_id, pairing_code, tunnel_local_port) = match target {
        PairingTarget::Direct { host, port } => {
            (host, port, "tcp".to_string(), None, None, None)
        }
        PairingTarget::Code(code) => {
            let endpoint_id = tunnel::endpoint_id_for_pair_code(&code)?;
            let local_port = tunnel::start_dialer(&endpoint_id, Some(&code), None)?;
            (
                "127.0.0.1".to_string(),
                local_port,
                "iroh".to_string(),
                Some(endpoint_id),
                Some(code),
                Some(local_port),
            )
        }
        PairingTarget::EndpointId(endpoint_id) => {
            let local_port = tunnel::start_dialer(&endpoint_id, None, None)?;
            (
                "127.0.0.1".to_string(),
                local_port,
                "iroh".to_string(),
                Some(endpoint_id),
                None,
                Some(local_port),
            )
        }
    };

    let worker_name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| match &endpoint_id {
            Some(id) => format!("Paired phone · {}", &id[..8.min(id.len())]),
            None => format!("{}:{}", host, port),
        });

    let id = match &endpoint_id {
        Some(id) => format!("tunnel-{}", &id[..10.min(id.len())]),
        None => format!("worker-{}", host.replace('.', "-")),
    };

    // Validate the encrypted link before declaring success. A newly started
    // phone may need a few seconds to publish its relay record, so a failure
    // here is reported but the worker is still saved for a later retry.
    let mut probe = None;
    let mut warning = None;
    if transport == "iroh" {
        if let Some(id) = &endpoint_id {
            match probe_quic_endpoint(id, pairing_code.as_deref()) {
                Some((p50, p95, jitter)) => {
                    probe = Some(quic_probe_result(&host, port, p50, p95, jitter));
                }
                None => {
                    warning = Some(
                        "Saved. The phone has not answered yet — keep Share Compute running and refresh in a few seconds."
                            .to_string(),
                    );
                }
            }
        }
    } else {
        probe = Some(probe_remote_worker_endpoint_internal(&host, port, 1200));
    }

    let worker = RemoteWorkerConfig {
        id: id.clone(),
        name: worker_name,
        host,
        port,
        added_at_ms: now_ms(),
        is_active: true,
        transport,
        endpoint_id,
        direct_addr: None,
        pairing_code,
        relay_url: None,
        tunnel_local_port,
    };

    let workers = register_worker_internal(workspace_root, worker.clone())?;

    let message = warning.unwrap_or_else(|| {
        if probe.as_ref().map(|p| p.reachable).unwrap_or(false) {
            "Paired. This device is now available as an encrypted compute worker.".to_string()
        } else {
            "Saved. This device will appear once its worker is reachable.".to_string()
        }
    });

    Ok(PairWorkerResult {
        success: true,
        message,
        worker: Some(worker),
        probe,
        workers,
    })
}

#[tauri::command]
pub async fn supervisor_pair_worker(
    state: State<'_, SupervisorState>,
    code: String,
    name: Option<String>,
) -> Result<PairWorkerResult, String> {
    let workspace_root = state.workspace_root.clone();
    tokio::task::spawn_blocking(move || pair_worker_internal(&workspace_root, &code, name))
        .await
        .map_err(|e| format!("Pairing task failed: {e}"))?
}

pub fn remove_worker_internal(
    workspace_root: &Path,
    id: &str,
) -> Result<Vec<RemoteWorkerConfig>, String> {
    let mut workers = load_remote_workers(workspace_root);
    // Stop the local tunnel dialer before forgetting the worker, otherwise a
    // loopback port would stay bound for the rest of the session.
    for worker in workers.iter().filter(|w| w.id == id || format!("{}:{}", w.host, w.port) == id) {
        if let Some(endpoint_id) = &worker.endpoint_id {
            tunnel::stop_dialer(endpoint_id);
        }
    }
    workers.retain(|w| w.id != id && format!("{}:{}", w.host, w.port) != id);
    save_remote_workers(workspace_root, &workers)?;
    Ok(workers)
}

#[tauri::command]
pub async fn supervisor_probe_worker_endpoint(
    host: String,
    port: u16,
    timeout_ms: Option<u64>,
) -> Result<WorkerProbeResult, String> {
    tokio::task::spawn_blocking(move || {
        probe_remote_worker_endpoint_internal(&host, port, timeout_ms.unwrap_or(800))
    })
    .await
    .map_err(|e| format!("Probe worker task failed: {}", e))
}

#[tauri::command]
pub fn supervisor_get_host_network_info() -> HostNetworkInfo {
    get_host_network_info_internal()
}

#[tauri::command]
pub fn supervisor_get_registered_workers(
    state: State<'_, SupervisorState>,
) -> Vec<RemoteWorkerConfig> {
    get_registered_workers_internal(&state.workspace_root)
}

#[tauri::command]
pub fn supervisor_register_worker(
    state: State<'_, SupervisorState>,
    worker: RemoteWorkerConfig,
) -> Result<Vec<RemoteWorkerConfig>, String> {
    register_worker_internal(&state.workspace_root, worker)
}

#[tauri::command]
pub fn supervisor_remove_worker(
    state: State<'_, SupervisorState>,
    id: String,
) -> Result<Vec<RemoteWorkerConfig>, String> {
    remove_worker_internal(&state.workspace_root, &id)
}

/// Broadcasts a LAN discovery probe and returns every worker that answered.
///
/// Runs on a blocking thread because it waits for UDP replies.
#[tauri::command]
pub async fn supervisor_discover_workers(
    timeout_ms: Option<u64>,
) -> Result<Vec<crate::supervisor::discovery::DiscoveredWorker>, String> {
    tokio::task::spawn_blocking(move || {
        crate::supervisor::discovery::discover_workers(timeout_ms.unwrap_or(1200))
    })
    .await
    .map_err(|e| format!("Discovery task failed: {}", e))
}
