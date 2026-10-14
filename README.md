# Swarm

Swarm is an open-source distributed LLM inference framework and native desktop application designed to run large language models cooperatively across multiple consumer devices by offloading layers over local networks.

---

## Architecture Overview

Swarm unites three core subsystems into a cohesive local-first platform:

1. **Inference Engine (`swarm_node`)**: High-performance C++ coordinator built on bundled GGML/llama.cpp, supporting local CUDA offloading and remote RPC tensor execution.
2. **Native Desktop Shell & Supervisor (`spike/desktop-shell/src-tauri`)**: Rust Tauri application providing Windows Job Object process confinement, health probing, graceful shutdown, staged startup, and fail-closed safety guards.
3. **Desktop Frontend (`ui/`)**: React 19 + TypeScript + Vite + TailwindCSS interface featuring Chat, Devices management, Session telemetry, Settings, and Compute Allocation.

```
┌─────────────────────────────────────────────────────────────────┐
│                      Swarm Desktop UI                           │
│     (React 19 / TypeScript / Vite / TailwindCSS / Radix UI)     │
└───────────────────────────────┬─────────────────────────────────┘
                                │ Tauri IPC Commands
┌───────────────────────────────▼─────────────────────────────────┐
│              Tauri Shell & Process Supervisor (Rust)            │
│  - Windows Job Object Confinement   - Staged Cluster Startup    │
│  - Health Probing & Diagnostics     - Process Tree Teardown     │
└───────────────┬─────────────────────────────────┬───────────────┘
                │ Child Process                   │ Network RPC
┌───────────────▼────────────────┐   ┌────────────▼──────────────┐
│     Swarm Coordinator (C++)    │   │  Remote Worker Node (C++) │
│  - HTTP API Gateway (Port 8080)│   │  - ggml-rpc-server        │
│  - Dynamic Placement Policy    ├───┤  - Hardware Telemetry     │
│  - Local CUDA Offload (GTX 1050)│   │    Agent (Port 50052)     │
└────────────────────────────────┘   └───────────────────────────┘
```

---

## Repository Structure

```
swarm/
├── CMakeLists.txt         # Root C++ build definitions (coordinator, agent, tests)
├── build_swarm.bat        # Automated C++ build script for Visual Studio / NMake
├── build_and_check.ps1    # PowerShell build verification tool
├── main.cpp               # C++ Coordinator gateway, HTTP routes, inference orchestration
├── worker.cpp / .h        # Worker lifecycle, RPC client connection, health state
├── agent_main.cpp / .h    # Remote worker telemetry reporter agent
├── config.h               # Configuration parsing and runtime defaults
├── node.h                 # Node inventory, provenance, and freshness models
├── policy.h               # Placement policy, virtual budgets, capacity planning
├── estimator.h            # Dynamic layer memory estimation and profiling
├── test_*.cpp             # Offline unit and regression test suites
│
├── llama.cpp/             # Bundled llama.cpp and GGML engine with customized CUDA/RPC
│
├── spike/
│   └── desktop-shell/     # Tauri native desktop shell and process supervisor
│       ├── package.json   # Shell test scripts and frontend dependencies
│       └── src-tauri/     # Rust backend (supervisor, process, job, commands)
│           ├── Cargo.toml # Rust dependencies (tauri, serde, windows-sys)
│           └── src/       # Rust supervisor modules and test binaries
│
├── ui/                    # React 19 + TypeScript + Vite frontend
│   ├── package.json       # UI dependencies and build scripts
│   ├── vite.config.ts     # Vite configuration
│   └── src/               # UI components (Chat, Devices, Session, Settings)
│
├── scripts/               # Automation, deployment, and milestone test scripts
│   ├── Start-LocalCuda.ps1              # Run standalone local CUDA coordinator
│   ├── Start-RemoteWorker.ps1           # Worker setup script for remote machines
│   ├── Start-ProductionCoordinator.ps1  # Production coordinator launcher
│   ├── Start-UI.ps1                     # Frontend dev server launcher
│   ├── test_inference.py                # Python SSE test client
│   └── Invoke-Milestone*Validation.ps1  # Automated regression validation suites
│
├── docs/                  # Architecture blueprints, security specs, and reports
├── artifacts/             # Validation reports, test logs, and UI screenshots
└── models/                # Local model directory (excluded from Git; see below)
```

---

## Prerequisites

- **Operating System:** Windows 10/11 x64 (tested on Windows 11).
- **C++ Compiler & Build Tools:** Visual Studio 2022 Build Tools (MSVC v143) with C++17 support, CMake (v3.14+), and NMake.
- **NVIDIA GPU & CUDA:** NVIDIA GPU with Compute Capability 6.1+ (tested on GeForce GTX 1050) and CUDA Toolkit 12.x.
- **Rust Toolchain:** Rust 1.80+ (2024 edition) with Cargo.
- **Node.js:** Node.js v18+ and npm.

---

## Model Setup

Model weight files (`*.gguf`) are large binaries and are **excluded from Git**.

1. Place your target GGUF model in the `models/` directory:
   ```
   models/qwen2.5-3b-instruct-q4_k_m.official-check.gguf
   ```
2. The validated reference baseline is **Qwen 2.5 3B Instruct Q4_K_M**:
   - SHA-256 Checksum: `626B4A6678B86442240E33DF819E00132D3BA7DDDFE1CDC4FBB18E0A9615C62D`
3. Custom model paths can be set via the `SWARM_MODEL_PATH` environment variable.

---

## Build and Run

### 1. Build C++ Engine (`swarm_node`)

Open **x64 Native Tools Command Prompt for VS 2022** and run:

```cmd
build_swarm.bat
```

Or configure and build manually with CMake:

```cmd
cmake -S . -B build-cuda -G "NMake Makefiles" -DGGML_CUDA=ON -DGGML_RPC=ON -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_ARCHITECTURES=61
cmake --build build-cuda --target swarm_node
```

The resulting executable and required runtime DLLs (`ggml-base.dll`, `ggml-cpu.dll`, `ggml-cuda.dll`, `ggml-rpc.dll`, `llama.dll`) reside in `build-cuda\bin\`.

### 2. Build Frontend UI

```cmd
cd ui
npm install
npm run build
```

For live UI development with hot reload:
```cmd
npm run dev
```

### 3. Build & Run Desktop Shell (Tauri)

```cmd
cd spike\desktop-shell\src-tauri
cargo check
cargo test
```

To run the full Tauri desktop application:
```cmd
cd spike\desktop-shell
npm run tauri dev
```

---

## Automated Test Verification

Swarm includes comprehensive unit, integration, and safety test suites:

### Offline C++ Unit & Policy Tests
```cmd
cmake --build build-cuda --target test_policy test_dynamic_policy test_node_inventory test_agent_and_inventory test_security test_rpc_health
build-cuda\test_policy.exe
build-cuda\test_dynamic_policy.exe
build-cuda\test_node_inventory.exe
build-cuda\test_agent_and_inventory.exe
build-cuda\test_security.exe
build-cuda\test_rpc_health.exe
```

### Supervisor Safety & Lifecycle Suite (44 Tests)
Validates hidden-console execution, port collision detection, Windows Job Object tree reclamation, staged timeouts, and transactional rollbacks:
```cmd
cd spike\desktop-shell\src-tauri
cargo run --bin supervisor_test_runner
```

---

## Current Status and Verified Capabilities

- **Local CUDA Acceleration:** PASS. Full offload of model layers to local GPU with tensor allocation verification.
- **Remote RPC Pipeline Offloading:** PASS. Seamless distribution of layers across local and remote nodes via GGML RPC v7.
- **Process Supervisor:** PASS. Windows Job Object management guarantees no orphan background processes survive app closure.
- **Observability:** PASS. Prometheus metrics (`/metrics`), backend placement introspection (`/backends`), and node freshness status (`/nodes`).
- **Telemetry Security:** PASS. Constant-time token verification protecting telemetry ingestion endpoints.
- **Current Limitations:** Tested on Windows x64. Remote device onboarding currently requires network reachability on port 50052. Full dynamic mid-generation failover without engine restart is in active development.

---

## License

This project incorporates components from [llama.cpp](https://github.com/ggerganov/llama.cpp) licensed under the MIT License. See `llama.cpp/LICENSE` for details.
