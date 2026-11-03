# Swarm Desktop — UI/UX Specification: Warm Light & Forest-Green Identity

**Target Audience:** UI/UX Engineers, Product Designers, and Frontend Developers  
**Platform:** Tauri 2 (Windows x64 WebView2), React 18, Warm Light & Forest-Green Design Tokens  
**Date:** 2026-10-15  
**Version Evaluated:** Swarm Desktop v0.1.0 (Visual Refinement Pass)  
**Status:** **WARM LIGHT & FOREST-GREEN IDENTITY RESTORED — ALL 18 UX DEFECTS RESOLVED**

---

## Executive Summary

Swarm Desktop has completed a focused, application-wide visual refinement pass. The design restores Swarm's signature **warm light and forest-green** visual identity while preserving 100% of the improved information architecture, state synchronization, navigation, device topology, and Compute Allocation capabilities.

The interface eliminates the generic, template-driven dark aesthetic in favor of a bespoke, natural, paper-and-ink workstation theme (`#F4F5F0` warm canvas, `#FFFFFF` crisp surfaces, `#F0F2EC` recessed wells, `#DDE2D8` hairline borders, `#202821` graphite ink, and `#1B5E49` authoritative forest-green accents).

```mermaid
graph TD
    A["Legacy State: Diagnostic Console & Mismatched Light Shell"] -->|UX & State Correction| B["Single Source of Truth & Authoritative Lifecycle"]
    B -->|Visual Refinement Pass| C["Warm Light & Forest-Green Identity System"]
    C --> D["Swarm Desktop: Bespoke Native Distributed AI Workstation"]
```

---

## 1. Design System Tokens: Warm Light & Forest-Green

### A. Core Palette Tokens

| Token Name | Value | Purpose | Contrast Ratio |
|---|---|---|---|
| `--color-bg` | `#F4F5F0` | Warm off-white canvas / page background | Base |
| `--color-surface` | `#FFFFFF` | Clean raised panel surface, cards, modals | Elevated |
| `--color-surface-subtle` | `#F0F2EC` | Recessed wells, inputs, secondary strips | Subtle recess |
| `--color-surface-sunken` | `#EAECE4` | User message bubbles, code blocks | Sunken recess |
| `--color-border` | `#DDE2D8` | Hairline card borders, row dividers | Crisp separation |
| `--color-border-strong` | `#C7CEBF` | Structural outlines, ghost button borders | Structural |
| `--color-text` | `#202821` | Primary graphite ink typography | ~15.5:1 on surface |
| `--color-text-2` | `#66716A` | Secondary technical copy and subtitles | ~5.8:1 on surface |
| `--color-text-3` | `#818A83` | Subdued metadata, captions, inactive labels | ~3.8:1 on surface |
| `--color-accent` | `#1B5E49` | Primary action button, active navigation | Forest green |
| `--color-accent-fg` | `#FFFFFF` | Text on primary forest green buttons | 7.8:1 on accent |
| `--color-accent-hover` | `#144A39` | Hover state for primary buttons | Deep forest |
| `--color-accent-subtle` | `#E3ECE7` | Selected navigation background, sage tint | Soft sage |

### B. Hardware & Backend Identities

| Identity | Token | Value | Tint Background | Usage |
|---|---|---|---|---|
| **CUDA GPU** | `--color-cuda` | `#355E9E` | `#EBF2FC` | NVIDIA GPU VRAM, CUDA device cards, split bar |
| **RPC Worker** | `--color-rpc` | `#1F6F66` | `#E3EFEC` | GGML RPC workers, network endpoints, split bar |
| **Neutral Gauge** | `--color-graphite-fill`| `#66716A` | `#F0F2EC` | Hardware RAM meters, neutral capacity |
| **Reserve Tick** | `--color-warn` | `#9A6700` | `#F7EEDC` | Safety reserve headroom markers |

### C. Semantic States

| State | Color Token | Value | Background Token | Value | Indicator |
|---|---|---|---|---|---|
| **Healthy / Ready** | `--color-ok` | `#1E7E59` | `--color-ok-bg` | `#EAF4EE` | Quiet emerald ink dot |
| **Warning / Attention** | `--color-warn` | `#9A6700` | `--color-warn-bg` | `#F7EEDC` | Brass amber dot / banner |
| **Error / Destructive** | `--color-error` | `#B91C1C` | `--color-error-bg` | `#F9E7E4` | Brick red dot / stop action |
| **Idle / Standby** | `--color-idle` | `#818A83` | `--color-idle-bg` | `#F0F2EC` | Muted graphite dot |

---

## 2. Component-by-Component Live Visual Verification

### A. Chat View — Calm Standby State

![Chat View Standby](ux_screenshots/01_chat_view_empty.png)

- **Surface Harmony**: Warm off-white background (`#F4F5F0`) with a white reading card (`#FFFFFF`) framed by hairline borders (`#DDE2D8`).
- **Standby Hero**: Centered standby card with clean typography, model metadata badges, and a prominent forest green `[▶ Start Engine]` button.
- **TopBar Control**: Authoritative status pill (`Standby`), model details (`Qwen 2.5 3B · 2,048 ctx`), profile badge (`Cluster`), and single-click start button.

---

### B. Chat View — Active Composer & Dynamic Token Counter

![Chat View Active](ux_screenshots/02_chat_view_active.png)

- **Editable Composer**: Textarea remains interactive even in standby; user prompts are never blocked.
- **Dynamic Token Count**: Live token estimation (`~21 est. tokens / 2,048 ctx`) updates in real time as the user types.
- **Prompt Safety**: Pressing Send when stopped safely launches the supervisor engine and queues the prompt without text loss.

---

### C. Devices & Cluster Topology View

![Devices View](ux_screenshots/03_devices_view.png)

- **Unified Cluster Cards**: White cards with graphite typography and subtle sage accents.
- **Removed Redundant Sidebar**: Duplicate right-hand inspection drawer completely eliminated.
- **Truthful Locality**: Loopback RPC worker (`127.0.0.1:50052`) clearly labeled as *Local RPC Worker (Shares Host RAM)* rather than a remote computer.
- **Primary Action**: Single `[Compute Allocation]` button in authoritative forest green.

---

### D. Device Onboarding (5-Step Guided Modal)

![Device Onboarding Modal](ux_screenshots/04_device_onboarding_modal.png)

- **Light Modal Theme**: White modal surface with warm backdrop (`rgba(28, 36, 30, 0.5)`), soft shadow (`0 20px 50px rgba(0,0,0,0.14)`).
- **5-Step Stepper**: Visual progress indicator highlighting completed steps in forest green.
- **Network Security Guidance**: Clear callout regarding unencrypted TCP traffic on trusted home/office networks.

---

### E. Compute Allocation — Automatic Mode

![Compute Allocation Automatic](ux_screenshots/05_compute_allocation_automatic.png)

- **Full Light-Theme Alignment**: Modal matches the rest of Swarm—no dark cyberpunk islands.
- **Proportional Tensor Split Bar**: Coordinated slate-blue (CUDA) and muted teal (RPC) proportional distribution.
- **Derived Model Layers**: Exact `37 / 37` layer capacity dynamically derived from active model metadata.
- **Collapsed Architectural Math**: Derivation formulas neatly tucked into an expandable `ℹ Architecture & Calibration` card.

---

### F. Compute Allocation — Manual Mode

![Compute Allocation Manual](ux_screenshots/06_compute_allocation_manual.png)

- **Per-Device Budget Controls**: Dedicated sliders and split weights for eligible participating backends.
- **Lock Controls**: Checkbox allowing users to lock specific device splits while adjusting others.
- **No Footer Clipping**: Bounded modal height with internal scrollable regions ensures buttons and sliders are never clipped on 1280×720 laptop screens.

---

### G. Compute Allocation — Confirmed Runtime View

![Compute Allocation Runtime](ux_screenshots/07_compute_allocation_runtime.png)

- **Height-Stable Display**: Preserves identical modal dimensions when toggling between Proposed, Saved, and Runtime views.
- **Truthful Standby Reporting**: Calm `Native Inference Engine Stopped` notification explaining that live placements require engine loading.

---

### H. Session & Telemetry View

![Session View](ux_screenshots/08_session_topology_view.png)

- **Symmetric Memory Gauges**: Balanced progress meters for Host RAM and NVIDIA GPU VRAM with utilized, free, and total values.
- **Dynamic Placement Rationale**: Copy generated dynamically from actual active splits rather than stale static text.
- **Clean Empty States**: Meaningful placeholders when inference metrics are not yet observed.

---

### I. Settings & Runtime Configuration

![Settings View](ux_screenshots/09_settings_lifecycle_view.png)

- **Resolved Model/Context Mismatch**: Synchronized to authoritative `Qwen 2.5 3B` and `2,048 ctx` instead of stale `0.5B / 512` values.
- **Supported Context Dropdown**: Validated options (`512`, `1,024`, `2,048`, `4,096`, `8,192`) with memory explanations.
- **Active vs. Staged Tagging**: Explicit badges indicating `[CURRENTLY ACTIVE]` vs. `[SELECT FOR NEXT LAUNCH]`.

---

## 3. Verification & Compliance Checklist

| Check | Tool / Command | Result |
|---|---|---|
| **Frontend TypeScript & Bundle** | `npm run build` | **PASSED** (0 errors, 408 kB JS, 21 kB CSS) |
| **Rust / Tauri App Compilation** | `cargo build` | **PASSED** (0 errors, debug/app.exe linked) |
| **Backend Allocation Regression** | `cargo run --bin allocation_integration_test` | **PASSED** (Real C++ 16-layer shift verified) |
| **Live Desktop App Inspection** | Tauri 2 WebView2 CDP on port 9222 | **PASSED** (All views verified live) |
| **Responsive Viewport Check** | 1280×720 and 1440×900 automated check | **PASSED** (0 horizontal overflow) |
| **All 9 Screenshots Captured** | Automated CDP capture harness | **PASSED** (All 9 saved in `ux_screenshots/`) |
| **Clean Environment State** | `Get-Process` & `Get-NetTCPConnection` | **PASSED** (No orphan processes, ports 8080/50052 free) |
