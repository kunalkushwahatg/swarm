//! Strongly-typed, validated Tauri commands for native process supervision.

use std::path::PathBuf;
use std::sync::Arc;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::config::{
    evaluate_profile_resource_eligibility, is_loopback_port_available, is_port_listening,
    probe_coordinator_health_detailed, probe_rpc_reachability, validate_binary_path,
    validate_model_path_file, AvailableProfilesResponse, CoordinatorConfig, DetailedHttpHealth,
    DetailedRpcReachability, PreflightReport, ProfileEnvVar, RuntimeProfile,
    RuntimeProfileMetadata,
};
use super::process::{ChildProcessSnapshot, ProcessManager, ProcessRole, ProcessStatus};
use super::shutdown::{shutdown_managed_child, ShutdownResult};
use super::orchestrator::{ClusterLifecycleState, ClusterStatus, Orchestrator, StagedLaunchConfig};
use super::paths::{
    ensure_telemetry_token_for_profile, load_remote_workers, read_telemetry_token_if_exists,
    resolve_model_file, resolve_native_runtime, save_remote_workers, RemoteWorkerConfig,
};
use super::win32::get_local_ip_addresses;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerProbeResult {
    pub reachable: bool,
    pub host: String,
    pub port: u16,
    pub latency_ms: u64,
    pub status_state: String,
    pub message: String,
    pub actionable_recovery: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostNetworkInfo {
    pub ip_addresses: Vec<String>,
    pub preferred_ip: String,
    pub coordinator_port: u16,
    pub telemetry_token: Option<String>,
    pub hostname: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DllDirectoryCheck {
    pub path: String,
    pub exists: bool,
    pub is_directory: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutableCheck {
    pub name: String,
    pub path: String,
    pub exists: bool,
    pub is_file: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelFileCheck {
    pub path: String,
    pub exists: bool,
    pub is_file: bool,
    pub extension_valid: bool,
    pub size_bytes: Option<u64>,
    pub recorded_sha256_provenance: Option<String>,
    pub fresh_verification_performed: bool,
    pub verification_note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortCheck {
    pub port: u16,
    pub occupied: bool,
    pub listening: bool,
    pub occupant_ownership: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupervisorDiagnosticsReport {
    // 1. Supervisor Availability
    pub supervisor_initialized: bool,
    pub job_object_active: bool,
    pub host_platform: String,

    // 2. Process Tracking (Managed Children Only)
    pub managed_children_count: usize,
    pub managed_children: Vec<ChildProcessSnapshot>,

    // 3. Port Occupancy (Distinct from process ownership)
    pub coordinator_port: PortCheck,
    pub rpc_port: PortCheck,

    // 4. Preflight Path Checks
    pub coordinator_executable: ExecutableCheck,
    pub rpc_executable: ExecutableCheck,
    pub dll_directories: Vec<DllDirectoryCheck>,
    pub model_file: ModelFileCheck,

    // 5. Active Endpoint Observations (Read-only probers)
    pub coordinator_health: DetailedHttpHealth,
    pub rpc_reachability: DetailedRpcReachability,

    // 6. Diagnostics & Validation
    pub configuration_valid: bool,
    pub issues: Vec<String>,
    pub is_simulated_fixture: bool,
    pub fixture_name: Option<String>,
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupervisorStatus {
    pub is_active: bool,
    pub managed_processes: Vec<ChildProcessSnapshot>,
    pub job_object_active: bool,
    pub coordinator_port_occupied: bool,
    pub rpc_port_occupied: bool,
    pub cluster_status: ClusterStatus,
}

pub struct SupervisorState {
    pub manager: Arc<ProcessManager>,
    pub orchestrator: Arc<Orchestrator>,
    pub workspace_root: PathBuf,
}

#[tauri::command]
pub fn supervisor_get_status(state: State<'_, SupervisorState>) -> SupervisorStatus {
    let snapshots = state.manager.get_snapshots();
    let coord_occupied = !is_loopback_port_available(8080);
    let rpc_occupied = !is_loopback_port_available(50052);
    let cluster_status = state.orchestrator.get_status();

    SupervisorStatus {
        is_active: true,
        managed_processes: snapshots,
        job_object_active: true,
        coordinator_port_occupied: coord_occupied,
        rpc_port_occupied: rpc_occupied,
        cluster_status,
    }
}

/// Generates a comprehensive read-only diagnostic report of live host observations.
/// Strictly non-destructive: inspects ports and processes without adopting, controlling, or terminating any process.
#[tauri::command]
pub fn supervisor_get_diagnostics(state: State<'_, SupervisorState>) -> SupervisorDiagnosticsReport {
    generate_diagnostics_report(&state.workspace_root, &state.manager)
}

/// Standalone diagnostic report generator callable without Tauri State wrapper.
pub fn generate_diagnostics_report(root: &std::path::Path, manager: &ProcessManager) -> SupervisorDiagnosticsReport {
    let snapshots = manager.get_snapshots();

    // 1. Port checks with strict ownership distinction
    let coord_occupied = !is_loopback_port_available(8080);
    let coord_listening = is_port_listening(8080);
    let coord_ownership = if !coord_occupied {
        "Available (Unbound)".to_string()
    } else {
        match snapshots.iter().find(|s| s.bound_ports.contains(&8080)) {
            Some(c) => format!("Managed Child (PID: {}, Role: {:?})", c.pid, c.role),
            None => "External / Unmanaged Process (Protected — Supervisor will not adopt or terminate)".to_string(),
        }
    };

    let rpc_occupied = !is_loopback_port_available(50052);
    let rpc_listening = is_port_listening(50052);
    let rpc_ownership = if !rpc_occupied {
        "Available (Unbound)".to_string()
    } else {
        match snapshots.iter().find(|s| s.bound_ports.contains(&50052)) {
            Some(c) => format!("Managed Child (PID: {}, Role: {:?})", c.pid, c.role),
            None => "External / Unmanaged Process (Protected — Supervisor will not adopt or terminate)".to_string(),
        }
    };

    // 2. Preflight path checks (supports installed and development paths)
    let runtime_paths = resolve_native_runtime(root).unwrap_or_else(|_| super::paths::RuntimePaths {
        coord_executable: root.join(r"build-cuda\swarm_node.exe"),
        rpc_executable: root.join(r"dist\swarm-worker-windows-x64\ggml-rpc-server.exe"),
        coord_extra_dll_dirs: vec![root.join(r"build-cuda"), root.join(r"build-cuda\bin")],
        rpc_extra_dll_dirs: vec![root.join(r"build-cuda"), root.join(r"build-cuda\bin")],
        is_installed_package: false,
        model_path: root.join(r"models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf"),
    });

    let coord_bin = runtime_paths.coord_executable;
    let rpc_bin = runtime_paths.rpc_executable;

    let coord_bin_exists = coord_bin.exists() && coord_bin.is_file();
    let rpc_bin_exists = rpc_bin.exists() && rpc_bin.is_file();

    let dll_checks: Vec<DllDirectoryCheck> = runtime_paths.coord_extra_dll_dirs.iter().map(|dir| {
        DllDirectoryCheck {
            path: dir.to_string_lossy().to_string(),
            exists: dir.exists(),
            is_directory: dir.is_dir(),
        }
    }).collect();

    // 3. Model file check (dynamic search: env -> dev workspace -> %ProgramData% -> %LocalAppData%)
    let model_path = resolve_model_file(root).unwrap_or_else(|_| root.join(r"models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf"));
    let model_exists = model_path.exists();
    let model_is_file = model_path.is_file();
    let model_size = std::fs::metadata(&model_path).map(|m| m.len()).ok();
    let model_ext_valid = model_path.extension().map(|e| e.to_string_lossy().to_lowercase() == "gguf").unwrap_or(false);

    let model_check = ModelFileCheck {
        path: model_path.to_string_lossy().to_string(),
        exists: model_exists,
        is_file: model_is_file,
        extension_valid: model_ext_valid,
        size_bytes: model_size,
        recorded_sha256_provenance: Some("626B4A6678B86442240E33DF819E00132D3BA7DDDFE1CDC4FBB18E0A9615C62D".to_string()),
        fresh_verification_performed: false,
        verification_note: "File presence confirmed. File existence does not prove binary compatibility or model loadability. SHA-256 provenance displayed from Milestone 12 baseline without re-hashing.".to_string(),
    };

    // 4. Endpoint observations (read-only probes)
    let coord_health = probe_coordinator_health_detailed(8080, "/health", 400);
    let rpc_probe = probe_rpc_reachability(50052, 200, rpc_occupied);

    // 5. Diagnostics issues aggregation
    let mut issues = Vec::new();
    if !coord_bin_exists {
        issues.push(format!("Coordinator binary missing at {}", coord_bin.display()));
    }
    if !rpc_bin_exists {
        issues.push(format!("RPC server binary missing at {}", rpc_bin.display()));
    }
    for d in &dll_checks {
        if !d.exists || !d.is_directory {
            issues.push(format!("Required DLL directory missing at {}", d.path));
        }
    }
    if !model_exists {
        issues.push(format!("Configured model file missing at {}", model_path.display()));
    }
    if coord_occupied {
        issues.push("Coordinator port 8080 is currently occupied by an external/unmanaged process. Supervisor will not overwrite or kill it.".to_string());
    }
    if rpc_occupied {
        issues.push("RPC port 50052 is currently occupied by an external/unmanaged process. Supervisor will not overwrite or kill it.".to_string());
    }

    let config_valid = coord_bin_exists && rpc_bin_exists && dll_checks.iter().all(|d| d.exists) && model_exists && model_ext_valid;

    SupervisorDiagnosticsReport {
        supervisor_initialized: true,
        job_object_active: true,
        host_platform: std::env::consts::OS.to_string(),
        managed_children_count: snapshots.len(),
        managed_children: snapshots,
        coordinator_port: PortCheck {
            port: 8080,
            occupied: coord_occupied,
            listening: coord_listening,
            occupant_ownership: coord_ownership,
        },
        rpc_port: PortCheck {
            port: 50052,
            occupied: rpc_occupied,
            listening: rpc_listening,
            occupant_ownership: rpc_ownership,
        },
        coordinator_executable: ExecutableCheck {
            name: "swarm_node.exe".to_string(),
            path: coord_bin.to_string_lossy().to_string(),
            exists: coord_bin_exists,
            is_file: coord_bin_exists,
        },
        rpc_executable: ExecutableCheck {
            name: "ggml-rpc-server.exe".to_string(),
            path: rpc_bin.to_string_lossy().to_string(),
            exists: rpc_bin_exists,
            is_file: rpc_bin_exists,
        },
        dll_directories: dll_checks,
        model_file: model_check,
        coordinator_health: coord_health,
        rpc_reachability: rpc_probe,
        configuration_valid: config_valid,
        issues,
        is_simulated_fixture: false,
        fixture_name: None,
        generated_at: "LIVE_OBSERVATION".to_string(),
    }
}

/// Returns deterministic mock test fixtures for verifying the diagnostic UI across edge states
/// without modifying host files, killing processes, or disturbing the live environment.
#[tauri::command]
pub fn supervisor_get_diagnostic_fixture(fixture_name: String) -> Result<SupervisorDiagnosticsReport, String> {
    match fixture_name.as_str() {
        "supervisor_unavailable" => Ok(SupervisorDiagnosticsReport {
            supervisor_initialized: false,
            job_object_active: false,
            host_platform: "windows".to_string(),
            managed_children_count: 0,
            managed_children: vec![],
            coordinator_port: PortCheck {
                port: 8080,
                occupied: false,
                listening: false,
                occupant_ownership: "Unknown (Supervisor offline)".to_string(),
            },
            rpc_port: PortCheck {
                port: 50052,
                occupied: false,
                listening: false,
                occupant_ownership: "Unknown (Supervisor offline)".to_string(),
            },
            coordinator_executable: ExecutableCheck {
                name: "swarm_node.exe".to_string(),
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\build-cuda\swarm_node.exe".to_string(),
                exists: true,
                is_file: true,
            },
            rpc_executable: ExecutableCheck {
                name: "ggml-rpc-server.exe".to_string(),
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\dist\swarm-worker-windows-x64\ggml-rpc-server.exe".to_string(),
                exists: true,
                is_file: true,
            },
            dll_directories: vec![],
            model_file: ModelFileCheck {
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf".to_string(),
                exists: true,
                is_file: true,
                extension_valid: true,
                size_bytes: Some(2104932768),
                recorded_sha256_provenance: Some("626B4A6678B86442240E33DF819E00132D3BA7DDDFE1CDC4FBB18E0A9615C62D".to_string()),
                fresh_verification_performed: false,
                verification_note: "Model presence verified".to_string(),
            },
            coordinator_health: DetailedHttpHealth {
                reachable: false,
                status_code: None,
                inference_ready: None,
                model_loaded: None,
                coordinator_reported_worker_state: None,
                duration_ms: 0,
                raw_response: None,
            },
            rpc_reachability: DetailedRpcReachability {
                reachable: false,
                duration_ms: 0,
                status_note: "Not checked".to_string(),
                diagnostic_state: "NOT_CHECKED".to_string(),
            },
            configuration_valid: false,
            issues: vec!["Native supervisor failed to initialize: Win32 Job Object creation error".to_string()],
            is_simulated_fixture: true,
            fixture_name: Some("supervisor_unavailable".to_string()),
            generated_at: "SIMULATED_FIXTURE".to_string(),
        }),

        "tracked_test_child" => Ok(SupervisorDiagnosticsReport {
            supervisor_initialized: true,
            job_object_active: true,
            host_platform: "windows".to_string(),
            managed_children_count: 1,
            managed_children: vec![ChildProcessSnapshot {
                pid: 9912,
                role: ProcessRole::TestChild,
                executable: "test_child.exe".to_string(),
                status: ProcessStatus::Running,
                bound_ports: vec![59204],
                uptime_secs: 42,
            }],
            coordinator_port: PortCheck {
                port: 8080,
                occupied: true,
                listening: true,
                occupant_ownership: "Managed Child (PID: 9912, Role: TestChild)".to_string(),
            },
            rpc_port: PortCheck {
                port: 50052,
                occupied: false,
                listening: false,
                occupant_ownership: "Available (Unbound)".to_string(),
            },
            coordinator_executable: ExecutableCheck {
                name: "swarm_node.exe".to_string(),
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\build-cuda\swarm_node.exe".to_string(),
                exists: true,
                is_file: true,
            },
            rpc_executable: ExecutableCheck {
                name: "ggml-rpc-server.exe".to_string(),
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\dist\swarm-worker-windows-x64\ggml-rpc-server.exe".to_string(),
                exists: true,
                is_file: true,
            },
            dll_directories: vec![],
            model_file: ModelFileCheck {
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf".to_string(),
                exists: true,
                is_file: true,
                extension_valid: true,
                size_bytes: Some(2104932768),
                recorded_sha256_provenance: Some("626B4A66...".to_string()),
                fresh_verification_performed: false,
                verification_note: "Model presence verified".to_string(),
            },
            coordinator_health: DetailedHttpHealth {
                reachable: false,
                status_code: None,
                inference_ready: None,
                model_loaded: None,
                coordinator_reported_worker_state: None,
                duration_ms: 0,
                raw_response: None,
            },
            rpc_reachability: DetailedRpcReachability {
                reachable: false,
                duration_ms: 0,
                status_note: "Not checked".to_string(),
                diagnostic_state: "NOT_CHECKED".to_string(),
            },
            configuration_valid: true,
            issues: vec![],
            is_simulated_fixture: true,
            fixture_name: Some("tracked_test_child".to_string()),
            generated_at: "SIMULATED_FIXTURE".to_string(),
        }),

        "ports_available" => Ok(SupervisorDiagnosticsReport {
            supervisor_initialized: true,
            job_object_active: true,
            host_platform: "windows".to_string(),
            managed_children_count: 0,
            managed_children: vec![],
            coordinator_port: PortCheck {
                port: 8080,
                occupied: false,
                listening: false,
                occupant_ownership: "Available (Unbound)".to_string(),
            },
            rpc_port: PortCheck {
                port: 50052,
                occupied: false,
                listening: false,
                occupant_ownership: "Available (Unbound)".to_string(),
            },
            coordinator_executable: ExecutableCheck {
                name: "swarm_node.exe".to_string(),
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\build-cuda\swarm_node.exe".to_string(),
                exists: true,
                is_file: true,
            },
            rpc_executable: ExecutableCheck {
                name: "ggml-rpc-server.exe".to_string(),
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\dist\swarm-worker-windows-x64\ggml-rpc-server.exe".to_string(),
                exists: true,
                is_file: true,
            },
            dll_directories: vec![],
            model_file: ModelFileCheck {
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf".to_string(),
                exists: true,
                is_file: true,
                extension_valid: true,
                size_bytes: Some(2104932768),
                recorded_sha256_provenance: Some("626B4A66...".to_string()),
                fresh_verification_performed: false,
                verification_note: "Model presence verified".to_string(),
            },
            coordinator_health: DetailedHttpHealth {
                reachable: false,
                status_code: None,
                inference_ready: None,
                model_loaded: None,
                coordinator_reported_worker_state: None,
                duration_ms: 0,
                raw_response: None,
            },
            rpc_reachability: DetailedRpcReachability {
                reachable: false,
                duration_ms: 0,
                status_note: "Port available (No listener)".to_string(),
                diagnostic_state: "UNBOUND".to_string(),
            },
            configuration_valid: true,
            issues: vec!["Coordinator offline (Port 8080 free)".to_string()],
            is_simulated_fixture: true,
            fixture_name: Some("ports_available".to_string()),
            generated_at: "SIMULATED_FIXTURE".to_string(),
        }),

        "missing_executable_dll" => Ok(SupervisorDiagnosticsReport {
            supervisor_initialized: true,
            job_object_active: true,
            host_platform: "windows".to_string(),
            managed_children_count: 0,
            managed_children: vec![],
            coordinator_port: PortCheck {
                port: 8080,
                occupied: false,
                listening: false,
                occupant_ownership: "Available (Unbound)".to_string(),
            },
            rpc_port: PortCheck {
                port: 50052,
                occupied: false,
                listening: false,
                occupant_ownership: "Available (Unbound)".to_string(),
            },
            coordinator_executable: ExecutableCheck {
                name: "swarm_node.exe".to_string(),
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\build-cuda\swarm_node.exe".to_string(),
                exists: false,
                is_file: false,
            },
            rpc_executable: ExecutableCheck {
                name: "ggml-rpc-server.exe".to_string(),
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\dist\swarm-worker-windows-x64\ggml-rpc-server.exe".to_string(),
                exists: false,
                is_file: false,
            },
            dll_directories: vec![
                DllDirectoryCheck {
                    path: r"C:\Users\kunal\OneDrive\Desktop\swarm\build-cuda".to_string(),
                    exists: true,
                    is_directory: true,
                },
                DllDirectoryCheck {
                    path: r"C:\Users\kunal\OneDrive\Desktop\swarm\build-cuda\bin".to_string(),
                    exists: false,
                    is_directory: false,
                },
            ],
            model_file: ModelFileCheck {
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf".to_string(),
                exists: true,
                is_file: true,
                extension_valid: true,
                size_bytes: Some(2104932768),
                recorded_sha256_provenance: Some("626B4A66...".to_string()),
                fresh_verification_performed: false,
                verification_note: "Model presence verified".to_string(),
            },
            coordinator_health: DetailedHttpHealth {
                reachable: false,
                status_code: None,
                inference_ready: None,
                model_loaded: None,
                coordinator_reported_worker_state: None,
                duration_ms: 0,
                raw_response: None,
            },
            rpc_reachability: DetailedRpcReachability {
                reachable: false,
                duration_ms: 0,
                status_note: "Not checked".to_string(),
                diagnostic_state: "NOT_CHECKED".to_string(),
            },
            configuration_valid: false,
            issues: vec![
                "Coordinator binary missing at build-cuda/swarm_node.exe".to_string(),
                "Required DLL search directory missing at build-cuda/bin".to_string(),
            ],
            is_simulated_fixture: true,
            fixture_name: Some("missing_executable_dll".to_string()),
            generated_at: "SIMULATED_FIXTURE".to_string(),
        }),

        "missing_model_file" => Ok(SupervisorDiagnosticsReport {
            supervisor_initialized: true,
            job_object_active: true,
            host_platform: "windows".to_string(),
            managed_children_count: 0,
            managed_children: vec![],
            coordinator_port: PortCheck {
                port: 8080,
                occupied: false,
                listening: false,
                occupant_ownership: "Available (Unbound)".to_string(),
            },
            rpc_port: PortCheck {
                port: 50052,
                occupied: false,
                listening: false,
                occupant_ownership: "Available (Unbound)".to_string(),
            },
            coordinator_executable: ExecutableCheck {
                name: "swarm_node.exe".to_string(),
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\build-cuda\swarm_node.exe".to_string(),
                exists: true,
                is_file: true,
            },
            rpc_executable: ExecutableCheck {
                name: "ggml-rpc-server.exe".to_string(),
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\dist\swarm-worker-windows-x64\ggml-rpc-server.exe".to_string(),
                exists: true,
                is_file: true,
            },
            dll_directories: vec![],
            model_file: ModelFileCheck {
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\models\missing_model.gguf".to_string(),
                exists: false,
                is_file: false,
                extension_valid: true,
                size_bytes: None,
                recorded_sha256_provenance: None,
                fresh_verification_performed: false,
                verification_note: "Model file not found on disk".to_string(),
            },
            coordinator_health: DetailedHttpHealth {
                reachable: false,
                status_code: None,
                inference_ready: None,
                model_loaded: None,
                coordinator_reported_worker_state: None,
                duration_ms: 0,
                raw_response: None,
            },
            rpc_reachability: DetailedRpcReachability {
                reachable: false,
                duration_ms: 0,
                status_note: "Not checked".to_string(),
                diagnostic_state: "NOT_CHECKED".to_string(),
            },
            configuration_valid: false,
            issues: vec!["Model file missing at models/missing_model.gguf".to_string()],
            is_simulated_fixture: true,
            fixture_name: Some("missing_model_file".to_string()),
            generated_at: "SIMULATED_FIXTURE".to_string(),
        }),

        "invalid_configuration" => Ok(SupervisorDiagnosticsReport {
            supervisor_initialized: true,
            job_object_active: true,
            host_platform: "windows".to_string(),
            managed_children_count: 0,
            managed_children: vec![],
            coordinator_port: PortCheck {
                port: 8080,
                occupied: true,
                listening: true,
                occupant_ownership: "External / Unmanaged Process".to_string(),
            },
            rpc_port: PortCheck {
                port: 50052,
                occupied: true,
                listening: true,
                occupant_ownership: "External / Unmanaged Process".to_string(),
            },
            coordinator_executable: ExecutableCheck {
                name: "swarm_node.exe".to_string(),
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\build-cuda\swarm_node.exe".to_string(),
                exists: true,
                is_file: true,
            },
            rpc_executable: ExecutableCheck {
                name: "ggml-rpc-server.exe".to_string(),
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\dist\swarm-worker-windows-x64\ggml-rpc-server.exe".to_string(),
                exists: true,
                is_file: true,
            },
            dll_directories: vec![],
            model_file: ModelFileCheck {
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\models\model.invalid_ext".to_string(),
                exists: true,
                is_file: true,
                extension_valid: false,
                size_bytes: Some(1024),
                recorded_sha256_provenance: None,
                fresh_verification_performed: false,
                verification_note: "Model file lacks valid .gguf extension".to_string(),
            },
            coordinator_health: DetailedHttpHealth {
                reachable: false,
                status_code: None,
                inference_ready: None,
                model_loaded: None,
                coordinator_reported_worker_state: None,
                duration_ms: 0,
                raw_response: None,
            },
            rpc_reachability: DetailedRpcReachability {
                reachable: false,
                duration_ms: 0,
                status_note: "Not checked".to_string(),
                diagnostic_state: "NOT_CHECKED".to_string(),
            },
            configuration_valid: false,
            issues: vec![
                "Model file extension invalid (must be .gguf)".to_string(),
                "Ports 8080 and 50052 are both occupied by external services".to_string(),
                "Configuration contains conflicting local port assignments".to_string(),
            ],
            is_simulated_fixture: true,
            fixture_name: Some("invalid_configuration".to_string()),
            generated_at: "SIMULATED_FIXTURE".to_string(),
        }),

        "unknown_diagnostic_values" => Ok(SupervisorDiagnosticsReport {
            supervisor_initialized: true,
            job_object_active: true,
            host_platform: "windows".to_string(),
            managed_children_count: 0,
            managed_children: vec![],
            coordinator_port: PortCheck {
                port: 8080,
                occupied: false,
                listening: false,
                occupant_ownership: "Unknown / Not checked".to_string(),
            },
            rpc_port: PortCheck {
                port: 50052,
                occupied: false,
                listening: false,
                occupant_ownership: "Unknown / Not checked".to_string(),
            },
            coordinator_executable: ExecutableCheck {
                name: "swarm_node.exe".to_string(),
                path: "Unknown".to_string(),
                exists: false,
                is_file: false,
            },
            rpc_executable: ExecutableCheck {
                name: "ggml-rpc-server.exe".to_string(),
                path: "Unknown".to_string(),
                exists: false,
                is_file: false,
            },
            dll_directories: vec![],
            model_file: ModelFileCheck {
                path: "Unknown".to_string(),
                exists: false,
                is_file: false,
                extension_valid: false,
                size_bytes: None,
                recorded_sha256_provenance: None,
                fresh_verification_performed: false,
                verification_note: "Model status unknown / not checked".to_string(),
            },
            coordinator_health: DetailedHttpHealth {
                reachable: false,
                status_code: None,
                inference_ready: None,
                model_loaded: None,
                coordinator_reported_worker_state: None,
                duration_ms: 0,
                raw_response: Some("Unknown / Not checked".to_string()),
            },
            rpc_reachability: DetailedRpcReachability {
                reachable: false,
                duration_ms: 0,
                status_note: "Unknown / Not checked".to_string(),
                diagnostic_state: "NOT_CHECKED".to_string(),
            },
            configuration_valid: false,
            issues: vec!["Diagnostic probing not yet executed".to_string()],
            is_simulated_fixture: true,
            fixture_name: Some("unknown_diagnostic_values".to_string()),
            generated_at: "SIMULATED_FIXTURE".to_string(),
        }),

        "reconciled_rpc_busy" => Ok(SupervisorDiagnosticsReport {
            supervisor_initialized: true,
            job_object_active: true,
            host_platform: "windows".to_string(),
            managed_children_count: 0,
            managed_children: vec![],
            coordinator_port: PortCheck {
                port: 8080,
                occupied: true,
                listening: true,
                occupant_ownership: "External / Unmanaged Process (Protected — Supervisor will not adopt or terminate)".to_string(),
            },
            rpc_port: PortCheck {
                port: 50052,
                occupied: true,
                listening: true,
                occupant_ownership: "External / Unmanaged Process (Protected — Supervisor will not adopt or terminate)".to_string(),
            },
            coordinator_executable: ExecutableCheck {
                name: "swarm_node.exe".to_string(),
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\build-cuda\swarm_node.exe".to_string(),
                exists: true,
                is_file: true,
            },
            rpc_executable: ExecutableCheck {
                name: "ggml-rpc-server.exe".to_string(),
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\dist\swarm-worker-windows-x64\ggml-rpc-server.exe".to_string(),
                exists: true,
                is_file: true,
            },
            dll_directories: vec![
                DllDirectoryCheck {
                    path: r"C:\Users\kunal\OneDrive\Desktop\swarm\build-cuda".to_string(),
                    exists: true,
                    is_directory: true,
                },
                DllDirectoryCheck {
                    path: r"C:\Users\kunal\OneDrive\Desktop\swarm\build-cuda\bin".to_string(),
                    exists: true,
                    is_directory: true,
                },
            ],
            model_file: ModelFileCheck {
                path: r"C:\Users\kunal\OneDrive\Desktop\swarm\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf".to_string(),
                exists: true,
                is_file: true,
                extension_valid: true,
                size_bytes: Some(2104932768),
                recorded_sha256_provenance: Some("626B4A6678B86442240E33DF819E00132D3BA7DDDFE1CDC4FBB18E0A9615C62D".to_string()),
                fresh_verification_performed: false,
                verification_note: "Model presence verified".to_string(),
            },
            coordinator_health: DetailedHttpHealth {
                reachable: true,
                status_code: Some(200),
                inference_ready: Some(true),
                model_loaded: Some(true),
                coordinator_reported_worker_state: Some("READY".to_string()),
                duration_ms: 84,
                raw_response: Some("{\"status\":\"ok\"}".to_string()),
            },
            rpc_reachability: DetailedRpcReachability {
                reachable: false,
                duration_ms: 1,
                status_note: "Direct TCP probe: Refused (OS 10061) — Port 50052 occupied; coordinator holds active session; cause: Unconfirmed".to_string(),
                diagnostic_state: "REFUSED".to_string(),
            },
            configuration_valid: true,
            issues: vec![
                "Coordinator port 8080 is currently occupied by an external/unmanaged process. Supervisor will not overwrite or kill it.".to_string(),
                "RPC port 50052 is currently occupied by an external/unmanaged process. Supervisor will not overwrite or kill it.".to_string(),
            ],
            is_simulated_fixture: true,
            fixture_name: Some("reconciled_rpc_busy".to_string()),
            generated_at: "SIMULATED_FIXTURE".to_string(),
        }),

        unknown => Err(format!("Unknown diagnostic fixture name: '{}'. Available fixtures: supervisor_unavailable, tracked_test_child, ports_available, missing_executable_dll, missing_model_file, invalid_configuration, unknown_diagnostic_values, reconciled_rpc_busy", unknown)),
    }
}

pub fn run_preflight_check(root: &std::path::Path, cfg: CoordinatorConfig) -> PreflightReport {
    let coord_port_avail = is_loopback_port_available(cfg.port);
    let rpc_port_avail = if cfg.use_rpc && cfg.rpc_port > 0 {
        is_loopback_port_available(cfg.rpc_port)
    } else {
        true
    };

    let runtime_paths = resolve_native_runtime(root).unwrap_or_else(|_| super::paths::RuntimePaths {
        coord_executable: root.join(r"build-cuda\swarm_node.exe"),
        rpc_executable: root.join(r"dist\swarm-worker-windows-x64\ggml-rpc-server.exe"),
        coord_extra_dll_dirs: vec![root.join(r"build-cuda"), root.join(r"build-cuda\bin")],
        rpc_extra_dll_dirs: vec![root.join(r"build-cuda"), root.join(r"build-cuda\bin")],
        is_installed_package: false,
        model_path: root.join(r"models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf"),
    });

    let coord_bin = runtime_paths.coord_executable;
    let rpc_bin = runtime_paths.rpc_executable;

    let coord_found = validate_binary_path(&coord_bin).is_ok();
    let rpc_found = if cfg.use_rpc {
        validate_binary_path(&rpc_bin).is_ok()
    } else {
        true
    };

    let model_target = if cfg.model_path.is_empty() {
        resolve_model_file(root).unwrap_or_else(|_| root.join(r"models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf"))
    } else {
        PathBuf::from(&cfg.model_path)
    };
    let model_found = validate_model_path_file(&model_target.to_string_lossy()).is_ok();

    let mut issues = Vec::new();
    if !coord_port_avail {
        issues.push(format!("Coordinator port {} is currently occupied. Supervisor will not overwrite or kill existing processes.", cfg.port));
    }
    if cfg.use_rpc && cfg.rpc_port > 0 && !rpc_port_avail {
        issues.push(format!("RPC port {} is currently occupied. Supervisor will not overwrite or kill existing processes.", cfg.rpc_port));
    }
    if !coord_found {
        issues.push(format!("Coordinator binary missing at {}", coord_bin.display()));
    }
    if cfg.use_rpc && !rpc_found {
        issues.push(format!("RPC server binary missing at {}", rpc_bin.display()));
    }
    if !model_found {
        issues.push(format!("Model file missing or invalid at {}", model_target.display()));
    }

    let can_launch = issues.is_empty();

    PreflightReport {
        coordinator_port_available: coord_port_avail,
        rpc_port_available: rpc_port_avail,
        coordinator_binary_found: coord_found,
        coordinator_binary_path: coord_bin.to_string_lossy().to_string(),
        rpc_binary_found: rpc_found,
        rpc_binary_path: rpc_bin.to_string_lossy().to_string(),
        model_found,
        model_path: model_target.to_string_lossy().to_string(),
        can_launch,
        issues,
    }
}

#[tauri::command]
pub fn supervisor_preflight_check(
    state: State<'_, SupervisorState>,
    config: Option<CoordinatorConfig>,
) -> PreflightReport {
    run_preflight_check(&state.workspace_root, config.unwrap_or_default())
}

#[tauri::command]
pub fn supervisor_start_test_child(
    state: State<'_, SupervisorState>,
    port: u16,
    ignore_break: Option<bool>,
) -> Result<u32, String> {
    // 1. Validate that proposed test port is available
    if !is_loopback_port_available(port) {
        return Err(format!("Proposed test port {} is already in use. Refusing to spawn test child.", port));
    }

    // 2. Locate compiled test_child binary
    let test_child_bin = state.workspace_root.join(r"spike\desktop-shell\src-tauri\target\debug\test_child.exe");
    if !test_child_bin.exists() {
        return Err(format!("test_child.exe binary not found at {}. Build with 'cargo build --bin test_child'.", test_child_bin.display()));
    }

    let port_str = port.to_string();
    let mut args = vec!["--listen", &port_str];
    if ignore_break.unwrap_or(false) {
        args.push("--ignore-break");
    }

    let working_dir = state.workspace_root.join(r"spike\desktop-shell");

    state.manager.spawn_child(
        &test_child_bin,
        &args,
        &working_dir,
        &[],
        &[], // extra_dll_dirs
        ProcessRole::TestChild,
        vec![port],
        true, // with console for console control event testing
        true, // hide_console (hidden by default)
    )
}

#[tauri::command]
pub fn supervisor_stop_test_child(
    state: State<'_, SupervisorState>,
    pid: u32,
    timeout_ms: Option<u64>,
) -> Result<ShutdownResult, String> {
    shutdown_managed_child(pid, &state.manager.managed_children, timeout_ms.unwrap_or(3000))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn supervisor_get_logs(
    state: State<'_, SupervisorState>,
    pid: u32,
    count: Option<usize>,
) -> Result<Vec<String>, String> {
    state.manager.get_logs(pid, count).ok_or_else(|| format!("PID {} is not a managed process", pid))
}

#[tauri::command]
pub fn supervisor_start_coordinator() -> Result<u32, String> {
    Err("Safety Guard: Direct uncoordinated launch of production coordinator is disabled. Use controlled supervisor_start_engine instead.".to_string())
}

#[tauri::command]
pub fn supervisor_start_worker() -> Result<u32, String> {
    Err("Safety Guard: Direct uncoordinated launch of production worker is disabled. Use controlled supervisor_start_engine instead.".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StartEngineOptions {
    pub mode: Option<String>, // "simulated" | "real"
    pub profile: Option<String>, // None | "default" | "low_memory_cuda_standalone"
    pub simulate_failure: Option<String>, // None | "rpc_fail" | "rpc_timeout" | "coord_fail" | "coord_timeout" | "port_conflict"
    pub allow_real_runtime: Option<bool>, // Explicit operator authorization required for real execution
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineStartResult {
    pub success: bool,
    pub status: ClusterStatus,
    pub message: String,
    pub preflight: Option<PreflightReport>,
    pub available_ram_mb: Option<u64>,
    pub total_ram_mb: Option<u64>,
    pub available_vram_mb: Option<u64>,
    pub total_vram_mb: Option<u64>,
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
    if ram < 1000 {
        return Err(format!(
            "Resource Preflight Failure: Measured available physical RAM is {} MB, which is below the conservative threshold of 1,000 MB required for the standalone CUDA test profile. Free system memory before launching.",
            ram
        ));
    }

    let vram = match avail_vram_mb {
        Some(v) => v,
        None => {
            return Err("Preflight Resource Check Failed (Fail-Closed): Unable to obtain GPU VRAM reading from nvidia-smi. Ensure NVIDIA graphics driver and nvidia-smi are accessible. Launch aborted.".to_string());
        }
    };
    if vram < 3100 {
        return Err(format!(
            "Resource Preflight Failure: Measured available GPU VRAM is {} MiB, which is below the conservative threshold of 3,100 MiB required for full 37-layer CUDA offload. Close GPU-consuming applications before launching.",
            vram
        ));
    }

    Ok(())
}

/// Constructs the exact environment variable pairs for the standalone CUDA coordinator process.
pub fn build_standalone_cuda_coordinator_env(model_path: &std::path::Path) -> Vec<(String, String)> {
    vec![
        ("SWARM_USE_RPC".to_string(), "0".to_string()),
        ("PORT".to_string(), "8080".to_string()),
        ("SWARM_MODEL_PATH".to_string(), model_path.to_string_lossy().to_string()),
        ("SWARM_N_GPU_LAYERS".to_string(), "-1".to_string()),
        ("SWARM_CTX_SIZE".to_string(), "512".to_string()),
        ("SWARM_PLACEMENT_POLICY".to_string(), "none".to_string()),
        ("SWARM_DEPLOYMENT_ENV".to_string(), "development".to_string()),
    ]
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
    allocation_config: Option<&super::planning::ComputeAllocationConfig>,
) -> Vec<(String, String)> {
    let mut all_endpoints = vec!["127.0.0.1:50052".to_string()];
    for rw in remote_workers {
        if rw.is_active {
            let ep = format!("{}:{}", rw.host.trim(), rw.port);
            if !all_endpoints.contains(&ep) {
                all_endpoints.push(ep);
            }
        }
    }

    let (endpoints, policy, n_gpu_layers, extra_envs) = match allocation_config {
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
            (filtered, "dynamic".to_string(), alloc.total_offload_layers.to_string(), extras)
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
            (filtered, "resource_aware".to_string(), alloc.total_offload_layers.to_string(), extras)
        }
        _ => (all_endpoints, "none".to_string(), "4".to_string(), vec![]),
    };

    let mut envs = vec![
        ("SWARM_USE_RPC".to_string(), "1".to_string()),
        ("PORT".to_string(), "8080".to_string()),
        ("SWARM_MODEL_PATH".to_string(), model_path.to_string_lossy().to_string()),
        ("SWARM_N_GPU_LAYERS".to_string(), n_gpu_layers),
        ("SWARM_CTX_SIZE".to_string(), "2048".to_string()),
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
    let allocation_cfg = super::planning::load_allocation_config(workspace_root);
    let raw = match profile {
        RuntimeProfile::DefaultCluster => build_default_cluster_coordinator_env_with_workers_and_allocation(&model_path, &remote_workers, allocation_cfg.as_ref()),
        RuntimeProfile::LowMemoryCudaStandalone => build_standalone_cuda_coordinator_env(&model_path),
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

    // 1. Guard against duplicate startup
    let current_status = state.orchestrator.get_status();
    match current_status.state {
        ClusterLifecycleState::Stopped | ClusterLifecycleState::Error { .. } => {}
        ref busy_state => {
            return Err(format!(
                "Duplicate startup rejected: cluster is already in lifecycle state {:?}",
                busy_state
            ));
        }
    }

    // 2. Query available physical memory and VRAM for headroom checks
    let mem_info = super::win32::get_available_physical_memory();
    let avail_ram_mb = mem_info.map(|(avail, _)| avail / (1024 * 1024));
    let total_ram_mb = mem_info.map(|(_, total)| total / (1024 * 1024));

    let vram_info = super::win32::get_available_vram_mb();
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
            let model_target = resolve_model_file(&state.workspace_root)
                .map_err(|e| format!("Model Path Resolution Failed: {}", e))?;

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
                coord_env: build_standalone_cuda_coordinator_env(&model_target),
                coord_port: 8080,
                coord_health_path: "/health".to_string(),
                coord_readiness_timeout_ms: 30000,
            };

            match state.orchestrator.start_staged(&config) {
                Ok(()) => {
                    let status = state.orchestrator.get_status();
                    return Ok(EngineStartResult {
                        success: true,
                        status,
                        message: "Real Standalone CUDA Swarm Engine started successfully: Coordinator verified healthy (SWARM_USE_RPC=0, SWARM_N_GPU_LAYERS=-1, SWARM_CTX_SIZE=512).".to_string(),
                        preflight: Some(preflight),
                        available_ram_mb: avail_ram_mb,
                        total_ram_mb: total_ram_mb,
                        available_vram_mb: avail_vram_mb,
                        total_vram_mb: total_vram_mb,
                    });
                }
                Err(e) => {
                    let status = state.orchestrator.get_status();
                    return Err(format!("Standalone CUDA Startup Failed & Safely Rolled Back: {}. Status: {:?}", e, status.state));
                }
            }
        }

        // Standard Dual-Process Mode: preserves original 1,500 MB free-RAM guard
        if !is_loopback_port_available(8080) {
            return Err("Port Conflict: Coordinator port 8080 is already occupied by an external/unmanaged process. Supervisor refuses to overwrite or terminate existing processes.".to_string());
        }
        if !is_loopback_port_available(50052) {
            return Err("Port Conflict: RPC port 50052 is already occupied by an external/unmanaged process. Supervisor refuses to overwrite or terminate existing processes.".to_string());
        }

        let preflight = run_preflight_check(&state.workspace_root, CoordinatorConfig::default());
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

        if avail_ram < 1500 {
            return Err(format!(
                "Resource Headroom Warning: Only {} MB of physical RAM is free (minimum 1,500 MB recommended for 1.96 GB model). Free RAM before launching.",
                avail_ram
            ));
        }

        if opts.allow_real_runtime != Some(true) {
            return Err("Gate 3 Safety Boundary: Real-runtime cluster launch is prepared and preflight-validated, but requires explicit operator authorization (allow_real_runtime: true) before starting production Swarm processes. Zero real processes spawned.".to_string());
        }

        // Concrete production configuration using audited paths and parameters
        let runtime_paths = resolve_native_runtime(&state.workspace_root)
            .map_err(|e| format!("Runtime Binary Resolution Failed: {}", e))?;
        let model_target = resolve_model_file(&state.workspace_root)
            .map_err(|e| format!("Model Path Resolution Failed: {}", e))?;

        // Secure first-run telemetry token provisioning if needed for cluster
        let remote_workers = load_remote_workers(&state.workspace_root);
        let allocation_cfg = super::planning::load_allocation_config(&state.workspace_root);
        let mut coord_env = build_default_cluster_coordinator_env_with_workers_and_allocation(
            &model_target,
            &remote_workers,
            allocation_cfg.as_ref(),
        );
        if let Ok(Some(token_path)) = ensure_telemetry_token_for_profile(RuntimeProfile::DefaultCluster) {
            coord_env.push(("SWARM_TELEMETRY_TOKEN_FILE".to_string(), token_path.to_string_lossy().to_string()));
        }

        let config = StagedLaunchConfig {
            rpc_executable: runtime_paths.rpc_executable,
            rpc_working_dir: state.workspace_root.clone(),
            rpc_args: vec![
                "--host".to_string(), "127.0.0.1".to_string(),
                "--port".to_string(), "50052".to_string(),
                "--threads".to_string(), "2".to_string(),
            ],
            rpc_extra_dll_dirs: runtime_paths.rpc_extra_dll_dirs,
            rpc_env: vec![],
            rpc_port: 50052,
            rpc_readiness_timeout_ms: 10000,

            coord_executable: runtime_paths.coord_executable,
            coord_working_dir: state.workspace_root.clone(),
            coord_args: vec![],
            coord_extra_dll_dirs: runtime_paths.coord_extra_dll_dirs,
            coord_env,
            coord_port: 8080,
            coord_health_path: "/health".to_string(),
            coord_readiness_timeout_ms: 30000,
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
                let status = state.orchestrator.get_status();
                return Err(format!("Production Startup Failed & Safely Rolled Back: {}. Status: {:?}", e, status.state));
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
            let status = state.orchestrator.get_status();
            Err(format!("Startup Failed & Safely Rolled Back: {}. Status: {:?}", e, status.state))
        }
    }
}

pub fn stop_engine_internal(state: &SupervisorState) -> Result<ClusterStatus, String> {
    state.orchestrator.stop_staged(3000)?;
    Ok(state.orchestrator.get_status())
}

pub fn cancel_startup_internal(state: &SupervisorState) -> Result<(), String> {
    state.orchestrator.request_cancel();
    Ok(())
}

pub fn get_engine_status_internal(state: &SupervisorState) -> ClusterStatus {
    state.orchestrator.get_status()
}

#[tauri::command]
pub fn supervisor_start_engine(
    state: State<'_, SupervisorState>,
    options: Option<StartEngineOptions>,
) -> Result<EngineStartResult, String> {
    start_engine_internal(&state, options)
}

#[tauri::command]
pub fn supervisor_stop_engine(state: State<'_, SupervisorState>) -> Result<ClusterStatus, String> {
    stop_engine_internal(&state)
}

#[tauri::command]
pub fn supervisor_cancel_startup(state: State<'_, SupervisorState>) -> Result<(), String> {
    cancel_startup_internal(&state)
}

#[tauri::command]
pub fn supervisor_get_engine_status(state: State<'_, SupervisorState>) -> ClusterStatus {
    get_engine_status_internal(&state)
}

#[tauri::command]
pub fn supervisor_get_available_profiles(
    state: State<'_, SupervisorState>,
) -> AvailableProfilesResponse {
    let mem_info = super::win32::get_available_physical_memory();
    let avail_ram_mb = mem_info.map(|(avail, _)| avail / (1024 * 1024));
    let vram_info = super::win32::get_available_vram_mb();
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

/// Probes a remote worker TCP endpoint directly with customizable timeout.
/// Evaluates reachability, measures real socket latency, and returns actionable recovery guidance on failure.
pub fn probe_remote_worker_endpoint_internal(host: &str, port: u16, timeout_ms: u64) -> WorkerProbeResult {
    use std::net::ToSocketAddrs;
    let t0 = std::time::Instant::now();
    let trimmed_host = host.trim();
    let addr_str = format!("{}:{}", trimmed_host, port);
    let timeout = std::time::Duration::from_millis(timeout_ms.max(500));

    match addr_str.to_socket_addrs() {
        Ok(mut addrs) => {
            if let Some(sock_addr) = addrs.next() {
                match std::net::TcpStream::connect_timeout(&sock_addr, timeout) {
                    Ok(stream) => {
                        drop(stream);
                        let latency = t0.elapsed().as_millis() as u64;
                        WorkerProbeResult {
                            reachable: true,
                            host: trimmed_host.to_string(),
                            port,
                            latency_ms: latency,
                            status_state: "REACHABLE".to_string(),
                            message: format!("Connection established in {} ms. Port {} is open and accepting TCP traffic.", latency, port),
                            actionable_recovery: None,
                        }
                    }
                    Err(e) => {
                        let elapsed = t0.elapsed().as_millis() as u64;
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

pub fn remove_worker_internal(
    workspace_root: &std::path::Path,
    id: &str,
) -> Result<Vec<RemoteWorkerConfig>, String> {
    let mut workers = load_remote_workers(workspace_root);
    workers.retain(|w| w.id != id && format!("{}:{}", w.host, w.port) != id);
    save_remote_workers(workspace_root, &workers)?;
    Ok(workers)
}

#[tauri::command]
pub fn supervisor_probe_worker_endpoint(
    host: String,
    port: u16,
    timeout_ms: Option<u64>,
) -> Result<WorkerProbeResult, String> {
    Ok(probe_remote_worker_endpoint_internal(&host, port, timeout_ms.unwrap_or(3000)))
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetAllocationConfigResponse {
    pub config: super::planning::ComputeAllocationConfig,
    pub has_backup: bool,
    pub active_policy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyAllocationResult {
    pub success: bool,
    pub preview: super::planning::AllocationPlanPreview,
    pub message: String,
    pub coordinator_restarted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RollbackAllocationResult {
    pub success: bool,
    pub restored_config: super::planning::ComputeAllocationConfig,
    pub message: String,
    pub coordinator_restarted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimePlacementBackend {
    pub backend_id: String,
    pub device_name: String,
    pub description: String,
    pub endpoint: String,
    pub backend_type: String,
    pub is_loopback: bool,
    pub memory_scope: String,
    pub assigned_layers: Vec<i32>,
    pub assigned_layer_ranges: Vec<(i32, i32)>,
    pub model_buffer_bytes: u64,
    pub kv_buffer_bytes: u64,
    pub compute_buffer_bytes: u64,
    pub measurement_status: String,
    pub virtual_budget_bytes: Option<u64>,
    pub capped_capacity: Option<i32>,
    pub split_weight: Option<f32>,
    pub predicted_layers: Option<Vec<i32>>,
    pub policy_match: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimePlacementReport {
    pub is_running: bool,
    pub policy_name: Option<String>,
    pub policy_evaluated: bool,
    pub backends: Vec<RuntimePlacementBackend>,
    pub raw_json: Option<String>,
}

pub fn gather_live_candidate_telemetry(workspace_root: &std::path::Path) -> Vec<super::planning::CandidateDeviceTelemetry> {
    let mut candidates = Vec::new();

    // 1. Host CUDA GPU
    let vram_info = super::win32::get_available_vram_mb();
    if let Some((free, total)) = vram_info {
        candidates.push(super::planning::CandidateDeviceTelemetry {
            device_id: "local-cuda-0".to_string(),
            device_name: "Host NVIDIA CUDA GPU".to_string(),
            backend_type: "cuda".to_string(),
            is_loopback: false,
            memory_total_mb: Some(total),
            memory_free_mb: Some(free),
            is_online: true,
            is_stale: false,
            telemetry_age_ms: 0,
            provenance: "MEASURED".to_string(),
        });
    }

    // 2. Host Loopback RPC Worker
    let mem_info = super::win32::get_available_physical_memory();
    let ram_free = mem_info.map(|(avail, _)| avail / (1024 * 1024));
    let ram_total = mem_info.map(|(_, total)| total / (1024 * 1024));

    candidates.push(super::planning::CandidateDeviceTelemetry {
        device_id: "127.0.0.1:50052".to_string(),
        device_name: "Host Loopback RPC Worker".to_string(),
        backend_type: "rpc".to_string(),
        is_loopback: true,
        memory_total_mb: ram_total,
        memory_free_mb: ram_free,
        is_online: true,
        is_stale: false,
        telemetry_age_ms: 0,
        provenance: "MEASURED".to_string(),
    });

    // 3. Registered Remote Workers
    let remote_workers = load_remote_workers(workspace_root);
    for rw in remote_workers {
        let endpoint = format!("{}:{}", rw.host.trim(), rw.port);
        let probe = probe_remote_worker_endpoint_internal(&rw.host, rw.port, 1500);
        let is_online = probe.reachable;

        candidates.push(super::planning::CandidateDeviceTelemetry {
            device_id: endpoint,
            device_name: rw.name.clone(),
            backend_type: "rpc".to_string(),
            is_loopback: false,
            memory_total_mb: None,
            memory_free_mb: None,
            is_online,
            is_stale: false,
            telemetry_age_ms: 0,
            provenance: if is_online { "MEASURED".to_string() } else { "UNAVAILABLE".to_string() },
        });
    }

    candidates
}

#[tauri::command]
pub fn supervisor_get_allocation_config(
    state: State<'_, SupervisorState>,
) -> GetAllocationConfigResponse {
    let config = super::planning::load_allocation_config(&state.workspace_root)
        .unwrap_or_default();
    let has_backup = super::planning::has_allocation_backup(&state.workspace_root);
    let active_policy = match config.mode.as_str() {
        "automatic" => "dynamic",
        "manual" => "resource_aware",
        _ => "none",
    }.to_string();

    GetAllocationConfigResponse {
        config,
        has_backup,
        active_policy,
    }
}

#[tauri::command]
pub fn supervisor_preview_allocation_plan(
    state: State<'_, SupervisorState>,
    config: super::planning::ComputeAllocationConfig,
    custom_candidates: Option<Vec<super::planning::CandidateDeviceTelemetry>>,
) -> super::planning::AllocationPlanPreview {
    let candidates = custom_candidates.unwrap_or_else(|| gather_live_candidate_telemetry(&state.workspace_root));
    super::planning::AllocationPlanner::evaluate_plan(&config, &candidates)
}

#[tauri::command]
pub fn supervisor_apply_allocation_config(
    state: State<'_, SupervisorState>,
    config: super::planning::ComputeAllocationConfig,
    restart_coordinator: bool,
) -> Result<ApplyAllocationResult, String> {
    let candidates = gather_live_candidate_telemetry(&state.workspace_root);
    let preview = super::planning::AllocationPlanner::evaluate_plan(&config, &candidates);
    if !preview.is_valid {
        return Err(format!("Allocation Plan Validation Failed: {}", preview.validation_errors.join("; ")));
    }

    // Transactional backup of current known-good configuration
    super::planning::create_allocation_backup(&state.workspace_root)?;
    super::planning::save_allocation_config(&state.workspace_root, &config)?;

    let mut did_restart = false;
    if restart_coordinator {
        let current_status = state.orchestrator.get_status();
        let was_running = matches!(
            current_status.state,
            ClusterLifecycleState::Ready
                | ClusterLifecycleState::StartingCoordinator
                | ClusterLifecycleState::WaitingForCoordinator
                | ClusterLifecycleState::StartingRpc
                | ClusterLifecycleState::WaitingForRpc
        );

        if was_running {
            let _ = stop_engine_internal(&state);
            std::thread::sleep(std::time::Duration::from_millis(1000));
            match start_engine_internal(&state, Some(StartEngineOptions {
                mode: Some("real".to_string()),
                profile: Some("default".to_string()),
                allow_real_runtime: Some(true),
                ..Default::default()
            })) {
                Ok(_) => {
                    did_restart = true;
                }
                Err(e) => {
                    // Rollback on failure!
                    let _ = super::planning::restore_allocation_backup(&state.workspace_root);
                    return Err(format!("Coordinator restart with new allocation failed: {}. Safely rolled back to previous configuration.", e));
                }
            }
        }
    }

    Ok(ApplyAllocationResult {
        success: true,
        preview,
        message: if did_restart {
            "Allocation plan applied and coordinator successfully restarted with new layer distribution.".to_string()
        } else {
            "Allocation plan saved. Configuration will take effect upon next coordinator restart.".to_string()
        },
        coordinator_restarted: did_restart,
    })
}

#[tauri::command]
pub fn supervisor_rollback_allocation_config(
    state: State<'_, SupervisorState>,
    restart_coordinator: bool,
) -> Result<RollbackAllocationResult, String> {
    let restored_config = super::planning::restore_allocation_backup(&state.workspace_root)?;

    let mut did_restart = false;
    if restart_coordinator {
        let current_status = state.orchestrator.get_status();
        let was_running = matches!(
            current_status.state,
            ClusterLifecycleState::Ready
                | ClusterLifecycleState::StartingCoordinator
                | ClusterLifecycleState::WaitingForCoordinator
                | ClusterLifecycleState::StartingRpc
                | ClusterLifecycleState::WaitingForRpc
        );

        if was_running {
            let _ = stop_engine_internal(&state);
            std::thread::sleep(std::time::Duration::from_millis(1000));
            let _ = start_engine_internal(&state, Some(StartEngineOptions {
                mode: Some("real".to_string()),
                profile: Some("default".to_string()),
                allow_real_runtime: Some(true),
                ..Default::default()
            }));
            did_restart = true;
        }
    }

    Ok(RollbackAllocationResult {
        success: true,
        restored_config,
        message: "Successfully rolled back to previous known-good allocation configuration.".to_string(),
        coordinator_restarted: did_restart,
    })
}

/// Helper using standard TcpStream to query coordinator JSON endpoints without third-party HTTP clients
pub fn fetch_coordinator_json_body(path: &str, port: u16, timeout_ms: u64) -> Option<serde_json::Value> {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;

    let timeout = Duration::from_millis(timeout_ms);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));

    if let Ok(mut stream) = TcpStream::connect_timeout(&addr, timeout) {
        let _ = stream.set_read_timeout(Some(timeout));
        let _ = stream.set_write_timeout(Some(timeout));
        let request = format!(
            "GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nUser-Agent: SwarmSupervisor/0.1.0\r\n\r\n",
            path, port
        );
        if stream.write_all(request.as_bytes()).is_ok() {
            let mut response_buf = Vec::new();
            let mut chunk = [0u8; 8192];
            while let Ok(n) = stream.read(&mut chunk) {
                if n == 0 { break; }
                response_buf.extend_from_slice(&chunk[..n]);
                if response_buf.len() > 1024 * 1024 { break; }
            }
            let resp_str = String::from_utf8_lossy(&response_buf);
            if let Some((_, body)) = resp_str.split_once("\r\n\r\n") {
                return serde_json::from_str::<serde_json::Value>(body.trim()).ok();
            }
        }
    }
    None
}

#[tauri::command]
pub fn supervisor_get_runtime_placement() -> RuntimePlacementReport {
    if let Some(val) = fetch_coordinator_json_body("/backends", 8080, 1500) {
        let policy_name = val.get("placement_policy")
            .or_else(|| val.get("policy_name"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let policy_evaluated = val.get("policy_evaluated").and_then(|v| v.as_bool()).unwrap_or(false);
        let backends_val = val.get("backends").and_then(|v| v.as_array());

        let mut backends = Vec::new();
        if let Some(arr) = backends_val {
            for b in arr {
                let backend_id = b.get("backend_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let device_name = b.get("device_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let description = b.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let endpoint = b.get("endpoint").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let backend_type = b.get("backend_type").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let is_loopback = b.get("is_loopback").and_then(|v| v.as_bool()).unwrap_or(false);
                let memory_scope = b.get("memory_scope").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let assigned_layers: Vec<i32> = b.get("assigned_layers")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_i64().map(|n| n as i32)).collect())
                    .unwrap_or_default();
                let assigned_layer_ranges: Vec<(i32, i32)> = b.get("assigned_layer_ranges")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter().filter_map(|pair| {
                            let p = pair.as_array()?;
                            if p.len() == 2 {
                                Some((p[0].as_i64()? as i32, p[1].as_i64()? as i32))
                            } else {
                                None
                            }
                        }).collect()
                    })
                    .unwrap_or_default();
                let model_buffer_bytes = b.get("model_buffer_bytes").and_then(|v| v.as_u64()).unwrap_or(0);
                let kv_buffer_bytes = b.get("kv_buffer_bytes").and_then(|v| v.as_u64()).unwrap_or(0);
                let compute_buffer_bytes = b.get("compute_buffer_bytes").and_then(|v| v.as_u64()).unwrap_or(0);
                let measurement_status = b.get("measurement_status").and_then(|v| v.as_str()).unwrap_or("unavailable").to_string();
                let virtual_budget_bytes = b.get("virtual_budget_bytes").and_then(|v| v.as_u64());
                let capped_capacity = b.get("capped_capacity").and_then(|v| v.as_i64()).map(|n| n as i32);
                let split_weight = b.get("split_weight").and_then(|v| v.as_f64()).map(|f| f as f32);
                let predicted_layers: Option<Vec<i32>> = b.get("predicted_layers")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_i64().map(|n| n as i32)).collect());
                let policy_match = b.get("policy_match").and_then(|v| v.as_bool());

                backends.push(RuntimePlacementBackend {
                    backend_id,
                    device_name,
                    description,
                    endpoint,
                    backend_type,
                    is_loopback,
                    memory_scope,
                    assigned_layers,
                    assigned_layer_ranges,
                    model_buffer_bytes,
                    kv_buffer_bytes,
                    compute_buffer_bytes,
                    measurement_status,
                    virtual_budget_bytes,
                    capped_capacity,
                    split_weight,
                    predicted_layers,
                    policy_match,
                });
            }
        }

        return RuntimePlacementReport {
            is_running: true,
            policy_name,
            policy_evaluated,
            backends,
            raw_json: Some(val.to_string()),
        };
    }

    RuntimePlacementReport {
        is_running: false,
        policy_name: None,
        policy_evaluated: false,
        backends: vec![],
        raw_json: None,
    }
}

