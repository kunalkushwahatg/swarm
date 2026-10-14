# Phase C.3.6 Standalone CUDA Real Inference Test Report

**Document Date:** October 12, 2026  
**Status:** COMPLETE — REAL INFERENCE TEST PASSED  
**Workspace:** `C:\Users\kunal\OneDrive\Desktop\swarm`  
**Prototype Path:** `spike/desktop-shell/`  
**Test Runner Evidence:** `spike/desktop-shell/phase_c36_standalone_cuda_result.json`  
**Test Verdict:** **PASS**

---

## 1. Executive Summary

This report documents the authorized execution of **one controlled real Swarm standalone CUDA inference test** using the staged low-memory profile (`SWARM_USE_RPC=0`, `SWARM_N_GPU_LAYERS=-1`, `SWARM_CTX_SIZE=512`, `PORT=8080`) with the official Qwen 2.5 3B Instruct Q4_K_M model.

The test was executed strictly within the isolated Tauri supervisor architecture under Win32 Job Object containment:
- **Preflight Gates Passed:** Fresh dynamic measurements immediately prior to launch confirmed **1,325 MB available physical RAM** (exceeding the conservative 1,000 MB threshold) and **3,450 MiB available GPU VRAM** (exceeding the 3,100 MiB threshold). Port 8080 was unoccupied and all binaries/models were verified.
- **Controlled Supervisor Launch:** Coordinator PID `18420` launched successfully under supervisor Job Object management in **9,021 ms**. Zero RPC worker processes were spawned (`SWARM_USE_RPC=0`).
- **Authoritative Model Verification:** The `/health` endpoint returned HTTP 200 with `model.loaded: true` and `inference.ready: true`. All **37 model layers** were offloaded to `CUDA0` (NVIDIA GeForce GTX 1050 4GB).
- **Exact Inference Result:** Exactly one short generation request (`"Reply with exactly: SWARM CUDA TEST OK"`) was submitted to the production `/v1/chat/completions` SSE endpoint. The model responded with exact verbatim fidelity: **`SWARM CUDA TEST OK`**.
- **Performance:** Time to first content (TTFC) was **484 ms**, prompt evaluation took **461.28 ms**, token generation took **262.79 ms**, and token generation throughput was **19.03 tokens/second**.
- **Clean Supervisor Shutdown:** The coordinator child was cleanly stopped via `stop_engine_internal()` in **649 ms**. Process `18420` exited, port 8080 was released, GPU VRAM recovered from 1,262 MiB to **3,410 MiB**, and the cluster transitioned cleanly to `Stopped`. Zero unmanaged processes were touched.

---

## 2. Fresh Preflight Resource Measurements

Preflight measurements were queried dynamically immediately prior to launch execution at `2026-10-12 15:32:54` using Win32 `GlobalMemoryStatusEx` and `nvidia-smi`.

| Resource / Prerequisite | Required Threshold | Measured Value Immediately Pre-Launch | Status | Margin / Detail |
| :--- | :--- | :--- | :--- | :--- |
| **Available Physical RAM** | $\ge 1,000\text{ MB}$ | **1,325 MB** (Total: 8,032 MB) | **PASS** | $+325\text{ MB}$ headroom |
| **Available GPU VRAM** | $\ge 3,100\text{ MiB}$ | **3,450 MiB** (Total: 4,096 MiB) | **PASS** | $+350\text{ MiB}$ headroom |
| **Coordinator Port 8080** | Must be unbound | **Available (Unbound)** | **PASS** | 0 active listeners |
| **RPC Port 50052** | Bypassed (`SWARM_USE_RPC=0`) | **Unbound** | **PASS** | No listener required |
| **Active Swarm Processes** | Zero existing | **None running** | **PASS** | Zero unmanaged coordinators or RPC workers |
| **Official Model File** | Present & valid | **Present** | **PASS** | `models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf` (2,104,932,768 bytes) |
| **Coordinator Binary** | Present & valid | **Present** | **PASS** | `build-cuda\swarm_node.exe` |
| **Required CUDA DLLs** | Present in search path | **Present** | **PASS** | `llama.dll`, `ggml.dll`, `ggml-cuda.dll` in `build-cuda` & `build-cuda\bin` |

**Preflight Outcome:** All preflight checks passed. Launch authorized to proceed under the single-test scope.

---

## 3. Exact Launch Configuration & Supervisor Containment

The coordinator process was started using the Tauri supervisor's internal orchestrator (`start_engine_internal`) with explicit `allow_real_runtime: true`.

### 3.1 Effective Environment Variables

```ini
SWARM_USE_RPC=0
PORT=8080
SWARM_MODEL_PATH=C:\Users\kunal\OneDrive\Desktop\swarm\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf
SWARM_N_GPU_LAYERS=-1
SWARM_CTX_SIZE=512
SWARM_PLACEMENT_POLICY=none
SWARM_DEPLOYMENT_ENV=development
```

### 3.2 Process Execution & Containment Details

- **Executable:** [`build-cuda\swarm_node.exe`](file:///C:/Users/kunal/OneDrive/Desktop/swarm/build-cuda/swarm_node.exe)
- **Working Directory:** `C:\Users\kunal\OneDrive\Desktop\swarm`
- **Prepended DLL Paths:**
  - `C:\Users\kunal\OneDrive\Desktop\swarm\build-cuda`
  - `C:\Users\kunal\OneDrive\Desktop\swarm\build-cuda\bin`
- **Supervisor Job Object:** Process attached to Win32 Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
- **RPC Worker:** None spawned. `rpc_port: 0` bypassed worker launch in [`orchestrator.rs`](file:///C:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/supervisor/orchestrator.rs#L164-L245).
- **Spawned Process PID:** `18420`
- **Startup Time to Readiness:** **9,021 ms** (HTTP 200 on `/health`)

---

## 4. Authoritative Model-Loading Verification

Upon coordinator readiness, the supervisor probed `GET http://127.0.0.1:8080/health` and inspected internal runtime metrics at `GET http://127.0.0.1:8080/metrics`.

### 4.1 Authoritative `/health` Response Body

```json
{
  "context": {
    "created": true,
    "size": 512
  },
  "inference": {
    "ready": true,
    "ready_required_rpc_workers": 0,
    "ready_workers": 0,
    "required_rpc_workers": 0,
    "total_rpc_workers": 0,
    "total_workers": 1
  },
  "model": {
    "loaded": true,
    "path": "C:\\Users\\kunal\\OneDrive\\Desktop\\swarm\\models\\qwen2.5-3b-instruct-q4_k_m.official-check.gguf"
  },
  "server": {
    "host": "0.0.0.0",
    "port": 8080,
    "state": "running"
  },
  "status": "ok",
  "timestamp": "2026-10-12 15:33:03"
}
```

### 4.2 Actual Device Layer Placement & Memory Allocations

Measurements extracted directly from coordinator Prometheus metrics (`/metrics`):

| Metric | CUDA0 (NVIDIA GTX 1050) | Host CPU | Notes |
| :--- | :--- | :--- | :--- |
| **Assigned Model Layers** | **37 layers** | **0 layers** | Full layer offload achieved (`-1`) |
| **Model Buffer** | **1,923,958,702 bytes** (1,834.83 MiB) | **175,028,306 bytes** (166.92 MiB) | Embedding/output heads on CPU |
| **KV Cache Buffer** | **18,874,368 bytes** (18.00 MiB) | **0 bytes** | KV cache hosted entirely in GPU VRAM |
| **Compute Buffer** | **8,923,382 bytes** (8.51 MiB) | **0 bytes** | Compute buffer hosted entirely in GPU VRAM |
| **Total Dedicated GPU Allocation** | **1,951,756,452 bytes** (~1,861.34 MiB) | — | Net coordinator GPU allocation |

---

## 5. Actual Inference Execution & Validation

### 5.1 Request Details

- **Endpoint:** `POST http://127.0.0.1:8080/v1/chat/completions`
- **Request Headers:** `Content-Type: application/json; Connection: close`
- **Request Body:**
  ```json
  {
    "messages": [
      {
        "role": "user",
        "content": "Reply with exactly: SWARM CUDA TEST OK"
      }
    ],
    "max_tokens": 30
  }
  ```

### 5.2 Server-Sent Events (SSE) Stream Streamed by Coordinator

The coordinator streamed 6 raw SSE chunks over the persistent connection:

```
data: {"choices":[{"delta":{"content":"SW"}}],"id":1}

data: {"choices":[{"delta":{"content":"ARM"}}],"id":1}

data: {"choices":[{"delta":{"content":" CUDA"}}],"id":1}

data: {"choices":[{"delta":{"content":" TEST"}}],"id":1}

data: {"choices":[{"delta":{"content":" OK"}}],"id":1}

data: {"choices":[{"delta":{}}],"id":1,"timings":{"gen_ms":262.7909,"prompt_eval_ms":461.277,"tokens_generated":5,"tokens_per_sec":19.026534023818932,"total_ms":733.0356}}
```

### 5.3 Generated Output Verification

- **Full Aggregated Text:**
  ```
  SWARM CUDA TEST OK
  ```
- **Fidelity:** **Exact verbatim match** to prompt instruction. No hallucinations, garbage tokens, or formatting errors.
- **Tokens Generated:** **5 tokens** (`SW`, `ARM`, ` CUDA`, ` TEST`, ` OK`).

### 5.4 Timing and Throughput Metrics

| Timing Metric | Measured Value | Authority / Source |
| :--- | :--- | :--- |
| **Startup Duration** | **9,021 ms** (9.02 s) | Supervisor orchestrator timer |
| **Time to First Content (TTFC)** | **484 ms** (0.48 s) | Client TCP reader timestamp |
| **Prompt Evaluation Duration** | **461.28 ms** | Coordinator internal timer (`llama_decode`) |
| **Token Generation Duration** | **262.79 ms** | Coordinator internal timer |
| **Total Inference Duration** | **733.04 ms** (internal) / **742 ms** (round-trip) | Coordinator timing event / Client timer |
| **Token Generation Throughput** | **19.03 tokens/second** | Coordinator timing event |

---

## 6. Live Memory & Resource Profile

All memory numbers below represent **actual host measurements** taken via Win32 `GlobalMemoryStatusEx` and `nvidia-smi` at each distinct lifecycle stage.

| Lifecycle Phase | Measured Avail Physical RAM | Measured Avail GPU VRAM | Total GPU VRAM Used | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **1. Preflight** (Idle) | **1,325 MB** | **3,450 MiB** | 646 MiB | System idle, baseline state |
| **2. Post-Startup** (Loaded) | **460 MB** | **1,268 MiB** | 2,828 MiB | Coordinator active, weights staged |
| **3. Post-Inference** (Post-Run) | **453 MB** | **1,262 MiB** | 2,834 MiB | Immediately after token generation |
| **4. Post-Shutdown** (Clean Exit) | **908 MB** | **3,410 MiB** | 686 MiB | After supervisor `stop_staged()` |

### Analysis of Memory Behavior
1. **GPU Offload Success:** Moving from 3,450 MiB to 1,268 MiB free VRAM represents an allocation of **2,182 MiB** total GPU memory (including CUDA runtime, driver overhead, 1,835 MiB model buffer, 18 MiB KV cache, and 8.5 MiB compute buffer).
2. **Physical RAM Preservation:** Even under active inference, the system retained **453 MB of physical RAM**, preventing out-of-memory thrashing or system instability.
3. **Complete Memory Reclamation:** Upon clean supervisor shutdown, GPU VRAM recovered instantly from 1,262 MiB to **3,410 MiB** (+2,148 MiB reclaimed), confirming zero leaked GPU contexts or orphaned buffers.

---

## 7. Clean Shutdown & Verification

- **Shutdown Mechanism:** Supervisor orchestrator graceful stop sequence (`stop_engine_internal(&state)`).
- **Shutdown Duration:** **649 ms**.
- **Child Process Exit:** Coordinator PID `18420` terminated cleanly with code 0. Confirmed by `Get-Process -Id 18420` returning no process.
- **Port Release:** Coordinator port 8080 was immediately unbound. No active listening sockets remained (only transient Windows TCP `TimeWait` on closed loopback connections).
- **Cluster State:** Orchestrator lifecycle state transitioned cleanly to `ClusterLifecycleState::Stopped`.
- **System Integrity:** Zero unmanaged processes were touched, killed, or adopted. WSL and other Windows services remained completely undisturbed.

---

## 8. Summary of Evidence Files

| Evidence Artifact | Absolute Workspace Path | Description |
| :--- | :--- | :--- |
| **Complete Result JSON** | [`spike\desktop-shell\phase_c36_standalone_cuda_result.json`](file:///C:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/phase_c36_standalone_cuda_result.json) | Full structured test execution metrics, timestamps, health JSON, SSE chunks, and metrics. |
| **Standalone Test Runner** | [`spike\desktop-shell\src-tauri\src\bin\standalone_cuda_test.rs`](file:///C:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/bin/standalone_cuda_test.rs) | Single authorized execution binary with fail-closed gates and Job Object supervisor integration. |
| **Preflight Probe Binary** | [`spike\desktop-shell\src-tauri\src\bin\preflight_probe.rs`](file:///C:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/bin/preflight_probe.rs) | Non-destructive host resource and threshold evaluation prober. |

---

## 9. Pass/Fail Verdict & Remaining Limitations

### Final Result: **PASS**

All requirements of Swarm Phase C.3.6 have been fulfilled:
1. Fresh preflight checks verified RAM ($\ge 1,000\text{ MB}$) and VRAM ($\ge 3,100\text{ MiB}$) immediately before launch.
2. Coordinator was launched strictly under supervisor Job Object containment with the exact staged low-memory profile (`SWARM_USE_RPC=0`, `SWARM_N_GPU_LAYERS=-1`, `SWARM_CTX_SIZE=512`).
3. Authoritative `/health` confirmed the official Qwen 2.5 3B model loaded with inference readiness.
4. Exactly one prompt was executed against `/v1/chat/completions`.
5. Exact verbatim response was received (`SWARM CUDA TEST OK`) at **19.03 tokens/second**.
6. Supervisor cleanly stopped the test coordinator child, releasing port 8080 and reclaiming GPU/system resources.

### Remaining Production Considerations
- **Physical RAM Headroom Under Dual-Process Operation:** Standalone CUDA mode operated safely with ~453 MB free RAM during inference. However, full dual-process cluster operation (with local RPC worker `ggml-rpc-server.exe`) requires additional host RAM overhead. The **1,500 MB preflight guard** for default dual-process mode remains mandatory.
- **Context Size Ceiling:** This test validated `SWARM_CTX_SIZE=512`. Further expansion of the context window to 2,048 or 4,096 tokens will increase the KV cache footprint on the GTX 1050 (from 18 MiB up to ~72–144 MiB), which fits comfortably within the 1,262 MiB VRAM reserve, but should be tested in subsequent stages.
