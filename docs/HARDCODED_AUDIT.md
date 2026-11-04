# Exhaustive Codebase Audit: Hard-Coded Values & Vulnerabilities

**Audit Date:** November 2026  
**Application:** Swarm Distributed LLM Inference Engine & Edge Compute Supervisor  
**Scope:** C++ Engine (`main.cpp`, `inference_engine.cpp`, `worker.cpp`, etc.), Rust Desktop Supervisor (`src-tauri/`), Rust Tunnel Daemon (`swarm-tunnel/`), Android App (`SwarmWorkerService.kt`), and Frontend UI (`ui/src/`).

---

## Executive Summary

This audit conducted a line-by-line inspection across the entire Swarm codebase to locate hardcoded paths, ports, IP addresses, model architecture assumptions, cryptographic salts, buffer sizes, and timeouts. 

A total of **32 distinct hardcoded patterns** were identified, categorized by severity:
- **7 CRITICAL** (Absolute user paths, shell injection via `system()`, and hardcoded compile toolchains)
- **10 HIGH** (Model-specific layer/cost assumptions, rigid port/host binds, unconfigurable token caps, and air-gap leaks)
- **10 MEDIUM** (Hardcoded timeouts, spin loops, and memory headroom thresholds)
- **5 LOW** (Fallback labels, UI defaults, and cosmetic placeholders)

---

## Master Vulnerability & Finding Matrix

| ID | File & Line | Category | Severity | Description & Real-World Impact | Remediation Recommendation |
|---|---|---|---|---|---|
| **HARD-01** | `worker.cpp:443` | Security / Command Injection | **CRITICAL** | `int result = system(cmd_str.c_str());` on POSIX/Linux/macOS executes worker commands through `/bin/sh -c`. If arguments contain metacharacters, it allows arbitrary shell command execution. | Replace with `fork()` + `execv()` (or `posix_spawnp`) with explicit argument arrays, matching the Windows `CreateProcess` implementation. |
| **HARD-02** | `diagnostics.rs:207-696` | Hardcoded Paths | **CRITICAL** | `r"C:\Users\kunal\OneDrive\Desktop\swarm\..."` is hardcoded across 14 fixture locations in `supervisor_get_diagnostic_fixture`. Diagnostics fail or return invalid paths on any machine not owned by user `kunal`. | Derive paths dynamically from `state.workspace_root` or `std::env::current_exe()`. |
| **HARD-03** | `swarm-tunnel/build-android.ps1:7` | Toolchain Paths | **CRITICAL** | `$ndk = "C:\Users\kunal\AppData\Local\Android\Sdk\ndk\27.2.12479018"` breaks Android cross-compilation on any machine without this exact username and NDK revision. | Read `$env:ANDROID_NDK_HOME` or `$env:ANDROID_HOME/ndk/*` dynamically. |
| **HARD-04** | `swarm-tunnel/.cargo/config.toml:2-3` | Toolchain Paths | **CRITICAL** | Hardcoded absolute paths to `C:/Users/kunal/AppData/Local/Android/Sdk/.../llvm-ar.exe` and `clang.cmd`. Fails build on any other system. | Remove hardcoded paths from committed `config.toml`; pass via environment variables in the build script (`CARGO_TARGET_AARCH64_LINUX_ANDROID_AR` and `LINKER`). |
| **HARD-05** | `build_swarm.bat:6` | Toolchain Paths | **CRITICAL** | `set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"` assumes VS BuildTools 2022. Fails if user has VS Community, Professional, Enterprise, or VS 2019/2025. | Use `vswhere.exe` to dynamically query the installed Visual Studio instance. |
| **HARD-06** | `build_swarm.bat:35` | Hardware Architecture | **CRITICAL** | `-DCMAKE_CUDA_ARCHITECTURES=61` hardcodes Nvidia Pascal (GTX 1050/1060). On RTX 20xx (75), 30xx (86), 40xx (89), or 50xx, kernels run in PTX JIT fallback or fail. | Set `-DCMAKE_CUDA_ARCHITECTURES=all` or `native`, or make it an optional batch parameter. |
| **HARD-07** | Integration Tests (`*.rs:32`) | Hardcoded Paths | **CRITICAL** | `worker_mode_integration_test.rs:32`, `supervisor_test_runner.rs:84`, `standalone_cuda_test.rs:144`, `allocation_integration_test.rs:92` hardcode `r"C:\Users\kunal\OneDrive\Desktop\swarm"`. All test binaries panic on other machines. | Default to `std::env::current_dir()` or `std::env::var("SWARM_WORKSPACE_ROOT")`. |
| **HARD-08** | `main.cpp:616` | Model Architecture | **HIGH** | `int32_t model_transformer_layers = 36;` is hardcoded as fallback. If running SmolLM2 (32 blocks), Llama 3.2 1B (16 blocks), or DeepSeek (28 blocks), the coordinator assumes a 36-layer Qwen model and miscalculates tensor placement. | Read `llama_model_n_layer(model)` directly from the loaded GGUF metadata before policy evaluation. |
| **HARD-09** | `policy.h:65`, `estimator.h:72` | Model Memory Cost | **HIGH** | `DEFAULT_ESTIMATED_BYTES_PER_LAYER = 92 MiB` and `BASE_WEIGHTS_PER_LAYER_BYTES = 73 MiB` are hardcoded for Qwen 2.5 3B. Smaller models are artificially rejected for "insufficient memory", while larger models risk VRAM OOM. | Compute actual per-layer byte size from `model_file_size / total_layers`. |
| **HARD-10** | `inference_engine.cpp:209` | Hardcoded Limit | **HIGH** | `if (max_tokens < 1 || max_tokens > 512)` strictly rejects any generation request above 512 tokens with HTTP 400. Models with 8K context cannot generate long-form responses. | Make max token ceiling configurable via `config.ctx_size` or `SWARM_MAX_TOKENS_LIMIT` (e.g. up to context window length). |
| **HARD-11** | `inference_engine.cpp:398` | Inference Sampling | **HIGH** | `llama_sampler_init_greedy()` is hardcoded. Request parameters for temperature, top-p, top-k, repetition penalty are completely ignored. | Initialize a `llama_sampler_chain` that reads temperature, top_p, etc. from the chat completion JSON payload. |
| **HARD-12** | `main.cpp:519` | Network Security | **HIGH** | `intake_srv.listen("0.0.0.0", config.http_port)` binds the discovery intake server unconditionally to all network interfaces (`0.0.0.0`), bypassing `config.http_bind_address`. | Bind to `config.http_bind_address.c_str()`. |
| **HARD-13** | `config.h:150` | Network Security | **HIGH** | `http_bind_address("0.0.0.0")` defaults the HTTP API gateway to listen publicly on all LAN adapters without authentication. | Default to `"127.0.0.1"` for safety; require explicit opt-in for LAN exposure. |
| **HARD-14** | `swarm-tunnel/src/main.rs:167` | Cryptographic Salt | **HIGH** | `hasher.update(b"swarm-pair-v1:");` paired with a 6-digit decimal PIN ($10^6$ combinations) has only 20 bits of entropy. Without rate-limiting, an offline attacker can precompute all 1M hashes in <1 second. | Use a stronger derivation scheme (e.g., Argon2id or SPAKE2/PAKE) with session salt, or rate-limit dialer attempts. |
| **HARD-15** | `swarm-tunnel/src/main.rs:265` | Network / Air-Gap Leak | **HIGH** | `for ip in ["8.8.8.8", "1.1.1.1"]` hardcodes Google and Cloudflare public DNS resolvers. In isolated/offline enterprise subnets, this causes resolution hangs and leaks DNS queries. | Only query public resolvers if system DNS resolution returns empty or explicitly configured. |
| **HARD-16** | `ui/src/lib/api.ts:24` | Hardcoded Port | **HIGH** | `export const BASE_URL = ... (isTauri ? "http://127.0.0.1:8080" : "");` hardcodes port `8080`. If the coordinator runs on any other port, the frontend fails to communicate. | Query the supervisor's active coordinator port via IPC (`supervisor.getStatus()`) rather than hardcoding `:8080`. |
| **HARD-17** | `ClusterStartupModal.tsx:475` | Debug Artifact | **HIGH** | `Probing ${remoteDevice.connectionAddress || "192.168.137.233:50052"}` displays a developer's private home Wi-Fi IP if connection address is empty. | Replace fallback with generic `"127.0.0.1:50052"` or `"remote-worker"`. |
| **HARD-18** | `scripts/Start-RemoteWorker.ps1:6` | Hardcoded IP | **HIGH** | `[string]$CoordinatorUrl = "http://192.168.204.41:8080"` hardcodes a private subnet IP from development testing. | Default to `"http://<COORDINATOR_IP>:8080"` and enforce input validation. |
| **HARD-19** | `lifecycle.rs:439` | Timeout Stalls | **MEDIUM** | `let standalone_readiness_timeout = ... unwrap_or(90000);` (90 seconds) and remote timeout `240000` (4 minutes). If a process crashes on start, the supervisor hangs for 1.5 to 4 minutes before reporting failure. | Poll `child.try_wait()` inside the loop so crashed processes fail immediately without waiting out the full deadline. |
| **HARD-20** | `tunnel.rs:182` | Timeout Limit | **MEDIUM** | `let deadline = Instant::now() + Duration::from_secs(10);` gives 10s for dialer startup. On high-latency 4G or satellite connections, QUIC relay hole punching can take 12–15s, causing false aborts. | Increase to 20s or make configurable. |
| **HARD-21** | `workers.rs:143` | Probe Clamp | **MEDIUM** | `timeout_ms.min(1000).max(250)` clamps remote worker TCP probe to max 1,000 ms. Cellular links with bufferbloat or RTT > 1s report false offline status. | Allow probe timeouts up to 3,000 ms for cellular/remote workers. |
| **HARD-22** | `SwarmWorkerService.kt:57` | Port Collision | **MEDIUM** | `private const val DISCOVERY_PORT = 50053` is fixed. If another application or instance uses 50053, UDP discovery fails silently. | Catch `BindException` and try next port, or allow configuration via intent extra. |
| **HARD-23** | `SwarmWorkerService.kt:652` | Battery Guardrail | **MEDIUM** | `LOW_BATTERY_STOP_PCT = 15` and `IDLE_LOCK_RELEASE_MS = 15 * 60 * 1000L` are fixed in code. | Expose battery and idle thresholds in Android settings. |
| **HARD-24** | `useSwarmSession.ts:145` | Headroom Warning | **MEDIUM** | `const DEFAULT_RESERVE_RAM = 1024 * 1024 * 1024;` (1.0 GB) hardcodes RAM headroom warning threshold. On an 8GB machine where OS takes 6.8 GB, it triggers constant false warnings. | Derive reserve dynamically based on total host RAM (e.g. 5% of total, min 300 MB). |
| **HARD-25** | `paths.rs:204` | Executable Fallback | **MEDIUM** | `workspace_root.join(r"dist\swarm-worker-windows-x64\ggml-rpc-server.exe")` hardcodes specific folder structure `dist\swarm-worker-windows-x64`. | Search standard directories (`bin/`, PATH, etc.). |
| **HARD-26** | `paths.rs:226` | Development Artifact | **MEDIUM** | `workspace_root.join(r"spike\swarm-tunnel\target\release\swarm-tunnel.exe")` hardcodes cargo target folder. | Search PATH and current executable directory before falling back to cargo target path. |
| **HARD-27** | `main.cpp:840` | CPU Consumption | **MEDIUM** | `std::this_thread::sleep_for(std::chrono::milliseconds(1));` in `main.cpp` main event loop sleeps for 1 ms, consuming unnecessary CPU cycles on an idle coordinator. | Increase to `50` or `100` ms, or use condition variables for shutdown signaling. |
| **HARD-28** | `worker.cpp:469` | Process Termination | **MEDIUM** | `WaitForSingleObject(worker_processes_[i], 5000);` hardcoded 5 second wait on worker process shutdown. | Accept timeout parameter from configuration. |
| **HARD-29** | `paths.rs:57, 91, 99` | Model Filename | **LOW** | `qwen2.5-3b-instruct-q4_k_m.official-check.gguf` is hardcoded across 5 fallback locations if no model is selected. | Fall back to any discovered `.gguf` file in the models directory rather than a specific filename. |
| **HARD-30** | `config.h:149` | Model Path | **LOW** | `model_path("models/qwen2.5-3b-instruct-q4_k_m.gguf")` hardcoded default relative model path. | Default to empty string and require explicit selection or discovery. |
| **HARD-31** | `main.cpp:400` | Device Identifier | **LOW** | `gpu_worker.id = "local-cuda-0"; gpu_worker.host = "127.0.0.1";` hardcoded local CUDA identifier. | Standardized constant, but limits multi-GPU configurations (`local-cuda-1`, etc.). |
| **HARD-32** | `swarm-tunnel/src/main.rs:76` | Concurrency | **LOW** | `.worker_threads(2)` hardcodes 2 threads for Tokio QUIC runtime. | Default to `std::thread::hardware_concurrency().min(4)`. |

---

## Detailed Risk Analysis for Critical & High Severity Findings

### 1. `HARD-01`: POSIX `system()` Command Execution in `worker.cpp:443`
```cpp
// worker.cpp:442-444
std::string cmd_str = cmd.str();
int result = system(cmd_str.c_str());
```
- **Vulnerability:** When running on non-Windows targets (Linux or Android NDK), starting a local worker concatenates `worker.host`, `worker.port`, and `worker.cache_dir` into a single string and executes it via `system()`.
- **Exploitation Vector:** If a remote node sends a malicious cache directory or host containing `"; rm -rf / ;"` or `"` backticks, the POSIX shell executes arbitrary injected commands with the permissions of the Swarm process.
- **Fix:** Replace with `fork()` + `execvp()` or `posix_spawn()`.

---

### 2. `HARD-02`: Hardcoded User Paths (`C:\Users\kunal\...`) in `diagnostics.rs`
```rust
// diagnostics.rs:207, 213, 219
path: r"C:\Users\kunal\OneDrive\Desktop\swarm\build-cuda\swarm_node.exe".to_string(),
path: r"C:\Users\kunal\OneDrive\Desktop\swarm\dist\swarm-worker-windows-x64\ggml-rpc-server.exe".to_string(),
path: r"C:\Users\kunal\OneDrive\Desktop\swarm\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf".to_string(),
```
- **Vulnerability:** Diagnostic fixtures returned to the UI contain hardcoded paths belonging to the developer's personal user folder.
- **Impact:** Any user running the desktop app on another computer receives invalid diagnostic reports stating that core files are expected under `C:\Users\kunal`.
- **Fix:** Replace with `state.workspace_root.join(...)`.

---

### 3. `HARD-08` & `HARD-09`: Rigid 36-Layer & 92 MB Layer Assumptions
```cpp
// main.cpp:616
int32_t model_transformer_layers = 36;
// policy.h:65
static constexpr uint64_t DEFAULT_ESTIMATED_BYTES_PER_LAYER = 92ULL * 1024ULL * 1024ULL;
```
- **Vulnerability:** The capacity estimator assumes every model has 36 transformer blocks and costs 92 MiB per layer (specifically calibrated for Qwen 2.5 3B).
- **Impact:**
  - When loading smaller models (e.g. `SmolLM2 360M`, where layers cost ~8 MiB), Swarm calculates that the model requires multiple gigabytes of memory, falsely declaring that the device has insufficient capacity.
  - When loading larger models (e.g. 7B, 14B), Swarm underestimates layer cost and causes CUDA Out-of-Memory crashes.
- **Fix:** Read the layer count and tensor dimensions directly from `llama_model_get_vocab` and GGUF header before running `PlacementPolicyEngine::evaluate()`.

---

### 4. `HARD-10`: 512 Max Tokens Hard Ceiling in `inference_engine.cpp:209`
```cpp
// inference_engine.cpp:209-214
if (max_tokens < 1 || max_tokens > 512) {
    res.status = 400;
    res.set_content(R"({"error":"max_tokens must be 1..512"})", "application/json");
    return;
}
```
- **Vulnerability:** The C++ coordinator rejects any request asking for more than 512 output tokens.
- **Impact:** Code generation, document summarization, or chain-of-thought models (e.g. DeepSeek R1) fail with HTTP 400 when asked to generate typical long-form outputs (1024–4096 tokens).
- **Fix:** Allow `max_tokens` up to `config.ctx_size - prompt_tokens`.

---

### 5. `HARD-16`: Frontend Hardcoded Coordinator Port (`:8080`) in `api.ts:24`
```typescript
// ui/src/lib/api.ts:24
export const BASE_URL = import.meta.env.VITE_SWARM_API_URL ?? (isTauri ? "http://127.0.0.1:8080" : "");
```
- **Vulnerability:** The frontend assumes the coordinator is always on port 8080.
- **Impact:** If port 8080 is in use and the user runs on a custom port (`PORT=8090`), the Tauri UI becomes completely disconnected from the coordinator.
- **Fix:** Retrieve the active port dynamically from `useSupervisor()` status.

---

### 6. `HARD-17`: Developer Hotspot IP Leaked in `ClusterStartupModal.tsx:475`
```typescript
// ClusterStartupModal.tsx:475
Probing ${remoteDevice.connectionAddress || "192.168.137.233:50052"}
```
- **Vulnerability:** A private Wi-Fi hotspot IP address is hardcoded as fallback text.
- **Impact:** Leaks private network configuration and confuses operators.
- **Fix:** Replace fallback with `"Checking remote worker endpoint..."`.

---

## Action Plan: Priority Remediation Order

1. **Immediate Security Fixes:**
   - Remove `system()` in `worker.cpp` and sanitize arguments.
   - Remove hardcoded `C:\Users\kunal\...` paths in `diagnostics.rs` and build scripts.
   - Clean leaked `192.168.137.233` IP in `ClusterStartupModal.tsx`.
2. **Dynamic Model & Architecture Sizing:**
   - Relax `max_tokens` limit in `inference_engine.cpp` from 512 to context-bound dynamic limit.
   - Derive layer count and layer memory cost from loaded GGUF metadata instead of defaulting to 36 layers / 92 MB.
3. **Network & Port Portability:**
   - Anchor `ui/src/lib/api.ts` `BASE_URL` to the live coordinator port.
   - Auto-detect Visual Studio location in `build_swarm.bat` using `vswhere.exe`.
   - Parameterize CUDA architecture in `CMakeLists.txt` and `build_swarm.bat`.
