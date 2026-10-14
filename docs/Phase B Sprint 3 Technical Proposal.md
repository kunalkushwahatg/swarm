# Swarm — Phase B Sprint 3 Technical Implementation Proposal (Revised)

**Workspace:** `C:\Users\kunal\OneDrive\Desktop\swarm`  
**Date:** October 12, 2026  
**Status:** Planning & Technical Contract Verification (Awaiting Explicit User Authorization)  
**Baseline Preserved:** `backups/milestone12-final-baseline-20261011/`  
**Official Model Preserved:** `models/qwen2.5-3b-instruct-q4_k_m.official-check.gguf` (2,104,932,768 bytes)

---

## 1. Executive Summary & Verification Verdict

This revised proposal verifies the telemetry contracts for Sprint 3:
- **B.4 — Generation Performance:** Exposing authoritative post-generation speed and timings, client-observed Time to First Content (TTFC), and an honest in-flight streaming state in Chat and Session.
- **B.6 — Tensor Buffer Composition Visualization:** Visualizing the internal byte composition (Model Weights vs KV Cache vs Compute Scratch) per processor in the Session view.

### Verification Verdict: Deliverable Without Backend Changes
- **C++ Contract Verification:** Genuinely verified. The existing coordinator in `main.cpp:1634-1646` already emits authoritative `timings` (`prompt_eval_ms`, `gen_ms`, `total_ms`, `tokens_generated`, `tokens_per_sec`) in the terminal chunk before `data: [DONE]`. This is captured and proven in validation logs (e.g., `artifacts/validation/2026-10-11/milestone-12/m12_inference_response.raw.txt`).
- **`/backends` Endpoint Verification:** Genuinely verified. The `/backends` endpoint in `main.cpp:1029-1041` and `placement.h:66-68` already exposes real `model_buffer_bytes`, `kv_buffer_bytes`, and `compute_buffer_bytes` per processor.
- **Feasibility:** **Both B.4 and B.6 can be completely delivered using existing frontend capabilities and APIs with zero modifications to C++ code.**

---

## 2. Telemetry Contract Verification (Item B.4)

### 2.1 The Actual SSE Stream Contract
Inspection of the coordinator source (`main.cpp`) and captured responses confirms the exact wire protocol:

1. **Content Chunks (In-Flight Stream):**
   `main.cpp:1579-1584` emits one chunk per sampled token piece:
   ```json
   data: {"choices":[{"delta":{"content":"..."}}],"id":1}
   ```
2. **Terminal Timings Chunk (Completion Ground Truth):**
   `main.cpp:1634-1646` emits the timing payload immediately before `data: [DONE]`:
   ```json
   data: {"choices":[{"delta":{}}],"id":1,"timings":{"gen_ms":8072.625,"prompt_eval_ms":6712.5476,"tokens_generated":26,"tokens_per_sec":3.220761524287329,"total_ms":14815.8315}}
   ```
3. **Stream Termination:**
   `main.cpp:1648`:
   ```
   data: [DONE]
   ```

### 2.2 Proof of Emitted Fields
Physical proof from Milestone 12 validation artifacts (`artifacts/validation/2026-10-11/milestone-12/m12_inference_response.raw.txt:53`):
```text
data: {"choices":[{"delta":{}}],"id":1,"timings":{"gen_ms":8072.625,"prompt_eval_ms":6712.5476,"tokens_generated":26,"tokens_per_sec":3.220761524287329,"total_ms":14815.8315}}
data: [DONE]
```

All 5 timing fields are active in the C++ engine:
- `tokens_generated`: Integer count of tokens sampled and emitted.
- `prompt_eval_ms`: Milliseconds spent evaluating the prompt batch (`llama_decode` for prompt).
- `gen_ms`: Milliseconds spent in the token generation loop.
- `total_ms`: Total inference duration from prompt start to last token.
- `tokens_per_sec`: Server-calculated rate: $\frac{\text{tokens\_generated}}{\text{gen\_ms} / 1000}$.

---

## 3. Corrected Live Generation Speed Strategy (Item B.4)

### 3.1 Limitations of Client-Side Piece Counting
In a web browser, SSE chunks carry text fragments (`llama_token_to_piece`), not discrete BPE tokenizer tokens. Furthermore, network packet coalescing and buffering mean that chunk receipt frequency does not correspond 1-to-1 with model forward passes.

Presenting an unverified chunk count as an exact token count during streaming is technically inaccurate. Therefore, Sprint 3 adopts an **honest, multi-tier measurement strategy**:

| Phase | Metric Displayed | Source of Data | Labeling & Semantics |
|---|---|---|---|
| **Pre-Response (Dispatch to Byte 1)** | `"Evaluating prompt…"` | Client timer $t_{\text{first\_content}} - t_{\text{dispatch}}$ | Informs the user that the coordinator is executing prefill. |
| **Active Streaming (Decoding)** | `"Streaming…"` (pulsing badge) | Active SSE stream state | Does not display fabricated intermediate token counts. Optionally displays an estimated chunk rate labeled explicitly as: `~X.X pieces/s (est)`. |
| **Stream Complete (Normal)** | `26 tok · 3.2 tok/s · 6.7s eval` | Authoritative C++ `timings` payload | Authoritative ground truth derived from C++ `std::chrono::steady_clock` and actual token count. |
| **User Cancelled ("Stop" clicked)** | `"Stopped · 4.2s elapsed"` | Client stream duration | Socket closed before terminal chunk; no server timings emitted. Omits token count and speed rather than inventing estimates. |
| **Inference Interrupted (Drop/Error)** | `"Interrupted · [error message]"` | Stream abort / HTTP error | Error state displayed clearly; no fake zero speeds shown. |
| **Zero-Token Output (Empty)** | `"0 tokens · N/A tok/s"` | C++ `tokens_generated == 0` | Avoids division by zero. |

### 3.2 Client-Observed Time to First Content (TTFC)
We define and display **Client-Observed Time to First Content (TTFC)**:
$$\text{TTFC} = t_{\text{first\_content\_byte}} - t_{\text{dispatch\_click}}$$
- Measured entirely client-side using `performance.now()`.
- Captures total end-to-end user perceived latency: HTTP request dispatch + coordinator queueing + tokenization + prompt prefill + network delivery.
- Clearly distinguished from the coordinator's internal `prompt_eval_ms`.

---

## 4. Tensor Buffer Composition Visualization (Item B.6)

### 4.1 Verification of `/backends` Telemetry
Inspection of `placement.h:66-70` and `main.cpp:1029-1041` confirms that `/backends` provides exact byte allocations for each backend:
- `model_buffer_bytes`: Memory allocated for static quantized model weights.
- `kv_buffer_bytes`: Memory allocated for key-value context cache.
- `compute_buffer_bytes`: Memory allocated for dynamic activation/compute scratch.
- `assigned_layers`: Integer layer array (e.g. `[0..32]`).

### 4.2 Strict Mathematical and Visual Principles
To prevent misleading visualizations, the buffer composition bar adheres to strict constraints:

1. **Self-Contained Denominator:**
   The proportion for each buffer component is calculated strictly against the sum of observed buffers for that specific processor:
   $$\text{Denominator} = \text{model\_buffer\_bytes} + \text{kv\_buffer\_bytes} + \text{compute\_buffer\_bytes}$$
   $$\text{Model \%} = \frac{\text{model\_buffer\_bytes}}{\text{Denominator}}, \quad \text{KV \%} = \frac{\text{kv\_buffer\_bytes}}{\text{Denominator}}, \quad \text{Compute \%} = \frac{\text{compute\_buffer\_bytes}}{\text{Denominator}}$$

2. **Explicit Labeling as Buffer Composition, NOT Total Memory Utilization:**
   - The bar is titled **"Tensor Buffer Composition (Observed)"**.
   - It represents how Swarm's tensor buffers are divided on that processor.
   - It is **not** labeled as total device VRAM or host RAM utilization. (Physical memory headroom is already tracked separately in the host memory gauge).

3. **Safe Handling of Zero or Missing Buffers:**
   - If a processor has zero allocated buffers ($\text{Denominator} = 0$), render a neutral empty track with an honest label: *"No local tensor buffers allocated"* (e.g. for pure routing/gateway nodes).
   - If a field is omitted or null, display *"Unmeasured"* rather than fabricating 0 bytes.

4. **Visual Separation from Layer Ratios:**
   - Layer counts (discrete integer layer assignment 0–36) remain visually separate in the **Placement Ribbon**.
   - Buffer bytes are displayed in the **Tensor Buffer Allocation Table** in `SessionPanel.tsx`.

5. **Preservation of Offline / Unverified State:**
   - When `isCoordinatorOffline` is true, the buffer bars are marked with a warning label:  
     *"Last known buffer composition — status unverified while offline"*.

---

## 5. Proposed File Changes & Scope Boundary

| File | Purpose |
|---|---|
| [useSwarm.ts](file:///C:/Users/kunal/OneDrive/Desktop/swarm/ui/src/hooks/useSwarm.ts) | Update `useChat` to track `tDispatch`, `tFirstContent`, expose `ttfcMs`, and store authoritative `timings` from the completed stream. |
| [useSwarmSession.ts](file:///C:/Users/kunal/OneDrive/Desktop/swarm/ui/src/hooks/useSwarmSession.ts) | Expose `latestInferenceTimings` so [SessionPanel.tsx](file:///C:/Users/kunal/OneDrive/Desktop/swarm/ui/src/components/SessionPanel.tsx) can display recent generation performance. |
| [ChatPanel.tsx](file:///C:/Users/kunal/OneDrive/Desktop/swarm/ui/src/components/ChatPanel.tsx) | Update sub-header badge to reflect active state (`Evaluating prompt…`, `Streaming…`); render authoritative completion pill on assistant messages (`tok`, `tok/s`, `eval ms`, `TTFC`). |
| [SessionPanel.tsx](file:///C:/Users/kunal/OneDrive/Desktop/swarm/ui/src/components/SessionPanel.tsx) | Add stacked tensor buffer composition mini-bars beneath processor rows; display recent generation performance in the performance card. |
| [index.css](file:///C:/Users/kunal/OneDrive/Desktop/swarm/ui/src/index.css) | Add styling tokens for segmented buffer composition bars (`.buffer-bar-track`, `.buffer-slice-model`, `.buffer-slice-kv`, `.buffer-slice-compute`). |

---

## 6. Implementation Order & Testing Plan

1. **Step 1 — Stream Telemetry Hook ([useSwarm.ts](file:///C:/Users/kunal/OneDrive/Desktop/swarm/ui/src/hooks/useSwarm.ts)):**
   - Record `tDispatch = performance.now()` on send.
   - Record `tFirstContent = performance.now()` on first chunk with non-empty content delta.
   - Capture C++ `timings` on terminal chunk; handle abort/cancellation cleanly without fabricating metrics.
2. **Step 2 — Chat View Display ([ChatPanel.tsx](file:///C:/Users/kunal/OneDrive/Desktop/swarm/ui/src/components/ChatPanel.tsx)):**
   - Update sub-header to show honest streaming status.
   - Render completed metrics pill on assistant messages.
3. **Step 3 — Buffer Composition Bars ([SessionPanel.tsx](file:///C:/Users/kunal/OneDrive/Desktop/swarm/ui/src/components/SessionPanel.tsx)):**
   - Add segmented horizontal mini-bars per processor row with semantic colors (Model = Accent Verdigris, KV = Amber, Compute = Slate).
   - Add table legend: `■ Model Weights  ■ KV Cache  ■ Compute Scratch`.
   - Implement zero-denominator safety and offline unverified badge.
4. **Step 4 — Session Runtime Performance Card:**
   - Surface the latest completed request's authoritative metrics in the Runtime Performance summary card.
5. **Step 5 — Validation:**
   - Execute `npm run lint` and `npm run build`.
   - Verify layout and accessibility across desktop (1280x800) and mobile (320px, 375px, 390px, 430px) viewports.

---

## 7. Recommendation

**B.4 and B.6 are 100% deliverable using existing backend contracts.** No modifications to C++ coordinator code, inference engine, RPC protocol, or local-development scripts are needed.

Awaiting explicit authorization before starting Sprint 3 implementation.
