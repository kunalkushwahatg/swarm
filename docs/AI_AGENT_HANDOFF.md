# AI agent handoff

This document provides essential operational context, baseline hashes, and verification procedures.
Treat fresh source inspection and runtime checks as authoritative if this handoff becomes stale.

## System Environment

- **Operating System:** Windows development host (Windows 10/11 x64).
- **Toolchain:** Visual Studio 2022 Build Tools (MSVC v143), CMake (v3.14+), NMake Makefiles.
- **Hardware Acceleration:** NVIDIA GeForce GTX 1050 (Compute Capability 6.1, ~4 GiB VRAM).
- **Core Engine:** Bundled `llama.cpp/` providing GGML tensor library, CUDA kernels, and GGML RPC v7.
- **Active Build Config:** CMake flags `-DGGML_CUDA=ON -DGGML_RPC=ON -DCMAKE_CUDA_ARCHITECTURES=61 -DCMAKE_BUILD_TYPE=Release`.

## Validated baseline

Project: `C:\Users\kunal\OneDrive\Desktop\swarm`

Build:

```bat
cmake --build build-cuda --target swarm_node --config Release
```

Runtime:

```text
SWARM_USE_RPC=0
SWARM_MODEL_PATH=C:\Users\kunal\OneDrive\Desktop\swarm\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf
SWARM_N_GPU_LAYERS=-1
```

The official model hash is
`626B4A6678B86442240E33DF819E00132D3BA7DDDFE1CDC4FBB18E0A9615C62D`.
Local CUDA passed with 37/37 layers and sensible output.

Current file hashes:

```text
build-cuda/swarm_node.exe
7F2650CE05D835C624394577D44B281D6872AFD7B39D0893709922C26B9E604A

build-cuda/swarm_agent.exe
01CBF6E7DE3D83FBEB6CE9BC369F25B0811B4E4C077677DD1AE49146D1F9190B

build-cuda/test_security.exe
C691554FE14A8A78188E41B667C1C78DE4DB4F28EFD945229190C69E4A8E3FA0

test_dynamic_policy.exe
94B21FB177D91DFB54D4AF5C375DB6D4207715BC858FCD5F29F700CEFA4FCE98

models/qwen2.5-3b-instruct-q4_k_m.official-check.gguf
626B4A6678B86442240E33DF819E00132D3BA7DDDFE1CDC4FBB18E0A9615C62D
```

> [!NOTE]
> `models/qwen2.5-3b-instruct-q4_k_m.official-check.gguf` is the sole canonical baseline model asset. The previously retained unverified model artifact `qwen2.5-3b-instruct-q4_k_m.gguf` (`B7AA5CE0...`) and unreferenced `llama-3-8b.gguf` were removed during workspace decluttering.

## RPC status

Opt-in loopback configuration:

```text
SWARM_USE_RPC=1
SWARM_RPC_ENDPOINT=127.0.0.1:50052
SWARM_N_GPU_LAYERS=4
```

Multi-endpoint loopback configuration:

```text
SWARM_USE_RPC=1
SWARM_RPC_ENDPOINTS=127.0.0.1:50052,127.0.0.1:50053
SWARM_N_GPU_LAYERS=4
```

The two endpoints are registered before model loading and remain available to
llama.cpp placement. In the validated run, layers 33 and 34 were assigned to
RPC0 and RPC1 respectively, while layers 35 and 36 were assigned to CUDA0.
Both RPC workers received model, KV, and compute buffers. Each loopback worker
reported the same host-wide memory view, so this is not independent capacity.

The CPU RPC server in `temp_rpc_build/bin` participated in the validated
loopback run. It allocated remote model/KV/compute buffers and layers 33-36
were reported on RPC0. The run returned `2 + 2 equals 4.`. A benchmark averaged
approximately 4,166 ms client latency and 5.47 tok/s versus 489 ms and
21.17 tok/s for full local CUDA. This is not evidence of LAN or multi-device
speedup, and the captured RPC placement did not prove CUDA0 also received a
layer.

## Preservation rules

Do not delete or overwrite `build-cuda`, `temp_rpc_build`, `llama.cpp`, either
Qwen model, source backups, or validation evidence. Do not modify inference
architecture, add scheduling, or claim PASS from worker readiness alone.
Keep experimental RPC loopback-only unless a trusted private-LAN test is
explicitly planned.

If a registered worker stops after model loading, the current process can fail
on an RPC transport error. Restarting the worker does not recreate the existing
model/context; use a clean Swarm restart.

## Fault-handling validation

Run the repeatable same-machine failure test with:

```powershell
.\scripts\Invoke-MultiRpcFaultTest.ps1
```

The script starts RPC0 on port 50052, RPC1 on port 50053, and Swarm on port
8080. It waits for readiness instead of relying only on fixed sleeps, verifies
the arithmetic response and both RPC model-buffer allocations, stops RPC1,
records the failed request and Windows Application Error event, and cleans up
only its own process IDs. Results and logs are written to
`artifacts/validation/2026-10-10/fault-handling/`.

The observed failure is below Swarm's recoverable HTTP layer. A disconnected
RPC send produces GGML's
`Remote RPC server crashed or returned malformed response` abort, and Windows
records exception `0xc0000409` in `ucrtbase.dll`. RPC0 remains reachable, but
the loaded model/context is not considered usable. Restarting RPC1 alone does
not recover the process; restart Swarm to recreate the model/context. There is
no transparent failover or silent local fallback.

## Milestone 4 observability status

Backend placement observability and accurate resource reporting are implemented and validated:

- **Observability endpoints:**
  - `GET /backends`: Full JSON inventory of all registered backends (CPU, CUDA, RPC), their device names, loopback status, memory scope, observed layer ranges (`[[33, 33]]`), model buffer bytes, KV buffer bytes, compute buffer bytes, and host physical memory.
  - `GET /workers`: Backward-compatible worker list enriched with backend ID, endpoint, backend type, loopback status, memory scope, assigned layer ranges, and buffer allocations.
  - `GET /metrics`: Standard Prometheus metrics including `swarm_backend_model_buffer_bytes`, `swarm_backend_kv_buffer_bytes`, `swarm_backend_compute_buffer_bytes`, `swarm_backend_assigned_layers`, and monotonic inference latency gauges.
  - `POST /v1/chat/completions`: Emits a penultimate timing chunk with `timings` object prior to `[DONE]` without altering OpenAI delta compatibility.
- **Memory scope:** Loopback RPC workers report `memory_scope: "shared_host"` and deduplicate physical host RAM.
- **Repeatable harness:** `scripts/Invoke-Milestone4Validation.ps1` tests both local CUDA and two-worker loopback RPC. Results are archived in `artifacts/validation/2026-10-10/milestone-4/`.

Validation artifacts are in
`../artifacts/validation/2026-10-10/`, with a move record in
`../artifacts/validation/2026-10-10/CLEANUP_MANIFEST.md`. The workspace has no
root `RTK.md`; existing `writing-block.md` and `andrej clad.md` in this
directory were preserved.

## Milestone 5 resource-aware placement policy status

Resource-aware placement policy and deterministic scheduling are implemented and validated:

- **Policy configuration:**
  - `SWARM_PLACEMENT_POLICY`: `none` (default) or `resource_aware`.
  - `SWARM_WORKER_PROFILES`: comma-delimited backend budgets (`RPC0=50MB,RPC1=500MB,CUDA0=4000MB`).
- **Policy implementation (`policy.h`):**
  - Strict profile parsing supporting units `B`, `KB`, `KiB`, `MB`, `MiB`, `GB`, `GiB`. Rejects malformed values, negative numbers, overflow, and duplicate keys.
  - Per-layer cost model based on Qwen 2.5 3B allocations (~92 MiB: 73 MiB model weights + 16 MiB KV cache + 2.25 MiB compute buffer per layer).
  - Capacities capped at `act_gpu_layers`. Split weights derived from capped capacities.
  - Ineligible devices (budget < 92 MiB) assigned `0.0f` weight, guaranteeing zero layers.
  - Total insufficient capacity checks prevent startup when $\sum C_i < \text{act\_gpu\_layers}$.
  - Simulates GGML's `std::upper_bound` allocation to verify runtime placement (`policy_match`).
- **Validation suites:**
  - Unit tests: `test_policy.exe` (7/7 passed).
  - Integration matrix: `scripts/Invoke-Milestone5Validation.ps1` (Cases 1–6, 8 passed).
  - Fault regression: `scripts/Invoke-MultiRpcFaultTest.ps1` (Case 7 passed).
  - Validation artifacts archived under `artifacts/validation/2026-10-10/milestone-5/`.

## Milestone 6 multi-node orchestration and reliability status

Multi-node orchestration, reliability, and controlled failure handling are implemented and validated:

- **Controlled failure handling:**
  - Idle/pre-inference loss of a required worker safely returns HTTP 503 (`Service Unavailable`) with structured JSON error details. Gateway remains alive and listening.
  - Zero-layer worker resilience: if an RPC worker assigned 0 layers drops out, inference proceeds uninterrupted without HTTP 503 or process abort.
  - `/health` exposes `inference.ready` reflecting required backends, exposing `required_rpc_workers`, `ready_required_rpc_workers`, and diagnosing unready required workers.
  - In-flight mid-decode worker failures trigger fatal `RPC_STATUS_ASSERT` / `GGML_ABORT`; captured via `ggml_set_abort_callback` to log stderr diagnostics before process termination (unrecoverable in-process).
  - Controlled clean restart recovery verified end-to-end.
- **Non-intrusive TCP health monitoring:**
  - Loopback worker reachability uses kernel listener table inspection via `GetExtendedTcpTable`, avoiding connection collisions on single-client `ggml-rpc-server`.
  - Remote endpoints resolve arbitrary hostnames and IP addresses via `getaddrinfo` (locally verified syntax; physical LAN deferred to Milestone 7).
  - Whitespace tolerance added to `SWARM_RPC_ENDPOINTS` parsing.
- **Process management hygiene:**
  - Swarm uses Win32 `TerminateProcess` on tracked child process handles during shutdown.
- **Validation suites:**
  - Automated test harness: `scripts/Invoke-Milestone6Validation.ps1` (Cases 1–8 all PASS).
  - Fault regression: `scripts/Invoke-MultiRpcFaultTest.ps1` (PASS).
  - Validation artifacts archived under `artifacts/validation/2026-10-10/milestone-6/`.

## Milestone 7 node inventory and resource discovery status

Node capability modeling, resource discovery, and cluster inventory observability are implemented and validated:

- **Node capability model (`node.h`):**
  - Defines `NodeRecord`, `DeviceCapability`, and `ResourceValue<T>`.
  - Tracks node identifiers, role (`gateway` vs `worker`), endpoint, loopback status, live connection state, inference readiness, assigned model layers, buffer allocations, and `is_required_by_model`.
  - Captures resource data provenance: `MEASURED` (OS / GGML API), `CONFIGURED_BUDGET` (`SWARM_WORKER_PROFILES`), `SIMULATED` (offline fixtures), and `UNKNOWN` (unmeasurable values serialized as `null`).
- **Cluster memory deduplication:**
  - `NodeInventory` marks loopback workers with `memory_scope: "shared_host"` and records `host_ram_deduplicated: true` in cluster summaries, strictly preventing additive host RAM inflation across collocated processes.
- **Endpoints and metrics:**
  - `GET /nodes`: Full JSON inventory of all cluster nodes, devices, provenance, and assigned layer requirements.
  - `GET /metrics`: Standard Prometheus metrics `swarm_nodes_total`, `swarm_nodes_online`, and `swarm_nodes_required`.
  - Endpoints `/health`, `/workers`, `/backends`, and `/metrics` retained with full backward compatibility.
- **Deterministic offline unit tests:**
  - `test_node_inventory.exe`: 7 unit test cases verifying provenance segregation, metadata validation, staleness detection, state transitions, model requirement flags, memory deduplication, and simulated fixture isolation (all 7 PASS).
- **Validation suites:**
  - Integration suite: `scripts/Invoke-Milestone7Validation.ps1` (Cases 1–7 all PASS).
  - Regression suite: `scripts/Invoke-Milestone6Validation.ps1` (Cases 1–8 all PASS).
  - Validation artifacts archived under `artifacts/validation/2026-10-10/milestone-7/`.

## Milestone 8 worker-side resource agent and coordinator integration status

Worker-side hardware resource reporting agent and coordinator integration are implemented and validated:

- **Worker resource reporting agent (`swarm_agent.exe`):**
  - Standalone, lightweight C++ binary (`agent_main.cpp` / `agent.h`) linking only Win32 `ws2_32`, `crypt32`, `dxgi`, and `advapi32`.
  - Hardware probing engine: Win32 `GlobalMemoryStatusEx` for host physical RAM total/available; `GetNativeSystemInfo` and registry query for CPU architecture, logical processor count, and model string; DXGI `CreateDXGIFactory` / `EnumAdapters` for dedicated GPU VRAM.
  - Honestly reports unmeasurable metrics (GPU/CPU thermals, fan RPM, GPU core utilization) as omitted / `null` in `unsupported_metrics`.
  - Supports `--coordinator`, `--node-id`, `--endpoint`, `--rpc-port`, `--interval-ms`, and `--once` CLI modes.
- **Coordinator report ingestion (`NodeInventory::ingest_agent_report`):**
  - Endpoints `POST /api/v1/nodes/report` and `POST /nodes/report`.
  - Enforces 64 KB request payload boundary (`SWARM_MAX_REPORT_PAYLOAD_BYTES`), rejecting oversized payloads with HTTP 413.
  - Rejects malformed JSON, invalid schema versions, and inverted RAM values (`available > total`) with HTTP 400.
  - Ingests reports into `NodeRecord` under `ResourceProvenance::MEASURED`. Preserves configured placement budgets (`CONFIGURED_BUDGET`).
- **Freshness tracking & staleness safety:**
  - 30-second TTL enforced via monotonic clock (`std::chrono::steady_clock`). Reports older than 30s transition to `is_stale: true`, `stale_reason: "Report exceeded 30000ms TTL"`, and connection state `UNAVAILABLE`.
  - Stale nodes are marked unready for inference and excluded from active scheduling calculations.
  - Re-reporting cleanly resets staleness and restores `READY` state.
- **Endpoints and metrics:**
  - `GET /nodes` reflects agent telemetry (`agent_reported`, `agent_version`, `report_age_ms`, `hardware`, `unsupported_metrics`).
  - `GET /metrics` exposes Prometheus gauges `swarm_nodes_agent_reported` and `swarm_nodes_stale`.
- **Validation suites:**
  - Offline unit tests: `test_agent_and_inventory.exe` (7/7 PASS).
  - Live integration suite: `scripts/Invoke-Milestone8Validation.ps1` (Cases 1–7 all PASS).
  - Regression suites: `scripts/Invoke-Milestone7Validation.ps1` (7/7 PASS) and `scripts/Invoke-Milestone6Validation.ps1` (8/8 PASS).
  - Validation artifacts archived under `artifacts/validation/2026-10-10/milestone-8/`.

## Milestone 9 dynamic resource-aware layer allocation status

Dynamic resource-aware layer allocation is implemented, verified, and regression-tested:

- **Conservative capacity estimator (`ConservativeCapacityEstimator`, `estimator.h`):**
  - Distinguishes measured total, genuinely available memory, configured budgets, model demand, and reserved OS/application headroom.
  - Headroom defaults: 1024 MiB RAM (`SWARM_RESERVED_HEADROOM_RAM_MB`), 256 MiB VRAM (`SWARM_RESERVED_HEADROOM_VRAM_MB`).
  - Strict loopback shared-host deduplication and partitioning: collocated loopback processes share physical host RAM equally, preventing additive capacity inflation.
  - Calibrated model- and context-aware layer cost: ~92 MiB per layer for Qwen 2.5 3B at context 2048.
- **Dynamic placement policy (`SWARM_PLACEMENT_POLICY=dynamic`):**
  - Derives split weights matching exact GGML contiguous device order (`RPC` backends, then `CUDA0`).
  - Stale (>30s TTL), missing, implausible, or insufficient telemetry safely halts startup with exit code 1 and actionable diagnostics; no silent layer reductions or unrequested fallback.
  - Supports offline report ingestion via `SWARM_AGENT_REPORT_FILE` and startup intake window via `SWARM_DISCOVERY_TIMEOUT_MS`.
- **Validation suites:**
  - Offline deterministic unit tests: `test_dynamic_policy.exe` (9/9 PASS, including clock-skew and replay protection).
  - Live integration suite: `scripts/Invoke-Milestone9Validation.ps1` (Cases 1–8 all PASS).
  - Historical regression suites: Milestone 8 (7/7 PASS), Milestone 7 (7/7 PASS), Milestone 6 (8/8 PASS).
  - Validation artifacts archived under `artifacts/validation/2026-10-10/milestone-9/`.

## Milestone 10 secure remote-node readiness status

Secure remote-node readiness and authenticated telemetry reporting are implemented, verified, and regression-tested:

- **Bearer token telemetry authentication (`POST /api/v1/nodes/report`):**
  - Configured via `SWARM_TELEMETRY_TOKEN` / `SWARM_AUTH_TOKEN` environment variables; supported via `--token` / `--auth-token` CLI flags on `swarm_agent.exe`.
  - Constant-time secret comparison (`swarm::security::constant_time_equals`) with volatile bitwise XOR accumulator.
  - Strict pre-parse error discrimination: 401 Unauthorized (`WWW-Authenticate: Bearer`), 403 Forbidden (bad token / remote unauth), 413 Payload Too Large (>64KB), 400 Bad Request (malformed/schema).
  - Node inventory isolation: unauthenticated requests cannot mutate `NodeInventory`, advance sequence numbers, or refresh telemetry timestamps.
  - Unauthenticated loopback development mode explicitly supported with visible coordinator startup warning.
- **Transport security & GGML RPC boundary:**
  - Upstream GGML RPC protocol is natively unauthenticated and unencrypted plain TCP. Protecting HTTP telemetry alone does not protect GGML RPC tensors.
  - Plain HTTP Bearer tokens are safe only on loopback or inside an encrypted network overlay.
  - Remote multi-computer execution requires isolating RPC communication inside a private encrypted overlay (WireGuard / Tailscale) with host firewall rules.
- **Repaired Milestone 8 stale-report fixture:**
  - `scripts/Invoke-Milestone8Validation.ps1` Case 3 fixture repaired to include valid `timestamp_ms` without weakening coordinator validation. Full suite now passes (7/7 PASS).
- **Validation suites:**
  - Security unit tests: `build-cuda/test_security.exe` (5/5 PASS).
  - Live integration suite: `scripts/Invoke-Milestone10Validation.ps1` (Cases 1–9 all PASS + Step 0).
  - Full regression suites: Milestone 9 (8/8 PASS), Milestone 8 (7/7 PASS), Milestone 7 (7/7 PASS), Milestone 6 (8/8 PASS), local CUDA (`SWARM_USE_RPC=0`, 37 layers, PASS).
  - Validation artifacts archived under `artifacts/validation/2026-10-10/milestone-10/`.

## Milestone 11 production readiness and deployment hardening status

Production readiness and deployment hardening are implemented, verified, and regression-tested:

- **Fail-secure production startup preflight:**
  - `SWARM_DEPLOYMENT_ENV=production` (or `SWARM_MODE=production`) strictly enforces telemetry authentication token configuration.
  - Startup halts immediately with exit code 1 and fatal stderr diagnostic if unconfigured: `[FATAL SECURITY PREFLIGHT] SWARM_DEPLOYMENT_ENV is set to 'production', but no telemetry authentication token is configured!`.
  - Development mode (`development`, default) retains loopback unauthenticated convenience with visible security warnings while strictly rejecting remote requests.
- **Process-list secret exposure hardening:**
  - Supported file-based token loading via `SWARM_TELEMETRY_TOKEN_FILE` and `--token-file <path>` using `swarm::security::read_secret_from_file()`. Eliminates token visibility in Task Manager, `Get-Process`, and process tables.
  - Emits explicit stderr warning if `--token` / `--auth-token` is passed via CLI.
- **Upstream GGML RPC remote advisory:**
  - Preflight scan of `SWARM_RPC_ENDPOINTS` detects non-loopback addresses and issues an explicit security warning: upstream GGML RPC is unencrypted and must be routed through an encrypted network overlay (WireGuard / Tailscale).
- **Windows runtime DLL placement:**
  - Copied `llama.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`, `ggml-cuda.dll`, `ggml-rpc.dll` directly to `build-cuda` alongside `swarm_node.exe`.
  - Operational scripts automatically configure `$env:PATH` to prevent Windows missing DLL dialogs.
- **Operational scripts & documentation:**
  - Authored turn-key operational scripts: `scripts/Start-LocalCuda.ps1` (Mode A), `scripts/Start-LoopbackRpc.ps1` (Mode B), and `scripts/Start-ProductionCoordinator.ps1` (Mode C).
  - Authored `docs/PRODUCTION_DEPLOYMENT.md` covering architecture, port listener matrix, firewall configurations, and VPN setup.
- **Validation suites:**
  - Offline security unit tests: `build-cuda/test_security.exe` (6/6 PASS, including `read_secret_from_file`).
  - Milestone 11 integration suite: `scripts/Invoke-Milestone11Validation.ps1` (Cases 1–8 all PASS).
  - Full regression suites: Milestone 10 (9/9 PASS), Milestone 9 (8/8 PASS), Milestone 8 (7/7 PASS), Milestone 7 (7/7 PASS), Milestone 6 (8/8 PASS).
  - Validation artifacts archived under `artifacts/validation/2026-10-10/milestone-11/`.

## Milestone 12 physical multi-device validation status

Physical multi-device validation assets are prepared and packaged; execution is **BLOCKED (Hardware Prerequisite Not Available)**:

- **Standalone Windows x64 worker package (`dist/swarm-worker-windows-x64.zip`):**
  - Contains `ggml-rpc-server.exe`, runtime DLLs (`ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`, `ggml-rpc.dll`), `swarm_agent.exe`, turn-key launcher `Start-RemoteWorker.ps1`, and `README.md`.
  - Zero external toolchain or compiler requirement on Computer B.
- **Automated test harness (`scripts/Invoke-Milestone12Validation.ps1`):**
  - Implements 6-step validation sequence: reachability test -> production coordinator startup -> inventory verification -> live inference -> backend placement check -> teardown.
  - Preflight verified: reports `[MILESTONE 12 STATUS: BLOCKED / NO REMOTE WORKER SPECIFIED]` without failing or hanging.
- **Hardware prerequisite blocker:**
  - No second physical computer is currently available on the private network.
  - Local CUDA baseline (37/37 layers, official Qwen 2.5 3B model) and historical regression suites remain fully functional.

## Open work

- **Physical multi-device LAN deployment execution (Milestone 12 unblock):** Unpack `dist/swarm-worker-windows-x64.zip` on Computer B, execute `Start-RemoteWorker.ps1`, and run `Invoke-Milestone12Validation.ps1` from Computer A to capture physical inference latency and multi-device speedup.
- **Persistent replay protection:** Moving from in-memory sequence tracking to persistent state storage if required across coordinator restarts.
- **Multi-worker request balancing and dynamic failover:** Transparent model recreation or request dispatching across independent model instances without restarting the gateway process.







