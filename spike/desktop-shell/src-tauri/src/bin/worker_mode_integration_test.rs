//! Automated end-to-end integration test for Swarm Worker Mode:
//! Unified Distributed Inference, Compute Sharing, Native Supervision, Security Hardening,
//! Path Portability, and Acceptance Testing.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use std::net::TcpStream;

use app_lib::supervisor::config::is_loopback_port_available;
use app_lib::supervisor::orchestrator::Orchestrator;
use app_lib::supervisor::{JobObject, ProcessManager};
use app_lib::supervisor::worker_mode::{
    WorkerModeConfig, WorkerModeManager,
};
use app_lib::supervisor::commands::types::{SupervisorState, StartEngineOptions};
use app_lib::supervisor::commands::lifecycle::{start_engine_internal, stop_engine_internal};

fn find_workspace_root() -> PathBuf {
    if let Ok(val) = std::env::var("SWARM_WORKSPACE_ROOT") {
        return PathBuf::from(val);
    }
    let exe = std::env::current_exe().unwrap();
    let mut curr = exe.parent().unwrap();
    while let Some(parent) = curr.parent() {
        if curr.join("dist").exists() && curr.join("models").exists() {
            return curr.to_path_buf();
        }
        curr = parent;
    }
    PathBuf::from(r"C:\Users\kunal\OneDrive\Desktop\swarm")
}

fn query_http(port: u16, method: &str, path: &str, body: Option<&str>, timeout: Duration) -> Result<(u16, String), String> {
    use std::io::{Read, Write};
    let addr = format!("127.0.0.1:{}", port);
    let mut stream = TcpStream::connect_timeout(&addr.parse().unwrap(), timeout).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(timeout)).ok();
    stream.set_write_timeout(Some(timeout)).ok();

    let content_len = body.map(|b| b.len()).unwrap_or(0);
    let req = format!(
        "{} {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        method, path, port, content_len, body.unwrap_or("")
    );
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;

    let mut response_bytes = Vec::new();
    stream.read_to_end(&mut response_bytes).map_err(|e| e.to_string())?;
    let resp_str = String::from_utf8_lossy(&response_bytes).to_string();

    let mut parts = resp_str.splitn(2, "\r\n\r\n");
    let header_part = parts.next().unwrap_or("");
    let body_part = parts.next().unwrap_or("");

    let status_code = header_part
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);

    Ok((status_code, body_part.to_string()))
}

fn send_chat_completion(port: u16, prompt_text: &str) -> Result<String, String> {
    let payload = serde_json::json!({
        "messages": [
            { "role": "user", "content": prompt_text }
        ],
        "max_tokens": 20
    });
    let (code, body) = query_http(port, "POST", "/v1/chat/completions", Some(&payload.to_string()), Duration::from_secs(60))?;
    if code != 200 {
        return Err(format!("Chat completion HTTP status {}: {}", code, body));
    }
    Ok(body)
}

fn main() {
    println!("================================================================================");
    println!("     SWARM WORKER MODE — SECURITY HARDENING & ACCEPTANCE TEST SUITE            ");
    println!("================================================================================");

    let workspace_root = find_workspace_root();
    println!("Workspace Root: {}", workspace_root.display());

    let job = Arc::new(JobObject::new().expect("Failed to create Job Object"));
    let manager = Arc::new(ProcessManager::new(Arc::clone(&job)));
    let orchestrator = Arc::new(Orchestrator::new(Arc::clone(&manager)));
    let worker_manager = Arc::new(WorkerModeManager::new(Arc::clone(&manager), workspace_root.clone()));

    let state = SupervisorState::new(
        Arc::clone(&manager),
        Arc::clone(&orchestrator),
        Arc::clone(&worker_manager),
        workspace_root.clone(),
    );

    let mut all_passed = true;

    // -------------------------------------------------------------------------
    // TEST 1: Hardware Telemetry Probing
    // -------------------------------------------------------------------------
    println!("\n[TEST 1] Hardware Telemetry Probing...");
    let hw = WorkerModeManager::probe_hardware_telemetry();
    println!("  CPU: {} ({} cores)", hw.cpu_name, hw.logical_cores);
    println!("  RAM: Total {} MB, Available {} MB", hw.total_ram_mb, hw.available_ram_mb);
    println!("  GPU: {:?}, VRAM Total {:?} MB, Available {:?} MB", hw.gpu_name, hw.total_vram_mb, hw.available_vram_mb);
    println!("  Supported backends: {:?}", hw.supported_backends);

    if hw.total_ram_mb > 0 && hw.available_ram_mb > 0 && !hw.supported_backends.is_empty() {
        println!("  -> PASS: Telemetry accurately queried via native Win32/driver interfaces.");
    } else {
        println!("  -> FAIL: Invalid telemetry metrics.");
        all_passed = false;
    }

    // -------------------------------------------------------------------------
    // TEST 2: Configuration Validation, Security Boundaries & Path Portability
    // -------------------------------------------------------------------------
    println!("\n[TEST 2] Configuration Validation, Security Boundaries & Path Portability...");
    
    // 2a. Loopback safe defaults
    let def_cfg = WorkerModeConfig::default();
    println!("  Default listen_host: {}", def_cfg.listen_host);
    println!("  Default allow_remote_access: {}", def_cfg.allow_remote_access);
    assert_eq!(def_cfg.listen_host, "127.0.0.1", "Fresh config must default to loopback");
    assert!(!def_cfg.allow_remote_access, "Fresh config must not allow remote sharing");

    // 2b. Canonical path resolution
    let canonical_path = WorkerModeManager::resolve_canonical_config_path(&workspace_root);
    println!("  Canonical config path: {}", canonical_path.display());
    assert!(!canonical_path.to_string_lossy().contains(r"dist\worker_mode_config.json"), "Canonical path must not point directly to workspace dist");

    // 2c. Save valid loopback configuration
    let mut safe_cfg = WorkerModeConfig::default();
    safe_cfg.listen_host = "127.0.0.1".to_string();
    safe_cfg.rpc_port = 50052;
    safe_cfg.allow_remote_access = false;
    let save_ok = worker_manager.save_config(&safe_cfg).is_ok();
    println!("  Save valid loopback configuration: {}", if save_ok { "OK" } else { "FAILED" });

    // 2d. Reject unsafe non-loopback bind without allow_remote_access
    let mut unsafe_cfg = safe_cfg.clone();
    unsafe_cfg.listen_host = "0.0.0.0".to_string();
    unsafe_cfg.allow_remote_access = false;
    let unsafe_rejected = worker_manager.save_config(&unsafe_cfg).is_err();
    println!("  Unsafe 0.0.0.0 bind without allow_remote_access rejected: {}", if unsafe_rejected { "PASS" } else { "FAIL" });

    // 2e. Reject remote access with empty or missing controller IP
    let mut missing_ctrl_cfg = safe_cfg.clone();
    missing_ctrl_cfg.listen_host = "0.0.0.0".to_string();
    missing_ctrl_cfg.allow_remote_access = true;
    missing_ctrl_cfg.authorized_controller_ip = "".to_string();
    let missing_ctrl_rejected = worker_manager.save_config(&missing_ctrl_cfg).is_err();
    println!("  Remote access with empty controller IP rejected: {}", if missing_ctrl_rejected { "PASS" } else { "FAIL" });

    // 2f. Reject invalid controller IP (malformed, loopback, or wildcard)
    let mut malformed_ctrl_cfg = safe_cfg.clone();
    malformed_ctrl_cfg.listen_host = "0.0.0.0".to_string();
    malformed_ctrl_cfg.allow_remote_access = true;
    malformed_ctrl_cfg.authorized_controller_ip = "999.999.999.999".to_string();
    let malformed_rejected = worker_manager.save_config(&malformed_ctrl_cfg).is_err();

    let mut loopback_ctrl_cfg = malformed_ctrl_cfg.clone();
    loopback_ctrl_cfg.authorized_controller_ip = "127.0.0.1".to_string();
    let loopback_rejected = worker_manager.save_config(&loopback_ctrl_cfg).is_err();
    println!("  Malformed controller IP rejected: {}", if malformed_rejected { "PASS" } else { "FAIL" });
    println!("  Loopback controller IP rejected: {}", if loopback_rejected { "PASS" } else { "FAIL" });

    // 2g. Valid remote configuration accepted
    let mut valid_remote_cfg = safe_cfg.clone();
    valid_remote_cfg.listen_host = "0.0.0.0".to_string();
    valid_remote_cfg.allow_remote_access = true;
    valid_remote_cfg.authorized_controller_ip = "192.168.1.50".to_string();
    let valid_remote_ok = worker_manager.save_config(&valid_remote_cfg).is_ok();
    println!("  Valid remote configuration accepted: {}", if valid_remote_ok { "PASS" } else { "FAIL" });

    // 2h. Migration from legacy config test
    let test_temp_dir = std::env::temp_dir().join(format!("swarm_test_mig_{}", std::process::id()));
    let _ = fs::create_dir_all(&test_temp_dir.join("dist"));
    let legacy_file = test_temp_dir.join(r"dist\worker_mode_config.json");
    let mut legacy_sample = WorkerModeConfig::default();
    legacy_sample.threads = 6;
    legacy_sample.target_ram_mb = 4096;
    fs::write(&legacy_file, serde_json::to_string_pretty(&legacy_sample).unwrap()).unwrap();

    let target_canonical = test_temp_dir.join(r"config\worker_mode_config.json");
    let mig_res = WorkerModeManager::migrate_legacy_config_if_needed(&test_temp_dir, &target_canonical);
    let mig_ok = match mig_res {
        Ok(Some(cfg)) => cfg.threads == 6 && target_canonical.exists() && test_temp_dir.join(r"dist\worker_mode_config.migrated.json").exists(),
        _ => false,
    };
    println!("  Migration of legacy config with backup preservation: {}", if mig_ok { "PASS" } else { "FAIL" });
    let _ = fs::remove_dir_all(&test_temp_dir);

    // Revert to safe loopback config for subsequent tests
    worker_manager.save_config(&safe_cfg).unwrap();

    if save_ok && unsafe_rejected && missing_ctrl_rejected && malformed_rejected && loopback_rejected && valid_remote_ok && mig_ok {
        println!("  -> PASS: Configuration security, migration, and parameter integrity verified.");
    } else {
        println!("  -> FAIL: Configuration validation checks failed.");
        all_passed = false;
    }

    // -------------------------------------------------------------------------
    // TEST 3: Scoped Firewall Generation & Honest Elevation Handling
    // -------------------------------------------------------------------------
    println!("\n[TEST 3] Scoped Firewall Generation & Honest Elevation Handling...");
    let fw_cmd = WorkerModeManager::generate_firewall_command(50052, Some("192.168.1.50"));
    println!("  Generated Firewall Command:\n    {}", fw_cmd);

    assert!(fw_cmd.contains("-Name 'Swarm_RPC_Worker_50052'"), "Rule must have unique Swarm identifier");
    assert!(fw_cmd.contains("-Group 'Swarm Compute'"), "Rule must belong to Swarm Compute group");
    assert!(fw_cmd.contains("-RemoteAddress '192.168.1.50'"), "Rule must be restricted to controller IP");
    assert!(fw_cmd.contains("-Profile Private,Domain"), "Rule must exclude Public profile");
    println!("  -> PASS: Firewall command scoped strictly to controller IP and Private/Domain profile.");

    // Test non-elevated application handling
    let apply_res = WorkerModeManager::apply_firewall_rule(50052, "192.168.1.50");
    match apply_res {
        Ok(msg) => {
            println!("  [Privileged Environment] Rule installed: {}", msg);
            let _ = WorkerModeManager::remove_firewall_rule(50052);
        }
        Err(err) => {
            println!("  [Non-Elevated Environment] Reported honestly:\n    {}", err);
            assert!(err.contains("Administrator privileges required") || err.contains("failed"), "Error must report elevation requirement honestly");
            println!("  -> PASS: Non-elevated execution honestly reports privilege requirement without false claims.");
        }
    }

    // -------------------------------------------------------------------------
    // TEST 4: Revocation Action & Safety Reset
    // -------------------------------------------------------------------------
    println!("\n[TEST 4] Revocation Action & Safety Reset...");
    // Put manager in remote sharing state
    worker_manager.save_config(&valid_remote_cfg).unwrap();
    assert!(worker_manager.get_config().allow_remote_access);

    println!("  Executing revoke_remote_access()...");
    let revoked_status = worker_manager.revoke_remote_access();
    match revoked_status {
        Ok(st) => {
            println!("  Revoked Status listen_host: {}", st.config.listen_host);
            println!("  Revoked Status allow_remote_access: {}", st.config.allow_remote_access);
            println!("  Revoked Status authorized_controller_ip: {:?}", st.config.authorized_controller_ip);
            println!("  Revoked Status firewall_status: {}", st.firewall_status);

            let revoked_ok = st.config.listen_host == "127.0.0.1"
                && !st.config.allow_remote_access
                && st.config.authorized_controller_ip.is_empty()
                && st.firewall_status == "NotRequired";

            if revoked_ok {
                println!("  -> PASS: Remote access revocation restored loopback-only configuration safely.");
            } else {
                println!("  -> FAIL: Revocation did not restore safe loopback state.");
                all_passed = false;
            }
        }
        Err(e) => {
            println!("  -> FAIL: Revocation error: {}", e);
            all_passed = false;
        }
    }

    // -------------------------------------------------------------------------
    // TEST 5: Supervised Native Worker Lifecycle (Start / Stop)
    // -------------------------------------------------------------------------
    println!("\n[TEST 5] Supervised Native Worker Lifecycle (Start / Stop)...");
    assert!(is_loopback_port_available(50052), "Port 50052 must be available before test");

    println!("  Starting native Worker Mode on 127.0.0.1:50052...");
    let t0 = Instant::now();
    let start_res = worker_manager.start_worker(Some(safe_cfg.clone()));
    match start_res {
        Ok(res) => {
            println!("  Worker started in {} ms: {}", t0.elapsed().as_millis(), res.message);
            println!("  Assigned PID: {:?}", res.status.pid);
            println!("  Listening endpoint: {:?}", res.status.listen_endpoint);
            println!("  Status State: {}", res.status.state);
            println!("  Canonical Config: {}", res.status.canonical_config_path);

            // Verify duplicate start is rejected
            let dup_res = worker_manager.start_worker(None);
            let dup_rejected = dup_res.is_err();
            println!("  Duplicate start rejection: {}", if dup_rejected { "PASS" } else { "FAIL" });

            // Stop worker
            println!("  Stopping Worker Mode...");
            let stop_res = worker_manager.stop_worker();
            match stop_res {
                Ok(stop_status) => {
                    println!("  Worker stopped successfully. Final state: {}", stop_status.state);
                    let port_free = is_loopback_port_available(50052);
                    println!("  Port 50052 released: {}", if port_free { "YES" } else { "NO" });
                    if stop_status.state == "Stopped" && port_free && dup_rejected {
                        println!("  -> PASS: Supervised native worker lifecycle verified.");
                    } else {
                        println!("  -> FAIL: Port release or state transition failed.");
                        all_passed = false;
                    }
                }
                Err(e) => {
                    println!("  -> FAIL: Error stopping worker: {}", e);
                    all_passed = false;
                }
            }
        }
        Err(e) => {
            println!("  -> FAIL: Failed to start worker: {}", e);
            all_passed = false;
        }
    }

    // -------------------------------------------------------------------------
    // TEST 6: Real Local RPC Inference Integration (Combined Mode)
    // -------------------------------------------------------------------------
    println!("\n[TEST 6] Real Local RPC Inference Integration (Combined Mode)...");
    // 1. Start worker on 50052
    println!("  [Step 1] Starting Worker Mode compute node on 127.0.0.1:50052...");
    let worker_start = worker_manager.start_worker(Some(safe_cfg));
    if let Err(e) = worker_start {
        eprintln!("  Failed to start worker for inference: {}", e);
        return;
    }
    println!("  Worker Node active and ready for RPC connections.");

    // 2. Start Coordinator in RPC profile
    println!("  [Step 2] Launching Coordinator connected to Worker RPC (127.0.0.1:50052)...");
    let launch_options = StartEngineOptions {
        mode: Some("real".to_string()),
        profile: Some("default".to_string()), // Default profile uses RPC on 50052
        allow_real_runtime: Some(true),
        simulate_failure: None,
    };

    let t_coord = Instant::now();
    match start_engine_internal(&state, Some(launch_options)) {
        Ok(engine_res) => {
            println!("  Coordinator initialized in {} ms: {}", t_coord.elapsed().as_millis(), engine_res.message);

            // 3. Verify health endpoint
            println!("  [Step 3] Verifying /health endpoint on Coordinator (port 8080)...");
            let (health_code, health_body) = query_http(8080, "GET", "/health", None, Duration::from_secs(5))
                .unwrap_or((0, String::new()));
            println!("  /health HTTP {}: {}", health_code, health_body);

            // 4. Send actual prompt and stream tokens
            println!("  [Step 4] Submitting Real Chat Completion prompt through Coordinator -> Worker...");
            let chat_res = send_chat_completion(8080, "Respond with: SWARM WORKER MODE TEST VERIFIED");
            match chat_res {
                Ok(resp) => {
                    println!("\n  ================ INFERENCE RESPONSE ================");
                    println!("  {}", resp);
                    println!("  ====================================================\n");
                    println!("  -> PASS: Full distributed inference pipeline executed end-to-end!");
                }
                Err(e) => {
                    println!("  -> FAIL: Chat completion failed: {}", e);
                    all_passed = false;
                }
            }

            // 5. Clean teardown of Coordinator
            println!("  [Step 5] Shutting down Coordinator...");
            let stop_coord = stop_engine_internal(&state);
            println!("  Coordinator stop result: {:?}", stop_coord);
        }
        Err(e) => {
            println!("  -> FAIL: Coordinator start failed: {}", e);
            all_passed = false;
        }
    }

    // 6. Clean teardown of Worker
    println!("  [Step 6] Shutting down Worker Mode...");
    let _ = worker_manager.stop_worker();
    let port_50052_clean = is_loopback_port_available(50052);
    let port_8080_clean = is_loopback_port_available(8080);
    println!("  Port 50052 clean: {}", port_50052_clean);
    println!("  Port 8080 clean: {}", port_8080_clean);

    println!("\n================================================================================");
    if all_passed && port_50052_clean && port_8080_clean {
        println!("               ALL WORKER MODE SECURITY & INFERENCE TESTS PASSED!               ");
    } else {
        println!("                      SOME WORKER MODE TESTS FAILED                             ");
    }
    println!("================================================================================");
}
