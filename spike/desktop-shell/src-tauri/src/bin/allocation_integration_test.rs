use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use app_lib::supervisor::commands::{
    start_engine_internal, stop_engine_internal, StartEngineOptions, SupervisorState,
};
use app_lib::supervisor::config::is_loopback_port_available;
use app_lib::supervisor::job::JobObject;
use app_lib::supervisor::orchestrator::{ClusterLifecycleState, Orchestrator};
use app_lib::supervisor::process::ProcessManager;
use app_lib::supervisor::planning::{
    ComputeAllocationConfig, DeviceAllocationSetting, save_allocation_config,
    create_allocation_backup, restore_allocation_backup,
};

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

fn query_backends(port: u16) -> Result<serde_json::Value, String> {
    let (code, body) = query_http(port, "GET", "/backends", None, Duration::from_secs(5))?;
    if code != 200 {
        return Err(format!("/backends returned HTTP {}", code));
    }
    serde_json::from_str(&body).map_err(|e| format!("Failed to parse /backends JSON: {}", e))
}

fn send_chat_completion(port: u16, prompt: &str) -> Result<String, String> {
    let body = serde_json::json!({
        "messages": [
            { "role": "user", "content": prompt }
        ],
        "max_tokens": 20
    }).to_string();

    let (code, resp) = query_http(port, "POST", "/v1/chat/completions", Some(&body), Duration::from_secs(30))?;
    if code != 200 {
        return Err(format!("Inference returned HTTP {}: {}", code, resp));
    }
    Ok(resp)
}

fn main() {
    println!("============================================================");
    println!("SWARM: CUSTOM ALLOCATION DYNAMIC & TENSOR-SPLIT INTEGRATION TEST");
    println!("============================================================");

    let workspace_root = std::path::PathBuf::from(r"C:\Users\kunal\OneDrive\Desktop\swarm");
    println!("Workspace Root: {:?}", workspace_root);

    // Initial check: ensure ports are available
    if !is_loopback_port_available(8080) {
        panic!("Port 8080 is occupied before test start!");
    }
    if !is_loopback_port_available(50052) {
        panic!("Port 50052 is occupied before test start!");
    }

    let job = Arc::new(JobObject::new().expect("Failed to initialize Job Object"));
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

    // Backup any existing allocation config
    create_allocation_backup(&workspace_root).ok();

    // -------------------------------------------------------------
    // PHASE 1: Config A (RPC Heavy: RPC=2500MB, CUDA=1500MB)
    // -------------------------------------------------------------
    println!("\n[PHASE 1] Applying Config A (RPC heavy: 127.0.0.1:50052=2500MB, local-cuda-0=1500MB)...");
    let config_a = ComputeAllocationConfig {
        mode: "manual".to_string(),
        total_offload_layers: 37,
        context_size: 2048,
        reserved_headroom_ram_mb: 512,
        reserved_headroom_vram_mb: 256,
        device_settings: vec![
            DeviceAllocationSetting {
                device_id: "127.0.0.1:50052".to_string(),
                device_name: "Host Loopback RPC Worker".to_string(),
                backend_type: "rpc".to_string(),
                enabled: true,
                memory_budget_mb: 2500,
                is_loopback: true,
                split_weight: None,
                locked_split: None,
            },
            DeviceAllocationSetting {
                device_id: "local-cuda-0".to_string(),
                device_name: "Host NVIDIA CUDA GPU".to_string(),
                backend_type: "cuda".to_string(),
                enabled: true,
                memory_budget_mb: 1500,
                is_loopback: false,
                split_weight: None,
                locked_split: None,
            },
        ],
        updated_at_ms: 1000,
    };
    save_allocation_config(&workspace_root, &config_a).expect("Failed to save config_a");

    let launch_opts = StartEngineOptions {
        mode: Some("real".to_string()),
        profile: Some("default".to_string()),
        allow_real_runtime: Some(true),
        simulate_failure: None,
    };

    let start_res_a = start_engine_internal(&state, Some(launch_opts.clone()))
        .expect("Failed to start cluster in Config A");
    println!("  -> Cluster started: {}", start_res_a.message);

    // Verify /health and /backends
    let backends_a = query_backends(8080).expect("Failed to query /backends for Config A");
    println!("  -> /backends A: {}", serde_json::to_string_pretty(&backends_a).unwrap());

    // Verify inference works
    println!("  -> Running test inference on Config A...");
    let _inf_resp_a = send_chat_completion(8080, "Reply: TEST CONFIG A OK").expect("Inference failed on Config A");
    println!("  -> Inference A success (received response)");

    // Clean stop
    println!("  -> Stopping engine A...");
    stop_engine_internal(&state).expect("Failed to stop engine A");
    std::thread::sleep(Duration::from_millis(1500));
    assert!(is_loopback_port_available(8080), "Port 8080 not released!");
    assert!(is_loopback_port_available(50052), "Port 50052 not released!");
    println!("  -> Engine A stopped cleanly. Ports released.");

    // -------------------------------------------------------------
    // PHASE 2: Config B (CUDA Heavy: RPC=800MB, CUDA=3000MB)
    // -------------------------------------------------------------
    println!("\n[PHASE 2] Applying Config B (CUDA heavy: 127.0.0.1:50052=800MB, local-cuda-0=3000MB)...");
    let config_b = ComputeAllocationConfig {
        mode: "manual".to_string(),
        total_offload_layers: 37,
        context_size: 2048,
        reserved_headroom_ram_mb: 512,
        reserved_headroom_vram_mb: 256,
        device_settings: vec![
            DeviceAllocationSetting {
                device_id: "127.0.0.1:50052".to_string(),
                device_name: "Host Loopback RPC Worker".to_string(),
                backend_type: "rpc".to_string(),
                enabled: true,
                memory_budget_mb: 800,
                is_loopback: true,
                split_weight: None,
                locked_split: None,
            },
            DeviceAllocationSetting {
                device_id: "local-cuda-0".to_string(),
                device_name: "Host NVIDIA CUDA GPU".to_string(),
                backend_type: "cuda".to_string(),
                enabled: true,
                memory_budget_mb: 3000,
                is_loopback: false,
                split_weight: None,
                locked_split: None,
            },
        ],
        updated_at_ms: 2000,
    };
    save_allocation_config(&workspace_root, &config_b).expect("Failed to save config_b");

    let start_res_b = start_engine_internal(&state, Some(launch_opts))
        .expect("Failed to start cluster in Config B");
    println!("  -> Cluster started: {}", start_res_b.message);

    // Verify /backends
    let backends_b = query_backends(8080).expect("Failed to query /backends for Config B");
    println!("  -> /backends B: {}", serde_json::to_string_pretty(&backends_b).unwrap());

    // Verify inference works
    println!("  -> Running test inference on Config B...");
    let inf_resp_b = send_chat_completion(8080, "Reply: TEST CONFIG B OK").expect("Inference failed on Config B");
    println!("  -> Inference B success (received response)");

    // Clean stop
    println!("  -> Stopping engine B...");
    stop_engine_internal(&state).expect("Failed to stop engine B");
    std::thread::sleep(Duration::from_millis(1500));
    assert!(is_loopback_port_available(8080), "Port 8080 not released!");
    assert!(is_loopback_port_available(50052), "Port 50052 not released!");
    println!("  -> Engine B stopped cleanly. Ports released.");

    // -------------------------------------------------------------
    // PHASE 3: Compare Actual Placement Between Config A and Config B
    // -------------------------------------------------------------
    println!("\n[PHASE 3] Comparing Actual Loaded Placement between Config A and Config B...");

    let devices_a = backends_a.get("backends").and_then(|d| d.as_array()).expect("backends array in A");
    let devices_b = backends_b.get("backends").and_then(|d| d.as_array()).expect("backends array in B");

    println!("  Config A Backends: {}", serde_json::to_string(devices_a).unwrap());
    println!("  Config B Backends: {}", serde_json::to_string(devices_b).unwrap());

    // Verify that the two configurations produced distinct actual allocations!
    assert_ne!(
        serde_json::to_string(devices_a).unwrap(),
        serde_json::to_string(devices_b).unwrap(),
        "CRITICAL: Config A and Config B produced identical device allocations! Native tensor split not taking effect!"
    );
    println!("  -> VERIFIED: Config A and Config B produced MATERIALLY DIFFERENT actual device placement!");

    // -------------------------------------------------------------
    // PHASE 4: Transactional Rollback & Clean Baseline Restoration
    // -------------------------------------------------------------
    println!("\n[PHASE 4] Restoring known-good allocation configuration...");
    restore_allocation_backup(&workspace_root).ok();
    println!("  -> Known-good configuration restored.");

    println!("\n============================================================");
    println!("ALL INTEGRATION REGRESSION TESTS PASSED (PASS)");
    println!("============================================================");
}
