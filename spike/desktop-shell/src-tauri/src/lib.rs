pub mod supervisor;

use std::path::PathBuf;
use std::sync::Arc;
use supervisor::{JobObject, ProcessManager, SupervisorState};

#[tauri::command]
fn save_spike_results(results: String) -> Result<(), String> {
    let base = std::env::var("SWARM_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        });
    let path = base.join("spike").join("desktop-shell").join("diagnostic_results.json");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, &results).map_err(|e| e.to_string())?;
    println!("[Tauri IPC] Saved spike diagnostic results to {}", path.display());
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let job = Arc::new(JobObject::new().expect("Failed to initialize Windows Job Object"));
    let manager = Arc::new(ProcessManager::new(Arc::clone(&job)));
    let orchestrator = Arc::new(supervisor::Orchestrator::new(Arc::clone(&manager)));
    let workspace_root = match std::env::var("SWARM_WORKSPACE_ROOT") {
        Ok(val) => PathBuf::from(val),
        Err(_) => {
            if let Ok(exe_path) = std::env::current_exe() {
                if let Some(exe_dir) = exe_path.parent() {
                    let dev_root = exe_dir.ancestors().find(|p| p.join("build-cuda").exists() && p.join("ui").exists());
                    if let Some(root) = dev_root {
                        root.to_path_buf()
                    } else {
                        exe_dir.to_path_buf()
                    }
                } else {
                    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
                }
            } else {
                std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
            }
        }
    };
    let state = SupervisorState {
        manager,
        orchestrator,
        workspace_root,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            save_spike_results,
            supervisor::commands::supervisor_get_status,
            supervisor::commands::supervisor_preflight_check,
            supervisor::commands::supervisor_get_diagnostics,
            supervisor::commands::supervisor_get_diagnostic_fixture,
            supervisor::commands::supervisor_start_test_child,
            supervisor::commands::supervisor_stop_test_child,
            supervisor::commands::supervisor_get_logs,
            supervisor::commands::supervisor_start_coordinator,
            supervisor::commands::supervisor_start_worker,
            supervisor::commands::supervisor_start_engine,
            supervisor::commands::supervisor_stop_engine,
            supervisor::commands::supervisor_cancel_startup,
            supervisor::commands::supervisor_get_engine_status,
            supervisor::commands::supervisor_get_available_profiles,
            supervisor::commands::supervisor_get_profile_fixture,
            supervisor::commands::supervisor_probe_worker_endpoint,
            supervisor::commands::supervisor_get_host_network_info,
            supervisor::commands::supervisor_get_registered_workers,
            supervisor::commands::supervisor_register_worker,
            supervisor::commands::supervisor_remove_worker,
            supervisor::commands::supervisor_get_allocation_config,
            supervisor::commands::supervisor_preview_allocation_plan,
            supervisor::commands::supervisor_apply_allocation_config,
            supervisor::commands::supervisor_rollback_allocation_config,
            supervisor::commands::supervisor_get_runtime_placement,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}


