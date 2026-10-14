# Swarm UI — Technical Architecture & Guide

Modern, responsive web interface for **Swarm** — a distributed LLM inference engine running across multiple computers and local RPC workers.

---

## 1. Visual Design & Aesthetic Tokens

The interface follows a clean, technical, productivity-focused design inspired by Linear and Raycast. It uses light mode by default with accessible WCAG-compliant contrast and zero decorative gimmickry (no neon gradients, glowing borders, or fake illustrations).

### Color Palette
- **Canvas / Background**: `#F7F8F6` (Warm off-white)
- **Surfaces / Cards**: `#FFFFFF` (Crisp white)
- **Dividers & Borders**: `#E4E6E2`
- **Primary Text**: `#252A30` (Charcoal)
- **Secondary Text**: `#69717D` (Muted gray)
- **Accent**: `#416B8C` (Muted steel-blue)
- **Status Indicators**:
  - OK / Ready: `#2E7D5B`
  - Warning / Stale: `#8C6B2E`
  - Error / Disconnected: `#8C2E2E`

---

## 2. Implemented Application Sections

### A. Streaming Chat
- Connects to `/v1/chat/completions` using real Server-Sent Events (SSE).
- Displays streaming token output with typing cursor animation.
- Captures and displays real generation timings from the C++ coordinator:
  - Total tokens generated
  - Tokens per second rate (`tok/s`)
  - Prompt evaluation duration (`ms`)
  - Token generation duration (`ms`)
- Configurable `max_tokens` input parameter.
- Abort generation button (`Stop`) and conversation history reset.

### B. Cluster Devices & Workers
- **Local Coordinator Gateway**: Displays server state, endpoint (`127.0.0.1:8080`), active model path, context size, and inference readiness.
- **RPC Workers**: Displays every registered worker with:
  - Distinct badge for **Localhost Loopback RPC (Same Computer)** vs **Remote Physical Worker (Secondary Machine)**.
  - Process ID (PID) for local workers.
  - Assigned layer counts and range brackets (e.g. `[0-3]`).
  - Model buffer, KV cache, and compute buffer sizes.
  - Host RAM / Device VRAM telemetry bar, **strictly distinguishing unavailable telemetry from a measured zero**.
  - Worker health status and real error messages.

### C. Activity & Backend Placement
- Visual **Layer Distribution Bar** mapping layer segments across CPU, CUDA, and RPC backends with consistent color coding.
- **Live Prometheus Telemetry**: Directly polled from coordinator `/metrics`:
  - Lifetime tokens generated counter.
  - Most recent generation rate (`tok/s`).
  - Average prompt evaluation latency (`ms`).
  - Average token generation latency (`ms`).
- **Cluster Memory Accounting**: Model buffers, KV cache, compute buffers, total allocated, host RAM total/available, and explicit deduplication notice for shared host memory on loopback.

### D. Discovered Nodes Inventory
- Real-time node inventory from `/nodes` endpoint.
- Cluster summary: Total nodes, online nodes, required nodes, agent-reported nodes, stale count.
- Per-node cards showing hardware architecture (e.g., `x86_64`), CPU model, measured RAM total/available, and GPU VRAM with provenance timestamp.

### E. Settings & Process Controls
- Active runtime configuration summary (model path, context size, placement policy, bind host/port).
- **Local Process Management**: Detailed safety documentation explaining why browser JavaScript cannot launch arbitrary host processes without an insecure bridge.
- **Audited PowerShell Scripts**: One-click copyable commands for:
  - `Start-LocalDev.ps1` (spawns coordinator & RPC worker on 50052)
  - `Test-LocalDevInference.ps1` (validates end-to-end token generation)
  - `Stop-LocalDev.ps1` (clean process termination and port release)
- Safety verification confirming Milestone 12 baseline preservation and loopback isolation.

---

## 3. Responsive Layout

- **Desktop (>= 768px)**: Left fixed vertical sidebar (200px width), top sticky brand/status header, spacious content area.
- **Mobile / Tablet (< 768px)**: Bottom navigation tab bar (touch-friendly targets >= 44px), sticky top bar with connection indicator, single-task content pane preventing horizontal overflow.

---

## 4. How to Run

### Development Mode (with proxy to coordinator on port 8080)
```powershell
# From workspace root:
powershell -ExecutionPolicy Bypass -File scripts\Start-UI.ps1

# Or directly in ui/ directory:
cd ui
npm run dev
```
Open [http://127.0.0.1:5173](http://127.0.0.1:5173).

### Production Build
```powershell
cd ui
npm run build
```
Build output is generated into `ui/dist/`.
To preview the built production bundle:
```powershell
npm run preview
```
