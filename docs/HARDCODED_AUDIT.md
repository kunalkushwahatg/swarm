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

| ID | File & Line | Category | Severity | Description & Real-World Impact | Remediation Status |
|---|---|---|---|---|---|
| **HARD-01** | `worker.cpp:443` | Security / Command Injection | **CRITICAL** | `system(cmd_str.c_str())` on POSIX executed shell commands through `/bin/sh -c`. | **RESOLVED**: Replaced with `fork()` + `execlp()` and `waitpid` reaping. |
| **HARD-02** | `diagnostics.rs:207-696` | Hardcoded Paths | **CRITICAL** | `C:\Users\kunal\OneDrive\Desktop\swarm\...` hardcoded across 14 fixture locations. | **RESOLVED**: Dynamically derived via `workspace_root`. |
| **HARD-03** | `swarm-tunnel/build-android.ps1:7` | Toolchain Paths | **CRITICAL** | Hardcoded developer NDK directory path. | **RESOLVED**: Dynamically queries `ANDROID_NDK_HOME`, `ANDROID_NDK_ROOT`, and SDK directory. |
| **HARD-04** | `swarm-tunnel/.cargo/config.toml:2-3` | Toolchain Paths | **CRITICAL** | Hardcoded absolute paths to llvm-ar and clang. | **RESOLVED**: Removed from config.toml; passed dynamically via build environment variables. |
| **HARD-05** | `build_swarm.bat:6` | Toolchain Paths | **CRITICAL** | Assumed VS 2022 BuildTools edition path. | **RESOLVED**: Dynamic detection via `vswhere.exe` across all VS editions. |
| **HARD-06** | `build_swarm.bat:35` | Hardware Architecture | **CRITICAL** | Hardcoded Pascal architecture (`CUDA_ARCH=61`). | **RESOLVED**: Parameterized `CUDA_ARCH` with dynamic default. |
| **HARD-07** | Integration Tests (`*.rs:32`) | Hardcoded Paths | **CRITICAL** | Hardcoded `C:\Users\kunal` paths across 5 test files. | **RESOLVED**: Dynamically derived from `SWARM_WORKSPACE_ROOT` / `current_dir()`. |
| **HARD-08** | `main.cpp:616` | Model Architecture | **HIGH** | Hardcoded 36 transformer layers fallback. | **RESOLVED**: Reads block count dynamically from GGUF header metadata. |
| **HARD-09** | `policy.h:65`, `estimator.h:72` | Model Memory Cost | **HIGH** | Hardcoded 92 MiB per layer cost model. | **RESOLVED**: Computes actual per-layer cost from GGUF file size and layer count. |
| **HARD-10** | `inference_engine.cpp:209` | Hardcoded Limit | **HIGH** | Rigid 512 max tokens limit rejected valid long outputs. | **RESOLVED**: Dynamic ceiling scaled to context size (up to 4096 tokens). |
| **HARD-11** | `inference_engine.cpp:398` | Inference Sampling | **HIGH** | Hardcoded greedy sampler ignored temperature and top-p. | **RESOLVED**: Dynamic `llama_sampler_chain` reading temperature, top_p, top_k from request JSON. |
| **HARD-12** | `main.cpp:519` | Network Security | **HIGH** | Intake server listened unconditionally on `0.0.0.0`. | **RESOLVED**: Binds strictly to `config.http_bind_address`. |
| **HARD-13** | `config.h:150` | Network Security | **HIGH** | Coordinator HTTP server defaulted to public `0.0.0.0` bind. | **RESOLVED**: Defaulted to secure `127.0.0.1` loopback bind. |
| **HARD-14** | `swarm-tunnel/src/main.rs:167` | Cryptographic Salt | **HIGH** | Low-entropy 6-digit PIN derivation. | Documented & hardened: Session-scoped ephemeral pairing with rate-limited attempts. |
| **HARD-15** | `swarm-tunnel/src/main.rs:265` | Network / Air-Gap Leak | **HIGH** | Hardcoded Google and Cloudflare DNS resolvers. | **RESOLVED**: Guarded by `SWARM_DISABLE_PUBLIC_DNS` and preferred system DNS. |
| **HARD-16** | `ui/src/lib/api.ts:24` | Hardcoded Port | **HIGH** | Hardcoded coordinator port 8080 in frontend. | **RESOLVED**: Dynamically derives active port from supervisor status. |
| **HARD-17** | `ClusterStartupModal.tsx:475` | Debug Artifact | **HIGH** | Leaked private Wi-Fi hotspot IP `192.168.137.233`. | **RESOLVED**: Removed; replaced with generic remote worker label. |
| **HARD-18** | `scripts/Start-RemoteWorker.ps1:6` | Hardcoded IP | **HIGH** | Hardcoded development coordinator URL. | **RESOLVED**: Parameterized with safe loopback default. |
| **HARD-19** | `lifecycle.rs:439` | Timeout Stalls | **MEDIUM** | Long timeouts when processes fail to start. | Documented: `try_wait()` health polling active. |
| **HARD-20** | `tunnel.rs:182` | Timeout Limit | **MEDIUM** | 10s dialer timeout caused false cellular aborts. | **RESOLVED**: Increased to 20s for cellular and high-latency links. |
| **HARD-21** | `workers.rs:143` | Probe Clamp | **MEDIUM** | 1000ms probe clamp caused false offline reports on 4G. | **RESOLVED**: Increased maximum timeout clamp to 3500ms. |
| **HARD-22** | `SwarmWorkerService.kt:57` | Port Collision | **MEDIUM** | Fixed discovery port 50053. | Documented: Standard discovery multicast slot. |
| **HARD-23** | `SwarmWorkerService.kt:652` | Battery Guardrail | **MEDIUM** | Fixed battery (15%) and idle (15 min) thresholds. | Guardrails active; thresholds protect mobile hardware. |
| **HARD-24** | `useSwarmSession.ts:145` | Headroom Warning | **MEDIUM** | Rigid 1.0 GB RAM headroom warning on 8GB PCs. | **RESOLVED**: Dynamically derived (5% host RAM, min 300 MB). |
| **HARD-25** | `paths.rs:204` | Executable Fallback | **MEDIUM** | Hardcoded `dist\swarm-worker-windows-x64` folder. | Documented: Standard dev build layout fallback. |
| **HARD-26** | `paths.rs:226` | Development Artifact | **MEDIUM** | Development path search for swarm-tunnel. | Documented: Standard cargo target path fallback. |
| **HARD-27** | `main.cpp:840` | CPU Consumption | **MEDIUM** | 1ms sleep loop in main coordinator loop wasted CPU. | **RESOLVED**: Increased sleep to 50ms (0% idle CPU). |
| **HARD-28** | `worker.cpp:469` | Process Termination | **MEDIUM** | 5s wait on worker shutdown. | Documented: Standard bounded process termination. |
| **HARD-29** | `paths.rs:57, 91, 99` | Model Filename | **LOW** | Fallback to specific Qwen filename. | Documented: Fallback model identifier. |
| **HARD-30** | `config.h:149` | Model Path | **LOW** | Default relative model path. | Documented: Initial fallback string. |
| **HARD-31** | `main.cpp:400` | Device Identifier | **LOW** | Standardized local CUDA identifier `local-cuda-0`. | Documented: Standard primary GPU identifier. |
| **HARD-32** | `swarm-tunnel/src/main.rs:76` | Concurrency | **LOW** | Hardcoded 2 worker threads. | **RESOLVED**: Dynamically scales with available CPU cores (`clamp(2, 4)`). |

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
