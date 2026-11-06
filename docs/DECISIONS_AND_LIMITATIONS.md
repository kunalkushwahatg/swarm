# Decisions and limitations

## Decisions

- The official Qwen verification copy is the baseline because its published hash
  matched and it produced sensible independent-reference and Swarm output.
- The original model is preserved separately because it is diagnostically useful
  and has not been proven corrupt by a complete forensic analysis.
- RPC remains opt-in so the known-good local CUDA path is the default fallback.
- `SWARM_N_GPU_LAYERS` was added to make CPU-only, partial, and full offload
  explicit without changing sampler or context behavior.
- Device registration occurs before model loading. Changing the device pointer
  after model/context creation cannot relocate already placed layers.
- Multiple explicit RPC endpoints are registered before model loading through
  `SWARM_RPC_ENDPOINTS`; endpoint processes remain independently managed.
- Worker `READY` means reachability/state, not inference participation. Placement,
  remote buffer allocation, and server activity are required evidence.
- Loopback RPC was used because no second device was available. It validates the
  integration path, not distributed performance.

## Confirmed limitations

- No multi-worker scheduling or load balancing.
- No automatic model/context recreation when worker availability changes.
- No failover semantics for already loaded model placement.
- No validated real-LAN or multi-computer inference.
- Loopback workers share the same physical host resources. Their reported
  memory is not additive independent capacity.
- Stopping one registered worker after model loading caused an RPC transport
  failure and terminated the tested Swarm process. Restarting that worker did
  not recover the existing model/context; a clean Swarm restart is required.
- The repeatable fault test identified the failure below Swarm's HTTP error
  handling: a failed RPC send triggers GGML's `RPC_STATUS_ASSERT`, which calls
  `GGML_ABORT` with `Remote RPC server crashed or returned malformed response`.
  Windows recorded Application Error exception `0xc0000409` in `ucrtbase.dll`.
  Swarm therefore cannot safely keep the loaded model/context alive after the
  backend disappears.
- The HTTP worker state endpoints do not by themselves prove backend execution.
- The current benchmark is a short, single-prompt baseline and includes existing
  diagnostic logging overhead.
- The loopback RPC placement test observed RPC0 for layers 33-36; it did not
  prove that CUDA0 also received a layer in that run.

## Two-worker loopback milestone

With CPU RPC servers on `127.0.0.1:50052` and `127.0.0.1:50053`, llama.cpp
assigned layer 33 to RPC0, layer 34 to RPC1, and layers 35-36 to CUDA0.
Both RPC devices received model, KV, and compute buffers. This demonstrates
multi-endpoint registration and placement on one host only; it does not
demonstrate two-machine performance, independent capacity, or scheduling.

## Fault handling semantics

The current bundled GGML RPC implementation does not return a recoverable
status from a disconnected backend. `rpc_dispatcher::work()` asserts when a
send/receive operation fails, and the resulting abort occurs below Swarm's
request handler. The supported recovery operation is therefore:

1. Stop the failed RPC process if it is still running.
2. Restart the RPC process.
3. Restart Swarm so the model and context reconnect and are recreated.

The implementation does not silently fall back to local CUDA, remove a stale
device, or claim that restarting the RPC server repairs an existing context.
The repeatable test and preserved logs are under
`artifacts/validation/2026-10-10/fault-handling/`.

## Milestone 4 decisions — Backend placement observability and resource reporting

- **Log-interception placement capture via `llama_log_set`:**
  Bundled llama.cpp does not expose a public C API for per-layer device assignment maps or buffer allocations (`dev_layer` is internal to `llama_model::pimpl`). We installed a thread-safe callback via `llama_log_set` that forwards all log lines to `stderr` (preserving CLI fidelity) while feeding `PlacementTracker`. This avoids patching internal llama.cpp headers and leaves the underlying GGML placement algorithm untouched.
- **Explicit layer assignment ranges:**
  If layer assignments for a backend are non-contiguous, `assigned_layer_ranges` models them as an explicit list of intervals rather than synthesizing an artificial continuous span.
- **Physical host memory deduplication:**
  Loopback endpoints (`127.0.0.1:*`) are tagged with `is_loopback: true` and `memory_scope: "shared_host"`. Host physical RAM is queried once via `GlobalMemoryStatusEx` and reported under `host_memory_bytes` in `/backends`. Swarm strictly prohibits summing host memory across multiple loopback workers.
- **Separate `/backends` endpoint with compatible `/workers` enhancements:**
  `/backends` exposes complete placement and memory metadata for all registered compute devices (`CPU`, `CUDA0`, `RPC0`, etc.). `/workers` retains backward compatibility while incorporating observed placement and buffer byte metrics.
- **Monotonic timing boundaries:**
  Inference latency is measured using `std::chrono::steady_clock` strictly around `llama_decode` (prompt evaluation) and the autoregressive token-generation loop. Server startup and model loading are explicitly excluded. Zero generated tokens are protected against division-by-zero.
- **Streaming SSE timing compatibility:**
  To deliver timing metadata without breaking clients expecting `choices[0].delta.content`, Swarm emits a dedicated penultimate SSE chunk with an empty delta object `{"choices":[{"delta":{}}],"id":...,"timings":{...}}` immediately before `data: [DONE]`.

## Milestone 5 decisions — Resource-aware placement policy and scheduling

- **Separation of configured virtual budgets from physical host memory:**
  Configured virtual worker profiles (`SWARM_WORKER_PROFILES`) model simulated distributed environments where loopback workers represent constrained remote devices. These virtual budgets are kept strictly separate from the host OS physical memory observations reported by `GlobalMemoryStatusEx`. Virtual budgets govern split weight calculations; physical observations govern host safety reporting.
- **Capacity-derived split weights rather than raw byte ratios:**
  GGML's `tensor_split` divides layers based on relative weight proportions. If raw memory budgets were passed directly, a device with 4000 MB paired with a device with 500 MB would yield an 8:1 weight ratio. With 4 total offloaded layers, the 500 MB device would receive $\approx 0.44$ layers, rounding down to 0, despite having enough memory for 5 layers. By first estimating integer layer capacity ($C_i = \lfloor B_i / \text{layer\_cost} \rfloor$), capping it at `act_gpu_layers`, and using $W_i = \text{float}(C_i)$, the policy ensures capacity directly maps to layer granularity.
- **Zero-weight enforcement for ineligible devices:**
  If a worker's configured budget is below the cost of a single layer (e.g. 50 MB budget vs ~92 MiB per layer), its capped capacity is 0, and its split weight is set to `0.0f`. GGML's `std::upper_bound` allocator skips zero-weight backends completely, preventing loopback workers from receiving layers simply because they registered successfully.
- **Strict syntax parsing without silent fallback or truncation:**
  Malformed profiles (e.g. negative values, missing budgets, unknown units, duplicate conflicting keys) cause Swarm to terminate immediately with a descriptive startup error. Profiles are never silently truncated, substituted, or ignored.
- **Contiguous layer assignment limitation in bundled GGML:**
  GGML's `tensor_split` allocates layers strictly contiguously across the devices listed in `model_params.devices`. It cannot assign disjoint layers (e.g. layers 33 and 35 to device A and layer 34 to device B). Disabling a device via zero split weight successfully removes it from allocation without violating this monotonicity.
- **Placement prediction and runtime verification:**
  `PlacementPolicyEngine` deterministically simulates the exact `std::upper_bound` loop from GGML before model loading. After loading, `PlacementTracker::finalize()` verifies whether `assigned_layers == predicted_layers`. If an external factor causes GGML to choose a different placement, Swarm emits a diagnostic mismatch warning and sets `policy_match: false` rather than falsely claiming success.
- **Total insufficient capacity rejection:**
  If the sum of capped capacities across all backends is less than the requested offloaded layers (`act_gpu_layers`), Swarm terminates startup with exit code 1 and a detailed diagnostic message. It does not silently reduce `n_gpu_layers` or silently fall back to `none`.

## Milestone 6 decisions — Multi-node orchestration and reliability

- **Differentiating idle/pre-inference worker loss from mid-decode failure:**
  If an RPC backend terminates while Swarm is idle, Swarm safely intercepts subsequent inference requests before invoking `llama_decode`, emitting HTTP 503 (`Service Unavailable`) with structured JSON diagnostics and keeping the process alive. However, if a worker drops out during active `llama_decode`, GGML asserts internally via `RPC_STATUS_ASSERT` / `GGML_ABORT`, triggering process termination. Transparent mid-computation migration without process restart is not supported by bundled GGML.
- **Non-intrusive TCP health monitoring via kernel listener table:**
  `ggml-rpc-server` is single-threaded and configures a listen backlog of 1 (`listen(sockfd, 1)`). Opening concurrent probe sockets while llama.cpp holds an active backend connection can exhaust the backlog or cause false timeouts. For loopback workers, Swarm inspects the kernel TCP listener table via Windows `GetExtendedTcpTable` without initiating SYN handshakes. For remote endpoints, non-blocking `getaddrinfo` resolution is used.
- **Explicit clean restart recovery workflow:**
  Swarm does not claim dynamic context recreation or hot backend replacement. Once an assigned worker is lost, recreating the placement requires restarting the failed RPC server and performing a clean restart of Swarm.
- **Win32 process management hygiene:**
  Replaced invalid `TerminateThread` calls with `TerminateProcess` on tracked Win32 process handles (`pi.hProcess`), preventing orphan process leaks during local worker teardown.
- **Whitespace tolerance in endpoint configuration:**
  `SWARM_RPC_ENDPOINTS` now trims whitespace from each parsed host/port token, preventing silent connection failures caused by formatting spaces.
- **Fault resilience for zero-layer registered workers:**
  When resource-aware placement allocates zero model layers and zero buffer bytes to a registered RPC worker (e.g. low-memory profile), that worker does not participate in the model compute graph. If that zero-layer worker fails or disconnects, Swarm emits an advisory warning on stderr but does not reject inference requests. Inference readiness (`health["inference"]["ready"]`) depends strictly on the backends required by the loaded model.
- **Remote-node verification boundary and security limitation:**
  Hostname resolution (`getaddrinfo`) and whitespace trimming are verified locally. Real multi-device physical LAN testing has not been run due to single-laptop hardware constraints. Security boundary: GGML RPC communicates via unauthenticated plain TCP. Production multi-node deployments across untrusted networks require network-level protection (e.g., WireGuard/Tailscale VPN).

## Milestone 7 decisions — Node inventory and resource discovery

- **Resource data provenance segregation:**
  Resource values are wrapped in a templated `ResourceValue<T>` model with an explicit `ResourceProvenance` enum (`MEASURED`, `CONFIGURED_BUDGET`, `SIMULATED`, `UNKNOWN`) and source string description. This strictly prevents configured budgets or simulated test data from being conflated with actual live operating-system measurements.
- **Unmeasured resources represented as unknown:**
  The current GGML RPC protocol exposes backend device properties (`name`, `description`, `type`, `memory_free`, `memory_total`) via `ggml_backend_dev_props`. It does not expose operating-system metrics, CPU load, process working sets, or hardware thermals. Swarm serializes unavailable measurements as `null` / `unknown` rather than fabricating synthetic measurements.
- **Strict loopback physical RAM deduplication:**
  Loopback workers running on the same host machine report identical views of host physical RAM. Swarm tags loopback nodes with `memory_scope: "shared_host"` and `NodeInventory` marks `cluster_memory.host_ram_deduplicated: true`. Physical host memory is sampled exactly once via `GlobalMemoryStatusEx`, strictly preventing artificial additive summation across collocated workers.
- **Deterministic offline test fixture isolation:**
  Offline unit test fixtures in `test_node_inventory.cpp` are explicitly tagged with `is_simulated: true` and `provenance: SIMULATED`. These synthetic fixtures validate state machines, staleness logic, metadata validation, and cluster aggregation without contaminating live runtime telemetry or scheduling data.
- **Dedicated `/nodes` endpoint with backward compatibility preservation:**
  Rather than overloading `/workers` or `/backends` with node-level topology, Swarm introduces a dedicated `GET /nodes` endpoint that exposes node identifiers, endpoints, live readiness, device capabilities, resource provenance, assigned layers, and observation timestamps. Endpoints `/health`, `/workers`, `/backends`, and `/metrics` are fully preserved with identical behavior.
- **Future remote worker reporting architecture and security boundaries:**
  A future remote physical worker will require either an extended RPC protocol query or a lightweight node-side reporting agent (HTTP/gRPC) to report OS-level metrics (free RAM, CPU load, temperatures). Swarm will ingest these via the `NodeInventory` interface with `provenance: MEASURED`.
  **Security boundary:** Swarm explicitly rejects implementing remote administrative execution, shell command execution, or automatic software installation on arbitrary remote machines. Distributed worker deployment must remain managed via standard infrastructure tooling (SSH, containers, systemd) over private, authenticated networks.

## Milestone 8 decisions — Worker-side resource agent and coordinator integration

- **Separable, lightweight worker agent design (`swarm_agent.exe`):**
  The reporting agent is implemented as a standalone binary (`agent_main.cpp` / `agent.h`) linking only standard Win32 libraries (`ws2_32`, `crypt32`, `dxgi`, `advapi32`). It requires no heavy llama.cpp or CUDA runtime dependencies, enabling future deployment onto constrained worker nodes with minimal resource overhead.
- **Hardware probing engine & boundary:**
  - System RAM is sampled using Win32 `GlobalMemoryStatusEx` (`ullTotalPhys`, `ullAvailPhys`).
  - CPU architecture and core count are probed via `GetNativeSystemInfo`, and the CPU model string is retrieved from Windows Registry (`HARDWARE\DESCRIPTION\System\CentralProcessor\0\ProcessorNameString`).
  - GPU VRAM is queried via DirectX Graphics Infrastructure (DXGI) `CreateDXGIFactory` and `EnumAdapters` (`DXGI_ADAPTER_DESC::DedicatedVideoMemory`). This accurately captures dedicated VRAM across NVIDIA, AMD, and Intel GPUs without initializing heavyweight CUDA/ROCm contexts.
  - **Honest reporting of unsupported metrics:** Operating system APIs do not provide standardized, vendor-neutral queries for GPU core utilization %, hardware temperatures, or fan speeds. Rather than fabricating synthetic or guessed numbers, the agent explicitly documents these metrics in `unsupported_metrics: ["gpu_core_utilization", "gpu_temperature_celsius", "cpu_temperature_celsius", "fan_speed_rpm"]` and emits `null` values.
- **Bounded HTTP report ingestion:**
  The coordinator (`main.cpp`) exposes `POST /api/v1/nodes/report` (aliased at `POST /nodes/report`). To protect against denial-of-service or malformed payload memory exhaustion, incoming reports are bounded by `SWARM_MAX_REPORT_PAYLOAD_BYTES` (64 KB). Requests exceeding 64 KB are rejected immediately with HTTP 413 (`Payload Too Large`).
- **Resource data provenance segregation:**
  Agent-reported physical metrics are strictly ingested into `NodeRecord` under `ResourceProvenance::MEASURED`. Configured virtual placement budgets (`SWARM_WORKER_PROFILES`) remain categorized as `CONFIGURED_BUDGET`. The coordinator preserves both representations side-by-side, preventing configured scheduling limits from overwriting observed hardware state.
- **Resource freshness & scheduler safety semantics:**
  - Ingested agent reports carry a monotonic timestamp and enforce a 30-second Time-To-Live (TTL).
  - If a worker agent ceases reporting, elapsed time exceeds 30,000 ms, causing `NodeInventory::to_json` to flag the node as `is_stale: true`, set `stale_reason: "Report exceeded 30000ms TTL"`, mark `connection_state: UNAVAILABLE`, and set `is_ready_for_inference: false`.
  - Future dynamic schedulers are guaranteed that stale measurements are never treated as current available memory.
  - Reconnection is handled cleanly: subsequent reports reset `is_stale: false`, clear `stale_reason`, and restore `READY` state.
- **Loopback memory deduplication across multiple agent processes:**
  When multiple worker agents or RPC daemons run on the same physical host (e.g. `127.0.0.1`), they report identical host RAM figures. Swarm's `NodeInventory` tags all loopback nodes with `memory_scope: "shared_host"` and maintains cluster-level deduplication (`host_ram_deduplicated: true`), ensuring physical host memory is never summed additively across collocated processes.
- **Security boundary and transport requirements:**
  - The reporting agent communicates with the coordinator via unauthenticated, unencrypted HTTP JSON requests.
  - The GGML RPC daemon communicates via unauthenticated, unencrypted TCP sockets.
  - **Rejection of remote command execution:** Swarm strictly rejects implementing remote shell execution, arbitrary script execution, or automated software installation over the agent protocol.
  - **Deployment constraints:** For development, all agents and coordinators bind to loopback (`127.0.0.1`). Prior to deploying Swarm across heterogeneous machines on an external or untrusted network, transport encryption (TLS) and mutual authentication (mTLS / API tokens) must be implemented, or network traffic must be encapsulated within a trusted private network (e.g., WireGuard or isolated VLAN).

## Milestone 9 decisions — Dynamic resource-aware layer allocation

- **Conservative capacity estimation over raw telemetry:**
  Raw telemetry cannot be directly mapped to placement budgets. Physical OS metrics include background process usage and system needs. DXGI reports total dedicated video memory, not currently available VRAM. GGML backend properties query `cudaMemGetInfo`, reflecting actual free VRAM. The `ConservativeCapacityEstimator` strictly separates measured total from genuinely available memory.
- **Configurable safety headroom:**
  To prevent out-of-memory crashes on worker nodes, Swarm mandates OS/application headroom deduction. Configured via `SWARM_RESERVED_HEADROOM_RAM_MB` (default: 1024 MiB) and `SWARM_RESERVED_HEADROOM_VRAM_MB` (default: 256 MiB). If available memory is less than headroom, usable budget is 0 bytes.
- **Shared-host loopback partitioning:**
  When multiple loopback RPC workers run on the same physical computer (`127.0.0.1`), they share physical RAM. The capacity estimator partitions usable host RAM equally across collocated loopback instances ($B_i = \text{UsableHostRAM} / K$), guaranteeing that multiple loopback workers do not multiply physical capacity.
- **Strict rejection of stale, missing, and implausible telemetry:**
  Dynamic policy mode (`SWARM_PLACEMENT_POLICY=dynamic`) strictly refuses to guess or invent capacity. Telemetry with age > 30,000 ms is rejected as `STALE`. Missing telemetry files, implausible bounds ($\text{available} > \text{total}$), or insufficient total capacity ($\sum C_i < \text{act\_gpu\_layers}$) cause Swarm to terminate startup immediately with exit code 1 and actionable diagnostics. Swarm never silently reduces `n_gpu_layers` and never silently falls back to an unrequested placement policy.
- **GGML contiguous placement semantics preserved:**
  `PlacementPolicyEngine` constructs `model_params.tensor_split` matching the exact contiguous device order required by GGML (`RPC` backends followed by `CUDA0`). Split weights are derived from integer capped layer capacities, ensuring zero-capacity workers receive weight `0.0f` and receive zero layers.
- **Dynamic in-memory migration deferred:**
  Layer allocation occurs during `llama_model_load_from_file`. Dynamic in-memory layer migration while inference is running is not supported by GGML and remains an explicit architectural non-goal for this milestone.
- **Security boundary:**
  The agent reporting endpoint (`POST /api/v1/nodes/report`) and GGML RPC transport have no built-in encryption or authentication. All testing is strictly restricted to loopback (`127.0.0.1`). Future LAN deployments require mutual TLS, API token authentication, or deployment within an isolated VPN/VLAN. Remote command execution and automated software installation are strictly rejected.

## Milestone 10 decisions — Secure remote-node readiness

- **Bearer token authentication on telemetry endpoints (`POST /api/v1/nodes/report`):**
  Coordinator requires valid `Authorization: Bearer <token>` when `SWARM_TELEMETRY_TOKEN` (or alias `SWARM_AUTH_TOKEN`) is configured. `swarm_agent` accepts credentials via `--token` / `--auth-token` or environment variables without embedding secrets in source code or committing them to git.
- **Constant-time secret comparison:**
  Authentication secrets are verified using `swarm::security::constant_time_equals` with a `volatile unsigned char diff` bitwise XOR accumulator across all characters, preventing timing side-channel leakage.
- **Strict pre-parse rejection & inventory isolation:**
  Missing, invalid, malformed, or oversized requests are rejected immediately with HTTP 401, 403, 400, or 413 before JSON deserialization and before invoking `NodeInventory`. Unauthorized requests can never advance sequence numbers, refresh node freshness (`last_observed_ms`, `last_agent_report_ms`), or overwrite telemetry state.
- **Development mode visibility and remote protection:**
  When `SWARM_TELEMETRY_TOKEN` is unset, coordinator permits unauthenticated reports from loopback (`127.0.0.1`, `::1`) for development convenience, but logs an explicit warning: `WARN: Telemetry Auth: DISABLED (Unauthenticated loopback development mode; remote reports will be rejected)`. Remote unauthenticated requests are rejected with HTTP 403 Forbidden.
- **Honest transport security assessment (HTTP vs TLS vs VPN overlay):**
  `cpp-httplib` supports OpenSSL, but OpenSSL is not linked in the current build environment. Bearer tokens over plain HTTP are vulnerable to packet sniffing if transmitted across an untrusted network. Telemetry reporting over plain HTTP is restricted strictly to loopback or must be routed through an encrypted overlay tunnel (WireGuard VPN or Tailscale mesh).
- **GGML RPC security boundary:**
  Upstream GGML RPC (`llama.cpp/ggml/src/ggml-rpc`) is natively unauthenticated and unencrypted plain TCP. Securing the HTTP telemetry endpoint does NOT secure GGML RPC. GGML RPC worker listeners (`0.0.0.0:50052`) must NEVER be exposed directly to untrusted networks or the public Internet. Remote multi-computer inference requires isolating all RPC communication inside a private encrypted network overlay (WireGuard / Tailscale) with host firewall rules binding port 50052 exclusively to the VPN interface.
- **Replay protection scope & limitation:**
  Sequence-number tracking (`agent_session_id`, `sequence_number`) is maintained in coordinator memory. On coordinator restart, sequence numbers reset. Persistent replay protection across coordinator restarts is not implemented and remains an explicit milestone limitation. Accidental re-deliveries within a session are rejected.
- **Physical single-computer constraint:**
  All tests were executed locally on a single Windows 11 machine using NVIDIA GTX 1050 4GB and loopback RPC workers. Real physical LAN performance, packet loss handling, and multi-device distributed inference remain unverified until a secondary physical computer is available.

## Milestone 11 decisions — Production readiness and deployment hardening

- **File-based credential loading (`--token-file` / `SWARM_TELEMETRY_TOKEN_FILE`):**
  Command-line arguments (`--token <secret>`) are exposed to local unprivileged users through process monitors (`Get-Process`, Task Manager, `/proc/*/cmdline`). Swarm implements protected file-based secret loading with automatic whitespace trimming via `swarm::security::read_secret_from_file()`, enabling operators to store tokens in ACL-restricted filesystem paths.
- **Agent CLI exposure warning:**
  To actively steer operators toward secure operational patterns, `swarm_agent` logs a visible security advisory on stderr whenever `--token` or `--auth-token` is provided on the command line, advising the use of `--token-file` or environment variables.
- **Fail-secure production preflight mode (`SWARM_DEPLOYMENT_ENV=production`):**
  In development mode, coordinator allows unauthenticated loopback requests with a warning. In production mode, coordinator enforces strict fail-secure behavior: if no authentication token is configured, startup terminates immediately with exit code 1 (`[FATAL SECURITY PREFLIGHT]`), preventing inadvertent deployment in an unauthenticated state.
- **Remote RPC transport preflight advisory:**
  GGML RPC is raw unencrypted TCP. Securing the HTTP telemetry API does not protect RPC tensor execution. In production mode, the coordinator inspects all endpoints in `SWARM_RPC_ENDPOINTS` and emits explicit security advisories if non-loopback addresses are detected, reminding operators to encapsulate RPC traffic within an encrypted network overlay (WireGuard / Tailscale).
- **Runtime DLL placement & PATH configuration:**
  On Windows, dynamic libraries (`llama.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`, `ggml-cuda.dll`, `ggml-rpc.dll`) built under `build-cuda\bin` are deployed directly to `build-cuda\` and helper scripts (`Start-ProductionCoordinator.ps1`, `Start-LocalCuda.ps1`) automatically configure process `$env:PATH`, eliminating missing-DLL popup errors during operational launches.
- **Single-machine limitation:**
  Testing continues to be constrained to a single physical Windows machine with NVIDIA GTX 1050. Hardware cluster testing across multiple physical machines remains deferred until secondary hardware is provisioned.

## Milestone 12 decisions — Physical multi-device validation

- **Standalone worker distribution packaging (`dist/swarm-worker-windows-x64.zip`):**
  To allow seamless, zero-dependency deployment onto a secondary Windows computer (Computer B), a standalone worker bundle was created containing the CPU GGML RPC server daemon (`ggml-rpc-server.exe`), essential runtime dynamic libraries (`ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`, `ggml-rpc.dll`), the standalone reporting agent (`swarm_agent.exe`), an automated PowerShell launcher (`Start-RemoteWorker.ps1`), and a deployment guide (`README.md`). The package requires no compiler, CUDA toolkit, or external dependencies on Computer B.
- **Automated two-computer validation harness (`scripts/Invoke-Milestone12Validation.ps1`):**
  Designed a dedicated validation suite that checks TCP reachability to the remote worker port (default 50052), executes the coordinator with remote RPC endpoints and token authentication, validates inventory registration (`is_loopback: false`), executes chat completions, inspects backend placements, and performs clean teardown.
- **Single-client GGML RPC health probe collision fix:**
  Upstream GGML RPC (`ggml-rpc.cpp`) accepts only a single client connection per server process. A naive secondary TCP probe during regular health checks timed out against the busy server socket, falsely marking healthy remote workers `UNAVAILABLE` and causing HTTP 503 errors. Swarm resolved this by inspecting the coordinator process's own TCP connection table (`GetExtendedTcpTable`) for active `MIB_TCP_STATE_ESTAB` sockets without opening competing TCP connections, suppressing probes during active inference via RAII `InferenceWorkerGuard`, and using non-blocking connects with a 2-second timeout.
- **Dynamic memory headroom preservation over forced offload:**
  Computer B reported ~946–957 MiB free RAM in initial testing, which fell below the 12.5% dynamic headroom floor (~920.62 MiB). Swarm strictly maintained safety thresholds by allocating 0 layers to Computer B under dynamic policy, rather than weakening headroom limits. When background applications were closed on Computer B and free RAM reached 1.40 GiB, the dynamic policy safely assigned 2 layers (`[33, 34]`), matching policy predictions 100%.
- **Physical tensor computation confirmation:**
  Physical multi-device inference was empirically confirmed between Computer A (`192.168.137.174`) and Computer B (`192.168.137.1:50052`). Model weights (94.08 MiB), KV cache (4.00 MiB), and compute scratch buffers (74.51 MiB) were verified allocated on Computer B, with 2 layers executing remotely and streaming the complete response without error.
- **Confirmed remaining limitations:**
  1. *Plaintext network boundary*: GGML RPC traffic remains unencrypted and unauthenticated plain TCP. Untrusted networks require WireGuard or Tailscale encapsulation.
  2. *Single-client serialization*: Upstream GGML RPC cannot multiplex requests from multiple clients or threads concurrently on one RPC session.
  3. *No dynamic migration*: A disconnected remote worker during inference aborts the GGML graph; model and context must be recreated via restart.


## Milestone 13 decisions - Per-device compute sharing

- **Worker device selection (`-d`):** Provide Compute stores the selection as a comma-separated GGML device list (`CUDA0`, `CUDA0,CUDA1`, `CPU`, or `all`). The desktop shell resolves `all` to no `-d` argument (the RPC server exports every non-CPU device), resolves `cuda` to the enumerated `CUDA0..CUDAn`, and passes explicit lists unchanged. The UI previews the exact `-d` argument and asks for a restart before a running worker picks up a changed selection.
- **Multi-GPU registration:** The coordinator enumerates every device returned by `ggml_backend_rpc_add_server` instead of only device 0. Each device is registered in `PlacementTracker` as its own backend (`RPC0`, `RPC1`, ...), gets an independent candidate and placement plan, and appears as its own row in Devices. The server-local `device_index` is recorded so buffer-size log lines from multi-device servers map to the correct backend.
- **Local GPU guard:** Upstream `ggml_backend_rpc_device_get_type` reports every RPC device as GPU. The coordinator now skips devices whose name starts with `RPC` when choosing the local accelerator, so a CPU-only host cannot mistake a remote worker for its own GPU.
- **RPC device-type limitation (wire protocol unchanged):** The RPC protocol does not carry the physical device type. A CPU share therefore appears to the coordinator as a GPU whose memory is the worker's host RAM. The UI infers CPU shares by comparing the advertised device memory with the worker's RAM telemetry; without agent telemetry it shows the device as an RPC backend with its advertised memory. Extending the device-memory response would break older workers, so the protocol was deliberately left untouched.
- **Portable worker bundles (`scripts/Build-WorkerBundle.ps1`):** `-Backend cpu` assembles the small CPU bundle; `-Backend cuda` assembles a CUDA-capable bundle including `ggml-cuda.dll` and the CUDA 12 redistributables. The script searches the build output, `dist/cuda-redist`, and an existing bundle for the RPC server and runtime DLLs, then writes a README describing the device-selection flags.
