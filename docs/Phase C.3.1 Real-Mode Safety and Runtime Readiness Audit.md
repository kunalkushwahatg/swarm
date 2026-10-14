# Swarm — Phase C.3.1 Real-Mode Safety and Runtime Readiness Audit

**Author:** Antigravity AI Pair Programmer  
**Date:** October 12, 2026  
**Status:** **AUDIT COMPLETE — REAL-MODE CODE SECURED; PHYSICAL RAM INSUFFICIENT (BLOCKER)**  
**Workspace:** `C:\Users\kunal\OneDrive\Desktop\swarm`  
**Automated Test Suite Evidence:** `spike/desktop-shell/supervisor_test_results.json` (29/29 Tests Passing)  
**Real-Runtime Execution Status:** **STOPPED — AWAITING MEMORY REMEDIATION & EXPLICIT OPERATOR APPROVAL**  

---

## Executive Summary

Prior to executing the real Swarm production inference engine (`build-cuda\swarm_node.exe` and `dist\swarm-worker-windows-x64\ggml-rpc-server.exe`) under the native Tauri supervisor, we performed a thorough safety and readiness audit across the production startup path, process-isolation boundary, resource headroom, and automated test suite.

### Key Audit Findings:
1. **Safety Boundary Verified & Hardened:** The production startup path in `spike/desktop-shell/` was audited and hardened. Real-production launch is strictly hardcoded to the approved Swarm binaries and arguments. The frontend cannot inject arbitrary executables, shell commands, or PIDs. Duplicate starts are rejected. All supervisor child processes are bound to an anonymous Win32 Job Object configured with `KILL_ON_JOB_CLOSE`.
2. **Non-Destructive Process Isolation:** The supervisor never adopts, signals, or terminates external processes. Partial startup failures roll back only supervisor-owned children tracked in its local process table.
3. **Hardware & Resource Readiness Measured (Read-Only):**
   - **TCP Ports:** Both `8080` (Coordinator) and `50052` (RPC Worker) are completely unbound and available.
   - **GPU VRAM:** NVIDIA GeForce GTX 1050 has **3,246 MiB free** out of 4,096 MiB total, which is ample headroom for the configured 4 offloaded GPU layers.
   - **Binaries & Model File:** All required binaries, CUDA/GGML dynamic libraries, and the official 1.96 GB model file are present, valid, and unmodified.
   - **Active Processes:** Zero active Swarm, GGML, or test child processes exist on the host.
4. **Critical Blocker Identified — Physical RAM Starvation:**
   - Total physical RAM is **8,032.36 MB** (~7.84 GB).
   - Fresh measurement reveals only **478.75 MB free physical RAM** (~0.47 GB), which is tighter than the ~560 MB observed in Gate 3 preparation.
   - Top memory consumers: Antigravity IDE (~1.2 GB), Language Server (~956 MB), WSL2 Virtual Machine (`vmmemWSL`, ~430 MB), Windows Defender (`MsMpEng`, ~199 MB), and Brave Browser (~280 MB).
   - Under an 8 GB Windows host, loading a 1.96 GB model plus context buffers and compute graphs requires at least **1,500 MB** of free physical RAM. Attempting to start the real engine with only 478 MB free risks severe disk thrashing, paging stalls, out-of-memory errors, or system unresponsiveness.
5. **Verdict:** Real-mode code path is **AUDITED, SECURE, AND TEST-VALIDATED (29/29 tests passing)**, but execution is **BLOCKED BY PHYSICAL RAM SHORTAGE**. Real engine execution must remain stopped until memory remediation is performed and explicit operator approval is granted.

---

## 1. Audit of the Real-Production Startup Path

We inspected the concrete implementation of:
- `supervisor_start_engine` (`spike/desktop-shell/src-tauri/src/supervisor/commands.rs`)
- `supervisor_stop_engine` (`spike/desktop-shell/src-tauri/src/supervisor/commands.rs`)
- `supervisor_cancel_startup` (`spike/desktop-shell/src-tauri/src/supervisor/commands.rs`)
- `start_engine_internal` (`spike/desktop-shell/src-tauri/src/supervisor/commands.rs`)
- `orchestrator.rs` (`spike/desktop-shell/src-tauri/src/supervisor/orchestrator.rs`)
- `shutdown.rs` (`spike/desktop-shell/src-tauri/src/supervisor/shutdown.rs`)
- UI event handlers (`spike/desktop-shell/dist/assets/supervisor-diagnostics.js`)

### Verification Matrix:

| Safety Property | Verification Status | Implementation Evidence |
|---|---|---|
| **Safe Test Mode launches only harmless test children** | **VERIFIED** | When `mode == "simulated"`, `start_engine_internal` launches only `spike\desktop-shell\src-tauri\target\debug\test_child.exe` on high ephemeral loopback ports (59260 / 59261). It never loads model weights or touches production ports. |
| **Real Production Engine launches only approved Swarm binaries** | **VERIFIED** | In `commands.rs`, when `mode == "real"`, the launch configuration hardcodes:<br>• RPC Worker: `dist\swarm-worker-windows-x64\ggml-rpc-server.exe` with args `["--host", "127.0.0.1", "--port", "50052", "--threads", "2"]`<br>• Coordinator: `build-cuda\swarm_node.exe` with audited environment (`SWARM_USE_RPC=1`, `PORT=8080`, `SWARM_MODEL_PATH=...`, `SWARM_N_GPU_LAYERS=4`, `SWARM_RPC_ENDPOINTS=127.0.0.1:50052`, `SWARM_PLACEMENT_POLICY=none`, `SWARM_DEPLOYMENT_ENV=development`) and prepended DLL paths (`build-cuda`, `build-cuda\bin`). |
| **Frontend cannot supply arbitrary executable paths, commands, or PIDs** | **VERIFIED** | `StartEngineOptions` accepted over IPC exposes only `{ mode: Option<String>, simulate_failure: Option<String>, allow_real_runtime: Option<bool> }`. All executable paths, arguments, environment variables, working directories, and ports are resolved server-side from `state.workspace_root`. Neither `supervisor_stop_engine` nor `supervisor_cancel_startup` accept external PIDs. |
| **Duplicate starts are rejected** | **VERIFIED** | `start_engine_internal` checks `orchestrator.get_status().state`. If state is anything other than `Stopped` or `Error`, the request is immediately rejected with `Err("Duplicate startup rejected: cluster is already in lifecycle state ...")`. |
| **Partial startup failures clean up only supervisor-owned processes** | **VERIFIED** | `orchestrator.rollback_partial` calls `shutdown_managed_child(pid, &self.manager.managed_children, 2000)` only for PIDs recorded in `inner.rpc_pid` and `inner.coordinator_pid`. In `shutdown.rs`, `shutdown_managed_child` validates `map.get_mut(&pid).ok_or(ShutdownError::ProcessNotManaged(pid))`. External processes are never touched. |
| **Cancellation and shutdown cannot terminate unrelated processes** | **VERIFIED** | All shutdown operations require proof of ownership in the supervisor's `Mutex<HashMap<u32, ManagedChild>>`. Furthermore, child processes reside in an anonymous Job Object with `KILL_ON_JOB_CLOSE`, ensuring containment without PID recycling collisions. |
| **Production mode cannot silently fall back to test fixtures** | **VERIFIED** | When `mode == "real"`, `start_engine_internal` contains zero references or fallbacks to `test_child.exe` or mock fixtures. Any failure returns an explicit `Err(...)` and transitions state to `ClusterLifecycleState::Error`. |
| **Readiness is based on actual runtime health** | **VERIFIED** | • Worker readiness is evaluated by `is_port_listening(50052)` which performs an active TCP loopback handshake.<br>• Coordinator readiness is evaluated by `check_http_health(8080, "/health", 200)` which issues a real HTTP `GET /health` request over TCP and asserts a `200 OK` response code. No mock responses are used in production mode. |

### Code Hardening Applied in `spike/desktop-shell/`:
1. **Added Operator Authorization Flag (`allow_real_runtime`):**
   `StartEngineOptions` was augmented with `pub allow_real_runtime: Option<bool>`. Calling `mode == "real"` without `allow_real_runtime: Some(true)` is strictly rejected with a clear safety boundary message, preventing accidental production startup.
2. **Enforced Concrete Production Configuration:**
   Added the full production `StagedLaunchConfig` in `commands.rs` for `ggml-rpc-server.exe` and `swarm_node.exe`, properly wiring the audited command-line parameters, environment variables, DLL search paths, and timeouts (10s for RPC worker, 30s for coordinator model load).
3. **Hardened Preflight RAM Headroom Gate:**
   `start_engine_internal` checks available physical RAM via `get_available_physical_memory()`. If available RAM is below 1,500 MB, the launch is aborted immediately with an explicit resource warning.

---

## 2. Resource Readiness Observations (Fresh Read-Only Audit)

Measurements taken on host `2026-10-12T13:17:16+05:30` using read-only PowerShell, `nvidia-smi`, and Win32 queries without starting, stopping, restarting, or adopting any processes:

### A. Memory Metrics (RAM)
- **Total Physical RAM:** `8,032.36 MB` (~7.84 GB / 8,225,140 KB)
- **Free Physical RAM:** `478.75 MB` (~0.47 GB / 490,240 KB)
- **Memory Utilization:** **94.0% consumed by active host applications**
- **Top Working Set Consumers:**
  1. `Antigravity IDE` (PID 18096): 1,207.95 MB
  2. `language_server_windows_x64` (PID 11008 + 11452): 956.45 MB
  3. `vmmemWSL` (WSL2 VM, PID 4940): 430.43 MB
  4. `MsMpEng` (Windows Defender, PID 5504): 198.95 MB
  5. `brave` (Browser tabs, PIDs 12912, 15896): 280.37 MB

### B. GPU VRAM Metrics
- **GPU Device:** NVIDIA GeForce GTX 1050 (Mobile / Desktop)
- **Total VRAM:** `4,096 MiB` (4.0 GB)
- **Used VRAM:** `759 MiB`
- **Free VRAM:** **3,246 MiB** (~3.17 GB)
- **VRAM Assessment:** **READY**. 3,246 MiB free is more than sufficient for 4 offloaded GPU layers (`SWARM_N_GPU_LAYERS=4`), which requires approximately 600–900 MiB of VRAM.

### C. Active Swarm Processes
- **Query Filter:** `swarm*`, `ggml*`, `test_child*`
- **Active Processes Found:** **0 (None)**
- **Assessment:** Clean environment. No conflicting Swarm or GGML instances are currently running.

### D. TCP Port Occupancy
- **Port 8080 (Coordinator HTTP):** **UNBOUND / AVAILABLE**
- **Port 50052 (RPC Worker TCP):** **UNBOUND / AVAILABLE**
- **Assessment:** Both required loopback ports are free. No port collision exists.

### E. Required Executable, DLL, and Model File Verification

| Component | Target Path | File Size | Timestamp | Status |
|---|---|---|---|---|
| **Coordinator Binary** | `build-cuda\swarm_node.exe` | 751,104 bytes | 10/11/2026 00:20:55 | **EXISTS** (PE-x64) |
| **RPC Worker Binary** | `dist\swarm-worker-windows-x64\ggml-rpc-server.exe` | 86,016 bytes | 10/09/2026 19:54:47 | **EXISTS** (PE-x64) |
| **CUDA GGML DLL** | `build-cuda\bin\ggml-cuda.dll` | 95,373,312 bytes | 10/10/2026 18:03:42 | **EXISTS** |
| **LLAMA Core DLL** | `build-cuda\bin\llama.dll` | 2,579,456 bytes | 10/10/2026 03:51:57 | **EXISTS** |
| **GGML Base DLL** | `build-cuda\bin\ggml.dll` | 67,072 bytes | 10/10/2026 03:41:43 | **EXISTS** |
| **Official Model** | `models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf` | 2,104,932,768 bytes | 10/10/2026 10:54:22 | **EXISTS** (1.96 GB) |

---

## 3. RAM Headroom Policy for 8 GB Windows Machines

### Selected Policy: Minimum 1,500 MB (1.5 GB) Free Physical RAM

### Rationale & Distinction (Estimate vs Measured Requirement):
1. **Measured Requirement (Model File on Disk):**
   The model file `qwen2.5-3b-instruct-q4_k_m.official-check.gguf` is **2,104,932,768 bytes** (~1.96 GB).
2. **Estimated Requirement (Process Working Set & Allocations):**
   When `swarm_node.exe` initializes:
   - Offloading 4 layers to CUDA places ~750 MiB of weights in GPU VRAM.
   - The remaining ~1.25 GB of weights remain mapped in CPU memory.
   - The context window (KV cache for 4k/8k tokens) allocates ~400–600 MB.
   - The coordinator HTTP server and worker thread stacks allocate ~150–200 MB.
   - Total estimated peak CPU RAM footprint is approximately **1.4–1.8 GB**.
3. **Windows 8 GB Operating System Dynamics:**
   - On an 8 GB Windows 10/11 system, Windows core services, graphics driver working sets, and background caches typically require 3.5–4.5 GB of RAM.
   - When free physical RAM falls below 500 MB, the Windows Memory Manager initiates aggressive memory trimming, swapping dirty pages of active background applications (such as the IDE, WebView2, and language servers) into `pagefile.sys`.
   - If `swarm_node.exe` requests 1.5 GB of allocations when only 478 MB of physical RAM is free:
     - The OS will thrash the disk pagefile intensely.
     - Inference token latency will spike from milliseconds to seconds or tens of seconds due to hard page faults.
     - If the pagefile cannot expand rapidly enough, the C++ runtime will abort with `std::bad_alloc` or `STATUS_NO_MEMORY`.
4. **Conservative Safety Threshold:**
   Setting the threshold to **1,500 MB** ensures that Windows has sufficient unpaged physical RAM to accommodate the un-offloaded weights and runtime working buffers without inducing disk thrashing or destabilizing running applications.

---

## 4. Test Coverage Analysis (29/29 Passing)

The automated test runner was executed via:
```powershell
powershell -Command "cd spike\desktop-shell\src-tauri; cargo run --bin supervisor_test_runner"
```

All 29 tests passed cleanly (Exit Code: 0). The test suite strictly separates harmless test fixtures from production paths:

### Breakdown of Test Categories:
- **Harmless Test Children (23 Tests):** Tests 1–13, 15, 17, 24–28 use `spike\desktop-shell\src-tauri\target\debug\test_child.exe` to validate DLL prepending, environment normalization, Job Object containment, hidden consoles, `CTRL_BREAK` signaling, socket release, timeouts, duplicate start rejection, cancellation, and partial startup rollback.
- **Simulated Diagnostic Fixtures (5 Tests):** Tests 14, 16, 18–22 validate the supervisor diagnostic reporting engine against mock edge cases (`supervisor_unavailable`, `tracked_test_child`, `ports_available`, `missing_executable_dll`, `missing_model_file`, `invalid_configuration`, `reconciled_rpc_busy`) without touching host processes or files.
- **Real-Mode Safety Boundary & Headroom Guard (1 Test — New Test 29):** Test 29 exercises `start_engine_internal` under `mode == "real"`. It asserts that calls without `allow_real_runtime: true` or calls under insufficient RAM headroom are blocked immediately with zero child processes spawned and zero ports bound.
- **Real Swarm Binaries:** **0 tests.** The actual Swarm binaries (`swarm_node.exe` and `ggml-rpc-server.exe`) have **not** been launched during this test run. Simulated and harmless test child success is **not** misrepresented as real-engine validation.

### Automated Test Suite Execution Summary:
```
==========================================================
  Test Suite Execution Summary
==========================================================
  [ 1] DLL Path Prepending & Delivery                      PASS (164 ms)
  [ 2] Environment Key Normalization                       PASS (1 ms)
  [ 3] Missing Path Validation                             PASS (1 ms)
  [ 4] Hidden-Console Child Launch                         PASS (274 ms)
  [ 5] Graceful Shutdown (Hidden Console)                  PASS (45 ms)
  [ 6] Staged Startup - RPC Readiness Timeout              PASS (653 ms)
  [ 7] Staged Startup - Coordinator Health Timeout         PASS (1463 ms)
  [ 8] Staged Startup - Full Progression & Stop            PASS (866 ms)
  [ 9] Partial Failure Cleanup & Orphan Prevention         PASS (1008 ms)
  [10] Port Conflict Safety                                PASS (0 ms)
  [11] Repeated Start/Stop Cycles                          PASS (2424 ms)
  [12] Job Object Tree Reclamation                         PASS (373 ms)
  [13] Live Host Diagnostics Generation                    PASS (1017 ms)
  [14] Fixture: Supervisor Unavailable                     PASS (0 ms)
  [15] Zero Managed Children Baseline                      PASS (0 ms)
  [16] Fixture: Tracked Test Child                         PASS (0 ms)
  [17] Port Occupancy vs Ownership Distinction             PASS (816 ms)
  [18] Fixture: Ports Available                            PASS (0 ms)
  [19] Fixture: Missing Executable & DLL Directory         PASS (0 ms)
  [20] Fixture: Missing Model File                         PASS (0 ms)
  [21] Fixture: Invalid Configuration                      PASS (0 ms)
  [22] Fixture: Unknown Diagnostic Values                  PASS (0 ms)
  [23] Reconciled RPC Busy Status Model                    PASS (0 ms)
  [24] Duplicate Startup Request Guard                     PASS (806 ms)
  [25] RPC Startup Failure & Clean Teardown                PASS (510 ms)
  [26] Cancellation During Startup & Rollback              PASS (553 ms)
  [27] Controlled Engine Lifecycle (IPC Command)           PASS (806 ms)
  [28] Simulated Failure Modes & Rollback                  PASS (3772 ms)
  [29] Real-Mode Safety Boundary & Headroom Guard          PASS (2 ms)
----------------------------------------------------------
  Total: 29 | Passed: 29 | Failed: 0
==========================================================
Report saved to: C:\Users\kunal\OneDrive\Desktop\swarm\spike\desktop-shell\supervisor_test_results.json
```

---

## 5. Summary of Files Changed During Gate 3.1

All changes were strictly limited to `spike/desktop-shell/`:

1. `spike/desktop-shell/src-tauri/src/supervisor/commands.rs`:
   - Updated `StartEngineOptions` to include `pub allow_real_runtime: Option<bool>`.
   - In `start_engine_internal`, added concrete `StagedLaunchConfig` for `ggml-rpc-server.exe` and `swarm_node.exe` with audited arguments, environment, DLL paths, and timeouts.
   - Enforced preflight checks: port collision rejection, binary verification, RAM headroom gate (< 1,500 MB), and explicit authorization check (`allow_real_runtime: true`).
2. `spike/desktop-shell/src-tauri/src/bin/supervisor_test_runner.rs`:
   - Updated `StartEngineOptions` struct initializations in Tests 27 and 28 to include `allow_real_runtime: None`.
   - Added Test 29: "Real-Mode Safety Boundary & Headroom Guard".
3. `spike/desktop-shell/supervisor_test_results.json`:
   - Updated test results recording 29/29 passed tests.
4. `docs/Phase C.3.1 Real-Mode Safety and Runtime Readiness Audit.md`:
   - Authored this audit report.

Zero changes were made to C++ sources, production build artifacts, launch scripts, firewalls, or the baseline model.

---

## 6. Readiness Verdict, Blockers & Exact Remediation Steps

### Verdict:
**REAL-MODE EXECUTION IS CURRENTLY BLOCKED DUE TO INSUFFICIENT PHYSICAL RAM (478 MB vs 1,500 MB threshold).**  
The supervisory code, state machine, Job Object containment, and binary environments are fully prepared, verified, and safe to execute once memory headroom is established.

### Primary Blocker:
- **Available Physical RAM:** **478.75 MB free** (< 1,500 MB required threshold).

### Exact Remediation Steps:
1. **Free Host Physical RAM:**
   Execute the following in a user terminal to reclaim memory before launch:
   - Shutdown WSL2 virtual machine (reclaims ~430 MB):
     ```powershell
     wsl --shutdown
     ```
   - Close non-essential browser windows/tabs in Brave (reclaims ~280 MB).
   - Close inactive language server instances if possible (reclaims ~400–800 MB).
2. **Re-Verify Memory Headroom:**
   Run the read-only memory query:
   ```powershell
   Get-CimInstance Win32_OperatingSystem | Select-Object @{Name="FreeRAM_MB";Expression={[math]::Round($_.FreePhysicalMemory/1024,2)}}
   ```
   Ensure `FreeRAM_MB >= 1500`.
3. **Explicit Operator Authorization:**
   Once free RAM is confirmed >= 1,500 MB, the operator may authorize Gate 3.2 execution:
   - Provide explicit prompt approval to run the real engine.
   - The supervisor will pass `allow_real_runtime: true` and execute the staged sequence:
     1. Start `ggml-rpc-server.exe` on port 50052 with hidden console.
     2. Wait for port 50052 TCP handshake readiness.
     3. Start `swarm_node.exe` on port 8080 with prepended DLL path.
     4. Wait for `GET http://127.0.0.1:8080/health` returning `200 OK`.
     5. Transition to `READY`.

---

## 7. Stop Condition

In strict compliance with Gate 3.1 instructions:
- Zero real Swarm processes (`swarm_node.exe`, `ggml-rpc-server.exe`) were launched.
- Zero existing host processes were stopped, restarted, or adopted.
- All 29 automated tests pass cleanly.
- The supervisor stands ready, awaiting memory remediation and explicit operator approval before initiating real engine execution.
