# Swarm Desktop — Defect Register and Corrections Log

**Audit Execution Date:** 2026-10-16  
**Topology:** Computer A (Host Controller: `192.168.137.1`) + Computer B (Remote RPC Worker: `192.168.137.202:50052`)  
**Evaluator:** Antigravity Autonomous Engineering & Acceptance QA

---

### DEF-01: Premature Coordinator Rollback During Multi-Node Wi-Fi Weight Streaming

- **Defect ID:** `DEF-01`
- **Severity:** High (Critical for remote multi-node setups)
- **Component:** `spike/desktop-shell/src-tauri/src/supervisor/commands/lifecycle.rs` & `orchestrator.rs`
- **Symptoms:**
  When configuring a distributed cluster with 9–13 layers offloaded to remote Computer B, high network usage was observed for ~75 seconds, followed by:
  `Coordinator PID health check on port 8080 timed out after 75000 ms`
  and on Computer B:
  `receive failed: bytes received 2698080, size to receive 9983440, then client closed`
- **Root Cause:**
  Streaming 500 MB – 1 GB of quantized neural network layer tensors over a standard 2.4 GHz / 5 GHz Wi-Fi hotspot requires 80–120 seconds. The supervisor had a hardcoded readiness check timeout of `75000` ms (75 seconds). At second 75, the coordinator was in the middle of transferring a 10 MB tensor chunk. The supervisor mistakenly assumed the coordinator had hung, triggering safety rollback and terminating the process, which severed the TCP socket.
- **Resolution Applied:**
  In [`lifecycle.rs`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/supervisor/commands/lifecycle.rs#L525-L531), increased `readiness_timeout` to `240000` ms (4 minutes) for multi-node setups and added support for dynamic environment override via `SWARM_READINESS_TIMEOUT_MS`.
- **Regression Verification:**
  Rebuilt release binary `app.exe`. Re-ran full cluster launch with 9 layers offloaded to Computer B. Coordinator completed all weight uploads in 118,729 ms (~118 seconds), verified healthy on port 8080, and successfully executed distributed inference without errors.
- **Status:** **VERIFIED FIXED (PASS)**

---

### DEF-02: Remote Worker Terminating on Session Disconnect / Socket Reset

- **Defect ID:** `DEF-02`
- **Severity:** Medium (Operational Resiliency)
- **Component:** `dist-worker-package/Start-Worker.bat` & `swarm-rpc-worker/run_worker.bat`
- **Symptoms:**
  Whenever an inference session ended or the coordinator restarted, `ggml-rpc-server.exe` on Computer B exited and paused at the command prompt, requiring manual user intervention to restart it.
- **Root Cause:**
  Vanilla `ggml-rpc-server.exe` can exit if its client socket abruptly closes or finishes. The batch scripts invoked `ggml-rpc-server.exe` followed immediately by `pause`, terminating the server process until someone manually pressed a key.
- **Resolution Applied:**
  Updated both `Start-Worker.bat` and `run_worker.bat` with a resilient `:loop` structure:
  ```bat
  :loop
  echo [%date% %time%] Starting GGML RPC Server on 0.0.0.0:50052 ...
  ggml-rpc-server.exe -H 0.0.0.0 -p 50052 -t 4
  echo.
  echo [WARNING] GGML RPC Server stopped (exit code: %errorlevel%).
  echo Auto-restarting worker in 2 seconds... (Press Ctrl+C to stop)
  timeout /t 2 >nul
  goto loop
  ```
  Updated lightweight distribution package [`swarm-rpc-worker.zip`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/swarm-rpc-worker.zip) (755 KB).
- **Regression Verification:**
  Computer B automatically recovers and rebinds port `50052` immediately across cluster stops, resets, and reconnects.
- **Status:** **VERIFIED FIXED (PASS)**

---

### DEF-03: Compute Allocation Slider Deserialization Crash & Preview Failure

- **Defect ID:** `DEF-03`
- **Severity:** High (Functional Blocker in UI)
- **Component:** `spike/desktop-shell/src-tauri/src/supervisor/planning.rs` & `ui/src/components/ComputeAllocationModal.tsx`
- **Symptoms:**
  Moving the split weight sliders in the Compute Allocation Modal crashed `supervisor_preview_allocation_plan` with missing field error or caused the UI preview to collapse into "100% Host CPU Memory".
- **Root Cause:**
  The Rust struct `DeviceSettingInput` required `device_name` during deserialization, but slider updates omitted `device_name`. In addition, `handleDeviceSplitWeightChange` in the React modal was discarding device names and backend types when rebuilding device settings.
- **Resolution Applied:**
  Added `#[serde(default)]` to optional fields in `DeviceSettingInput` in `planning.rs`, and updated `handleDeviceSplitWeightChange` to preserve all device metadata.
- **Regression Verification:**
  Verified smooth slider movement in UI, manual plan preview generation returned `is_valid: true`, `risk_level: SAFE`, and correctly allocated layers across CUDA and RPC backends.
- **Status:** **VERIFIED FIXED (PASS)**

---

### DEF-04: Streaming SSE Response Parse Mismatch on Non-Streaming Invocations

- **Defect ID:** `DEF-04`
- **Severity:** Low (Integration / Protocol Handling)
- **Component:** API Client / Test harness
- **Symptoms:**
  Invoking `/v1/chat/completions` with `stream: false` or default headers produced Server-Sent Events (`data: {"choices":...}`) lines that caused direct `res.json()` calls to fail with `Unexpected token 'd'`.
- **Root Cause:**
  The C++ coordinator implementation streams chunks by default using SSE framing.
- **Resolution Applied:**
  Added unified SSE chunk accumulator to handle both buffered and streaming responses seamlessly.
- **Regression Verification:**
  Chat completions cleanly stream tokens and parse full assistant responses.
- **Status:** **VERIFIED FIXED (PASS)**
