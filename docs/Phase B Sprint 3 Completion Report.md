# Swarm — Phase B Sprint 3 Completion & Acceptance Report

**Status:** **ACCEPTED**  
**Date:** 2026-10-12  
**Scope:** Phase B Sprint 3 items **B.4** (Generation Performance) and **B.6** (Tensor-Buffer Composition Visualization)  
**Workspace:** `C:\Users\kunal\OneDrive\Desktop\swarm`

---

## 1. Executive Summary

Phase B Sprint 3 has been audited, verified, and accepted.
- **B.4 (Generation Performance):** Successfully reuses the authoritative terminal `timings` SSE event from `/v1/chat/completions` (`tokens_generated`, `prompt_eval_ms`, `gen_ms`, `total_ms`, `tokens_per_sec`). It validates all numeric fields before use, tracks client-observed Time to First Content (TTFC) separately from backend prompt ingestion, displays restrained in-flight state (`Evaluating prompt…` before first content; `Streaming…` after), and renders genuine metrics beneath assistant responses upon completion. Zero-token generations report `0 tokens · N/A tok/s`. Positive token counts with zero rates suppress misleading rates to `N/A tok/s`. Cancelled requests report `Generation stopped · authoritative timings unavailable`. The most recent completed inference metrics are preserved in `sessionStorage` and exposed in the Session panel with explicit single-request labeling.
- **B.6 (Tensor-Buffer Composition Visualization):** Correctly derives model weights, KV-cache, and compute scratch proportions per processor from `/backends` byte measurements. The Session panel renders a compact segmented horizontal bar labelled `Tensor Buffer Composition (Observed)` for each processor with accessible color tokens and clear numerical byte values. Empty allocations display `No tensor buffers allocated`. Unmeasured fields are explicitly labeled `Unmeasured`. Retained offline values display `Cached buffer allocations — status unverified while offline`. Tensor buffer allocations are explicitly distinguished from physical RAM and GPU VRAM usage.

---

## 2. Evidence Audit & Reconciliation

### 2.1 Reconciling TTFC Timing Measurements
During browser testing, the client dynamically measures Time to First Content ($\text{TTFC} = t_{\text{first\_chunk}} - t_{\text{dispatch}}$):
- **Chat Panel Screenshot:** [`sprint3_chat_completed_timings.png`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/artifacts/ui_screenshots/sprint3/sprint3_chat_completed_timings.png) shows:
  - Header: `26 tokens · 3.2 tok/s · 6.7 s prompt evaluation`
  - Sub-line: `Time to first content: 193 ms (client) · Generation: 8.07 s (backend) · Total: 14.82 s (backend)`
- **Session Panel Screenshot:** [`sprint3_session_inference_performance.png`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/artifacts/ui_screenshots/sprint3/sprint3_session_inference_performance.png) shows:
  - Generated Tokens: `26 tokens`
  - Generation Rate: `3.2 tok/s`
  - Prompt Evaluation: `6.71 s`
  - Time to First Content: `193 ms`
  - Generation Duration: `8.07 s`
  - Total Duration: `14.82 s`
- **Reconciliation Audit:** Both screenshots were captured from the exact same completed request execution. Both interfaces display the identical measured TTFC value (**193 ms**). An earlier draft of the report text referenced an illustrative fallback constant (`420 ms`) from mock fixture generator scaffolding; this has been corrected to the verified actual measured runtime value of **193 ms**.

### 2.2 Provenance of Buffer Measurements
In `/backends`, tensor allocations originate from the GGML memory buffer allocator and model tensor mapping. To prevent misleading users into believing buffer byte breakdowns are hardware OS measurements:
1. **API-Reported Buffer Allocation (`API-reported buffer allocation`):** Direct allocations returned by the coordinator when live.
2. **Log-Derived Allocations (`Log-derived (GGML engine)`):** CPU buffer allocations derived from backend tensor layer allocations during engine initialization (`log_derived: true`).
3. **Cached Offline Allocations (`Cached buffer allocations — status unverified while offline`):** Displayed when coordinator connection is lost, warning that cached allocations cannot be confirmed current.
4. **Physical Memory Usage (`Host Physical RAM (OS-reported via system telemetry)` and `Dedicated GPU VRAM (OS/Driver-reported hardware usage)`):** Kept in a dedicated section with explicit system/driver telemetry labels, isolated from GGML inference tensor allocations.

### 2.3 Mobile Usability & Accessibility (390px Viewport)
Audit of [`sprint3_mobile_session_buffer_composition.png`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/artifacts/ui_screenshots/sprint3/sprint3_mobile_session_buffer_composition.png):
- Processor rows use responsive card containers (`card-flat`) rather than fixed horizontal tables.
- Each processor card displays identity, layer count (`33 (L0–L32)`), and total measured buffers with responsive flex-wrapping.
- The segmented composition bar adapts smoothly to viewport width.
- The legend grid wraps into clean, legible lines with readable color dots and mono byte values.
- Zero horizontal scroll cutoffs, clipping, or obscured controls exist on mobile.

### 2.4 Metric Consistency & State Reset
The timing validation logic in [`validateTimings`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/ui/src/hooks/useSwarm.ts) and [`fmtTps`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/ui/src/lib/utils.ts) enforces strict semantic correctness:
- **Zero Tokens:** If `tokens_generated === 0`, `tokens_per_sec` is `undefined`, displaying `0 tokens · N/A tok/s`.
- **Positive Tokens with Zero/Invalid Rate:** If `tokens_generated > 0` but backend emits rate $\le 0$ or NaN, the rate is treated as inconsistent and rendered as `N/A tok/s`, never fabricating a misleading `0.0 tok/s`.
- **Cancellation:** If the user stops generation via the composer Stop button, `stopStreaming()` marks the message `Generation stopped · authoritative timings unavailable`. Zero tokens or rates are fabricated.
- **Missing Timing Events:** If the SSE stream completes without a `timings` event, the response is preserved with `Authoritative timings unavailable`.
- **Fresh Request State Reset:** Dispatched requests reset in-flight state immediately. Stale metrics from previous generations never leak to new responses.

---

## 3. Automated Test Results

### 3.1 Logic & Calculation Test Suite
Executed [`scripts/test_sprint3_logic.js`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/scripts/test_sprint3_logic.js) via Node.js:
```
=== Testing B.6: Tensor Buffer Composition ===
✔ Case 1 Passed: Standard measured values match expected percentages (CPU ~95.5% model, ~3.9% KV, ~0.6% compute)
✔ Case 2 Passed: GPU buffer proportions calculated correctly (CUDA0 ~49.0% model, ~0.3% KV, ~50.7% compute)
✔ Case 3 Passed: Zero denominator cleanly returns 'No tensor buffers allocated'
✔ Case 4 Passed: Unmeasured component marked unmeasured without inventing zero
✔ Case 5 Passed: All unmeasured returns 'Unmeasured' status

=== Testing B.4: Generation Timings Validation ===
✔ Case 6 Passed: Authoritative captured M12 timing event validated successfully
✔ Case 7 Passed: Zero-token response correctly sets tokens_per_sec to undefined (N/A)
✔ Case 8 Passed: Malformed, negative, NaN, and non-finite values treated as unavailable
✔ Case 9 Passed: Completely invalid payloads return null
✔ Case 10 Passed: Positive token count with zero rate cleanly suppresses rate to undefined (N/A)

All 10 logic and calculation tests passed!
```

### 3.2 Linter & Production Build
Executed from `ui/`:
```bash
npm run lint
# oxlint: Finished in 180ms on 22 files with 116 rules. (0 errors)

npm run build
# tsc -b && vite build:
# ✓ 1922 modules transformed.
# dist/index.html                   0.45 kB │ gzip:  0.28 kB
# dist/assets/index-DA1cFlr-.css   20.44 kB │ gzip:  5.06 kB
# dist/assets/index-EialOGPP.js   327.84 kB │ gzip: 93.85 kB
# ✓ built in 1.19s (0 errors)
```

---

## 4. Archived Verification Artifacts

All screenshots are stored under `artifacts/ui_screenshots/sprint3/`:

| Artifact | File Path | Verified Visual Elements |
| :--- | :--- | :--- |
| **Chat Completed Metrics** | [`artifacts/ui_screenshots/sprint3/sprint3_chat_completed_timings.png`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/artifacts/ui_screenshots/sprint3/sprint3_chat_completed_timings.png) | `26 tokens · 3.2 tok/s · 6.7 s prompt evaluation`, TTFC 193 ms, Gen 8.07 s, Total 14.82 s |
| **Session Buffer Composition** | [`artifacts/ui_screenshots/sprint3/sprint3_session_buffer_composition.png`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/artifacts/ui_screenshots/sprint3/sprint3_session_buffer_composition.png) | `Tensor Buffer Composition (Observed)` segmented bars, accessible legend, exact bytes |
| **Session Latest Inference** | [`artifacts/ui_screenshots/sprint3/sprint3_session_inference_performance.png`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/artifacts/ui_screenshots/sprint3/sprint3_session_inference_performance.png) | 6-card compact performance grid, single-request disclaimer |
| **Zero Tokens Case** | [`artifacts/ui_screenshots/sprint3/sprint3_edge_case_zero_tokens.png`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/artifacts/ui_screenshots/sprint3/sprint3_edge_case_zero_tokens.png) | Displays `0 tokens · N/A tok/s · 0.1 s prompt evaluation` |
| **Missing Timings Case** | [`artifacts/ui_screenshots/sprint3/sprint3_edge_case_missing_timings.png`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/artifacts/ui_screenshots/sprint3/sprint3_edge_case_missing_timings.png) | Displays `Authoritative timings unavailable` |
| **Zero Buffers Case** | [`artifacts/ui_screenshots/sprint3/sprint3_edge_case_zero_buffers.png`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/artifacts/ui_screenshots/sprint3/sprint3_edge_case_zero_buffers.png) | Empty track with `No tensor buffers allocated` |
| **Coordinator Offline Case** | [`artifacts/ui_screenshots/sprint3/sprint3_edge_case_offline_status.png`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/artifacts/ui_screenshots/sprint3/sprint3_edge_case_offline_status.png) | Badge: `Cached buffer allocations — status unverified while offline` |
| **Cancellation Case** | [`artifacts/ui_screenshots/sprint3/sprint3_edge_case_cancellation.png`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/artifacts/ui_screenshots/sprint3/sprint3_edge_case_cancellation.png) | Displays `Generation stopped · authoritative timings unavailable` |
| **Fresh Request Reset** | [`artifacts/ui_screenshots/sprint3/sprint3_edge_case_fresh_request.png`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/artifacts/ui_screenshots/sprint3/sprint3_edge_case_fresh_request.png) | Successive request executes cleanly without stale timing bleed |
| **Mobile Layout (390px)** | [`artifacts/ui_screenshots/sprint3/sprint3_mobile_session_buffer_composition.png`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/artifacts/ui_screenshots/sprint3/sprint3_mobile_session_buffer_composition.png) | Responsive wrapping of processor cards, bars, and legends |

---

## 5. Scope Safeguards & Baseline Preservation

- **Milestone 12 & C++ Coordinator Preserved:** No C++ source files or GGML RPC protocols were modified.
- **Model Baseline Preserved:** Official model weights and baseline configurations remain untouched.
- **Storage Scope Preserved:** No conversation history database or IndexedDB introduced; session metrics persist strictly via browser `sessionStorage`.
- **Sprint Boundaries:** Implementation limited strictly to B.4 and B.6. No unapproved roadmap features commenced.

**Sprint 3 Final Decision: ACCEPTED**
