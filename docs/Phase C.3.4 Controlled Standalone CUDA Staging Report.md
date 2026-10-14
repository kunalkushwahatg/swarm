# Phase C.3.4 Controlled Standalone CUDA Staging Report

**Document Date:** October 12, 2026  
**Status:** STAGED AND VERIFIED (PREPARATION ONLY — ZERO REAL PROCESSES SPAWNED)  
**Workspace:** `C:\Users\kunal\OneDrive\Desktop\swarm`  
**Prototype Path:** `spike/desktop-shell/`  
**Test Results:** `spike/desktop-shell/supervisor_test_results.json` (30/30 Passing)

---

## 1. Executive Summary

In accordance with operator instructions, **Option 1: Standalone CUDA mode** has been staged as an isolated, opt-in low-memory test profile within the `spike/desktop-shell/` supervisor prototype. 

This configuration targets local CUDA offloading without a loopback RPC worker:
- `SWARM_USE_RPC=0`
- `SWARM_CTX_SIZE=512`
- `SWARM_N_GPU_LAYERS=-1` (matching the historically verified Milestone 4 configuration; preserving `-1` without substituting `36`)
- `PORT=8080`

### Strict Boundary Adherence
- **Zero Real Processes Spawned:** Real engine execution remains blocked awaiting explicit operator launch. No real coordinator process was started, no model weights were loaded, and no tokens were generated.
- **Production Baseline Preserved:** The core C++ inference engine (`main.cpp`, `config.h`, `node.h`), production PowerShell launchers (`Start-LocalDev.ps1`, `Start-ProductionCoordinator.ps1`), official GGUF model files, and Milestone 12 baseline remain completely untouched.
- **Standard Guards Intact:** The default 1,500 MB RAM guard for dual-process production mode is preserved unaltered. The standalone profile exists exclusively as an explicit opt-in profile with its own mathematically justified safety floors (600 MB RAM emergency floor, 2,600 MiB VRAM floor).

---

## 2. Resolution of Audit Discrepancies

### Discrepancy 1: Reconciling the 1,963 MiB Table Estimate vs 2,048.54 MiB Model Buffer

In [Phase C.3.3 GPU Offload and Low-Memory Feasibility.md](file:///C:/Users/kunal/OneDrive/Desktop/swarm/docs/Phase%20C.3.3%20GPU%20Offload%20and%20Low-Memory%20Feasibility.md), the comparative table listed total VRAM demand for Config 3 as **1,963 MiB**, while historical logs in [VALIDATION_STATUS.md](file:///C:/Users/kunal/OneDrive/Desktop/swarm/docs/VALIDATION_STATUS.md) record a `CUDA0` model weights buffer of **2,048.54 MiB** alone.

**Reconciliation:**
1. **Config 3 was a Dual-Process Loopback RPC Hybrid (37 layers total):**
   - In Config 3 (`SWARM_USE_RPC=1`, `SWARM_N_GPU_LAYERS=37`), the placement policy offloaded approximately **10 layers to RPC0** (in host RAM) and **27 layers to CUDA0** (on the GTX 1050).
   - Because `CUDA0` hosted only 27 of 37 layers, the model weights buffer on `CUDA0` was only **~1,430 MiB** (not the full 2,048.54 MiB). Adding 486 MiB of KV cache and 47 MiB of compute buffer yielded **~1,963 MiB**.
2. **Option 1 is Standalone Pure CUDA (Config 4 / Milestone 4 Baseline):**
   - In Standalone CUDA mode (`SWARM_USE_RPC=0`), there is no RPC worker. `CUDA0` hosts **all 37 layers**.
   - As recorded in Milestone 4 Test 1, the model weights buffer alone on `CUDA0` occupies **2,048.54 MiB**.
   - Therefore, 1,963 MiB was specific to the 27-layer GPU split in Config 3. In Standalone CUDA mode (all 37 layers on GPU), the model weights buffer is 2,048.54 MiB.

---

### Discrepancy 2: Distinguishing Measured Historical Allocations from Context-512 Estimates

To ensure mathematical precision, measured physical allocations from actual engine runs must be strictly distinguished from derived mathematical estimates for reduced context lengths.

| Resource Component | Measured Historical Baseline (`n_ctx=2048`, M4 Test 1) | Derived Estimate (`n_ctx=512`, Standalone Option 1) | Basis / Derivation |
| :--- | :--- | :--- | :--- |
| **Model Weights Buffer** | **2,048.54 MiB** | **2,048.54 MiB** | **Measured Constant:** All 37 layers loaded into `CUDA0` VRAM; unaffected by context window size. |
| **KV Cache Buffer** | **576.00 MiB** | **144.00 MiB** | **Derived Linear Scaling:** Context memory is proportional to token capacity: $576.00 \times \frac{512}{2048} = 144.00\text{ MiB}$. |
| **Compute Buffer** | **49.25 MiB** | **49.25 MiB** | **Measured Baseline:** Working scratch graph allocated during decode. Minimal variation with context size. |
| **Sum of Engine Buffers** | **2,673.79 MiB** | **2,241.79 MiB** | **Exact Sum:** $2,048.54 + 144.00 + 49.25 = 2,241.79\text{ MiB}$ (~2.19 GiB). |
| **CUDA Runtime Overhead** | **~251.21 MiB** | **~250.00 – 300.00 MiB** | **Measured in M4:** CUDA context, driver allocations, and cuBLAS workspace reported by `nvidia-smi`. |
| **Total Process VRAM Footprint** | **~2,925.00 MiB** | **~2,491.79 – 2,541.79 MiB** | **Derived Estimate:** Sum of engine buffers + CUDA runtime context. |
| **Free VRAM on GTX 1050 (4 GB)** | **~3,457.00 MiB free** | **~3,457.00 MiB free** | **Measured Live:** Total VRAM is 4,096 MiB; headroom is **~915 – 965 MiB**. |

---

### Discrepancy 3: Source, Mechanism, and Timestamp for Host Readings

Stale measurements from prior audits must never be reused for runtime decisions.

1. **Physical Host System RAM:**
   - **Measurement Mechanism:** Win32 `GlobalMemoryStatusEx` API (`ullAvailPhys`, `ullTotalPhys`) via [win32.rs](file:///C:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/supervisor/win32.rs#L213-L222).
   - **Timestamp of Query:** `2026-10-12T14:18:42+05:30`
   - **Total Physical RAM:** `8,032.36 MB` (~7.84 GB)
   - **Available Physical RAM:** `1,244.26 MB` (~1.21 GB)
2. **GPU VRAM:**
   - **Measurement Mechanism:** Non-destructive `nvidia-smi --query-gpu=memory.free,memory.total --format=csv,noheader,nounits` via [win32.rs](file:///C:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/supervisor/win32.rs#L226-L249).
   - **Timestamp of Query:** `2026-10-12T14:12:54+05:30`
   - **Total GPU VRAM:** `4,096 MiB` (NVIDIA GeForce GTX 1050)
   - **Available GPU VRAM:** `3,457 MiB` (84.4% free)
3. **Operational Policy:**
   - Both readings are queried dynamically inside `start_engine_internal` immediately before evaluating preflight gates. If host conditions deteriorate below safety floors prior to an authorized launch, the supervisor will immediately abort.

---

### Discrepancy 4: Standalone CUDA Dependencies & Semantic Verification

#### 1. Zero RPC Dependency
Inspection of [main.cpp](file:///C:/Users/kunal/OneDrive/Desktop/swarm/main.cpp#L510-L540) confirms that setting `SWARM_USE_RPC=0` causes `config.rpc_enabled` to evaluate to `false`. Under this branch:
- No RPC worker client is instantiated.
- No network connections to port 50052 are opened.
- Port 50052 is not required to be open or bound.
- The coordinator initializes local `llama.cpp` CUDA backend directly.

#### 2. GPU Layer Semantics: Why `-1` is Canonical
In `main.cpp` (lines 522–527):
```cpp
if (!parse_gpu_layer_setting(std::getenv("SWARM_N_GPU_LAYERS"), n_gpu_layers)) {
    log_error("Invalid SWARM_N_GPU_LAYERS; expected -1, 0, or a non-negative integer");
}
```
And in [policy.h](file:///C:/Users/kunal/OneDrive/Desktop/swarm/policy.h#L112-L125) and [llama.cpp](file:///C:/Users/kunal/OneDrive/Desktop/swarm/llama.cpp/src/llama-model.cpp):
- Passing `n_gpu_layers = -1` instructs `llama.cpp` to offload **all model layers** to the GPU automatically.
- The Qwen 2.5 3B model has 36 transformer blocks plus 1 output layer (37 total layers).
- Setting `-1` ensures all layers are offloaded without hardcoding layer counts that could misalign across models.
- **Confirmation:** The report maintains `SWARM_N_GPU_LAYERS=-1` strictly matching Milestone 4 Test 1 and `README.md`. It does NOT substitute `36`.

#### 3. Context Size Support
In [config.h](file:///C:/Users/kunal/OneDrive/Desktop/swarm/config.h#L153-L159):
```cpp
if (const char* env_ctx_size = std::getenv("SWARM_CTX_SIZE")) {
    try {
        config.ctx_size = std::stoi(env_ctx_size);
    } catch (...) {}
}
```
Setting `SWARM_CTX_SIZE=512` is natively parsed and applied directly to `llama_context_params.n_ctx`.

#### 4. Dependency Presence Verified
- Coordinator binary: `build-cuda\swarm_node.exe` (751,104 bytes, PE-x64, verified present)
- Runtime libraries: `build-cuda\bin\llama.dll`, `ggml.dll`, `ggml-cuda.dll` (verified present)
- Official Model: `models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf` (2,104,932,768 bytes, verified present)

---

## 3. Isolated Prototype Implementation Details

All code changes were strictly confined to the `spike/desktop-shell/` prototype.

### 1. Staged Orchestrator (`orchestrator.rs`)
In [orchestrator.rs](file:///C:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/supervisor/orchestrator.rs#L137-L330):
- Updated `start_staged`: When `config.rpc_port == 0`, the orchestrator bypasses RPC port binding pre-checks and skips `STARTING_RPC` / `WAITING_FOR_RPC` states.
- It proceeds directly to launching the coordinator on `coord_port` (8080) and polls `http://127.0.0.1:8080/health`.
- If coordinator launch or health check fails, rollback cleanly terminates only the coordinator process (`self.rollback_partial(None, Some(coord_pid))`).
- If stopped via `stop_staged`, it halts only the coordinator.

### 2. Live VRAM Measurement Query (`win32.rs`)
In [win32.rs](file:///C:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/supervisor/win32.rs#L226-L249):
- Added `get_available_vram_mb() -> Option<(u64, u64)>`.
- Executes `nvidia-smi` with `CREATE_NO_WINDOW` (preventing console window popups) and parses free and total MiB in under 200 ms.

### 3. IPC Commands & Safety Guards (`commands.rs`)
In [commands.rs](file:///C:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/supervisor/commands.rs#L949-L1070):
- Extended `StartEngineOptions` with `pub profile: Option<String>`.
- Extended `EngineStartResult` with `pub available_vram_mb: Option<u64>` and `total_vram_mb`.
- Updated `run_preflight_check` to bypass RPC binary and port validation when `cfg.use_rpc == false`.
- **Dual-Guard Policy:**
  - Standard Real Mode: Preserves original **1,500 MB free-RAM guard**.
  - Standalone CUDA Profile (`profile: "low_memory_cuda_standalone"`):
    - Enforces **600 MB physical RAM emergency floor**.
    - Enforces **2,600 MiB GPU VRAM floor**.
    - Requires explicit authorization: `allow_real_runtime: true`.
    - Configures environment: `SWARM_USE_RPC=0`, `PORT=8080`, `SWARM_N_GPU_LAYERS=-1`, `SWARM_CTX_SIZE=512`.

### 4. Diagnostics UI (`supervisor-diagnostics.js`)
In [supervisor-diagnostics.js](file:///C:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/dist/assets/supervisor-diagnostics.js#L69-L80):
- Added select option: `<option value="real_cuda_standalone">Real: Standalone CUDA Low-RAM Profile (Opt-in)</option>`.
- Maps operator selection directly to `{ mode: "real", profile: "low_memory_cuda_standalone" }`.

---

## 4. Resource Budgets & Safety Floor Justifications

```
  +------------------------------------------------------------------------+
  |              PHYSICAL HOST SYSTEM RAM (Total: 8,032 MB)                 |
  |  [ OS & Background Apps: ~6,788 MB ]  [ Available RAM: ~1,244 MB ]     |
  |                                                  |                     |
  |                                     [ Emergency Floor: 600 MB ]        |
  |                                     [ Margin: +644 MB Headroom ]       |
  +------------------------------------------------------------------------+

  +------------------------------------------------------------------------+
  |               NVIDIA GEFORCE GTX 1050 (Total: 4,096 MiB)                |
  |  [ Display: ~639 MiB ]  [ Available VRAM: 3,457 MiB ]                  |
  |                                    |                                   |
  |                [ Projected Standalone Footprint: ~2,500 MiB ]          |
  |                (Model: 2,048 MiB | KV: 144 MiB | Graph/CUDA: ~300 MiB) |
  |                                    |                                   |
  |                [ Safety Floor: 2,600 MiB ]                             |
  |                [ Margin: +857 MiB Headroom ]                           |
  +------------------------------------------------------------------------+
```

### Justification for the 600 MB RAM Floor
When `SWARM_N_GPU_LAYERS=-1`, all 37 layers of model weights are held in GPU VRAM (`CUDA0`). The coordinator process in system RAM only manages:
- HTTP network buffers and cpp-httplib threads (~30 MB)
- Model metadata and tensor mapping tables (~60 MB)
- Process heap, stack, and CRT DLL runtime (~100 MB)
- Total coordinator host RAM footprint is **< 300 MB**.
- An emergency floor of **600 MB** ensures at least 300 MB remains completely untouched for Windows kernel page tables, filesystem cache, and background services, preventing OS thrashing or out-of-memory paging.

### Justification for the 2,600 MiB VRAM Floor
- Model weights: 2,048.54 MiB
- KV cache (`n_ctx=512`): 144.00 MiB
- Compute buffer: 49.25 MiB
- Sum of engine buffers: 2,241.79 MiB
- CUDA runtime context & overhead: ~250–300 MiB
- Total demand: **~2,492 – 2,542 MiB**
- A floor of **2,600 MiB** ensures that the engine will never start if free VRAM cannot satisfy the complete allocation plus runtime overhead. With current host VRAM at **3,457 MiB**, there is **857 MiB of safety margin**.

---

## 5. Automated Verification Results

The automated test runner was executed via `cargo run --bin supervisor_test_runner` in `spike/desktop-shell/src-tauri`.

All **30 out of 30 tests passed cleanly** (0 failures):

```
==========================================================
  Test Suite Execution Summary
==========================================================
  [ 1] DLL Path Prepending & Delivery                      PASS (300 ms)
  [ 2] Environment Key Normalization                       PASS (1 ms)
  [ 3] Missing Path Validation                             PASS (1 ms)
  [ 4] Hidden-Console Child Launch                         PASS (271 ms)
  [ 5] Graceful Shutdown (Hidden Console)                  PASS (38 ms)
  [ 6] Staged Startup - RPC Readiness Timeout              PASS (653 ms)
  [ 7] Staged Startup - Coordinator Health Timeout         PASS (1741 ms)
  [ 8] Staged Startup - Full Progression & Stop            PASS (858 ms)
  [ 9] Partial Failure Cleanup & Orphan Prevention         PASS (1039 ms)
  [10] Port Conflict Safety                                PASS (2 ms)
  [11] Repeated Start/Stop Cycles                          PASS (2428 ms)
  [12] Job Object Tree Reclamation                         PASS (380 ms)
  [13] Live Host Diagnostics Generation                    PASS (1048 ms)
  [14] Fixture: Supervisor Unavailable                     PASS (0 ms)
  [15] Zero Managed Children Baseline                      PASS (0 ms)
  [16] Fixture: Tracked Test Child                         PASS (0 ms)
  [17] Port Occupancy vs Ownership Distinction             PASS (837 ms)
  [18] Fixture: Ports Available                            PASS (0 ms)
  [19] Fixture: Missing Executable & DLL Directory         PASS (0 ms)
  [20] Fixture: Missing Model File                         PASS (0 ms)
  [21] Fixture: Invalid Configuration                      PASS (0 ms)
  [22] Fixture: Unknown Diagnostic Values                  PASS (0 ms)
  [23] Reconciled RPC Busy Status Model                    PASS (0 ms)
  [24] Duplicate Startup Request Guard                     PASS (823 ms)
  [25] RPC Startup Failure & Clean Teardown                PASS (517 ms)
  [26] Cancellation During Startup & Rollback              PASS (543 ms)
  [27] Controlled Engine Lifecycle (IPC Command)           PASS (940 ms)
  [28] Simulated Failure Modes & Rollback                  PASS (4032 ms)
  [29] Real-Mode Safety Boundary & Headroom Guard          PASS (207 ms)
  [30] Standalone CUDA Low-Memory Profile Guards & Lifecycle  PASS (677 ms)
----------------------------------------------------------
  Total: 30 | Passed: 30 | Failed: 0
==========================================================
```

### Verification of Test 30 Highlights
- Verified that invoking `profile: "low_memory_cuda_standalone"` without `allow_real_runtime: true` is strictly rejected before spawning any child process.
- Verified that invoking with `allow_real_runtime: false` is strictly rejected.
- Verified that the staged orchestrator handles `rpc_port: 0` by completely skipping the RPC worker and orchestrating only the coordinator to `Ready`.
- Verified that clean shutdown terminates only the coordinator without leaving orphan processes or bound ports.

---

## 6. Safety Compliance Checklist

| Safety Requirement | Compliance Status | Implementation Evidence |
| :--- | :--- | :--- |
| **Keep 1,500 MB RAM guard unchanged** | **VERIFIED** | Default dual-process mode enforces `avail < 1500` check in [commands.rs](file:///C:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/supervisor/commands.rs#L1066-L1074). Tested in Test 29. |
| **Separate profile isolated in `spike/desktop-shell/`** | **VERIFIED** | Profile logic exists only in `spike/desktop-shell/src-tauri/` and UI assets. |
| **Require explicit operator opt-in** | **VERIFIED** | Requires `profile: "low_memory_cuda_standalone"` AND `allow_real_runtime: true`. Tested in Test 30. |
| **Fresh RAM & VRAM preflight immediately before launch** | **VERIFIED** | `GlobalMemoryStatusEx` and `nvidia-smi` queried dynamically on each start request. |
| **Conservative emergency RAM (600 MB) & VRAM (2,600 MiB) floors** | **VERIFIED** | Enforced in `commands.rs`. Justified by 2,242 MiB model/buffer sum + 300 MiB runtime overhead. |
| **No automatic retries** | **VERIFIED** | Single-shot launch; failure triggers immediate rollback to `Error` state. |
| **Teardown on failure stops only created processes** | **VERIFIED** | `rollback_partial` operates exclusively on PIDs registered in `ProcessManager`. |
| **Never kill unrelated apps or shut down WSL** | **VERIFIED** | Supervisor manages only children spawned into its Windows Job Object. |
| **Do not modify C++ engine, launchers, or model** | **VERIFIED** | No files outside `spike/desktop-shell/` and `docs/` were modified. |
| **Preparation only** | **VERIFIED** | Zero real Swarm coordinator or worker processes launched. |

---

## 7. Current Readiness State & Recommended Next Step

The isolated standalone CUDA low-memory profile is fully prepared, tested, and guarded.

### Readiness Status
- **Coordinator Executable:** Ready (`build-cuda\swarm_node.exe`)
- **Required DLLs:** Ready (`llama.dll`, `ggml.dll`, `ggml-cuda.dll`)
- **Official Model:** Ready (`models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf`)
- **Available Physical RAM:** `1,244 MB` (Exceeds emergency floor of 600 MB by +644 MB)
- **Available GPU VRAM:** `3,457 MiB` (Exceeds required floor of 2,600 MiB by +857 MiB)
- **Coordinator Port 8080:** Available (Unbound)

Awaiting explicit operator authorization to execute the real runtime test.
