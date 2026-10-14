# Swarm Milestone 13 &mdash; Architectural & Visual Design Decisions

## 1. Executive Summary
As part of Milestone 13 Design Transformation, four distinct visual and architectural directions were explored and evaluated side-by-side on a dedicated preview canvas (`ui/public/design-exploration.html`).

**Selected Direction:** **Direction A &mdash; Warm Engineering Workbench** enriched with topological clarity elements from **Direction C (Distributed Systems Instrument)**.

Swarm's core identity is established as a **quiet, precise engineering workbench for distributed inference** &mdash; balancing human-scale calm with rigorous technical transparency.

---

## 2. Exploration Directions Evaluated

| Direction | Paradigm | Palette & Style | Strengths | Tradeoffs |
| :--- | :--- | :--- | :--- | :--- |
| **A: Warm Engineering Workbench** | Calm technical workbench | `#F7F7F3` warm canvas, `#252B28` charcoal text, `#356B55` forest accent | Exceptional readability, authentic workbench feel, balanced hierarchy | Needs crisp topological elements for cluster visualization |
| **B: Precision Productivity** | IDE / Terminal tool | `#F8F9FA` slate, `#0F172A` stark contrast, hairline dividers | Dense, developer-native | Too sterile; resembles a generic code editor or admin CRUD |
| **C: Distributed Systems Instrument** | Hardware topology monitor | `#F1F4F8` instrument grey, `#1E3A8A` deep blue, node graphs | High technical transparency, clear layer flow | High cognitive load; graph-heavy components can wrap poorly on narrow mobile |
| **D: Contemporary Editorial Minimalism** | Typography-led editorial | `#FAF9F5` ivory, serif branding, stark line rules | Elegant, distinctive | Inadequate data density for low-level GGML buffer & RPC telemetry |

---

## 3. Selection Rationale for Direction A (Warm Engineering Workbench)

1. **Brand Identity & Authenticity**: Swarm coordinates real physical hardware (CPUs, GPUs, and network RPC endpoints). The warm workbench aesthetic communicates reliability, quiet confidence, and tactile engineering precision without falling into generic dark-mode cyberpunk or SaaS marketing cliches.
2. **Readability & Ergonomics**: Normal body text on `#F7F7F3` background with `#252B28` text yields a contrast ratio exceeding **9.5:1**, far exceeding WCAG 2.2 AA (4.5:1) and AAA (7:1).
3. **Chat-First Workspace**: Constrained ~960px reading column with anchored bottom composer ensures focus during extended interactive sessions.
4. **Architectural Transparency**: Distinctly separates:
   - **Local Coordinator Gateway** (`127.0.0.1:8080`)
   - **Local In-Process Hardware Acceleration** (`CUDA0` VRAM, 3 layers offloaded)
   - **Distributed RPC Workers** (`127.0.0.1:50052`, 33 layers offloaded)
5. **Cross-Platform Adaptability**: Responsive tokens seamlessly transition from 1440px desktop down to 320px ultra-compact mobile without horizontal overflow or clipped badges.

---

## 4. Centralized Design System Tokens

### Palette
- **Canvas / Background**: `--color-bg: #F7F7F3`
- **Surface**: `--color-surface: #FFFFFF`
- **Surface Subtle**: `--color-surface-subtle: #F0F2EE`
- **Border**: `--color-border: #E2E6E0`
- **Border Strong**: `--color-border-strong: #CDD3CA`
- **Text Primary**: `--color-text: #252B28`
- **Text Secondary**: `--color-text-2: #66716B`
- **Text Muted / Placeholder**: `--color-text-3: #97A29C`
- **Accent Primary**: `--color-accent: #356B55` (deep forest workbench green)
- **Accent Foreground**: `--color-accent-fg: #FFFFFF`
- **Accent Hover**: `--color-accent-hover: #295543`
- **Accent Subtle (Bg)**: `--color-accent-subtle: #E8ECE6`

### Status Indicators (Semantic)
- **Ready / Online**: `--color-ok: #2D6A4F`, bg: `#EAF4EE`
- **Busy / Generating**: `--color-busy: #356B55`, bg: `#E8ECE6`
- **Warning / Degraded**: `--color-warn: #8D6228`, bg: `#FEF7EB`
- **Error / Offline**: `--color-error: #9E3A3A`, bg: `#FDEDED`
- **Idle / Stale**: `--color-idle: #66716B`, bg: `#F0F2EE`

### Typography & Layout
- **Primary Typeface**: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif`
- **Technical / Monospace**: `"JetBrains Mono", "SF Mono", Consolas, "Fira Code", monospace`
- **Column Max Width (Chat)**: `max-w-4xl` (~896–960px)
- **Radii**: 4px (`--radius-sm`), 6px (`--radius`), 8px (`--radius-lg`), 9999px (pills)

---

## 5. Implementation Roadmap
1. Update `ui/src/index.css` with the complete Warm Engineering Workbench token set.
2. Refine `TopBar.tsx` and `Sidebar.tsx` with the new palette, refined brand mark, and responsive mobile nav.
3. Enhance `ChatPanel.tsx` with refined typography, prompt suggestion chips, live telemetry footer, and anchored composer.
4. Elevate `BackendsPanel.tsx` with intuitive visual layer distribution bars and buffer accounting.
5. Perfect `WorkersPanel.tsx` with explicit local hardware vs network RPC separation and ping indicators.
6. Upgrade `NodesPanel.tsx` with a lightweight, accessible CSS/SVG cluster topology diagram connecting Host to RPC Workers.
7. Streamline `SettingsPanel.tsx` with organized groups and quick-copy process commands.
8. Validate across viewports (320px, 375px, 390px, 430px, 768px, 1280px, 1440px) and run live inference query.

---

## 6. Runtime Data Architecture & Verified Semantics

Audited directly against live backend endpoints (`/health`, `/backends`, `/nodes`, `/metrics`):

### A. Verified Layer Allocation (Total: 37 Layers)
The active model `qwen2.5-3b-instruct-q4_k_m.official-check.gguf` has 37 model layers (0–36) distributed as:
- **`CPU` (Host In-Process)**: 33 layers &mdash; range `[0–32]`
- **`RPC0` (Loopback RPC Worker)**: 1 layer &mdash; range `[33]` (endpoint `127.0.0.1:50052`)
- **`CUDA0` (Host GPU Acceleration)**: 3 layers &mdash; range `[34–36]` (device `NVIDIA GeForce GTX 1050`, 4GB VRAM)
- **Total Assigned Layers**: `33 + 1 + 3 = 37 layers` (100% of model layers accounted for).

### B. Topological & Endpoint Clarifications
- **Coordinator HTTP Gateway**: `http://127.0.0.1:8080` (represented logically as `node-gateway-local` with port `0` for internal worker tracking).
- **RPC Worker Process**: `127.0.0.1:50052` (represented logically as `node-127.0.0.1-50052`).
- **Physical Host Integrity**: Both processes reside on the **same single physical computer** (`127.0.0.1`). There is no second physical computer in the local development environment.
- **Node Count vs Worker Count**:
  - **Logical Nodes**: 2 inventory records (`node-gateway-local` + `node-127.0.0.1-50052`).
  - **RPC Workers**: 1 network worker (`rpc-endpoint-0` on `127.0.0.1:50052`).
  - **Physical Machines**: 1 physical host (`Desktop-Host`).

### C. Host Memory Semantics
- Total Host RAM reported by `win32_GlobalMemoryStatusEx` is 7.84 GB total, with ~7.67 GB in use (~0.18 GB free) under local model and application load.
- Loopback memory deduplication note: `shared_host_memory_deduplicated` is active; reported host memories are not summed additively.
