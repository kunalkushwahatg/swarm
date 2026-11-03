//! Compute allocation planning, preview, apply, rollback, and runtime placement.

use std::path::Path;
use std::net::{SocketAddr, TcpStream};
use std::io::{Read, Write};
use std::time::Duration;
use tauri::State;

use super::types::*;
use super::lifecycle::{start_engine_internal, stop_engine_internal};
use super::workers::probe_remote_worker_endpoint_internal;
use crate::supervisor::orchestrator::ClusterLifecycleState;
use crate::supervisor::paths::load_remote_workers;
use crate::supervisor::planning;
use crate::supervisor::win32;

fn selected_model_planning_profile(state: &SupervisorState) -> planning::ModelPlanningProfile {
    state
        .model_library
        .get_selected_model_path()
        .filter(|path| path.exists())
        .map(|path| planning::model_planning_profile_from_path(&path))
        .unwrap_or_default()
}

fn runtime_backend_for_endpoint<'a>(
    placement: &'a serde_json::Value,
    endpoint: &str,
) -> Option<&'a serde_json::Value> {
    placement
        .get("backends")
        .and_then(|value| value.as_array())
        .and_then(|backends| {
            backends.iter().find(|backend| {
                backend
                    .get("endpoint")
                    .and_then(|value| value.as_str())
                    .map(|value| value == endpoint)
                    .unwrap_or(false)
                    || backend
                        .get("description")
                        .and_then(|value| value.as_str())
                        .map(|value| value == endpoint)
                        .unwrap_or(false)
            })
        })
}

pub fn gather_live_candidate_telemetry(workspace_root: &std::path::Path) -> Vec<crate::supervisor::planning::CandidateDeviceTelemetry> {
    let mut candidates = Vec::new();

    // 1. Host CUDA GPU
    let vram_info = crate::supervisor::win32::get_available_vram_mb();
    if let Some((free, total)) = vram_info {
        candidates.push(crate::supervisor::planning::CandidateDeviceTelemetry {
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
    let mem_info = crate::supervisor::win32::get_available_physical_memory();
    let ram_free = mem_info.map(|(avail, _)| avail / (1024 * 1024));
    let ram_total = mem_info.map(|(_, total)| total / (1024 * 1024));

    candidates.push(crate::supervisor::planning::CandidateDeviceTelemetry {
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

    // 3. Registered Remote Workers. An RPC worker accepts exactly one TCP
    // connection, so a direct probe fails while the coordinator is already
    // connected to it. Prefer the coordinator's /backends telemetry and only
    // fall back to a TCP probe when the engine is stopped.
    let is_coord_listening = !crate::supervisor::config::is_loopback_port_available(8080);
    let runtime_placement = if is_coord_listening {
        fetch_coordinator_json_body("/backends", 8080, 600)
    } else {
        None
    };
    let remote_workers = load_remote_workers(workspace_root);
    for rw in remote_workers {
        let endpoint = format!("{}:{}", rw.host.trim(), rw.port);
        if endpoint == "127.0.0.1:50052" || endpoint == "localhost:50052" {
            continue;
        }

        let runtime_backend =
            runtime_placement.as_ref().and_then(|placement| runtime_backend_for_endpoint(placement, &endpoint));
        let runtime_memory_total_mb = runtime_backend
            .and_then(|backend| backend.get("memory_total_bytes"))
            .and_then(|value| value.as_u64())
            .filter(|bytes| *bytes > 0)
            .map(|bytes| bytes / (1024 * 1024));
        let runtime_memory_free_mb = runtime_backend
            .and_then(|backend| backend.get("memory_free_bytes"))
            .and_then(|value| value.as_u64())
            .filter(|bytes| *bytes > 0)
            .map(|bytes| bytes / (1024 * 1024));

        let is_connected = runtime_backend.is_some();
        let tcp_reachable = if is_connected {
            false
        } else {
            probe_remote_worker_endpoint_internal(&rw.host, rw.port, 400).reachable
        };
        let is_online = is_connected || tcp_reachable;
        let provenance = if runtime_memory_free_mb.is_some() {
            "MEASURED_RUNTIME"
        } else if is_online {
            "UNKNOWN"
        } else {
            "UNAVAILABLE"
        };

        candidates.push(crate::supervisor::planning::CandidateDeviceTelemetry {
            device_id: endpoint,
            device_name: rw.name.clone(),
            backend_type: "rpc".to_string(),
            is_loopback: false,
            memory_total_mb: runtime_memory_total_mb,
            memory_free_mb: runtime_memory_free_mb,
            is_online,
            is_stale: false,
            telemetry_age_ms: 0,
            provenance: provenance.to_string(),
        });
    }

    candidates
}

#[tauri::command]
pub fn supervisor_get_allocation_config(
    state: State<'_, SupervisorState>,
) -> GetAllocationConfigResponse {
    let config = crate::supervisor::planning::load_allocation_config(&state.workspace_root)
        .unwrap_or_default();
    let has_backup = crate::supervisor::planning::has_allocation_backup(&state.workspace_root);
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
    config: crate::supervisor::planning::ComputeAllocationConfig,
    custom_candidates: Option<Vec<crate::supervisor::planning::CandidateDeviceTelemetry>>,
) -> crate::supervisor::planning::AllocationPlanPreview {
    let candidates = custom_candidates.unwrap_or_else(|| gather_live_candidate_telemetry(&state.workspace_root));
    let profile = selected_model_planning_profile(&state);
    crate::supervisor::planning::AllocationPlanner::evaluate_plan_with_profile(
        &config,
        &candidates,
        &profile,
    )
}

fn apply_allocation_internal(
    state: &SupervisorState,
    config: crate::supervisor::planning::ComputeAllocationConfig,
    restart_coordinator: bool,
) -> Result<ApplyAllocationResult, String> {
    let candidates = gather_live_candidate_telemetry(&state.workspace_root);
    let profile = selected_model_planning_profile(state);
    let preview = crate::supervisor::planning::AllocationPlanner::evaluate_plan_with_profile(
        &config,
        &candidates,
        &profile,
    );
    if !preview.is_valid {
        return Err(format!("Allocation Plan Validation Failed: {}", preview.validation_errors.join("; ")));
    }

    // Transactional backup of current known-good configuration
    crate::supervisor::planning::create_allocation_backup(&state.workspace_root)?;
    crate::supervisor::planning::save_allocation_config(&state.workspace_root, &config)?;

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

        let has_rpc_workers = config.device_settings.iter().any(|d| d.enabled && (d.backend_type == "rpc" || d.device_id.contains(':')));
        let target_profile = if has_rpc_workers {
            "default".to_string()
        } else {
            current_status.active_profile.clone().unwrap_or_else(|| "default".to_string())
        };

        if was_running {
            let _ = stop_engine_internal(state);
            std::thread::sleep(std::time::Duration::from_millis(1000));
        }

        match start_engine_internal(state, Some(StartEngineOptions {
            mode: Some("real".to_string()),
            profile: Some(target_profile),
            allow_real_runtime: Some(true),
            ..Default::default()
        })) {
            Ok(_) => {
                did_restart = true;
            }
            Err(e) => {
                // Rollback on failure!
                let _ = crate::supervisor::planning::restore_allocation_backup(&state.workspace_root);
                return Err(format!("Coordinator start with new allocation failed: {}. Safely rolled back to previous configuration.", e));
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
pub async fn supervisor_apply_allocation_config(
    state: State<'_, SupervisorState>,
    config: crate::supervisor::planning::ComputeAllocationConfig,
    restart_coordinator: bool,
) -> Result<ApplyAllocationResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply_allocation_internal(&state, config, restart_coordinator)
    })
    .await
    .map_err(|e| format!("Allocation apply task failed: {}", e))?
}

fn rollback_allocation_internal(
    state: &SupervisorState,
    restart_coordinator: bool,
) -> Result<RollbackAllocationResult, String> {
    let restored_config = crate::supervisor::planning::restore_allocation_backup(&state.workspace_root)?;

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
            let active_profile = current_status.active_profile.clone().unwrap_or_else(|| "default".to_string());
            stop_engine_internal(state)
                .map_err(|e| format!("Failed to stop the engine before rollback restart: {}", e))?;
            std::thread::sleep(std::time::Duration::from_millis(1000));
            match start_engine_internal(state, Some(StartEngineOptions {
                mode: Some("real".to_string()),
                profile: Some(active_profile),
                allow_real_runtime: Some(true),
                ..Default::default()
            })) {
                Ok(_) => {
                    did_restart = true;
                }
                Err(e) => {
                    return Err(format!(
                        "Allocation rolled back to the previous configuration, but the coordinator failed to restart: {}",
                        e
                    ));
                }
            }
        }
    }

    Ok(RollbackAllocationResult {
        success: true,
        restored_config,
        message: "Successfully rolled back to previous known-good allocation configuration.".to_string(),
        coordinator_restarted: did_restart,
    })
}

#[tauri::command]
pub async fn supervisor_rollback_allocation_config(
    state: State<'_, SupervisorState>,
    restart_coordinator: bool,
) -> Result<RollbackAllocationResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        rollback_allocation_internal(&state, restart_coordinator)
    })
    .await
    .map_err(|e| format!("Allocation rollback task failed: {}", e))?
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
    if crate::supervisor::config::is_loopback_port_available(8080) {
        return RuntimePlacementReport::default();
    }
    if let Some(val) = fetch_coordinator_json_body("/backends", 8080, 800) {
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

