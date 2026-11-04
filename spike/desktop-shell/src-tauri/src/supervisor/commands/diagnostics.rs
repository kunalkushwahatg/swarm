//! Diagnostics, preflight verification, and simulated test fixtures.

use std::path::PathBuf;
use tauri::State;

use super::types::*;
use crate::supervisor::config::{
    is_loopback_port_available, is_port_listening, probe_coordinator_health_detailed,
    probe_rpc_reachability, validate_binary_path, validate_model_path_file,
    CoordinatorConfig, DetailedHttpHealth, DetailedRpcReachability, PreflightReport,
    RuntimeProfile,
};
use crate::supervisor::paths::{resolve_model_file, resolve_native_runtime};
use crate::supervisor::process::{ChildProcessSnapshot, ProcessManager, ProcessRole, ProcessStatus};
use crate::supervisor::shutdown::{shutdown_managed_child, ShutdownResult};

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
    let runtime_paths = resolve_native_runtime(root).unwrap_or_else(|_| crate::supervisor::paths::RuntimePaths {
        coord_executable: root.join(r"build-cuda\swarm_node.exe"),
        rpc_executable: root.join(r"dist\swarm-worker-windows-x64\ggml-rpc-server.exe"),
        tunnel_executable: None,
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
    let workspace_root = std::env::var("SWARM_WORKSPACE_ROOT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
        });
    let root = workspace_root.to_string_lossy();

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
                path: format!(r"{}\build-cuda\swarm_node.exe", root),
                exists: true,
                is_file: true,
            },
            rpc_executable: ExecutableCheck {
                name: "ggml-rpc-server.exe".to_string(),
                path: format!(r"{}\dist\swarm-worker-windows-x64\ggml-rpc-server.exe", root),
                exists: true,
                is_file: true,
            },
            dll_directories: vec![],
            model_file: ModelFileCheck {
                path: format!(r"{}\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf", root),
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
                path: format!(r"{}\build-cuda\swarm_node.exe", root),
                exists: true,
                is_file: true,
            },
            rpc_executable: ExecutableCheck {
                name: "ggml-rpc-server.exe".to_string(),
                path: format!(r"{}\dist\swarm-worker-windows-x64\ggml-rpc-server.exe", root),
                exists: true,
                is_file: true,
            },
            dll_directories: vec![],
            model_file: ModelFileCheck {
                path: format!(r"{}\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf", root),
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
                path: format!(r"{}\build-cuda\swarm_node.exe", root),
                exists: true,
                is_file: true,
            },
            rpc_executable: ExecutableCheck {
                name: "ggml-rpc-server.exe".to_string(),
                path: format!(r"{}\dist\swarm-worker-windows-x64\ggml-rpc-server.exe", root),
                exists: true,
                is_file: true,
            },
            dll_directories: vec![],
            model_file: ModelFileCheck {
                path: format!(r"{}\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf", root),
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
                path: format!(r"{}\build-cuda\swarm_node.exe", root),
                exists: false,
                is_file: false,
            },
            rpc_executable: ExecutableCheck {
                name: "ggml-rpc-server.exe".to_string(),
                path: format!(r"{}\dist\swarm-worker-windows-x64\ggml-rpc-server.exe", root),
                exists: false,
                is_file: false,
            },
            dll_directories: vec![
                DllDirectoryCheck {
                    path: format!(r"{}\build-cuda", root),
                    exists: true,
                    is_directory: true,
                },
                DllDirectoryCheck {
                    path: format!(r"{}\build-cuda\bin", root),
                    exists: false,
                    is_directory: false,
                },
            ],
            model_file: ModelFileCheck {
                path: format!(r"{}\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf", root),
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
                path: format!(r"{}\build-cuda\swarm_node.exe", root),
                exists: true,
                is_file: true,
            },
            rpc_executable: ExecutableCheck {
                name: "ggml-rpc-server.exe".to_string(),
                path: format!(r"{}\dist\swarm-worker-windows-x64\ggml-rpc-server.exe", root),
                exists: true,
                is_file: true,
            },
            dll_directories: vec![],
            model_file: ModelFileCheck {
                path: format!(r"{}\models\missing_model.gguf", root),
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
                path: format!(r"{}\build-cuda\swarm_node.exe", root),
                exists: true,
                is_file: true,
            },
            rpc_executable: ExecutableCheck {
                name: "ggml-rpc-server.exe".to_string(),
                path: format!(r"{}\dist\swarm-worker-windows-x64\ggml-rpc-server.exe", root),
                exists: true,
                is_file: true,
            },
            dll_directories: vec![],
            model_file: ModelFileCheck {
                path: format!(r"{}\models\model.invalid_ext", root),
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
                path: format!(r"{}\build-cuda\swarm_node.exe", root),
                exists: true,
                is_file: true,
            },
            rpc_executable: ExecutableCheck {
                name: "ggml-rpc-server.exe".to_string(),
                path: format!(r"{}\dist\swarm-worker-windows-x64\ggml-rpc-server.exe", root),
                exists: true,
                is_file: true,
            },
            dll_directories: vec![
                DllDirectoryCheck {
                    path: format!(r"{}\build-cuda", root),
                    exists: true,
                    is_directory: true,
                },
                DllDirectoryCheck {
                    path: format!(r"{}\build-cuda\bin", root),
                    exists: true,
                    is_directory: true,
                },
            ],
            model_file: ModelFileCheck {
                path: format!(r"{}\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf", root),
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

    let runtime_paths = resolve_native_runtime(root).unwrap_or_else(|_| crate::supervisor::paths::RuntimePaths {
        coord_executable: root.join(r"build-cuda\swarm_node.exe"),
        rpc_executable: root.join(r"dist\swarm-worker-windows-x64\ggml-rpc-server.exe"),
        tunnel_executable: None,
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
    profile_id: Option<String>,
) -> Result<PreflightReport, String> {
    let mut cfg = config.unwrap_or_default();

    // The UI sends a profile id. Previously this argument was ignored because
    // the backend only accepted `config`, so preflight always checked the
    // default profile's ports even when the operator selected standalone mode.
    if let Some(profile_id) = profile_id {
        let profile = RuntimeProfile::from_id(&profile_id)
            .ok_or_else(|| format!("Unknown runtime profile '{}'.", profile_id))?;
        cfg.port = profile.coordinator_port();
        cfg.use_rpc = profile.requires_rpc_worker();
        cfg.rpc_port = profile.rpc_port().unwrap_or(0);
    }

    Ok(run_preflight_check(&state.workspace_root, cfg))
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
