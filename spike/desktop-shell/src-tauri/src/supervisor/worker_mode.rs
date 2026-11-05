//! Native Swarm Worker Mode supervision, compute sharing, and hardware telemetry.
//! Manages standalone GGML RPC server processes inside a Windows Job Object.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use serde::{Deserialize, Serialize};

use super::config::{is_host_port_available, is_host_port_listening};
use super::paths::resolve_native_runtime;
use super::process::{ProcessManager, ProcessRole, ProcessStatus};
use super::shutdown::shutdown_managed_child;
use super::win32::{get_available_physical_memory, get_local_ip_addresses, CREATE_NO_WINDOW};

/// Operating roles supported by the Swarm Desktop application.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OperatingRole {
    Inference,
    Worker,
    Combined,
}

impl Default for OperatingRole {
    fn default() -> Self {
        OperatingRole::Inference
    }
}

/// Persistent configuration for Worker Mode.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerModeConfig {
    pub role: String, // "inference" | "worker" | "combined"
    pub listen_host: String, // "127.0.0.1" | "0.0.0.0" | custom LAN IP
    pub rpc_port: u16, // default: 50052
    pub threads: u32, // CPU thread count (default: 4)
    pub backend_device: String, // "all" | "cuda" | "cpu"
    pub authorized_controller_ip: String, // Optional authorized controller IP / subnet filter
    pub allow_remote_access: bool, // Explicit operator authorization required for non-loopback
    pub enable_file_cache: bool, // -c flag for ggml-rpc-server
    pub target_ram_mb: u64, // Advisory sharing target
    pub target_vram_mb: u64, // Advisory sharing target
    pub reserved_headroom_ram_mb: u64, // Safety headroom for OS (default: 1024)
    pub reserved_headroom_vram_mb: u64, // Safety headroom for display (default: 256)
    pub background_run_enabled: bool, // Allow worker to run when minimized
    pub updated_at_ms: u64,
}

impl Default for WorkerModeConfig {
    fn default() -> Self {
        Self {
            role: "inference".to_string(),
            listen_host: "127.0.0.1".to_string(),
            rpc_port: 50052,
            threads: 4,
            backend_device: "all".to_string(),
            authorized_controller_ip: String::new(),
            allow_remote_access: false,
            enable_file_cache: true,
            target_ram_mb: 2048,
            target_vram_mb: 2048,
            reserved_headroom_ram_mb: 1024,
            reserved_headroom_vram_mb: 256,
            background_run_enabled: false,
            updated_at_ms: 0,
        }
    }
}

/// Point-in-time hardware capability and telemetry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerHardwareTelemetry {
    pub cpu_name: String,
    pub logical_cores: usize,
    pub total_ram_mb: u64,
    pub available_ram_mb: u64,
    pub total_vram_mb: Option<u64>,
    pub available_vram_mb: Option<u64>,
    pub gpu_name: Option<String>,
    pub supported_backends: Vec<String>,
    pub timestamp_ms: u64,
}

/// Authoritative live status of Worker Mode.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerModeStatus {
    pub role: String,
    pub state: String, // "Stopped" | "CheckingPrerequisites" | "Starting" | "Listening" | "Connected" | "Busy" | "Stopping" | "Failed"
    pub pid: Option<u32>,
    pub listen_endpoint: Option<String>,
    pub advertised_endpoint: String,
    /// Iroh endpoint id of this worker's encrypted tunnel, when one is running.
    #[serde(default)]
    pub endpoint_id: Option<String>,
    /// Relay URL reported by the tunnel, used to reach devices behind CGNAT.
    #[serde(default)]
    pub relay_url: Option<String>,
    /// Short code a desktop can enter to pair with this device over the tunnel.
    #[serde(default)]
    pub pairing_code: Option<String>,
    pub is_listening: bool,
    pub uptime_secs: u64,
    pub last_error: Option<String>,
    pub hardware: WorkerHardwareTelemetry,
    pub config: WorkerModeConfig,
    pub network_interfaces: Vec<String>,
    #[serde(default)]
    pub network_interface_names: std::collections::HashMap<String, String>,
    pub firewall_rule_installed: Option<bool>,
    pub firewall_status: String, // "NotRequired" | "RestrictedAndVerified" | "UnrestrictedWarning" | "MissingRule" | "ControllerMismatch" | "ElevationRequired"
    pub firewall_remote_address: Option<String>,
    pub firewall_command: String,
    pub recent_logs: Vec<String>,
    pub unencrypted_transport_warning: bool,
    pub transport_security_notice: String,
    pub active_client_connections: Vec<String>,
    pub canonical_config_path: String,
    pub is_remote_binding: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerStartResult {
    pub success: bool,
    pub status: WorkerModeStatus,
    pub message: String,
}

pub struct WorkerModeManager {
    pub manager: Arc<ProcessManager>,
    pub workspace_root: PathBuf,
    pub canonical_config_path: PathBuf,
    pub current_config: Mutex<WorkerModeConfig>,
    pub current_state: Mutex<String>,
    pub worker_pid: Mutex<Option<u32>>,
    pub started_at: Mutex<Option<Instant>>,
    pub last_error: Mutex<Option<String>>,
    /// Serializes start/stop/revoke transitions. The individual state fields
    /// remain separately lockable for status reads, but lifecycle operations
    /// must not interleave (e.g. two concurrent starts both passing the
    /// duplicate guard before either records a PID).
    lifecycle_lock: Mutex<()>,
}

impl WorkerModeManager {
    pub fn new(manager: Arc<ProcessManager>, workspace_root: PathBuf) -> Self {
        let canonical_path = Self::resolve_canonical_config_path(&workspace_root);
        let config = Self::load_config_with_migration(&workspace_root, &canonical_path)
            .unwrap_or_default();

        Self {
            manager,
            workspace_root,
            canonical_config_path: canonical_path,
            current_config: Mutex::new(config),
            current_state: Mutex::new("Stopped".to_string()),
            worker_pid: Mutex::new(None),
            started_at: Mutex::new(None),
            last_error: Mutex::new(None),
            lifecycle_lock: Mutex::new(()),
        }
    }

    /// Resolves canonical per-user persistent configuration directory (%APPDATA%\Swarm\config).
    pub fn resolve_canonical_config_dir(workspace_root: &Path) -> PathBuf {
        if let Ok(env_dir) = std::env::var("SWARM_WORKER_CONFIG_DIR") {
            let p = PathBuf::from(env_dir.trim());
            if !p.as_os_str().is_empty() {
                return p;
            }
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            let p = PathBuf::from(appdata.trim()).join(r"Swarm\config");
            return p;
        }
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            let p = PathBuf::from(localappdata.trim()).join(r"Swarm\config");
            return p;
        }
        workspace_root.join("dist")
    }

    /// Resolves canonical per-user persistent configuration path (%APPDATA%\Swarm\config\worker_mode_config.json).
    pub fn resolve_canonical_config_path(workspace_root: &Path) -> PathBuf {
        if let Ok(env_path) = std::env::var("SWARM_WORKER_CONFIG_PATH") {
            let p = PathBuf::from(env_path.trim());
            if !p.as_os_str().is_empty() {
                return p;
            }
        }
        Self::resolve_canonical_config_dir(workspace_root).join("worker_mode_config.json")
    }

    /// Resolves backup path in canonical configuration directory.
    pub fn resolve_canonical_backup_path(workspace_root: &Path) -> PathBuf {
        Self::resolve_canonical_config_dir(workspace_root).join("worker_mode_config.backup.json")
    }

    /// Legacy workspace config path for backward compatibility and migration.
    pub fn resolve_legacy_config_path(workspace_root: &Path) -> PathBuf {
        workspace_root.join(r"dist\worker_mode_config.json")
    }

    /// Validates configuration integrity and network safety policies.
    pub fn sanitize_and_validate_config(config: &mut WorkerModeConfig) -> Result<(), String> {
        if config.rpc_port == 0 {
            return Err("Validation Error: RPC port must be greater than 0 (recommended: 50052).".to_string());
        }
        if config.threads == 0 || config.threads > 128 {
            return Err("Validation Error: CPU thread count must be between 1 and 128.".to_string());
        }
        if config.backend_device != "all"
            && config.backend_device != "cuda"
            && config.backend_device != "cpu"
            && config.backend_device != "vulkan"
        {
            return Err(format!(
                "Validation Error: Unsupported backend device '{}'. Supported: 'all', 'cuda', 'cpu', 'vulkan'.",
                config.backend_device
            ));
        }

        // Loopback is the safe default. If remote access is not explicitly authorized,
        // force/verify listen_host is 127.0.0.1.
        if !config.allow_remote_access {
            if config.listen_host != "127.0.0.1" {
                return Err("Safety Guard: Remote compute sharing is disabled. Worker must bind to 127.0.0.1. Enable 'Authorize Remote Compute Sharing' before binding to a network adapter or 0.0.0.0.".to_string());
            }
        } else {
            // Remote sharing is enabled
            if config.listen_host != "127.0.0.1" {
                let ctrl_str = config.authorized_controller_ip.trim();
                // Android has no inbound host firewall to scope by controller
                // address, and the encrypted relay tunnel is the access
                // boundary there, so the controller IP is optional.
                if ctrl_str.is_empty() {
                    if cfg!(target_os = "android") {
                        return Ok(());
                    }
                    return Err("Security Policy: Remote compute sharing requires an authorized controller IP address (e.g. 192.168.1.50) to restrict network access scope.".to_string());
                }
                let ip: std::net::IpAddr = ctrl_str.parse().map_err(|_| {
                    format!("Security Policy: Invalid authorized controller IP address '{}'. Must be a valid IPv4 or IPv6 address.", ctrl_str)
                })?;

                if ip.is_loopback() {
                    return Err("Security Policy: Authorized controller IP cannot be a loopback address (127.0.0.1 / ::1) when remote sharing is enabled.".to_string());
                }
                if ip.is_unspecified() {
                    return Err("Security Policy: Authorized controller IP cannot be a wildcard address (0.0.0.0 / ::).".to_string());
                }
                if ip.is_multicast() {
                    return Err("Security Policy: Authorized controller IP cannot be a multicast address.".to_string());
                }
            }
        }

        Ok(())
    }

    /// Safely migrates legacy config from dist\worker_mode_config.json to canonical location.
    pub fn migrate_legacy_config_if_needed(
        workspace_root: &Path,
        canonical_path: &Path,
    ) -> Result<Option<WorkerModeConfig>, String> {
        if canonical_path.exists() {
            return Ok(None);
        }

        let legacy_path = Self::resolve_legacy_config_path(workspace_root);
        if !legacy_path.exists() {
            return Ok(None);
        }

        let data = fs::read_to_string(&legacy_path)
            .map_err(|e| format!("Failed to read legacy config at {}: {}", legacy_path.display(), e))?;

        let mut cfg: WorkerModeConfig = match serde_json::from_str(&data) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[WorkerModeManager] Legacy config corrupted: {}. Skipping migration.", e);
                return Ok(None);
            }
        };

        if let Err(e) = Self::sanitize_and_validate_config(&mut cfg) {
            eprintln!("[WorkerModeManager] Legacy config failed validation: {}. Falling back to default.", e);
            cfg = WorkerModeConfig::default();
        }

        // 1. Preserve a recoverable backup alongside legacy config
        let legacy_migrated_backup = workspace_root.join(r"dist\worker_mode_config.migrated.json");
        let _ = fs::copy(&legacy_path, &legacy_migrated_backup);

        // 2. Ensure canonical directory exists
        if let Some(parent) = canonical_path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        // 3. Atomically write to canonical location
        Self::atomic_write_config(canonical_path, &cfg)?;

        // 4. Verify readback
        let readback_data = fs::read_to_string(canonical_path)
            .map_err(|e| format!("Failed to readback migrated config: {}", e))?;
        let verified: WorkerModeConfig = serde_json::from_str(&readback_data)
            .map_err(|e| format!("Failed to deserialize verified config: {}", e))?;

        println!(
            "[WorkerModeManager] Successfully migrated worker configuration from {} to {}",
            legacy_path.display(),
            canonical_path.display()
        );

        Ok(Some(verified))
    }

    /// Atomically writes worker configuration using temp file + rename.
    pub fn atomic_write_config(path: &Path, config: &WorkerModeConfig) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        let tmp_path = path.with_extension("tmp");
        let json = serde_json::to_string_pretty(config)
            .map_err(|e| format!("Failed to serialize worker config: {}", e))?;

        fs::write(&tmp_path, &json)
            .map_err(|e| format!("Failed to write temporary worker config {}: {}", tmp_path.display(), e))?;

        // Transactional backup of existing file
        if path.exists() {
            let backup_path = path.with_extension("backup.json");
            let _ = fs::copy(path, &backup_path);
            let _ = fs::remove_file(path);
        }

        fs::rename(&tmp_path, path)
            .map_err(|e| format!("Failed to replace worker config {}: {}", path.display(), e))?;

        Ok(())
    }

    /// Loads worker configuration from canonical path with safe fallback and recovery.
    pub fn load_config_with_migration(workspace_root: &Path, canonical_path: &Path) -> Option<WorkerModeConfig> {
        // Attempt migration first if canonical file doesn't exist
        if let Ok(Some(migrated)) = Self::migrate_legacy_config_if_needed(workspace_root, canonical_path) {
            return Some(migrated);
        }

        if canonical_path.exists() {
            if let Ok(data) = fs::read_to_string(canonical_path) {
                if let Ok(mut cfg) = serde_json::from_str::<WorkerModeConfig>(&data) {
                    if Self::sanitize_and_validate_config(&mut cfg).is_ok() {
                        return Some(cfg);
                    }
                }
            }

            // Attempt recovery from backup if canonical file corrupted
            let backup_path = canonical_path.with_extension("backup.json");
            if backup_path.exists() {
                if let Ok(b_data) = fs::read_to_string(&backup_path) {
                    if let Ok(mut b_cfg) = serde_json::from_str::<WorkerModeConfig>(&b_data) {
                        if Self::sanitize_and_validate_config(&mut b_cfg).is_ok() {
                            eprintln!("[WorkerModeManager] Recovered worker configuration from backup.");
                            let _ = Self::atomic_write_config(canonical_path, &b_cfg);
                            return Some(b_cfg);
                        }
                    }
                }
            }
        }

        None
    }

    pub fn get_config(&self) -> WorkerModeConfig {
        self.current_config.lock().unwrap().clone()
    }

    pub fn is_active_worker(&self) -> bool {
        let config = self.get_config();
        let pid_opt = *self.worker_pid.lock().unwrap();
        pid_opt.is_some() && is_host_port_listening(&config.listen_host, config.rpc_port)
    }

    pub fn save_config(&self, config: &WorkerModeConfig) -> Result<(), String> {
        let mut cfg = config.clone();
        cfg.updated_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        Self::sanitize_and_validate_config(&mut cfg)?;
        Self::atomic_write_config(&self.canonical_config_path, &cfg)?;

        let mut lock = self.current_config.lock().unwrap();
        *lock = cfg;
        Ok(())
    }

    /// Human-readable CPU name, resolved per platform without external tools.
    ///
    /// Cached because hardware telemetry is rebuilt on every status poll and the
    /// Android path shells out to `getprop`.
    fn detect_cpu_name() -> String {
        static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        CACHE
            .get_or_init(|| {
                #[cfg(target_os = "android")]
                {
                    // Android ARM64 kernels usually omit the x86-style "model name"
                    // and often the "Hardware" line, so ask platform properties first.
                    for prop in ["ro.soc.model", "ro.board.platform", "ro.hardware"] {
                        if let Ok(output) = std::process::Command::new("/system/bin/getprop")
                            .arg(prop)
                            .output()
                        {
                            if output.status.success() {
                                let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
                                if !value.is_empty() && value != "unknown" {
                                    return value;
                                }
                            }
                        }
                    }

                    if let Ok(text) = std::fs::read_to_string("/proc/cpuinfo") {
                        let mut hardware: Option<String> = None;
                        let mut model: Option<String> = None;
                        for line in text.lines() {
                            if let Some(rest) = line.strip_prefix("Hardware") {
                                if let Some((_, value)) = rest.split_once(':') {
                                    let value = value.trim();
                                    if !value.is_empty() {
                                        hardware = Some(value.to_string());
                                    }
                                }
                            } else if let Some(rest) = line.strip_prefix("model name") {
                                if let Some((_, value)) = rest.split_once(':') {
                                    let value = value.trim();
                                    if !value.is_empty() {
                                        model = Some(value.to_string());
                                    }
                                }
                            }
                        }
                        if let Some(name) = hardware.or(model) {
                            return name;
                        }
                    }
                    "ARM64 CPU".to_string()
                }

                #[cfg(not(target_os = "android"))]
                {
                    std::env::var("PROCESSOR_IDENTIFIER").unwrap_or_else(|_| "x86_64 CPU".to_string())
                }
            })
            .clone()
    }

    /// Queries live hardware telemetry honestly from Win32 and driver interfaces.
    pub fn probe_hardware_telemetry() -> WorkerHardwareTelemetry {
        let mem = get_available_physical_memory();
        let (avail_ram, total_ram) = match mem {
            Some((avail, total)) => (avail / (1024 * 1024), total / (1024 * 1024)),
            None => (0, 0),
        };

        let logical_cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);

        let cpu_name = Self::detect_cpu_name();

        let (gpu_name, total_vram, avail_vram) = Self::probe_gpu_info();

        #[cfg(target_os = "android")]
        let backends = vec!["vulkan".to_string(), "cpu".to_string()];

        #[cfg(not(target_os = "android"))]
        let backends = {
            let mut list = vec!["cpu".to_string()];
            if gpu_name.is_some() {
                list.insert(0, "cuda".to_string());
            }
            list
        };

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        WorkerHardwareTelemetry {
            cpu_name,
            logical_cores,
            total_ram_mb: total_ram,
            available_ram_mb: avail_ram,
            total_vram_mb: total_vram,
            available_vram_mb: avail_vram,
            gpu_name,
            supported_backends: backends,
            timestamp_ms: now_ms,
        }
    }

    /// Probes NVIDIA GPU identity and memory via nvidia-smi if available.
    #[cfg(windows)]
    fn probe_gpu_info() -> (Option<String>, Option<u64>, Option<u64>) {
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        let output = match Command::new("nvidia-smi")
            .args(&["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(o) if o.status.success() => o,
            _ => return (None, None, None),
        };

        let text = String::from_utf8_lossy(&output.stdout);
        let first_line = match text.lines().next() {
            Some(l) if !l.trim().is_empty() => l.trim(),
            _ => return (None, None, None),
        };

        let parts: Vec<&str> = first_line.split(',').map(|s| s.trim()).collect();
        if parts.len() >= 3 {
            let name = parts[0].to_string();
            let total = parts[1].parse::<u64>().ok();
            let free = parts[2].parse::<u64>().ok();
            (Some(name), total, free)
        } else {
            (None, None, None)
        }
    }

    #[cfg(not(windows))]
    fn probe_gpu_info() -> (Option<String>, Option<u64>, Option<u64>) {
        (None, None, None)
    }

    /// Generates narrowly-scoped Windows Firewall rule command with specific RemoteAddress and Private/Domain profile.
    pub fn generate_firewall_command(port: u16, controller_ip: Option<&str>) -> String {
        let remote_arg = match controller_ip {
            Some(ip) if !ip.trim().is_empty() => format!(" -RemoteAddress '{}'", ip.trim()),
            _ => String::new(),
        };

        format!(
            "New-NetFirewallRule -Name 'Swarm_RPC_Worker_{}' -DisplayName 'Swarm GGML RPC (Port {})' -Group 'Swarm Compute' -Direction Inbound -LocalPort {} -Protocol TCP{} -Profile Private,Domain -Action Allow",
            port, port, port, remote_arg
        )
    }

    /// Generates the removal command for the Swarm-owned firewall rule.
    pub fn generate_firewall_remove_command(port: u16) -> String {
        format!(
            "Remove-NetFirewallRule -Name 'Swarm_RPC_Worker_{}' -ErrorAction SilentlyContinue",
            port
        )
    }

    /// Inspects Windows Firewall rule for the specified RPC port.
    #[cfg(windows)]
    pub fn inspect_firewall_status(port: u16, expected_controller: Option<&str>) -> (String, Option<String>) {
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        let ps_script = format!(
            "$r = Get-NetFirewallRule -Name 'Swarm_RPC_Worker_{port}' -ErrorAction SilentlyContinue;\
            if ($r) {{\
                $f = Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $r -ErrorAction SilentlyContinue;\
                if ($f) {{ $f.RemoteAddress }} else {{ 'Any' }}\
            }} else {{\
                $legacy = Get-NetFirewallRule -DisplayName 'Swarm GGML RPC' -ErrorAction SilentlyContinue;\
                if ($legacy) {{ 'LEGACY_UNRESTRICTED' }} else {{ 'NONE' }}\
            }}",
            port = port
        );

        let output = match Command::new("powershell")
            .args(&["-NoProfile", "-Command", &ps_script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
            _ => return ("Unknown".to_string(), None),
        };

        if output == "NONE" || output.is_empty() {
            ("MissingRule".to_string(), None)
        } else if output == "LEGACY_UNRESTRICTED" {
            ("UnrestrictedWarning".to_string(), Some("Any (Legacy Open Rule)".to_string()))
        } else if output == "Any" || output == "*" {
            ("UnrestrictedWarning".to_string(), Some("Any".to_string()))
        } else {
            let remote_ip = output.lines().next().unwrap_or("").trim().to_string();
            if let Some(exp) = expected_controller {
                if !exp.trim().is_empty() && remote_ip == exp.trim() {
                    ("RestrictedAndVerified".to_string(), Some(remote_ip))
                } else if !exp.trim().is_empty() {
                    ("ControllerMismatch".to_string(), Some(remote_ip))
                } else {
                    ("RestrictedAndVerified".to_string(), Some(remote_ip))
                }
            } else {
                ("RestrictedAndVerified".to_string(), Some(remote_ip))
            }
        }
    }

    #[cfg(not(windows))]
    pub fn inspect_firewall_status(_port: u16, _expected_controller: Option<&str>) -> (String, Option<String>) {
        ("RestrictedAndVerified".to_string(), None)
    }

    /// Applies a narrowly-scoped Windows Firewall rule with explicit elevation handling.
    #[cfg(windows)]
    pub fn apply_firewall_rule(port: u16, controller_ip: &str) -> Result<String, String> {
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        let parsed: std::net::IpAddr = controller_ip.trim().parse()
            .map_err(|_| format!("Invalid controller IP address '{}'", controller_ip))?;
        if parsed.is_loopback() || parsed.is_unspecified() || parsed.is_multicast() {
            return Err("Security Policy: Controller IP must be a valid unicast network address.".to_string());
        }

        let cmd_str = Self::generate_firewall_command(port, Some(controller_ip.trim()));

        // Remove any prior instance of this specific rule for clean update
        let _ = Command::new("powershell")
            .args(&[
                "-NoProfile",
                "-Command",
                &format!("Remove-NetFirewallRule -Name 'Swarm_RPC_Worker_{}' -ErrorAction SilentlyContinue", port),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .status();

        let output = Command::new("powershell")
            .args(&["-NoProfile", "-Command", &cmd_str])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Failed to invoke PowerShell: {}", e))?;

        if !output.status.success() {
            let err_text = String::from_utf8_lossy(&output.stderr);
            let out_text = String::from_utf8_lossy(&output.stdout);
            let combined = format!("{} {}", err_text, out_text);
            if combined.contains("Access is denied") || combined.contains("PermissionDenied") || combined.contains("0x80070005") {
                return Err(format!(
                    "Administrator privileges required to create Windows Firewall rule. Please run Swarm as Administrator, or execute this command in an elevated PowerShell terminal:\n{}",
                    cmd_str
                ));
            } else {
                return Err(format!("Windows Firewall configuration failed: {}. Command:\n{}", combined.trim(), cmd_str));
            }
        }

        Ok(format!("Firewall rule 'Swarm_RPC_Worker_{}' configured for controller {}.", port, controller_ip))
    }

    #[cfg(not(windows))]
    pub fn apply_firewall_rule(_port: u16, _controller_ip: &str) -> Result<String, String> {
        Ok("Firewall management not required on this platform".to_string())
    }

    /// Safely removes only Swarm-owned firewall rules.
    #[cfg(windows)]
    pub fn remove_firewall_rule(port: u16) -> Result<(), String> {
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        let ps_cmd = format!(
            "Remove-NetFirewallRule -Name 'Swarm_RPC_Worker_{port}' -ErrorAction SilentlyContinue; \
             Remove-NetFirewallRule -DisplayName 'Swarm GGML RPC' -ErrorAction SilentlyContinue",
            port = port
        );

        let _ = Command::new("powershell")
            .args(&["-NoProfile", "-Command", &ps_cmd])
            .creation_flags(CREATE_NO_WINDOW)
            .status();

        Ok(())
    }

    #[cfg(not(windows))]
    pub fn remove_firewall_rule(_port: u16) -> Result<(), String> {
        Ok(())
    }

    /// Queries currently established TCP client connections on the RPC worker port.
    #[cfg(windows)]
    pub fn query_active_connections(port: u16) -> Vec<String> {
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        let ps_cmd = format!(
            "Get-NetTCPConnection -LocalPort {} -State Established -ErrorAction SilentlyContinue | Select-Object -ExpandProperty RemoteAddress",
            port
        );

        let output = match Command::new("powershell")
            .args(&["-NoProfile", "-Command", &ps_cmd])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
            _ => return vec![],
        };

        output
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    }

    #[cfg(not(windows))]
    pub fn query_active_connections(_port: u16) -> Vec<String> {
        Vec::new()
    }

    /// Checks whether the firewall rule for the configured RPC port exists and
    /// is restricted to the expected controller. The port must be supplied by
    /// the caller; hard-coding 50052 produced false results for non-default
    /// worker ports.
    pub fn check_firewall_rule(port: u16, expected_controller: Option<&str>) -> Option<bool> {
        let (status, _) = Self::inspect_firewall_status(port, expected_controller);
        Some(status == "RestrictedAndVerified" || status == "UnrestrictedWarning")
    }

    /// Revokes remote access, reverts binding to loopback 127.0.0.1, and cleans up firewall rules.
    pub fn revoke_remote_access(&self) -> Result<WorkerModeStatus, String> {
        // Serialize with start/stop. Calling the public stop_worker() here
        // would try to re-acquire the same lock and deadlock.
        let _guard = self.lifecycle_lock.lock().unwrap();

        // 1. Stop the tracked worker before removing its remote binding. If
        // shutdown fails, do not claim that remote access was revoked.
        let has_tracked_worker = self
            .worker_pid
            .lock()
            .map(|pid| pid.is_some())
            .unwrap_or(false);
        if has_tracked_worker || self.is_active_worker() {
            self.stop_worker_locked()?;
        }

        // 2. Reset config to safe loopback defaults
        let mut config = self.get_config();
        let old_port = config.rpc_port;
        config.listen_host = "127.0.0.1".to_string();
        config.allow_remote_access = false;
        config.authorized_controller_ip = String::new();
        config.updated_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        self.save_config(&config)?;

        // 3. Remove Swarm-owned firewall rule
        Self::remove_firewall_rule(old_port)?;

        // 4. Reset last error
        *self.last_error.lock().unwrap() = None;

        Ok(self.get_status())
    }

    pub fn get_status(&self) -> WorkerModeStatus {
        let config = self.get_config();
        let mut state = self.current_state.lock().unwrap().clone();
        let original_state = state.clone();
        let mut pid_opt = *self.worker_pid.lock().unwrap();
        let observed_pid = pid_opt;
        let mut started_at_opt = *self.started_at.lock().unwrap();
        let mut last_err = self.last_error.lock().unwrap().clone();
        let mut state_changed = false;
        let mut pid_changed = false;

        // Refresh child process status if tracked. Crashed workers must clear
        // their stale PID/timestamp and publish the failure, otherwise the UI
        // can remain stuck on a dead worker that can never be started again.
        if let Some(pid) = pid_opt {
            let mut map = self.manager.managed_children.lock().unwrap();
            if let Some(child) = map.get_mut(&pid) {
                match child.refresh_status() {
                    ProcessStatus::Exited { exit_code } => {
                        state = "Failed".to_string();
                        last_err = Some(format!(
                            "Worker process PID {} exited unexpectedly with code {}.",
                            pid, exit_code
                        ));
                        pid_opt = None;
                        started_at_opt = None;
                        state_changed = true;
                        pid_changed = true;
                    }
                    ProcessStatus::Terminated => {
                        state = "Stopped".to_string();
                        pid_opt = None;
                        started_at_opt = None;
                        state_changed = true;
                        pid_changed = true;
                    }
                    ProcessStatus::Failed { reason } => {
                        state = "Failed".to_string();
                        last_err = Some(format!("Worker process PID {} failed: {}.", pid, reason));
                        pid_opt = None;
                        started_at_opt = None;
                        state_changed = true;
                        pid_changed = true;
                    }
                    ProcessStatus::Running => {}
                }
            } else {
                state = "Stopped".to_string();
                last_err = Some(format!(
                    "Worker process PID {} is no longer tracked by the supervisor.",
                    pid
                ));
                pid_opt = None;
                started_at_opt = None;
                state_changed = true;
                pid_changed = true;
            }
            drop(map);
        }

        let is_listening = is_host_port_listening(&config.listen_host, config.rpc_port);
        if is_listening && (state == "Starting" || state == "CheckingPrerequisites") {
            state = "Listening".to_string();
            state_changed = true;
        } else if !is_listening && state == "Listening" {
            // The process may still be alive but no longer serving. Keep the
            // PID so the operator can stop/clean it up, but do not report the
            // worker as listening.
            state = "Failed".to_string();
            last_err = Some(format!(
                "Worker PID {} is running but no longer listening on {}:{}.",
                pid_opt
                    .map(|pid| pid.to_string())
                    .unwrap_or_else(|| "unknown".to_string()),
                config.listen_host,
                config.rpc_port
            ));
            state_changed = true;
        } else if let Some(detail) = state.strip_prefix("Failed (") {
            // Compact the detailed failure state written by older versions
            // while preserving the diagnostic in last_error.
            if last_err.is_none() {
                last_err = Some(format!("Worker failed: {}", detail.trim_end_matches(')')));
            }
            state = "Failed".to_string();
            state_changed = true;
        }

        // Compare-and-set the individual fields. Status polling must not
        // overwrite a PID or state that a concurrent start/stop transition
        // installed after this snapshot was taken.
        if state_changed {
            let mut current_state = self.current_state.lock().unwrap();
            if *current_state == original_state {
                *current_state = state.clone();
                *self.last_error.lock().unwrap() = last_err.clone();
            } else {
                state = current_state.clone();
                last_err = self.last_error.lock().unwrap().clone();
            }
        }
        if pid_changed {
            let mut current_pid = self.worker_pid.lock().unwrap();
            if *current_pid == observed_pid {
                *current_pid = pid_opt;
                *self.started_at.lock().unwrap() = started_at_opt;
            } else {
                pid_opt = *current_pid;
                started_at_opt = *self.started_at.lock().unwrap();
            }
        }

        let uptime_secs = match started_at_opt {
            Some(t) if pid_opt.is_some() && is_listening => t.elapsed().as_secs(),
            _ => 0,
        };

        let listen_endpoint = if is_listening {
            Some(format!("{}:{}", config.listen_host, config.rpc_port))
        } else {
            None
        };

        let (interfaces, interface_names) = crate::supervisor::win32::get_local_ip_addresses_with_aliases();
        let preferred_ip = interfaces.first().cloned().unwrap_or_else(|| "127.0.0.1".to_string());
        let advertised_host = match config.listen_host.as_str() {
            // A loopback-only worker is not reachable through a LAN address.
            "127.0.0.1" | "localhost" | "::1" => "127.0.0.1",
            // A wildcard bind is reachable through the preferred LAN address.
            "0.0.0.0" | "::" => preferred_ip.as_str(),
            // An explicit interface address is already the correct endpoint.
            host => host,
        };
        let advertised_endpoint = format!("{}:{}", advertised_host, config.rpc_port);

        let hardware = Self::probe_hardware_telemetry();

        // Detailed firewall status determination
        let is_remote_binding = config.listen_host != "127.0.0.1" && config.allow_remote_access;
        let (fw_status, fw_remote_addr) = if !is_remote_binding {
            ("NotRequired".to_string(), None)
        } else {
            Self::inspect_firewall_status(
                config.rpc_port,
                if config.authorized_controller_ip.is_empty() {
                    None
                } else {
                    Some(&config.authorized_controller_ip)
                },
            )
        };

        let firewall_rule_installed = match fw_status.as_str() {
            "RestrictedAndVerified" | "UnrestrictedWarning" => Some(true),
            "NotRequired" => None,
            _ => Some(false),
        };

        let firewall_command = Self::generate_firewall_command(
            config.rpc_port,
            if config.authorized_controller_ip.is_empty() {
                None
            } else {
                Some(&config.authorized_controller_ip)
            },
        );

        let recent_logs = if let Some(pid) = pid_opt {
            self.manager.get_logs(pid, Some(40)).unwrap_or_default()
        } else {
            vec![]
        };

        let active_connections = if is_listening {
            Self::query_active_connections(config.rpc_port)
        } else {
            vec![]
        };

        let unencrypted_transport_warning = is_remote_binding;
        let transport_security_notice = if is_remote_binding {
            "NOTICE: GGML RPC transport is unencrypted and does not cryptographically authenticate clients. Remote sharing must only be run across a trusted private LAN or an encrypted WireGuard/Tailscale VPN. Do not expose port 50052 to the public internet.".to_string()
        } else {
            "Loopback Only: RPC traffic is restricted to 127.0.0.1 on this machine. No remote network exposure.".to_string()
        };

        WorkerModeStatus {
            role: config.role.clone(),
            state,
            pid: pid_opt,
            listen_endpoint,
            advertised_endpoint,
            endpoint_id: None,
            relay_url: None,
            pairing_code: None,
            is_listening,
            uptime_secs,
            last_error: last_err,
            hardware,
            config,
            network_interfaces: interfaces,
            network_interface_names: interface_names,
            firewall_rule_installed,
            firewall_status: fw_status,
            firewall_remote_address: fw_remote_addr,
            firewall_command,
            recent_logs,
            unencrypted_transport_warning,
            transport_security_notice,
            active_client_connections: active_connections,
            canonical_config_path: self.canonical_config_path.to_string_lossy().to_string(),
            is_remote_binding,
        }
    }

    /// Starts the supervised native RPC worker.
    pub fn start_worker(&self, config_override: Option<WorkerModeConfig>) -> Result<WorkerStartResult, String> {
        // Serialize the entire start transition with stop/revoke. Without
        // this, two starts can both pass the duplicate guard and spawn two
        // workers on the same port.
        let _guard = self.lifecycle_lock.lock().unwrap();

        let mut config = match config_override {
            Some(mut cfg) => {
                Self::sanitize_and_validate_config(&mut cfg)?;
                self.save_config(&cfg)?;
                cfg
            }
            None => self.get_config(),
        };

        // Re-validate bind address and security policies on startup unconditionally
        Self::sanitize_and_validate_config(&mut config)?;

        // 1. Guard against duplicate startup and clean up a stale/dead PID
        // left by a crash. A running worker that is still listening is
        // rejected rather than silently replaced.
        {
            let state = self.current_state.lock().unwrap().clone();
            if state == "Starting" || state == "CheckingPrerequisites" || state == "Stopping" {
                return Err("Worker is already starting or stopping".to_string());
            }

            let pid_opt = *self.worker_pid.lock().unwrap();
            if let Some(pid) = pid_opt {
                let running = {
                    let mut map = self.manager.managed_children.lock().unwrap();
                    map.get_mut(&pid)
                        .map(|child| matches!(child.refresh_status(), ProcessStatus::Running))
                        .unwrap_or(false)
                };
                let listening = is_host_port_listening(&config.listen_host, config.rpc_port);
                if running && listening {
                    return Err("Worker is already active or starting".to_string());
                }

                // The previous worker is dead or no longer listening. Reap it
                // before reusing its port/PID slot.
                let _ = shutdown_managed_child(pid, &self.manager.managed_children, 2000);
                *self.worker_pid.lock().unwrap() = None;
                *self.started_at.lock().unwrap() = None;
                if state == "Listening" {
                    *self.current_state.lock().unwrap() = "Stopped".to_string();
                }
            }
        }

        // 2. Strict Security Boundary: reject non-loopback bindings without explicit operator authorization
        if config.listen_host != "127.0.0.1" && !config.allow_remote_access {
            return Err("Safety Guard: Remote compute sharing is not authorized. Enable 'Authorize Remote Compute Sharing' before binding to a network interface.".to_string());
        }

        // 3. Port availability check
        if !is_host_port_available(&config.listen_host, config.rpc_port) {
            return Err(format!(
                "Port Conflict: RPC port {} is already in use on {} by another service. Stop any competing worker or select a different port.",
                config.rpc_port, config.listen_host
            ));
        }

        // 4. Resolve binary and DLL paths
        let runtime = resolve_native_runtime(&self.workspace_root)
            .map_err(|e| format!("Failed to resolve RPC runtime: {}", e))?;

        if !runtime.rpc_executable.exists() {
            return Err(format!(
                "Worker binary missing: {}",
                runtime.rpc_executable.display()
            ));
        }

        *self.current_state.lock().unwrap() = "CheckingPrerequisites".to_string();

        // 5. Build exact command line arguments
        let threads_str = config.threads.to_string();
        let port_str = config.rpc_port.to_string();
        let mut args: Vec<&str> = vec![
            "-H", &config.listen_host,
            "-p", &port_str,
            "-t", &threads_str,
        ];

        if config.enable_file_cache {
            args.push("-c");
        }

        let dev_arg = config.backend_device.clone();
        if dev_arg != "all" && !dev_arg.is_empty() {
            if dev_arg.eq_ignore_ascii_case("cpu") {
                args.push("-d");
                args.push("CPU");
            } else if !dev_arg.eq_ignore_ascii_case("cuda") {
                args.push("-d");
                args.push(&dev_arg);
            }
        }

        let dll_refs: Vec<&Path> = runtime.rpc_extra_dll_dirs.iter().map(|p| p.as_path()).collect();
        let working_dir = runtime.rpc_executable.parent().unwrap_or(&self.workspace_root);

        *self.current_state.lock().unwrap() = "Starting".to_string();

        // 6. Spawn inside Windows Job Object with hidden console
        let pid = match self.manager.spawn_child(
            &runtime.rpc_executable,
            &args,
            working_dir,
            &[],
            &dll_refs,
            ProcessRole::RpcWorker,
            vec![config.rpc_port],
            true, // with_console for graceful break
            true, // hide_console
        ) {
            Ok(p) => p,
            Err(e) => {
                let err_msg = format!("Failed to launch RPC worker process: {}", e);
                *self.current_state.lock().unwrap() = "Failed".to_string();
                *self.last_error.lock().unwrap() = Some(err_msg.clone());
                return Err(err_msg);
            }
        };

        *self.worker_pid.lock().unwrap() = Some(pid);
        *self.started_at.lock().unwrap() = Some(Instant::now());

        // 7. Verification: Poll TCP listener readiness
        let deadline = Instant::now() + std::time::Duration::from_millis(5000);
        let mut ready = false;

        while Instant::now() < deadline {
            // Check if child unexpectedly exited
            {
                let mut map = self.manager.managed_children.lock().unwrap();
                if let Some(child) = map.get_mut(&pid) {
                    if let ProcessStatus::Exited { exit_code } = child.refresh_status() {
                        let err_msg = format!("Worker process PID {} exited immediately with code {}", pid, exit_code);
                        drop(map);
                        let _ = shutdown_managed_child(pid, &self.manager.managed_children, 2000);
                        *self.worker_pid.lock().unwrap() = None;
                        *self.started_at.lock().unwrap() = None;
                        *self.current_state.lock().unwrap() = "Failed".to_string();
                        *self.last_error.lock().unwrap() = Some(err_msg.clone());
                        return Err(err_msg);
                    }
                }
            }

            if is_host_port_listening(&config.listen_host, config.rpc_port) {
                ready = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
        }

        if !ready {
            let err_msg = format!(
                "Worker PID {} failed to bind and listen on port {} within 5000 ms timeout.",
                pid, config.rpc_port
            );
            let _ = shutdown_managed_child(pid, &self.manager.managed_children, 2000);
            *self.worker_pid.lock().unwrap() = None;
            *self.started_at.lock().unwrap() = None;
            *self.current_state.lock().unwrap() = "Failed".to_string();
            *self.last_error.lock().unwrap() = Some(err_msg.clone());
            return Err(err_msg);
        }

        *self.current_state.lock().unwrap() = "Listening".to_string();
        *self.last_error.lock().unwrap() = None;

        // 8. Advertise this worker on UDP 50053 so Android phones can find the
        // PC with "Scan Nearby" instead of typing an IP address. Only a worker
        // reachable on a real interface is advertised; a loopback-only worker
        // would hand peers an address that resolves back to themselves.
        crate::supervisor::discovery::stop_responder();
        let is_loopback_bind = matches!(config.listen_host.as_str(), "127.0.0.1" | "localhost" | "::1");
        if !is_loopback_bind {
            let interfaces = crate::supervisor::win32::get_local_ip_addresses();
            let preferred_ip = interfaces
                .first()
                .cloned()
                .unwrap_or_else(|| "127.0.0.1".to_string());
            let advertised_host = match config.listen_host.as_str() {
                "0.0.0.0" | "::" => preferred_ip,
                host => host.to_string(),
            };
            crate::supervisor::discovery::start_responder(
                crate::supervisor::discovery::AdvertiseIdentity {
                    name: std::env::var("COMPUTERNAME")
                        .or_else(|_| std::env::var("HOSTNAME"))
                        .unwrap_or_else(|_| "Swarm Desktop".to_string()),
                    platform: std::env::consts::OS.to_string(),
                    port: config.rpc_port,
                    host: advertised_host,
                    endpoint_id: None,
                },
            );
        }

        let status = self.get_status();
        Ok(WorkerStartResult {
            success: true,
            status,
            message: format!(
                "Worker node is active and listening on {}:{} (PID {}). Ready to provide compute.",
                config.listen_host, config.rpc_port, pid
            ),
        })
    }

    /// Stops the supervised native RPC worker.
    pub fn stop_worker(&self) -> Result<WorkerModeStatus, String> {
        let _guard = self.lifecycle_lock.lock().unwrap();
        self.stop_worker_locked()
    }

    /// Stop implementation used by both the public command and revocation.
    /// Callers must already hold `lifecycle_lock`.
    fn stop_worker_locked(&self) -> Result<WorkerModeStatus, String> {
        use super::shutdown::ShutdownError;

        // Withdraw the LAN advertisement first so peers stop offering a worker
        // that is about to disappear.
        crate::supervisor::discovery::stop_responder();

        let prior_state = self.current_state.lock().unwrap().clone();
        *self.current_state.lock().unwrap() = "Stopping".to_string();
        let pid_opt = *self.worker_pid.lock().unwrap();
        let mut shutdown_error: Option<String> = None;

        if let Some(pid) = pid_opt {
            match shutdown_managed_child(pid, &self.manager.managed_children, 3000) {
                Ok(_) => {}
                Err(ShutdownError::ProcessNotManaged(_))
                | Err(ShutdownError::AlreadyExited(_)) => {
                    // The child already vanished; there is nothing left to
                    // terminate, so continue to the port-release check.
                }
                Err(e) => shutdown_error = Some(format!("Failed to stop worker PID {}: {}", pid, e)),
            }
        }

        // Wait for the port to be released only when a worker was tracked or
        // the state says it was supposed to be serving. Otherwise a stray
        // listener on the configured port would make an idle stop fail.
        let config = self.get_config();
        let wait_for_port = pid_opt.is_some()
            || prior_state == "Listening"
            || prior_state == "Starting"
            || prior_state == "CheckingPrerequisites";
        let mut port_released = !wait_for_port;
        if wait_for_port {
            let deadline = Instant::now() + std::time::Duration::from_millis(3000);
            while Instant::now() < deadline {
                if is_host_port_available(&config.listen_host, config.rpc_port) {
                    port_released = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }

        if let Some(err) = shutdown_error {
            *self.current_state.lock().unwrap() = "Failed".to_string();
            *self.last_error.lock().unwrap() = Some(err.clone());
            return Err(err);
        }

        // The process is gone (or was never tracked). Do not leave a stale
        // PID behind even if an unrelated process still owns the port.
        *self.worker_pid.lock().unwrap() = None;
        *self.started_at.lock().unwrap() = None;

        if !port_released {
            let err = format!(
                "Worker process stopped, but {}:{} is still in use by another process.",
                config.listen_host, config.rpc_port
            );
            *self.current_state.lock().unwrap() = "Failed".to_string();
            *self.last_error.lock().unwrap() = Some(err.clone());
            return Err(err);
        }

        *self.current_state.lock().unwrap() = "Stopped".to_string();
        *self.last_error.lock().unwrap() = None;
        Ok(self.get_status())
    }
}
