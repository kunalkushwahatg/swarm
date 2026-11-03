//! LAN auto-discovery for compute workers.
//!
//! The desktop broadcasts a small UDP probe and every running Swarm worker
//! answers it. Because the reply is unicast back to this socket, the source
//! address of the reply is the interface that actually reaches this machine —
//! USB tether, hotspot, or Wi-Fi — with no address guessing.
//!
//! This removes the need to type IP addresses, which is the single most
//! error-prone part of pairing a phone.

use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

pub const DISCOVERY_PORT: u16 = 50053;
const DISCOVERY_MAGIC: &str = "SWARM_DISCOVER";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredWorker {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub endpoint_id: Option<String>,
    pub platform: String,
    pub last_seen_ms: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Identity this host advertises when a peer broadcasts a discovery probe.
#[derive(Debug, Clone)]
pub struct AdvertiseIdentity {
    pub name: String,
    pub platform: String,
    pub port: u16,
    pub host: String,
    /// Real relay/tunnel identity when one exists. `None` is advertised as JSON
    /// null so peers fall back to direct TCP instead of dialling a fake endpoint.
    pub endpoint_id: Option<String>,
}

struct ResponderHandle {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

fn responder_slot() -> &'static Mutex<Option<ResponderHandle>> {
    static SLOT: OnceLock<Mutex<Option<ResponderHandle>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Starts answering `SWARM_DISCOVER` probes on UDP 50053.
///
/// Android already answers probes from its foreground service
/// (`SwarmWorkerService.startDiscoveryResponder`), so this is a no-op there to
/// avoid two responders racing on the same port.
pub fn start_responder(identity: AdvertiseIdentity) {
    let _ = &identity;
    if cfg!(target_os = "android") {
        return;
    }

    stop_responder();

    let payload = serde_json::json!({
        "v": 1,
        "platform": identity.platform,
        "name": identity.name,
        "port": identity.port,
        "host": identity.host,
        "endpoint_id": identity.endpoint_id,
    })
    .to_string();

    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = Arc::clone(&stop);

    let join = std::thread::Builder::new()
        .name("SwarmDiscoveryResponder".to_string())
        .spawn(move || {
            let socket = match UdpSocket::bind((Ipv4Addr::UNSPECIFIED, DISCOVERY_PORT)) {
                Ok(s) => s,
                Err(_) => return,
            };
            let _ = socket.set_read_timeout(Some(Duration::from_millis(400)));
            let mut buf = [0u8; 512];
            while !stop_thread.load(Ordering::Relaxed) {
                match socket.recv_from(&mut buf) {
                    Ok((len, src)) => {
                        let text = String::from_utf8_lossy(&buf[..len]);
                        if text.trim_start().starts_with(DISCOVERY_MAGIC) {
                            let _ = socket.send_to(payload.as_bytes(), src);
                        }
                    }
                    Err(_) => continue,
                }
            }
        })
        .ok();

    if let Ok(mut slot) = responder_slot().lock() {
        *slot = Some(ResponderHandle { stop, join });
    }
}

/// Stops the discovery responder if this host started one.
pub fn stop_responder() {
    let handle = responder_slot().lock().ok().and_then(|mut slot| slot.take());
    if let Some(handle) = handle {
        handle.stop.store(true, Ordering::Relaxed);
        if let Some(join) = handle.join {
            let _ = join.join();
        }
    }
}

/// True when `ip` belongs to one of this host's own interfaces, i.e. the reply
/// came from ourselves and must not be offered as a remote worker.
fn is_local_address(ip: &std::net::IpAddr, local_ips: &[String]) -> bool {
    if ip.is_loopback() {
        return true;
    }
    let needle = ip.to_string();
    local_ips.iter().any(|local| local == &needle)
}

fn broadcast_addr(ip: Ipv4Addr, prefix: u8) -> Ipv4Addr {
    let prefix = prefix.min(32);
    let mask: u32 = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix as u32)
    };
    Ipv4Addr::from(u32::from(ip) | !mask)
}

/// Local IPv4 addresses with their prefix lengths, from the Windows IP stack.
#[cfg(windows)]
fn local_ipv4_subnets() -> Vec<(Ipv4Addr, u8)> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const SCRIPT: &str = "Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.IPAddress)/$($_.PrefixLength)\" }";

    let mut out = Vec::new();
    if let Ok(output) = Command::new("powershell")
        .args(["-NoProfile", "-Command", SCRIPT])
        .creation_flags(crate::supervisor::win32::CREATE_NO_WINDOW)
        .output()
    {
        if output.status.success() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                if let Some((ip, prefix)) = line.trim().split_once('/') {
                    if let (Ok(ip), Ok(prefix)) = (ip.trim().parse(), prefix.trim().parse::<u8>()) {
                        let ip: Ipv4Addr = ip;
                        if !ip.is_loopback() && !ip.is_link_local() {
                            out.push((ip, prefix));
                        }
                    }
                }
            }
        }
    }
    out
}

#[cfg(not(windows))]
fn local_ipv4_subnets() -> Vec<(Ipv4Addr, u8)> {
    Vec::new()
}

/// Broadcasts a discovery probe and collects every worker that answers.
///
/// `timeout_ms` bounds how long to wait for replies. Results are de-duplicated
/// by `host:port`, keeping the most recent answer.
pub fn discover_workers(timeout_ms: u64) -> Vec<DiscoveredWorker> {
    let timeout = Duration::from_millis(timeout_ms.clamp(300, 5_000));
    let socket = match UdpSocket::bind("0.0.0.0:0") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let _ = socket.set_broadcast(true);
    let _ = socket.set_read_timeout(Some(Duration::from_millis(150)));

    // Resolve our own interface addresses exactly once. Querying the OS per
    // reply costs ~1 s on Windows and would blow the discovery deadline before
    // real peers get processed.
    let local_ips = crate::supervisor::win32::get_local_ip_addresses();

    let request = format!("{DISCOVERY_MAGIC} 1");
    let mut targets: Vec<SocketAddr> = vec![SocketAddr::from((Ipv4Addr::BROADCAST, DISCOVERY_PORT))];
    for (ip, prefix) in local_ipv4_subnets() {
        targets.push(SocketAddr::from((broadcast_addr(ip, prefix), DISCOVERY_PORT)));
    }
    targets.sort();
    targets.dedup();
    for target in targets {
        let _ = socket.send_to(request.as_bytes(), target);
    }

    let deadline = Instant::now() + timeout;
    let mut found: Vec<DiscoveredWorker> = Vec::new();
    let mut buf = [0u8; 2048];

    while Instant::now() < deadline {
        match socket.recv_from(&mut buf) {
            Ok((len, src)) => {
                // A host that is also sharing compute answers its own probe.
                // Drop those replies so the UI only lists real remote peers.
                if is_local_address(&src.ip(), &local_ips) {
                    continue;
                }
                let text = String::from_utf8_lossy(&buf[..len]);
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
                let host = src.ip().to_string();
                let port = value
                    .get("port")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(50052) as u16;
                let name = value
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Android device")
                    .to_string();
                let platform = value
                    .get("platform")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let endpoint_id = value
                    .get("endpoint_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                let worker = DiscoveredWorker {
                    name,
                    host,
                    port,
                    endpoint_id,
                    platform,
                    last_seen_ms: now_ms(),
                };

                if let Some(existing) = found
                    .iter_mut()
                    .find(|w| w.host == worker.host && w.port == worker.port)
                {
                    *existing = worker;
                } else {
                    found.push(worker);
                }
            }
            // A read timeout is expected; keep listening until the deadline.
            Err(_) => continue,
        }
    }

    found.sort_by(|a, b| a.host.cmp(&b.host));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broadcast_of_slash_24_is_dot_255() {
        let ip: Ipv4Addr = "192.168.137.1".parse().unwrap();
        assert_eq!(broadcast_addr(ip, 24), Ipv4Addr::new(192, 168, 137, 255));
    }

    #[test]
    fn broadcast_of_slash_32_is_self() {
        let ip: Ipv4Addr = "10.154.101.225".parse().unwrap();
        assert_eq!(broadcast_addr(ip, 32), ip);
    }
}
