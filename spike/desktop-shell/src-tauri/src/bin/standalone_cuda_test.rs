use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use app_lib::supervisor::commands::{
    evaluate_standalone_resource_thresholds, run_preflight_check,
    start_engine_internal, stop_engine_internal, StartEngineOptions, SupervisorState,
};
use app_lib::supervisor::config::{CoordinatorConfig, is_loopback_port_available};
use app_lib::supervisor::job::JobObject;
use app_lib::supervisor::orchestrator::{ClusterLifecycleState, Orchestrator};
use app_lib::supervisor::process::ProcessManager;
use app_lib::supervisor::win32::{get_available_physical_memory, get_available_vram_mb};

fn query_http(port: u16, method: &str, path: &str, body_opt: Option<&str>, timeout: Duration) -> Result<(u16, String), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|e| format!("Connect error to {}:{}: {}", addr.ip(), port, e))?;
    
    stream.set_read_timeout(Some(timeout)).ok();
    stream.set_write_timeout(Some(timeout)).ok();

    let request_data = if let Some(body) = body_opt {
        format!(
            "{} {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            method, path, port, body.len(), body
        )
    } else {
        format!(
            "{} {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            method, path, port
        )
    };

    stream.write_all(request_data.as_bytes())
        .map_err(|e| format!("Write error: {}", e))?;

    let mut response_bytes = Vec::new();
    stream.read_to_end(&mut response_bytes)
        .map_err(|e| format!("Read error: {}", e))?;

    let response_str = String::from_utf8_lossy(&response_bytes).to_string();
    let status_code = response_str
        .lines()
        .next()
        .and_then(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                parts[1].parse::<u16>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);

    let body = response_str.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    Ok((status_code, body))
}

fn query_chat_completion_sse(
    port: u16,
    request_body: &str,
    timeout: Duration,
) -> Result<(String, u64, u64, Vec<String>), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|e| format!("Connect error to {}:{}: {}", addr.ip(), port, e))?;

    stream.set_read_timeout(Some(timeout)).ok();
    stream.set_write_timeout(Some(timeout)).ok();

    let request = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        port, request_body.len(), request_body
    );

    let t0 = Instant::now();
    stream.write_all(request.as_bytes())
        .map_err(|e| format!("Write error: {}", e))?;

    let mut time_to_first_content_ms: Option<u64> = None;
    let mut aggregated_content = String::new();
    let mut raw_chunks = Vec::new();
    let mut buffer = Vec::new();
    let mut chunk_buf = [0u8; 1024];

    loop {
        match stream.read(&mut chunk_buf) {
            Ok(0) => break,
            Ok(n) => {
                buffer.extend_from_slice(&chunk_buf[..n]);
                let text = String::from_utf8_lossy(&buffer).to_string();
                let lines: Vec<&str> = text.split('\n').collect();

                // Keep incomplete trailing line in buffer
                if let Some((_, rest)) = text.rsplit_once('\n') {
                    buffer = rest.as_bytes().to_vec();
                } else {
                    continue;
                }

                for line in lines.iter().take(lines.len().saturating_sub(1)) {
                    let trimmed = line.trim();
                    if trimmed.starts_with("data:") {
                        let payload = trimmed.trim_start_matches("data:").trim();
                        if payload == "[DONE]" {
                            continue;
                        }
                        raw_chunks.push(payload.to_string());
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) {
                            if let Some(delta) = v.get("choices")
                                .and_then(|c| c.get(0))
                                .and_then(|c0| c0.get("delta"))
                                .and_then(|d| d.get("content"))
                                .and_then(|s| s.as_str())
                            {
                                if time_to_first_content_ms.is_none() && !delta.is_empty() {
                                    time_to_first_content_ms = Some(t0.elapsed().as_millis() as u64);
                                }
                                aggregated_content.push_str(delta);
                            }
                        }
                    }
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                if t0.elapsed() >= timeout {
                    return Err(format!("Chat completion streaming timed out after {} s", timeout.as_secs()));
                }
            }
            Err(e) => return Err(format!("Stream read error: {}", e)),
        }
    }

    let total_duration_ms = t0.elapsed().as_millis() as u64;
    let ttfc = time_to_first_content_ms.unwrap_or(total_duration_ms);

    Ok((aggregated_content, ttfc, total_duration_ms, raw_chunks))
}

fn main() {
    let workspace_root = PathBuf::from(r"C:\Users\kunal\OneDrive\Desktop\swarm");
    let result_file = workspace_root.join(r"spike\desktop-shell\phase_c36_standalone_cuda_result.json");
    let start_timestamp = format!("{:?}", std::time::SystemTime::now());

    println!("============================================================");
    println!("SWARM PHASE C.3.6: STANDALONE CUDA REAL INFERENCE TEST");
    println!("Start Timestamp: {}", start_timestamp);
    println!("============================================================");

    // -------------------------------------------------------------
    // Step 1: Preflight Verification Immediately Before Launch
    // -------------------------------------------------------------
    println!("\n[1/6] Fresh Preflight Resource & Dependency Inspection...");

    let mem_pre = get_available_physical_memory();
    let avail_ram_mb = mem_pre.map(|(a, _)| a / (1024 * 1024));
    let total_ram_mb = mem_pre.map(|(_, t)| t / (1024 * 1024));

    let vram_pre = get_available_vram_mb();
    let avail_vram_mb = vram_pre.map(|(f, _)| f);
    let total_vram_mb = vram_pre.map(|(_, t)| t);

    println!("  -> Physical RAM: {:?} MB Available (Total: {:?} MB)", avail_ram_mb, total_ram_mb);
    println!("  -> GPU VRAM:     {:?} MiB Available (Total: {:?} MiB)", avail_vram_mb, total_vram_mb);

    let port_8080_free = is_loopback_port_available(8080);
    println!("  -> Port 8080 Free: {}", port_8080_free);

    let preflight_cfg = CoordinatorConfig {
        port: 8080,
        rpc_port: 0,
        gpu_layers: 37,
        threads: 2,
        model_path: String::new(),
        use_rpc: false,
    };
    let preflight = run_preflight_check(&workspace_root, preflight_cfg);
    println!("  -> Coordinator binary: {}", if preflight.coordinator_binary_found { "EXISTS" } else { "MISSING" });
    println!("  -> Official model:     {}", if preflight.model_found { "EXISTS" } else { "MISSING" });
    println!("  -> Preflight issues:   {:?}", preflight.issues);

    // Fail-closed threshold check
    let threshold_eval = evaluate_standalone_resource_thresholds(avail_ram_mb, avail_vram_mb);
    if let Err(e) = &threshold_eval {
        eprintln!("\n[BLOCKER] Preflight threshold check FAILED: {}", e);
        let blocked_res = serde_json::json!({
            "test_name": "Phase C.3.6 Standalone CUDA Real Inference Test",
            "start_timestamp": start_timestamp,
            "launch_attempted": false,
            "status": "BLOCKED",
            "reason": e,
            "preflight": {
                "available_ram_mb": avail_ram_mb,
                "total_ram_mb": total_ram_mb,
                "available_vram_mb": avail_vram_mb,
                "total_vram_mb": total_vram_mb,
                "port_8080_free": port_8080_free,
                "preflight_report": preflight
            }
        });
        std::fs::write(&result_file, serde_json::to_string_pretty(&blocked_res).unwrap()).ok();
        std::process::exit(2);
    }

    if !port_8080_free {
        eprintln!("\n[BLOCKER] Port 8080 is occupied. Launch aborted.");
        std::process::exit(2);
    }
    if !preflight.can_launch {
        eprintln!("\n[BLOCKER] Preflight dependencies missing: {:?}. Launch aborted.", preflight.issues);
        std::process::exit(2);
    }

    println!("  -> PREFLIGHT PASSED: RAM >= 1000 MB, VRAM >= 3100 MiB, port 8080 free, dependencies verified.");

    // -------------------------------------------------------------
    // Step 2: Launch Exact Staged Profile via Supervisor Containment
    // -------------------------------------------------------------
    println!("\n[2/6] Initializing Supervisor Job Object & Starting Standalone Coordinator...");
    let job = Arc::new(JobObject::new().expect("Failed to initialize Windows Job Object"));
    let manager = Arc::new(ProcessManager::new(Arc::clone(&job)));
    let orchestrator = Arc::new(Orchestrator::new(Arc::clone(&manager)));
    let worker_manager = Arc::new(app_lib::supervisor::WorkerModeManager::new(
        manager.clone(),
        workspace_root.clone(),
    ));
    let state = SupervisorState::new(
        manager.clone(),
        orchestrator.clone(),
        worker_manager,
        workspace_root.clone(),
    );

    let launch_options = StartEngineOptions {
        mode: Some("real".to_string()),
        profile: Some("low_memory_cuda_standalone".to_string()),
        allow_real_runtime: Some(true),
        simulate_failure: None,
    };

    let t_launch_start = Instant::now();
    let start_result = match start_engine_internal(&state, Some(launch_options)) {
        Ok(res) => {
            println!("  -> Supervisor Launch SUCCESS in {} ms", t_launch_start.elapsed().as_millis());
            println!("  -> Message: {}", res.message);
            res
        }
        Err(e) => {
            eprintln!("\n[LAUNCH FAILURE] Supervisor start_engine_internal failed: {}", e);
            let fail_res = serde_json::json!({
                "test_name": "Phase C.3.6 Standalone CUDA Real Inference Test",
                "start_timestamp": start_timestamp,
                "launch_attempted": true,
                "status": "LAUNCH_FAILED",
                "error": e,
                "preflight": {
                    "available_ram_mb": avail_ram_mb,
                    "available_vram_mb": avail_vram_mb,
                }
            });
            std::fs::write(&result_file, serde_json::to_string_pretty(&fail_res).unwrap()).ok();
            std::process::exit(3);
        }
    };
    let startup_duration_ms = t_launch_start.elapsed().as_millis() as u64;

    // Capture post-startup memory
    let mem_post_start = get_available_physical_memory();
    let vram_post_start = get_available_vram_mb();
    println!("  -> Memory Post-Startup: RAM avail = {:?} MB, VRAM avail = {:?} MiB",
        mem_post_start.map(|(a, _)| a / (1024 * 1024)),
        vram_post_start.map(|(f, _)| f)
    );

    // -------------------------------------------------------------
    // Step 3: Authoritative Health & Model Loading Verification
    // -------------------------------------------------------------
    println!("\n[3/6] Querying Authoritative /health Endpoint...");
    let (health_code, health_body) = match query_http(8080, "GET", "/health", None, Duration::from_secs(5)) {
        Ok(res) => res,
        Err(e) => {
            eprintln!("[ERROR] Failed to query /health: {}", e);
            (0, String::new())
        }
    };
    println!("  -> /health HTTP Status: {}", health_code);
    println!("  -> /health Body: {}", health_body);

    let health_json: serde_json::Value = serde_json::from_str(&health_body).unwrap_or(serde_json::Value::Null);
    let model_loaded = health_json.get("model").and_then(|m| m.get("loaded")).and_then(|v| v.as_bool()).unwrap_or(false);
    let inference_ready = health_json.get("inference").and_then(|i| i.get("ready")).and_then(|v| v.as_bool()).unwrap_or(false);

    if !model_loaded || !inference_ready {
        eprintln!("[ERROR] Model loading verification failed: model_loaded={}, inference_ready={}", model_loaded, inference_ready);
    } else {
        println!("  -> Model verified LOADED and inference READY in coordinator runtime.");
    }

    // -------------------------------------------------------------
    // Step 4: Execute Single Authorized Chat Completion Prompt
    // -------------------------------------------------------------
    println!("\n[4/6] Submitting Exactly One Authorized Chat Completion Prompt...");
    let prompt_payload = serde_json::json!({
        "messages": [
            {
                "role": "user",
                "content": "Reply with exactly: SWARM CUDA TEST OK"
            }
        ],
        "max_tokens": 30
    });
    let payload_str = prompt_payload.to_string();
    println!("  -> Payload: {}", payload_str);

    let inference_outcome = query_chat_completion_sse(8080, &payload_str, Duration::from_secs(60));

    // Capture memory immediately post-inference
    let mem_post_infer = get_available_physical_memory();
    let vram_post_infer = get_available_vram_mb();
    println!("  -> Memory Post-Inference: RAM avail = {:?} MB, VRAM avail = {:?} MiB",
        mem_post_infer.map(|(a, _)| a / (1024 * 1024)),
        vram_post_infer.map(|(f, _)| f)
    );

    // Query /metrics
    let (_, metrics_body) = query_http(8080, "GET", "/metrics", None, Duration::from_secs(5)).unwrap_or((0, String::new()));

    // -------------------------------------------------------------
    // Step 5: Clean Shutdown via Supervisor Lifecycle Management
    // -------------------------------------------------------------
    println!("\n[5/6] Clean Shutdown of Test Coordinator via Supervisor...");
    let t_stop_start = Instant::now();
    let stop_result = stop_engine_internal(&state);
    let stop_duration_ms = t_stop_start.elapsed().as_millis() as u64;
    println!("  -> stop_engine_internal result: {:?} (took {} ms)", stop_result, stop_duration_ms);

    // Verify process exit and port 8080 release
    let port_released = is_loopback_port_available(8080);
    let final_status = orchestrator.get_status();
    println!("  -> Port 8080 Released: {}", port_released);
    println!("  -> Final Cluster State: {:?}", final_status.state);

    // -------------------------------------------------------------
    // Step 6: Compile Full Report Artifact
    // -------------------------------------------------------------
    println!("\n[6/6] Compiling Test Results...");
    let (inference_success, generated_text, ttfc_ms, total_gen_ms, chunks) = match inference_outcome {
        Ok((text, ttfc, gen_dur, c)) => {
            println!("\n================ INFERENCE RESPONSE ================");
            println!("{}", text);
            println!("====================================================");
            println!("Time to first content: {} ms", ttfc);
            println!("Total generation duration: {} ms", gen_dur);
            println!("Total SSE chunks: {}", c.len());
            (true, text, ttfc, gen_dur, c)
        }
        Err(e) => {
            eprintln!("\n[INFERENCE ERROR] {}", e);
            (false, format!("ERROR: {}", e), 0, 0, vec![])
        }
    };

    let test_passed = model_loaded && inference_ready && inference_success && port_released && final_status.state == ClusterLifecycleState::Stopped;

    let final_report = serde_json::json!({
        "test_name": "Phase C.3.6 Standalone CUDA Real Inference Test",
        "start_timestamp": start_timestamp,
        "completion_timestamp": format!("{:?}", std::time::SystemTime::now()),
        "launch_attempted": true,
        "test_passed": test_passed,
        "profile": {
            "name": "low_memory_cuda_standalone",
            "effective_env": {
                "SWARM_USE_RPC": "0",
                "PORT": "8080",
                "SWARM_MODEL_PATH": workspace_root.join(r"models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf").to_string_lossy(),
                "SWARM_N_GPU_LAYERS": "-1",
                "SWARM_CTX_SIZE": "512",
                "SWARM_PLACEMENT_POLICY": "none",
                "SWARM_DEPLOYMENT_ENV": "development"
            }
        },
        "preflight_readings": {
            "available_physical_ram_mb": avail_ram_mb,
            "total_physical_ram_mb": total_ram_mb,
            "available_gpu_vram_mib": avail_vram_mb,
            "total_gpu_vram_mib": total_vram_mb,
            "port_8080_free": port_8080_free,
            "preflight_check": preflight
        },
        "startup_metrics": {
            "startup_duration_ms": startup_duration_ms,
            "coordinator_pid": start_result.status.coordinator_pid,
            "cluster_state": format!("{:?}", start_result.status.state),
            "ram_post_startup_mb": mem_post_start.map(|(a, _)| a / (1024 * 1024)),
            "vram_post_startup_mib": vram_post_start.map(|(f, _)| f),
        },
        "health_verification": {
            "http_status": health_code,
            "raw_body": health_body,
            "model_loaded": model_loaded,
            "inference_ready": inference_ready
        },
        "inference_metrics": {
            "prompt": "Reply with exactly: SWARM CUDA TEST OK",
            "success": inference_success,
            "response_text": generated_text,
            "time_to_first_content_ms": ttfc_ms,
            "generation_duration_ms": total_gen_ms,
            "chunk_count": chunks.len(),
            "raw_chunks": chunks,
            "ram_post_inference_mb": mem_post_infer.map(|(a, _)| a / (1024 * 1024)),
            "vram_post_inference_mib": vram_post_infer.map(|(f, _)| f),
            "coordinator_metrics": metrics_body
        },
        "shutdown_verification": {
            "stop_duration_ms": stop_duration_ms,
            "port_8080_released": port_released,
            "final_cluster_state": format!("{:?}", final_status.state),
            "managed_children_remaining": manager.managed_children.lock().unwrap().len()
        }
    });

    std::fs::write(&result_file, serde_json::to_string_pretty(&final_report).unwrap())
        .expect("Failed to write result json");

    println!("\nFull test result saved to: {}", result_file.display());
    println!("OVERALL TEST VERDICT: {}", if test_passed { "PASS" } else { "FAIL" });

    if !test_passed {
        std::process::exit(1);
    }
}
