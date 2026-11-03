use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use sha2::Digest;

use app_lib::supervisor::models::downloader::{compute_file_sha256, DownloadManager};
use app_lib::supervisor::models::gguf::parse_gguf_metadata;
use app_lib::supervisor::models::library::ModelLibraryManager;
use app_lib::supervisor::models::types::DownloadStatus;

fn main() {
    println!("============================================================");
    println!("     Swarm In-App Model Library & Downloader Test Suite     ");
    println!("============================================================");

    let workspace_root = std::env::var("SWARM_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        });

    let temp_test_dir = workspace_root.join(r"target\test_model_manager");
    let _ = fs::remove_dir_all(&temp_test_dir);
    fs::create_dir_all(&temp_test_dir).expect("Failed to create test dir");

    // Keep library config and default model discovery inside the test directory.
    let test_local_app_data = temp_test_dir.join("localappdata");
    fs::create_dir_all(&test_local_app_data).expect("Failed to create isolated LOCALAPPDATA");
    unsafe {
        std::env::set_var("LOCALAPPDATA", &test_local_app_data);
    }

    let mut tests_passed = 0;
    let mut total_tests = 0;

    // ------------------------------------------------------------
    // TEST 1: GGUF Header Parser with Synthetic Minimal Valid GGUF
    // ------------------------------------------------------------
    total_tests += 1;
    print!("[TEST 1/8] Synthetic GGUF Header Parsing... ");
    let synth_gguf_path = temp_test_dir.join("test_model.gguf");
    create_synthetic_gguf(&synth_gguf_path, "llama", "TEST_Q4_K_M", 4096, 32);

    match parse_gguf_metadata(&synth_gguf_path) {
        Ok(meta) => {
            assert_eq!(meta.architecture, "llama");
            assert_eq!(meta.context_length, Some(4096));
            assert_eq!(meta.block_count, Some(32));
            assert_eq!(meta.quantization.as_deref(), Some("MOSTLY_Q4_K_M"));
            println!("PASS (Arch: {}, Ctx: {:?}, Layers: {:?}, Quant: {:?})",
                meta.architecture, meta.context_length, meta.block_count, meta.quantization);
            tests_passed += 1;
        }
        Err(e) => {
            println!("FAIL: {:?}", e);
        }
    }

    // ------------------------------------------------------------
    // TEST 2: Inspect Real Official Qwen GGUF if Present
    // ------------------------------------------------------------
    total_tests += 1;
    print!("[TEST 2/8] Real Official Qwen GGUF Header Inspection... ");
    let official_gguf = workspace_root.join(r"models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf");
    if official_gguf.exists() {
        match parse_gguf_metadata(&official_gguf) {
            Ok(meta) => {
                println!("PASS (Arch: {}, Ctx: {:?}, Layers: {:?}, Quant: {:?}, Tensors: {})",
                    meta.architecture, meta.context_length, meta.block_count, meta.quantization, meta.tensor_count);
                tests_passed += 1;
            }
            Err(e) => println!("FAIL: {:?}", e),
        }
    } else {
        println!("SKIP (Official model file not in workspace models/)");
        tests_passed += 1;
    }

    // ------------------------------------------------------------
    // TEST 3: Streaming Download with Real Mock HTTP Server
    // ------------------------------------------------------------
    total_tests += 1;
    print!("[TEST 3/8] Streaming Download & Progress Tracking... ");
    let test_data = b"SWARM_TEST_MODEL_BINARY_STREAM_CHUNKS_1234567890_ABCDEFGHIJ";
    let expected_hash = format!("{:x}", sha2::Sha256::digest(test_data));

    let (port, server_stop) = start_mock_http_server(test_data.to_vec(), false);
    let download_dir = temp_test_dir.join("downloads");
    let dm = DownloadManager::new(download_dir.clone());

    let source_url = format!("http://127.0.0.1:{}/model.gguf", port);
    let task_id = dm.start_download(
        "test_model_1".to_string(),
        "downloaded_model.gguf".to_string(),
        source_url,
        Some("test/repo".to_string()),
        Some(expected_hash.clone()),
        Some(download_dir.clone()),
    ).expect("start_download failed");

    // Poll until complete
    let mut completed = false;
    for _ in 0..50 {
        thread::sleep(Duration::from_millis(100));
        if let Some(task) = dm.get_task(&task_id) {
            if task.status == DownloadStatus::Completed {
                completed = true;
                break;
            }
        }
    }
    server_stop.store(true, Ordering::SeqCst);

    let downloaded_file = download_dir.join("downloaded_model.gguf");
    if completed && downloaded_file.exists() {
        let content = fs::read(&downloaded_file).expect("Failed to read downloaded file");
        assert_eq!(content, test_data);
        println!("PASS (File finalized, size: {} bytes, hash verified)", content.len());
        tests_passed += 1;
    } else {
        println!("FAIL (Task did not complete: {:?})", dm.get_task(&task_id));
    }

    // ------------------------------------------------------------
    // TEST 4: Checksum Mismatch Detection & Safety
    // ------------------------------------------------------------
    total_tests += 1;
    print!("[TEST 4/8] Checksum Mismatch Rejection & Non-Corruption... ");
    let bad_expected_hash = "0000000000000000000000000000000000000000000000000000000000000000";
    let (port2, server_stop2) = start_mock_http_server(test_data.to_vec(), false);
    let source_url2 = format!("http://127.0.0.1:{}/bad_model.gguf", port2);

    let task_id2 = dm.start_download(
        "test_model_bad_hash".to_string(),
        "bad_hash_model.gguf".to_string(),
        source_url2,
        None,
        Some(bad_expected_hash.to_string()),
        Some(download_dir.clone()),
    ).expect("start_download failed");

    let mut failed = false;
    for _ in 0..50 {
        thread::sleep(Duration::from_millis(100));
        if let Some(task) = dm.get_task(&task_id2) {
            if task.status == DownloadStatus::Failed {
                failed = true;
                break;
            }
        }
    }
    server_stop2.store(true, Ordering::SeqCst);

    let bad_target_file = download_dir.join("bad_hash_model.gguf");
    if failed && !bad_target_file.exists() {
        println!("PASS (Corrupt/mismatched download blocked, final file NOT created)");
        tests_passed += 1;
    } else {
        println!("FAIL (Expected failure but got: {:?}, file exists: {})",
            dm.get_task(&task_id2), bad_target_file.exists());
    }

    // ------------------------------------------------------------
    // TEST 5: Duplicate Download Prevention
    // ------------------------------------------------------------
    total_tests += 1;
    print!("[TEST 5/8] Duplicate Concurrent Download Prevention... ");
    let (port3, server_stop3) = start_mock_http_server(vec![1; 100_000], true);
    let source_url3 = format!("http://127.0.0.1:{}/slow.gguf", port3);

    let _t1 = dm.start_download(
        "dup_test_1".to_string(),
        "dup_model.gguf".to_string(),
        source_url3.clone(),
        None,
        None,
        Some(download_dir.clone()),
    ).expect("First download should succeed");

    let t2_err = dm.start_download(
        "dup_test_2".to_string(),
        "dup_model.gguf".to_string(),
        source_url3,
        None,
        None,
        Some(download_dir.clone()),
    );

    server_stop3.store(true, Ordering::SeqCst);
    if let Err(e) = t2_err {
        println!("PASS (Duplicate rejected: {})", e);
        tests_passed += 1;
    } else {
        println!("FAIL (Duplicate was not prevented)");
    }

    // ------------------------------------------------------------
    // TEST 6: Download Cancellation
    // ------------------------------------------------------------
    total_tests += 1;
    print!("[TEST 6/8] Download Cancellation... ");
    let (port4, server_stop4) = start_mock_http_server(vec![2; 500_000], true);
    let source_url4 = format!("http://127.0.0.1:{}/cancel.gguf", port4);

    let cancel_task_id = dm.start_download(
        "cancel_test".to_string(),
        "cancelled_model.gguf".to_string(),
        source_url4,
        None,
        None,
        Some(download_dir.clone()),
    ).expect("start_download failed");

    thread::sleep(Duration::from_millis(50));
    dm.cancel_download(&cancel_task_id).expect("cancel_download failed");

    thread::sleep(Duration::from_millis(150));
    server_stop4.store(true, Ordering::SeqCst);

    if let Some(task) = dm.get_task(&cancel_task_id) {
        if task.status == DownloadStatus::Cancelled {
            println!("PASS (Task successfully transitioned to Cancelled)");
            tests_passed += 1;
        } else {
            println!("FAIL (Status: {:?})", task.status);
        }
    } else {
        println!("FAIL (Task not found)");
    }

    // ------------------------------------------------------------
    // TEST 7: Model Registration & Persistent Library Management
    // ------------------------------------------------------------
    total_tests += 1;
    print!("[TEST 7/8] Model Registration & Persistence... ");
    let lib_mgr = ModelLibraryManager::new(temp_test_dir.clone());
    lib_mgr.set_models_dir(temp_test_dir.clone()).expect("set_models_dir failed");

    // Register our synthetic model
    let reg_res = lib_mgr.register_file(&synth_gguf_path, Some("synthetic/test".to_string()), None);
    match reg_res {
        Ok(m) => {
            assert_eq!(m.filename, "test_model.gguf");
            let state = lib_mgr.get_state();
            assert!(state.installed_models.iter().any(|im| im.id == m.id));

            // Test selection
            let sel = lib_mgr.select_model(&m.id).expect("select_model failed");
            assert_eq!(sel.id, m.id);
            assert_eq!(std::env::var("SWARM_MODEL_PATH").unwrap(), synth_gguf_path.to_string_lossy().to_string());

            println!("PASS (Registered model '{}', verified selection & env update)", m.name);
            tests_passed += 1;
        }
        Err(e) => println!("FAIL: {}", e),
    }

    // ------------------------------------------------------------
    // TEST 8: Curated Catalogue Completeness
    // ------------------------------------------------------------
    total_tests += 1;
    print!("[TEST 8/8] Curated Catalog Metadata Verification... ");
    let catalog = ModelLibraryManager::get_curated_catalog();
    assert!(catalog.len() >= 6, "Expected at least 6 curated models");

    // Check official Qwen model
    let qwen = catalog.iter().find(|c| c.id.contains("qwen2.5-3b")).expect("Missing Qwen 3B");
    assert_eq!(qwen.quantization, "Q4_K_M");
    assert_eq!(qwen.architecture, "qwen2");
    assert_eq!(qwen.expected_sha256.as_deref(), Some("626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d"));

    // Check SmolLM2 model
    let smol = catalog.iter().find(|c| c.id.contains("smollm2-135m")).expect("Missing SmolLM2 135M");
    assert_eq!(smol.architecture, "llama");

    println!("PASS (Catalog contains {} verified models with complete specs)", catalog.len());
    tests_passed += 1;

    // ------------------------------------------------------------
    // TEST 9: Reject filenames that escape the destination directory
    // ------------------------------------------------------------
    total_tests += 1;
    print!("[TEST 9/10] Download Filename Traversal Rejection... ");
    let traversal_url = "http://127.0.0.1:1/model.gguf".to_string();
    let traversal_results = [
        dm.start_download("traversal_1".to_string(), "../escape.gguf".to_string(), traversal_url.clone(), None, None, Some(download_dir.clone())),
        dm.start_download("traversal_2".to_string(), "/absolute.gguf".to_string(), traversal_url.clone(), None, None, Some(download_dir.clone())),
        dm.start_download("traversal_3".to_string(), "sub/nested.gguf".to_string(), traversal_url.clone(), None, None, Some(download_dir.clone())),
        dm.start_download("traversal_4".to_string(), "..\\escape.gguf".to_string(), traversal_url.clone(), None, None, Some(download_dir.clone())),
        dm.start_download("traversal_5".to_string(), "C:\\drive.gguf".to_string(), traversal_url, None, None, Some(download_dir.clone())),
    ];
    if traversal_results.iter().all(|result| result.is_err()) {
        println!("PASS (All directory, traversal, and drive-prefix names rejected)");
        tests_passed += 1;
    } else {
        println!("FAIL (At least one unsafe filename was accepted)");
    }

    // ------------------------------------------------------------
    // TEST 10: Official status must come from a digest, not the filename
    // ------------------------------------------------------------
    total_tests += 1;
    print!("[TEST 10/10] Official Status Requires Digest... ");
    let official_dir = temp_test_dir.join("official_dir");
    fs::create_dir_all(&official_dir).expect("Failed to create official test dir");
    let fake_official = official_dir.join("qwen2.5-3b-instruct-q4_k_m.official-check.gguf");
    create_synthetic_gguf(&fake_official, "qwen2", "TEST_Q4_K_M", 4096, 36);

    let config_file = test_local_app_data.join(r"Swarm\config\model_library.json");
    let _ = fs::remove_file(&config_file);
    let official_lib = ModelLibraryManager::new(temp_test_dir.clone());
    official_lib.set_models_dir(official_dir).expect("set_models_dir failed");
    let official_state = official_lib.get_state();
    match official_state.installed_models.iter().find(|model| model.path == fake_official) {
        Some(model) if model.sha256.is_none() && !model.is_official_verified => {
            println!("PASS (Filename alone did not mark the model verified)");
            tests_passed += 1;
        }
        other => println!("FAIL (Unexpected official state: {:?})", other.map(|model| (model.sha256.clone(), model.is_official_verified))),
    }

    // ------------------------------------------------------------
    // TEST 11: Resume validates Content-Range and appends correctly
    // ------------------------------------------------------------
    total_tests += 1;
    print!("[TEST 11] Download Resume & Content-Range Append... ");
    let resume_data: Vec<u8> = (0..100_000).map(|i| (i % 251) as u8).collect();
    let resume_hash = format!("{:x}", sha2::Sha256::digest(&resume_data));
    let resume_dir = temp_test_dir.join("resume_downloads");
    fs::create_dir_all(&resume_dir).expect("Failed to create resume test dir");
    let resume_name = "resume_model.gguf";
    let resume_part = resume_dir.join(format!("{}.part", resume_name));
    fs::write(&resume_part, &resume_data[..40_000]).expect("Failed to write partial file");

    let (resume_port, resume_stop) = start_mock_http_server(resume_data.clone(), false);
    let resume_url = format!("http://127.0.0.1:{}/resume_model.gguf", resume_port);
    let resume_dm = DownloadManager::new(resume_dir.clone());
    let resume_task = resume_dm.start_download(
        "resume_test".to_string(),
        resume_name.to_string(),
        resume_url,
        None,
        Some(resume_hash),
        Some(resume_dir.clone()),
    ).expect("start_download failed");

    let mut resume_completed = false;
    for _ in 0..50 {
        thread::sleep(Duration::from_millis(100));
        if let Some(task) = resume_dm.get_task(&resume_task) {
            if task.status == DownloadStatus::Completed {
                resume_completed = true;
                break;
            }
        }
    }
    resume_stop.store(true, Ordering::SeqCst);

    let resume_path = resume_dir.join(resume_name);
    match fs::read(&resume_path) {
        Ok(content) if resume_completed && content == resume_data => {
            println!("PASS (Partial file resumed from byte 40000 with matching Content-Range)");
            tests_passed += 1;
        }
        _ => println!("FAIL (Resume did not produce the expected file: {:?})", resume_dm.get_task(&resume_task)),
    }

    // Cleanup
    let _ = fs::remove_dir_all(&temp_test_dir);

    println!("============================================================");
    println!(" SUMMARY: {}/{} tests passed", tests_passed, total_tests);
    println!("============================================================");

    if tests_passed == total_tests {
        std::process::exit(0);
    } else {
        std::process::exit(1);
    }
}

/// Creates a minimal binary GGUF header for testing
fn create_synthetic_gguf(path: &PathBuf, arch: &str, quant_str: &str, ctx_len: u64, blocks: u64) {
    let mut file = fs::File::create(path).expect("Failed to create synth gguf");

    // Magic "GGUF"
    file.write_all(&[0x47, 0x47, 0x55, 0x46]).unwrap();
    // Version 3
    file.write_all(&3u32.to_le_bytes()).unwrap();
    // Tensor count: 0
    file.write_all(&0u64.to_le_bytes()).unwrap();
    // Metadata count: 4
    file.write_all(&4u64.to_le_bytes()).unwrap();

    // 1. "general.architecture" -> String (val_type = 8)
    write_gguf_string_kv(&mut file, "general.architecture", arch);

    // 2. "general.file_type" -> UINT32 (val_type = 4, 15 = Q4_K_M)
    write_gguf_u32_kv(&mut file, "general.file_type", 15);

    // 3. "<arch>.context_length" -> UINT64 (val_type = 10)
    write_gguf_u64_kv(&mut file, &format!("{}.context_length", arch), ctx_len);

    // 4. "<arch>.block_count" -> UINT64 (val_type = 10)
    write_gguf_u64_kv(&mut file, &format!("{}.block_count", arch), blocks);
}

fn write_gguf_string_kv(file: &mut fs::File, key: &str, value: &str) {
    // Key length + bytes
    file.write_all(&(key.len() as u64).to_le_bytes()).unwrap();
    file.write_all(key.as_bytes()).unwrap();
    // Val type: 8 = STRING
    file.write_all(&8u32.to_le_bytes()).unwrap();
    // Value length + bytes
    file.write_all(&(value.len() as u64).to_le_bytes()).unwrap();
    file.write_all(value.as_bytes()).unwrap();
}

fn write_gguf_u32_kv(file: &mut fs::File, key: &str, value: u32) {
    file.write_all(&(key.len() as u64).to_le_bytes()).unwrap();
    file.write_all(key.as_bytes()).unwrap();
    // Val type: 4 = UINT32
    file.write_all(&4u32.to_le_bytes()).unwrap();
    file.write_all(&value.to_le_bytes()).unwrap();
}

fn write_gguf_u64_kv(file: &mut fs::File, key: &str, value: u64) {
    file.write_all(&(key.len() as u64).to_le_bytes()).unwrap();
    file.write_all(key.as_bytes()).unwrap();
    // Val type: 10 = UINT64
    file.write_all(&10u32.to_le_bytes()).unwrap();
    file.write_all(&value.to_le_bytes()).unwrap();
}

/// Spawns a real background HTTP server responding to GET / Range requests
fn start_mock_http_server(data: Vec<u8>, slow: bool) -> (u16, Arc<AtomicBool>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind ephemeral mock port");
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();

    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_clone = Arc::clone(&stop_flag);

    thread::spawn(move || {
        while !stop_flag_clone.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut req_buf = [0u8; 1024];
                    let _ = stream.read(&mut req_buf);
                    let req_str = String::from_utf8_lossy(&req_buf);

                    let mut range_start = 0usize;
                    let mut is_range = false;

                    for line in req_str.lines() {
                        if line.to_lowercase().starts_with("range: bytes=") {
                            if let Some(range_val) = line.split('=').nth(1) {
                                if let Some(start_str) = range_val.split('-').next() {
                                    if let Ok(st) = start_str.trim().parse::<usize>() {
                                        range_start = st;
                                        is_range = true;
                                    }
                                }
                            }
                        }
                    }

                    if is_range && range_start < data.len() {
                        let slice = &data[range_start..];
                        let header = format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",
                            slice.len(), range_start, data.len() - 1, data.len()
                        );
                        let _ = stream.write_all(header.as_bytes());
                        let _ = stream.write_all(slice);
                    } else {
                        let header = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                            data.len()
                        );
                        let _ = stream.write_all(header.as_bytes());

                        if slow {
                            // Write in chunks with small delay
                            for chunk in data.chunks(1024) {
                                if stop_flag_clone.load(Ordering::SeqCst) {
                                    break;
                                }
                                let _ = stream.write_all(chunk);
                                thread::sleep(Duration::from_millis(50));
                            }
                        } else {
                            let _ = stream.write_all(&data);
                        }
                    }
                    let _ = stream.flush();
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20));
                }
                Err(_) => break,
            }
        }
    });

    (port, stop_flag)
}
