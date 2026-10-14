# Architecture

The current request path is:

```text
HTTP request
    -> message parsing
    -> model-specific chat-template formatting
    -> tokenization
    -> prompt evaluation
    -> greedy sampling and token decoding
    -> streamed HTTP/SSE response
```

## Components

- `main.cpp` initializes llama.cpp, GGML backends, workers, devices, the model,
  context, HTTP routes, and shutdown. It also performs request formatting,
  tokenization, decoding, sampling, and SSE streaming with monotonic timing.
- `placement.h` defines `BackendPlacement` and `PlacementTracker`. It captures
  model-layer assignments and buffer sizes (model, KV-cache, compute) via GGML
  log callbacks and parses loader logs without modifying the GGML allocator.
- `worker.h` defines worker types, states, resource fields, observability
  metrics, and the `WorkerManager` interface.
- `worker.cpp` manages worker reachability and locally managed RPC processes.
  It retains registered RPC device handles for the model lifetime.
- `config.h` reads environment variables and provides defaults. RPC is disabled
  by default.
- `policy.h` defines `PlacementPolicyEngine`, `WorkerProfile`, and `PlacementDecision`.
  It parses virtual worker resource budgets, calculates layer capacity using a
  calibrated per-layer cost model with safety margin, caps capacities at offload counts,
  derives normalized split weights for `model_params.tensor_split`, and simulates GGML's
  `upper_bound` placement to verify observed versus predicted placement.
- `CMakeLists.txt` builds `swarm_node` and links llama.cpp and `ggml-rpc`.

## Initialization, placement, and observability

`llama_backend_init()` and `ggml_backend_load_all()` run before configuration
and model loading. Ready RPC workers are registered through the bundled GGML
RPC API before `llama_model_load_from_file()`. The device vector contains
registered RPC devices, the local GPU device, and a null terminator; its backing
storage remains in `main()` while the model and context are alive.

`SWARM_N_GPU_LAYERS` is passed to `llama_model_params.n_gpu_layers`. The bundled
llama.cpp placement logic chooses backend devices and assigns tensors/layers
according to availability and capacity. Changing `model_params.devices` after
model creation would not relocate layers, so request handling does not mutate
placement. `SWARM_RPC_ENDPOINTS` accepts comma-separated `host:port` values;
each endpoint is registered before model loading and retained for the model and
context lifetime. The legacy singular `SWARM_RPC_ENDPOINT` remains supported.

During model loading, `llama_log_set` intercepts loader logs, parsing tensor
layer placements and model/KV/compute buffer allocations per backend into
`PlacementTracker`. These are synchronized to `WorkerInfo` and exposed in
`/health`, `/workers`, `/backends`, and `/metrics`.

The RPC memory query is a view reported by each server. Loopback workers on one
computer report the same host-wide memory capacity (`memory_scope: shared_host`,
`is_loopback: true`). The memory accounting module deduplicates shared-host memory
figures so loopback workers are not counted as independent physical RAM.

## Resource-aware placement policy

Swarm supports an explicit placement policy mode via `SWARM_PLACEMENT_POLICY`:
- `none` (default): Preserves existing default GGML behavior without modifying `model_params.tensor_split`.
- `resource_aware`: Enforces configured virtual worker profiles from `SWARM_WORKER_PROFILES`.

### Virtual profile configuration and parsing
`SWARM_WORKER_PROFILES` accepts comma-separated backend budget mappings:
```text
SWARM_WORKER_PROFILES=RPC0=50MB,RPC1=500MB,CUDA0=4000MB
```
`PlacementPolicyEngine` strictly validates each token:
- Supported units: `B`, `KB`, `KiB`, `MB`, `MiB`, `GB`, `GiB` (binary 1024-based multipliers).
- Strict parsing: whitespace trimming, syntax validation (`id=budget`), overflow rejection, and duplicate profile key rejection. Malformed or invalid profiles cause a clean startup error rather than silent truncation.

### Capacity estimation and split weight calculation
Virtual budgets are kept separate from physical OS memory queries. Layer capacity is computed per device:
1. **Per-layer memory cost approximation:** Calibrated based on Qwen 2.5 3B allocations (~73 MiB weights + 16 MiB KV cache + 2.25 MiB compute per layer, totaling ~91.25 MiB, rounded to 92 MiB with a safety factor).
2. **Layer capacity capping:** $C_i = \min(\lfloor \text{budget}_i / \text{cost\_per\_layer} \rfloor, \text{act\_gpu\_layers})$. Devices with budgets below one layer receive capacity $0$.
3. **Total capacity validation:** If $\sum C_i < \text{act\_gpu\_layers}$, the configured resources cannot satisfy the requested offload. Swarm aborts startup with a clear diagnostic error rather than silently changing parameters.
4. **Split weight derivation:** Split weights $W_i = \text{float}(C_i)$ are derived from capped layer capacity, not raw byte ratios. This ensures device capacity is not distorted by massive disparities in host memory. Ineligible devices ($C_i = 0$) receive split weight $0.0f$.
5. **Exact GGML split semantics:** `model_params.tensor_split` receives cumulative fractions:
   $$\text{splits}[i] = \frac{\sum_{k=0}^i W_k}{\sum_{k=0}^{N-1} W_k}$$
   The allocated array remains valid in memory throughout `llama_model_load_from_file()`.

### Predicted versus observed placement verification
GGML assigns layers contiguously via `std::upper_bound(splits, splits + n_devices, (layer - i_gpu_start) / act_gpu_layers)`.
`PlacementPolicyEngine` implements an exact simulation of this allocator to calculate `predicted_layers` for every backend.
After model loading:
- `PlacementTracker::finalize()` compares `assigned_layers` against `predicted_layers`.
- A boolean flag `policy_match` is set and exposed in `/backends`, `/workers`, and `/metrics`.
- If GGML chooses a placement differing from prediction, Swarm emits a diagnostic mismatch warning.

## Workers and endpoints

`LOCAL_RPC` workers may be started and stopped by Swarm. The `SWARM_RPC_ENDPOINT` and `SWARM_RPC_ENDPOINTS` workers are represented as
`REMOTE_RPC`; Swarm connects to them but does not launch local processes.
`STOPPED`, `STARTING`, `READY`, `BUSY`,
`UNAVAILABLE`, `FAILED`, and `STOPPING` are represented in `WorkerState`.

The HTTP server exposes `/health`, `/workers`, `/backends`, and `/metrics`.
- `/health`: Includes worker reachability, backend identifiers, assigned layer
  ranges, observed buffer bytes, and deduplicated memory status.
- `/workers`: Returns worker and local CUDA entries with full placement metadata.
- `/backends`: Exposes structured backend placement and host memory accounting.
- `/metrics`: Prometheus-compatible metrics including HTTP request counts, active
  requests, backend model/KV/compute buffer allocations, assigned layer counts,
  and monotonic inference timing summaries (prompt eval, token generation, total).

## Lifetime, timing, and shutdown

Inference operations measure monotonic duration for prompt evaluation (`llama_decode`)
and token generation loop, computing tokens per second without dividing by zero.
Optional timing metadata is included in the streamed SSE payload prior to `[DONE]`.

RPC device handles are retained by `WorkerManager`. The model and context are
freed before `llama_backend_free()` during normal shutdown. The manager stops
locally managed workers during destruction using Win32 `TerminateProcess` on
tracked process handles.

## Multi-node reliability and controlled failure handling

### Non-intrusive health monitoring
The bundled `ggml-rpc-server` is single-threaded and accepts only one active client connection with a listen backlog of 1 (`listen(sockfd, 1)`). During model loading, llama.cpp establishes an active socket that remains open for the model lifetime. Attempting intrusive TCP `connect()` probes while the server is active can exhaust the backlog or block.
- For loopback workers, Swarm inspects the kernel TCP table via `GetExtendedTcpTable(..., TCP_TABLE_OWNER_PID_LISTENER)` (`is_local_port_listening`). This checks socket listener existence in sub-millisecond time without opening SYN connections or interfering with GGML communications.
- For remote endpoints, standard `getaddrinfo` resolution and non-blocking TCP socket probes are supported.

### Controlled error handling on worker loss
- **Idle / Pre-inference worker failure:** If an RPC backend becomes unavailable while Swarm is idle, the health check marks the worker `UNAVAILABLE`.
  - `/health` reflects `inference.ready = false` with an explicit `unready_reason` ("RPC worker '...' is UNAVAILABLE").
  - Subsequent inference requests are safely intercepted before calling `llama_decode`. Swarm emits a structured HTTP 503 (`Service Unavailable`) JSON error stating that the backend is down and a clean restart is required. The gateway process remains alive.
- **Mid-inference failure:** If a worker drops out during active `llama_decode`, GGML asserts via `RPC_STATUS_ASSERT` / `GGML_ABORT`. Swarm captures this via `ggml_set_abort_callback`, logs fatal diagnostic context to `stderr`, and terminates cleanly. Reconnecting requires restarting Swarm.
- **Recovery procedure:** Swarm does not support dynamic device reassignment without restart. The supported recovery workflow is: (1) stop Swarm, (2) restart the failed RPC server process, (3) restart Swarm to reconstruct model and context placement.

## Remote node deployment specification (Two-computer topology)

Swarm supports arbitrary hostnames and IP addresses across LAN topologies:
- `getaddrinfo` dynamically resolves IPv4 addresses, IPv6 addresses, and local network hostnames (e.g. `desktop-node-2.local`, `192.168.1.50`).
- Whitespace is automatically trimmed from `SWARM_RPC_ENDPOINTS`.

### Future two-computer setup guide
1. **Primary Gateway Node (Computer A):**
   - Host running `swarm_node.exe` with local GPU (e.g. GTX 1050) and HTTP gateway on port `8080`.
   - Environment:
     ```text
     SWARM_USE_RPC=1
     SWARM_RPC_ENDPOINTS=192.168.1.50:50052
     SWARM_N_GPU_LAYERS=8
     SWARM_PLACEMENT_POLICY=resource_aware
     SWARM_WORKER_PROFILES=192.168.1.50:50052=4GB,local-cuda-0=4GB
     ```
2. **Worker Node (Computer B):**
   - Secondary host (e.g. `192.168.1.50`) running `ggml-rpc-server.exe`:
     ```cmd
     ggml-rpc-server.exe --host 0.0.0.0 --port 50052 --threads 4
     ```
3. **Network & Firewall Requirements:**
   - Inbound TCP rule opening port `50052` on Computer B's private network profile.
   - Connectivity verification from Computer A:
     ```powershell
     Test-NetConnection -ComputerName 192.168.1.50 -Port 50052
     ```
4. **Security Boundary:**
   - GGML RPC has no encryption or authentication. Remote workers must strictly operate within trusted, isolated private local subnets and never be exposed to public networks.

## Node inventory and resource discovery (Milestone 7)

Swarm defines an explicit node capability model in `node.h` to discover, track, and expose cluster topology, device capabilities, and resource metrics.

### Node capability model (`node.h`)
- **`NodeRecord`**: Represents a distinct node (either the primary `gateway` or an RPC `worker`).
  - `node_id`: Stable identifier (e.g., `node-gateway-local`, `node-rpc-127.0.0.1-50052`).
  - `role`: Node role (`gateway` or `worker`).
  - `endpoint`: Host and port, or `local` for the gateway.
  - `is_loopback`: Boolean indicating whether the endpoint resides on the local host.
  - `connection_state`: Current connection status (`READY`, `UNAVAILABLE`, etc.).
  - `is_ready_for_inference`: Live readiness flag reflecting connectivity and required-backend status.
  - `is_required_by_model`: Boolean indicating whether the node hosts any model layers or buffers required for inference.
  - `assigned_layers`: Vector of layer indices assigned to devices on this node.
  - `devices`: Vector of `DeviceCapability` records representing compute devices.
  - `configured_placement_budget`: Virtual placement budget if specified.
  - `last_observed_ms`: Monotonic millisecond timestamp of last observation.
  - `is_simulated`: Boolean flag explicitly identifying deterministic offline test fixtures.
- **Resource data provenance (`ResourceProvenance`)**:
  - `MEASURED`: Directly queried via OS API (e.g., `GlobalMemoryStatusEx`) or GGML device properties (`ggml_backend_dev_props`).
  - `CONFIGURED_BUDGET`: Manually configured via `SWARM_WORKER_PROFILES`.
  - `SIMULATED`: Generated within offline test fixtures; strictly isolated from scheduling evidence.
  - `UNKNOWN`: Resource measurement is not exposed or measurable; represented as `unknown` / `null` rather than fabricated.
- **Device capability (`DeviceCapability`)**:
  - Tracks `device_id`, `backend_type` (`CUDA`, `CPU`, `RPC`), `device_name`, `device_description`, total memory, free memory, and resource provenance.

### Physical memory accounting and loopback deduplication
Loopback processes (`127.0.0.1`) execute on the same host operating system and share physical memory. `NodeInventory` implements cluster-level deduplication:
- Physical host RAM is measured once via Windows `GlobalMemoryStatusEx`.
- Loopback nodes are assigned `memory_scope: "shared_host"`.
- Cluster memory summary (`cluster_memory`) reports `host_ram_deduplicated: true` and counts host RAM exactly once, never summing loopback workers additively.

### API and observability endpoints
- **`GET /nodes`**: Returns complete cluster inventory JSON:
  - `total_nodes`, `ready_nodes`, `required_nodes`.
  - `cluster_memory`: Deduplicated host physical memory view.
  - `nodes`: Array of full `NodeRecord` objects with device details, provenance tags, assigned layers, and observation timestamps.
- **Prometheus node metrics (`GET /metrics`)**:
  - `swarm_nodes_total`: Total nodes registered in the cluster inventory.
  - `swarm_nodes_online`: Number of nodes currently in `READY` state.
  - `swarm_nodes_required`: Number of nodes actively hosting model layers required for inference.

## Worker-side resource agent and coordinator integration (Milestone 8)

Swarm Milestone 8 introduces an independent, lightweight worker-side reporting agent (`swarm_agent.exe`) that executes on participating worker computers to probe physical hardware resources and periodically report them to the Swarm coordinator.

```text
+------------------------------------+          HTTP POST /api/v1/nodes/report
|  Worker Node / Host Computer       | ---------------------------------------------> +-----------------------------+
|                                    |          (JSON payload <= 64 KB, schema 1.0)   |  Swarm Coordinator Gateway  |
|  - swarm_agent.exe (Agent Daemon)  |                                                |  (swarm_node.exe)           |
|    * Probe OS RAM (GlobalMemStatus)|                                                |                             |
|    * Probe CPU (Win32 SystemInfo)  |                                                |  - NodeInventory            |
|    * Probe GPU (DXGI EnumAdapters) |                                                |    * Validates schema       |
|    * Null/Unknown Unsupported      |                                                |    * Bounds checking        |
|  - ggml-rpc-server.exe (Port 50052)| <--------------------------------------------- |    * Ingests MEASURED state |
|    (Inference Worker Backend)      |          GGML RPC Socket Connection            |    * 30s TTL Staleness      |
+------------------------------------+                                                +-----------------------------+
```

### Reporting agent daemon (`agent.h` / `agent_main.cpp`)
- **Lightweight, separable binary:** Built as `swarm_agent.exe` with minimal dependencies (linking only Win32 `ws2_32`, `crypt32`, and `dxgi`). Can run independently on a remote computer without requiring the full llama.cpp runtime.
- **Hardware probing engine (`HardwareProbe`):**
  - **Node Identity & Hostname:** Captured via `gethostname()`; node ID defaults to `node-rpc-<hostname>-<rpc_port>` or explicit `--node-id`.
  - **CPU Architecture & Model:** Queried via Win32 `GetNativeSystemInfo` (`x86_64`, `arm64`, `x86`) and logical processor count. Processor brand name string is extracted from Windows Registry (`HARDWARE\DESCRIPTION\System\CentralProcessor\0\ProcessorNameString`).
  - **Host RAM:** Queried via Win32 `GlobalMemoryStatusEx` for exact total and currently available physical memory bytes.
  - **GPU VRAM & Device Identity:** Probed via DirectX Graphics Infrastructure (DXGI) `CreateDXGIFactory` and `EnumAdapters`, capturing hardware vendor IDs, adapter descriptions, and `DedicatedVideoMemory` bytes without requiring heavy CUDA runtime or DirectX 12 drivers.
  - **Honest reporting of unsupported metrics:** Metrics not directly exposed by standard operating system APIs (such as GPU core utilization %, GPU/CPU temperatures, fan RPM) are explicitly cataloged in `unsupported_metrics: ["gpu_core_utilization", "gpu_temperature_celsius", "cpu_temperature_celsius", "fan_speed_rpm"]` and omitted or serialized as `null` rather than fabricated.
- **CLI and operational modes:**
  - `--coordinator <url>`: Coordinator endpoint (defaults to `http://127.0.0.1:8080`).
  - `--node-id <id>`: Explicit node identifier.
  - `--endpoint <host>`: Reported reachability host.
  - `--rpc-port <port>`: Port of the local RPC worker daemon.
  - `--interval-ms <ms>`: Heartbeat interval (defaults to 10,000 ms).
  - `--once`: Sends a single report and exits cleanly (ideal for testing and cron invocations).

### Coordinator report ingestion (`NodeInventory::ingest_agent_report`)
- **Endpoints:** The coordinator exposes `POST /api/v1/nodes/report` (aliased at `POST /nodes/report`).
- **Bounded request payload:** Enforces a strict 64 KB maximum request body limit (`SWARM_MAX_REPORT_PAYLOAD_BYTES`), rejecting oversized requests immediately with HTTP 413.
- **Validation and bounds checking:**
  - Requires valid JSON and mandatory schema version `"1.0"`.
  - Requires non-empty `node_id`, `endpoint`, and `status`.
  - Enforces physical sanity checks: `available_ram_bytes <= total_ram_bytes` and `total_ram_bytes > 0`. Violations return HTTP 400 with descriptive error messages.
- **Provenance preservation:** Agent reports are strictly ingested into `NodeRecord` under `ResourceProvenance::MEASURED`. Virtual placement budgets (`CONFIGURED_BUDGET`) from `SWARM_WORKER_PROFILES` are preserved and never overwritten by agent reports.
- **Node correlation:** Matches incoming reports to existing nodes by `node_id`, endpoint hostname, or RPC port. If a report arrives for an uncataloged worker, a new worker `NodeRecord` is dynamically registered in inventory.

### Freshness tracking and staleness safety
- **30-second TTL:** Each ingested report records `last_agent_report_ms` using monotonic time (`std::chrono::steady_clock`).
- **Stale transition:** When generating node state (`NodeInventory::to_json`), if `now_ms - last_agent_report_ms > 30000`, the node is flagged:
  - `is_stale: true`
  - `stale_reason: "Report exceeded 30000ms TTL"`
  - `connection_state: UNAVAILABLE`
  - `is_ready_for_inference: false`
- **Scheduler safety:** Stale measurements are explicitly invalidated and excluded from active scheduling calculations.
- **Clean recovery:** When an agent reconnects and submits a fresh report, `is_stale` is cleared to `false`, `stale_reason` is emptied, and connection state restores to `READY`.

### Agent telemetry in observability endpoints
- **`GET /nodes`**: Node records are enriched with:
  - `agent_reported: true`
  - `agent_version: "1.0.0"`
  - `last_agent_report_ms`: Monotonic timestamp.
  - `report_age_ms`: Elapsed time since last report.
  - `is_stale`: Boolean freshness status.
  - `hardware`: Structured CPU architecture, processor count, model name, RAM total/available, and GPU devices.
  - `unsupported_metrics`: List of unmeasured fields.
- **Prometheus metrics (`GET /metrics`)**:
  - `swarm_nodes_agent_reported`: Number of nodes currently tracked via live reporting agents.
  - `swarm_nodes_stale`: Number of nodes whose agent reports have expired beyond the 30s TTL.

## Dynamic resource-aware layer allocation (Milestone 9)

Milestone 9 implements `SWARM_PLACEMENT_POLICY=dynamic` (or `dynamic_resource_aware`), allowing Swarm to derive conservative layer placement budgets from trustworthy telemetry rather than relying exclusively on manual static worker profiles.

```text
[Hardware Telemetry / Agent Reports]
     |
     v
[ConservativeCapacityEstimator]
     * Distinguishes MEASURED physical capacity vs CONFIGURED budget
     * Deducts OS/App headroom (1024 MiB RAM, 256 MiB VRAM default)
     * Validates freshness (<30s TTL) & physical plausibility
     * Loopback Deduplication: Partitions shared host RAM across loopback workers
     * Calibrated Layer Cost: model- & context-aware (~92 MiB @ ctx=2048)
     |
     v
[PlacementPolicyEngine::evaluate(DYNAMIC)]
     * Computes usable budget B_i & capped layer capacity C_i = min(floor(B_i / cost), act_gpu_layers)
     * Enforces total capacity: rejects startup if sum(C_i) < act_gpu_layers
     * Computes exact normalized split weights W_i = float(C_i)
     * Builds tensor_split array matching exact GGML contiguous device order
     * Simulates cumulative std::upper_bound to predict layer assignment
     |
     v
[llama_model_load_from_file(..., tensor_split)]
     |
     v
[PlacementTracker Verification]
     * Asserts observed placement matches dynamic policy prediction
     * Observability exposed in /health, /nodes, /backends, /metrics
```

### Conservative capacity estimation (`estimator.h`)
The `ConservativeCapacityEstimator` component enforces strict distinction across capacity concepts:
1. **Measured Total vs Available:** For CUDA devices, `cudaMemGetInfo` provides genuine available and total VRAM. For RPC workers, Win32 `GlobalMemoryStatusEx` reports physical host RAM total and available bytes. DXGI total VRAM is never treated as immediately available memory.
2. **Safety Headroom Deduction:**
   - Operating system and background applications require guaranteed headroom.
   - Configured via `SWARM_RESERVED_HEADROOM_RAM_MB` (default: 1024 MiB) and `SWARM_RESERVED_HEADROOM_VRAM_MB` (default: 256 MiB).
   - Usable budget: $\text{UsableBytes} = \max(0, \text{AvailableBytes} - \text{HeadroomBytes})$.
3. **Loopback Shared-Host Deduplication & Partitioning:**
   - Multiple loopback RPC endpoints (`127.0.0.1`) execute on the same host and share the single physical RAM.
   - If $K$ loopback workers share the host, the usable host RAM after headroom deduction is partitioned equally ($B_i = \text{UsableHostRAM} / K$), strictly preventing additive memory inflation.
4. **Calibrated Model- and Context-Aware Layer Cost:**
   - Computes per-layer demand: $73 \text{ MiB weights} + 16 \text{ MiB KV cache} \times (\text{n\_ctx}/2048) + 2.25 \text{ MiB compute buffers} + 2\% \text{ safety margin}$ (~92 MiB per layer for Qwen 2.5 3B at context 2048).
5. **Freshness & Sanity Guards:**
   - Telemetry older than 30,000 ms is rejected as `STALE`.
   - Physically implausible reports ($\text{Available} > \text{Total}$ or $\text{Total} = 0$) are rejected immediately.
   - Insufficient capacity ($\sum C_i < \text{act\_gpu\_layers}$) produces an explicit startup error code 1 with actionable diagnostics, never silent layer reduction or silent policy fallback.

### Discovery intake and offline report ingestion
- `SWARM_AGENT_REPORT_FILE`: Filepath to a JSON report or array of reports, allowing offline telemetry ingestion for testing, orchestration, or air-gapped environments.
- `SWARM_DISCOVERY_TIMEOUT_MS`: Startup intake window allowing remote reporting agents to register before model loading begins.

## Security architecture & remote node boundary (Milestone 10)

### 1. Telemetry reporting authentication (`POST /api/v1/nodes/report`)
- **Bearer Token Authentication:** Configured via `SWARM_TELEMETRY_TOKEN` (or alias `SWARM_AUTH_TOKEN`) on the coordinator and passed via `--token` / `--auth-token` or environment on `swarm_agent`.
- **Constant-Time Verification:** Direct token comparison uses `swarm::security::constant_time_equals` with a volatile XOR accumulator across all characters to eliminate timing side-channel attacks.
- **Strict Error Discrimination:**
  - Missing token: HTTP 401 Unauthorized with `WWW-Authenticate: Bearer realm="swarm-telemetry"`.
  - Malformed scheme (non-Bearer): HTTP 401 Unauthorized with `WWW-Authenticate: Bearer error="invalid_token"`.
  - Invalid/mismatched token: HTTP 403 Forbidden.
  - Remote client when coordinator token is unset: HTTP 403 Forbidden.
  - Payload > 64 KB: HTTP 413 Payload Too Large.
  - Malformed JSON / schema mismatch: HTTP 400 Bad Request.
- **Node Inventory Isolation:** Unauthenticated and unauthorized requests are rejected prior to JSON parsing and never mutate `NodeInventory`, sequence numbers, or timestamp freshness.
- **Development Mode Visibility:** When `SWARM_TELEMETRY_TOKEN` is unset, coordinator operates in loopback-only development mode and logs an explicit warning: `WARN: Telemetry Auth: DISABLED (Unauthenticated loopback development mode; remote reports will be rejected)`.

### 2. GGML RPC transport security boundary
- **Native Protocol Reality:** Upstream GGML RPC (`llama.cpp/ggml/src/ggml-rpc`) is unauthenticated and unencrypted plain TCP. Protecting HTTP telemetry alone does NOT encrypt or authenticate GGML RPC tensors or execution commands.
- **Network Boundary Rule:** GGML RPC worker listeners (`0.0.0.0:50052`) must **NEVER** be directly exposed to untrusted networks or the public Internet.
- **Encrypted Overlay Requirement:** Remote worker execution across computers requires isolation inside an encrypted network overlay (WireGuard VPN or Tailscale mesh) with strict host firewall rules binding RPC communication exclusively to VPN virtual interfaces.

## Operational deployment profiles & hardening (Milestone 11)

### 1. Operational Modes
Swarm defines three operational profiles:
- **Mode A: Local CUDA:** `SWARM_USE_RPC=0`. In-process GPU tensor execution; no RPC daemons or telemetry network overhead. Managed via `scripts/Start-LocalCuda.ps1`.
- **Mode B: Loopback RPC Simulation:** `SWARM_USE_RPC=1`, `127.0.0.1:50052`, `127.0.0.1:50053`. Local development mode simulating distributed splitting on a single machine. Managed via `scripts/Start-LoopbackRpc.ps1`.
- **Mode C: Remote Multi-Computer (Production):** `SWARM_USE_RPC=1`, remote worker endpoints routed through encrypted overlay network. `SWARM_DEPLOYMENT_ENV=production`. Managed via `scripts/Start-ProductionCoordinator.ps1`.

### 2. File-Based Secret Loading & Process List Protection
- CLI options `--token` and `--auth-token` expose secrets to process list inspections (`Get-Process`, Task Manager).
- Swarm introduces `swarm::security::read_secret_from_file()` allowing token reading from ACL-restricted filesystem paths (`SWARM_TELEMETRY_TOKEN_FILE` / `--token-file`).
- When `--token` is passed on the command line, `swarm_agent` emits an advisory warning alerting operators to use `--token-file`.

### 3. Fail-Secure Production Preflight Mode
- `SWARM_DEPLOYMENT_ENV=production` triggers strict preflight validation.
- If no telemetry auth token is configured via `SWARM_TELEMETRY_TOKEN` or `SWARM_TELEMETRY_TOKEN_FILE`, coordinator immediately exits with code 1:
  `[FATAL SECURITY PREFLIGHT] SWARM_DEPLOYMENT_ENV is set to 'production', but no telemetry authentication token is configured!`
- If remote RPC endpoints are detected, coordinator logs security advisories reminding operators to ensure WireGuard/Tailscale VPN encapsulation.



