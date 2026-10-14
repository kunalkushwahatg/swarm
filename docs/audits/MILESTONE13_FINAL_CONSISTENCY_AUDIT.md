# Swarm Milestone 13 — Final Consistency & Data-Integrity Audit Report

**Workspace:** `C:\Users\kunal\OneDrive\Desktop\swarm`  
**Date & Timestamp:** 2026-10-11T13:51:00+05:30  
**Environment:** Windows 11 · Coordinator (127.0.0.1:8080) · GGML RPC Worker (127.0.0.1:50052) · Vite UI (127.0.0.1:5173)  
**Screenshots:**  
- `artifacts/ui_screenshots/34_m13_audit_activity_layers_verified.png`
- `artifacts/ui_screenshots/35_m13_audit_workers_reconciled.png`
- `artifacts/ui_screenshots/36_m13_audit_workers_cuda_layers_fixed.png`
- `artifacts/ui_screenshots/33_m13_audit_nodes_topology_corrected.png`

---

## 1. Executive Summary

During the final data-integrity review of Swarm Milestone 13, an inconsistency was identified:
- The **Activity** screen displayed: Host CPU (33 layers, `L0–L32`), Loopback RPC0 (1 layer, `L33`), and Local CUDA0 (3 layers, `L34–L36`) = 37 total layers.
- The **Nodes** topology screen corroborated this exact breakdown (`gateway node-gateway-local`: CPU 33 layers + CUDA0 3 layers; `worker node-worker-loopback`: RPC0 1 layer).
- However, the **Workers** screen under *Local Acceleration Backends (Host Hardware)* displayed `Assigned Layers: 0` for CUDA0, with no layer badge.

This audit report details the root-cause analysis, backend verification, frontend architectural reconciliation, build/lint validation, and live browser verification.

---

## 2. Root Cause Analysis

### A. Backend Source Comparison
We queried the real Swarm coordinator endpoints (`/health`, `/backends`, and `/nodes`):

1. **`GET /health` (`WorkerManager`):**
   - The coordinator's legacy `WorkerManager` maintains a list of networked worker descriptors.
   - For host-local in-process hardware acceleration, it instantiates an unnetworked device descriptor stub:
     ```json
     {
       "id": "local-cuda-0",
       "backend_id": "local-cuda-0",
       "device_name": "CUDA0",
       "type": "LOCAL_CUDA",
       "port": 0,
       "host": "127.0.0.1",
       "state": "UNAVAILABLE",
       "assigned_layers": [],
       "assigned_layer_ranges": []
     }
     ```
   - In `WorkerManager`, `assigned_layers` is kept empty (`[]`) because layer assignment for in-process backends is handled directly by the GGML inference engine (`PlacementTracker`), not by the remote RPC worker registry.

2. **`GET /backends` (`PlacementTracker` — Authoritative Source):**
   - The coordinator's `PlacementTracker` is the **authoritative single source of truth** for tensor layer assignments and device memory allocations:
     ```json
     {
       "backend_id": "CUDA0",
       "backend_type": "local_cuda",
       "device_name": "CUDA0",
       "description": "NVIDIA GeForce GTX 1050",
       "assigned_layers": [34, 35, 36],
       "assigned_layer_ranges": [[34, 36]],
       "model_buffer_bytes": 353915372,
       "kv_buffer_bytes": 4194304,
       "compute_buffer_bytes": 315359232,
       "memory_total_bytes": 4294836224,
       "memory_free_bytes": 3526780519,
       "measurement_status": "observed"
     }
     ```

3. **`GET /nodes` (`NodeRegistry`):**
   - Correctly aggregates nodes and hardware backends from `PlacementTracker`, allocating layers 34–36 to `CUDA0` on `node-gateway-local`.

### B. Frontend Mapping Flaw
In `ui/src/components/WorkersPanel.tsx`:
- The component originally only consumed `useHealth()`.
- While `rpcWorkers` received layers from `w.assigned_layers` (populated via RPC handshake), `localHardwareDevices` relied directly on `dev.assigned_layers.length`, which evaluated to `0` from the `/health` device stub.
- Consequently, the UI rendered `Assigned Layers: 0` despite the real GGML inference engine running 3 layers on the GPU.

---

## 3. Implementation of the Fix

Rather than hardcoding any values or altering the C++ inference engine, we resolved this cleanly at the frontend state-correlation boundary:

1. **Integrated `useBackends(3000)` Hook into `ui/src/components/WorkersPanel.tsx`:**
   - Polls `/backends` concurrently with `/health`.
2. **Correlation Helpers (`getBackendPlacement` & `getBackendLayers`):**
   - Correlates each hardware device or RPC worker in `/health` with its authoritative record in `backendsData.backends` by matching `backend_id`, `device_name`, or `backend_type`.
   - If `/health` lacks layer metadata (as with `local-cuda-0`), it falls back to the authoritative `PlacementTracker` data.
3. **Enhanced Device Display:**
   - **Display Name:** Now uses the GPU device name from `/backends` (`NVIDIA GeForce GTX 1050 (CUDA0)`).
   - **Layer Count Badge:** Displays `3 layers` badge.
   - **Assigned Layers Metric:** Displays `Assigned Layers: 3 [34-36]`.
   - **Real Buffer Allocations:** Renders Model Buffer (337.52 MB), KV Cache (4.00 MB), and Compute Buffer (300.75 MB).
   - **Dedicated VRAM Bar:** Retains accurate 4 GB VRAM status.

---

## 4. Cross-Screen Consistency Verification

| Screen | Backend Source | Host CPU | Loopback RPC0 (50052) | Local CUDA0 (GTX 1050) | Total Layers | Consistency Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Activity** | `/backends` + `/health` | 33 (`L0–L32`) | 1 (`L33`) | 3 (`L34–L36`) | 37 / 37 | **VERIFIED (100%)** |
| **Nodes** | `/nodes` + `/backends` | 33 (`L0–L32`) | 1 (`L33`) | 3 (`L34–L36`) | 37 / 37 | **VERIFIED (100%)** |
| **Workers** | `/health` + `/backends` | — | 1 (`L33-33`) | 3 (`L34-36`) | 4 offloaded | **VERIFIED (100%)** |

All three panels are now 100% consistent and reflect the authentic active runtime state of the model `qwen2.5-3b-instruct-q4_k_m.official-check.gguf` (37 layers total).

---

## 5. Verification Results

### A. Static Analysis (`npm run lint` via Oxlint)
```text
> ui@0.0.0 lint
> oxlint

Found 0 warnings and 0 errors.
Finished in 270ms on 16 files with 116 rules using 8 threads.
Exit code: 0
```

### B. Production Build (`npm run build`)
```text
> ui@0.0.0 build
> tsc -b && vite build

vite v8.3.4 building client environment for production...
transforming...
✓ 1920 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                   0.45 kB │ gzip:  0.29 kB
dist/assets/index-Bj7S_YUE.css   15.27 kB │ gzip:  4.14 kB
dist/assets/index-DATbAxtz.js   289.65 kB │ gzip: 84.05 kB
✓ built in 763ms
Exit code: 0
```

### C. Live Browser Verification & Screenshot Evidence
Using browser subagent inspection at 1440×900:
- **Card Title:** `NVIDIA GeForce GTX 1050 (CUDA0)`
- **Badges:** `In-Process Hardware` & `3 layers`
- **Assigned Layers:** `3 [34-36]`
- **Buffer Breakdown:**
  - Model Buffer: `337.52 MB`
  - KV Cache: `4.00 MB`
  - Compute: `300.75 MB`
- **VRAM Dedicated:** `732.48 MB / 4.00 GB (17.9% used)`
- **Screenshot Artifacts:**
  - `artifacts/ui_screenshots/36_m13_audit_workers_cuda_layers_fixed.png`
  - `artifacts/ui_screenshots/35_m13_audit_workers_reconciled.png`

---

## 6. Files Changed

1. `ui/src/components/WorkersPanel.tsx`:
   - Added `useBackends(3000)` hook import and call.
   - Correlated `/health` worker descriptors with `/backends` placement data.
   - Updated CUDA device card and RPC worker cards to render authoritative layer counts, ranges, and GGML tensor buffer sizes.
2. `artifacts/ui_screenshots/36_m13_audit_workers_cuda_layers_fixed.png`:
   - High-fidelity screenshot capturing the reconciled Workers & Cluster screen.
3. `artifacts/ui_screenshots/35_m13_audit_workers_reconciled.png`:
   - Updated with the reconciled state.

---

## 7. Safety & System Health Attestation

- **Warm Engineering Workbench Design:** Preserved in its entirety.
- **C++ Inference Engine:** Unmodified; zero regression risk.
- **Milestone 12 Baseline:** Preserved at `backups/milestone12-final-baseline-20261011/`.
- **System Memory:** No redundant inference invocations were triggered; coordinator memory headroom remained safely within boundaries.
