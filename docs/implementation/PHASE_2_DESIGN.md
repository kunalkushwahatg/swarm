# Swarm Phase 2 Design Documentation

## Overview

This document describes the design for Phase 2: Multi-Worker Inference and Worker Management. The goal is to evolve Swarm from a gateway that can use a local GPU and one RPC worker into a system that can manage multiple worker processes and coordinate multiple devices for inference.

## Key Design Goals

1. **Explicit worker configuration and lifecycle management**
2. **Multiple worker processes for local simulation**
3. **Clear distinction between worker being online and participating in inference**
4. **Verified multi-worker inference experiment (if supported by upstream)**
5. **Basic worker health, resource status, failure reporting, and timeouts**
6. **Repeatable test harness with stale artifact prevention**
7. **Foundation for real multi-device communication over Wi-Fi**
8. **Documentation of supported behavior, limitations, and next steps**

## Worker Abstraction Design

### WorkerInfo Structure

Each worker is represented by a `WorkerInfo` structure containing:

```cpp
struct WorkerInfo {
    std::string id;                    // Stable worker ID (UUID or user-defined)
    std::string host;                  // Hostname or IP address
    uint16_t port;                     // Port number
    WorkerType type;                   // LOCAL_RPC, REMOTE_RPC, LOCAL_CUDA, etc.
    WorkerState state;                 // Current state
    std::optional<uint32_t> pid;       // Process ID for locally managed workers
    std::chrono::system_clock::time_point started_at;  // Start time
    std::chrono::system_clock::time_point last_health_check; // Last health check
    std::string last_error;            // Last error message
    bool is_inference_active;          // Whether currently participating in inference
    size_t inference_count;            // Number of inferences participated in
    
    // Resource information (when available)
    std::optional<size_t> memory_total_bytes;
    std::optional<size_t> memory_free_bytes;
    std::optional<std::string> device_name;
    std::optional<ggml_backend_dev_type> device_type;
};
```

### Worker States

```cpp
enum class WorkerState {
    STOPPED,       // Not running
    STARTING,      // Process starting or connecting
    READY,         // Running and available for inference
    BUSY,          // Currently participating in inference
    UNAVAILABLE,   // Running but not available (e.g., health check failed)
    ERROR,         // In error state
    STOPPING       // In process of stopping
};
```

### Worker Types

```cpp
enum class WorkerType {
    LOCAL_RPC,     // Locally managed RPC worker process
    REMOTE_RPC,    // Remote RPC worker (not managed by Swarm)
    LOCAL_CUDA,    // Local CUDA device (not a process)
    UNKNOWN
};
```

## Worker Manager Responsibilities

The `WorkerManager` class handles:

1. **Registration and Removal**: Adding/removing worker records
2. **Validation**: Checking worker configuration for conflicts (duplicate IDs, ports)
3. **Lifecycle Control**: Starting/stopping only owned processes
4. **Health Monitoring**: Periodic health checks and state updates
5. **State Tracking**: Maintaining current state of all workers
6. **Error Handling**: Recording and reporting worker errors
7. **Timeout Management**: Connection and startup timeouts
8. **Status Reporting**: Providing observable worker status

## Local Worker Process Management

For local simulation, the manager will:

1. **Validate Ports**: Check requested ports are available before launching
2. **Check Process Ownership**: Verify if existing process owns each endpoint
3. **Launch Workers**: Use correct executable (`ggml-rpc-server.exe`) with appropriate arguments
4. **Track PIDs**: Record process ID for every started worker
5. **Capture Diagnostics**: Store startup failures and diagnostic output
6. **Wait for Readiness**: Confirm worker is reachable before marking ready
7. **Selective Stopping**: Stop only processes started and tracked by the manager
8. **Clean Shutdown**: Ensure all owned processes are stopped on exit
9. **Prevent Duplicates**: Avoid accidentally starting duplicate workers
10. **Individual Control**: Support starting/stopping individual workers

## Configuration Design

Extending the existing `config.h` approach:

### Environment Variables (Backward Compatible)

- `SWARM_WORKERS_JSON`: JSON string defining worker array (alternative to individual vars)
- `SWARM_MAX_LOCAL_WORKERS`: Maximum number of local workers to start (default: 4)
- `SWARM_WORKER_STARTUP_TIMEOUT_S`: Startup timeout in seconds (default: 30)
- `SWARM_WORKER_HEALTH_CHECK_INTERVAL_S`: Health check interval (default: 10)
- `SWARM_WORKER_CONNECTION_TIMEOUT_S`: Connection timeout (default: 5)

### Example Worker Configuration (JSON)

If using `SWARM_WORKERS_JSON`:
```json
[
  {
    "id": "worker-1",
    "type": "local_rpc",
    "host": "127.0.0.1",
    "port": 50052,
    "enabled": true,
    "cache_dir": "./worker1_cache"
  },
  {
    "id": "worker-2",
    "type": "local_rpc",
    "host": "127.0.0.1",
    "port": 50053,
    "enabled": true,
    "cache_dir": "./worker2_cache"
  }
]
```

### Individual Environment Variables (Alternative)

For simpler configuration:
- `SWARM_WORKER_0_ID`, `SWARM_WORKER_0_HOST`, `SWARM_WORKER_0_PORT`, etc.
- `SWARM_WORKER_1_ID`, `SWARM_WORKER_1_HOST`, `SWARM_WORKER_1_PORT`, etc.
- Up to `SWARM_MAX_LOCAL_WORKERS`

## Multi-Worker Inference Architecture Investigation

### Upstream Capability Analysis

From inspection of `llama.cpp/ggml/include/ggml-rpc.h`:
- `ggml_backend_rpc_reg()` returns a single backend registration
- `ggml_backend_rpc_add_server(const char * endpoint)` adds one server to the registry
- The backend registration can presumably contain multiple devices

However, the current Swarm implementation in `main.cpp` uses a fixed-size array of 3 devices:
```cpp
std::array<ggml_backend_dev_t, 3> devices = {
    use_rpc ? rpc_device : cuda_device, use_rpc ? cuda_device : nullptr,
    nullptr};
```

### Multi-Backend Support Hypothesis

The GGML backend system likely supports multiple devices in a single `llama_model_params.devices` array. The limitation appears to be in Swarm's hardcoded array size, not in the upstream llama.cpp implementation.

### Proposed Approach

1. **Dynamic Device Array**: Replace fixed `std::array<ggml_backend_dev_t, 3>` with `std::vector<ggml_backend_dev_t>`
2. **Worker-to-Device Mapping**: Map registered workers to device array entries
3. **Preserve Ordering**: Maintain device ordering for consistent layer placement
4. **Fallback to Existing Behavior**: When only one RPC worker configured, behave exactly as before

## Health and Observability Extensions

### Worker Status Endpoint

`GET /workers` returning JSON array of worker information:
```json
[
  {
    "id": "worker-1",
    "host": "127.0.0.1",
    "port": 50052,
    "type": "local_rpc",
    "state": "ready",
    "pid": 1234,
    "started_at": "2026-10-09T10:30:00Z",
    "last_health_check": "2026-10-09T10:30:05Z",
    "last_error": "",
    "is_inference_active": false,
    "inference_count": 0,
    "memory_total_bytes": 8589934592,
    "memory_free_bytes": 4294967296,
    "device_name": "AMD Ryzen 7 5800X",
    "device_type": "CPU"
  }
]
```

### Enhanced Logging

- Worker lifecycle events: starting, ready, busy, stopping, stopped, error
- Health check results: success/failure with latency
- Inference participation: worker joining/leaving inference
- Resource updates: periodic memory reporting

### Metrics Endpoint (Optional)

`GET /metrics` for Prometheus-compatible metrics:
- `swarm_requests_total{status="success|error"}`
- `swarm_request_duration_seconds`
- `swarm_active_requests`
- `swarm_worker_state_total{state="ready|busy|error|..."}`
- `swarm_worker_inference_active_total`
- `swarm_worker_startup_duration_seconds`
- `swarm_worker_health_check_duration_seconds`

## Failure Handling and Recovery

### Failure Detection

1. **Startup Failure**: Process fails to start or doesn't become reachable within timeout
2. **Unexpected Exit**: Monitored process terminates unexpectedly
3. **Unreachable Endpoint**: Health check fails repeatedly
4. **Port Conflict**: Requested port already occupied by unrelated process
5. **RPC Initialization Failure**: Backend registration fails

### Recovery Strategies

1. **Clear Error Reporting**: Log detailed error information
2. **State Transition**: Move worker to ERROR state
3. **No Automatic Restart**: Require manual intervention (safe default)
4. **Inference Continuation**: If worker fails during inference, return error but keep server running
5. **Resource Cleanup**: Proper cleanup of failed worker resources

### Timeouts

- Startup timeout: Configurable, default 30s
- Connection timeout: Configurable, default 5s  
- Health check timeout: Configurable, default 10s
- Inference stall detection: Not implemented in Phase 2 (would require complex KV-cache handling)

## Same-Wi-Fi Multi-Device Foundation

### Network Configuration Support

1. **Explicit Hostname/IP**: Workers can be configured with any valid hostname or IP address
2. **Binding Flexibility**: RPC workers can bind to specific interfaces (not just 127.0.0.1)
3. **Connection Validation**: Distinguish between unreachable workers and configuration errors
4. **Network Timeouts**: Configurable timeouts for network operations
5. **Coexistence**: Local simulation and remote worker configurations can coexist

### Security Limitations Documentation

The current GGML RPC implementation:
- **No Authentication**: Any network-reachable host can connect
- **No Encryption**: All communication is plain TCP
- **No Access Control**: No IP allowlisting/blocklisting
- **No Message Integrity**: No protection against tampering

**Usage Restriction**: Only for trusted networks. Binding to `0.0.0.0` or exposing to untrusted networks is unsafe.

## Implementation Approach

### Minimal Changes Principle

1. **Preserve Core Inference**: Do not change the fundamental inference path
2. **Backward Compatibility**: Existing single-worker mode must work identically
3. **Surgical Changes**: Only modify what's necessary for multi-worker support
4. **Gradual Enhancement**: Build on Phase 1 improvements

### Implementation Phases

1. **Worker Abstraction**: Add WorkerInfo, WorkerState, WorkerType definitions
2. **Worker Manager**: Implement WorkerManager class with core functionality
3. **Configuration Extension**: Enhance config.h to support multiple workers
4. **Integration Points**: Modify main.cpp to use WorkerManager instead of hardcoded RPC
5. **Health Endpoint**: Add /workers endpoint
6. **Enhanced Logging**: Add worker-specific log messages
7. **Error Handling**: Implement proper failure detection and reporting

## Acceptance Criteria

### Configuration
- [ ] Worker configuration is validated before use
- [ ] Duplicate IDs and invalid endpoints are rejected with clear errors
- [ ] Backward compatibility with existing single-worker setup maintained

### Worker Lifecycle
- [ ] Start one worker and verify its process and endpoint
- [ ] Start a second worker on a different port
- [ ] Verify both independently reachable
- [ ] Test occupied port reports useful error without terminating unrelated process
- [ ] Stop one worker and verify other remains running
- [ ] Stop manager and verify only simulator-owned processes stopped
- [ ] No duplicate worker processes unintentionally left behind

### Multi-Worker Inference (If Supported)
- [ ] Multiple workers registered with inference engine
- [ ] Multiple workers actually participating in same inference (verified)
- [ ] Multiple workers independently serving different requests
- [ ] Clear distinction between online workers and participating workers

### Observability
- [ ] Worker status accurately reflects stopped, starting, ready, failed states
- [ ] Health information updates after worker state changes
- [ ] Logs identify affected worker
- [ ] Errors do not crash gateway
- [ ] Status responses never claim participation without evidence

### Failure Handling
- [ ] Simulate worker becoming unavailable
- [ ] Failure detected and correct worker marked unavailable/failed
- [ ] Server does not falsely report success
- [ ] Logs contain diagnostic information
- [ ] Cleanup performed safely
- [ ] Gateway remains stable when recovery is technically possible

### Testing
- [ ] Lightweight test suite created and executed
- [ ] Tests cover configuration, lifecycle, health, failure handling
- [ ] End-to-end test with actual inference (if resources permit)
- [ ] No reuse of stale artifacts or test outputs
- [ ] Each test run has unique identifier and clean state

## Limitations and Open Questions

### Known Limitations
1. **Device Array Size**: Current implementation limited by hardcoded array in main.cpp
2. **Security**: No authentication or encryption in RPC/HTTP (documented limitation)
3. **Resource Awareness**: No automatic resource-based worker limiting
4. **Inference Serialization**: Mutex-serialized inference remains (Phase 1 limitation)

### Open Questions for Upstream Investigation
1. What is the precise algorithm for layer placement across multiple devices?
2. Can layer placement be influenced or overridden via API?
3. What happens if an RPC worker disconnects mid-inference?
4. Is there automatic fallback to CPU-only if GPU memory insufficient?
5. How does the system handle heterogeneous worker capabilities?
6. What is the maximum practical sequence length given memory constraints?
7. Are there any known race conditions in the GGML RPC backend?
8. How does quantization level affect split decisions and performance?

## Files to be Modified/Added

1. **New Files**:
   - `worker.h` / `worker.cpp` - WorkerInfo, WorkerState, WorkerType, WorkerManager
   - `docs/implementation/PHASE_2_RESULTS.md` - Implementation results
   - `docs/implementation/PHASE_2_TESTS.md` - Test procedures and results
   - `docs/implementation/PHASE_2_SUMMARY.md` - Phase summary

2. **Modified Files**:
   - `main.cpp` - Integrate WorkerManager, replace hardcoded RPC logic
   - `config.h` - Extend for multiple worker configuration
   - `docs/implementation/PHASE_2_DESIGN.md` - This document

## Conclusion

This design provides a foundation for multi-worker inference and worker management while maintaining backward compatibility and making minimal, surgical changes to the existing codebase. The design separates concerns clearly, preserves the core inference path, and provides extensibility for future enhancements.

The approach investigates upstream capabilities before implementation, ensuring we don't invent capabilities that don't exist in the underlying llama.cpp/GGML RPC implementation.

---
*Design documented as of 2026-10-09*