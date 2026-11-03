use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use app_lib::supervisor::commands::types::{StartEngineOptions, SupervisorState};
use app_lib::supervisor::commands::lifecycle::{start_engine_internal, stop_engine_internal};
use app_lib::supervisor::models::library::ModelLibraryManager;
use app_lib::supervisor::{JobObject, Orchestrator, ProcessManager, WorkerModeManager};

fn main() {
    println!("============================================================");
    println!("    Swarm Live Model Selection & Inference Integration      ");
    println!("============================================================");

    let workspace_root = std::env::var("SWARM_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        });

    println!("[Step 1] Initializing ModelLibraryManager...");
    let lib_mgr = ModelLibraryManager::new(workspace_root.clone());
    let state = lib_mgr.get_state();

    println!("  Models directory: {}", state.models_directory.display());
    println!("  Discovered installed models: {}", state.installed_models.len());
    for m in &state.installed_models {
        println!("    - Model: {} ({} bytes, Path: {})", m.name, m.size_bytes, m.path.display());
    }

    assert!(!state.installed_models.is_empty(), "Expected at least 1 installed model");

    let target_model = state
        .installed_models
        .iter()
        .find(|m| m.filename.contains("qwen2.5-3b"))
        .or_else(|| state.installed_models.first())
        .expect("No model available to test");

    println!("[Step 2] Selecting model '{}' for live inference...", target_model.name);
    let selected = lib_mgr.select_model(&target_model.id).expect("select_model failed");
    println!("  Authoritative model selected: {}", selected.path.display());

    let env_model_path = std::env::var("SWARM_MODEL_PATH").expect("SWARM_MODEL_PATH must be set");
    assert_eq!(env_model_path, selected.path.to_string_lossy().to_string());
    println!("  Confirmed SWARM_MODEL_PATH environment variable updated correctly.");

    println!("[Step 3] Initializing Supervisor & Orchestrator with selected model...");
    let job = Arc::new(JobObject::new().expect("Failed to initialize Windows Job Object"));
    let manager = Arc::new(ProcessManager::new(Arc::clone(&job)));
    let orchestrator = Arc::new(Orchestrator::new(Arc::clone(&manager)));
    let worker_manager = Arc::new(WorkerModeManager::new(
        Arc::clone(&manager),
        workspace_root.clone(),
    ));

    let supervisor_state = SupervisorState::new(
        manager,
        orchestrator,
        worker_manager,
        workspace_root.clone(),
    );

    println!("[Step 4] Starting real inference engine (Profile: low_memory_cuda_standalone)...");
    let launch_options = StartEngineOptions {
        mode: Some("real".to_string()),
        profile: Some("low_memory_cuda_standalone".to_string()),
        simulate_failure: None,
        allow_real_runtime: Some(true),
    };

    let start_result = start_engine_internal(&supervisor_state, Some(launch_options));
    match start_result {
        Ok(res) => {
            println!("  Engine startup triggered successfully. Status: {:?}", res.status.state);
        }
        Err(e) => {
            panic!("Real engine startup failed: {}", e);
        }
    }

    println!("[Step 5] Awaiting /health endpoint readiness and model verification...");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    let start_time = Instant::now();
    let mut is_healthy = false;
    let mut verified_model_path = String::new();

    while start_time.elapsed() < Duration::from_secs(45) {
        if let Ok(resp) = client.get("http://127.0.0.1:8080/health").send() {
            if resp.status().is_success() {
                if let Ok(json) = resp.json::<serde_json::Value>() {
                    let status = json.get("status").and_then(|v| v.as_str()).unwrap_or("");
                    let model_loaded = json
                        .get("model")
                        .and_then(|m| m.get("loaded"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);

                    if status == "ok" && model_loaded {
                        is_healthy = true;
                        verified_model_path = json
                            .get("model")
                            .and_then(|m| m.get("path"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        break;
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(500));
    }

    assert!(is_healthy, "Engine did not reach healthy model state within 45 seconds");
    println!("  Coordinator is HEALTHY on port 8080!");
    println!("  Loaded model path reported by engine: {}", verified_model_path);
    assert!(
        verified_model_path.to_lowercase().contains("qwen2.5-3b"),
        "Loaded model does not match expected model"
    );

    println!("[Step 6] Submitting prompt to /v1/chat/completions...");
    let prompt_payload = serde_json::json!({
        "messages": [
            { "role": "user", "content": "Reply with exactly: MODEL_LIBRARY_VERIFIED_OK" }
        ],
        "max_tokens": 16,
        "temperature": 0.0
    });

    let inf_resp = client
        .post("http://127.0.0.1:8080/v1/chat/completions")
        .json(&prompt_payload)
        .send();

    match inf_resp {
        Ok(resp) => {
            println!("  HTTP Status: {}", resp.status());
            if let Ok(body) = resp.text() {
                println!("  Inference Response: {}", body.trim());
                assert!(body.contains("MODEL_LIBRARY_VERIFIED_OK") || body.contains("choices"),
                    "Inference response did not contain expected content");
            }
        }
        Err(e) => {
            panic!("Inference request failed: {}", e);
        }
    }

    println!("[Step 7] Stopping inference engine and verifying clean termination...");
    let stop_res = stop_engine_internal(&supervisor_state);
    match stop_res {
        Ok(st) => {
            println!("  Engine stopped. State: {:?}", st.state);
        }
        Err(e) => {
            println!("  Warning stopping engine: {}", e);
        }
    }

    // Give process 1 second to release ports
    thread::sleep(Duration::from_secs(1));

    // Verify port 8080 is released
    let port_free = app_lib::supervisor::config::is_loopback_port_available(8080);
    println!("  Port 8080 released and available: {}", port_free);
    assert!(port_free, "Port 8080 should be released after engine stop");

    println!("============================================================");
    println!(" SUCCESS: Complete live model selection and inference passed!");
    println!("============================================================");
}
