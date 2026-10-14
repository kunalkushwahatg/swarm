//! Strongly-typed supervisor configuration and validation guards.

use std::net::{SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoordinatorConfig {
    pub port: u16,
    pub rpc_port: u16,
    pub gpu_layers: u32,
    pub threads: u32,
    pub model_path: String,
    pub use_rpc: bool,
}

impl Default for CoordinatorConfig {
    fn default() -> Self {
        Self {
            port: 8080,
            rpc_port: 50052,
            gpu_layers: 4,
            threads: 2,
            model_path: String::new(),
            use_rpc: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreflightReport {
    pub coordinator_port_available: bool,
    pub rpc_port_available: bool,
    pub coordinator_binary_found: bool,
    pub coordinator_binary_path: String,
    pub rpc_binary_found: bool,
    pub rpc_binary_path: String,
    pub model_found: bool,
    pub model_path: String,
    pub can_launch: bool,
    pub issues: Vec<String>,
}

#[derive(Debug)]
pub enum ConfigValidationError {
    PortInUse { port: u16, context: &'static str },
    BinaryNotFound(PathBuf),
    DllDirectoryNotFound(PathBuf),
    InvalidModelPath(String),
}

impl std::fmt::Display for ConfigValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigValidationError::PortInUse { port, context } => {
                write!(f, "Port {} ({}) is already occupied. Process left untouched.", port, context)
            }
            ConfigValidationError::BinaryNotFound(path) => {
                write!(f, "Required executable binary was not found at: {}", path.display())
            }
            ConfigValidationError::DllDirectoryNotFound(path) => {
                write!(f, "Required DLL directory was not found at: {}", path.display())
            }
            ConfigValidationError::InvalidModelPath(reason) => {
                write!(f, "Invalid model path: {}", reason)
            }
        }
    }
}

impl std::error::Error for ConfigValidationError {}

/// Checks whether a local TCP loopback port is available for binding.
/// Strictly non-destructive: tests if `TcpListener::bind` succeeds and closes immediately.
pub fn is_loopback_port_available(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    match TcpListener::bind(addr) {
        Ok(listener) => {
            drop(listener);
            true
        }
        Err(_) => false,
    }
}

/// Checks whether a local service is actively listening on a port by attempting a TCP connect.
pub fn is_port_listening(port: u16) -> bool {
    use std::net::TcpStream;
    use std::time::Duration;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

/// Validates that a proposed model path is a non-empty, existing `.gguf` file.
/// Does NOT load the model or allocate memory.
pub fn validate_model_path_file(raw_path: &str) -> Result<PathBuf, ConfigValidationError> {
    if raw_path.trim().is_empty() {
        return Err(ConfigValidationError::InvalidModelPath("Model path cannot be empty".to_string()));
    }
    let p = PathBuf::from(raw_path);
    if !p.exists() {
        return Err(ConfigValidationError::InvalidModelPath(format!("File does not exist: {}", p.display())));
    }
    if !p.is_file() {
        return Err(ConfigValidationError::InvalidModelPath(format!("Path is not a regular file: {}", p.display())));
    }
    if let Some(ext) = p.extension() {
        if ext.to_string_lossy().to_lowercase() != "gguf" {
            return Err(ConfigValidationError::InvalidModelPath("File must have a .gguf extension".to_string()));
        }
    } else {
        return Err(ConfigValidationError::InvalidModelPath("File lacks a .gguf extension".to_string()));
    }
    Ok(p)
}

/// Validates an executable binary path.
pub fn validate_binary_path(path: &Path) -> Result<(), ConfigValidationError> {
    if !path.exists() || !path.is_file() {
        return Err(ConfigValidationError::BinaryNotFound(path.to_path_buf()));
    }
    Ok(())
}

/// Validates that a required DLL search directory exists and is a directory.
pub fn validate_dll_directory(path: &Path) -> Result<(), ConfigValidationError> {
    if !path.exists() || !path.is_dir() {
        return Err(ConfigValidationError::DllDirectoryNotFound(path.to_path_buf()));
    }
    Ok(())
}

/// Returns the workspace-relative DLL directories required by swarm_node.exe
/// matching Start-LocalDev.ps1: ($WorkspaceRoot\build-cuda, $WorkspaceRoot\build-cuda\bin).
pub fn get_coordinator_dll_dirs(workspace_root: &Path) -> Vec<PathBuf> {
    vec![
        workspace_root.join(r"build-cuda"),
        workspace_root.join(r"build-cuda\bin"),
    ]
}

/// Detailed result of probing the coordinator HTTP health endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetailedHttpHealth {
    pub reachable: bool,
    pub status_code: Option<u16>,
    pub inference_ready: Option<bool>,
    pub model_loaded: Option<bool>,
    pub coordinator_reported_worker_state: Option<String>,
    pub duration_ms: u64,
    pub raw_response: Option<String>,
}

/// Detailed result of probing the RPC worker TCP reachability.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetailedRpcReachability {
    pub reachable: bool,
    pub duration_ms: u64,
    pub status_note: String,
    pub diagnostic_state: String,
}

/// Probes coordinator HTTP health with bounded timeout and extracts JSON status.
pub fn probe_coordinator_health_detailed(port: u16, path: &str, timeout_ms: u64) -> DetailedHttpHealth {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::{Duration, Instant};

    let t0 = Instant::now();
    let timeout = Duration::from_millis(timeout_ms);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));

    if let Ok(mut stream) = TcpStream::connect_timeout(&addr, timeout) {
        let _ = stream.set_read_timeout(Some(timeout));
        let _ = stream.set_write_timeout(Some(timeout));
        let request = format!(
            "GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nUser-Agent: SwarmSupervisorDiagnostic/0.2.0\r\n\r\n",
            path, port
        );
        if stream.write_all(request.as_bytes()).is_ok() {
            let mut response_buf = [0u8; 4096];
            if let Ok(bytes_read) = stream.read(&mut response_buf) {
                let duration_ms = t0.elapsed().as_millis() as u64;
                if bytes_read > 0 {
                    let resp_str = String::from_utf8_lossy(&response_buf[..bytes_read]).to_string();
                    let mut status_code = None;
                    if let Some(first_line) = resp_str.lines().next() {
                        let parts: Vec<&str> = first_line.split_whitespace().collect();
                        if parts.len() >= 2 {
                            status_code = parts[1].parse::<u16>().ok();
                        }
                    }

                    let mut inference_ready = None;
                    let mut model_loaded = None;
                    let mut coordinator_reported_worker_state = None;

                    // Extract body after double CRLF
                    if let Some((_, body)) = resp_str.split_once("\r\n\r\n") {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(body.trim()) {
                            if let Some(inf) = val.get("inference") {
                                inference_ready = inf.get("ready").and_then(|v| v.as_bool());
                            }
                            if let Some(mdl) = val.get("model") {
                                model_loaded = mdl.get("loaded").and_then(|v| v.as_bool());
                            }
                            if let Some(workers) = val.get("workers").and_then(|w| w.as_array()) {
                                if let Some(w) = workers.iter().find(|w| w.get("port").and_then(|p| p.as_u64()) == Some(50052)) {
                                    coordinator_reported_worker_state = w.get("state").and_then(|s| s.as_str()).map(|s| s.to_string());
                                }
                            }
                        }
                    }

                    return DetailedHttpHealth {
                        reachable: true,
                        status_code,
                        inference_ready,
                        model_loaded,
                        coordinator_reported_worker_state,
                        duration_ms,
                        raw_response: Some(resp_str),
                    };
                }
            }
        }
    }

    DetailedHttpHealth {
        reachable: false,
        status_code: None,
        inference_ready: None,
        model_loaded: None,
        coordinator_reported_worker_state: None,
        duration_ms: t0.elapsed().as_millis() as u64,
        raw_response: None,
    }
}

/// Probes RPC TCP endpoint reachability with bounded non-destructive connect.
/// Distinguishes an unbound port from an occupied port where secondary connection attempts fail.
pub fn probe_rpc_reachability(port: u16, timeout_ms: u64, port_occupied: bool) -> DetailedRpcReachability {
    use std::net::TcpStream;
    use std::time::{Duration, Instant};

    let t0 = Instant::now();
    let timeout = Duration::from_millis(timeout_ms);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));

    match TcpStream::connect_timeout(&addr, timeout) {
        Ok(stream) => {
            drop(stream);
            DetailedRpcReachability {
                reachable: true,
                duration_ms: t0.elapsed().as_millis() as u64,
                status_note: format!("Direct TCP connect accepted on 127.0.0.1:{}", port),
                diagnostic_state: "CONNECTED".to_string(),
            }
        }
        Err(e) => {
            let error_label = match e.kind() {
                std::io::ErrorKind::ConnectionRefused => "Refused",
                std::io::ErrorKind::TimedOut => "Timed out",
                _ => "Refused / Timed out",
            };
            let (diagnostic_state, status_note) = if port_occupied {
                (
                    error_label.to_uppercase(),
                    format!(
                        "Direct TCP probe: {} ({}) — Port {} occupied; coordinator holds active session; cause: Unconfirmed",
                        error_label, e, port
                    ),
                )
            } else {
                (
                    "NOT_TESTED".to_string(),
                    format!("Direct TCP probe: Not tested (Port {} is available / unbound)", port),
                )
            };
            DetailedRpcReachability {
                reachable: false,
                duration_ms: t0.elapsed().as_millis() as u64,
                status_note,
                diagnostic_state,
            }
        }
    }
}

/// Performs a lightweight HTTP GET to check if the coordinator /health endpoint returns 200 OK.
pub fn check_http_health(port: u16, path: &str, timeout_ms: u64) -> bool {
    let probe = probe_coordinator_health_detailed(port, path, timeout_ms);
    probe.reachable && probe.status_code == Some(200)
}

/// Strongly-typed runtime profile representation for Swarm cluster and standalone execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeProfile {
    DefaultCluster,
    LowMemoryCudaStandalone,
}

impl RuntimeProfile {
    /// Ordered list of all supported profiles. Default is always first.
    pub const ALL: [RuntimeProfile; 2] = [
        RuntimeProfile::DefaultCluster,
        RuntimeProfile::LowMemoryCudaStandalone,
    ];

    /// Stable machine-readable profile identifier.
    pub fn id(&self) -> &'static str {
        match self {
            RuntimeProfile::DefaultCluster => "default",
            RuntimeProfile::LowMemoryCudaStandalone => "low_memory_cuda_standalone",
        }
    }

    /// Resolves a string identifier to a typed RuntimeProfile.
    /// Rejects unknown identifiers (returns None) to prevent silent fallback.
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "default" => Some(RuntimeProfile::DefaultCluster),
            "low_memory_cuda_standalone" => Some(RuntimeProfile::LowMemoryCudaStandalone),
            _ => None,
        }
    }

    /// Human-readable display name for UI presentation.
    pub fn display_name(&self) -> &'static str {
        match self {
            RuntimeProfile::DefaultCluster => "Standard Distributed Cluster",
            RuntimeProfile::LowMemoryCudaStandalone => "Standalone Single-GPU (Low Memory)",
        }
    }

    /// Technical description of the profile architecture and allocation.
    pub fn description(&self) -> &'static str {
        match self {
            RuntimeProfile::DefaultCluster => "Dual-process distributed cluster with coordinator and local RPC worker (SWARM_USE_RPC=1, SWARM_N_GPU_LAYERS=4, SWARM_CTX_SIZE=2048, ports 8080 & 50052, 1,500 MB RAM guard).",
            RuntimeProfile::LowMemoryCudaStandalone => "Isolated single-process coordinator offloading all 37 model layers to local CUDA (SWARM_USE_RPC=0, SWARM_N_GPU_LAYERS=-1, SWARM_CTX_SIZE=512, port 8080, 1,000 MB RAM guard, 3,100 MiB VRAM guard).",
        }
    }

    /// Returns true if this profile is the system default.
    pub fn is_default(&self) -> bool {
        matches!(self, RuntimeProfile::DefaultCluster)
    }

    /// Required minimum free physical RAM in MB before launch is permitted.
    pub fn required_ram_mb(&self) -> u64 {
        match self {
            RuntimeProfile::DefaultCluster => 1500,
            RuntimeProfile::LowMemoryCudaStandalone => 1000,
        }
    }

    /// Required minimum free GPU VRAM in MiB before launch is permitted.
    /// None indicates VRAM is unconstrained or handled dynamically by the engine.
    pub fn required_vram_mb(&self) -> Option<u64> {
        match self {
            RuntimeProfile::DefaultCluster => None,
            RuntimeProfile::LowMemoryCudaStandalone => Some(3100),
        }
    }

    /// Port on which coordinator HTTP API listens.
    pub fn coordinator_port(&self) -> u16 {
        8080
    }

    /// Port on which local RPC worker listens, if applicable.
    pub fn rpc_port(&self) -> Option<u16> {
        match self {
            RuntimeProfile::DefaultCluster => Some(50052),
            RuntimeProfile::LowMemoryCudaStandalone => None,
        }
    }

    /// Whether this profile requires spawning and managing a local RPC worker child process.
    pub fn requires_rpc_worker(&self) -> bool {
        match self {
            RuntimeProfile::DefaultCluster => true,
            RuntimeProfile::LowMemoryCudaStandalone => false,
        }
    }

    /// Whether real engine launch requires explicit operator authorization.
    pub fn requires_real_authorization(&self) -> bool {
        true
    }
}

/// Key-value environment variable pair for profile configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProfileEnvVar {
    pub key: String,
    pub value: String,
}

/// Granular status of an individual resource threshold check.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ResourceEligibilityStatus {
    Satisfied,
    Deficit { current: u64, required: u64 },
    Unavailable { reason: String },
}

/// Evaluated live preflight eligibility for a given profile.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProfileResourceEligibility {
    pub satisfies_ram: Option<bool>,
    pub satisfies_vram: Option<bool>,
    pub ram_status: ResourceEligibilityStatus,
    pub vram_status: ResourceEligibilityStatus,
    pub ports_available: Option<bool>,
    pub can_launch_now: bool,
    pub note: String,
}

/// Full metadata and live preflight eligibility for a runtime profile.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RuntimeProfileMetadata {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub is_default: bool,
    pub required_ram_mb: u64,
    pub required_vram_mb: Option<u64>,
    pub coordinator_port: u16,
    pub rpc_port: Option<u16>,
    pub requires_rpc_worker: bool,
    pub requires_real_authorization: bool,
    pub env_vars: Vec<ProfileEnvVar>,
    pub eligibility: ProfileResourceEligibility,
}

/// Response payload for supervisor_get_available_profiles IPC command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AvailableProfilesResponse {
    pub default_profile_id: String,
    pub profiles: Vec<RuntimeProfileMetadata>,
    pub queried_ram_mb: Option<u64>,
    pub queried_vram_mb: Option<u64>,
    pub query_timestamp: String,
}

/// Evaluates whether current host resource readings satisfy a profile's preflight thresholds.
/// Fails closed on unreadable metrics (None) — never reports an unknown reading as satisfied.
pub fn evaluate_profile_resource_eligibility(
    profile: RuntimeProfile,
    avail_ram_mb: Option<u64>,
    avail_vram_mb: Option<u64>,
    port_8080_free: bool,
    port_50052_free: bool,
) -> ProfileResourceEligibility {
    let (satisfies_ram, ram_status) = match avail_ram_mb {
        Some(ram) => {
            if ram >= profile.required_ram_mb() {
                (Some(true), ResourceEligibilityStatus::Satisfied)
            } else {
                (
                    Some(false),
                    ResourceEligibilityStatus::Deficit {
                        current: ram,
                        required: profile.required_ram_mb(),
                    },
                )
            }
        }
        None => (
            None,
            ResourceEligibilityStatus::Unavailable {
                reason: "Physical RAM reading unavailable from Win32 GlobalMemoryStatusEx".to_string(),
            },
        ),
    };

    let (satisfies_vram, vram_status) = match profile.required_vram_mb() {
        Some(req_vram) => match avail_vram_mb {
            Some(vram) => {
                if vram >= req_vram {
                    (Some(true), ResourceEligibilityStatus::Satisfied)
                } else {
                    (
                        Some(false),
                        ResourceEligibilityStatus::Deficit {
                            current: vram,
                            required: req_vram,
                        },
                    )
                }
            }
            None => (
                None,
                ResourceEligibilityStatus::Unavailable {
                    reason: "GPU VRAM reading unavailable from nvidia-smi".to_string(),
                },
            ),
        },
        None => (Some(true), ResourceEligibilityStatus::Satisfied),
    };

    let ports_available = if profile.requires_rpc_worker() {
        port_8080_free && port_50052_free
    } else {
        port_8080_free
    };

    let can_launch_now = satisfies_ram == Some(true)
        && satisfies_vram == Some(true)
        && ports_available;

    let note = if can_launch_now {
        format!(
            "Eligible for launch: Meets RAM threshold ({} MB) and VRAM requirements; required ports free.",
            profile.required_ram_mb()
        )
    } else {
        let mut reasons = Vec::new();
        match &ram_status {
            ResourceEligibilityStatus::Deficit { current, required } => {
                reasons.push(format!("RAM deficit: {} MB available < {} MB required", current, required));
            }
            ResourceEligibilityStatus::Unavailable { reason } => {
                reasons.push(format!("RAM unavailable ({})", reason));
            }
            ResourceEligibilityStatus::Satisfied => {}
        }
        match &vram_status {
            ResourceEligibilityStatus::Deficit { current, required } => {
                reasons.push(format!("VRAM deficit: {} MiB available < {} MiB required", current, required));
            }
            ResourceEligibilityStatus::Unavailable { reason } => {
                reasons.push(format!("VRAM unavailable ({})", reason));
            }
            ResourceEligibilityStatus::Satisfied => {}
        }
        if !ports_available {
            if !port_8080_free {
                reasons.push("Coordinator port 8080 occupied".to_string());
            }
            if profile.requires_rpc_worker() && !port_50052_free {
                reasons.push("RPC port 50052 occupied".to_string());
            }
        }
        reasons.join("; ")
    };

    ProfileResourceEligibility {
        satisfies_ram,
        satisfies_vram,
        ram_status,
        vram_status,
        ports_available: Some(ports_available),
        can_launch_now,
        note,
    }
}


