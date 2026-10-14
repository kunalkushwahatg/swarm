# Swarm — Phase C.3 Gate 3 Controlled Startup Preparation Report

**Author:** Antigravity AI Pair Programmer  
**Date:** October 12, 2026  
**Status:** **GATE 3 PREPARED & TEST-VALIDATED (28/28 AUTOMATED TESTS PASSING, ZERO REAL PROCESSES LAUNCHED)**  
**Workspace:** `C:\Users\kunal\OneDrive\Desktop\swarm`  
**Test Evidence:** `spike/desktop-shell/supervisor_test_results.json`  
**Screenshot Evidence:** `artifacts/spike_screenshots/gate3_controlled_startup_window.png`  
**Real-Runtime Approval Status:** **PENDING EXPLICIT OPERATOR APPROVAL**  

---

## Executive Summary

Phase C.2.3 concluded Gate 2 with read-only supervisor diagnostics, strict 5-layer architectural separation, and verified preflight truth.

Under user authorization for **Gate 3 (Controlled Startup Integration Preparation)**, we implemented and validated explicit, user-triggered engine startup controls within the isolated Tauri desktop shell (`spike/desktop-shell/`). All changes remain strictly confined to the desktop spike. No production inference engine sources, launch scripts, or Milestone 12 baselines were modified.

Key achievements of Gate 3 preparation:
1. **Explicit User-Triggered Lifecycle Controls:** Added `supervisor_start_engine`, `supervisor_stop_engine`, `supervisor_cancel_startup`, and `supervisor_get_engine_status` Tauri IPC commands. **Zero processes start automatically when the desktop window opens.**
2. **Strict Native State Machine & Rollback:** Implemented staged multi-process orchestration (`STOPPED` -> `STARTING_RPC` -> `WAITING_FOR_RPC` -> `STARTING_COORDINATOR` -> `WAITING_FOR_COORDINATOR` -> `READY` -> `STOPPING` -> `ERROR`). Any failure or cancellation triggers instant kernel-level rollback of only supervisor-owned children via Windows Job Objects.
3. **Comprehensive State Machine Test Suite (28/28 Passing):** Expanded automated test suite from 23 to 28 tests using harmless test children and mock HTTP listeners to validate duplicate request guards, immediate RPC crash detection, in-flight cancellation, full sequential progression, port conflict protection, and simulated failure modes.
4. **Physical RAM Headroom Guard:** Integrated non-intrusive memory querying via Win32 `GlobalMemoryStatusEx`. The supervisor checks physical RAM headroom (recommending >= 1,500 MB free for the 1.96 GB model) before approving real runtime startup.
5. **Real-Runtime Isolation & Stop Condition:** Real Swarm binaries (`swarm_node.exe` and `ggml-rpc-server.exe`) have **not** been launched. Real-runtime execution is safely gated pending explicit operator authorization.

---

## 1. Files Modified and Created

All implementation work was strictly confined to `spike/desktop-shell/`:

| File Path | Nature of Change | Summary of Modifications |
|---|---|---|
| `spike/desktop-shell/src-tauri/src/supervisor/win32.rs` | Modified | Added Win32 `MEMORYSTATUSEX` struct and `GlobalMemoryStatusEx` binding, providing fast, read-only physical RAM querying via `get_available_physical_memory()`. |
| `spike/desktop-shell/src-tauri/src/supervisor/orchestrator.rs` | Modified | Integrated thread-safe cooperative cancellation (`cancel_flag: Arc<AtomicBool>`) and exposed `request_cancel()`. Both RPC and coordinator waiting loops immediately abort and roll back on cancellation. |
| `spike/desktop-shell/src-tauri/src/supervisor/commands.rs` | Modified | Added `StartEngineOptions`, `EngineStartResult`, `start_engine_internal`, `stop_engine_internal`, `cancel_startup_internal`, and exposed Tauri commands `supervisor_start_engine`, `supervisor_stop_engine`, `supervisor_cancel_startup`, `supervisor_get_engine_status`. |
| `spike/desktop-shell/src-tauri/src/lib.rs` | Modified | Registered `supervisor_start_engine`, `supervisor_stop_engine`, `supervisor_cancel_startup`, and `supervisor_get_engine_status` in Tauri IPC `generate_handler!`. |
| `spike/desktop-shell/dist/assets/supervisor-diagnostics.js` | Modified | Added Gate 3 Engine Lifecycle panel with `Start Engine`, `Stop Engine`, and `Cancel` buttons, mode selector, 4-stage visual progress stepper, RAM headroom display, and automated error/recovery guidance box. |
| `spike/desktop-shell/src-tauri/src/bin/supervisor_test_runner.rs` | Modified | Appended Tests 24–28 covering duplicate start rejection, RPC crash teardown, in-flight cancellation, full IPC command lifecycle, and simulated failure rollbacks. |
| `spike/desktop-shell/supervisor_test_results.json` | Updated | Recorded machine-readable execution results for all 28 passing tests. |
| `artifacts/spike_screenshots/gate3_controlled_startup_window.png` | Created | Fresh visual evidence showing Gate 3 UI controls rendered in the Tauri WebView2 window. |
| `docs/Phase C.3 Gate 3 Controlled Startup Preparation Report.md` | Created | This comprehensive Gate 3 preparation and validation report. |

---

## 2. Startup State Machine Behavior

The supervisor orchestrator manages an explicit state machine with strict transition guards:

```
[STOPPED] ────────────> [STARTING_RPC] ────────────> [WAITING_FOR_RPC]
   ▲                          │                             │
   │                          │ (spawn fail)                │ (timeout / crash)
   │                          ▼                             ▼
   │                     [ROLLBACK] <───────────────────────┘
   │                          │
   │                          ▼
   │                      [ERROR]
   │
   └──────────────────── [STOPPED] <────────────────────────┐
                              ▲                             │ (stop_staged)
                              │                             │
[READY] <────────── [WAITING_FOR_COORDINATOR] <── [STARTING_COORDINATOR]
                              │                             │
                              │ (timeout / crash)           │ (spawn fail)
                              ▼                             ▼
                         [ROLLBACK] <───────────────────────┘
                              │
                              ▼
                          [ERROR]
```

### Verified Behaviors Across All 10 Target Scenarios:
1. **Explicit Start Engine Requests:** User must explicitly invoke `supervisor_start_engine`. Zero background or automatic launches occur.
2. **Duplicate Startup Guard:** If startup is invoked while the cluster is already in `StartingRpc`, `WaitingForRpc`, `StartingCoordinator`, `WaitingForCoordinator`, `Ready`, or `Stopping`, the request is immediately rejected with `Err("Duplicate startup rejected: cluster is already in lifecycle state ...")`. Existing child processes remain unharmed.
3. **RPC Startup Failure:** If the RPC executable crashes immediately (e.g. exit code 42), the supervisor detects process death within 100 ms, triggers partial rollback, marks state `Error`, and never attempts to launch the coordinator.
4. **RPC Readiness Timeout:** If the RPC process runs but fails to bind its listening socket within the configured timeout (default: 2,000 ms), the supervisor aborts, terminates the RPC process gracefully (or forcibly via Job Object), and rolls back to `Error`.
5. **Coordinator Startup Failure:** If the coordinator crashes during initialization, the supervisor detects exit, immediately rolls back the running RPC worker via `CTRL_BREAK`, transitions to `Error`, and leaves 0 orphan processes.
6. **Coordinator Health Timeout:** If the coordinator process starts but its HTTP endpoint does not return `200 OK` within timeout, the supervisor stops the coordinator, stops the RPC worker, reclaims all ports, and transitions to `Error`.
7. **Partial-Startup Rollback:** Tested under multiple failure modes. In every failure case, only processes created by this supervisor instance are shut down. Third-party processes remain completely untouched.
8. **Existing-Port Conflicts:** Before launching any process, `is_loopback_port_available` tests loopback ports. If port 8080 or 50052 is occupied, startup aborts immediately with `Port Conflict` without killing the port owner.
9. **Cancellation During Startup:** When the operator clicks `Cancel` or calls `supervisor_cancel_startup`, the atomic cancellation flag interrupts the active wait loop, rolls back active children, releases ports, and transitions to `Stopped`.
10. **Repeated Start and Stop Cycles:** Verified across 3 consecutive cycles: `Stopped` -> `Ready` -> `Stopped` -> `Ready` -> `Stopped` -> `Ready` -> `Stopped` with clean port and process reclamation each time.

---

## 3. Automated Test Suite Execution Evidence (28/28 Passing)

Executed via:
```powershell
powershell -Command "cd spike\desktop-shell\src-tauri; cargo run --bin supervisor_test_runner"
```

All 28 tests passed with exit code 0:

| # | Test Scenario Name | Category | Status | Duration | Key Assertion |
|---|---|---|---|---|---|
| 1 | DLL Path Prepending & Delivery | Gate 1 | **PASS** | 323 ms | Verified `build-cuda` and `bin` prepended to child `PATH` |
| 2 | Environment Key Normalization | Gate 1 | **PASS** | 1 ms | Case-insensitive deduplication and normalization |
| 3 | Missing Path Validation | Gate 1 | **PASS** | 2 ms | Missing executable, working directory, and DLLs rejected |
| 4 | Hidden-Console Child Launch | Gate 1 | **PASS** | 280 ms | `SW_HIDE` with `CREATE_NEW_CONSOLE` verified |
| 5 | Graceful Shutdown (Hidden Console) | Gate 1 | **PASS** | 10 ms | `CTRL_BREAK_EVENT` shutdown in 10 ms |
| 6 | Staged Startup - RPC Readiness Timeout | Gate 1 | **PASS** | 678 ms | RPC readiness timeout rolls back to `ERROR` |
| 7 | Staged Startup - Coordinator Health Timeout | Gate 1 | **PASS** | 1480 ms | Health timeout rolls back both processes cleanly |
| 8 | Staged Startup - Full Progression & Stop | Gate 1 | **PASS** | 886 ms | Reached `READY`, HTTP 200 verified, clean teardown |
| 9 | Partial Failure Cleanup & Orphan Prevention | Gate 1 | **PASS** | 1020 ms | Coordinator crash triggers rollback with 0 orphans |
| 10 | Port Conflict Safety | Gate 1 | **PASS** | 0 ms | Aborts startup without terminating external port owner |
| 11 | Repeated Start/Stop Cycles | Gate 1 | **PASS** | 2414 ms | 3 consecutive start/stop cycles succeed cleanly |
| 12 | Job Object Tree Reclamation | Gate 1 | **PASS** | 382 ms | Job Object drop reclaims all descendant processes |
| 13 | Live Host Diagnostics Generation | Gate 2 | **PASS** | 1272 ms | Non-destructive diagnostics with 0 managed children; truthful port labels |
| 14 | Fixture: Supervisor Unavailable | Gate 2 | **PASS** | 0 ms | Reports uninitialized with offline occupant indicators |
| 15 | Zero Managed Children Baseline | Gate 2 | **PASS** | 0 ms | Fresh supervisor strictly initializes with 0 children |
| 16 | Fixture: Tracked Test Child | Gate 2 | **PASS** | 0 ms | Accurately correlates port ownership to managed child |
| 17 | Port Occupancy vs Ownership Distinction | Gate 2 | **PASS** | 822 ms | Port occupancy kept strictly distinct from ownership (0 managed vs port occupied) |
| 18 | Fixture: Ports Available | Gate 2 | **PASS** | 0 ms | Correctly detects unbound loopback ports |
| 19 | Fixture: Missing Executable & DLL Directory | Gate 2 | **PASS** | 0 ms | Flags missing binaries and sets `configuration_valid: false` |
| 20 | Fixture: Missing Model File | Gate 2 | **PASS** | 0 ms | Flags absent model and sets `configuration_valid: false` |
| 21 | Fixture: Invalid Configuration | Gate 2 | **PASS** | 0 ms | Flags bad extension and outputs issue checklist |
| 22 | Fixture: Unknown Diagnostic Values | Gate 2 | **PASS** | 0 ms | Graceful fallback on null health codes or unknown states |
| 23 | Reconciled RPC Busy Status Model | Gate 2 | **PASS** | 0 ms | Port 50052 occupied + secondary probe refused + coordinator inference ready |
| 24 | Duplicate Startup Request Guard | **Gate 3** | **PASS** | 781 ms | Duplicate start rejected while in `Ready`; active cluster state preserved |
| 25 | RPC Startup Failure & Clean Teardown | **Gate 3** | **PASS** | 515 ms | RPC worker crash detected; coordinator never spawned; 0 orphans left |
| 26 | Cancellation During Startup & Rollback | **Gate 3** | **PASS** | 560 ms | Operator cancellation cleanly intercepted staged wait, rolled back, freed ports |
| 27 | Controlled Engine Lifecycle (IPC Command) | **Gate 3** | **PASS** | 817 ms | `start_engine_internal` reached `Ready`, reported RAM, and stopped cleanly |
| 28 | Simulated Failure Modes & Rollback | **Gate 3** | **PASS** | 3785 ms | Simulated failure modes triggered clean rollbacks without orphan processes |

Serialized results preserved in: `spike/desktop-shell/supervisor_test_results.json`.

---

## 4. UI Implementation & Visual Screenshot Evidence

### 4.1 UI Layout and Gate 3 Controls
The Tauri frontend (`dist/assets/supervisor-diagnostics.js`) was updated with the Gate 3 Control Panel:
- **Top Status Bar:** Displays `GATE 3: CONTROLLED STARTUP SPIKE` badge, `Supervisor Active`, `Lifecycle: Stopped`, `Tracked: 0`, and port status.
- **Engine Lifecycle Panel:**
  - Header: `GATE 3 // ENGINE LIFECYCLE` with real-time status pill (`● Stopped`, `⏳ Starting...`, `● READY`, `● ERROR`).
  - Execution Mode Dropdown:
    * `Safe Test Mode (Harmless Test Children)` (default)
    * `Simulated: RPC Readiness Timeout`
    * `Simulated: Coordinator Health Timeout`
    * `Simulated: RPC Worker Crash`
    * `Simulated: Coordinator Crash`
    * `Simulated: Port Conflict`
    * `Real Production Engine (Requires Operator Approval)`
  - Controls: `▶ Start Engine` (primary action), `■ Stop Engine` (graceful stop), and `Cancel` (in-flight abort).
  - 4-Stage Progress Stepper:
    1. Preflight & Port Guard (`Valid (Ports & Binaries checked)`)
    2. RPC Worker Stage (`Pending` -> `Starting worker...` -> `Listening verified`)
    3. Coordinator Stage (`Pending` -> `Probing /health...` -> `HTTP 200 OK verified`)
    4. Inference Cluster Ready (`Cluster Idle / Waiting` -> `READY — Serving prompts`)
  - Automated Error & Recovery Box: Displays diagnostic cause, automated rollback confirmation, and step-by-step operator recovery guidance.

### 4.2 Screenshot Evidence

![Gate 3 Controlled Startup Window](file:///C:/Users/kunal/OneDrive/Desktop/swarm/artifacts/spike_screenshots/gate3_controlled_startup_window.png)

*Figure 1: `artifacts/spike_screenshots/gate3_controlled_startup_window.png` — Real live rendering of the compiled Tauri desktop shell on Windows showing Gate 3 controlled startup integration.*

---

## 5. Security & Resource Safeguards

1. **Zero Automatic Startup:** No processes are started when the Tauri window opens. Startup occurs solely upon explicit operator interaction.
2. **No Arbitrary Command / Shell Execution:** No shell (`cmd.exe` / `powershell.exe`) or arbitrary path execution APIs are exposed. All binaries and arguments are resolved strictly from approved native configuration.
3. **No Arbitrary PID Killing:** The supervisor only terminates processes explicitly spawned and tracked in its own `managed_children` table.
4. **Anonymous Job Object RAII:** Every spawned child is assigned to an anonymous Win32 Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` while still in a suspended thread state (`CREATE_SUSPENDED`). Even an unhandled crash of the Tauri host instantly terminates all child processes at the kernel level.
5. **Non-Destructive Port Guards:** `is_loopback_port_available` tests loopback ports without killing or adopting external processes.

---

## 6. Proposed Real-Runtime Test Procedure (Pending Operator Approval)

The following procedure outlines how real Swarm production binaries will be validated once explicit operator authorization is granted:

### 6.1 Prerequisites (Before Execution)
1. **Absence of Conflicting Processes:** Confirm that no external Swarm processes are running on ports 8080 or 50052:
   ```powershell
   Get-Process -Name swarm_node, ggml-rpc-server -ErrorAction SilentlyContinue
   netstat -ano | findstr "8080 50052"
   ```
   Both checks must return empty.
2. **Physical RAM Headroom Check:** Inspect host memory:
   ```powershell
   Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize, FreePhysicalMemory
   ```
   Current baseline inspection revealed `TotalVisibleMemorySize = 8.0 GB`, `FreePhysicalMemory = ~560 MB`. Because the Qwen 2.5 3B model is 1.96 GB, running real inference with only 560 MB free physical RAM would cause severe disk paging (thrashing). The operator should close background applications (browsers, IDEs) until at least **1.5 GB of free physical RAM** is available.
3. **GPU VRAM Check:** Inspect GPU VRAM:
   ```powershell
   nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader
   ```
   Baseline verified: `GeForce GTX 1050 (4096 MiB total, ~3297 MiB free)`. Adequate VRAM headroom is available.

### 6.2 Supervisor Real-Runtime Launch Sequence
1. In the Tauri desktop UI, the operator selects `Real Production Engine` in the mode selector and clicks `▶ Start Engine`.
2. The native supervisor executes:
   - Validates preflight paths: `build-cuda\swarm_node.exe`, `dist\swarm-worker-windows-x64\ggml-rpc-server.exe`, `models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf`, and DLL dirs `build-cuda`, `build-cuda\bin`.
   - Checks port availability for 50052 and 8080.
   - Spawns `ggml-rpc-server.exe` on port 50052 inside the Job Object with hidden console.
   - Polls loopback port 50052 until listening state is verified (timeout: 5,000 ms).
   - Spawns `swarm_node.exe` with `--port 8080 --model <model_path> --rpc 127.0.0.1:50052` with prepended DLL path inside the Job Object.
   - Polls HTTP endpoint `http://127.0.0.1:8080/health` until HTTP `200 OK` is returned and JSON `"ready": true` is parsed.
3. The UI reflects:
   - Lifecycle state transitions to `READY`.
   - Step 1 through Step 4 marked complete.
   - Tracked children count updates to `2`.

### 6.3 Verification of Readiness, Inference, and Shutdown
1. Verify endpoint health:
   ```powershell
   Invoke-RestMethod -Uri "http://127.0.0.1:8080/health"
   ```
2. Send test inference prompt:
   ```powershell
   Invoke-RestMethod -Uri "http://127.0.0.1:8080/v1/chat/completions" -Method Post -ContentType "application/json" -Body '{"messages":[{"role":"user","content":"Ping"}]}'
   ```
3. Test clean shutdown:
   - Operator clicks `■ Stop Engine` in the Tauri UI.
   - Supervisor sends `CTRL_BREAK_EVENT` to Coordinator PID, waits for exit.
   - Supervisor sends `CTRL_BREAK_EVENT` to RPC Worker PID, waits for exit.
   - Verify that ports 8080 and 50052 are released and both PIDs have exited.

### 6.4 Failure Recovery Procedure
- If startup fails at any point:
  - The supervisor automatically initiates rollback, terminating both children.
  - If any process hangs, closing the Tauri shell drops the anonymous Job Object handle, immediately terminating all descendants via `KILL_ON_JOB_CLOSE`.
  - The operator inspects logs via `supervisor_get_logs` or drawer diagnostic notices.

---

## 7. Remaining Blockers

1. **Explicit Operator Authorization:** In accordance with instructions ("Do not stop the current cluster or execute this real-runtime procedure without my explicit approval"), real-runtime launch is intentionally deferred.
2. **Host RAM Headroom:** Available physical RAM is currently ~560 MB. Real model execution should be preceded by closing memory-heavy background tasks to achieve >= 1.5 GB free RAM.

---

## 8. Summary & Next Steps

Gate 3 preparation is complete. All 28 automated tests are passing, native lifecycle IPC commands and cancellation are implemented, the UI controls are verified, and a safe real-runtime test procedure is documented.

Antigravity awaits explicit user instructions and approval before proceeding with the real-runtime validation test.
