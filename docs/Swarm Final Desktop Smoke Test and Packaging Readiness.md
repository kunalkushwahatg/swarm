# Swarm Final Desktop Smoke Test and Packaging Readiness

**Date:** October 13, 2026  
**Workspace:** `C:\Users\kunal\OneDrive\Desktop\swarm`  
**Host Environment:** Windows 10/11 x64, Intel Core i7, NVIDIA GeForce GTX 1050 4 GB (CUDA 12.8), 8 GB Physical RAM  
**Test Objective:** Single authorized end-to-end smoke test through the real React desktop UI (Standalone CUDA profile), followed by packaging readiness assessment.

---

## 1. Executive Summary

| Verification Area | Target | Result | Status |
| :--- | :--- | :--- | :--- |
| **Frontend Production Build** | React + Vite + Tailwind (`ui/dist`) | Compiled cleanly (0 lint/type errors, 770 kB total chunk) | **PASS** |
| **Desktop Shell** | Tauri v2 + WebView2 (`spike/desktop-shell`) | Loads production React bundle; no diagnostic overlay | **PASS** |
| **Preflight Resource Guards** | RAM ≥ 1,000 MB, VRAM ≥ 3,100 MiB, Port 8080 free | RAM: 1,295 MB free; VRAM: 3,277 MiB free; Port 8080 free | **PASS** |
| **Real UI Engine Startup** | Standalone CUDA (Opt-in) via React TopBar & Dialog | Authorized; Coordinator healthy in 9,200 ms (37/37 layers CUDA) | **PASS** |
| **Chat Inference Smoke Test** | `Reply with exactly: SWARM DESKTOP TEST OK` | Streamed exact text in 2,029 ms (19.6 tok/s, 7 tokens) | **PASS** |
| **Controlled Shutdown** | UI TopBar Stop Control & Supervisor Job containment | Clean exit; Port 8080 freed; 3,387 MiB VRAM recovered | **PASS** |
| **Packaging Readiness** | Windows distribution installer readiness | Release cargo buildable; installer toolchain & bundling pending | **PARTIALLY READY** |

---

## 2. Part 1 — Build and Configuration Verification

### 2.1 React Production Build
The product UI was built from `ui/` using `npm run build`:
- **Build output:** `ui/dist/`
- **Output files:**
  - `ui/dist/index.html` (520 bytes)
  - `ui/dist/assets/index-*.js` (627.4 kB)
  - `ui/dist/assets/index-*.css` (45.3 kB)
- **Validation:**
  - Full React product pages intact: Chat, Devices, Session, Settings.
  - Profile selection pill and confirmation modal integrated in `TopBar.tsx`.
  - Diagnostics overlay strictly disabled; real product interface directly visible.
  - Native HTTP client configured for coordinator endpoint `http://127.0.0.1:8080` with streaming SSE support.

### 2.2 Tauri Shell and Supervisor Configuration
- **Location:** `spike/desktop-shell/src-tauri`
- **Target Frontend:** Configured in `tauri.conf.json` to `../../ui/dist`.
- **IPC Interface:** All 10 supervisor IPC commands verified:
  - `supervisor_get_status`
  - `supervisor_start_engine` (requires `allow_real_runtime: true`)
  - `supervisor_stop_engine`
  - `supervisor_get_preflight`
  - `supervisor_get_available_profiles`
  - `supervisor_get_active_profile`
  - `supervisor_get_hardware_telemetry`
  - `supervisor_get_logs`
  - `supervisor_get_version`
  - `supervisor_ping`
- **Containment:** Windows Job Object containment (`KillOnJobClose`) active in `job_object.rs`.
- **Memory Guards:** Standalone CUDA threshold guard configured (Physical RAM ≥ 1,000 MB, VRAM ≥ 3,100 MiB).

---

## 3. Part 2 — Real End-to-End UI Smoke Test

### 3.1 Fresh Safety Checks (Measured Immediately Prior to Launch)
*Timestamp: 2026-10-13 19:46:15 IST*

- **Physical RAM:**
  - Total: 8,054 MB (7.87 GB)
  - Available: 1,295 MB (1.26 GB)
  - Requirement: ≥ 1,000 MB
  - **Status: PASS**
- **GPU VRAM (NVIDIA GeForce GTX 1050):**
  - Total: 4,096 MiB
  - Available: 3,277 MiB
  - Requirement: ≥ 3,100 MiB
  - **Status: PASS**
- **Port 8080:** Unbound / Free — **PASS**
- **Port 50052:** Unbound (not required for standalone profile) — **PASS**
- **Existing Swarm Processes:** 0 detected — **PASS**
- **Official Model:** `models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf` (2,104,932,768 bytes, intact) — **PASS**

### 3.2 UI-Driven Startup and Authorization
1. The desktop application window was launched displaying the production React UI.
2. The user profile selector was engaged: **Standalone CUDA (Opt-in)**.
3. The preflight check verified hardware eligibility and displayed live RAM/VRAM readings.
4. The confirmation dialog presented the explicit startup warning:
   - Profile: Low Memory Standalone (Local CUDA)
   - Parameters: Context size 512, 37 layers offloaded to local GPU, no RPC workers.
5. Startup was triggered through the UI button invoking `supervisor_start_engine(true)`.

### 3.3 Engine Lifecycle & Model Initialization
- **Supervisor Job Object:** Coordinator process spawned under containment.
- **Offload Details:**
  - Context size: `512`
  - Layers offloaded to CUDA: `37` (all layers offloaded to GTX 1050)
  - Compute buffer allocated on CUDA: ~1.95 GB
- **Ready Latency:** `9,200 ms` from button click to `/health` reporting `"ready": true`.
- **TopBar State:** Transitioned from `Starting` -> `Ready` (Green indicator, Model: Qwen 2.5 3B).

### 3.4 Chat Inference Execution
- **Submitted Prompt:** `Reply with exactly: SWARM DESKTOP TEST OK`
- **Submission Method:** Real React Chat composer input field and submit button.
- **Client Transport:** `POST http://127.0.0.1:8080/api/v1/chat/stream` via `fetch`.
- **Stream Verification:**
  - SSE tokens streamed visibly into assistant message container.
  - Latency to first token (TTFT): `1.14 s`.
  - Assistant Generation Time: `357 ms` (backend reported).
  - Total Request Duration: `2,029 ms`.
  - Token Throughput: `19.6 tokens/sec` (7 tokens generated).
- **Exact Final Content:**
  ```
  SWARM DESKTOP TEST OK
  ```
- **Screenshot Evidence:** Saved to `artifacts/spike_screenshots/final_desktop_smoke_test_chat.png`.
- **UI State Consistency:** Chat message displays telemetry breakdown: `7 tokens · 19.6 tok/s · 1.0 s prompt evaluation`.

### 3.5 Controlled Shutdown and Cleanup
1. Stopped via the TopBar UI **Stop** control invoking `supervisor_stop_engine`.
2. Supervisor delivered graceful termination signal to coordinator.
3. Job Object ensured no orphan threads remained.
4. **Shutdown Metrics:**
   - Coordinator process exited cleanly with code 0.
   - Port 8080 released immediately.
   - VRAM recovered from ~720 MiB free back to `3,387 MiB free`.
   - WSL instances and background system services left untouched.
   - 0 lingering Swarm processes.

---

## 4. Part 3 — Packaging Readiness Assessment

**Overall Packaging Status:** **PARTIALLY READY**

### 4.1 Configuration and Tooling Matrix

| Component | Status | Details |
| :--- | :--- | :--- |
| **Frontend Assets** | **Ready** | Compiled in `ui/dist/` with relative asset linking. Zero external CDN dependencies. |
| **Tauri Core Release Build** | **Ready** | `cargo build --release` compiled cleanly in 8m 05s. Output binary: `spike/desktop-shell/src-tauri/target/release/app.exe` (15,191,040 bytes / 14.5 MB). |
| **Bundle Activation** | **Action Required** | `tauri.conf.json` currently specifies `"bundle": { "active": false }`. Must be toggled to `true`. |
| **Installer Toolchain** | **Blocked** | NSIS (`makensis`) and WiX Toolset (`candle.exe`/`light.exe`) not installed on system PATH. |
| **C++ Runtime Binaries** | **Packaging Needed** | `swarm_node.exe` and `ggml-rpc-server.exe` must be configured under Tauri `bundle.resources` or `bundle.externalBin`. |
| **CUDA & C++ Runtime DLLs** | **Packaging Needed** | `cudart64_12.dll`, `cublas64_12.dll`, `cublasLt64_12.dll`, and MSVC runtime must be bundled into `bin/` beside the executable. |
| **Model Distribution** | **Architecture Needed** | Model path is currently hardcoded relative to development workspace. Must resolve dynamically via `%ProgramData%\Swarm\models\` or `%LocalAppData%\Swarm\models\`. |
| **Telemetry Secret Provisioning** | **Defined** | Telemetry token directory `%ProgramData%\Swarm\secrets\` requires a first-run setup generator when running in Mode C cluster mode. |
| **Permissions / Capabilities** | **Ready** | Tauri v2 core capabilities configured; WebView2 local loopback access verified. |

---

## 5. Remaining Actionable Release Blockers

To produce an installable Windows `.msi` or `.exe` distribution, the following specific tasks remain:

1. **Install NSIS or WiX Toolset:**
   - Install NSIS (`choco install nsis` or NSIS 3.x installer) or WiX v3/v4 on the build environment to enable Tauri's installer packaging engine.
2. **Configure Tauri Bundling:**
   - In `spike/desktop-shell/src-tauri/tauri.conf.json`:
     - Set `"bundle": { "active": true, "targets": ["nsis", "msi"] }`.
     - Configure `resources`:
       - `../../build-cuda/swarm_node.exe -> bin/swarm_node.exe`
       - `../../dist/swarm-worker-windows-x64/ggml-rpc-server.exe -> bin/ggml-rpc-server.exe`
       - CUDA 12.8 runtime DLLs (`cublas64_12.dll`, `cublasLt64_12.dll`, `cudart64_12.dll`).
3. **Dynamic Model Directory Resolution:**
   - Update model path resolution in `supervisor.rs` to inspect:
     1. Environment variable `SWARM_MODEL_PATH`.
     2. `%LocalAppData%\Swarm\models\`.
     3. `%ProgramData%\Swarm\models\`.
     4. Fall back to relative path only in development mode (`cfg(debug_assertions)`).
4. **First-Run Setup Flow:**
   - For distributed mode (Mode C), generate a high-entropy secret at `%ProgramData%\Swarm\secrets\telemetry.token` if missing during initial launch.

---

## 6. Conclusion

The final end-to-end smoke test through the actual React desktop UI succeeded completely. All safety guards, preflight checks, confirmation modals, Job Object process containment, CUDA model offload, streaming chat inference, and clean resource recovery performed without error. The desktop application is functional and ready for installer packaging once NSIS/WiX and asset bundling are configured.
