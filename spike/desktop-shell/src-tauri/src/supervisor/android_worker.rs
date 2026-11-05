//! Android worker bridge.
//!
//! The phone cannot reuse the desktop supervisor: Windows owns the child
//! processes through a Job Object and PowerShell firewall rules, while Android
//! requires a foreground service to keep compute alive with the screen off.
//!
//! This module is the single seam between the two. It drives
//! `com.swarm.desktop.SwarmWorkerService` over JNI (start / stop / status) and
//! projects the service's status JSON into the same `WorkerModeStatus` the
//! desktop UI already consumes, so the React front-end needs no platform forks.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::supervisor::commands::types::{EngineStartResult, StartEngineOptions};
use crate::supervisor::orchestrator::{ClusterLifecycleState, ClusterStatus};
use super::worker_mode::{
    WorkerHardwareTelemetry, WorkerModeConfig, WorkerModeManager, WorkerModeStatus, WorkerStartResult,
};

/// Status payload produced by `SwarmWorkerService.dispatch("status", ...)`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AndroidWorkerState {
    #[serde(default)]
    pub running: bool,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub endpoint_id: Option<String>,
    #[serde(default)]
    pub relay_url: Option<String>,
    #[serde(default)]
    pub pairing_code: Option<String>,
    #[serde(default)]
    pub backend: String,
    #[serde(default)]
    pub threads: u32,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub uptime_secs: u64,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub logs: Vec<String>,
}

/// Resolves the app-private data directory without needing a live JNI context.
///
/// `run()` executes before tao installs the Android context, so the package
/// name is read from `/proc/self/cmdline` (the process name is the package,
/// optionally suffixed with `:service`).
pub fn default_workspace_root() -> Option<PathBuf> {
    let raw = std::fs::read("/proc/self/cmdline").ok()?;
    let first = raw.split(|b| *b == 0).next()?;
    let process_name = String::from_utf8_lossy(first).trim().to_string();
    let package = process_name.split(':').next().unwrap_or("").trim();
    if package.is_empty() {
        return None;
    }

    let dir = PathBuf::from(format!("/data/user/0/{}/files", package));
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    Some(dir)
}

/// Invokes `SwarmWorkerService.dispatch` on the Android main class loader.
fn dispatch(action: &str, payload: &str) -> Result<String, String> {
    use jni::objects::{JClass, JObject, JString, JValue};

    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("JNI JavaVM unavailable: {e}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("JNI attach failed: {e}"))?;

    let context = unsafe { JObject::from_raw(ctx.context().cast()) };

    // FindClass from a native thread resolves against the system class loader,
    // which cannot see app classes. Ask the application's own loader instead.
    let loader = env
        .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .and_then(|v| v.l())
        .map_err(|e| format!("Could not read application ClassLoader: {e}"))?;
    let class_name = env
        .new_string("com.swarm.desktop.SwarmWorkerService")
        .map_err(|e| e.to_string())?;
    let raw_class = env
        .call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&class_name)],
        )
        .and_then(|v| v.l())
        .map_err(|e| format!("SwarmWorkerService class not found: {e}"))?;
    let class = JClass::from(raw_class);

    let j_action = env.new_string(action).map_err(|e| e.to_string())?;
    let j_payload = env.new_string(payload).map_err(|e| e.to_string())?;

    let result = env
        .call_static_method(
            &class,
            "dispatch",
            "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
            &[
                JValue::Object(&context),
                JValue::Object(&j_action),
                JValue::Object(&j_payload),
            ],
        )
        .map_err(|e| format!("JNI dispatch({action}) failed: {e}"))?;

    let obj = result
        .l()
        .map_err(|e| format!("JNI dispatch({action}) returned a non-object: {e}"))?;
    let j_text = JString::from(obj);
    let text = env
        .get_string(&j_text)
        .map_err(|e| format!("JNI dispatch({action}) returned an unreadable string: {e}"))?;
    Ok(text.into())
}

fn read_state() -> Result<AndroidWorkerState, String> {
    let raw = dispatch("status", "{}")?;
    serde_json::from_str(&raw).map_err(|e| format!("Malformed Android worker status: {e}"))
}

/// Point-in-time worker status, projected onto the shared status contract.
pub fn status(manager: &WorkerModeManager) -> Result<WorkerModeStatus, String> {
    let state = read_state()?;
    Ok(build_status(manager, manager.get_config(), state))
}

/// Starts (or reconfigures) the native RPC worker inside the foreground service.
pub fn start(
    manager: &WorkerModeManager,
    config_override: Option<WorkerModeConfig>,
) -> Result<WorkerStartResult, String> {
    let config = match config_override {
        Some(cfg) => {
            manager.save_config(&cfg)?;
            manager.get_config()
        }
        None => manager.get_config(),
    };

    let use_gpu = matches!(
        config.backend_device.trim().to_ascii_lowercase().as_str(),
        "vulkan" | "gpu" | "vulkan0"
    );

    let payload = serde_json::json!({
        "useGpu": use_gpu,
        "port": config.rpc_port,
        "threads": config.threads,
    })
    .to_string();

    let raw = dispatch("start", &payload)?;
    let mut state: AndroidWorkerState = serde_json::from_str(&raw)
        .map_err(|e| format!("Malformed Android worker status: {e}"))?;

    // The service reports `Starting` immediately; wait for the RPC socket so
    // the UI flips to `Listening` without a second manual refresh.
    let deadline = Instant::now() + Duration::from_secs(10);
    while state.state == "Starting" && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(200));
        state = read_state()?;
    }

    if state.state == "Failed" {
        return Err(state
            .last_error
            .clone()
            .unwrap_or_else(|| "Android worker failed to start".to_string()));
    }

    let success = state.state == "Listening" || state.running;
    let message = if success {
        format!(
            "Compute sharing active on 0.0.0.0:{} ({} threads, {}).",
            state.port, state.threads, state.backend
        )
    } else {
        "Compute sharing requested, but the RPC worker has not started listening yet.".to_string()
    };

    Ok(WorkerStartResult {
        success,
        status: build_status(manager, config, state),
        message,
    })
}

/// Stops the foreground service and waits for the port to be released.
pub fn stop(manager: &WorkerModeManager) -> Result<WorkerModeStatus, String> {
    let raw = dispatch("stop", "{}")?;
    let mut state: AndroidWorkerState = serde_json::from_str(&raw)
        .map_err(|e| format!("Malformed Android worker status: {e}"))?;

    let deadline = Instant::now() + Duration::from_secs(5);
    while state.running && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(150));
        state = read_state()?;
    }

    state.running = false;
    state.state = "Stopped".to_string();
    state.pid = None;
    Ok(build_status(manager, manager.get_config(), state))
}

/// Stops the worker and reverts the persisted configuration to loopback.
pub fn revoke_remote_access(manager: &WorkerModeManager) -> Result<WorkerModeStatus, String> {
    let status = stop(manager)?;
    let mut config = manager.get_config();
    config.listen_host = "127.0.0.1".to_string();
    config.allow_remote_access = false;
    config.authorized_controller_ip = String::new();
    manager.save_config(&config)?;
    Ok(status)
}

/// Recent worker log lines surfaced to the UI's log drawer.
pub fn logs(count: Option<usize>) -> Vec<String> {
    let limit = count.unwrap_or(120).min(500);
    match read_state() {
        Ok(state) => {
            let len = state.logs.len();
            state.logs.into_iter().skip(len.saturating_sub(limit)).collect()
        }
        Err(err) => vec![format!("[android-worker] status unavailable: {err}")],
    }
}

fn build_status(
    manager: &WorkerModeManager,
    config: WorkerModeConfig,
    state: AndroidWorkerState,
) -> WorkerModeStatus {
    let port = if state.port == 0 { config.rpc_port } else { state.port };
    let is_listening = state.state == "Listening";
    let host = if state.host.is_empty() || state.host == "0.0.0.0" {
        "0.0.0.0".to_string()
    } else {
        state.host.clone()
    };

    let hardware: WorkerHardwareTelemetry = WorkerModeManager::probe_hardware_telemetry();

    WorkerModeStatus {
        role: config.role.clone(),
        state: if state.state.is_empty() {
            "Stopped".to_string()
        } else {
            state.state.clone()
        },
        pid: state.pid,
        listen_endpoint: if state.running {
            Some(format!("0.0.0.0:{port}"))
        } else {
            None
        },
        advertised_endpoint: format!("{}:{}", host, port),
        endpoint_id: state.endpoint_id.clone(),
        relay_url: state.relay_url.clone(),
        pairing_code: state.pairing_code.clone(),
        is_listening,
        uptime_secs: state.uptime_secs,
        last_error: state.last_error.clone(),
        hardware,
        config,
        network_interfaces: super::win32::get_local_ip_addresses(),
        network_interface_names: std::collections::HashMap::new(),
        // Android has no host firewall to manage; the worker is reachable on
        // the LAN by design and authenticated by the encrypted relay tunnel.
        firewall_rule_installed: None,
        firewall_status: "NotRequired".to_string(),
        firewall_remote_address: None,
        firewall_command: String::new(),
        recent_logs: state.logs,
        unencrypted_transport_warning: true,
        transport_security_notice: "GGML RPC is plaintext on the LAN. Prefer the encrypted relay tunnel or a trusted local network."
            .to_string(),
        active_client_connections: if state.running {
            active_client_connections(port)
        } else {
            Vec::new()
        },
        canonical_config_path: manager.canonical_config_path.to_string_lossy().to_string(),
        is_remote_binding: state.running,
    }
}

/// Counts established RPC clients from `/proc/net/tcp{,6}` (no root needed).
fn active_client_connections(port: u16) -> Vec<String> {
    let mut clients: Vec<String> = Vec::new();
    for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        for line in text.lines().skip(1) {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 4 || cols[3] != "01" {
                // 01 == TCP_ESTABLISHED
                continue;
            }
            let Some((_, local_port_hex)) = cols[1].split_once(':') else {
                continue;
            };
            if u16::from_str_radix(local_port_hex, 16).ok() != Some(port) {
                continue;
            }
            if let Some(remote) = parse_proc_address(cols[2]) {
                clients.push(remote);
            }
        }
    }
    clients.sort();
    clients.dedup();
    clients
}

fn parse_proc_address(field: &str) -> Option<String> {
    let (ip_hex, port_hex) = field.split_once(':')?;
    let port = u16::from_str_radix(port_hex, 16).ok()?;
    match ip_hex.len() {
        8 => {
            let word = u32::from_str_radix(ip_hex, 16).ok()?;
            let ip = std::net::Ipv4Addr::from(word.to_le_bytes());
            Some(format!("{ip}:{port}"))
        }
        32 => {
            let mut bytes = [0u8; 16];
            for i in 0..4 {
                let word = u32::from_str_radix(&ip_hex[i * 8..(i + 1) * 8], 16).ok()?;
                bytes[i * 4..i * 4 + 4].copy_from_slice(&word.to_le_bytes());
            }
            Some(format!("{}:{}", std::net::Ipv6Addr::from(bytes), port))
        }
        _ => None,
    }
}

/// Status payload produced by `SwarmWorkerService.dispatch("leader_status", ...)`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AndroidLeaderState {
    #[serde(default)]
    pub running: bool,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub coord_healthy: bool,
    #[serde(default)]
    pub active_profile: Option<String>,
    #[serde(default)]
    pub model_path: String,
    #[serde(default)]
    pub uptime_secs: u64,
    #[serde(default)]
    pub last_error: Option<String>,
}

pub fn leader_status() -> ClusterStatus {
    let raw = match dispatch("leader_status", "{}") {
        Ok(r) => r,
        Err(_) => {
            return ClusterStatus {
                state: ClusterLifecycleState::Stopped,
                rpc_pid: None,
                coordinator_pid: None,
                rpc_port: 0,
                coordinator_port: 8080,
                last_error: None,
                active_profile: None,
            };
        }
    };
    let state: AndroidLeaderState = serde_json::from_str(&raw).unwrap_or_default();

    let lifecycle_state = match state.state.as_str() {
        "Healthy" | "Ready" => ClusterLifecycleState::Ready,
        "Starting" => ClusterLifecycleState::StartingCoordinator,
        "Stopping" => ClusterLifecycleState::Stopping,
        "Stopped" => ClusterLifecycleState::Stopped,
        other => ClusterLifecycleState::Error {
            reason: other.to_string(),
        },
    };

    ClusterStatus {
        state: lifecycle_state,
        rpc_pid: None,
        coordinator_pid: state.pid,
        rpc_port: 0,
        coordinator_port: if state.port > 0 { state.port } else { 8080 },
        last_error: state.last_error,
        active_profile: state.active_profile,
    }
}

pub fn start_leader(
    workspace_root: &std::path::Path,
    model_path: &std::path::Path,
    options: Option<StartEngineOptions>,
) -> Result<EngineStartResult, String> {
    // An explicit on-device profile must never depend on a remote RPC worker.
    // This is also the recovery path offered when a cluster launch fails.
    let force_standalone = options
        .as_ref()
        .and_then(|o| o.profile.as_deref())
        .map(|profile| profile == "low_memory_cuda_standalone")
        .unwrap_or(false);

    // Registered workers can go stale (for example, a USB-tethered host that
    // is no longer connected). Passing a dead endpoint to the coordinator makes
    // it abort before it can load the local model, so probe each candidate and
    // fall back to the on-device standalone engine when none answer.
    let registered_workers =
        crate::supervisor::commands::workers::get_registered_workers_internal(workspace_root);
    let mut endpoints: Vec<String> = Vec::new();
    if !force_standalone {
        for worker in registered_workers.iter().filter(|w| w.is_active) {
            let probe = crate::supervisor::commands::workers::probe_remote_worker_endpoint_internal(
                &worker.host,
                worker.port,
                500,
            );
            if probe.reachable {
                endpoints.push(format!("{}:{}", worker.host, worker.port));
            }
        }
    }

    let use_rpc = !endpoints.is_empty();
    let rpc_endpoints = endpoints.join(",");

    let payload = serde_json::json!({
        "modelPath": model_path.to_string_lossy().to_string(),
        "port": 8080,
        "ctxSize": 512,
        "threads": 4,
        "useRpc": use_rpc,
        "rpcEndpoints": rpc_endpoints,
        "nGpuLayers": -1,
        "placementPolicy": "none",
    })
    .to_string();

    let _ = dispatch("start_leader", &payload)?;

    let deadline = Instant::now() + Duration::from_secs(75);
    let mut status = leader_status();
    while (status.state == ClusterLifecycleState::StartingCoordinator
        || status.state == ClusterLifecycleState::StartingRpc)
        && Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(300));
        status = leader_status();
    }

    let success = status.state == ClusterLifecycleState::Ready;
    if success && !use_rpc {
        // The coordinator ran without RPC workers. Report the on-device
        // profile so the UI does not keep claiming this was a cluster launch.
        status.active_profile = Some("low_memory_cuda_standalone".to_string());
    }
    let message = if success {
        "Standalone Swarm Coordinator engine active on Android.".to_string()
    } else {
        status
            .last_error
            .clone()
            .unwrap_or_else(|| "Failed to start Swarm Coordinator on Android.".to_string())
    };

    Ok(EngineStartResult {
        success,
        status,
        message,
        preflight: None,
        available_ram_mb: None,
        total_ram_mb: None,
        available_vram_mb: None,
        total_vram_mb: None,
    })
}

pub fn stop_leader() -> Result<ClusterStatus, String> {
    let _ = dispatch("stop_leader", "{}")?;
    Ok(leader_status())
}
