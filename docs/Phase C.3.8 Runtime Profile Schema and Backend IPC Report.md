# Phase C.3.8 Runtime Profile Schema and Backend IPC Report

**Document Date:** October 12, 2026  
**Status:** IMPLEMENTATION COMPLETE — ALL 36 TESTS PASSING — AWAITING OPERATOR APPROVAL  
**Workspace:** `C:\Users\kunal\OneDrive\Desktop\swarm`  
**Phase Scope:** Isolated Tauri desktop-shell prototype extension strictly inside `spike/desktop-shell/` (zero real engine executions, zero GGUF weight loading, zero production C++ modifications, UI redesign deferred to Phase C.3.9)  
**Primary References:**
- [`docs/Phase C.3.7 Post-Inference Audit and Integration Plan.md`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/docs/Phase%20C.3.7%20Post-Inference%20Audit%20and%20Integration%20Plan.md)
- [`spike/desktop-shell/src-tauri/src/supervisor/config.rs`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/supervisor/config.rs)
- [`spike/desktop-shell/src-tauri/src/supervisor/commands.rs`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/supervisor/commands.rs)
- [`spike/desktop-shell/src-tauri/src/lib.rs`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/lib.rs)
- [`spike/desktop-shell/src-tauri/src/bin/supervisor_test_runner.rs`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/bin/supervisor_test_runner.rs)
- [`spike/desktop-shell/supervisor_test_results.json`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/supervisor_test_results.json)

---

## 1. Executive Summary

In accordance with the integration roadmap defined in **Phase C.3.7**, Phase C.3.8 has successfully formalized runtime profile definitions in the Tauri desktop supervisor backend and exposed their static metadata and dynamic preflight eligibility via a typed, read-only Tauri IPC command: `supervisor_get_available_profiles`.

All work remained strictly confined to `spike/desktop-shell/`. No real engine binaries (`swarm_node.exe`, `ggml-rpc-server.exe`) were executed, no GGUF weights were loaded, and zero inference requests were dispatched. Production C++ inference engine source files (`main.cpp`, `config.h`, `placement.h`) and the Milestone 12 baseline were preserved without modification.

The supervisor test runner was expanded from 32 tests to **36 comprehensive automated test cases**, and all 36 tests passed cleanly with 0 failures.

---

## 2. Files Changed

All changes are strictly located inside `spike/desktop-shell/src-tauri/`:

| File Path | Nature of Modification |
| :--- | :--- |
| [`spike/desktop-shell/src-tauri/src/supervisor/config.rs`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/supervisor/config.rs) | Introduced typed `RuntimeProfile` enum, metadata schema structs (`RuntimeProfileMetadata`, `ProfileEnvVar`, `ProfileResourceEligibility`, `ResourceEligibilityStatus`, `AvailableProfilesResponse`), and pure `evaluate_profile_resource_eligibility()` logic with strict fail-closed handling for unavailable metrics. |
| [`spike/desktop-shell/src-tauri/src/supervisor/commands.rs`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/supervisor/commands.rs) | Implemented `build_default_cluster_coordinator_env()`, `get_profile_env_vars()`, `get_available_profiles_internal()`, and Tauri IPC handler `supervisor_get_available_profiles()`. Updated `start_engine_internal()` to parse and validate profile identifiers using `RuntimeProfile::from_id()`, preventing unknown profile fallbacks. |
| [`spike/desktop-shell/src-tauri/src/lib.rs`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/lib.rs) | Registered `supervisor::commands::supervisor_get_available_profiles` in `tauri::generate_handler![...]`. |
| [`spike/desktop-shell/src-tauri/src/bin/supervisor_test_runner.rs`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/bin/supervisor_test_runner.rs) | Added 4 automated integration test suites (Tests 33–36) validating schema integrity, exact profile configurations, fail-closed eligibility evaluation, and read-only IPC safety invariants. |

---

## 3. Implementation Details

### 3.1 Formalized Runtime Profile Representation

A strongly typed Rust enum `RuntimeProfile` was introduced in `supervisor/config.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeProfile {
    DefaultCluster,
    LowMemoryCudaStandalone,
}
```

Key characteristics:
1. **Explicit Identifiers:**
   - `DefaultCluster` $\rightarrow$ stable identifier `"default"`
   - `LowMemoryCudaStandalone` $\rightarrow$ stable identifier `"low_memory_cuda_standalone"`
2. **Rejection of Unknown Identifiers:**
   `RuntimeProfile::from_id(id: &str) -> Option<RuntimeProfile>` returns `None` for any unverified profile string. Silent fallback to either profile is strictly disallowed.
3. **Default Assignment:**
   `RuntimeProfile::is_default(&self) -> bool` returns `true` exclusively for `DefaultCluster`.
4. **Safety Authorization Flag:**
   `RuntimeProfile::requires_real_authorization(&self) -> bool` returns `true` for `LowMemoryCudaStandalone` and `false` for `DefaultCluster`.

### 3.2 Preserved Configuration Baseline

During pre-implementation inspection of `config.rs` and `commands.rs`, configuration constants and environment builders were verified against the specifications:

| Parameter | Default Cluster (`DefaultCluster`) | Standalone CUDA (`LowMemoryCudaStandalone`) | Discrepancy Found |
| :--- | :--- | :--- | :--- |
| **Identifier** | `"default"` | `"low_memory_cuda_standalone"` | None |
| **RPC Enablement** | `SWARM_USE_RPC=1` | `SWARM_USE_RPC=0` | None |
| **GPU Offload Layers** | `SWARM_N_GPU_LAYERS=4` | `SWARM_N_GPU_LAYERS=-1` | None |
| **Context Size** | `SWARM_CTX_SIZE=2048` | `SWARM_CTX_SIZE=512` | None |
| **Coordinator Port** | `8080` | `8080` | None |
| **RPC Worker Port** | `50052` | None (Worker not required) | None |
| **Local RPC Worker** | Required (`true`) | Prohibited (`false`) | None |
| **RAM Threshold** | 1,500 MB (Headroom guard) | 1,000 MB (Hard threshold) | None |
| **VRAM Threshold** | None (Unconstrained CPU/hybrid) | 3,100 MiB (Hard threshold) | None |
| **Real-Mode Authorization** | Standard preflight rules | Explicit real-mode authorization required | None |

### 3.3 Profile Metadata IPC Command (`supervisor_get_available_profiles`)

A read-only Tauri command `supervisor_get_available_profiles` was implemented and registered:

```rust
#[tauri::command]
pub async fn supervisor_get_available_profiles(
    state: State<'_, SupervisorState>,
) -> Result<AvailableProfilesResponse, String>
```

#### Typed Payload Structure (`AvailableProfilesResponse`)
```rust
pub struct AvailableProfilesResponse {
    pub default_profile_id: String,
    pub profiles: Vec<RuntimeProfileMetadata>,
}
```

Each profile metadata entry contains:
- **Static Metadata:**
  - `id`: Stable identifier (`"default"`, `"low_memory_cuda_standalone"`).
  - `display_name`: Human-readable label (`"Default Swarm Cluster (CPU/RPC)"`, `"Standalone CUDA Low-Memory (Single GPU)"`).
  - `description`: Plain-language explanation of architecture and usage context.
  - `is_default`: Boolean indicating whether it is the pre-selected baseline.
  - `required_ram_mb`: Required physical host RAM threshold in MB.
  - `required_vram_mb`: Optional required dedicated GPU VRAM threshold in MiB (`None` for DefaultCluster, `Some(3100)` for Standalone).
  - `coordinator_port`: Expected coordinator HTTP listening port (`8080`).
  - `rpc_port`: Expected RPC worker listening port (`Some(50052)` or `None`).
  - `requires_rpc_worker`: Boolean indicating whether a helper worker process is managed.
  - `requires_real_authorization`: Boolean flag indicating whether explicit operator consent is mandatory before starting real mode.
  - `env_vars`: List of explicit environment variables (`ProfileEnvVar { key, value, description }`).
- **Dynamic Resource Eligibility (`ProfileResourceEligibility`):**
  - `status`: Enum (`Eligible`, `Ineligible`, `Unknown`).
  - `can_launch_now`: Boolean indicating immediate launch capability.
  - `satisfies_ram`: Optional boolean (`Some(true)`, `Some(false)`, or `None` if unmeasurable).
  - `satisfies_vram`: Optional boolean (`Some(true)`, `Some(false)`, or `None` if unmeasurable).
  - `ports_free`: Boolean indicating whether all ports required by that specific profile are available.
  - `missing_requirements`: List of human-readable deficiency strings explaining any failure or missing measurement.

### 3.4 Strict Fail-Closed Eligibility Semantics

To prevent unsafe launches caused by sensor failure or unreadable metric queries, `evaluate_profile_resource_eligibility()` enforces strict fail-closed semantics:

```rust
// If RAM measurement cannot be obtained (None):
satisfies_ram = None;
missing_requirements.push("Available physical RAM measurement is unavailable".into());

// If VRAM measurement cannot be obtained (None) for a profile requiring VRAM:
satisfies_vram = None;
missing_requirements.push("Available GPU VRAM measurement is unavailable".into());

// Under no circumstances does an unknown measurement pass:
let can_launch_now = matches!(satisfies_ram, Some(true))
    && matches!(satisfies_vram, Some(true))
    && ports_free;

let status = if !can_launch_now {
    if satisfies_ram.is_none() || satisfies_vram.is_none() {
        ResourceEligibilityStatus::Unknown
    } else {
        ResourceEligibilityStatus::Ineligible
    }
} else {
    ResourceEligibilityStatus::Eligible
};
```

Additionally, port requirements are strictly disambiguated: an external occupant on port 50052 will flag `DefaultCluster` as ineligible, but will **not** flag `LowMemoryCudaStandalone` as ineligible, because standalone mode does not bind port 50052.

### 3.5 Read-Only Guarantee and Startup Dispatch

- Calling `supervisor_get_available_profiles()` never spawns a process, never locks a mutex, never modifies supervisor state, and never initiates network listening sockets.
- In `start_engine_internal()`, the caller's requested profile is parsed using `RuntimeProfile::from_id(profile_str)`:
  - If omitted (`None`), it defaults safely to `RuntimeProfile::DefaultCluster`.
  - If an unrecognized string is provided, the call is rejected immediately with an explicit error: `"Unknown supervisor profile '...'. Supported profiles are 'default' and 'low_memory_cuda_standalone'. Silent fallback prevented."`
  - The supervisor spawns zero processes upon encountering an unknown profile.

---

## 4. Safety Invariants Verification

All established safety boundaries remain fully enforced:

1. **Default Mode Invariant:** Standard distributed cluster mode remains the default across all API layers and fallback paths.
2. **No Automatic Profile Fallback:** If a requested profile fails preflight or encounters an unknown identifier, the supervisor aborts rather than falling back to another profile.
3. **RAM and VRAM Thresholds Intact:**
   - Default Cluster: 1,500 MB RAM headroom guard.
   - Standalone CUDA: 1,000 MB RAM guard, 3,100 MiB VRAM guard.
4. **Real-Runtime Authorization Guard:** The authorization gate (`allow_real_runtime == Some(true)`) remains required before real engine processes can be spawned.
5. **Job Object Containment & Owned-Process Rollback:** Only processes spawned by the supervisor Job Object are tracked or terminated during shutdown or rollback; external third-party processes on any port are never disturbed.
6. **No Production Engine Impact:** The C++ inference engine (`main.cpp`) and production scripts are completely untouched.

---

## 5. Automated Tests and Results

The isolated supervisor test runner in `spike/desktop-shell/src-tauri/src/bin/supervisor_test_runner.rs` was executed.

### 5.1 Test Execution Command
```powershell
cargo run --bin supervisor_test_runner
```

### 5.2 Test Results Summary

```text
==========================================================
  Test Suite Execution Summary
==========================================================
  [ 1] DLL Path Prepending & Delivery                      PASS (163 ms)
  [ 2] Environment Key Normalization                       PASS (2 ms)
  [ 3] Missing Path Validation                             PASS (1 ms)
  [ 4] Hidden-Console Child Launch                         PASS (272 ms)
  [ 5] Graceful Shutdown (Hidden Console)                  PASS (45 ms)
  [ 6] Staged Startup - RPC Readiness Timeout              PASS (649 ms)
  [ 7] Staged Startup - Coordinator Health Timeout         PASS (1463 ms)
  [ 8] Staged Startup - Full Progression & Stop            PASS (855 ms)
  [ 9] Partial Failure Cleanup & Orphan Prevention         PASS (1010 ms)
  [10] Port Conflict Safety                                PASS (0 ms)
  [11] Repeated Start/Stop Cycles                          PASS (2422 ms)
  [12] Job Object Tree Reclamation                         PASS (380 ms)
  [13] Live Host Diagnostics Generation                    PASS (1038 ms)
  [14] Fixture: Supervisor Unavailable                     PASS (0 ms)
  [15] Zero Managed Children Baseline                      PASS (0 ms)
  [16] Fixture: Tracked Test Child                         PASS (0 ms)
  [17] Port Occupancy vs Ownership Distinction             PASS (808 ms)
  [18] Fixture: Ports Available                            PASS (0 ms)
  [19] Fixture: Missing Executable & DLL Directory         PASS (0 ms)
  [20] Fixture: Missing Model File                         PASS (0 ms)
  [21] Fixture: Invalid Configuration                      PASS (0 ms)
  [22] Fixture: Unknown Diagnostic Values                  PASS (0 ms)
  [23] Reconciled RPC Busy Status Model                    PASS (0 ms)
  [24] Duplicate Startup Request Guard                     PASS (806 ms)
  [25] RPC Startup Failure & Clean Teardown                PASS (509 ms)
  [26] Cancellation During Startup & Rollback              PASS (552 ms)
  [27] Controlled Engine Lifecycle (IPC Command)           PASS (887 ms)
  [28] Simulated Failure Modes & Rollback                  PASS (3897 ms)
  [29] Real-Mode Safety Boundary & Headroom Guard          PASS (138 ms)
  [30] Standalone CUDA Low-Memory Profile Guards & Lifecycle  PASS (647 ms)
  [31] Conservative Resource Threshold Boundary Tests (Fail-Closed, RAM, VRAM)  PASS (0 ms)
  [32] Standalone Environment Variables & Fallback Rejection Guard  PASS (71 ms)
  [33] Runtime Profile Schema & Metadata Integrity         PASS (0 ms)
  [34] Exact Profile Configurations & Distinct Thresholds  PASS (0 ms)
  [35] Live Resource Eligibility & Fail-Closed Behavior    PASS (0 ms)
  [36] Read-Only Profile Query & Safety Invariant Preservation  PASS (124 ms)
----------------------------------------------------------
  Total: 36 | Passed: 36 | Failed: 0
==========================================================
Report saved to: C:\Users\kunal\OneDrive\Desktop\swarm\spike\desktop-shell\supervisor_test_results.json
```

### 5.3 Detailed Focus on New Profile Tests

- **Test 33: Profile Schema & Metadata Integrity**
  - Confirmed `RuntimeProfile::ALL` has exactly 2 elements.
  - Confirmed `RuntimeProfile::from_id("default")` yields `DefaultCluster` with `is_default() == true`.
  - Confirmed `RuntimeProfile::from_id("low_memory_cuda_standalone")` yields `LowMemoryCudaStandalone` with `is_default() == false`.
  - Confirmed unknown profile strings (`"cuda"`, `"unknown"`) return `None`.
- **Test 34: Exact Profile Configurations & Distinct Thresholds**
  - Verified exact environment variables for Default Cluster (`SWARM_USE_RPC=1`, `PORT=8080`, `SWARM_N_GPU_LAYERS=4`, `SWARM_CTX_SIZE=2048`, `SWARM_RPC_ENDPOINTS=127.0.0.1:50052`).
  - Verified exact environment variables for Standalone CUDA (`SWARM_USE_RPC=0`, `PORT=8080`, `SWARM_N_GPU_LAYERS=-1`, `SWARM_CTX_SIZE=512`).
  - Verified distinct RAM thresholds (1,500 MB vs 1,000 MB) and VRAM constraints (`None` vs `3100 MiB`).
  - Verified `get_profile_env_vars()` exposes accurate, human-readable variable descriptions.
- **Test 35: Live Resource Eligibility & Fail-Closed Behavior**
  - Scenario 1 (1,600 MB RAM, 3,500 MiB VRAM, all ports free): Both profiles report `Eligible` and `can_launch_now == true`.
  - Scenario 2 (1,200 MB RAM, 3,500 MiB VRAM, all ports free): `DefaultCluster` reports `Ineligible` (fails 1,500 MB RAM threshold); `LowMemoryCudaStandalone` reports `Eligible` (passes 1,000 MB RAM and 3,100 MiB VRAM).
  - Scenario 3 (1,600 MB RAM, 2,800 MiB VRAM, all ports free): `DefaultCluster` reports `Eligible` (VRAM unconstrained); `LowMemoryCudaStandalone` reports `Ineligible` (fails 3,100 MiB VRAM).
  - Scenario 4 (RAM unavailable / `None`): Both profiles report `Unknown`, `satisfies_ram == None`, `can_launch_now == false`.
  - Scenario 5 (VRAM unavailable / `None`): `DefaultCluster` reports `Eligible` (unconstrained); `LowMemoryCudaStandalone` reports `Unknown`, `satisfies_vram == None`, `can_launch_now == false`.
  - Scenario 6 (Port 50052 occupied): `DefaultCluster` reports `Ineligible` (`ports_free == false`); `LowMemoryCudaStandalone` reports `Eligible` (`ports_free == true`).
- **Test 36: Read-Only Metadata Query & Safety Invariant Preservation**
  - Confirmed calling `get_available_profiles_internal()` spawns 0 child processes and leaves supervisor state in `Stopped`.
  - Verified unknown profile in startup options returns an explicit error without touching child processes.
  - Verified unauthorized real-mode request remains rejected by Gate 3 safety boundary.

---

## 6. Discrepancies Found During Inspection

No discrepancies were found between the Phase C.3.7 specifications and the actual supervisor implementation. The supervisor configuration constants, port conventions, environment keys, and threshold values match the approved architecture exactly.

---

## 7. Remaining Limitations

1. **Frontend UI Exposure Deferred:** The Tauri IPC backend command is fully implemented and tested, but the desktop shell frontend (HTML/JS/CSS) has not yet been modified to display or toggle profiles. UI implementation is reserved for Phase C.3.9.
2. **Synthetic Preflight in Tests:** Tests 33–36 use mocked measurements and test child fixtures to guarantee deterministic verification without requiring live GPU driver queries or port contention during CI/test runs.
3. **No Real Inference in Phase C.3.8:** No actual model load or token generation was executed. A subsequent real inference test under profile selection remains subject to operator authorization.

---

## 8. Conclusion and Next Steps

Phase C.3.8 is fully complete. The runtime profiles are formalized, typed, exposed through read-only IPC, and validated by 36 passing tests.

Per user instructions, all execution is stopped at this boundary. Do not implement the UI selector, launch the real engine, or modify production code.

**Awaiting operator review and approval before proceeding to Phase C.3.9.**
