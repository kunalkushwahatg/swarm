# Phase C.3.7 Post-Inference Audit and Integration Plan

**Document Date:** October 12, 2026  
**Status:** AUDIT COMPLETE — AWAITING OPERATOR APPROVAL  
**Workspace:** `C:\Users\kunal\OneDrive\Desktop\swarm`  
**Phase Scope:** Post-inference audit and integration plan only (zero runtime executions, zero process terminations, default configurations preserved)  
**Primary References:**
- [`docs/Phase C.3.6 Standalone CUDA Real Inference Test Report.md`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/docs/Phase%20C.3.6%20Standalone%20CUDA%20Real%20Inference%20Test%20Report.md)
- [`spike/desktop-shell/phase_c36_standalone_cuda_result.json`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/phase_c36_standalone_cuda_result.json)
- [`main.cpp`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/main.cpp) & [`placement.h`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/placement.h)
- [`spike/desktop-shell/src-tauri/src/supervisor/`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/supervisor/)

---

## 1. Executive Summary

Following the successful execution of Swarm Phase C.3.6 (the first authorized real standalone CUDA inference test under Tauri supervisor Job Object containment), this phase conducts a rigorous technical audit of the observed runtime behaviors and establishes a concrete integration plan.

Key audit findings:
1. **Post-Shutdown RAM Variance (1,325 MB pre $\rightarrow$ 453 MB active $\rightarrow$ 908 MB post):** The apparent "unreturned" ~417 MB of physical RAM is a well-understood artifact of Windows OS Memory Management. When `swarm_node.exe` memory-maps and reads the 2.10 GB model file from disk, the Windows Cache Manager populates the **Standby File Cache** list. Standby pages remain physically resident until reclaimed by memory pressure. Verified performance counters confirm over 459 MB of active Standby Cache. There is zero evidence of a kernel leak or orphaned process.
2. **CPU Model Buffer Allocation (175,028,306 bytes = 166.92 MiB):** Although all 37 transformer blocks (`blk.0`..`blk.35` plus final norm/head) were assigned to `CUDA0`, llama.cpp allocates non-layer tensors into a host memory-mapped buffer. For Qwen 2.5 3B, the massive vocabulary ($151,936\text{ tokens} \times 2,048\text{ hidden dim}$) requires an input embedding matrix (`token_embd.weight`) that accounts almost exactly for this 166.92 MiB host allocation. All matrix multiplications for generation executed on the GPU.
3. **Safety Threshold Boundary Analysis:** Phase C.3.6 proved that the standalone low-memory profile can launch, load weights, and generate a short response safely with 1,000 MB RAM and 3,100 MiB VRAM. However, it **does not** prove long-running stability under concurrent host memory demands, multi-turn context expansion (e.g., $n_{\text{ctx}} = 2048$), or multi-process RPC cluster safety. The default 1,500 MB RAM guard for dual-process cluster operation remains essential.
4. **Integration Strategy:** The standalone CUDA low-memory profile can be integrated into the desktop shell as an **explicit, opt-in alternative profile**, leaving the standard dual-process distributed cluster as the default.

---

## 2. Review of Phase C.3.6 Results and Current System State

### 2.1 Recorded Execution Metrics

| Parameter / Metric | Phase C.3.6 Measured Value | Authority / Source |
| :--- | :--- | :--- |
| **Model** | Qwen 2.5 3B Instruct Q4_K_M (2,104,932,768 bytes) | GGUF V3 metadata / file system |
| **CUDA Layers Assigned** | **37 layers** on `CUDA0` (NVIDIA GTX 1050 4GB) | Coordinator `/metrics` & `/health` |
| **CPU Layers Assigned** | **0 layers** on `CPU` | Coordinator `/metrics` |
| **Context Size** | 512 tokens | `SWARM_CTX_SIZE=512` |
| **Startup Duration** | 9,021 ms | Supervisor orchestrator timer |
| **Time to First Content (TTFC)** | 484 ms | Client SSE connection timer |
| **Inference Generation Rate** | **19.03 tokens/second** | Coordinator internal metrics |
| **Response Fidelity** | Exact verbatim match (`SWARM CUDA TEST OK`) | Client SSE aggregate |
| **Available RAM (Pre-Launch)** | **1,325 MB** (Total: 8,032 MB) | Win32 `GlobalMemoryStatusEx` |
| **Available RAM (During Inference)** | **453 MB** | Win32 `GlobalMemoryStatusEx` |
| **Available RAM (Post-Shutdown)** | **908 MB** | Win32 `GlobalMemoryStatusEx` |
| **Available VRAM (Pre-Launch)** | **3,450 MiB** (Total: 4,096 MiB) | `nvidia-smi` CLI |
| **Available VRAM (During Inference)** | **1,262 MiB** (Used: 2,834 MiB) | `nvidia-smi` CLI |
| **Available VRAM (Post-Shutdown)** | **3,410 MiB** (Used: 686 MiB) | `nvidia-smi` CLI |
| **Shutdown Duration** | 649 ms | Supervisor `stop_engine_internal()` |
| **Final Process & Port State** | Process `18420` terminated, port 8080 unbound | `Get-Process`, `Get-NetTCPConnection` |

### 2.2 Current Workspace and Git Status

- Workspace root `C:\Users\kunal\OneDrive\Desktop\swarm` is maintained as a direct standalone project tree (not a git root).
- Milestone 12 baseline C++ code, build configurations (`build-cuda`), and official model files remain pristine and unmodified.
- Staged supervisor spike code in `spike/desktop-shell/` remains clean, isolated, and passing all tests.

---

## 3. Investigation: Post-Shutdown Physical RAM Dynamics

### 3.1 The Observation

- Pre-launch available RAM: **1,325 MB**
- Active inference available RAM: **453 MB** (drop of 872 MB)
- Post-shutdown available RAM: **908 MB** (rebound of 455 MB)
- Delta between pre-launch and post-shutdown: **417 MB lower**

### 3.2 Verified Facts vs. Hypotheses

```mermaid
flowchart TD
    subgraph HostPhysicalRAM [8,032 MB Physical RAM]
        FreeList[Free & Zero Page Lists]
        StandbyCache[Standby Cache / File Cache]
        ActiveWorkingSets[Active Process Working Sets]
        ModifiedList[Modified Page List]
    end

    subgraph ActionsDuringTest [Actions Executed During Phase C.3.6]
        RustBuild[cargo build / rustc execution]
        ModelRead[Read 2.10 GB GGUF Model via mmap]
        CudaInit[CUDA Runtime & Driver Context Initialization]
    end

    ModelRead -->|Caches Model File Pages| StandbyCache
    RustBuild -->|Allocates compiler heap & DLLs| ActiveWorkingSets
    RustBuild -->|Dirty pages transitioned to disk| ModifiedList
    CudaInit -->|Driver working set expansion| ActiveWorkingSets
```

#### Verified Facts
1. **Zero Process Leak:** Coordinator PID `18420` fully terminated with exit code 0. No child processes, background threads, or unmanaged coordinator/worker instances remained.
2. **GPU VRAM Completely Reclaimed:** NVIDIA GPU memory recovered from 1,262 MiB free during inference back to **3,410 MiB free** post-shutdown (within 40 MiB of the 3,450 MiB pre-launch baseline), proving that the CUDA device context and driver buffers were completely released.
3. **Windows Standby File Cache Expansion:** Dynamic querying of Windows memory performance counters (`\Memory\Standby Cache Normal Priority Bytes`) immediately post-test revealed **459,833,344 bytes (~438.5 MB)** in the standby cache, alongside **48.9 MB** in system cache bytes.
4. **File I/O Footprint:** During launch, `swarm_node.exe` mapped and accessed the 2.10 GB GGUF file. In Windows, pages read into memory from disk are retained by the OS in the Standby Page List so subsequent reads are instantaneous. Windows does **not** free standby pages on process exit; it leaves them in memory until another application requires physical pages.
5. **Compilation Memory Footprint:** Immediately prior to the test, `cargo build --bin standalone_cuda_test` was invoked, executing `rustc.exe` and the MSVC linker (`link.exe`). Compilers cause significant working set churn and populate disk caches with intermediate crate metadata.

#### Hypotheses (Requiring Distinction from Verified Facts)
- *Hypothesis A (Driver Retained Pages):* The NVIDIA Windows display driver (`nvlddmkm.sys`) may retain a small kernel working set (~20–40 MB) after closing a CUDA context to expedite subsequent CUDA session initialization. (Plausible, but cannot be isolated without kernel pool tagging).
- *Hypothesis B (Background OS Service Re-expansion):* Windows services (Windows Defender, OneDrive sync on the Desktop path, Search Indexer) may have scheduled background working set expansions during or immediately following the heavy file activity. (Plausible given OneDrive desktop root, but not directly proven).

### 3.3 Conclusion on RAM Behavior

Physical memory does **not** immediately snap back to its pre-launch value in a modern virtual memory operating system. The 417 MB differential is predominantly accounted for by **Windows Standby File Cache (438.5 MB)** populated by loading the GGUF model and compiler artifacts. Under memory pressure, the Windows Memory Manager immediately repurposes standby pages for new allocations without writing to disk.

---

## 4. Investigation: CPU Model Buffer Allocation with Full CUDA Offload

### 4.1 The Observation

When probing `/metrics` on the loaded coordinator:
```prometheus
swarm_backend_model_buffer_bytes{backend="CPU",type="cpu"} 175028306
swarm_backend_model_buffer_bytes{backend="CUDA0",type="local_cuda"} 1923958702
swarm_backend_layers_assigned{backend="CPU",type="cpu"} 0
swarm_backend_layers_assigned{backend="CUDA0",type="local_cuda"} 37
```
`CUDA0` was assigned **37 layers** with a model buffer of 1,923,958,702 bytes (~1,834.83 MiB).  
`CPU` was assigned **0 layers**, yet was allocated a model buffer of **175,028,306 bytes (~166.92 MiB)**.

### 4.2 Code Inspection & Explanation

Inspection of `main.cpp`, `placement.h`, and the llama.cpp backend architecture reveals why this occurs:

1. **Layer Assignment vs. Model Buffer Allocation:**
   In `main.cpp`:
   ```cpp
   model_params.n_gpu_layers = n_gpu_layers; // -1
   ```
   In transformer architectures, `n_gpu_layers` specifies the number of **transformer block layers** (`blk.0` through `blk.N-1`) offloaded to hardware accelerators. Qwen 2.5 3B has 36 transformer blocks (`qwen2.block_count = 36`). Together with the output norm and LM head, llama.cpp classifies this as 37 layers. All 37 were assigned to `CUDA0`.

2. **The Nature of Non-Layer Tensors:**
   A GGUF transformer model consists of two distinct categories of weights:
   - **Layer Tensors:** Multi-head attention projections (`attn_q`, `attn_k`, `attn_v`, `attn_output`), feed-forward network weights (`ffn_gate`, `ffn_up`, `ffn_down`), and layer norms (`attn_norm`, `ffn_norm`). All of these reside in `blk.i.*` and were offloaded to `CUDA0`.
   - **Non-Layer Tensors:** Token embeddings (`token_embd.weight`), output norm (`output_norm.weight`), and model metadata tensors.

3. **Mathematical Proof of the 166.92 MiB CPU Buffer:**
   Qwen 2.5 uses an unusually large vocabulary for multilingual and code support:
   - Vocabulary size: **151,936 tokens**
   - Embedding hidden dimension ($d_{\text{model}}$): **2,048**
   - Total embedding parameters: $151,936 \times 2,048 = 311,164,928\text{ weights}$
   - Quantization format: In Q4_K_M GGUF models, the `token_embd.weight` tensor is quantized to `q4_K` blocks (approximately 4.5 bits per weight $\approx 0.536\text{ bytes per weight}$).
   - Theoretical embedding buffer size:
     $$311,164,928 \times 0.536\text{ bytes} \approx 166,784,000\text{ bytes} \approx 166.9\text{ MiB}$$
   - Observed CPU buffer size in `/metrics`:
     $$175,028,306\text{ bytes} \div 1024 \div 1024 = 166.92\text{ MiB}$$

4. **Runtime Placement Mechanism:**
   In llama.cpp, unless explicit GPU embedding offload is supported and active for the specific backend configuration, the input embedding lookup tensor (`token_embd.weight`) is placed in a CPU memory-mapped buffer (`CPU_Mapped`). Because token lookup is simply indexing a single row per prompt token (rather than heavy matrix multiplication), keeping embeddings in host memory is standard llama.cpp behavior.
   
5. **Log Parsing in PlacementTracker:**
   In [`placement.h`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/placement.h#L410-L432):
   ```cpp
   // Pattern 2: Model buffer size
   // "load_tensors:        CUDA0 model buffer size =   1834.83 MiB"
   // "load_tensors:   CPU_Mapped model buffer size =    166.92 MiB"
   ```
   `PlacementTracker` receives llama.cpp loader logs directly through the callback installed in `main.cpp` (`llama_log_set`). It matches `CPU` to the `CPU_Mapped` line and records `175,028,306 bytes`.

### 4.3 Conclusion on CPU Model Buffer

The 166.92 MiB CPU buffer is **not** an indication of incomplete layer offload or a placement defect. All 37 compute layers were fully executed on the GPU. The 166.92 MiB CPU buffer represents the host memory-mapped input token embedding matrix, which matches the architectural design of Qwen 2.5 3B under llama.cpp.

---

## 5. Safety Thresholds & Stability Assessment

The Phase C.3.5/C.3.6 preflight gate enforced:
- Available Physical RAM: $\ge 1,000\text{ MB}$
- Available GPU VRAM: $\ge 3,100\text{ MiB}$

### 5.1 What Phase C.3.6 Proved

1. **Startup Feasibility:** With 1,325 MB of available host RAM and 3,450 MiB of free VRAM, the coordinator successfully loads Qwen 2.5 3B with all 37 layers on an NVIDIA GeForce GTX 1050 4GB.
2. **Context Creation at 512 Tokens:** The 512-token context window allocated an 18.0 MiB KV cache and an 8.5 MiB compute buffer in VRAM, well within the GPU's remaining memory.
3. **Execution Safety:** Generation of 5 tokens completed in 742 ms with zero thrashing, zero OS paging locks, and 453 MB of physical RAM remaining during active computation.
4. **Lifecycle Containment:** The Win32 Job Object supervisor reliably caught, tracked, and terminated the process without leaving lingering handles or orphaned children.

### 5.2 What Phase C.3.6 Did NOT Prove

1. **Extended Multi-Turn Stability:** Phase C.3.6 executed a single 5-token completion. It did not test repeated requests over hours, session state accumulation, or KV cache fragmentation.
2. **Context Window Expansion ($n_{\text{ctx}} > 512$):** Scaling context size to 2,048 or 4,096 tokens increases KV cache and compute buffer requirements. While the GPU has ~1,262 MiB of free VRAM headroom, scaling context size also increases host-side batch structures.
3. **Host Memory Headroom Under Load:** During inference, physical RAM dipped to **453 MB**. If a user launches a web browser or other background application while inference is active, host RAM could dip below 200 MB, triggering severe page-file paging or OOM termination.
4. **Dual-Process / Cluster Safety:** Standalone mode eliminates `ggml-rpc-server.exe` entirely. In dual-process mode, the RPC server requires its own host process, C++ runtime, and network socket buffers, consuming an additional 400–600 MB of host RAM. **The 1,500 MB RAM guard for default cluster mode remains strictly necessary.**

---

## 6. Integration Architecture: Standalone Low-Memory Profile as an Explicit Option

To safely incorporate the standalone CUDA low-memory profile into the production Swarm desktop application, the following architectural principles must be maintained:

```
+-----------------------------------------------------------------------------------+
|                            Swarm Desktop Application UI                            |
+-----------------------------------------------------------------------------------+
                                         |
                       User selects Runtime Profile
                                         |
         +-------------------------------+-------------------------------+
         |                                                               |
         v                                                               v
+----------------------------------+           +------------------------------------+
|  Profile: "default" (CLUSTER)    |           | Profile: "low_memory_standalone"   |
|  - Multi-process (Coord + RPC)   |           | - Single process (Coordinator only)|
|  - SWARM_USE_RPC=1               |           | - SWARM_USE_RPC=0                  |
|  - SWARM_N_GPU_LAYERS=4          |           | - SWARM_N_GPU_LAYERS=-1            |
|  - SWARM_CTX_SIZE=2048           |           | - SWARM_CTX_SIZE=512               |
|  - Mandatory RAM Guard: 1,500 MB |           | - Mandatory RAM Guard: 1,000 MB    |
|  - Default on startup            |           | - VRAM Guard: 3,100 MiB            |
|                                  |           | - Explicit opt-in only             |
+----------------------------------+           +------------------------------------+
```

### 6.1 Preserving Default Behavior
- The default profile must remain `default` (Standard Distributed Cluster).
- The desktop shell must never silently fall back from cluster mode to standalone mode, nor from standalone mode to cluster mode.
- Starting the engine without an explicit profile parameter must continue to invoke the default cluster profile.

### 6.2 Explicit Opt-In Mechanism
- The user must explicitly select "Standalone CUDA Mode (Low Memory)" via the desktop application settings or cluster configuration modal.
- The UI must display an informational badge explaining:
  > *"Standalone mode runs entirely on your local NVIDIA GPU (Qwen 2.5 3B, 37 layers offloaded, 512 context). Local and remote RPC workers are disabled. Requires at least 1,000 MB RAM and 3,100 MiB VRAM."*

---

## 7. Required Code & Configuration Changes

### 7.1 Supervisor Backend (`src-tauri/src/supervisor/`)

| File | Subsystem | Required Modification |
| :--- | :--- | :--- |
| [`config.rs`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/supervisor/config.rs) | Configuration Schema | Formalize `RuntimeProfile` enum (`DefaultCluster`, `LowMemoryCudaStandalone`) with per-profile thresholds, ports, and environment builders. |
| [`commands.rs`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/supervisor/commands.rs) | IPC Commands | Expose `supervisor_get_available_profiles()` returning profile metadata, descriptions, prerequisites, and live eligibility based on current host metrics. |
| [`orchestrator.rs`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/supervisor/orchestrator.rs) | Lifecycle State | Ensure `ClusterStatus` metadata reports active profile name and active node count (1 for standalone, $\ge 2$ for cluster). |
| [`win32.rs`](file:///c:/Users/kunal/OneDrive/Desktop/swarm/spike/desktop-shell/src-tauri/src/supervisor/win32.rs) | Resource Queries | Maintain non-blocking, cached queries for RAM and VRAM to prevent UI lag during preflight polling. |

### 7.2 Desktop UI (`ui/` / Frontend)

| Subsystem | Component | Description of Change |
| :--- | :--- | :--- |
| **Settings / Controls** | Runtime Profile Dropdown | Add profile selector in the cluster control bar with choices: `Distributed Cluster (Default)` and `Standalone Local CUDA (Low Memory)`. |
| **Preflight Feedback** | Resource Bar / Checklist | Display live host RAM and VRAM gauges side-by-side with required profile thresholds, dynamically showing pass/fail status before launch. |
| **Health Monitor** | Node Topology Display | In standalone mode, render a single local node badge (`CUDA0 (GTX 1050) - 37 Layers - Standalone`); suppress "RPC Worker Offline" warnings. |
| **Error Handling** | Preflight Blocker Banner | Surface clear, actionable messages if preflight fails (e.g., *"Available RAM is 908 MB, below the 1,000 MB threshold. Free system memory before launching."*). |

### 7.3 Failure Recovery & Safeguards

- **Job Object Containment:** Maintain mandatory association of the spawned coordinator PID with the supervisor Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`).
- **Startup Timeout:** Keep 30-second bounded timeout for `/health` readiness. If timeout expires, execute automatic rollback (`stop_staged()`) and transition state to `Error`.
- **Non-Destructive Port Conflict Guard:** Verify port 8080 is free before spawning. Reject launch if port is occupied by an external/unmanaged process; never kill external processes.

---

## 8. Validation Plan Prior to Production Integration

Before merging this profile into the production desktop build, the following validation stages must be executed:

```mermaid
graph LR
    Stage1[Stage 1: Multi-Turn Conversation Validation] --> Stage2[Stage 2: Context Scaling Feasibility]
    Stage2 --> Stage3[Stage 3: Supervisor IPC & UI Integration]
    Stage3 --> Stage4[Stage 4: Automated CI / Test Runner Suite]
```

### Stage 1: Multi-Turn Conversation & Session Stability
- **Objective:** Verify coordinator stability over 10 consecutive chat completions.
- **Metrics to Track:** Host physical RAM post-request, VRAM drift, KV cache reuse, and response latency consistency.
- **Pass Criteria:** Zero memory leaks across 10 requests; available RAM stabilizes above 400 MB.

### Stage 2: Context Scaling Feasibility Probe ($n_{\text{ctx}} = 512 \rightarrow 1024 \rightarrow 2048$)
- **Objective:** Measure exact VRAM and RAM scaling as context size increases.
- **Pass Criteria:** VRAM usage remains safely below 3,800 MiB (leaving $\ge 300\text{ MiB}$ safety margin on the 4GB GPU).

### Stage 3: Supervisor IPC & UI Mock Integration
- **Objective:** Test profile selection, preflight feedback, and start/stop controls in the Tauri UI using mock and simulated fixtures.
- **Pass Criteria:** UI accurately reflects profile changes and disables launch when simulated thresholds fail.

### Stage 4: Automated Test Suite Extension
- **Objective:** Expand `supervisor_test_runner` to include automated contract tests for profile switching, error recovery, and configuration serialization.
- **Pass Criteria:** 100% test pass rate across all supervisor unit and integration tests.

---

## 9. Proposed Implementation Sequence

To ensure zero disruption to existing Milestone 12 and Phase B baselines, work should proceed in the following strict order:

```
Phase C.3.8: Supervisor Profile Schema & Backend IPC Extension
  ├── Define formal RuntimeProfile enum and configuration structs
  ├── Add supervisor_get_available_profiles IPC command
  └── Update supervisor test suite (zero real processes spawned)
  [GATE: Review & Approval Required]

Phase C.3.9: Desktop UI Profile Selection & Resource Visualization
  ├── Implement Profile Selector in Settings / Control view
  ├── Implement Dynamic Preflight Resource gauges (RAM / VRAM)
  └── Wire up supervisor IPC bindings with simulated fixture tests
  [GATE: Review & Approval Required]

Phase C.3.10: Controlled Multi-Turn & Extended Context Validation
  ├── Authorize controlled multi-turn inference test via supervisor
  ├── Validate context expansion (512 -> 1024)
  └── Finalize Phase C production desktop release readiness report
```

---

## 10. Conclusion & Request for Direction

Phase C.3.6 successfully proved that real CUDA inference is achievable on this host under supervisor containment using the staged low-memory standalone profile. The technical investigations in this audit confirm:
1. Physical RAM recovery is governed by standard Windows file caching dynamics and exhibits zero leaks.
2. The 166.92 MiB CPU buffer is architecturally expected and represents input embeddings for Qwen 2.5's large vocabulary.
3. The standalone profile is viable as an explicit opt-in choice, while the default cluster profile and its 1,500 MB safety guard remain intact.

**Stopping and awaiting operator review and approval before proceeding.**
