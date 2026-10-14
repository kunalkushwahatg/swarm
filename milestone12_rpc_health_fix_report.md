# Swarm Milestone 12 — Remote RPC Health Checks & Physical Layer Execution Report

**Date:** October 11, 2026  
**Workspace:** `C:\Users\kunal\OneDrive\Desktop\swarm`  
**Coordinator (Computer A):** `192.168.137.174:8080` (Local CPU + NVIDIA GeForce GTX 1050 CUDA)  
**Worker (Computer B):** `192.168.137.1:50052` (Physical Windows RPC Worker, 7.19 GiB total RAM)  
**Model:** `models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf` (36 Transformer Layers)  
**Validation Suite:** `scripts\Invoke-Milestone12Validation.ps1`

---

## 1. Executive Summary & Verification Verdict

| Verification Item | Target | Observed Result | Status |
| :--- | :--- | :--- | :--- |
| **TCP Reachability** | Port 50052 reachable from Computer A | `TcpTestSucceeded: True` | **PASS** |
| **Health Probe Suppression** | No competing TCP probes on active RPC connection | Active socket inspected via `GetExtendedTcpTable` without new connections | **PASS** |
| **No False UNAVAILABLE** | Worker remains `READY` during idle and `BUSY` during inference | Zero false `UNAVAILABLE` transitions; HTTP 503 completely resolved | **PASS** |
| **Genuine Disconnect Detection** | Detect lost connection if socket drops | Correctly transitions to `UNAVAILABLE` with error log | **PASS** |
| **Unit Regression Suites** | All 4 test binaries pass offline checks | 27 / 27 unit tests passed (Security: 6, Agent: 7, Dynamic: 9, RPC Health: 5) | **PASS** |
| **Controlled Inference (`none`)** | Layers 33–34 on RPC0; full streaming response | 2 layers executed on RPC0; coherent text generated in 16.5s | **PASS** |
| **Dynamic Inference (`dynamic`)** | Predictions match physical placement; memory safety preserved | Predicted `[33, 34]` on RPC0; Actual `[33, 34]` on RPC0; 100% match | **PASS** |
| **Remote Tensor Computation** | Physical remote worker executes forward graph nodes | **GENUINELY CONFIRMED** (Model: 94.08 MiB, KV: 4.00 MiB, Compute: 74.51 MiB) | **PASS** |

### Definitive Finding
**Remote physical tensor computation has been genuinely confirmed.** The coordinator successfully offloaded layers 33 and 34 to Computer B (`192.168.137.1:50052`), allocated 94.08 MiB model weight buffers, 4.00 MiB KV cache buffers, and 74.51 MiB compute scratch buffers on the remote host, and executed the multi-device distributed inference graph across **CPU (layers 0–32) + CUDA0 (layers 35–36) + RPC0 (layers 33–34)** to completion.

---

## 2. Root Cause Analysis

### 2.1 Upstream GGML RPC Architecture
Upstream `llama.cpp/ggml/src/ggml-rpc/ggml-rpc.cpp` implements a single-threaded synchronous server loop:
```cpp
while (true) {
    auto client_socket = server_socket->accept();
    rpc_serve_client(client_socket);
}
```
`rpc_serve_client` retains the accepted socket in a blocking loop until the client disconnects. While `swarm_node` maintains its persistent backend connection, `rpc-server.exe` does **not** invoke `accept()` again.

### 2.2 Mechanism of False Failure
1. During startup, `swarm_node` calls `ggml_backend_rpc_init("192.168.137.1:50052")`, establishing the persistent backend TCP connection.
2. The periodic health checker (`WorkerManager::check_worker_health`) previously executed a naive TCP connect probe (`is_worker_reachable`) using a new socket.
3. Because the remote RPC worker was already serving the coordinator's persistent backend connection, the competing TCP `connect()` was refused or queued until the 2-second timeout expired.
4. The coordinator interpreted this timeout as a worker failure, updated the worker state from `READY` to `UNAVAILABLE`, and subsequently returned `HTTP 503 ("Service Unavailable: No ready workers available")` for incoming chat completion requests.

---

## 3. Exact Code Changes

### 3.1 `worker.h`
- Added `bool has_active_backend_connection;` (default `false`) to `WorkerInfo` to track persistent RPC session state.
- Added `bool is_worker_connected_or_reachable(const WorkerInfo& worker, int timeout_ms = 2000);` to `WorkerManager`.

### 3.2 `worker.cpp`
- **Active Connection Inspection (`is_process_tcp_connected_to_endpoint`)**:
  Implemented non-intrusive Windows TCP table inspection using `GetExtendedTcpTable(..., TCP_TABLE_OWNER_PID_ALL, ...)`. This inspects the coordinator process's own socket table for active `MIB_TCP_STATE_ESTAB` sockets connected to `worker.host:worker.port` without opening any new network sockets.
- **Non-Blocking Connect**:
  Updated `is_worker_reachable` on Windows to use non-blocking socket mode (`ioctlsocket(FIONBIO)`) and `select()` with `2000ms` timeout, preventing the thread from blocking for the default 21-second TCP SYN timeout.
- **Smart Health Check Logic (`WorkerManager::check_worker_health`)**:
  1. *Inference Suppression*: If `worker.is_inference_active || worker.state == WorkerState::BUSY`, health checks return immediately to prevent network contention.
  2. *Active Backend Connection*: For `REMOTE_RPC`, if `is_process_tcp_connected_to_endpoint` detects an established socket, `worker.has_active_backend_connection = true`, the state is maintained as `READY`, and all competing socket probes are skipped.
  3. *Genuine Connection Loss Detection*: If a worker previously held an active connection with assigned layers, but the TCP socket is no longer established, it is accurately marked `UNAVAILABLE` with `last_error = "RPC backend connection ... was lost"`.
  4. *Idle Probing*: Pre-connection or idle workers without active backend connections continue to be probed safely using `is_worker_reachable`.

### 3.3 `main.cpp`
- Initialized `worker.has_active_backend_connection = true` upon successful device registration.
- Added `InferenceWorkerGuard` RAII struct in `/v1/chat/completions` (line 1383): marks participating workers as `BUSY` and `is_inference_active = true` during request processing, cleanly resetting them to `READY` and `false` upon request exit.

### 3.4 `CMakeLists.txt`
- Added `test_rpc_health` target linking `worker.cpp`, `ws2_32`, and `iphlpapi`.

---

## 4. Build and Regression Test Results

All test binaries were compiled with MSVC 2022 (x64) and executed cleanly:

```powershell
.\build-cuda\test_security.exe; .\test_agent_and_inventory.exe; .\test_dynamic_policy.exe; .\build-cuda\test_rpc_health.exe
```

### Test Results Breakdown

1. **`test_security.exe` (Milestone 10 Primitives) — 6/6 PASS**
   - Constant-time comparison: PASS
   - Bearer token extraction: PASS
   - Loopback address validation: PASS
   - Telemetry authorization (token configured): PASS
   - Telemetry authorization (dev mode): PASS
   - File-based secret ingestion (`read_secret_from_file`): PASS

2. **`test_agent_and_inventory.exe` (Milestone 8 Telemetry) — 7/7 PASS**
   - Hardware probe & report serialization: PASS
   - Malformed report rejection: PASS
   - Unsupported metrics & provenance: PASS
   - Freshness & staleness safety: PASS
   - Agent disconnect & reconnection: PASS
   - Stable node identity & worker merge: PASS
   - Loopback RAM deduplication: PASS

3. **`test_dynamic_policy.exe` (Milestone 9 Dynamic Placement) — 9/9 PASS**
   - Heterogeneous backends allocation: PASS
   - Configured vs measured provenance: PASS
   - Stale and missing telemetry rejection: PASS
   - Loopback memory partitioning: PASS
   - Zero-capacity handling: PASS
   - Insufficient capacity rejection: PASS
   - Malformed values rejection: PASS
   - Simulation fixtures isolation: PASS
   - Clock skew and replay protection: PASS

4. **`test_rpc_health.exe` (Milestone 12 Regression Suite) — 5/5 PASS**
   - *Test 1: Healthy worker probe suppression*: Proves active RPC connection is detected via `GetExtendedTcpTable`, keeping worker `READY` without opening competing sockets.
   - *Test 2: Dead / lost worker detection*: Proves genuinely dead endpoints transition to `UNAVAILABLE`, and dropped sockets on workers with assigned layers are flagged as lost connections.
   - *Test 3: Connection failure isolation*: Proves an unreachable worker does not impact or terminate healthy workers.
   - *Test 4: Dynamic zero-capacity safety*: Proves workers with free RAM below headroom are safely assigned 0 layers without crashes.
   - *Test 5: Reflection in `/backends`*: Proves remote RPC layer allocation is accurately tracked, parsed, and exposed via JSON.

---

## 5. Physical Validation Evidence

### 5.1 Controlled Placement Test (`-PlacementPolicy "none"`)
**Execution Command:**
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
    -File .\scripts\Invoke-Milestone12Validation.ps1 `
    -RemoteWorkerEndpoint "192.168.137.1:50052" `
    -TokenFile ".\secrets\m12_telemetry_token.txt" `
    -GpuLayers 4 `
    -PlacementPolicy "none"
```

**Captured Evidence:**
- **Step 1:** Reachability to `192.168.137.1:50052` verified (`TcpTestSucceeded: True`).
- **Step 2:** Coordinator started with PID 24972.
- **Step 3:** Coordinator health check passed (`/health` returned `ok`).
- **Step 4:** Node inventory registered `node-192.168.137.1-50052` (non-loopback remote node).
- **Step 5:** Inference completed in 16,490 ms (2.75 tok/s).
  - *Generated Text:* `"Distributed computing is the practice of dividing a large computing task among many computer processors or computers that work together to solve a problem."`
- **Backend Placement Verification (`/backends`):**
  - `CPU`: 33 layers (0–32), Model: 1.58 GiB, KV: 66.00 MiB, Compute: 10.01 MiB
  - `CUDA0`: 2 layers (35–36), Model: 290.48 MiB, KV: 2.00 MiB, Compute: 300.75 MiB
  - `RPC0`: 2 layers (33–34), Model: 94.08 MiB, KV: 4.00 MiB, Compute: 74.51 MiB

### 5.2 Dynamic Resource-Aware Placement Test (`-PlacementPolicy "dynamic"`)
**Execution Command:**
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
    -File .\scripts\Invoke-Milestone12Validation.ps1 `
    -RemoteWorkerEndpoint "192.168.137.1:50052" `
    -TokenFile ".\secrets\m12_telemetry_token.txt" `
    -GpuLayers 4 `
    -PlacementPolicy "dynamic"
```

**Captured Evidence:**
- **Telemetry Receipt:** Computer B advertised 1.40 GiB free RAM / 7.19 GiB total RAM.
- **Headroom Enforcement:** Enforced 12.5% minimum floor (920.62 MiB). Derived usable budget: `1433 MiB - 920.62 MiB = 512.85 MiB`.
- **Policy Prediction:**
  - `RPC0 (192.168.137.1:50052)`: usable budget = 512.85 MiB, predicted layers = `[33, 34]`
  - `local-cuda-0 (GTX 1050)`: usable budget = 3.03 GiB, predicted layers = `[35, 36]`
- **Verification Log:**
  ```text
  === Placement Policy Verification (dynamic) ===
    Device 192.168.137.1:50052: [MATCH] predicted=[33, 34] actual=[33, 34]
    Device local-cuda-0: [MATCH] predicted=[35, 36] actual=[35, 36]
  Outcome: All backend placements MATCHED the dynamic policy prediction.
  ```
- **Inference Completion:** Inference completed in 14,921 ms without error.

---

## 6. Resource-Aware Placement Safety & Memory Requirements

### 6.1 Safety Threshold Mathematical Specification
For Computer B (Total Physical RAM = 7.19 GiB = 7,722,795,008 bytes):
- **Dynamic Headroom Floor:** `candidate_total / 8ULL` = 12.5% = **920.62 MiB**
- **Layer Cost:** ~47.04 MiB model weights + ~2.00 MiB KV cache + compute scratch = **~92.2 MiB per layer**

### 6.2 Threshold Regimes for Computer B
1. **Free RAM < 920.62 MiB:** Usable budget is 0 MiB. Dynamic policy safely assigns **0 layers** to Computer B, offloading entirely to local CUDA or retaining on CPU. Memory safety is strictly maintained.
2. **920.62 MiB < Free RAM < 1,012.8 MiB:** Usable budget is < 92.2 MiB. Assigns **0 layers**.
3. **1,012.8 MiB <= Free RAM < 1,105.0 MiB:** Usable budget is >= 92.2 MiB. Assigns **1 layer**.
4. **Free RAM >= 1,105.0 MiB:** Usable budget is >= 184.4 MiB. Assigns **2 layers**.

When Computer B's background applications were closed, free RAM rose to 1.40 GiB (1,433 MiB), providing 512.85 MiB of usable headroom, allowing dynamic placement to allocate 2 layers safely and verify physical execution automatically.

---

## 7. Status Classification Matrix

| Milestone Feature | Status | Details |
| :--- | :--- | :--- |
| Remote Worker TCP Discovery | **PASS** | Computer A connects to `192.168.137.1:50052` over hotspot Wi-Fi |
| Telemetry Token Authentication | **PASS** | File-based token passing validated in production mode |
| Non-Intrusive RPC Health Checking | **PASS** | `GetExtendedTcpTable` avoids competing TCP socket collisions |
| False UNAVAILABLE Prevention | **PASS** | Workers with live RPC sessions stay `READY` / `BUSY` |
| Dead / Dropped Connection Detection | **PASS** | Transitions to `UNAVAILABLE` when socket closes |
| Single-Client Serialization Guard | **PASS** | `InferenceWorkerGuard` protects active request execution |
| Offline Regression Test Suite | **PASS** | 27 / 27 unit tests pass across all suites |
| Controlled Layer Allocation (`none`) | **PASS** | 2 layers assigned to RPC0, verified via `/backends` |
| Dynamic Placement Allocation (`dynamic`) | **PASS** | 2 layers predicted and matched to RPC0 |
| Physical Remote Tensor Computation | **PASS** | 94.08 MiB model, 4 MiB KV, 74.5 MiB compute allocated on Computer B |
| Streaming Chat Completion Output | **PASS** | Coherent definition of distributed computing streamed over SSE |

---

## 8. Artifact and Log Integrity

The following evidence artifacts have been preserved in `artifacts/validation/`:
- `artifacts/validation/m12_backends.json` — Physical backend placements and buffer statistics
- `artifacts/validation/m12_coordinator.stdout.log` — Coordinator execution and token streaming timeline
- `artifacts/validation/m12_coordinator.stderr.log` — LLAMA tensor loader, device assignments, and graph splits
- `artifacts/validation/m12_inference_response.raw.txt` — Raw streamed completion text
- `test_rpc_health.cpp` — Dedicated 5-test regression suite source
- `build-cuda/test_rpc_health.exe` — Compiled regression binary

---

## 9. Cleanup & Operator Instructions

1. **Firewall Rules:** The narrowly scoped inbound rule `Swarm-Coordinator-Hotspot-B-Restricted` remains active on Computer A, allowing only `192.168.137.1` to access port 8080.
2. **Worker Process:** When testing is complete, Computer B's worker can be stopped by pressing `Ctrl+C` in its PowerShell window.
3. **Coordinator:** The coordinator process was cleanly stopped at Step 6 of the validation script.
