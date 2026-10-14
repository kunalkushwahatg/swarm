# Swarm Phase 2 Baseline Documentation

## Step 0 - Inspecting Current State

### Project Directory Structure

```
swarm/
├── llama.cpp/                  # llama.cpp submodule (v0.3.0)
│   ├── ggml/                   # GGML backend with RPC support
│   ├── tools/rpc/              # RPC server tool
│   └── ...                     # Standard llama.cpp structure
├── build/                      # CPU/RPC build artifacts
├── build-cuda/                 # CUDA+RPC build artifacts
├── build-rpc-server/           # Legacy RPC-only build
├── models/                     # GGUF model files
│   ├── llama-3-8b.gguf         # Original 4.9GB model (not used)
│   └── qwen2.5-3b-instruct-q4_k_m.gguf  # Working 2.0GB model
├── main.cpp                    # Application entry point (Phase 1 updated)
├── config.h                    # Phase 1 configuration header
├── CMakeLists.txt              # Build configuration
├── HANDOFF.md                  # Operational documentation
├── docs/                       # Documentation
│   ├── audits/                 # Audit reports
│   └── implementation/         # Implementation docs
│       ├── PHASE_1_BASELINE.md
│       ├── PHASE_1_RESULTS.md
│       ├── PHASE_1_TESTS.md
│       ├── PHASE_1_SUMMARY.md
│       └── PHASE_2_BASELINE.md (this file)
└── PHASE_1_COMPLETION_SUMMARY.md
```

### Source Code Inspection

**main.cpp** (current state after Phase 1):
- Uses llama.cpp backend with GGML RPC support
- HTTP server on port 8080 via httplib
- Model loading: configurable via SWARM_MODEL_PATH env var (defaults to "models/qwen2.5-3b-instruct-q4_k_m.gguf")
- RPC endpoint: configurable via SWARM_RPC_ENDPOINT env var (defaults to "127.0.0.1:50052")
- RPC enable/disable: SWARM_USE_RPC env var (0 disables, any other value enables, default true)
- Context length: configurable via SWARM_CTX_SIZE env var (defaults to 2048)
- Inference serialized via std::mutex inference_mutex
- Streaming response via Server-Sent Events with request ID tracking
- Device reporting via get_device_report() function
- Graceful shutdown handling via Windows console events
- Structured logging with INFO/WARN/ERROR levels and optional timestamps
- Request ID tracing (unique 64-bit ID per request)

**config.h** (Phase 1 addition):
- SwarmConfig structure with configurable parameters
- load_config_from_env() function for environment variable loading
- Supported configuration options:
  - Model path (SWARM_MODEL_PATH)
  - HTTP bind address (SWARM_HTTP_BIND)
  - HTTP port (SWARM_HTTP_PORT)
  - RPC enable (SWARM_USE_RPC)
  - RPC endpoint (SWARM_RPC_ENDPOINT)
  - Context size (SWARM_CTX_SIZE)
  - Default max tokens (SWARM_MAX_TOKENS_DEFAULT)
  - Log timestamps (SWARM_LOG_TIMESTAMPS)

**CMakeLists.txt**:
- Minimum CMake version 3.14
- Project name: SwarmNode
- C++17 standard enforced
- llama.cpp added as subdirectory
- Executable: swarm_node from main.cpp + httplib.cpp
- Links against llama and ggml-rpc libraries

### Build Environment Verification

**Compiler**: 
- Visual Studio 2022 Build Tools (cl.exe from VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64/cl.exe)
- Generator: NMake Makefiles

**CMake Configuration (build-cuda)**:
```
cmake -S . -B build-cuda -G "NMake Makefiles" -DGGML_CUDA=ON -DGGML_RPC=ON -DGGML_BACKEND_DL=OFF -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_ARCHITECTURES=61
```

### Executable Locations

**Primary Application**: `build-cuda/swarm_node.exe` 
**RPC Worker**: `build\bin\Release\ggml-rpc-server.exe` (CPU-only)
**Shared DLLs**: ggml-cuda.dll, llama.dll, ggml-rpc.dll, platform-specific DLLs

### llama.cpp Version and GGML RPC Architecture

**llama.cpp Version**: 0.3.0
- From `llama.cpp/CMakeLists.txt`: 
  ```cmake
  set(LLAMA_VERSION_MAJOR 0)
  set(LLAMA_VERSION_MINOR 3)
  set(LLAMA_VERSION_PATCH 0)
  ```

**GGML RPC Architecture**:
- **Protocol Version**: 7.0.0 (from `llama.cpp/ggml/include/ggml-rpc.h`)
  - `#define RPC_PROTO_MAJOR_VERSION    7`
  - `#define RPC_PROTO_MINOR_VERSION    0` 
  - `#define RPC_PROTO_PATCH_VERSION    0`
- **Maximum Servers**: 16 (`#define GGML_RPC_MAX_SERVERS       16`)
- **Implementation**: Backend registration system in llama.cpp GGML
- **Key Functions**:
  - `ggml_backend_rpc_add_server(const char * endpoint)` - adds an RPC server
  - `ggml_backend_rpc_reg(void)` - gets the RPC backend registration
  - `ggml_backend_rpc_init(const char * endpoint, uint32_t device)` - initializes RPC backend
  - `ggml_backend_rpc_start_server(const char * endpoint, const char * cache_dir, size_t n_threads, size_t n_devices, ggml_backend_dev_t * devices)` - starts RPC server

### Device Array Limitation in Current Implementation

From `main.cpp` lines 249-252:
```cpp
std::array<ggml_backend_dev_t, 3> devices = {
    use_rpc ? rpc_device : cuda_device, use_rpc ? cuda_device : nullptr,
    nullptr};
model_params.devices = devices.data();
```

This shows the current implementation uses a fixed-size array of 3 devices:
1. Index 0: RPC device (if enabled) or CUDA device (if RPC disabled)
2. Index 1: CUDA device (if RPC enabled) or nullptr (if RPC disabled)  
3. Index 2: nullptr (terminator)

This architecture limits the system to at most one RPC device plus one CUDA device, or just one device if RPC is disabled.

### Worker Process Investigation

The RPC worker executable is `ggml-rpc-server.exe` located in:
- `build\bin\Release\ggml-rpc-server.exe` (from CPU-only build)
- Would need to be built with `GGML_CUDA=ON` for GPU-enabled RPC worker (not currently present)

From `llama.cpp/tools/rpc/rpc-server.cpp`, the RPC server accepts:
- `--host`: Host to bind to (default: 127.0.0.1)
- `--port`: Port to listen on (default: 50052)
- `--threads`: Number of threads (default: based on hardware concurrency)
- `--cache-dir`: Directory for model caching
- `--nb`: Number of devices (backend count)

### Current Working Directory Status

**Git Status**: NOT A GIT REPOSITORY
- No .git folder in root directory
- No .git folder in llama.cpp subdirectory
- Appears to be extracted/released version rather than active development clone

**Working Tree**: CLEAN (after Phase 1 changes)
- No uncommitted changes visible in source files beyond Phase 1 implementations
- Build artifacts present in dedicated directories

## Baseline Classification Summary

### Verified by Source Inspection:
- llama.cpp version 0.3.0 with GGML RPC v7.0.0
- Fixed device array size of 3 in main.cpp limiting to 1 RPC + 1 CUDA device
- RPC server implementation in llama.cpp/tools/rpc/
- Configuration system via config.h and environment variables
- Structured logging and request ID tracing from Phase 1
- Graceful shutdown handling from Phase 1
- Build configuration using NMake Makefiles with Visual Studio 2022

### Verified by Existing Documentation (HANDOFF.md, summary.txt):
- Mixed CUDA+RPC mode works with Qwen2.5-3B model
- Layer split approximately layers 0-14 (RPC CPU) and 15-31 (local CUDA) for Qwen2.5-3B
- Resource requirements: ≥1.5GB free RAM and VRAM
- Successful end-to-end testing with PowerShell Invoke-RestMethod

### Reported by Existing Documentation but Not Verified in Current Context:
- Exact performance metrics (tokens/sec, latency)
- Behavior under memory/GPU pressure
- Network sensitivity to latency/jitter
- Long-running stability

### Blocked or Unknown (Due to Environment Permissions):
- Actual build execution and verification
- Test suite execution
- End-to-end functional testing
- Runtime behavior validation

### Configuration Parameters (Current Effective Defaults)

| Parameter | Source | Default Value | Notes |
|-----------|--------|---------------|-------|
| Model Path | config.h + SWARM_MODEL_PATH | models/qwen2.5-3b-instruct-q4_k_m.gguf | Configurable |
| HTTP Bind Address | config.h + SWARM_HTTP_BIND | 0.0.0.0 | Configurable |
| HTTP Port | config.h + SWARM_HTTP_PORT | 8080 | Configurable |
| RPC Enable | config.h + SWARM_USE_RPC | true (unless "0") | Configurable |
| RPC Endpoint | config.h + SWARM_RPC_ENDPOINT | 127.0.0.1:50052 | Configurable |
| Context Size | config.h + SWARM_CTX_SIZE | 2048 | Configurable |
| Default Max Tokens | config.h + SWARM_MAX_TOKENS_DEFAULT | 50 | Configurable |
| Log Timestamps | config.h + SWARM_LOG_TIMESTAMPS | true | Configurable |
| Device Array Size | main.cpp (hardcoded) | 3 elements | Fixed limit |
| Max RPC Servers | llama.cpp/ggml/include/ggml-rpc.h | 16 | Upstream limit |

## Conclusion

Baseline establishes that:
1. The application has been successfully updated with Phase 1 improvements (configuration, logging, lifecycle handling)
2. Core llama.cpp v0.3.0 with GGML RPC v7.0.0 is present
3. Current architecture limits device array to 3 elements (max 1 RPC + 1 CUDA device)
4. RPC server implementation supports multiple configuration options
5. Build environment is Visual Studio 2022 Build Tools with NMake Makefiles
6. No blocking issues found in source inspection - ready to proceed with Phase 2 implementation focusing on multi-worker capabilities

The primary limitation for multi-worker inference is the fixed device array size in main.cpp, which would need modification to support multiple RPC backends.