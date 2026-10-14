# Roadmap

## 1. Reproducible local baseline and workspace hygiene

Exit criteria: a documented build command, verified model hash, isolated
validation artifacts, clean ports after tests, and repeatable local CUDA output.
The current baseline is documented; future changes must preserve it.

## 2. RPC lifecycle, failure handling, and regression tests

Exit criteria: automated coverage for registration failure, process ownership,
device lifetime, shutdown ordering, and RPC-disabled fallback without silently
claiming RPC participation.

## 3. Real second-device LAN testing

Exit criteria: a trusted second device runs a matching RPC server on a private
address, the client connects using compatible binaries, remote buffers and
remote computation are evidenced, and cleanup is verified on both hosts.

## 4. Backend instrumentation and placement observability — COMPLETED

Exit criteria met on 2026-10-10:
- Thread-safe `llama_log_set` callback captures real-time backend layer assignments, model buffer bytes, KV cache buffer bytes, and compute buffer bytes.
- Physical host memory is accurately deduplicated across loopback RPC workers with `shared_host` memory scope.
- Structured endpoints `/backends`, `/workers`, and Prometheus `/metrics` report observed placement and buffer allocations.
- Monotonic timings (`std::chrono::steady_clock`) measure prompt evaluation time, token generation time, total latency, and tokens per second without dividing by zero.
- Preserved existing fault handling semantics and validated against local CUDA and two-worker loopback test harnesses.


## 5. Multi-worker placement and scheduling — COMPLETED

Exit criteria met on 2026-10-10:
- Explicit placement policies supported: `SWARM_PLACEMENT_POLICY=none` (preserves GGML defaults) and `SWARM_PLACEMENT_POLICY=resource_aware`.
- Virtual worker profiles parsed strictly (`SWARM_WORKER_PROFILES=id=budget,...`) with unit validation (`B`, `KB`, `KiB`, `MB`, `MiB`, `GB`, `GiB`), duplicate rejection, and no silent truncations.
- Calibrated layer cost model with safety margin; capacities capped at offloaded layer count; split weights derived from capped capacities.
- Ineligible/zero-capacity workers assigned `0.0f` split weight, preventing unwanted layer allocation.
- GGML `upper_bound` placement simulation predicts exact layer boundaries; runtime verification flags any mismatch via `policy_match`.
- Controlled startup errors emitted for insufficient total budget or invalid profile syntax.
- Full 8-case test matrix validated under `artifacts/validation/2026-10-10/milestone-5/`.

## 6. Multi-node orchestration and reliability — COMPLETED

Exit criteria met on 2026-10-10:
- Worker lifecycle, health monitoring, and graceful startup/shutdown verified across local multi-worker loopback setups.
- Non-intrusive TCP health monitoring prevents single-client listen backlog exhaustion on `ggml-rpc-server`.
- Controlled error handling: idle/pre-inference worker loss safely returns HTTP 503 Service Unavailable with structured JSON error; Swarm process remains alive and listening.
- Mid-inference worker failures captured via `ggml_set_abort_callback` with descriptive diagnostics.
- Controlled clean restart recovery verified end-to-end.
- Arbitrary host addresses and hostnames supported via `getaddrinfo`; whitespace trimmed in endpoint configuration.
- Two-computer remote deployment architecture documented (ports, processes, firewall, and connectivity).
- Full 7-case test suite passing in `scripts/Invoke-Milestone6Validation.ps1` with evidence in `artifacts/validation/2026-10-10/milestone-6/`.

## 7. Node inventory and resource discovery — COMPLETED

Exit criteria met on 2026-10-10:
- Small, documented node capability model with stable node IDs, roles (`gateway`, `worker`), and endpoints.
- Resource value wrapper (`ResourceValue<T>`) tracking values, freshness timestamps (`observed_at_ms`), and provenance: `measured`, `configured_budget`, `simulated`, `unknown`.
- Dedicated `GET /nodes` endpoint serving full inventory, per-node device capabilities, layer assignments, and cluster summary.
- Strict host RAM deduplication for loopback workers: physical host memory is never summed additively across collocated loopback processes.
- Clear separation of configured placement budgets from measured hardware memory.
- Deterministic offline test suite (`test_node_inventory.exe`) validating 7 test scenarios (valid/invalid metadata, staleness, disconnect/recovery, required vs zero-layer, loopback deduplication, and synthetic fixture isolation).
- Full automated validation suite passing in `scripts/Invoke-Milestone7Validation.ps1` with evidence in `artifacts/validation/2026-10-10/milestone-7/`.

## 8. Worker-side resource agent and coordinator integration — COMPLETED

Exit criteria met on 2026-10-10:
- Standalone, lightweight reporting agent (`swarm_agent.exe`) built with minimal Win32/DXGI dependencies, operable as a single-shot probe or long-running daemon.
- Probes real OS and device capabilities: hostname, CPU architecture and model, total and available physical RAM via `GlobalMemoryStatusEx`, and GPU VRAM via DXGI `DedicatedVideoMemory`.
- Unsupported metrics (thermals, utilization, fan RPM) explicitly reported as omitted / `null` rather than fabricated.
- Coordinator report ingestion (`POST /api/v1/nodes/report`, aliased at `POST /nodes/report`) with 64 KB payload boundary (`SWARM_MAX_REPORT_PAYLOAD_BYTES`), rejecting malformed JSON, invalid schemas, and inverted RAM with HTTP 400.
- Resource provenance strictly maintained: agent telemetry tagged `MEASURED`, preserved alongside configured budgets (`CONFIGURED_BUDGET`).
- Freshness tracking with 30s TTL: stale nodes transition to `is_stale: true`, `UNAVAILABLE`, excluded from active free memory scheduling assumptions. Re-reporting cleanly recovers fresh state.
- Loopback memory deduplication preserved across multiple agent and worker processes.
- Offline unit suite (`test_agent_and_inventory.exe`, 7/7 PASS) and live integration suite (`Invoke-Milestone8Validation.ps1`, 7/7 PASS) passing with evidence in `artifacts/validation/2026-10-10/milestone-8/`.
- Full regressions passing against Milestone 6 (8/8 PASS) and Milestone 7 (7/7 PASS).

## 9. Dynamic resource-aware layer allocation — COMPLETED

Exit criteria met on 2026-10-10:
- Conservative capacity estimator (`ConservativeCapacityEstimator`, `estimator.h`) deriving usable layer budgets from trustworthy telemetry (`MEASURED`) rather than exclusively static profiles.
- Strict differentiation between measured total, genuinely available memory, configured budgets, model demand, and reserved OS/application headroom (`SWARM_RESERVED_HEADROOM_RAM_MB=1024`, `SWARM_RESERVED_HEADROOM_VRAM_MB=256`).
- Loopback memory deduplication and partitioning: collocated loopback processes share usable physical host RAM equally without additive capacity inflation.
- Policy mode `SWARM_PLACEMENT_POLICY=dynamic` (or `dynamic_resource_aware`) derives split weights matching exact GGML contiguous device order.
- Stale (>30s TTL), missing, implausible, or insufficient telemetry safely halts startup with exit code 1 and actionable diagnostics; no silent layer reductions or unrequested fallback.
- Offline deterministic unit tests (`test_dynamic_policy.exe`, 8/8 PASS) and live integration suite (`Invoke-Milestone9Validation.ps1`, 8/8 PASS) passing with evidence in `artifacts/validation/2026-10-10/milestone-9/`.
- Full regressions passing against Milestone 6 (8/8 PASS), Milestone 7 (7/7 PASS), and Milestone 8 (7/7 PASS).

## 10. Secure remote-node readiness — COMPLETED

Exit criteria met on 2026-10-10:
- Bearer token authentication implemented for telemetry reporting (`POST /api/v1/nodes/report`), loaded from `SWARM_TELEMETRY_TOKEN` / `SWARM_AUTH_TOKEN` without committed secrets.
- Constant-time secret comparison (`swarm::security::constant_time_equals`) eliminating timing side-channel attacks.
- Strict rejection of missing auth (401 + `WWW-Authenticate: Bearer`), invalid format (401), invalid tokens (403), remote unauthenticated requests (403), oversized payloads (413), and malformed schemas (400).
- Inventory protection: unauthorized requests cannot refresh node freshness or advance sequence numbers.
- Unauthenticated loopback development mode explicitly supported with visible security warning.
- Upstream GGML RPC plaintext boundary documented; interim encrypted network overlay (WireGuard / Tailscale) specified for remote multi-computer execution.
- Repaired historical Milestone 8 stale-report test fixture to include valid `timestamp_ms`.
- Full offline security unit tests (`build-cuda/test_security.exe`, 5/5 PASS), Milestone 10 integration suite (`Invoke-Milestone10Validation.ps1`, 9/9 PASS), and full regressions (Milestone 9: 8/8 PASS, Milestone 8: 7/7 PASS, Milestone 7: 7/7 PASS, Milestone 6: 8/8 PASS).

## 11. Production readiness and deployment hardening — COMPLETED

Exit criteria met on 2026-10-10:
- Fail-secure production mode (`SWARM_DEPLOYMENT_ENV=production`): coordinator immediately halts at startup (exit code 1) if telemetry authentication token is not configured, preventing accidental unauthenticated production exposures.
- Process-list credential security: supported file-based token loading (`SWARM_TELEMETRY_TOKEN_FILE` and `--token-file <path>`), preventing token disclosure in `Get-Process`, Task Manager, and `/proc` process listings.
- CLI argument security warning: runtime warning emitted on stderr if tokens are passed via CLI flags (`--token` / `--auth-token`).
- Upstream GGML RPC remote advisory: coordinator emits an explicit security advisory when non-loopback RPC worker endpoints are detected, warning operators that raw GGML RPC is unencrypted and must be routed through an encrypted overlay (WireGuard / Tailscale).
- Windows runtime deployment hygiene: placed runtime DLLs (`llama.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`, `ggml-cuda.dll`, `ggml-rpc.dll`) in `build-cuda` next to `swarm_node.exe`, and hardened operational scripts with automatic `$env:PATH` configuration to prevent Windows missing DLL dialogs.
- Operational deployment scripts: provided turn-key launchers `scripts/Start-LocalCuda.ps1` (Mode A), `scripts/Start-LoopbackRpc.ps1` (Mode B), and `scripts/Start-ProductionCoordinator.ps1` (Mode C) with preflight validation and health verification.
- Production deployment guide: authored comprehensive `docs/PRODUCTION_DEPLOYMENT.md` detailing operational modes, port/firewall matrix, VPN overlay setups, and secret access controls.
- Full offline security unit tests (`build-cuda/test_security.exe`, 6/6 PASS including `read_secret_from_file`), Milestone 11 integration suite (`scripts/Invoke-Milestone11Validation.ps1`, 8/8 PASS), and full regressions (Milestone 10: 9/9 PASS, Milestone 9: 8/8 PASS, Milestone 8: 7/7 PASS, Milestone 7: 7/7 PASS, Milestone 6: 8/8 PASS).

## 12. Physical multi-device LAN deployment and network benchmarking — COMPLETED

Exit criteria met on 2026-10-11:
- Standalone worker distribution package prepared and verified: `dist/swarm-worker-windows-x64.zip` (includes `ggml-rpc-server.exe`, runtime DLLs, `swarm_agent.exe`, turn-key launcher `Start-RemoteWorker.ps1`, and documentation).
- Automated two-computer validation harness prepared and verified: `scripts/Invoke-Milestone12Validation.ps1`.
- Physical network connectivity and firewall traversal confirmed between Computer A (`192.168.137.174`) and Computer B (`192.168.137.1:50052`).
- Fixed remote RPC worker health check behavior (`WorkerManager::check_worker_health`): replaced competing TCP connect probes with Windows TCP table inspection (`GetExtendedTcpTable`), avoiding socket collisions on single-client GGML RPC servers and eliminating false HTTP 503 errors.
- Verified physical remote tensor computation: layers 33–34 allocated to Computer B (`RPC0`), with 94.08 MiB model buffer, 4.00 MiB KV buffer, and 74.51 MiB compute scratch buffer allocated remotely.
- Verified multi-device forward graph execution across CPU (layers 0–32) + CUDA0 (layers 35–36) + RPC0 (layers 33–34).
- Verified dynamic placement with physical telemetry: Computer B's 1.40 GiB free RAM evaluated with 920.62 MiB headroom floor, accurately predicting and placing 2 layers on RPC0 with 100% policy match.
- Dedicated regression test suite created and passing: `build-cuda/test_rpc_health.exe` (5/5 PASS).
- All offline regression suites passing: Security (6/6 PASS), Agent (7/7 PASS), Dynamic Policy (9/9 PASS), RPC Health (5/5 PASS) — 27/27 total.
- Complete evidence preserved in `artifacts/validation/2026-10-11/milestone-12/` and baseline snapshot in `backups/milestone12-final-baseline-20261011/`.




