//! Tauri IPC command endpoints for Worker Mode compute sharing and supervision.
//!
//! Worker mode status probes and lifecycle transitions can spawn PowerShell,
//! nvidia-smi, and wait for a child process for several seconds. Running them
//! directly in a Tauri command blocks the event loop, so every command offloads
//! to `spawn_blocking` and returns a join error instead of freezing the webview.
//!
//! On Android the lifecycle is owned by the Kotlin foreground service
//! (`SwarmWorkerService`), so the same commands delegate to the JNI bridge in
//! `supervisor::android_worker` and return the identical status contract.

use tauri::State;
use super::types::SupervisorState;
use crate::supervisor::worker_mode::{
    WorkerModeConfig, WorkerModeStatus, WorkerStartResult, WorkerHardwareTelemetry, WorkerModeManager,
};

fn join_error<E: std::fmt::Display>(operation: &str, e: E) -> String {
    format!("Worker mode {} task failed: {}", operation, e)
}

#[tauri::command]
pub async fn supervisor_get_worker_config(
    state: State<'_, SupervisorState>,
) -> Result<WorkerModeConfig, String> {
    let manager = state.worker_manager.clone();
    tauri::async_runtime::spawn_blocking(move || manager.get_config())
        .await
        .map_err(|e| join_error("config read", e))
}

#[tauri::command]
pub async fn supervisor_save_worker_config(
    state: State<'_, SupervisorState>,
    config: WorkerModeConfig,
) -> Result<WorkerModeConfig, String> {
    let manager = state.worker_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.save_config(&config)?;
        Ok(manager.get_config())
    })
    .await
    .map_err(|e| join_error("config save", e))?
}

#[tauri::command]
pub async fn supervisor_get_worker_status(
    state: State<'_, SupervisorState>,
) -> Result<WorkerModeStatus, String> {
    #[cfg(target_os = "android")]
    {
        let manager = state.worker_manager.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            crate::supervisor::android_worker::status(&manager)
        })
        .await
        .map_err(|e| join_error("status", e))?;
    }

    #[cfg(not(target_os = "android"))]
    {
        let manager = state.worker_manager.clone();
        tauri::async_runtime::spawn_blocking(move || manager.get_status())
            .await
            .map_err(|e| join_error("status", e))
    }
}

#[tauri::command]
pub async fn supervisor_start_worker(
    state: State<'_, SupervisorState>,
    config: Option<WorkerModeConfig>,
) -> Result<WorkerStartResult, String> {
    #[cfg(target_os = "android")]
    {
        let manager = state.worker_manager.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            crate::supervisor::android_worker::start(&manager, config)
        })
        .await
        .map_err(|e| join_error("start", e))?;
    }

    #[cfg(not(target_os = "android"))]
    {
        let manager = state.worker_manager.clone();
        tauri::async_runtime::spawn_blocking(move || manager.start_worker(config))
            .await
            .map_err(|e| join_error("start", e))?
    }
}

#[tauri::command]
pub async fn supervisor_stop_worker(
    state: State<'_, SupervisorState>,
) -> Result<WorkerModeStatus, String> {
    #[cfg(target_os = "android")]
    {
        let manager = state.worker_manager.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            crate::supervisor::android_worker::stop(&manager)
        })
        .await
        .map_err(|e| join_error("stop", e))?;
    }

    #[cfg(not(target_os = "android"))]
    {
        let manager = state.worker_manager.clone();
        tauri::async_runtime::spawn_blocking(move || manager.stop_worker())
            .await
            .map_err(|e| join_error("stop", e))?
    }
}

#[tauri::command]
pub async fn supervisor_revoke_remote_access(
    state: State<'_, SupervisorState>,
) -> Result<WorkerModeStatus, String> {
    #[cfg(target_os = "android")]
    {
        let manager = state.worker_manager.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            crate::supervisor::android_worker::revoke_remote_access(&manager)
        })
        .await
        .map_err(|e| join_error("revoke", e))?;
    }

    #[cfg(not(target_os = "android"))]
    {
        let manager = state.worker_manager.clone();
        tauri::async_runtime::spawn_blocking(move || manager.revoke_remote_access())
            .await
            .map_err(|e| join_error("revoke", e))?
    }
}

#[tauri::command]
pub async fn supervisor_apply_firewall_rule(
    state: State<'_, SupervisorState>,
    port: Option<u16>,
    controller_ip: String,
) -> Result<String, String> {
    let manager = state.worker_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let target_port = port.unwrap_or_else(|| manager.get_config().rpc_port);
        WorkerModeManager::apply_firewall_rule(target_port, &controller_ip)
    })
    .await
    .map_err(|e| join_error("firewall apply", e))?
}

#[tauri::command]
pub async fn supervisor_get_worker_hardware(
    _state: State<'_, SupervisorState>,
) -> Result<WorkerHardwareTelemetry, String> {
    tauri::async_runtime::spawn_blocking(WorkerModeManager::probe_hardware_telemetry)
        .await
        .map_err(|e| join_error("hardware probe", e))
}

#[tauri::command]
pub async fn supervisor_check_firewall_status(
    state: State<'_, SupervisorState>,
    port: Option<u16>,
) -> Result<Option<bool>, String> {
    #[cfg(target_os = "android")]
    {
        // Android has no host firewall to inspect; report "not applicable".
        let _ = (state, port);
        return Ok(None);
    }

    #[cfg(not(target_os = "android"))]
    {
        let manager = state.worker_manager.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let config = manager.get_config();
            let target_port = port.unwrap_or(config.rpc_port);
            let controller = if config.authorized_controller_ip.trim().is_empty() {
                None
            } else {
                Some(config.authorized_controller_ip.as_str())
            };
            WorkerModeManager::check_firewall_rule(target_port, controller)
        })
        .await
        .map_err(|e| join_error("firewall status", e))
    }
}

#[tauri::command]
pub async fn supervisor_get_worker_logs(
    state: State<'_, SupervisorState>,
    count: Option<usize>,
) -> Result<Vec<String>, String> {
    #[cfg(target_os = "android")]
    {
        let _ = &state;
        return tauri::async_runtime::spawn_blocking(move || {
            crate::supervisor::android_worker::logs(count)
        })
        .await
        .map_err(|e| join_error("logs", e));
    }

    #[cfg(not(target_os = "android"))]
    {
        let manager = state.worker_manager.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let pid_opt = *manager.worker_pid.lock().unwrap();
            if let Some(pid) = pid_opt {
                manager.manager.get_logs(pid, count).unwrap_or_default()
            } else {
                vec![]
            }
        })
        .await
        .map_err(|e| join_error("logs", e))
    }
}
