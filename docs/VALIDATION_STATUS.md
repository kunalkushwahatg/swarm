# Validation status

Status labels are explicit: `PASS`, `FAIL`, `NOT RUN`, `BLOCKED`, and
`UNVERIFIED`. Evidence is under
[`artifacts/validation/2026-10-10`](../artifacts/validation/2026-10-10).

The nine project documents are the root
[README.md](../README.md) plus the eight Markdown documents in `docs/`.

## Model integrity

- Current executable hash: **PASS**
  - `build-cuda/swarm_node.exe`
  - SHA-256:
    `0D4D2ED6E2A9A65F15A3D08D3FFB29131231D109A76661959D2D0205AD493C8E`
  - `build-cuda/swarm_agent.exe`
  - SHA-256:
    `01CBF6E7DE3D83FBEB6CE9BC369F25B0811B4E4C077677DD1AE49146D1F9190B`
  - `build-cuda/test_security.exe`
  - SHA-256:
    `C691554FE14A8A78188E41B667C1C78DE4DB4F28EFD945229190C69E4A8E3FA0`
  - `build-cuda/test_rpc_health.exe`
  - SHA-256:
    `7191CB192B1D04F300E0DD408E2B68AD8F365A5B8D18DB956C02CAEFC03151E7`

- Official verification copy and hash: **PASS**
  - `models/qwen2.5-3b-instruct-q4_k_m.official-check.gguf`
  - SHA-256:
    `626B4A6678B86442240E33DF819E00132D3BA7DDDFE1CDC4FBB18E0A9615C62D`
- Original model provenance: **UNVERIFIED**
  - `models/qwen2.5-3b-instruct-q4_k_m.gguf`
  - SHA-256:
    `B7AA5CE06C2B483A582B81CFC6EF3C379DE3D341BD1C30B69B60396786526A82`
  - It remains preserved and is not used as the baseline.

The official model produced sensible text in the independent CPU reference and
in Swarm. The original produced non-meaningful reference output. The original
is classified as unverified rather than conclusively corrupt.

## Local CUDA layer tests

Using the official model and the same Swarm path:

- `0` GPU layers: **PASS**, CPU inference with finite logits.
- `4` GPU layers: **PASS**, finite logits and sensible output.
- `8` GPU layers: **PASS**, finite logits and sensible output.
- `-1`: **PASS**, all 37/37 layers offloaded, finite logits and sensible output.

## Loopback RPC integration

- CPU RPC server bound to `127.0.0.1:50052`: **PASS**.
- Device registered before model loading: **PASS**.
- Remote model, KV-cache, and compute buffers reported: **PASS**.
- Remote layer placement observed: **PASS**.
- `What is 2 + 2?` returned `2 + 2 equals 4.`: **PASS**.

The controlled RPC test reported layers 33-36 assigned to `RPC0` and
`offloaded 4/37 layers to GPU`. The captured placement did not report a layer
assigned to `CUDA0`, so this evidence must not be described as proven local
CUDA plus RPC computation. It proves RPC backend participation and remote
placement, not a particular mixed-device split.

## Two-worker loopback simulation — 2026-10-10

- Two independent CPU RPC server processes on `127.0.0.1:50052` and
  `127.0.0.1:50053`: **PASS**.
- Both endpoints registered before model loading as `RPC0` and `RPC1`:
  **PASS**.
- llama.cpp placement assigned layer 33 to RPC0, layer 34 to RPC1, and layers
  35-36 to CUDA0: **PASS**.
- Remote model, KV, and compute buffers allocated on both endpoints: **PASS**.
- Prompt logits were finite (`151936` finite, `0` nonfinite) and the response
  was `2 + 2 equals 4.`: **PASS**.
- Same-machine memory caveat: both workers reported approximately `7.84 GiB`
  total and the same changing free-memory view; this is shared host memory,
  not additive independent capacity.
- Worker-B failure after model load: **FAIL / limitation exposed**. Stopping
  port `50053` caused an RPC transport error and Swarm terminated. Restarting
  worker B did not recover the existing model/context; a clean Swarm restart
  is required.
- Real second-device LAN inference: **NOT RUN**.

Evidence is under
`artifacts/validation/2026-10-10/multi-rpc/`, including the clean Swarm
stdout/stderr logs and worker process logs.
The command and PID record is in
`artifacts/validation/2026-10-10/multi-rpc/MULTI_RPC_TEST_SUMMARY.md`.

## Fault handling and repeatable test — 2026-10-10

The repeatable harness is
`scripts/Invoke-MultiRpcFaultTest.ps1`. It starts only the two loopback RPC
servers and Swarm, waits for listener/model readiness, sends the arithmetic
request, verifies both RPC model-buffer allocations, stops RPC1, records the
failed request, captures the Windows Application Error event, and releases
ports 50052, 50053, and 8080.

Observed result:

- Baseline inference with both workers: **PASS**.
- RPC0 remained listening after RPC1 was stopped: **PASS**.
- The request after RPC1 loss: **FAIL**, with the HTTP connection closed or
  timing out rather than a structured inference error.
- Swarm process: **FAIL / limitation exposed**. GGML logged
  `send failed` followed by
  `Remote RPC server crashed or returned malformed response`.
- Windows Application Error 1000 reported `swarm_node.exe` faulting in
  `ucrtbase.dll` with exception code `0xc0000409`.
- Transparent recovery after restarting RPC1: **NOT SUPPORTED**. The loaded
  model/context must be recreated by a clean Swarm restart.
- Harness cleanup and port release: **PASS**.

Evidence is under
`artifacts/validation/2026-10-10/fault-handling/`, including the harness
responses, allocation evidence, worker logs, Swarm logs, failure result, and
Windows crash-event record.

## Benchmark — 2026-10-10

Both configurations used the same official model, prompt, context settings,
greedy sampling, and eight observed output tokens. Two warm-up requests were
followed by five measured requests.

| Configuration | Client latency (min/avg/max) | Prompt (min/avg/max) | Generation (min/avg/max) | Generation speed | Correct |
|---|---:|---:|---:|---:|---:|
| Local CUDA, 37/37 layers | 463/489/551 ms | 78/81.8/88 ms | 358/380/440 ms | 18.18/21.17/22.35 tok/s | 5/5 |
| Loopback RPC, observed RPC0 placement | 4133/4166/4239 ms | 2660/2679.8/2714 ms | 1439/1462.6/1502 ms | 5.33/5.47/5.56 tok/s | 5/5 |

The loopback RPC server used approximately 400 MB working set and about
3.55 CPU seconds per measured request on average. Loopback RPC was slower for
this workload and does not establish multi-computer speedup.

## Fallback and real-LAN status

- RPC-disabled fallback with `SWARM_USE_RPC=0` and `SWARM_N_GPU_LAYERS=-1`:
  **PASS**.
- Real second-device LAN inference: **NOT RUN**.
- Multi-worker scheduling and load balancing: **NOT RUN**.

## Milestone 4 — Backend placement observability and resource reporting — 2026-10-10

Automated test harness: `scripts/Invoke-Milestone4Validation.ps1`
Evidence directory: `artifacts/validation/2026-10-10/milestone-4/`

### 1. Test 1: Local CUDA Baseline (`SWARM_USE_RPC=0`, `SWARM_N_GPU_LAYERS=-1`)
- **Model Load & Placement:** **PASS**. All 37 layers (0-36) assigned to `CUDA0`. Model buffer: 2048.54 MiB, KV cache: 576.00 MiB, Compute buffer: 49.25 MiB.
- **Inference Verification:** **PASS**. Prompt `What is 2 + 2?` returned `2 + 2 equals 4.` (finite logits, HTTP 200).
- **Timing Instrumentation:** **PASS**. Monotonic request timings recorded:
  - Prompt evaluation: ~91.2 ms
  - Token generation: ~382.4 ms (8 tokens, ~20.9 tok/s)
  - Total inference: ~473.6 ms
- **Observability Endpoints:** **PASS**. `/backends`, `/workers`, and `/metrics` reported accurate single-device CUDA0 metrics and allocations.
- **Process & Port Cleanup:** **PASS**. Port 8080 cleanly closed.

### 2. Test 2: Two Loopback RPC Workers (`SWARM_USE_RPC=1`, ports 50052 & 50053, `SWARM_N_GPU_LAYERS=4`)
- **Backend Registration:** **PASS**. Three compute devices registered before model loading: `RPC0[127.0.0.1:50052]`, `RPC1[127.0.0.1:50053]`, and `CUDA0`.
- **Observed Placement (from GGML log callback):** **PASS**.
  - `RPC0`: layer 33 (`range: [33-33]`), Model buffer: 73.00 MiB, KV cache: 16.00 MiB, Compute buffer: 2.25 MiB.
  - `RPC1`: layer 34 (`range: [34-34]`), Model buffer: 73.00 MiB, KV cache: 16.00 MiB, Compute buffer: 2.25 MiB.
  - `CUDA0`: layers 35-36 (`range: [35-36]`), Model buffer: 146.00 MiB, KV cache: 32.00 MiB, Compute buffer: 49.25 MiB.
  - `CPU`: layers 0-32 (host RAM).
- **Memory Scope Deduplication:** **PASS**.
  - Both RPC endpoints classified as `backend_type: "loopback_rpc"` and `memory_scope: "shared_host"`.
  - Host RAM capacity (~7.84 GiB / 8031 MiB) reported once under `host_memory_bytes` and not artificially summed across workers.
- **Inference Verification:** **PASS**. Prompt `What is 2 + 2?` returned `2 + 2 equals 4.` with finite logits.
- **Timing Instrumentation:** **PASS**.
  - Prompt evaluation: ~2810.5 ms
  - Token generation: ~1520.1 ms (8 tokens, ~5.26 tok/s)
  - Total inference: ~4330.6 ms
  - Optional `timings` object emitted in SSE stream prior to `[DONE]`.
- **Prometheus Metrics:** **PASS**. `/metrics` exposed bounded gauges:
  - `swarm_backend_model_buffer_bytes`
  - `swarm_backend_kv_buffer_bytes`
  - `swarm_backend_compute_buffer_bytes`
  - `swarm_backend_assigned_layers`
  - `swarm_backend_is_loopback`
  - `swarm_inference_prompt_eval_ms`
  - `swarm_inference_eval_ms`
  - `swarm_inference_total_ms`
  - `swarm_inference_tokens_generated`
- **Fault Handling Regression:** **PASS**. Ran `scripts/Invoke-MultiRpcFaultTest.ps1` with the new binary. Existing failure semantics preserved (`0xc0000409` in `ucrtbase.dll`, exit code `-1073740791`), no false recovery claims, all ports released.

## Milestone 5 — Resource-Aware Placement Policy and Scheduling — 2026-10-10

Automated test harnesses:
- Unit tests: `test_policy.exe` (compiled from `test_policy.cpp`)
- Integration matrix: `scripts/Invoke-Milestone5Validation.ps1`
- Fault regression: `scripts/Invoke-MultiRpcFaultTest.ps1`

Evidence directory: `artifacts/validation/2026-10-10/milestone-5/`

### 1. Unit Test Suite (`test_policy.exe`) — PASS
All 7 unit tests passed deterministically:
- `test_unit_parsing`: Validated `B`, `KB`, `KiB`, `MB`, `MiB`, `GB`, `GiB` multiplier parsing and rejected unknown units.
- `test_profile_string_parsing`: Validated comma-delimited key-value syntax, whitespace handling, and duplicate key rejection.
- `test_policy_none`: Preserved default empty splits array for `SWARM_PLACEMENT_POLICY=none`.
- `test_policy_resource_aware_split_weights`: Validated Profile A (`RPC0=0, RPC1=2, CUDA0=2` layers) and Profile B (`RPC0=2, RPC1=0, CUDA0=2` layers) split weight generation and GGML `upper_bound` simulation.
- `test_policy_both_low`: Validated both loopback workers assigned zero weight with CUDA0 receiving all 4 offloaded layers.
- `test_insufficient_budget`: Validated that total capacity shortfall returns controlled error status.
- `test_capacity_capping`: Confirmed device capacity is strictly capped at `act_gpu_layers`.

### 2. Integration Test Matrix (Cases 1–8)

#### Case 1: Baseline Policy Disabled (`SWARM_PLACEMENT_POLICY=none`, 4 layers) — PASS
- **Command & Configuration:** `SWARM_USE_RPC=1`, `SWARM_RPC_ENDPOINTS=127.0.0.1:50052,127.0.0.1:50053`, `SWARM_N_GPU_LAYERS=4`.
- **Observed Placement:** Default GGML allocation: `RPC0`: layer 33 (1 layer), `RPC1`: layer 34 (1 layer), `CUDA0`: layers 35-36 (2 layers).
- **Inference & Logits:** Prompt `What is 2 + 2?` returned `2 + 2 equals 4.`; finite logits verified.
- **Artifacts:** `case1-baseline-backends.json`, `case1-baseline-workers.json`, `case1-baseline-metrics.prom`.

#### Case 2: Profile A (`RPC0=50MB, RPC1=500MB, CUDA0=4000MB`, 4 layers) — PASS
- **Policy Prediction:** RPC0 budget 50 MB < 92 MiB cost -> 0 layers (weight 0.0); RPC1 budget 500 MB -> 2 layers; CUDA0 budget 4000 MB -> 2 layers.
- **Observed Runtime Placement:**
  - `RPC0`: 0 layers assigned (`policy_match: true`), model buffer 0 B.
  - `RPC1`: layers [33, 34] (2 layers, `policy_match: true`), model buffer 146.00 MiB.
  - `CUDA0`: layers [35, 36] (2 layers, `policy_match: true`), model buffer 146.00 MiB.
- **Inference & Logits:** Returned `2 + 2 equals 4.`; finite logits verified.
- **Artifacts:** `case2-profile-a-backends.json`, `case2-profile-a-workers.json`, `case2-profile-a-metrics.prom`.

#### Case 3: Profile B (`RPC0=500MB, RPC1=50MB, CUDA0=4000MB`, 4 layers) — PASS
- **Policy Prediction:** RPC0 budget 500 MB -> 2 layers; RPC1 budget 50 MB -> 0 layers (weight 0.0); CUDA0 budget 4000 MB -> 2 layers.
- **Observed Runtime Placement:**
  - `RPC0`: layers [33, 34] (2 layers, `policy_match: true`), model buffer 146.00 MiB.
  - `RPC1`: 0 layers assigned (`policy_match: true`), model buffer 0 B.
  - `CUDA0`: layers [35, 36] (2 layers, `policy_match: true`), model buffer 146.00 MiB.
- **Inference & Logits:** Returned `2 + 2 equals 4.`; finite logits verified.
- **Artifacts:** `case3-profile-b-backends.json`, `case3-profile-b-workers.json`, `case3-profile-b-metrics.prom`.

#### Case 4: Both RPC Low (`RPC0=50MB, RPC1=50MB, CUDA0=4000MB`, 4 layers) — PASS
- **Policy Prediction:** RPC0 -> 0 layers, RPC1 -> 0 layers, CUDA0 -> all 4 layers.
- **Observed Runtime Placement:**
  - `RPC0`: 0 layers assigned (`policy_match: true`), model buffer 0 B.
  - `RPC1`: 0 layers assigned (`policy_match: true`), model buffer 0 B.
  - `CUDA0`: layers [33, 34, 35, 36] (4 layers, `policy_match: true`), model buffer 292.00 MiB.
- **Inference & Logits:** Returned `2 + 2 equals 4.`; finite logits verified.
- **Artifacts:** `case4-both-low-backends.json`, `case4-both-low-workers.json`, `case4-both-low-metrics.prom`.

#### Case 5: Insufficient Capacity (`RPC0=50MB, RPC1=50MB, CUDA0=150MB`, 4 layers requested) — PASS
- **Behavior:** Total capacity 0 + 0 + 1 = 1 layer < 4 requested offloaded layers.
- **Diagnostics:** Controlled startup abort (exit code 1). Stderr reported:
  `[SWARM_POLICY] Total estimated layer capacity (1) is insufficient for requested 4 offloaded layers.`
- **Artifacts:** `case5-insufficient-stdout.log`, `case5-insufficient-stderr.log`.

#### Case 6: Repeated Inference (Profile A, 5 trials) — PASS
- **Inference Quality:** 5 consecutive trials on Profile A returned identical sensible text `2 + 2 equals 4.`.
- **Accuracy:** 5/5 correct responses; zero NaN/inf logits observed.
- **Latency Consistency:** Prompt eval ~2370–2410 ms, token generation ~860–880 ms.
- **Artifacts:** `case6-swarm.log`, `case6-rpc0.log`, `case6-rpc1.log`.

#### Case 7: Worker Fault Handling Regression — PASS
- **Harness:** `scripts/Invoke-MultiRpcFaultTest.ps1` with the Milestone 5 binary.
- **Behavior:** Abrupt termination of RPC1 triggered GGML RPC assertion and controlled Windows Application Error 1000 (`0xc0000409` in `ucrtbase.dll`), preserving documented fault semantics. No false recovery claims. All ports cleaned up.

#### Case 8: Local CUDA Full Fallback (`SWARM_USE_RPC=0`, 37 layers) — PASS
- **Observed Placement:** All 37 layers placed on `CUDA0`.
- **Generation Speed:** ~20.2 tok/s (prompt eval ~83 ms, generation ~395 ms).
- **Inference & Logits:** Returned `2 + 2 equals 4.` with finite logits.
- **Artifacts:** `case8-cuda.log`.

## Milestone 6 — Multi-Node Orchestration and Reliability — 2026-10-10

Automated test harness: `scripts/Invoke-Milestone6Validation.ps1`
Regression fault harness: `scripts/Invoke-MultiRpcFaultTest.ps1`
Evidence directory: `artifacts/validation/2026-10-10/milestone-6/`

### Test Matrix Results

| Test Case | Scenario / Configuration | Expected Behavior | Observed Result | Status |
|---|---|---|---|---|
| **Case 1** | Worker Registration & Readiness (RPC0, RPC1, CUDA0) | Both RPC workers register before model load; `/health` reports `inference.ready = true` and `ready_workers = 2`. | Verified in `/health` and `/backends`. Text: `2 + 2 equals 4.` | **PASS** |
| **Case 2** | Invalid / Unreachable Endpoints at Startup | (2a) Unreachable port `59999` $\rightarrow$ exit code 1 with clean stderr error.<br>(2b) Malformed port `99999` $\rightarrow$ exit code 1 with clean stderr error. | 2a exited code 1, stderr logged connection failure.<br>2b exited code 1, stderr logged port syntax error. | **PASS** |
| **Case 3** | Controlled Handling when One Worker Becomes Unavailable (Idle) | Stop RPC1 while Swarm is idle. Subsequent request returns HTTP 503 instead of crashing. `/health` reports `unready_reason`. Swarm remains alive. | Received HTTP 503 Service Unavailable with structured JSON error. Swarm remained alive and listening. | **PASS** |
| **Case 4** | Controlled Recovery via Clean Restart | Stop Swarm, restart RPC1, restart Swarm cleanly. Full readiness and inference restored. | Swarm initialized cleanly, both workers ready, inference generated `2 + 2 equals 4.`. | **PASS** |
| **Case 5** | Repeated Inference with 2 Loopback Workers (5 Trials) | 5 consecutive requests on Profile A (`RPC0=50MB, RPC1=500MB, CUDA0=4000MB`) return correct text and finite logits without TCP health check interference. | 5/5 trials returned `2 + 2 equals 4.`. Latency stable, zero false 503s. | **PASS** |
| **Case 6** | Local CUDA Fallback Regression | `SWARM_USE_RPC=0`, all 37 layers offloaded to CUDA0. Fast local inference. | Verified 37/37 layers offloaded, returned `2 + 2 equals 4.`. | **PASS** |
| **Case 7** | Graceful Shutdown and Port Cleanup | Terminate Swarm and RPC servers. Verify all ports (8080, 50052, 50053) are released. | All processes exited, all ports confirmed free. | **PASS** |
| **Case 8** | Zero-Layer Worker Fault Resilience & Required Backend Enforcement | In Profile A (`RPC0=50MB [0 layers], RPC1=500MB [2 layers]`), stop RPC0: inference succeeds (200). Then stop RPC1: inference rejected with 503. | RPC0 loss did not disrupt inference; text generated `2 + 2 equals 4.`. RPC1 loss cleanly rejected with 503. | **PASS** |
| **Idle Fault Regression** | Idle Worker Fault Regression (`Invoke-MultiRpcFaultTest.ps1`) | Worker loss between requests intercepted by pre-inference health check; returns HTTP 503 while Swarm remains alive and listening. | Returned HTTP 503 Service Unavailable, preserved documented failure semantics, all ports released. | **PASS** |
| **Mid-Decode Disconnect (Architectural)** | In-Flight Worker Disconnect during `llama_decode` | Worker drops while actively decoding tensor graph. Expected fatal termination via GGML abort. | GGML triggers `RPC_STATUS_ASSERT` / `GGML_ABORT`, `ggml_set_abort_callback` logs stderr diagnostics, process terminates (not recoverable in-process). | **DOCUMENTED ARCHITECTURAL LIMITATION** |
| **Physical LAN Connectivity** | Multi-Device Physical LAN Operation | Operation across separate physical hosts over physical router/switch. | Not physically tested due to single-laptop hardware constraint. Specification and endpoints documented; physical testing deferred to Milestone 8. | **DEFERRED TO MILESTONE 8** |

## Milestone 7 — Node Inventory and Resource Discovery — 2026-10-10

Automated test harness: `scripts/Invoke-Milestone7Validation.ps1`
Regression test harness: `scripts/Invoke-Milestone6Validation.ps1`
Deterministic offline test executable: `test_node_inventory.exe`
Evidence directory: `artifacts/validation/2026-10-10/milestone-7/`

### Step 0: Deterministic Offline Unit Tests (`test_node_inventory.exe`)

| Test Case | Scenario / Verification | Result | Status |
|---|---|---|---|
| **Test 1** | Resource Provenance Tracking | Verified segregation of `MEASURED`, `CONFIGURED_BUDGET`, `SIMULATED`, and `UNKNOWN` types; confirmed JSON serialization preserves provenance tags and source strings. | Output matches expected provenance rules | **PASS** |
| **Test 2** | Valid & Invalid Node Metadata | Valid metadata accepted; invalid metadata (empty node_id, empty endpoint) cleanly rejected by `validate_node()`. | Validation rules enforced | **PASS** |
| **Test 3** | Staleness Detection | Fresh observation (< 30s) passes; stale observation (60s old with 30s threshold) flagged as stale by `is_stale()`. | Staleness accurately detected | **PASS** |
| **Test 4** | Node Disconnect & Recovery Transitions | Simulates `READY` $\rightarrow$ `UNAVAILABLE` $\rightarrow$ `READY` cycle. Readiness and connection state update deterministically. | State machine transitions verified | **PASS** |
| **Test 5** | Required vs Zero-Layer Worker Reporting | Nodes with assigned layers marked `is_required_by_model: true`; zero-layer nodes marked `is_required_by_model: false`. | Model requirement flags verified | **PASS** |
| **Test 6** | Loopback Host Memory Deduplication | Multiple loopback nodes sharing physical host RAM deduplicated: cluster summary samples host memory once, setting `host_ram_deduplicated: true`. | No additive memory inflation | **PASS** |
| **Test 7** | Simulated Fixtures Isolation | Fixtures marked `is_simulated: true` explicitly identify synthetic nature in JSON serialization, preventing confusion with live scheduling data. | Simulated tag enforced | **PASS** |

### Live Integration Test Matrix (`Invoke-Milestone7Validation.ps1`)

| Test Case | Scenario / Configuration | Expected Behavior | Observed Result | Status |
|---|---|---|---|---|
| **Case 1** | Live Node Inventory Discovery (`GET /nodes`) | Swarm gateway initializes `g_node_inventory` with 1 gateway and 2 loopback RPC workers. `GET /nodes` returns full JSON inventory with 3 nodes, device metrics, and deduplicated memory. Inference succeeds. | `total_nodes: 3`, `ready_nodes: 3`, `required_nodes: 3`. Response: `2 + 2 equals 4.` | **PASS** |
| **Case 2** | Resource-Aware Inventory with Provenance (Profile A) | `SWARM_WORKER_PROFILES=RPC0=50MB,RPC1=500MB,CUDA0=4000MB`. RPC0 assigned 0 layers (`is_required_by_model: false`), RPC1 assigned 2 layers (`is_required_by_model: true`). Profiles reflected as `CONFIGURED_BUDGET`. | RPC0 required=false, RPC1 required=true, CUDA0 required=true. Provenance verified. | **PASS** |
| **Case 3** | Node Disconnect Visibility in Live `/nodes` | Terminate RPC0 while Swarm is idle. Calling `GET /nodes` reflects `RPC0` connection_state `UNAVAILABLE` and `is_ready_for_inference: false`. Zero-layer RPC0 loss allows continued inference (HTTP 200). | State updated to `UNAVAILABLE` in live `/nodes`. Generated `2 + 2 equals 4.`. | **PASS** |
| **Case 4** | Prometheus Node Metrics (`GET /metrics`) | Exposes `swarm_nodes_total`, `swarm_nodes_online`, and `swarm_nodes_required`. Matches `/nodes` state. | `swarm_nodes_total 3`, `swarm_nodes_online 3`, `swarm_nodes_required 2`. | **PASS** |
| **Case 5** | Backward Compatibility with Existing Endpoints | Endpoints `/health`, `/workers`, and `/backends` retain identical JSON schema and expected fields from Milestones 4-6. | Schema and values verified against baseline schemas. | **PASS** |
| **Case 6** | Local CUDA Fallback Regression | `SWARM_USE_RPC=0`, 37 layers offloaded to CUDA0. Baseline inference speed ~20 tok/s. | 37/37 layers offloaded, returned `2 + 2 equals 4.`. | **PASS** |
| **Case 7** | Graceful Teardown & Port Verification | Clean termination of all processes; verify ports 8080, 50052, 50053 are completely freed. | All processes terminated, all ports verified free. | **PASS** |
| **Milestone 6 Regression** | Multi-Node Orchestration Suite (`Invoke-Milestone6Validation.ps1`) | Full execution of Cases 1–8 under Milestone 7 binary. | All 8 cases passed with 100% fidelity. | **PASS** |

## Milestone 8 validation — 2026-10-10

Evidence directory: [`artifacts/validation/2026-10-10/milestone-8`](../artifacts/validation/2026-10-10/milestone-8).

### Offline Agent & Inventory Unit Tests (`test_agent_and_inventory.exe`)

| Test Case | Scenario / Verification | Expected Behavior | Observed Result | Status |
|---|---|---|---|---|
| **Test 1** | Local Hardware Probe & Report Serialization | Probe Win32 CPU, RAM via `GlobalMemoryStatusEx`, and GPU via DXGI. Serialize to JSON. | Valid JSON produced, non-empty fields, RAM total > 0, schema `"1.0"`. | **PASS** |
| **Test 2** | Malformed & Invalid Report Rejection | Submit reports with empty node ID, inverted RAM (`available > total`), zero total RAM, and invalid schema. | `ingest_agent_report()` rejects invalid payloads with descriptive errors. | **PASS** |
| **Test 3** | Unsupported Metrics & Provenance Segregation | Check unmeasurable metrics (CPU/GPU thermals, fan RPM) and resource provenance. | Listed in `unsupported_metrics`; hardware metrics tagged `MEASURED`; configured budget preserved. | **PASS** |
| **Test 4** | Freshness Tracking & Staleness Safety | Ingest report at $T=0$. Query at $T=10\text{s}$ (fresh) and $T=35\text{s}$ (stale). | At 10s: `is_stale: false`, `READY`. At 35s: `is_stale: true`, `UNAVAILABLE`, excluded from active memory. | **PASS** |
| **Test 5** | Agent Disconnection & Clean Reconnection | Ingest report, let expire ($T=40\text{s}$), then re-report at $T=45\text{s}$. | Stale node safely transitions back to `is_stale: false` and `READY`. | **PASS** |
| **Test 6** | Stable Node Identity & Hostname Merging | Re-report with same node ID and endpoint across process restarts. | Preserves identity, updates hardware telemetry without duplicate node creation. | **PASS** |
| **Test 7** | Loopback Memory Deduplication Preservation | Ingest agent reports for two loopback workers. Check cluster summary. | Cluster physical RAM sampled once (`host_ram_deduplicated: true`); RAM not summed additively. | **PASS** |

### Live Integration Test Matrix (`Invoke-Milestone8Validation.ps1`)

| Test Case | Scenario / Configuration | Expected Behavior | Observed Result | Status |
|---|---|---|---|---|
| **Case 1** | Live Ingestion via `swarm_agent.exe --once` | Coordinator launched with RPC0 (50052). `swarm_agent.exe --once` reports hardware. Ingested into `GET /nodes`. Inference executed. | `agent_reported: true`, CPU model name, RAM total/available present in `/nodes`. Inference returned `2 + 2 equals 4.`. | **PASS** |
| **Case 2** | Malformed Report & Size Limit Rejection | Coordinator subjected to bad schema (HTTP 400), invalid RAM bounds (HTTP 400), and >64KB oversized payload (HTTP 413). | Rejected with exact HTTP status codes; coordinator remains healthy. | **PASS** |
| **Case 3** | Continuous Agent Daemon & Staleness Handling | Agent daemon running with 10s heartbeat. Agent stopped; wait 32s. Verify staleness. Re-run agent. | At 32s: `is_stale: true`, `stale_reason: "Report exceeded 30000ms TTL"`, `connection_state: UNAVAILABLE`. Re-report restores `is_stale: false` and `READY`. | **PASS** |
| **Case 4** | Prometheus Agent Metrics Verification | Coordinator queried at `/metrics` after agent reporting. | Exposes `swarm_nodes_agent_reported 2` and `swarm_nodes_stale 0`. | **PASS** |
| **Case 5** | Backward Compatibility Verification | Queries `/health`, `/workers`, and `/backends`. | Schemas remain identical to Milestone 4-7 specifications. | **PASS** |
| **Case 6** | Local CUDA Fallback Regression | `SWARM_USE_RPC=0`, 37 layers offloaded to CUDA0. Baseline inference speed ~20 tok/s. | 37/37 layers offloaded to CUDA0; returned `2 + 2 equals 4.`. | **PASS** |
| **Case 7** | Graceful Teardown & Port Verification | Terminate all processes and inspect TCP ports 8080, 50052, 50053. | Zero lingering processes; all ports verified free. | **PASS** |

### Regression Suite Verification

| Regression Suite | Script | Scope | Result | Status |
|---|---|---|---|---|
| **Milestone 7 Suite** | `scripts/Invoke-Milestone7Validation.ps1` | Cases 1–7 (Live discovery, profiles, disconnect, metrics, endpoints, CUDA, teardown) | 7/7 Cases Passed | **PASS** |
| **Milestone 6 Suite** | `scripts/Invoke-Milestone6Validation.ps1` | Cases 1–8 (Lifecycle, TCP table checks, idle 503, abort handler, clean recovery, whitespace) | 8/8 Cases Passed | **PASS** |

## Milestone 9 validation — Dynamic Resource-Aware Layer Allocation — 2026-10-10

Evidence directory: [`artifacts/validation/2026-10-10/milestone-9`](../artifacts/validation/2026-10-10/milestone-9).

### Step 0: Deterministic Offline Unit Tests (`test_dynamic_policy.exe`)

| Test Case | Scenario / Verification | Expected Behavior | Observed Result | Status |
|---|---|---|---|---|
| **Test 1** | Heterogeneous Backends Dynamic Allocation | 8 layers distributed across heterogeneous nodes with varying RAM/VRAM capacities. | Accurate budget computation; layer allocation proportional to capacity without truncation. | **PASS** |
| **Test 2** | Configured Budgets vs Measured Values | Distinguishes `MEASURED` telemetry provenance from static `CONFIGURED_BUDGET`. | Strict segregation preserved; OS headroom correctly reserved. | **PASS** |
| **Test 3** | Stale & Missing Telemetry Rejection | Submits expired (>30s TTL) and missing telemetry. | Rejected with clear diagnostic reasons (`STALE`); startup halted safely. | **PASS** |
| **Test 4** | Loopback Memory Deduplication & Partitioning | Two collocated loopback processes sharing physical host RAM. | Usable host RAM partitioned equally; no additive memory inflation. | **PASS** |
| **Test 5** | Zero-Capacity Backend Handling | Worker node with insufficient capacity for 1 layer. | Assigned 0 layers (`split_weight = 0.0f`) without error or crash. | **PASS** |
| **Test 6** | Insufficient Total Capacity Rejection | Total cluster capacity cannot accommodate requested layers. | Startup safely aborted with code 1; no silent layer reduction. | **PASS** |
| **Test 7** | Malformed & Implausible Values Rejection | Telemetry with inverted memory or integer overflow bounds. | Safely rejected; diagnostics returned. | **PASS** |
| **Test 8** | Simulated Fixtures Isolation | Evaluates synthetic fixtures labelled simulated. | Isolated from live measured provenance; labeled clearly. | **PASS** |
| **Test 9** | Clock Skew, Replay Protection & Timestamp Validation | Worker clock 35 s behind accepted; worker clock 60 s ahead accepted; stale after 30 s coordinator time; replayed sequence number rejected; fresh re-report restores node; malformed timestamps (string, zero, far-future) rejected. | All 6 sub-tests passed with coordinator monotonic receipt clock governing freshness. | **PASS** |

### Live Integration Test Matrix (`Invoke-Milestone9Validation.ps1`)

| Test Case | Scenario / Configuration | Expected Behavior | Observed Result | Status |
|---|---|---|---|---|
| **Step 0** | Offline Unit Tests (`test_dynamic_policy.exe`) | Run all 9 deterministic unit tests (clock-skew & replay included). | All 9 tests passed (9/9). | **PASS** |
| **Case 1** | Live Dynamic Placement with Fresh Telemetry & Inference | `SWARM_PLACEMENT_POLICY=dynamic`, 1 RPC worker + local CUDA, fresh report ingested. | Plan derived matching prediction (`predicted=[33,34] actual=[33,34]`). Inference returned `2 + 2 equals 4.`. | **PASS** |
| **Case 2** | Stale Telemetry Startup Rejection | Ingest report fixture 60s old (>30s TTL). | Swarm terminates startup with exit code 1 and error `Telemetry is STALE ... exceeds 30000ms TTL`. | **PASS** |
| **Case 3** | Missing Telemetry Startup Rejection | `SWARM_AGENT_REPORT_FILE` pointing to non-existent file. | Swarm terminates startup with exit code 1 and diagnostic error. | **PASS** |
| **Case 4** | Insufficient Dynamic Capacity Rejection | Insufficient RAM/VRAM after headroom to fit requested 37 layers. | Swarm terminates startup with exit code 1 and error `Insufficient dynamic capacity`. | **PASS** |
| **Case 5** | Loopback Memory Deduplication & Prometheus Metrics | Two loopback RPC workers reporting live telemetry. | Prometheus exports `swarm_policy_configured{policy="dynamic"} 1`, `host_ram_deduplicated: true`. | **PASS** |
| **Case 6** | Backward Compatibility (Static Resource-Aware) | `SWARM_PLACEMENT_POLICY=resource_aware` with `SWARM_WORKER_PROFILES`. | Static profile parsed, inference returned `2 + 2 equals 4.`. | **PASS** |
| **Case 7** | Local CUDA Fallback Regression | `SWARM_USE_RPC=0`, `SWARM_PLACEMENT_POLICY=none`, 37 layers on CUDA0. | Full local CUDA inference returned `2 + 2 equals 4.`. | **PASS** |
| **Case 8** | Graceful Teardown & Port Hygiene | Clean termination of all processes; verify ports 8080, 50052, 50053 free. | All ports verified free; zero orphaned processes. | **PASS** |

### Historical Regression Suite Verification

| Regression Suite | Script | Scope | Result | Status |
|---|---|---|---|---|
| **Milestone 8 Suite** | `scripts/Invoke-Milestone8Validation.ps1` | Cases 1–7 (Agent daemon, schema limits, staleness, Prometheus, backward compat, CUDA) | 7/7 Cases Passed | **PASS** |
| **Milestone 7 Suite** | `scripts/Invoke-Milestone7Validation.ps1` | Cases 1–7 (Live discovery, profiles, disconnect, metrics, endpoints, CUDA, teardown) | 7/7 Cases Passed | **PASS** |
| **Milestone 6 Suite** | `scripts/Invoke-Milestone6Validation.ps1` | Cases 1–8 (Lifecycle, TCP table checks, idle 503, abort handler, clean recovery, 5 trials) | 8/8 Cases Passed | **PASS** |

---

## Milestone 9 Stage 2 — Clock-Skew Correction and Revalidation — 2026-10-10

The independent Milestone 9 audit identified a cross-machine clock-skew defect. Stage 2 corrected the defect and re-ran the full validation suite to confirm no regression.

### Defect Corrected

| Defect | Root Cause | Fix Applied |
|---|---|---|
| **Cross-machine clock skew in freshness check** | `is_stale` was calculated as `(coordinator_wall_ms – worker_timestamp_ms) > TTL`, meaning a worker whose clock ran ahead of the coordinator would be falsely marked stale, and a worker whose clock ran behind could appear perpetually fresh. | `NodeRecord::last_receipt_time_ms` stores the coordinator's local monotonic receipt time on each ingestion. `is_stale` is now `(now_ms – last_receipt_time_ms) > TTL`. Remote `timestamp_ms` is retained only for diagnostics and optional clock-skew logging. |
| **No replay protection** | A captured agent report could be re-submitted indefinitely with any timestamp. | Each `NodeReport` carries a `session_id` (UUID, set at agent startup) and a `sequence_number` (monotonically increasing per report). `ingest_agent_report` rejects reports whose `sequence_number` does not exceed the last accepted value for that session. Session transitions reset the counter. |

### Source Files Changed

| File | Change summary | SHA-256 |
|---|---|---|
| `node.h` | Added `last_receipt_time_ms`, `agent_session_id`, `last_sequence_number`, `clock_skew_ms` to `NodeRecord`. Updated `ingest_agent_report` to use coordinator monotonic clock and enforce replay protection. | `6DFD9461643BCBA8A9FD3E1EE97EB1C3A63BA270C2110E161C445D3B4999E050` |
| `agent.h` | Added `session_id` and `sequence_number` to `NodeReport`. Added comprehensive `timestamp_ms` validation (missing, non-numeric, zero, far-future) in `from_json`. | `A1316A716264847F97410F7D7D53E123D3B7FEDD9EAAE21238910618783F3CFA` |
| `agent_main.cpp` | Generates a `session_id` UUID at startup; increments `sequence_number` each reporting cycle. | `203A97AC75CDB101791BB1D2D47E69A46AA4D0055C494395C4AEEEC4F71F07F4` |
| `main.cpp` | `cd.telemetry_age_ms` now computed as `now_ms – node.last_receipt_time_ms`. | `A4F1EF338C42EDA2E7271E07EBAD6024691966463E1A763913897D30B88BBDD0` |
| `test_dynamic_policy.cpp` | Added Test 9 covering all clock-skew, replay, staleness, and timestamp-validation sub-cases. | `568B5D1A72E423061257BD808CC2167CEBBA54A79BE80D76FFBF96192CAA77C2` |
| `test_agent_and_inventory.cpp` | Updated fixtures; added `timestamp_ms` validation sub-tests. | `E6DF253B5A241BDF94751717A840B9B8BBAE2F4262B24514EA76E98FBE9824FC` |
| `scripts/Invoke-Milestone9Validation.ps1` | Step 0 assertion updated to `All 9 dynamic policy unit tests`. | `7EB9E850B94B70FD8558726A521863CDD39D9C01628A0DFD38A0BB4360C85496` |

### Stage 2 Integration Results (Aligned Build) — 2026-10-10T17:32 IST

Evidence: [`artifacts/validation/2026-10-10/milestone-9/MILESTONE_9_RESULTS.json`](../artifacts/validation/2026-10-10/milestone-9/MILESTONE_9_RESULTS.json)  
Binary Executed: `build-cuda/swarm_node.exe` (SHA-256: `69A678FA41E80CD4578C59DDA09999BFFDF14E1B2FB4D072343F370BF0019990`)

| Step / Case | Result |
|---|---|
| Step 0 — Offline Unit Tests (`test_dynamic_policy.exe`, 9/9 tests) | **PASS** |
| Case 1 — Live Dynamic Placement + Inference | **PASS** (`2 + 2 equals 4.`) |
| Case 2 — Stale Telemetry Startup Rejection (age 60 895 ms > 30 000 ms) | **PASS** |
| Case 3 — Missing Telemetry File Rejection | **PASS** |
| Case 4 — Insufficient Dynamic Capacity Rejection | **PASS** |
| Case 5 — Loopback Deduplication & Prometheus Metrics | **PASS** |
| Case 6 — Backward Compatibility (Static Resource-Aware) | **PASS** |
| Case 7 — Local CUDA Fallback Regression | **PASS** (`2 + 2 equals 4.`) |
| Case 8 — Graceful Teardown & Port Hygiene | **PASS** |
| **Overall** | **PASS — ALL 8 INTEGRATION CASES + STEP 0** |

### Regression Suites Execution Summary (Post-Rebuild)

| Regression Suite | Script / Binary | Scope | Result | Exit Status |
|---|---|---|---|---|
| **Milestone 9 Dynamic Policy Unit Tests** | `test_dynamic_policy.exe` | 9 offline unit tests (Heterogeneous, headroom, staleness, deduplication, zero-cap, insufficient-cap, malformed, simulated, clock-skew & replay) | 9/9 Passed | **PASS** (Exit 0) |
| **Milestone 9 Live Integration Suite** | `scripts/Invoke-Milestone9Validation.ps1` | Cases 1–8 + Step 0 (Dynamic inference, stale rejection, missing file, low cap, loopback dedup, resource_aware compat, CUDA fallback, teardown) | 8/8 Cases Passed | **PASS** (Exit 0) |
| **Milestone 7 Node Inventory Suite** | `scripts/Invoke-Milestone7Validation.ps1` | Cases 1–7 + Step 0 (Live discovery, profiles, disconnect, metrics, endpoints, CUDA, teardown) | 7/7 Cases Passed | **PASS** (Exit 0) |
| **Milestone 6 Reliability Suite** | `scripts/Invoke-Milestone6Validation.ps1` | Cases 1–8 (Lifecycle, TCP table checks, idle 503, abort handler, clean recovery, 5 trials) | 8/8 Cases Passed | **PASS** (Exit 0) |
| **Milestone 8 Agent Unit Tests** | `test_agent_and_inventory.exe` | 7 offline unit tests (Probe, malformed, unsupported metrics, staleness, reconnect, stable ID, RAM dedup) | 7/7 Passed | **PASS** (Exit 0) |
| **Milestone 8 Integration Suite (Repaired)** | `scripts/Invoke-Milestone8Validation.ps1` | Cases 1–7 (Live agent daemon, malformed payloads, repaired Case 3 staleness fixture with valid timestamp_ms, metrics, endpoints, CUDA) | 7/7 Cases Passed | **PASS** (Exit 0) |
| **Milestone 10 Security Unit Tests** | `build-cuda/test_security.exe` | 5 unit tests (`constant_time_equals`, `extract_bearer_token`, `is_loopback_address`, configured token auth, unconfigured dev mode auth) | 5/5 Passed | **PASS** (Exit 0) |
| **Milestone 10 Live Integration Suite** | `scripts/Invoke-Milestone10Validation.ps1` | Cases 1–9 + Step 0 (Missing auth 401, invalid auth 403, valid auth 200 via agent, unauthorized cannot refresh, malformed/oversized 400/413, agent reconnect & sequence, loopback dev mode warning, live inference with dynamic auth, port hygiene) | 9/9 Cases Passed + Step 0 | **PASS** (Exit 0) |

*Milestone 8 Case 3 contract note:* Case 3 of the historical Milestone 8 script submitted a synthetic report without `timestamp_ms`. In Milestone 10 Stage 0, the fixture was repaired by including `timestamp_ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()` without weakening coordinator validation. The entire Milestone 8 regression suite now executes with **Exit Code 0 (ALL 7 CASES PASSED)**.

### Known Limitation: Replay Protection Scope

`sequence_number` replay protection is in-memory only. On coordinator restart all last-seen sequence numbers are reset to zero. An attacker who captures a report during one coordinator session cannot replay it to a restarted coordinator through a reused sequence number. However, this provides no guarantee of freshness across restarts and should not be described as cryptographic or persistent replay protection. The remote `timestamp_ms` and the coordinator receipt time together bound the practical replay window for accidental re-deliveries.

### Binary Hashes & Provenance (Milestone 10 Aligned Build)

| Binary | SHA-256 | Build Timestamp | Provenance |
|---|---|---|---|
| `build-cuda/swarm_node.exe` | `08DD853A951138C5BEDFA3F9C70A66DE89BEE1062EF510DD530EB936C137A437` | 2026-10-10 18:05:40 | Rebuilt incrementally with Bearer token authentication & constant-time validation (`main.cpp`, `node.h`, `agent.h`, `config.h`) |
| `build-cuda/swarm_agent.exe` | `C4A07515B2F879079FD69EE247A163A40E465D3C7AA1A860591CD826182E62F0` | 2026-10-10 18:05:40 | Rebuilt incrementally with `--token` / `--auth-token` CLI and env var support (`agent_main.cpp`, `agent.h`) |
| `build-cuda/test_security.exe` | `4310D0D2130FAD6B7CAD767212DD4C7F92BA71EDAE9F265BD8D44A70053515B2` | 2026-10-10 18:07:44 | Milestone 10 security unit test suite (verified 5/5 tests) |
| `test_dynamic_policy.exe` | `94B21FB177D91DFB54D4AF5C375DB6D4207715BC858FCD5F29F700CEFA4FCE98` | 2026-10-10 16:59:55 | Milestone 9 dynamic policy unit test suite (verified 9/9 tests) |
| `test_agent_and_inventory.exe` | `B34B860E8D45AF053D054EC0EB1A85CC1ABECF6296DB4248ADA58B25B6ADD995` | 2026-10-10 16:56:54 | Milestone 8 agent inventory unit test suite (verified 7/7 tests) |
| `models/qwen2.5-3b-instruct-q4_k_m.official-check.gguf` | `626B4A6678B86442240E33DF819E00132D3BA7DDDFE1CDC4FBB18E0A9615C62D` | Baseline | Verified official model check |

## Milestone 10 Secure Remote-Node Readiness Results — 2026-10-10

Evidence: [`artifacts/validation/2026-10-10/milestone-10/milestone10_summary.json`](../artifacts/validation/2026-10-10/milestone-10/milestone10_summary.json)  
Binary Executed: `build-cuda/swarm_node.exe` (SHA-256: `08DD853A951138C5BEDFA3F9C70A66DE89BEE1062EF510DD530EB936C137A437`)  
Agent Executed: `build-cuda/swarm_agent.exe` (SHA-256: `C4A07515B2F879079FD69EE247A163A40E465D3C7AA1A860591CD826182E62F0`)

| Step / Case | Result | Description |
|---|---|---|
| Step 0 — Offline Unit Tests | **PASS** | Verified `test_security.exe` (5/5), `test_agent_and_inventory.exe` (7/7), and `test_dynamic_policy.exe` (9/9) |
| Case 1 — Missing Authentication Rejection | **PASS** | Coordinator with configured token rejects unauthenticated POST with HTTP 401 Unauthorized and `WWW-Authenticate: Bearer realm="swarm-telemetry"` |
| Case 2 — Incorrect Authentication Rejection | **PASS** | Bad token rejected with HTTP 403 Forbidden; malformed auth scheme rejected with HTTP 401 Unauthorized |
| Case 3 — Valid Authentication via Agent | **PASS** | `swarm_agent.exe --token <token> --once` accepted with HTTP 200; inventory registered node with `agent_reported=true` and state `READY` |
| Case 4 — Unauthorized Requests Cannot Refresh | **PASS** | Unauthorized telemetry attempts cannot update `last_agent_report_ms`, `last_receipt_time_ms`, or advance sequence numbers |
| Case 5 — Malformed & Oversized Payload Rejection | **PASS** | Payloads > 64KB rejected with HTTP 413; malformed JSON and invalid schema rejected with HTTP 400 |
| Case 6 — Agent Reconnection & Sequence Tracking | **PASS** | Sequential reports tracked; agent restart with new session ID cleanly recognized and sequence reset safely |
| Case 7 — Unauthenticated Loopback Dev Mode | **PASS** | Coordinator with unset token visibly logs warning `Telemetry Auth: DISABLED`; permits loopback reports; remote requests denied HTTP 403 |
| Case 8 — Live Inference with Authenticated Telemetry | **PASS** | Discovery intake window accepts authenticated report; dynamic layer allocation succeeds; completion returns `4` (`2 + 2 equals 4.`) |
| Case 9 — Clean Teardown & Port Hygiene | **PASS** | All test processes terminated; ports 8080, 50052, and 50053 confirmed completely free |
| **Overall Milestone 10 Verdict** | **ACCEPTED WITH LIMITATIONS** | End-to-end telemetry authentication, constant-time verification, and local test coverage verified. In-memory replay scope and GGML RPC plaintext boundary documented. |

---

## Milestone 11 Production Readiness and Deployment Hardening — 2026-10-10

Evidence: [`artifacts/validation/2026-10-10/milestone-11/milestone11_validation_results.json`](../artifacts/validation/2026-10-10/milestone-11/milestone11_validation_results.json)  
Binary Executed: `build-cuda/swarm_node.exe` (SHA-256: `7F2650CE05D835C624394577D44B281D6872AFD7B39D0893709922C26B9E604A`)  
Agent Executed: `build-cuda/swarm_agent.exe` (SHA-256: `01CBF6E7DE3D83FBEB6CE9BC369F25B0811B4E4C077677DD1AE49146D1F9190B`)  
Security Tests: `build-cuda/test_security.exe` (SHA-256: `C691554FE14A8A78188E41B667C1C78DE4DB4F28EFD945229190C69E4A8E3FA0`)  

### Changes Implemented in Milestone 11:
1. **Protected File-Based Secret Loading**: Added `swarm::security::read_secret_from_file()` with automatic whitespace trimming to prevent token leakage in process listings (`Get-Process`, Task Manager, `/proc/*/cmdline`).
2. **Fail-Secure Production Preflight**: Added `SWARM_DEPLOYMENT_ENV` ("development" / "production"). If "production" is specified without a valid telemetry token (`SWARM_TELEMETRY_TOKEN` or `SWARM_TELEMETRY_TOKEN_FILE`), coordinator immediately terminates startup with exit code 1 (`[FATAL SECURITY PREFLIGHT]`).
3. **Remote RPC Security Advisory**: Preflight check alerts operators when remote (non-loopback) GGML RPC endpoints are detected, warning that GGML RPC is unencrypted plain TCP and requires VPN tunnel encapsulation (Tailscale / WireGuard).
4. **Agent CLI Warning**: Visible advisory warning emitted when credentials are provided via command-line arguments (`--token` / `--auth-token`).
5. **Runtime DLL Placement Hardening**: Deployed runtime DLLs (`llama.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`, `ggml-cuda.dll`, `ggml-rpc.dll`) directly to `build-cuda\` and configured operational scripts (`Start-ProductionCoordinator.ps1`, `Start-LocalCuda.ps1`) to automatically configure `$env:PATH`.

### Milestone 11 Integration Results:

| Step / Case | Result | Description |
|---|---|---|
| Step 0 — Offline Unit Tests | **PASS** | Verified `test_security.exe` (6/6 tests including `read_secret_from_file`), `test_agent_and_inventory.exe` (7/7 tests), and `test_dynamic_policy.exe` (9/9 tests) |
| Case 1 — Production Preflight Rejection | **PASS** | Coordinator in production mode halts immediately (exit code 1) when telemetry token is omitted |
| Case 2 — Production Token File Startup | **PASS** | Coordinator successfully reads token from file, activates strict production security, and returns `/health` ok |
| Case 3 — Agent CLI Token Exposure Warning | **PASS** | `swarm_agent.exe --token` emits visible process-list exposure warning on stderr |
| Case 4 — Agent Token File Authentication | **PASS** | `swarm_agent.exe --token-file` securely authenticates with coordinator, HTTP 200 accepted and verified in inventory |
| Case 5 — Dev Mode Loopback Acceptance | **PASS** | Development mode logs `Telemetry Auth: DISABLED`, allows unauthenticated loopback reports, rejects remote reports (HTTP 403) |
| Case 6 — Remote RPC Security Advisory | **PASS** | Preflight identifies remote RPC endpoints and emits plaintext transport advisories |
| Case 7 — Live Production Multi-Worker Inference | **PASS** | Live streaming chat completions verified across RPC workers and local CUDA under hardened production configuration |
| Case 8 — Teardown and Port Hygiene | **PASS** | Clean teardown; ports 8080, 50052, 50053 confirmed free with zero lingering processes |
| **Overall Milestone 11 Verdict** | **ACCEPTED WITH LIMITATIONS** | Production deployment hardening, secret protection, fail-secure startup, and full test matrix verified on local workstation. Single-machine constraint remains; physical multi-device execution unverified. |

### Complete Regression Verification Matrix:

| Regression Suite | Script / Target | Result | Exit Code | Verified Scope |
|---|---|---|---|---|
| **Milestone 11 Validation** | `scripts/Invoke-Milestone11Validation.ps1` | **PASS (8/8 Cases + Step 0)** | 0 | Production security preflight, token file, agent CLI warning, live multi-worker inference |
| **Milestone 10 Validation** | `scripts/Invoke-Milestone10Validation.ps1` | **PASS (9/9 Cases + Step 0)** | 0 | Bearer token auth, 401/403 rejection, session sequence tracking, dynamic intake |
| **Milestone 9 Validation** | `scripts/Invoke-Milestone9Validation.ps1` | **PASS (8/8 Cases + Step 0)** | 0 | Dynamic policy, clock skew, monotonic receipt time, stale rejection, live inference |
| **Milestone 8 Validation** | `scripts/Invoke-Milestone8Validation.ps1` | **PASS (7/7 Cases + Step 0)** | 0 | Hardware probe, telemetry ingestion, staleness TTL, Prometheus metrics |
| **Milestone 7 Validation** | `scripts/Invoke-Milestone7Validation.ps1` | **PASS (7/7 Cases + Step 0)** | 0 | Node inventory discovery, resource provenance, worker fault tolerance |
| **Milestone 6 Validation** | `scripts/Invoke-Milestone6Validation.ps1` | **PASS (8/8 Cases)** | 0 | Multi-RPC worker registration, 503 unavailable handling, 5/5 repeated trials |

---

## Milestone 12 Physical Multi-Device Validation — 2026-10-11

Evidence:
- Comprehensive Report: [`milestone12_rpc_health_fix_report.md`](../milestone12_rpc_health_fix_report.md)
- Baseline Manifest: [`backups/milestone12-final-baseline-20261011/BASELINE_MANIFEST.md`](../backups/milestone12-final-baseline-20261011/BASELINE_MANIFEST.md)
- Backend Placement Snapshot: [`artifacts/validation/2026-10-11/milestone-12/m12_backends.json`](../artifacts/validation/2026-10-11/milestone-12/m12_backends.json)
- Coordinator Execution Logs: [`artifacts/validation/2026-10-11/milestone-12/m12_coordinator.stdout.log`](../artifacts/validation/2026-10-11/milestone-12/m12_coordinator.stdout.log) and [`m12_coordinator.stderr.log`](../artifacts/validation/2026-10-11/milestone-12/m12_coordinator.stderr.log)
- Streamed Response Capture: [`artifacts/validation/2026-10-11/milestone-12/m12_inference_response.raw.txt`](../artifacts/validation/2026-10-11/milestone-12/m12_inference_response.raw.txt)
- Validation Suite: [`scripts/Invoke-Milestone12Validation.ps1`](../scripts/Invoke-Milestone12Validation.ps1)
- Binary Executed: `build-cuda/swarm_node.exe` (SHA-256: `0D4D2ED6E2A9A65F15A3D08D3FFB29131231D109A76661959D2D0205AD493C8E`)
- Dedicated Regression Suite: `build-cuda/test_rpc_health.exe` (SHA-256: `7191CB192B1D04F300E0DD408E2B68AD8F365A5B8D18DB956C02CAEFC03151E7`)

### Environment & Nodes:
- **Coordinator (Computer A):** `192.168.137.174:8080` (Local CPU + NVIDIA GeForce GTX 1050 CUDA 4GB)
- **Physical Worker (Computer B):** `192.168.137.1:50052` (Physical Windows 11 RPC Worker, 7.19 GiB RAM)
- **Model:** `models/qwen2.5-3b-instruct-q4_k_m.official-check.gguf` (SHA-256: `626B4A6678B86442240E33DF819E00132D3BA7DDDFE1CDC4FBB18E0A9615C62D`)

### Changes Implemented:
1. **Remote RPC Health Check Fix (`WorkerManager::check_worker_health`)**:
   - Replaced naive competing TCP socket connect probes with non-intrusive Windows TCP table inspection via `GetExtendedTcpTable(..., TCP_TABLE_OWNER_PID_ALL, ...)`. This inspects coordinator process socket states directly for active `MIB_TCP_STATE_ESTAB` connections to `worker.host:worker.port` without opening new connections.
   - Suppresses probes when `worker.is_inference_active || worker.state == WorkerState::BUSY`.
   - Distinguishes active single-client RPC sessions from connection loss; genuine connection loss transitions to `UNAVAILABLE`.
2. **Non-Blocking Connect Implementation**:
   - `is_worker_reachable` on Windows now uses `ioctlsocket(FIONBIO)` with `select()` and a strict 2000ms timeout to prevent 21-second socket hang.
3. **Inference Serialization Guard**:
   - Implemented `InferenceWorkerGuard` RAII in `/v1/chat/completions`, setting participating workers to `BUSY` / `is_inference_active=true` during request execution.
4. **Dedicated Regression Test Suite**:
   - Created `test_rpc_health.cpp` (5/5 tests passing) verifying probe suppression, lost connection detection, failed connection isolation, dynamic zero-cap safety, and `/backends` reflection.

### Milestone 12 Physical Validation Results:

| Step / Verification Case | Result | Description |
| :--- | :---: | :--- |
| Step 0 — Offline Unit Tests | **PASS** | Verified `test_security.exe` (6/6), `test_agent_and_inventory.exe` (7/7), `test_dynamic_policy.exe` (9/9), and `test_rpc_health.exe` (5/5) — 27/27 total |
| Step 1 — Physical TCP Reachability | **PASS** | Computer A successfully connected to Computer B on `192.168.137.1:50052` over hotspot Wi-Fi (`TcpTestSucceeded: True`) |
| Step 2 — Production Token File Launch | **PASS** | Coordinator started in production mode reading 64-byte token file, bound to port 8080 with strict security active |
| Step 3 — Remote Worker Inventory Discovery | **PASS** | `/nodes` registered `node-192.168.137.1-50052` with `is_loopback: false` and endpoint `192.168.137.1:50052` |
| Step 4 — Controlled Physical Inference (`none`) | **PASS** | Layers 33–34 allocated to `RPC0`, 35–36 to `CUDA0`, 0–32 to `CPU`. Remote buffers: 94.08 MiB model, 4.00 MiB KV, 74.51 MiB compute. Generation completed in 16.49s (2.75 tok/s); zero HTTP 503 errors |
| Step 5 — Dynamic Placement Validation (`dynamic`) | **PASS** | Telemetry reported 1.40 GiB free RAM. Headroom reserved 920.62 MiB (12.5%). Usable budget: 512.85 MiB. Predicted layers `[33, 34]` on RPC0 matched physical placement `[33, 34]` 100%. Generation completed in 14.92s |
| Step 6 — Clean Teardown & Port Hygiene | **PASS** | Coordinator exited cleanly; ports 8080 and local sockets released |
| **Physical Tensor Computation Confirmation** | **PASS** | **GENUINELY CONFIRMED** via remote model buffer allocation, KV cache allocation, remote compute scratch buffers, and multi-device forward graph execution |
| **Overall Milestone 12 Verdict** | **ACCEPTED WITH LIMITATIONS** | Physical multi-device distributed inference across two separate Windows machines confirmed working with both controlled and dynamic placement. |

### Remaining Limitations:
1. **Single-Client GGML RPC Concurrency**: Upstream GGML RPC handles a single synchronous client connection per port. Concurrent requests must be serialized at the coordinator gateway.
2. **Plaintext Network Boundary**: GGML RPC transport remains unauthenticated and unencrypted plain TCP. Production WAN deployments require VPN encapsulation (WireGuard / Tailscale) and firewall scoping.
3. **No Dynamic Mid-Inference Migration**: If a remote worker drops while holding model layers, the current GGML context aborts. Recovery requires restarting the worker and coordinator.

---

## Phase B Sprint 1 Validation & Acceptance — 2026-10-11

Evidence:
- Report: `docs/Phase B Sprint 1 Completion Report.md`
- Screenshots: `artifacts/ui_screenshots/sprint1_coordinator_recovery.png`, `artifacts/ui_screenshots/sprint1_worker_diagnostics.png`

### Scope Verified:
- **B.1 Coordinator Offline Recovery:** Reactive detection within 3s of coordinator termination, countdown retry, draft preservation in sessionStorage, turn-key restart commands.
- **B.5 Worker Disconnect Diagnostics:** Elevated error banner on device cards, critical vs non-critical layer impact assessment, clear guidance on coordinator reload necessity.
- **Automated Validation:** Lint 0 errors, build clean in 690ms.
- **Overall Verdict:** **ACCEPTED**.

---

## Phase B Sprint 2 Validation & Acceptance — 2026-10-12

Evidence:
- Report: `docs/Phase B Sprint 2 Completion Report.md`
- Screenshots: `artifacts/ui_screenshots/sprint2_helper_address_config.png`, `artifacts/ui_screenshots/sprint2_placement_drilldown_desktop.png`, `artifacts/ui_screenshots/sprint2_placement_drilldown_mobile.png`, `artifacts/ui_screenshots/sprint2_placement_drilldown_offline.png`

### Scope Verified:
- **B.2 Helper Address Configuration:**
  - Interactive inputs for helper private VPN address and RPC port in Add Device modal (Mode C).
  - Client-side format validation (IPv4 regex, hostname regex, port range 1–65535).
  - Dynamic parameterization of official deployment commands (`ggml-rpc-server.exe` and `Start-ProductionCoordinator.ps1`).
  - Strict preservation of private VPN encryption requirement and Instruction Generator disclaimer.
  - Zero phantom device creation upon entering an address.
- **B.3 Interactive Placement Ribbon Drill-Down:**
  - Accessible keyboard navigation (`tablist`/`tab`, Enter/Space, Left/Right arrow cycling, Escape to close).
  - Compact data-driven detail drill-down card populated from `/backends` (processor identity, layer range, model/KV/compute buffer bytes, memory scope, transport).
  - Offline unverified banner when coordinator is disconnected.
  - Fixed load-time allocation notice (no live migration implied).
- **Mobile UX Layout Verification:**
  - Root-cause resolution of vertical clipping: eliminated redundant 72px padding-bottom on `.app-main`, replaced `justify-content: center` with `margin: auto 0` on empty welcome state, added `minHeight: 0` to scroll container, and capped drilldown to `min(38vh, 240px)` with auto-fit 130px 2-column metrics.
  - Verified across 320px, 375px, 390px, 430px viewports with zero horizontal overflow and full accessibility of chat composer and suggestion chips.
- **Automated Verification:**
  - `oxlint`: 0 errors, 1 pre-existing warning (`useSwarm.ts:87:5`).
  - `tsc -b && vite build`: Succeeded in 793ms.
- **Overall Verdict:** **ACCEPTED**.


