//! Dynamic runtime binary, DLL directory, and external model path resolution.
//!
//! Supports both:
//! 1. Development workflow: binaries in build-cuda / dist, models in repo models/
//! 2. Installed Windows package: bundled resources in bin/ or resources/bin, models external in %ProgramData%\Swarm\models\ or %LocalAppData%\Swarm\models\

use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use super::config::RuntimeProfile;
use super::win32::generate_secure_random_hex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteWorkerConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub added_at_ms: u64,
    pub is_active: bool,
    #[serde(default = "default_worker_transport")]
    pub transport: String,
    #[serde(default)]
    pub endpoint_id: Option<String>,
    #[serde(default)]
    pub direct_addr: Option<String>,
    /// Six-digit code shared out-of-band. Both ends hash it into the same
    /// Iroh identity so the desktop can dial a phone behind carrier NAT.
    #[serde(default)]
    pub pairing_code: Option<String>,
    #[serde(default)]
    pub relay_url: Option<String>,
    /// Loopback port served by the desktop's local tunnel dialer. When set,
    /// the coordinator connects here instead of the phone's unreachable LAN IP.
    #[serde(default)]
    pub tunnel_local_port: Option<u16>,
}

fn default_worker_transport() -> String {
    "tcp".to_string()
}

#[derive(Debug, Clone)]
pub struct RuntimePaths {
    pub coord_executable: PathBuf,
    pub rpc_executable: PathBuf,
    pub tunnel_executable: Option<PathBuf>,
    pub coord_extra_dll_dirs: Vec<PathBuf>,
    pub rpc_extra_dll_dirs: Vec<PathBuf>,
    pub is_installed_package: bool,
    pub model_path: PathBuf,
}

/// Resolves the official GGUF model path.
///
/// Order of precedence:
/// 1. SWARM_MODEL_PATH environment variable (if non-empty and points to existing file)
/// 2. Development workspace path (<workspace_root>\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf)
/// 3. %ProgramData%\Swarm\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf (or any *.gguf in %ProgramData%\Swarm\models)
/// 4. %LocalAppData%\Swarm\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf (or any *.gguf in %LocalAppData%\Swarm\models)
pub fn resolve_model_file(workspace_root: &Path) -> Result<PathBuf, String> {
    // 1. Explicit environment override
    if let Ok(env_path) = std::env::var("SWARM_MODEL_PATH") {
        let p = PathBuf::from(env_path.trim());
        if p.exists() && p.is_file() {
            return Ok(p);
        }
    }

    // 1b. Persistent library selection
    let lib_cfg_candidates = [
        std::env::var("LOCALAPPDATA").ok().map(|p| PathBuf::from(p).join(r"Swarm\config\model_library.json")),
        std::env::var("ProgramData").ok().map(|p| PathBuf::from(p).join(r"Swarm\config\model_library.json")),
        Some(workspace_root.join(r"dist\model_library.json")),
    ];
    for cand in lib_cfg_candidates.into_iter().flatten() {
        if cand.exists() {
            if let Ok(content) = std::fs::read_to_string(&cand) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(sel) = json.get("selected_model_path").and_then(|v| v.as_str()) {
                        let p = PathBuf::from(sel);
                        if p.exists() && p.is_file() {
                            return Ok(p);
                        }
                    }
                }
            }
        }
    }

    // 2. Development repository path
    let dev_model = workspace_root.join(r"models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf");
    if dev_model.exists() && dev_model.is_file() {
        return Ok(dev_model);
    }

    // 3. System-wide installed location (%ProgramData%\Swarm\models)
    if let Ok(program_data) = std::env::var("ProgramData") {
        let dir = PathBuf::from(program_data).join(r"Swarm\models");
        let target = dir.join("qwen2.5-3b-instruct-q4_k_m.official-check.gguf");
        if target.exists() && target.is_file() {
            return Ok(target);
        }
        if dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let ep = entry.path();
                    if ep.is_file() && ep.extension().map(|e| e.to_string_lossy().to_lowercase() == "gguf").unwrap_or(false) {
                        return Ok(ep);
                    }
                }
            }
        }
    }

    // 4. Per-user installed location (%LocalAppData%\Swarm\models)
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let dir = PathBuf::from(local_app_data).join(r"Swarm\models");
        let target = dir.join("qwen2.5-3b-instruct-q4_k_m.official-check.gguf");
        if target.exists() && target.is_file() {
            return Ok(target);
        }
        if dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let ep = entry.path();
                    if ep.is_file() && ep.extension().map(|e| e.to_string_lossy().to_lowercase() == "gguf").unwrap_or(false) {
                        return Ok(ep);
                    }
                }
            }
        }
    }

    Err(format!(
        "Official GGUF model not found. For an installed desktop deployment, place the Qwen 2.5 3B GGUF file in either:\n  1. %ProgramData%\\Swarm\\models\\qwen2.5-3b-instruct-q4_k_m.official-check.gguf\n  2. %LocalAppData%\\Swarm\\models\\qwen2.5-3b-instruct-q4_k_m.official-check.gguf\nor set the SWARM_MODEL_PATH environment variable to its location."
    ))
}

/// Resolves the native coordinator and worker executables and required DLL paths.
pub fn resolve_native_runtime(workspace_root: &Path) -> Result<RuntimePaths, String> {
    let current_exe = std::env::current_exe().ok();
    let exe_dir = current_exe.as_ref().and_then(|p| p.parent());

    // Installed application candidates:
    // 1. <exe_dir>\bin\swarm_node.exe (packaged side-by-side in bin/)
    // 2. <exe_dir>\resources\bin\swarm_node.exe (Tauri packaged resource structure)
    // 3. <exe_dir>\swarm_node.exe (flat installation)
    let installed_coord_candidates = match exe_dir {
        Some(dir) => vec![
            dir.join(r"bin\swarm_node.exe"),
            dir.join(r"resources\bin\swarm_node.exe"),
            dir.join("swarm_node.exe"),
        ],
        None => vec![],
    };

    let mut found_coord = None;
    let mut found_dll_dirs = Vec::new();
    let mut is_installed = false;

    for cand in installed_coord_candidates {
        if cand.exists() && cand.is_file() {
            let parent_buf = cand.parent().unwrap_or(workspace_root).to_path_buf();
            found_coord = Some(cand);
            found_dll_dirs = vec![parent_buf];
            is_installed = true;
            break;
        }
    }

    // If not found in installed locations, fallback to development workspace
    let coord_executable = match found_coord {
        Some(p) => p,
        None => {
            let dev_coord = workspace_root.join(r"build-cuda\swarm_node.exe");
            found_dll_dirs = vec![
                workspace_root.join("build-cuda"),
                workspace_root.join(r"build-cuda\bin"),
            ];
            dev_coord
        }
    };

    // RPC worker resolution
    let installed_rpc_candidates = match exe_dir {
        Some(dir) => vec![
            dir.join(r"bin\ggml-rpc-server.exe"),
            dir.join(r"resources\bin\ggml-rpc-server.exe"),
            dir.join("ggml-rpc-server.exe"),
        ],
        None => vec![],
    };

    let mut found_rpc = None;
    for cand in installed_rpc_candidates {
        if cand.exists() && cand.is_file() {
            found_rpc = Some(cand);
            break;
        }
    }

    let rpc_executable = match found_rpc {
        Some(p) => p,
        None => workspace_root.join(r"dist\swarm-worker-windows-x64\ggml-rpc-server.exe"),
    };

    // Tunnel binary resolution
    let installed_tunnel_candidates = match exe_dir {
        Some(dir) => vec![
            dir.join(r"bin\swarm-tunnel.exe"),
            dir.join(r"resources\bin\swarm-tunnel.exe"),
            dir.join("swarm-tunnel.exe"),
        ],
        None => vec![],
    };

    let mut found_tunnel = None;
    for cand in installed_tunnel_candidates {
        if cand.exists() && cand.is_file() {
            found_tunnel = Some(cand);
            break;
        }
    }

    let tunnel_executable = found_tunnel.or_else(|| {
        let dev_tunnel = workspace_root.join(r"spike\swarm-tunnel\target\release\swarm-tunnel.exe");
        if dev_tunnel.exists() && dev_tunnel.is_file() {
            Some(dev_tunnel)
        } else {
            None
        }
    });

    let model_path = resolve_model_file(workspace_root).unwrap_or_else(|_| {
        // Fallback default path for display/preflight reporting if not yet created
        workspace_root.join(r"models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf")
    });

    Ok(RuntimePaths {
        coord_executable,
        rpc_executable,
        tunnel_executable,
        coord_extra_dll_dirs: found_dll_dirs.clone(),
        rpc_extra_dll_dirs: found_dll_dirs,
        is_installed_package: is_installed,
        model_path,
    })
}

/// Secure first-run telemetry secret provisioning for cluster deployments.
///
/// Standalone CUDA profile returns Ok(None) because local single-GPU execution
/// does not use RPC worker telemetry.
/// Distributed cluster profile provisions or reads a 256-bit token from %ProgramData%\Swarm\secrets\telemetry.token
/// (or %LocalAppData%\Swarm\secrets\telemetry.token) with secure generation via Win32 CNG BCryptGenRandom.
pub fn ensure_telemetry_token_for_profile(
    profile: RuntimeProfile,
) -> Result<Option<PathBuf>, String> {
    match profile {
        RuntimeProfile::LowMemoryCudaStandalone => Ok(None),
        RuntimeProfile::DefaultCluster => {
            // If already configured by operator via environment, honor it
            if let Ok(env_token_file) = std::env::var("SWARM_TELEMETRY_TOKEN_FILE") {
                let p = PathBuf::from(env_token_file.trim());
                if p.exists() {
                    return Ok(Some(p));
                }
            }

            // Determine directory: prefer %ProgramData%\Swarm\secrets, fallback to %LocalAppData%\Swarm\secrets
            let base_dir = std::env::var("ProgramData")
                .map(|p| PathBuf::from(p).join(r"Swarm\secrets"))
                .or_else(|_| std::env::var("LOCALAPPDATA").map(|p| PathBuf::from(p).join(r"Swarm\secrets")))
                .map_err(|_| "Failed to determine Application Data directory for telemetry secret".to_string())?;

            let token_path = base_dir.join("telemetry.token");
            if token_path.exists() && token_path.is_file() {
                return Ok(Some(token_path));
            }

            // Provision new cryptographically secure token on first run
            std::fs::create_dir_all(&base_dir)
                .map_err(|e| format!("Failed to create secrets directory at {}: {}", base_dir.display(), e))?;

            let secret_hex = generate_secure_random_hex(32)?;
            std::fs::write(&token_path, &secret_hex)
                .map_err(|e| format!("Failed to write telemetry secret to {}: {}", token_path.display(), e))?;

            println!("[Supervisor Security] Provisioned first-run telemetry authentication token at {}", token_path.display());
            Ok(Some(token_path))
        }
    }
}

/// Reads the shared telemetry authentication Bearer token if it exists.
pub fn read_telemetry_token_if_exists() -> Option<String> {
    if let Ok(env_token_file) = std::env::var("SWARM_TELEMETRY_TOKEN_FILE") {
        let p = PathBuf::from(env_token_file.trim());
        if let Ok(tok) = std::fs::read_to_string(&p) {
            let trimmed = tok.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    let candidates = [
        std::env::var("ProgramData").ok().map(|p| PathBuf::from(p).join(r"Swarm\secrets\telemetry.token")),
        std::env::var("LOCALAPPDATA").ok().map(|p| PathBuf::from(p).join(r"Swarm\secrets\telemetry.token")),
    ];

    for candidate in candidates.into_iter().flatten() {
        if let Ok(tok) = std::fs::read_to_string(&candidate) {
            let trimmed = tok.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    None
}

/// Resolves the storage path for the persistent registered remote workers list.
pub fn resolve_remote_workers_file(workspace_root: &Path) -> PathBuf {
    if let Ok(program_data) = std::env::var("ProgramData") {
        let dir = PathBuf::from(program_data).join(r"Swarm\config");
        let _ = std::fs::create_dir_all(&dir);
        return dir.join("remote_workers.json");
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let dir = PathBuf::from(local_app_data).join(r"Swarm\config");
        let _ = std::fs::create_dir_all(&dir);
        return dir.join("remote_workers.json");
    }
    workspace_root.join(r"dist\remote_workers.json")
}

/// Loads registered remote workers from configuration.
pub fn load_remote_workers(workspace_root: &Path) -> Vec<RemoteWorkerConfig> {
    let p = resolve_remote_workers_file(workspace_root);

    if let Ok(content) = std::fs::read_to_string(&p) {
        if let Ok(workers) = serde_json::from_str::<Vec<RemoteWorkerConfig>>(&content) {
            return workers;
        }
    }

    // Recover from the backup if the primary file was truncated or a
    // replacement failed between remove and rename.
    let backup_path = p.with_extension("backup.json");
    if let Ok(content) = std::fs::read_to_string(&backup_path) {
        if let Ok(workers) = serde_json::from_str::<Vec<RemoteWorkerConfig>>(&content) {
            eprintln!(
                "[RemoteWorkers] Recovered {} worker record(s) from {}",
                workers.len(),
                backup_path.display()
            );
            return workers;
        }
    }

    Vec::new()
}

/// Persists registered remote workers to configuration.
///
/// Writes to a temporary file and renames it into place so a crash or power
/// loss cannot leave a half-written `remote_workers.json` that fails to parse
/// and silently discards every registered worker.
pub fn save_remote_workers(workspace_root: &Path, workers: &[RemoteWorkerConfig]) -> Result<(), String> {
    use std::io::Write;

    let p = resolve_remote_workers_file(workspace_root);
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let json_str = serde_json::to_string_pretty(workers).map_err(|e| e.to_string())?;
    let tmp_path = p.with_extension("json.tmp");

    let write_result = (|| -> Result<(), String> {
        let mut file = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create {}: {}", tmp_path.display(), e))?;
        file.write_all(json_str.as_bytes())
            .map_err(|e| format!("Failed to write {}: {}", tmp_path.display(), e))?;
        file.sync_all()
            .map_err(|e| format!("Failed to flush {}: {}", tmp_path.display(), e))?;
        drop(file);

        if p.exists() {
            let backup_path = p.with_extension("backup.json");
            let _ = std::fs::copy(&p, &backup_path);
            std::fs::remove_file(&p)
                .map_err(|e| format!("Failed to replace {}: {}", p.display(), e))?;
        }

        std::fs::rename(&tmp_path, &p)
            .map_err(|e| format!("Failed to install {}: {}", p.display(), e))
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    write_result
}
