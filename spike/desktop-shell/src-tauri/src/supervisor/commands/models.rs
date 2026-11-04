use std::path::PathBuf;
use tauri::State;
use serde::{Deserialize, Serialize};

use super::types::SupervisorState;
use crate::supervisor::models::{
    CatalogModel, DownloadTask, HuggingFaceRepoInfo, InstalledModel, ModelLibraryState,
    query_huggingface_repo,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelSelectResult {
    pub success: bool,
    pub requires_restart: bool,
    pub message: String,
    pub model: Option<InstalledModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChecksumVerifyResult {
    pub success: bool,
    pub model_id: String,
    pub computed_sha256: String,
    pub matches_expected: Option<bool>,
    pub message: String,
}

#[tauri::command]
pub async fn models_get_library(
    state: State<'_, SupervisorState>,
) -> Result<ModelLibraryState, String> {
    let mut lib_state = state.model_library.get_state();
    lib_state.active_downloads = state.download_manager.get_all_tasks();
    
    // Check if any completed download tasks need to be registered. Rescan may
    // have already added the file without a digest, so compare digests rather
    // than only checking whether the path exists.
    let mut newly_registered = false;
    for task in &lib_state.active_downloads {
        if task.status != crate::supervisor::models::DownloadStatus::Completed {
            continue;
        }
        if !task.destination_path.exists() {
            continue;
        }
        let already_recorded = lib_state.installed_models.iter().any(|model| {
            if model.path != task.destination_path {
                return false;
            }
            match task.computed_sha256.as_deref() {
                Some(computed) => model
                    .sha256
                    .as_deref()
                    .map(|recorded| recorded.eq_ignore_ascii_case(computed))
                    .unwrap_or(false),
                None => true,
            }
        });
        if !already_recorded {
            let _ = state.model_library.register_file(
                &task.destination_path,
                task.repo_id.clone(),
                task.computed_sha256.clone(),
            );
            newly_registered = true;
        }
    }
    
    if newly_registered {
        lib_state.installed_models = state.model_library.get_installed_models();
    }
    Ok(lib_state)
}

#[tauri::command]
pub fn models_get_catalog() -> Vec<CatalogModel> {
    crate::supervisor::models::ModelLibraryManager::get_curated_catalog()
}

#[tauri::command]
pub fn models_start_download(
    state: State<'_, SupervisorState>,
    model_id: String,
    filename: String,
    source_url: String,
    repo_id: Option<String>,
    expected_sha256: Option<String>,
) -> Result<String, String> {
    let dest_dir = state.model_library.get_models_dir();
    state.download_manager.start_download(
        model_id,
        filename,
        source_url,
        repo_id,
        expected_sha256,
        Some(dest_dir),
    )
}

#[tauri::command]
pub fn models_cancel_download(
    state: State<'_, SupervisorState>,
    task_id: String,
) -> Result<(), String> {
    state.download_manager.cancel_download(&task_id)
}

#[tauri::command]
pub fn models_clear_downloads(
    state: State<'_, SupervisorState>,
) -> Result<(), String> {
    state.download_manager.clear_completed_tasks();
    Ok(())
}

fn is_coordinator_running(state: &SupervisorState) -> bool {
    let status = state.orchestrator.get_status();
    if status.state != crate::supervisor::orchestrator::ClusterLifecycleState::Ready {
        return false;
    }
    match status.coordinator_pid {
        Some(pid) => crate::supervisor::win32::is_pid_alive(pid),
        None => false,
    }
}

#[tauri::command]
pub async fn models_delete_model(
    state: State<'_, SupervisorState>,
    model_id: String,
) -> Result<(), String> {
    let is_running = is_coordinator_running(&state);
    state.model_library.delete_model(&model_id, is_running)
}

#[tauri::command]
pub async fn models_select_model(
    state: State<'_, SupervisorState>,
    model_id: String,
    restart_engine_if_running: Option<bool>,
) -> Result<ModelSelectResult, String> {
    let is_running = is_coordinator_running(&state);

    let do_restart = restart_engine_if_running.unwrap_or(false);

    if is_running && !do_restart {
        let lib_state = state.model_library.get_state();
        let target_model = lib_state.installed_models.iter().find(|m| m.id == model_id).cloned();
        return Ok(ModelSelectResult {
            success: false,
            requires_restart: true,
            message: "Inference engine is currently active with a loaded model. Switching models requires restarting the inference coordinator.".to_string(),
            model: target_model,
        });
    }

    let model = state.model_library.select_model(&model_id)?;

    // Synchronize allocation budgets to the newly selected model so stale manual configs
    // never cause an "Insufficient simulated capacity" shortfall.
    if let Some(mut alloc) = crate::supervisor::planning::load_allocation_config(&state.workspace_root) {
        let profile = crate::supervisor::planning::model_planning_profile_from_path(&model.path);
        let ctx = alloc.context_size;
        let bytes_per_layer = crate::supervisor::planning::estimate_bytes_per_layer_with_weights(
            ctx,
            profile.weights_bytes_per_layer,
        );
        let mb_per_layer = (bytes_per_layer as f64 / (1024.0 * 1024.0)).ceil() as u64;

        let total_active_weight: f32 = alloc.device_settings.iter()
            .filter(|s| s.enabled)
            .map(|s| s.split_weight.unwrap_or(0.0))
            .sum();

        if total_active_weight > 0.0 {
            for s in &mut alloc.device_settings {
                if s.enabled {
                    let weight = s.split_weight.unwrap_or(0.0);
                    let desired_layers = ((weight / total_active_weight) * profile.total_layers as f32).round() as u64;
                    s.memory_budget_mb = desired_layers * mb_per_layer + mb_per_layer;
                }
            }
            alloc.updated_at_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let _ = crate::supervisor::planning::save_allocation_config(&state.workspace_root, &alloc);
        }
    }

    if is_running && do_restart {
        println!("[Supervisor] Stopping active engine to switch to selected model: {}", model.name);
        let state_clone = state.inner().clone();
        let model_clone = model.clone();

        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let _ = crate::supervisor::commands::lifecycle::stop_engine_internal(&state_clone);

            // Bounded wait for coordinator port 8080 to be released by Windows TCP stack
            let port_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while std::time::Instant::now() < port_deadline {
                if crate::supervisor::config::is_loopback_port_available(8080) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(150));
            }

            println!("[Supervisor] Restarting engine with new model path: {}", model_clone.path.display());
            let active_profile = state_clone.orchestrator.get_status().active_profile;
            let launch_options = crate::supervisor::commands::types::StartEngineOptions {
                mode: Some("real".to_string()),
                profile: active_profile,
                allow_real_runtime: Some(true),
                simulate_failure: None,
            };
            crate::supervisor::commands::lifecycle::start_engine_internal(&state_clone, Some(launch_options))
                .map(|_| ())
                .map_err(|e| format!("Model '{}' was selected, but the engine failed to restart: {}", model_clone.name, e))
        })
        .await
        .map_err(|e| format!("Task join error during model restart: {}", e))??;
    }

    Ok(ModelSelectResult {
        success: true,
        requires_restart: false,
        message: format!("Model '{}' selected successfully", model.name),
        model: Some(model),
    })
}

#[tauri::command]
pub async fn models_rescan(
    state: State<'_, SupervisorState>,
) -> Result<ModelLibraryState, String> {
    state.model_library.rescan();
    state.model_library.persist();
    models_get_library(state).await
}

#[tauri::command]
pub async fn models_set_directory(
    state: State<'_, SupervisorState>,
    path: String,
) -> Result<ModelLibraryState, String> {
    let pb = PathBuf::from(path.trim());
    state.model_library.set_models_dir(pb.clone())?;
    state.download_manager.set_models_dir(pb);
    models_get_library(state).await
}

#[tauri::command]
pub async fn models_query_hf_repo(
    repo_id: String,
) -> Result<HuggingFaceRepoInfo, String> {
    Ok(query_huggingface_repo(&repo_id).await)
}

#[tauri::command]
pub async fn models_verify_model_checksum(
    state: State<'_, SupervisorState>,
    model_id: String,
) -> Result<ChecksumVerifyResult, String> {
    let model = {
        let lib = state.model_library.get_state();
        lib.installed_models.into_iter().find(|m| m.id == model_id)
            .ok_or_else(|| format!("Model '{}' not found", model_id))?
    };

    let p = model.path.clone();
    let computed_hash = tokio::task::spawn_blocking(move || {
        crate::supervisor::models::downloader::compute_file_sha256(&p)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Hash computation failed: {}", e))?;

    let matches = if let Some(ref exp) = model.sha256 {
        Some(computed_hash.eq_ignore_ascii_case(exp))
    } else {
        None
    };

    if matches == Some(false) {
        state.model_library.mark_verification_failed(&model.path);
    } else {
        let _ = state.model_library.register_file(&model.path, model.source_repo.clone(), Some(computed_hash.clone()));
    }

    let message = match matches {
        Some(true) => "Checksum verified successfully: matches expected digest.".to_string(),
        Some(false) => "WARNING: Checksum mismatch! The file digest differs from the expected value.".to_string(),
        None => format!("Calculated SHA-256 digest: {}", computed_hash),
    };

    Ok(ChecksumVerifyResult {
        success: matches != Some(false),
        model_id,
        computed_sha256: computed_hash,
        matches_expected: matches,
        message,
    })
}
