//! Engine lifecycle management, profile resolution, and environment construction.

use std::path::PathBuf;
use tauri::State;

use super::types::*;
use super::diagnostics::run_preflight_check;
use crate::supervisor::config::{
    evaluate_profile_resource_eligibility, is_loopback_port_available,
    AvailableProfilesResponse, CoordinatorConfig, ProfileEnvVar, RuntimeProfile,
    RuntimeProfileMetadata,
};
use crate::supervisor::orchestrator::{ClusterLifecycleState, ClusterStatus, StagedLaunchConfig};
use crate::supervisor::paths::{
    ensure_telemetry_token_for_profile, load_remote_workers, resolve_model_file,
    resolve_native_runtime, RemoteWorkerConfig,
};
use crate::supervisor::planning;
use crate::supervisor::shutdown::shutdown_managed_child;
use crate::supervisor::win32;

#[tauri::command]
pub fn supervisor_start_coordinator() -> Result<u32, String> {
    Err("Safety Guard: Direct uncoordinated launch of production coordinator is disabled. Use controlled supervisor_start_engine instead.".to_string())
}



/// Evaluates physical RAM and GPU VRAM thresholds for the standalone CUDA low-memory profile.
/// Fails closed (returns Err) if either measurement cannot be obtained (None) or if either is below threshold.
/// Requires at least 1,000 MB physical RAM and at least 3,100 MiB GPU VRAM.
pub fn evaluate_standalone_resource_thresholds(
    avail_ram_mb: Option<u64>,
    avail_vram_mb: Option<u64>,
) -> Result<(), String> {
    let ram = match avail_ram_mb {
        Some(r) => r,
        None => {
            return Err("Preflight Resource Check Failed (Fail-Closed): Unable to obtain physical RAM reading from Win32 GlobalMemoryStatusEx. Launch aborted.".to_string());
        }
    };
    let min_ram: u64 = std::env::var("SWARM_MIN_RAM_MB")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1000);
    if ram < min_ram {
        let req_str = if min_ram == 1000 { "1,000".to_string() } else { min_ram.to_string() };
        return Err(format!(
            "Resource Preflight Failure: Measured available physical RAM is {} MB, which is below the conservative threshold of {} MB required for the standalone CUDA test profile. Free system memory before launching.",
            ram, req_str
        ));
    }

    let vram = match avail_vram_mb {
        Some(v) => v,
        None => {
            return Err("Preflight Resource Check Failed (Fail-Closed): Unable to obtain GPU VRAM reading from nvidia-smi. Ensure NVIDIA graphics driver and nvidia-smi are accessible. Launch aborted.".to_string());
        }
    };
    let min_vram = std::env::var("SWARM_MIN_VRAM_MB")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(3100);

    if vram < min_vram {
        return Err(format!(
            "Resource Preflight Failure: Measured available GPU VRAM is {} MiB, which is below the conservative threshold of 3,100 MiB required for full 37-layer CUDA offload. Close GPU-consuming applications before launching.",
            vram
        ));
    }

    Ok(())
}

/// Constructs the exact environment variable pairs for the standalone CUDA coordinator process,
/// applying any active ComputeAllocationConfig (such as offload layers or context size).
pub fn build_standalone_cuda_coordinator_env_with_allocation(
    model_path: &std::path::Path,
    allocation_config: Option<&crate::supervisor::planning::ComputeAllocationConfig>,
) -> Vec<(String, String)> {
    let (n_gpu_layers, ctx_size) = match allocation_config {
        Some(alloc) => {
            let layers = if alloc.total_offload_layers >= 0 {
                alloc.total_offload_layers.to_string()
            } else {
                "-1".to_string()
            };
            (layers, alloc.context_size.to_string())
        }
        None => ("-1".to_string(), "512".to_string()),
    };

    vec![
        ("SWARM_USE_RPC".to_string(), "0".to_string()),
        ("PORT".to_string(), "8080".to_string()),
        ("SWARM_MODEL_PATH".to_string(), model_path.to_string_lossy().to_string()),
        ("SWARM_N_GPU_LAYERS".to_string(), n_gpu_layers),
        ("SWARM_CTX_SIZE".to_string(), ctx_size),
        ("SWARM_PLACEMENT_POLICY".to_string(), "none".to_string()),
        ("SWARM_DEPLOYMENT_ENV".to_string(), "development".to_string()),
    ]
}

/// Constructs the exact environment variable pairs for the standalone CUDA coordinator process.
pub fn build_standalone_cuda_coordinator_env(model_path: &std::path::Path) -> Vec<(String, String)> {
    build_standalone_cuda_coordinator_env_with_allocation(model_path, None)
}

/// Constructs the exact environment variable pairs for the standard distributed cluster coordinator process.
pub fn build_default_cluster_coordinator_env(model_path: &std::path::Path) -> Vec<(String, String)> {
    build_default_cluster_coordinator_env_with_workers(model_path, &[])
}

/// Constructs the exact environment variable pairs for the standard distributed cluster coordinator process,
/// integrating the local RPC worker and any registered remote worker endpoints.
pub fn build_default_cluster_coordinator_env_with_workers(
    model_path: &std::path::Path,
    remote_workers: &[RemoteWorkerConfig],
) -> Vec<(String, String)> {
    build_default_cluster_coordinator_env_with_workers_and_allocation(model_path, remote_workers, None)
}

/// Constructs the exact environment variable pairs for the standard distributed cluster coordinator process,
/// integrating registered remote workers and applying any active ComputeAllocationConfig.
pub fn build_default_cluster_coordinator_env_with_workers_and_allocation(
    model_path: &std::path::Path,
    remote_workers: &[RemoteWorkerConfig],
    allocation_config: Option<&crate::supervisor::planning::ComputeAllocationConfig>,
) -> Vec<(String, String)> {
    let model_profile = if model_path.exists() {
        crate::supervisor::planning::model_planning_profile_from_path(model_path)
    } else {
        crate::supervisor::planning::ModelPlanningProfile::default()
    };

    let mut all_endpoints = vec!["127.0.0.1:50052".to_string()];
    for rw in remote_workers {
        if rw.is_active {
            let ep = format!("{}:{}", rw.host.trim(), rw.port);
            if !all_endpoints.contains(&ep) {
                all_endpoints.push(ep);
            }
        }
    }

    let (mut endpoints, policy, n_gpu_layers_raw, extra_envs) = match allocation_config {
        Some(alloc) if alloc.mode == "automatic" => {
            let filtered: Vec<String> = all_endpoints
                .into_iter()
                .filter(|ep| {
                    alloc.device_settings.iter().find(|s| s.device_id == *ep).map(|s| s.enabled).unwrap_or(true)
                })
                .collect();
            let extras = vec![
                ("SWARM_RESERVED_HEADROOM_RAM_MB".to_string(), alloc.reserved_headroom_ram_mb.to_string()),
                ("SWARM_RESERVED_HEADROOM_VRAM_MB".to_string(), alloc.reserved_headroom_vram_mb.to_string()),
            ];
            (filtered, "dynamic".to_string(), alloc.total_offload_layers, extras)
        }
        Some(alloc) if alloc.mode == "manual" => {
            let filtered: Vec<String> = all_endpoints
                .into_iter()
                .filter(|ep| {
                    alloc.device_settings.iter().find(|s| s.device_id == *ep).map(|s| s.enabled).unwrap_or(true)
                })
                .collect();
            let mut profile_entries = Vec::new();
            for s in &alloc.device_settings {
                if s.enabled {
                    profile_entries.push(format!("{}={}MB", s.device_id, s.memory_budget_mb));
                } else {
                    profile_entries.push(format!("{}=0MB", s.device_id));
                }
            }
            let extras = vec![
                ("SWARM_WORKER_PROFILES".to_string(), profile_entries.join(",")),
            ];
            (filtered, "resource_aware".to_string(), alloc.total_offload_layers, extras)
        }
        _ => (all_endpoints, "none".to_string(), 4, vec![]),
    };

    if endpoints.is_empty() {
        endpoints.push("127.0.0.1:50052".to_string());
    }

    let ctx_size_i32 = allocation_config.map(|alloc| alloc.context_size).unwrap_or(2048);
    let bytes_per_layer = crate::supervisor::planning::estimate_bytes_per_layer_with_weights(
        ctx_size_i32,
        model_profile.weights_bytes_per_layer,
    );
    // Never ask the native policy for more layers than the selected model has.
    // Values above the model's total (or -1) mean "all layers".
    let n_gpu_layers = if n_gpu_layers_raw < 0 || n_gpu_layers_raw > model_profile.total_layers {
        "-1".to_string()
    } else {
        n_gpu_layers_raw.to_string()
    };

    let mut envs = vec![
        ("SWARM_USE_RPC".to_string(), "1".to_string()),
        ("PORT".to_string(), "8080".to_string()),
        ("SWARM_MODEL_PATH".to_string(), model_path.to_string_lossy().to_string()),
        ("SWARM_N_GPU_LAYERS".to_string(), n_gpu_layers),
        ("SWARM_CTX_SIZE".to_string(), ctx_size_i32.to_string()),
        ("SWARM_MODEL_TRANSFORMER_LAYERS".to_string(), model_profile.transformer_layers.to_string()),
        ("SWARM_ESTIMATED_BYTES_PER_LAYER".to_string(), bytes_per_layer.to_string()),
        ("SWARM_RPC_ENDPOINTS".to_string(), endpoints.join(",")),
        ("SWARM_PLACEMENT_POLICY".to_string(), policy),
        ("SWARM_DEPLOYMENT_ENV".to_string(), "development".to_string()),
    ];
    envs.extend(extra_envs);
    envs
}

/// Resolves environment variable pairs for a given profile into structured ProfileEnvVar items.
pub fn get_profile_env_vars(profile: RuntimeProfile, workspace_root: &std::path::Path) -> Vec<ProfileEnvVar> {
    let model_path = resolve_model_file(workspace_root).unwrap_or_else(|_| workspace_root.join(r"models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf"));
    let remote_workers = load_remote_workers(workspace_root);
    let allocation_cfg = crate::supervisor::planning::load_allocation_config(workspace_root);
    let raw = match profile {
        RuntimeProfile::DefaultCluster => build_default_cluster_coordinator_env_with_workers_and_allocation(&model_path, &remote_workers, allocation_cfg.as_ref()),
        RuntimeProfile::LowMemoryCudaStandalone => build_standalone_cuda_coordinator_env_with_allocation(&model_path, allocation_cfg.as_ref()),
    };
    raw.into_iter().map(|(key, value)| ProfileEnvVar { key, value }).collect()
}

/// Generates the complete available profiles report with static metadata and live preflight eligibility.
/// Strictly read-only: does not launch processes, modify configuration, or allocate buffers.
pub fn get_available_profiles_internal(
    workspace_root: &std::path::Path,
    avail_ram_mb: Option<u64>,
    avail_vram_mb: Option<u64>,
) -> AvailableProfilesResponse {
    let port_8080_free = is_loopback_port_available(8080);
    let port_50052_free = is_loopback_port_available(50052);
    get_available_profiles_internal_with_ports(
        workspace_root,
        avail_ram_mb,
        avail_vram_mb,
        port_8080_free,
        port_50052_free,
    )
}

/// Helper supporting parameterized port availability for deterministic test fixtures.
pub fn get_available_profiles_internal_with_ports(
    workspace_root: &std::path::Path,
    avail_ram_mb: Option<u64>,
    avail_vram_mb: Option<u64>,
    port_8080_free: bool,
    port_50052_free: bool,
) -> AvailableProfilesResponse {
    let mut profiles = Vec::new();
    for prof in RuntimeProfile::ALL {
        let eligibility = evaluate_profile_resource_eligibility(
            prof,
            avail_ram_mb,
            avail_vram_mb,
            port_8080_free,
            port_50052_free,
        );
        let env_vars = get_profile_env_vars(prof, workspace_root);

        profiles.push(RuntimeProfileMetadata {
            id: prof.id().to_string(),
            display_name: prof.display_name().to_string(),
            description: prof.description().to_string(),
            is_default: prof.is_default(),
            required_ram_mb: prof.required_ram_mb(),
            required_vram_mb: prof.required_vram_mb(),
            coordinator_port: prof.coordinator_port(),
            rpc_port: prof.rpc_port(),
            requires_rpc_worker: prof.requires_rpc_worker(),
            requires_real_authorization: prof.requires_real_authorization(),
            env_vars,
            eligibility,
        });
    }

    AvailableProfilesResponse {
        default_profile_id: RuntimeProfile::DefaultCluster.id().to_string(),
        profiles,
        queried_ram_mb: avail_ram_mb,
        queried_vram_mb: avail_vram_mb,
        query_timestamp: format!("{:?}", std::time::SystemTime::now()),
    }
}

/// Generates a deterministic simulated profile fixture response for testing.
pub fn get_profile_fixture_internal(
    workspace_root: &std::path::Path,
    fixture_name: &str,
) -> Result<AvailableProfilesResponse, String> {
    match fixture_name {
        "profile_both_eligible" => Ok(get_available_profiles_internal_with_ports(
            workspace_root,
            Some(1600),
            Some(3500),
            true,
            true,
        )),
        "profile_ram_deficit" => Ok(get_available_profiles_internal_with_ports(
            workspace_root,
            Some(1200),
            Some(3500),
            true,
            true,
        )),
        "profile_vram_deficit" => Ok(get_available_profiles_internal_with_ports(
            workspace_root,
            Some(1600),
            Some(2800),
            true,
            true,
        )),
        "profile_unknown_metrics" => Ok(get_available_profiles_internal_with_ports(
            workspace_root,
            None,
            None,
            true,
            true,
        )),
        "profile_rpc_port_conflict" => Ok(get_available_profiles_internal_with_ports(
            workspace_root,
            Some(1600),
            Some(3500),
            true,
            false,
        )),
        unknown => Err(format!(
            "Unknown profile fixture: '{}'. Available fixtures: profile_both_eligible, profile_ram_deficit, profile_vram_deficit, profile_unknown_metrics, profile_rpc_port_conflict",
            unknown
        )),
    }
}

pub fn start_engine_internal(
    state: &SupervisorState,
    options: Option<StartEngineOptions>,
) -> Result<EngineStartResult, String> {
    let opts = options.unwrap_or_default();
    let mode = opts.mode.unwrap_or_else(|| "simulated".to_string());

    // Profile safety guard: reject unknown profiles and prevent silent fallback.
    // None or "default" strictly resolves to DefaultCluster.
    let profile = match opts.profile.as_deref() {
        None | Some("default") => RuntimeProfile::DefaultCluster,
        Some("low_memory_cuda_standalone") => RuntimeProfile::LowMemoryCudaStandalone,
        Some(unknown) => {
            return Err(format!(
                "Unknown supervisor profile '{}'. Supported profiles are 'default' and 'low_memory_cuda_standalone'. Silent fallback prevented.",
                unknown
            ));
        }
    };
    let is_low_mem_standalone = profile == RuntimeProfile::LowMemoryCudaStandalone;
    state.orchestrator.set_active_profile(Some(profile.id().to_string()));

    // 1. Guard against duplicate startup and cleanly clean up any dead/errored cluster run
    let current_status = state.orchestrator.get_status();
    match current_status.state {
        ClusterLifecycleState::Stopped => {}
        ClusterLifecycleState::Error { .. } => {
            // A prior cluster session encountered an error or crashed. Ensure any lingering
            // managed child processes are stopped and ports released before re-evaluating ports.
            let _ = state.orchestrator.stop_staged(2000);
        }
        ref busy_state => {
            return Err(format!(
                "Duplicate startup rejected: cluster is already in lifecycle state {:?}",
                busy_state
            ));
        }
    }

    // 2. Query available physical memory and VRAM for headroom checks
    let mem_info = crate::supervisor::win32::get_available_physical_memory();
    let avail_ram_mb = mem_info.map(|(avail, _)| avail / (1024 * 1024));
    let total_ram_mb = mem_info.map(|(_, total)| total / (1024 * 1024));

    let vram_info = crate::supervisor::win32::get_available_vram_mb();
    let avail_vram_mb = vram_info.map(|(free, _)| free);
    let total_vram_mb = vram_info.map(|(_, total)| total);

    if mode == "real" {
        if is_low_mem_standalone {
            // Standalone CUDA Mode: Isolated low-memory profile
            // Coordinator port 8080 must be available. RPC port 50052 is not required (SWARM_USE_RPC=0).
            if !is_loopback_port_available(8080) {
                return Err("Port Conflict: Coordinator port 8080 is already occupied by an external/unmanaged process. Supervisor refuses to overwrite or terminate existing processes.".to_string());
            }

            let preflight_cfg = CoordinatorConfig {
                port: 8080,
                rpc_port: 0,
                gpu_layers: 37,
                threads: 2,
                model_path: String::new(),
                use_rpc: false,
            };
            let preflight = run_preflight_check(&state.workspace_root, preflight_cfg);
            if !preflight.can_launch {
                return Err(format!(
                    "Preflight validation failed: {}",
                    preflight.issues.join("; ")
                ));
            }

            // Phase C.3.5: Conservative low-memory preflight evaluation (Fail-closed on None, RAM >= 1,000 MB, VRAM >= 3,100 MiB)
            evaluate_standalone_resource_thresholds(avail_ram_mb, avail_vram_mb)?;

            // Explicit operator authorization required for real execution
            if opts.allow_real_runtime != Some(true) {
                return Err("Gate 3 Safety Boundary: Real-runtime standalone CUDA launch is prepared and preflight-validated, but requires explicit operator authorization (allow_real_runtime: true) before starting production Swarm processes. Zero real processes spawned.".to_string());
            }

            // Concrete production standalone configuration (supports installed and development layouts)
            let runtime_paths = resolve_native_runtime(&state.workspace_root)
                .map_err(|e| format!("Runtime Binary Resolution Failed: {}", e))?;
            let model_target = state.model_library.get_selected_model_path()
                .filter(|p| p.exists())
                .unwrap_or_else(|| resolve_model_file(&state.workspace_root).unwrap_or_default());
            if !model_target.exists() {
                return Err("Model Path Resolution Failed: No model selected in Model Library or found on disk.".to_string());
            }
            unsafe {
                std::env::set_var("SWARM_MODEL_PATH", &model_target);
            }

            let allocation_cfg = crate::supervisor::planning::load_allocation_config(&state.workspace_root);
            let standalone_env = build_standalone_cuda_coordinator_env_with_allocation(&model_target, allocation_cfg.as_ref());
            let n_gpu_layers_str = standalone_env.iter().find(|(k, _)| k == "SWARM_N_GPU_LAYERS").map(|(_, v)| v.as_str()).unwrap_or("-1").to_string();
            let ctx_size_str = standalone_env.iter().find(|(k, _)| k == "SWARM_CTX_SIZE").map(|(_, v)| v.as_str()).unwrap_or("512").to_string();

            let standalone_readiness_timeout = std::env::var("SWARM_READINESS_TIMEOUT_MS")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(90000);

            let config = StagedLaunchConfig {
                rpc_executable: PathBuf::new(),
                rpc_working_dir: state.workspace_root.clone(),
                rpc_args: vec![],
                rpc_extra_dll_dirs: vec![],
                rpc_env: vec![],
                rpc_port: 0,
                rpc_readiness_timeout_ms: 0,

                coord_executable: runtime_paths.coord_executable,
                coord_working_dir: state.workspace_root.clone(),
                coord_args: vec![],
                coord_extra_dll_dirs: runtime_paths.coord_extra_dll_dirs,
                coord_env: standalone_env,
                coord_port: 8080,
                coord_health_path: "/health".to_string(),
                coord_readiness_timeout_ms: standalone_readiness_timeout,
            };

            match state.orchestrator.start_staged(&config) {
                Ok(()) => {
                    let status = state.orchestrator.get_status();
                    return Ok(EngineStartResult {
                        success: true,
                        status,
                        message: format!("Real Standalone CUDA Swarm Engine started successfully: Coordinator verified healthy (SWARM_USE_RPC=0, SWARM_N_GPU_LAYERS={}, SWARM_CTX_SIZE={}).", n_gpu_layers_str, ctx_size_str),
                        preflight: Some(preflight),
                        available_ram_mb: avail_ram_mb,
                        total_ram_mb: total_ram_mb,
                        available_vram_mb: avail_vram_mb,
                        total_vram_mb: total_vram_mb,
                    });
                }
                Err(e) => {
                    return Err(format!("Standalone CUDA Startup Failed: {}", e));
                }
            }
        }

        // Standard Dual-Process Mode / Combined Mode: preserves original 1,500 MB free-RAM guard
        let worker_already_active = state.worker_manager.is_active_worker()
            && state.worker_manager.get_config().rpc_port == 50052;

        if !is_loopback_port_available(8080) {
            return Err("Port Conflict: Coordinator port 8080 is already occupied by an external/unmanaged process. Supervisor refuses to overwrite or terminate existing processes.".to_string());
        }
        if !worker_already_active && !is_loopback_port_available(50052) {
            return Err("Port Conflict: RPC port 50052 is already occupied by an external/unmanaged process. Supervisor refuses to overwrite or terminate existing processes.".to_string());
        }

        let mut preflight_cfg = CoordinatorConfig::default();
        if worker_already_active {
            preflight_cfg.rpc_port = 0;
        }
        let preflight = run_preflight_check(&state.workspace_root, preflight_cfg);
        if !preflight.can_launch {
            return Err(format!(
                "Preflight validation failed: {}",
                preflight.issues.join("; ")
            ));
        }

        let avail_ram = match avail_ram_mb {
            Some(r) => r,
            None => {
                return Err("Preflight Resource Check Failed (Fail-Closed): Unable to obtain physical RAM reading from Win32 GlobalMemoryStatusEx. Launch aborted.".to_string());
            }
        };

        let min_ram_required = std::env::var("SWARM_MIN_RAM_MB")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(if worker_already_active { 1000 } else { 1500 });
        if avail_ram < min_ram_required {
            return Err(format!(
                "Resource Headroom Warning: Only {} MB of physical RAM is free (minimum {} MB recommended for 1.96 GB model in Combined Mode). Free RAM before launching.",
                avail_ram, min_ram_required
            ));
        }

        if opts.allow_real_runtime != Some(true) {
            return Err("Gate 3 Safety Boundary: Real-runtime cluster launch is prepared and preflight-validated, but requires explicit operator authorization (allow_real_runtime: true) before starting production Swarm processes. Zero real processes spawned.".to_string());
        }

        // Concrete production configuration using audited paths and parameters
        let runtime_paths = resolve_native_runtime(&state.workspace_root)
            .map_err(|e| format!("Runtime Binary Resolution Failed: {}", e))?;
        let model_target = state.model_library.get_selected_model_path()
            .filter(|p| p.exists())
            .unwrap_or_else(|| resolve_model_file(&state.workspace_root).unwrap_or_default());
        if !model_target.exists() {
            return Err("Model Path Resolution Failed: No model selected in Model Library or found on disk.".to_string());
        }
        unsafe {
            std::env::set_var("SWARM_MODEL_PATH", &model_target);
        }

        // Secure first-run telemetry token provisioning if needed for cluster
        let remote_workers = load_remote_workers(&state.workspace_root);
        let tunnel_warnings = crate::supervisor::tunnel::ensure_worker_tunnels(&remote_workers);
        if !tunnel_warnings.is_empty() {
            return Err(format!(
                "Encrypted tunnel unavailable: {}",
                tunnel_warnings.join("; ")
            ));
        }
        let allocation_cfg = crate::supervisor::planning::load_allocation_config(&state.workspace_root);
        let mut coord_env = build_default_cluster_coordinator_env_with_workers_and_allocation(
            &model_target,
            &remote_workers,
            allocation_cfg.as_ref(),
        );
        if let Ok(Some(token_path)) = ensure_telemetry_token_for_profile(RuntimeProfile::DefaultCluster) {
            coord_env.push(("SWARM_TELEMETRY_TOKEN_FILE".to_string(), token_path.to_string_lossy().to_string()));
        }

        let (rpc_exe, rpc_port_target, rpc_timeout) = if worker_already_active {
            // Combined Mode: Worker Mode is already supervising an active GGML RPC worker on port 50052.
            // Coordinator will attach directly to the existing worker without spawning a duplicate.
            log::info!("[Supervisor] Combined Mode: Attaching to active supervised Worker Mode on port 50052");
            (PathBuf::new(), 0, 0)
        } else {
            (runtime_paths.rpc_executable, 50052, 10000)
        };

        let readiness_timeout = if let Some(custom_to) = std::env::var("SWARM_READINESS_TIMEOUT_MS").ok().and_then(|v| v.parse::<u64>().ok()) {
            custom_to
        } else if remote_workers.iter().any(|w| w.is_active && (!w.host.starts_with("127.") || w.transport == "iroh")) {
            240000 // 240s (4 minutes) for remote multi-node Wi-Fi / cellular weight streaming
        } else {
            35000
        };

        // Proactively probe active remote workers to fail fast with a friendly message if unreachable
        for rw in &remote_workers {
            if rw.is_active && !rw.host.starts_with("127.") && rw.host != "localhost" {
                let target = format!("{}:{}", rw.host.trim(), rw.port);
                let reachable = std::net::ToSocketAddrs::to_socket_addrs(&target)
                    .ok()
                    .map(|mut addrs| {
                        addrs.any(|addr| {
                            std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(1500)).is_ok()
                        })
                    })
                    .unwrap_or(false);

                if !reachable {
                    return Err(format!(
                        "Remote worker '{}' ({}:{}) is unreachable. Ensure the worker device is online and ggml-rpc-server is running, or switch to Standalone CUDA to run locally.",
                        rw.name, rw.host, rw.port
                    ));
                }
            }
        }

        let config = StagedLaunchConfig {
            rpc_executable: rpc_exe,
            rpc_working_dir: state.workspace_root.clone(),
            rpc_args: vec![
                "--host".to_string(), "127.0.0.1".to_string(),
                "--port".to_string(), "50052".to_string(),
                "--threads".to_string(), "2".to_string(),
            ],
            rpc_extra_dll_dirs: runtime_paths.rpc_extra_dll_dirs,
            rpc_env: vec![],
            rpc_port: rpc_port_target,
            rpc_readiness_timeout_ms: rpc_timeout,

            coord_executable: runtime_paths.coord_executable,
            coord_working_dir: state.workspace_root.clone(),
            coord_args: vec![],
            coord_extra_dll_dirs: runtime_paths.coord_extra_dll_dirs,
            coord_env,
            coord_port: 8080,
            coord_health_path: "/health".to_string(),
            coord_readiness_timeout_ms: readiness_timeout,
        };

        match state.orchestrator.start_staged(&config) {
            Ok(()) => {
                let status = state.orchestrator.get_status();
                return Ok(EngineStartResult {
                    success: true,
                    status,
                    message: "Real Production Swarm Engine started successfully: RPC worker and Coordinator verified healthy.".to_string(),
                    preflight: Some(preflight),
                    available_ram_mb: avail_ram_mb,
                    total_ram_mb: total_ram_mb,
                    available_vram_mb: avail_vram_mb,
                    total_vram_mb: total_vram_mb,
                });
            }
            Err(e) => {
                return Err(format!("Production Startup Failed: {}", e));
            }
        }
    }

    // Safe Test / Simulated Mode using harmless test_child
    let test_child_bin = state.workspace_root.join(r"spike\desktop-shell\src-tauri\target\debug\test_child.exe");
    if !test_child_bin.exists() {
        return Err(format!("test_child.exe binary not found at {}. Build with 'cargo build --bin test_child'.", test_child_bin.display()));
    }
    let working_dir = state.workspace_root.join(r"spike\desktop-shell");

    let coord_port = 59261;
    let sim_fail = opts.simulate_failure.as_deref().unwrap_or("none");

    if sim_fail == "port_conflict" {
        let dummy = std::net::TcpListener::bind(("127.0.0.1", coord_port)).map_err(|e| e.to_string())?;
        let config = StagedLaunchConfig {
            rpc_executable: test_child_bin.clone(),
            rpc_working_dir: working_dir.clone(),
            rpc_args: vec!["--listen".to_string(), "59260".to_string()],
            rpc_extra_dll_dirs: vec![],
            rpc_env: vec![],
            rpc_port: 59260,
            rpc_readiness_timeout_ms: 1000,

            coord_executable: test_child_bin.clone(),
            coord_working_dir: working_dir.clone(),
            coord_args: vec!["--mock-coordinator".to_string(), coord_port.to_string()],
            coord_extra_dll_dirs: vec![],
            coord_env: vec![],
            coord_port,
            coord_health_path: "/health".to_string(),
            coord_readiness_timeout_ms: 1000,
        };
        let res = state.orchestrator.start_staged(&config);
        drop(dummy);
        return match res {
            Ok(_) => Err("Expected port conflict, but startup succeeded".to_string()),
            Err(e) => Err(format!("Simulated Port Conflict: {}", e)),
        };
    }

    let (rpc_port, rpc_args) = if is_low_mem_standalone {
        (0, vec![])
    } else if sim_fail == "rpc_fail" {
        (59260, vec!["--fail".to_string()])
    } else if sim_fail == "rpc_timeout" {
        (59260, vec!["--listen".to_string(), "59299".to_string()])
    } else {
        (59260, vec!["--listen".to_string(), "59260".to_string()])
    };

    let coord_args = if sim_fail == "coord_fail" {
        vec!["--fail".to_string()]
    } else if sim_fail == "coord_timeout" {
        vec!["--listen".to_string(), coord_port.to_string()]
    } else {
        vec!["--mock-coordinator".to_string(), coord_port.to_string()]
    };

    let config = StagedLaunchConfig {
        rpc_executable: test_child_bin.clone(),
        rpc_working_dir: working_dir.clone(),
        rpc_args,
        rpc_extra_dll_dirs: vec![],
        rpc_env: vec![],
        rpc_port,
        rpc_readiness_timeout_ms: 1500,

        coord_executable: test_child_bin.clone(),
        coord_working_dir: working_dir.clone(),
        coord_args,
        coord_extra_dll_dirs: vec![],
        coord_env: vec![],
        coord_port,
        coord_health_path: "/health".to_string(),
        coord_readiness_timeout_ms: 1500,
    };

    match state.orchestrator.start_staged(&config) {
        Ok(()) => {
            let status = state.orchestrator.get_status();
            let msg = if is_low_mem_standalone {
                "Engine started successfully (Harmless Standalone Test Mode). Coordinator HTTP 200 OK -> Cluster Ready (0 RPC workers).".to_string()
            } else {
                "Engine started successfully (Harmless Test Mode). Full staged sequence verified: RPC ready -> Coordinator HTTP 200 OK -> Cluster Ready.".to_string()
            };
            Ok(EngineStartResult {
                success: true,
                status,
                message: msg,
                preflight: None,
                available_ram_mb: avail_ram_mb,
                total_ram_mb: total_ram_mb,
                available_vram_mb: avail_vram_mb,
                total_vram_mb: total_vram_mb,
            })
        }
        Err(e) => {
            Err(format!("Startup Failed: {}", e))
        }
    }
}

pub fn stop_engine_internal(state: &SupervisorState) -> Result<ClusterStatus, String> {
    state.orchestrator.stop_staged(3000)?;
    crate::supervisor::tunnel::stop_all_dialers();
    Ok(state.orchestrator.get_status())
}

pub fn cancel_startup_internal(state: &SupervisorState) -> Result<(), String> {
    state.orchestrator.request_cancel();
    Ok(())
}

pub fn get_engine_status_internal(state: &SupervisorState) -> ClusterStatus {
    state.orchestrator.get_status()
}

// Startup/stop are long blocking sequences (up to several minutes). Running them
// on a background thread keeps the webview responsive and lets cancel_startup
// be delivered while startup is still in flight.
#[tauri::command]
pub async fn supervisor_start_engine(
    state: State<'_, SupervisorState>,
    options: Option<StartEngineOptions>,
) -> Result<EngineStartResult, String> {
    #[cfg(target_os = "android")]
    {
        let workspace_root = state.workspace_root.clone();
        let model_target = state
            .model_library
            .get_selected_model_path()
            .unwrap_or_else(|| {
                let models_dir = workspace_root.join("models");
                if let Ok(entries) = std::fs::read_dir(&models_dir) {
                    for entry in entries.flatten() {
                        if entry.path().extension().map(|e| e == "gguf").unwrap_or(false) {
                            return entry.path();
                        }
                    }
                }
                workspace_root.join("models").join("qwen2.5-3b-instruct-q4_k_m.official-check.gguf")
            });

        return tauri::async_runtime::spawn_blocking(move || {
            crate::supervisor::android_worker::start_leader(&workspace_root, &model_target, options)
        })
        .await
        .map_err(|e| format!("Leader startup task failed: {}", e))?;
    }

    #[cfg(not(target_os = "android"))]
    {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || start_engine_internal(&state, options))
            .await
            .map_err(|e| format!("Startup task failed: {}", e))?
    }
}

#[tauri::command]
pub async fn supervisor_stop_engine(
    state: State<'_, SupervisorState>,
) -> Result<ClusterStatus, String> {
    #[cfg(target_os = "android")]
    {
        let _ = &state;
        return tauri::async_runtime::spawn_blocking(move || {
            crate::supervisor::android_worker::stop_leader()
        })
        .await
        .map_err(|e| format!("Leader stop task failed: {}", e))?;
    }

    #[cfg(not(target_os = "android"))]
    {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || stop_engine_internal(&state))
            .await
            .map_err(|e| format!("Stop task failed: {}", e))?
    }
}

#[tauri::command]
pub fn supervisor_cancel_startup(state: State<'_, SupervisorState>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = &state;
        crate::supervisor::android_worker::stop_leader()?;
        Ok(())
    }

    #[cfg(not(target_os = "android"))]
    {
        cancel_startup_internal(&state)
    }
}

#[tauri::command]
pub fn supervisor_get_engine_status(state: State<'_, SupervisorState>) -> ClusterStatus {
    #[cfg(target_os = "android")]
    {
        let _ = &state;
        crate::supervisor::android_worker::leader_status()
    }

    #[cfg(not(target_os = "android"))]
    {
        get_engine_status_internal(&state)
    }
}

#[tauri::command]
pub fn supervisor_get_available_profiles(
    state: State<'_, SupervisorState>,
) -> AvailableProfilesResponse {
    let mem_info = crate::supervisor::win32::get_available_physical_memory();
    let avail_ram_mb = mem_info.map(|(avail, _)| avail / (1024 * 1024));
    let vram_info = crate::supervisor::win32::get_available_vram_mb();
    let avail_vram_mb = vram_info.map(|(free, _)| free);

    get_available_profiles_internal(&state.workspace_root, avail_ram_mb, avail_vram_mb)
}

#[tauri::command]
pub fn supervisor_get_profile_fixture(
    state: State<'_, SupervisorState>,
    fixture_name: String,
) -> Result<AvailableProfilesResponse, String> {
    get_profile_fixture_internal(&state.workspace_root, &fixture_name)
}
