//! Managed local dialers for the embedded Iroh tunnel.
//!
//! A phone on cellular data sits behind carrier-grade NAT, so the desktop
//! cannot open a TCP socket to its GGML RPC port. Instead the phone runs
//! `swarm-tunnel serve` and the desktop runs `swarm-tunnel dial`, which exposes
//! the phone's RPC server on a loopback port that the coordinator can use as if
//! it were local.
//!
//! Both ends derive the same Iroh identity from a short pairing code, so no
//! rendezvous service, account, or third-party VPN is involved.

use std::collections::HashMap;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::supervisor::paths::RemoteWorkerConfig;

struct Dialer {
    child: Child,
    local_port: u16,
}

fn dialers() -> &'static Mutex<HashMap<String, Dialer>> {
    static DIALERS: OnceLock<Mutex<HashMap<String, Dialer>>> = OnceLock::new();
    DIALERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Locates the tunnel binary in development and installed layouts.
pub fn resolve_tunnel_exe() -> Option<PathBuf> {
    let current_exe = std::env::current_exe().ok();
    let exe_dir = current_exe.as_ref().and_then(|p| p.parent());

    if let Some(dir) = exe_dir {
        for candidate in [
            dir.join("swarm-tunnel.exe"),
            dir.join(r"bin\swarm-tunnel.exe"),
            dir.join(r"resources\bin\swarm-tunnel.exe"),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // Walk up from the executable and the working directory so a debug build
    // launched from target/debug still finds the repo's release artifact.
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    if let Some(exe) = current_exe {
        roots.extend(exe.ancestors().map(|p| p.to_path_buf()));
    }
    for root in roots {
        for rel in [
            r"spike\swarm-tunnel\target\release\swarm-tunnel.exe",
            r"target\release\swarm-tunnel.exe",
        ] {
            let candidate = root.join(rel);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn free_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Could not reserve a local tunnel port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Could not read the local tunnel port: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn port_is_open(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(250),
    )
    .is_ok()
}

/// Returns the endpoint id for a short pairing code by asking the tunnel.
pub fn endpoint_id_for_pair_code(code: &str) -> Result<String, String> {
    let exe = resolve_tunnel_exe()
        .ok_or_else(|| "The encrypted tunnel component is missing from this installation.".to_string())?;
    let mut cmd = Command::new(exe);
    cmd.args(["id", "--pair-code", code]);
    cmd.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::supervisor::win32::CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("Could not read the pairing code: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if id.is_empty() {
        return Err("The pairing code did not produce a tunnel identity.".to_string());
    }
    Ok(id)
}

/// Starts (or reuses) a loopback dialer for one remote tunnel peer.
///
/// The returned port is already accepting local TCP connections, so the
/// coordinator can be pointed at it immediately.
pub fn start_dialer(
    endpoint_id: &str,
    pairing_code: Option<&str>,
    preferred_port: Option<u16>,
) -> Result<u16, String> {
    {
        let mut map = dialers().lock().unwrap();
        if let Some(existing) = map.get_mut(endpoint_id) {
            match existing.child.try_wait() {
                Ok(None) if port_is_open(existing.local_port) => return Ok(existing.local_port),
                _ => {
                    let _ = existing.child.kill();
                    let _ = existing.child.wait();
                    map.remove(endpoint_id);
                }
            }
        }
    }

    let exe = resolve_tunnel_exe()
        .ok_or_else(|| "The encrypted tunnel component is missing from this installation.".to_string())?;

    let port = match preferred_port {
        Some(p) if !port_is_open(p) => p,
        _ => free_loopback_port()?,
    };

    let mut cmd = Command::new(exe);
    cmd.arg("dial");
    match pairing_code.map(str::trim).filter(|c| !c.is_empty()) {
        Some(code) => {
            cmd.arg("--pair-code").arg(code);
        }
        None => {
            cmd.arg("--peer").arg(endpoint_id);
        }
    }
    cmd.arg("--listen").arg(format!("127.0.0.1:{port}"));
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::supervisor::win32::CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start the encrypted tunnel: {e}"))?;

    // `dial` binds and announces before touching the network, so the port
    // opens within milliseconds even when the phone is still waking up.
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if port_is_open(port) {
            let mut map = dialers().lock().unwrap();
            map.insert(endpoint_id.to_string(), Dialer { child, local_port: port });
            return Ok(port);
        }
        if let Ok(Some(_)) = child.try_wait() {
            return Err("The encrypted tunnel exited before it became ready.".to_string());
        }
        std::thread::sleep(Duration::from_millis(120));
    }

    let _ = child.kill();
    Err("The encrypted tunnel did not become ready in time.".to_string())
}

/// Restarts any missing dialers for registered tunnel workers.
pub fn ensure_worker_tunnels(workers: &[RemoteWorkerConfig]) -> Vec<String> {
    let mut warnings = Vec::new();
    for worker in workers.iter().filter(|w| w.is_active && w.transport == "iroh") {
        let endpoint_id = match worker
            .endpoint_id
            .clone()
            .or_else(|| worker.pairing_code.as_deref().and_then(|c| endpoint_id_for_pair_code(c).ok()))
        {
            Some(id) => id,
            None => {
                warnings.push(format!("{}: no tunnel identity is stored.", worker.name));
                continue;
            }
        };
        if let Err(err) = start_dialer(
            &endpoint_id,
            worker.pairing_code.as_deref(),
            worker.tunnel_local_port,
        ) {
            warnings.push(format!("{}: {err}", worker.name));
        }
    }
    warnings
}

/// Stops the dialer for one endpoint id.
pub fn stop_dialer(endpoint_id: &str) {
    let mut map = dialers().lock().unwrap();
    if let Some(mut dialer) = map.remove(endpoint_id) {
        let _ = dialer.child.kill();
        let _ = dialer.child.wait();
    }
}

/// Stops every dialer. Called when the cluster engine shuts down.
pub fn stop_all_dialers() {
    let mut map = dialers().lock().unwrap();
    for (_, mut dialer) in map.drain() {
        let _ = dialer.child.kill();
        let _ = dialer.child.wait();
    }
}
