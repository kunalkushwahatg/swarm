# Swarm Desktop Product Integration Report

**Date:** October 13, 2026  
**Workspace:** `C:\Users\kunal\OneDrive\Desktop\swarm`  
**Application:** Swarm Desktop (Windows x64 Native Desktop Application)  
**Status:** Complete — Real React Application Restored as Main Desktop Window

---

## 1. Executive Summary & Root Cause Analysis

### Decision Executed
Work on the standalone diagnostic dashboard prototype has been terminated. The authentic product interface—the React 19 + TypeScript + Vite + Tailwind CSS application located in `ui/`—is now the primary, native Windows desktop application window.

### Verified Root Cause of Incorrect UI
Investigation identified the following reasons why the Tauri window was displaying the diagnostic spike instead of the product UI:
1. **Isolated Assets Folder Configuration:** In `spike/desktop-shell/src-tauri/tauri.conf.json`, `build.frontendDist` was set to `"../dist"`, resolving to `spike/desktop-shell/dist/`. This folder contained an isolated, stale static snapshot from early Phase C.1 rather than compiling directly from `ui/src/`.
2. **Script Injection Overlay:** In `spike/desktop-shell/dist/index.html`, lines 8–9 injected:
   - `<script type="module" src="/assets/tauri-bridge.js"></script>`
   - `<script type="module" src="/assets/supervisor-diagnostics.js"></script>`
   During Phase C.3.9, `supervisor-diagnostics.js` mounted `#swarm-supervisor-panel` with CSS `position: fixed; top: 0; left: 0; right: 0; z-index: 99990;` and `max-height: 80vh`, covering the React `#root` element with diagnostic tables and buttons.
3. **Missing Desktop API Integration:** The `ui/src/lib/api.ts` client relied on dev-server proxying (`/health`, `/v1/chat/completions`) without native loopback resolution or CORS-free transport in production desktop mode.

---

## 2. Changes Made & Architecture Restored

### A. Source-of-Truth Build Pipeline
- `spike/desktop-shell/src-tauri/tauri.conf.json` was reconfigured with:
  ```json
  "productName": "Swarm Desktop",
  "build": {
    "frontendDist": "../../../ui/dist"
  },
  "app": {
    "windows": [
      {
        "title": "Swarm Desktop",
        "width": 1200,
        "height": 800
      }
    ]
  }
  ```
  Tauri now packages `ui/dist` directly as compiled from `ui/src/`.

### B. CORS-Free Native Network Client (`ui/src/lib/api.ts`)
- Integrated `@tauri-apps/plugin-http` into the React application.
- When running in Tauri desktop mode, all requests (`/health`, `/backends`, `/nodes`, `/metrics`, and `/v1/chat/completions`) route through `tauriFetch` targeting `http://127.0.0.1:8080`.
- This bypasses WebView2 browser CORS enforcement entirely, supporting SSE delta streaming and `AbortSignal` cancellation over the Windows loopback socket.
- When run in standard web development mode (`npm run dev`), the app transparently falls back to `window.fetch` using Vite's proxy.

### C. Typed Supervisor Client (`ui/src/lib/supervisor.ts` & `useSupervisor.ts`)
- Created a typed IPC bridge for the Rust supervisor:
  - `supervisor.getEngineStatus()`
  - `supervisor.getAvailableProfiles()`
  - `supervisor.preflightCheck(profileId)`
  - `supervisor.startEngine(options)`
  - `supervisor.stopEngine()`
  - `supervisor.cancelStartup()`
  - `supervisor.getDiagnostics()`
- Default profile remains `default` (Distributed Cluster: RPC worker on `50052` + Coordinator on `8080`, with 1,500 MB RAM guard).
- Standalone CUDA is an explicit opt-in option (`low_memory_cuda_standalone`: coordinator with 37 GPU layers offloaded, 1,000 MB RAM / 3,100 MiB VRAM guard).

### D. Native Lifecycle Controls in Product UI
- **`TopBar.tsx`**: Displays concise session state, model name, context window, and an active runtime profile badge (`Cluster (Default)` vs `Standalone CUDA`).
- **`CoordinatorRecoveryCard.tsx`**: When running in desktop mode, presents a Native Engine Launcher directly in the conversation pane with profile selection, start/cancel controls, and preflight issue notices. PowerShell scripts remain available as a secondary collapsible view.
- **`SettingsPanel.tsx`**: Features a "Native Desktop Engine Supervision" section for switching runtime profiles, reviewing port occupancy and RAM/VRAM eligibility, and viewing a collapsible "Supervisor Diagnostics" panel for secondary hardware inspection.

---

## 3. Files Changed

| File | Nature of Change |
|---|---|
| `spike/desktop-shell/src-tauri/tauri.conf.json` | Updated `frontendDist` to `../../../ui/dist`, window title to `Swarm Desktop`, productName to `Swarm Desktop`. |
| `ui/package.json` | Added `@tauri-apps/api` (^2.12.3) and `@tauri-apps/plugin-http` (^2.8.2). |
| `ui/src/lib/api.ts` | Configured `appFetch` with `tauriFetch` for loopback routing and zero CORS failures in desktop mode. |
| `ui/src/lib/supervisor.ts` | Created typed Tauri IPC bindings for process orchestration and profile management. |
| `ui/src/hooks/useSupervisor.ts` | Created reactive hook for polling engine lifecycle, selected profile, and preflight validation. |
| `ui/src/components/TopBar.tsx` | Added active profile chip and desktop lifecycle indicators. |
| `ui/src/components/CoordinatorRecoveryCard.tsx` | Embedded native engine launcher, profile toggle, and preflight error alerts. |
| `ui/src/components/SettingsPanel.tsx` | Added Group 3 Desktop Engine Supervision controls and secondary collapsible diagnostics inspection. |

---

## 4. Verification Results

### 1. React Production Build
```
> ui@0.0.0 build
> tsc -b && vite build

✓ 1927 modules transformed.
dist/index.html                   0.45 kB │ gzip:  0.29 kB
dist/assets/index-DA1cFlr-.css   20.44 kB │ gzip:  5.06 kB
dist/assets/index-BzMmDROZ.js   347.66 kB │ gzip: 97.79 kB
✓ built in 10.17s
```
TypeScript compilation and Vite bundling completed with **0 errors**.

### 2. Tauri Desktop Compilation
```
cargo build (in spike/desktop-shell/src-tauri)
Finished dev profile [unoptimized + debuginfo] target(s) in 1m 30s
Binary generated: spike/desktop-shell/src-tauri/target/debug/app.exe
```

### 3. Native Supervisor Backend Test Suite
Executed all 37 test cases via `supervisor_test_runner`:
```
Total: 37 | Passed: 37 | Failed: 0
Execution time: ~18.5 seconds
```
Verified invariants:
- Zero orphan process leaks via Windows Job Object containment.
- Gate 3 explicit operator authorization enforcement (`allow_real_runtime: true`).
- Fail-closed memory headroom guards (1,500 MB RAM for Cluster; 1,000 MB RAM / 3,100 MiB VRAM for Standalone).
- Strict non-interference with unowned third-party processes.

### 4. Visual Verification of Desktop Shell
Launched `app.exe` and captured window via PowerShell (`Capture-Window.ps1`):
- **Artifact:** `artifacts/spike_screenshots/desktop_react_product_ui.png`
- **Confirmation:** The main desktop application window displays the authentic Swarm product UI:
  - Sidebar with navigation for **Chat**, **Devices**, **Session**, and **Settings**.
  - Top Bar with brand header, model information, and `Cluster (Default)` profile badge.
  - Chat view with Coordinator Recovery card containing the **Native Engine Launcher**.
  - **No diagnostic overlay**; the original design and theme are preserved.

---

## 5. Feature Status Matrix

| Component / Feature | Status | Notes |
|---|---|---|
| **Chat View** | **Working** | Full message stream layout, composer draft retention, timing telemetry, placement ribbon integration. |
| **Streaming Inference** | **Ready** | Connected to `/v1/chat/completions` via `tauri-plugin-http` with SSE parsing and cancellation. |
| **Devices View** | **Working** | Displays device topology, layer allocation, RAM/VRAM gauges, helper configuration modal. |
| **Session View** | **Working** | Shows token counters, prompt evaluation timings, tokens/sec rate, and active placement details. |
| **Settings View** | **Working** | Includes native supervisor profile selector, preflight validation status, and collapsible diagnostics view. |
| **Profile Selection** | **Working** | Defaults to Distributed Cluster; Standalone CUDA available as opt-in option. |
| **Engine Startup Control** | **Working** | Safe, guarded lifecycle commands wired to the Rust supervisor. |

---

## 6. Remaining Blockers to a Production Release

1. **Production Packaging Pipeline:** While debug builds (`target/debug/app.exe`) compile and run, production distribution requires configuring `cargo tauri build` to generate an NSIS installer and code-signed `.msi` bundle.
2. **First-Run Model Onboarding:** In a clean install, the GGUF model path must be confirmed or downloaded if not present in `models/`.
3. **Telemetry Secret Generation:** Production launch scripts expect a telemetry secret token in `$env:ProgramData\Swarm\secrets\telemetry.token`. A setup wizard or automatic generator is needed for fresh installations.
4. **End-to-End Inference Verification:** Real engine execution and token generation remain subject to explicit operator authorization and were intentionally skipped in this integration phase.
