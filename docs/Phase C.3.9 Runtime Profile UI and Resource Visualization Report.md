# Phase C.3.9 Runtime Profile UI and Resource Visualization Report

**Document Date:** October 12, 2026  
**Status:** IMPLEMENTATION COMPLETE — 37/37 BACKEND TESTS & 11/11 FRONTEND TESTS PASSING — AWAITING OPERATOR APPROVAL  
**Workspace:** `C:\Users\kunal\OneDrive\Desktop\swarm`  
**Phase Scope:** Isolated Tauri desktop-shell frontend development and safe integration testing strictly inside `spike/desktop-shell/` (zero real engine executions, zero GGUF weight loading, zero production C++ modifications, UI selection strictly unwired from real startup)  
**Primary References:**
- [`docs/Phase C.3.8 Runtime Profile Schema and Backend IPC Report.md`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/docs/Phase%20C.3.8%20Runtime%20Profile%20Schema%20and%20Backend%20IPC%20Report.md)
- [`docs/Phase C.3.7 Post-Inference Audit and Integration Plan.md`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/docs/Phase%20C.3.7%20Post-Inference%20Audit%20and%20Integration%20Plan.md)
- [`spike/desktop-shell/dist/assets/supervisor-diagnostics.js`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/dist/assets/supervisor-diagnostics.js)
- [`spike/desktop-shell/test_profiles_ui.mjs`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/test_profiles_ui.mjs)
- [`spike/desktop-shell/frontend_profile_test_results.json`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/frontend_profile_test_results.json)
- [`spike/desktop-shell/supervisor_test_results.json`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/supervisor_test_results.json)
- [`artifacts/spike_screenshots/phase_c39_profile_ui_window.png`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/artifacts/spike_screenshots/phase_c39_profile_ui_window.png)

---

## 1. Executive Summary

Following the approval of Phase C.3.8, Phase C.3.9 has integrated the **Runtime Profile Selector** and **Live Resource Preflight Dashboard** into the Tauri desktop shell prototype.

Key accomplishments:
1. **Source of Truth Adherence:** The frontend consumes profile configurations and live preflight eligibility directly from the backend IPC response (`supervisor_get_available_profiles` and `supervisor_get_profile_fixture`). Zero configuration constants or threshold numbers are duplicated in the UI.
2. **Clear Architecture Differentiation:**
   - **Distributed Cluster — Default:** Clearly labeled as `DEFAULT`, showing dual-process topology, `SWARM_USE_RPC=1`, `SWARM_N_GPU_LAYERS=4`, `SWARM_CTX_SIZE=2048`, coordinator port 8080, RPC port 50052, and 1,500 MB RAM guard. Unconstrained VRAM is explicitly labeled "None required".
   - **Standalone CUDA — Low Memory:** Clearly labeled as `OPT-IN SINGLE MACHINE`, showing single-process coordinator mode, `SWARM_USE_RPC=0`, `SWARM_N_GPU_LAYERS=-1`, `SWARM_CTX_SIZE=512`, coordinator port 8080, bypassed RPC worker, 1,000 MB RAM guard, and 3,100 MiB VRAM guard.
3. **Fail-Closed Resource Preflight Indicators:**
   - Physical Host RAM gauge compares live available RAM to the active profile's threshold.
   - Dedicated GPU VRAM gauge compares live available VRAM to 3,100 MiB (for standalone) or indicates "None required" (for cluster).
   - Overall status badge strictly displays `ELIGIBLE FOR LAUNCH`, `INELIGIBLE (REQUIREMENTS NOT MET)`, or `UNKNOWN (MEASUREMENTS UNAVAILABLE)`.
   - Under no circumstances is green or success styling applied when measurements are missing or deficit.
4. **Safety Wire Guard:** Profile selection in this phase is strictly restricted to inspection and preflight visualization. It cannot call `supervisor_start_engine`, spawn child processes, load model weights, or dispatch inference requests.
5. **Full Test Verification & Visual Capture:**
   - 37/37 Rust backend supervisor tests passed (`supervisor_test_runner`).
   - 11/11 Node.js automated frontend integration tests passed (`test_profiles_ui.mjs`).
   - A live screenshot of the rendered desktop shell window was captured directly from WebView2.

---

## 2. Files Changed

All modifications remained strictly confined to `spike/desktop-shell/`:

| File Path | Nature of Modification |
| :--- | :--- |
| [`spike/desktop-shell/dist/assets/supervisor-diagnostics.js`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/dist/assets/supervisor-diagnostics.js) | Implemented the Profile Selector and Resource Preflight Dashboard, reactive selection state, fail-closed eligibility styling, non-blocking refresh control, query timestamp display, architecture notices, and runtime memory disclaimer. |
| [`spike/desktop-shell/src-tauri/src/supervisor/commands.rs`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/supervisor/commands.rs) | Added `get_available_profiles_internal_with_ports`, `get_profile_fixture_internal`, and read-only Tauri IPC command `supervisor_get_profile_fixture` for deterministic testing of profile eligibility states. |
| [`spike/desktop-shell/src-tauri/src/lib.rs`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/lib.rs) | Registered `supervisor::commands::supervisor_get_profile_fixture` in `tauri::generate_handler![...]`. |
| [`spike/desktop-shell/src-tauri/src/bin/supervisor_test_runner.rs`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/bin/supervisor_test_runner.rs) | Added Test 37 validating profile simulation fixtures and unknown fixture error rejection. |
| [`spike/desktop-shell/test_profiles_ui.mjs`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/test_profiles_ui.mjs) | Created automated headless frontend test suite validating all 11 required UI behaviors. |
| [`spike/desktop-shell/frontend_profile_test_results.json`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/frontend_profile_test_results.json) | Output test report from `test_profiles_ui.mjs` confirming 11/11 passed. |
| [`spike/desktop-shell/supervisor_test_results.json`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/supervisor_test_results.json) | Output test report from `supervisor_test_runner` confirming 37/37 passed. |
| [`artifacts/spike_screenshots/phase_c39_profile_ui_window.png`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/artifacts/spike_screenshots/phase_c39_profile_ui_window.png) | Visual screenshot of the rendered desktop shell window displaying the new UI. |

---

## 3. Visual UI Evidence

A live window capture of the running desktop shell was recorded to:
- `artifacts/spike_screenshots/phase_c39_profile_ui_window.png`

Key visual elements verified in the capture:
- **Top Status Bar:** Displays the new active profile badge (`Profile: Cluster (Default)`), lifecycle state, port occupancies, and View Mode selector with profile simulation modes.
- **Header:** `RUNTIME PROFILE & RESOURCE PREFLIGHT` with `PHASE C.3.9` badge, query freshness timestamp (`Queried: 4:41:46 pm`), and `⟳ Refresh Resources` button.
- **Profile Selector Cards:**
  - Card 1: `Standard Distributed Cluster` with `DEFAULT` badge, highlighted by active Verdigris border (`#1F6F66`), radio button indicator, and exact environment breakdown.
  - Card 2: `Standalone Single-GPU (Low Memory)` with `OPT-IN SINGLE MACHINE` badge.
- **Active Profile Preflight Panel:**
  - Overall status badge: `INELIGIBLE (REQUIREMENTS NOT MET)` (reflecting live host RAM: 682 MB < 1500 MB threshold).
  - Physical Host RAM card: `682 MB`, Threshold `1500 MB`, Status: `DEFICIT (Insufficient RAM)`.
  - Dedicated GPU VRAM card: `Unconstrained`, Threshold `None required (Host RAM cluster)`, Status: `NOT REQUIRED`.
  - Port Availability card: `All Required Ports Free` (Coordinator 8080 free, RPC 50052 free).
  - Preflight Summary: `RAM deficit: 682 MB available < 1500 MB required`.
  - Explanatory notices: Runtime memory disclaimer and read-only integration boundary notice.

---

## 4. IPC Payload Fields Consumed

The frontend consumes the exact backend payload returned by `supervisor_get_available_profiles`:

```json
{
  "default_profile_id": "default",
  "queried_ram_mb": 1325,
  "queried_vram_mb": 3450,
  "query_timestamp": "2026-10-12T16:00:00Z",
  "profiles": [
    {
      "id": "default",
      "display_name": "Standard Distributed Cluster",
      "description": "Dual-process distributed cluster with coordinator and local RPC worker...",
      "is_default": true,
      "required_ram_mb": 1500,
      "required_vram_mb": null,
      "coordinator_port": 8080,
      "rpc_port": 50052,
      "requires_rpc_worker": true,
      "requires_real_authorization": true,
      "env_vars": [
        { "key": "SWARM_USE_RPC", "value": "1" },
        { "key": "PORT", "value": "8080" },
        { "key": "SWARM_N_GPU_LAYERS", "value": "4" },
        { "key": "SWARM_CTX_SIZE", "value": "2048" },
        { "key": "SWARM_RPC_ENDPOINTS", "value": "127.0.0.1:50052" }
      ],
      "eligibility": {
        "satisfies_ram": true,
        "satisfies_vram": true,
        "ram_status": "Satisfied",
        "vram_status": "Satisfied",
        "ports_available": true,
        "can_launch_now": true,
        "note": "Eligible for launch: Meets RAM threshold (1500 MB) and VRAM requirements; required ports free."
      }
    },
    {
      "id": "low_memory_cuda_standalone",
      "display_name": "Standalone Single-GPU (Low Memory)",
      "description": "Isolated single-process coordinator offloading all 37 model layers to local CUDA...",
      "is_default": false,
      "required_ram_mb": 1000,
      "required_vram_mb": 3100,
      "coordinator_port": 8080,
      "rpc_port": null,
      "requires_rpc_worker": false,
      "requires_real_authorization": true,
      "env_vars": [
        { "key": "SWARM_USE_RPC", "value": "0" },
        { "key": "PORT", "value": "8080" },
        { "key": "SWARM_N_GPU_LAYERS", "value": "-1" },
        { "key": "SWARM_CTX_SIZE", "value": "512" }
      ],
      "eligibility": {
        "satisfies_ram": true,
        "satisfies_vram": true,
        "ram_status": "Satisfied",
        "vram_status": "Satisfied",
        "ports_available": true,
        "can_launch_now": true,
        "note": "Eligible for launch: Meets RAM threshold (1000 MB) and VRAM requirements; required ports free."
      }
    }
  ]
}
```

---

## 5. Automated Tests and Build Results

### 5.1 Rust Backend Supervisor Test Suite (`cargo run --bin supervisor_test_runner`)
```text
==========================================================
  Test Suite Execution Summary
==========================================================
  Total: 37 | Passed: 37 | Failed: 0
==========================================================
Report saved to: spike\desktop-shell\supervisor_test_results.json
```
New test added in Phase C.3.9:
- **Test 37: Profile Simulation Fixtures & Error State Handling:** Verified deterministic evaluation of `profile_both_eligible`, `profile_ram_deficit`, `profile_vram_deficit`, `profile_unknown_metrics`, `profile_rpc_port_conflict`, and rejection of unknown fixtures.

### 5.2 Frontend Integration Test Suite (`node test_profiles_ui.mjs`)
```text
==========================================================
  Swarm Phase C.3.9 Frontend Integration Test Suite
==========================================================
  [PASS] Test 1: Default cluster selected initially
  [PASS] Test 2: Switching profiles updates displayed requirements
  [PASS] Test 3: Eligible status displayed correctly
  [PASS] Test 4: RAM below threshold displays clear failure
  [PASS] Test 5: VRAM below standalone threshold displays clear failure
  [PASS] Test 6: Missing RAM/VRAM measurements display Unknown
  [PASS] Test 7: Port conflicts affect only profiles requiring that port
  [PASS] Test 8: IPC errors produce visible error state
  [PASS] Test 9: Unknown profile IDs are rejected
  [PASS] Test 10: Profile selection cannot launch or stop any process
  [PASS] Test 11: Default configuration & behavior unchanged
==========================================================
  Frontend Test Results: Total: 11 | Passed: 11 | Failed: 0
==========================================================
Report written to: spike\desktop-shell\frontend_profile_test_results.json
```

### 5.3 Desktop Shell Binary Build (`cargo build`)
- Built in `spike/desktop-shell/src-tauri` using dev profile.
- Result: Clean compile, 0 errors.

---

## 6. Safety Invariants and Process Isolation Confirmation

1. **Zero Real Engine Processes Launched:** Neither `swarm_node.exe` nor `ggml-rpc-server.exe` was spawned during any test or UI rendering.
2. **Zero Weights Loaded:** The official model `qwen2.5-3b-instruct-q4_k_m.official-check.gguf` was not loaded into host or GPU memory.
3. **No Unwired Launch Path:** Selecting a profile in the UI merely updates the active view and preflight dashboard; it does not invoke `supervisor_start_engine` or communicate with process managers.
4. **Pristine Production Baseline:** Production inference C++ files (`main.cpp`, `config.h`, `placement.h`) and Milestone 12 launch scripts remain untouched.

---

## 7. Known Limitations

1. **Unwired Profile Selection:** The profile selector updates UI preflight indicators, but is not yet wired to pass the selected profile string into `supervisor_start_engine`. This wiring is reserved for Phase C.3.10.
2. **Dynamic Workstation Memory Fluctuations:** Point-in-time RAM readings reflect host operating system memory conditions (e.g., page file and file cache state). Passing preflight checks remains a necessary but not sufficient condition for inference success.

---

## 8. Proposed Next Phase: Phase C.3.10

**Phase C.3.10 Objective:**
Wire the runtime profile selector to the supervisor startup IPC command, implement explicit confirmation modals for the opt-in Standalone CUDA profile, and execute one authorized, controlled real inference test directly through the desktop shell UI under Job Object containment.

**Stop after Phase C.3.9. Awaiting operator review and approval before Phase C.3.10.**
