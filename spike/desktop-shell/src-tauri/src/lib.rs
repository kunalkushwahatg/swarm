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

/// Resolves the writable workspace root for this platform.
///
/// Android apps have no meaningful working directory (`/` is not writable), so
/// the app-private files directory is used. On desktop the executable location
/// is used, walking up to the development repository root when it is detected.
fn default_workspace_root() -> PathBuf {
    #[cfg(target_os = "android")]
    {
        if let Some(dir) = supervisor::android_worker::default_workspace_root() {
            return dir;
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let dev_root = exe_dir
                .ancestors()
                .find(|p| p.join("build-cuda").exists() && p.join("ui").exists());
            if let Some(root) = dev_root {
                return root.to_path_buf();
            }
            return exe_dir.to_path_buf();
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Automatically calibrate low-memory threshold for 8GB or lower RAM devices if not overridden
    if std::env::var("SWARM_MIN_RAM_MB").is_err() {
        if let Some((_, total_bytes)) = supervisor::win32::get_available_physical_memory() {
            let total_mb = total_bytes / (1024 * 1024);
            if total_mb <= 8500 {
                // Safety: run() is the single-threaded initialization entry point of the application
                unsafe {
                    std::env::set_var("SWARM_MIN_RAM_MB", "300");
                }
                println!("[Supervisor] Auto-calibrated low-memory headroom threshold to 300 MB for 8GB host (Total: {} MB)", total_mb);
            }
        }
    }

    // Automatically calibrate standalone VRAM threshold for 4GB or lower GPUs
    if std::env::var("SWARM_MIN_VRAM_MB").is_err() {
        if let Some((_, total_vram_mb)) = supervisor::win32::get_available_vram_mb() {
            if total_vram_mb <= 4500 {
                unsafe {
                    std::env::set_var("SWARM_MIN_VRAM_MB", "800");
                }
                println!("[Supervisor] Auto-calibrated standalone VRAM threshold to 800 MB for 4GB GPU host (Total: {} MB)", total_vram_mb);
            }
        }
    }

    let job = Arc::new(JobObject::new().expect("Failed to initialize Windows Job Object"));
    supervisor::job::set_global_job(Arc::clone(&job));
    let manager = Arc::new(ProcessManager::new(Arc::clone(&job)));
    let orchestrator = Arc::new(supervisor::Orchestrator::new(Arc::clone(&manager)));
    let workspace_root = match std::env::var("SWARM_WORKSPACE_ROOT") {
        Ok(val) => PathBuf::from(val),
        Err(_) => default_workspace_root(),
    };
    let worker_manager = Arc::new(supervisor::WorkerModeManager::new(
        Arc::clone(&manager),
        workspace_root.clone(),
    ));
    let model_library = Arc::new(supervisor::ModelLibraryManager::new(workspace_root.clone()));
    let download_manager = Arc::new(supervisor::DownloadManager::new(model_library.get_models_dir()));
    let state = SupervisorState {
        manager,
        orchestrator,
        worker_manager,
        model_library,
        download_manager,
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
            supervisor::commands::supervisor_pair_worker,
            supervisor::commands::supervisor_remove_worker,
            supervisor::commands::supervisor_discover_workers,
            supervisor::commands::supervisor_get_allocation_config,
            supervisor::commands::supervisor_preview_allocation_plan,
            supervisor::commands::supervisor_apply_allocation_config,
            supervisor::commands::supervisor_rollback_allocation_config,
            supervisor::commands::supervisor_get_runtime_placement,
            supervisor::commands::supervisor_get_worker_config,
            supervisor::commands::supervisor_save_worker_config,
            supervisor::commands::supervisor_get_worker_status,
            supervisor::commands::supervisor_start_worker,
            supervisor::commands::supervisor_stop_worker,
            supervisor::commands::supervisor_get_worker_hardware,
            supervisor::commands::supervisor_check_firewall_status,
            supervisor::commands::supervisor_apply_firewall_rule,
            supervisor::commands::supervisor_revoke_remote_access,
            supervisor::commands::supervisor_get_worker_logs,
            supervisor::commands::models_get_library,
            supervisor::commands::models_get_catalog,
            supervisor::commands::models_start_download,
            supervisor::commands::models_cancel_download,
            supervisor::commands::models_clear_downloads,
            supervisor::commands::models_delete_model,
            supervisor::commands::models_select_model,
            supervisor::commands::models_rescan,
            supervisor::commands::models_set_directory,
            supervisor::commands::models_query_hf_repo,
            supervisor::commands::models_verify_model_checksum,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .targets([
                            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                        ])
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}


