NOTE: Due to environment permissions, the test suite has not been executed. This document defines the tests that would be run.

# Swarm Phase 2 Test Suite

## Test Overview

This document outlines the test suite for Phase 2 improvements, focusing on:
- Worker configuration and validation
- Worker lifecycle management
- Health checking and status reporting
- Multi-worker inference capabilities
- Failure handling and recovery
- HTTP endpoints (/workers, /health, /metrics)
- Backward compatibility with existing single-worker setup

Due to resource constraints and the need to avoid multiple large-model instances, most tests are unit-level or use mocks where appropriate. End-to-end tests with the Qwen2.5-3B model are included only if resources permit and only for verifying that existing functionality still works.

## Test Environment

- **Build Directory**: `build-cuda/`
- **Executable**: `swarm_node.exe`
- **Model**: `models/qwen2.5-3b-instruct-q4_k_m.gguf` (required for end-to-end test)
- **RPC Worker**: `build/bin/Release/ggml-rpc-server.exe` (required for mixed-mode tests)

## Test Categories

### 1. Configuration Tests

#### Test 1.1: Default Configuration Loading
- **Description**: Verify that default values are loaded when no environment variables are set
- **Procedure**: 
  1. Unset all SWARM_* environment variables
  2. Start swarm_node.exe with timeout
  3. Check startup logs for expected defaults
- **Expected**: 
  - Model path: models/qwen2.5-3b-instruct-q4_k_m.gguf
  - HTTP bind: 0.0.0.0:8080
  - RPC enabled: true
  - Legacy RPC endpoint: 127.0.0.1:50052
  - One worker configured (legacy-rpc-worker)
  - Context size: 2048
  - Default max tokens: 50
  - Log timestamps: true

#### Test 1.2: Environment Variable Override (Legacy)
- **Description**: Verify that legacy environment variables still work
- **Procedure**:
  1. Set SWARM_MODEL_PATH=models/test.gguf
  2. Set SWARM_HTTP_PORT=9090
  3. Set SWARM_USE_RPC=0
  4. Start swarm_node.exe with timeout
  5. Check startup logs
- **Expected**: 
  - Model path: models/test.gguf
  - HTTP port: 9090
  - RPC enabled: false
  - No workers configured (since RPC disabled)
  - Other values remain defaults

#### Test 1.3: New Worker Configuration via Individual Variables
- **Description**: Verify that new worker configuration via SWARM_WORKER_*_* variables works
- **Procedure**:
  1. Set SWARM_WORKER_0_ID=worker1
  2. Set SWARM_WORKER_0_HOST=127.0.0.1
  3. Set SWARM_WORKER_0_PORT=50052
  4. Set SWARM_WORKER_0_ENABLED=1
  5. Set SWARM_WORKER_1_ID=worker2
  6. Set SWARM_WORKER_1_HOST=127.0.0.1
  7. Set SWARM_WORKER_1_PORT=50053
  8. Set SWARM_WORKER_1_ENABLED=1
  9. Start swarm_node.exe with timeout
  10. Check startup logs and /workers endpoint
- **Expected**: 
  - Two workers configured
  - Worker1: ID=worker1, host=127.0.0.1, port=50052, enabled=true
  - Worker2: ID=worker2, host=127.0.0.1, port=50053, enabled=true
  - Legacy RPC variables ignored when new worker config present

#### Test 1.4: Invalid Configuration Handling
- **Description**: Verify graceful handling of invalid configuration values
- **Procedure**:
  1. Set SWARM_WORKER_0_PORT=invalid
  2. Start swarm_node.exe
  3. Check that error is logged and worker not added
  4. Set SWARM_WORKER_0_PORT=65536 (out of range)
  5. Check that error is logged
  6. Set SWARM_WORKER_0_ID=duplicate and SWARM_WORKER_1_ID=duplicate
  7. Check that duplicate ID error is logged
- **Expected**: Invalid values result in error messages and faulty workers not being added

#### Test 1.5: Worker Configuration Validation
- **Description**: Verify that worker configuration validates duplicate IDs and conflicting ports
- **Procedure**:
  1. Set two workers with same ID but different ports
  2. Set two workers with same port but different IDs
  3. Start swarm_node.exe
  4. Check error logs
- **Expected**: 
  - Duplicate ID rejected with clear error
  - Conflicting port rejected with clear error
  - Server may still start with valid workers

### 2. Worker Lifecycle Tests

#### Test 2.1: Worker Process Startup
- **Description**: Verify that local RPC workers can be started and stopped
- **Procedure**:
  1. Configure two local RPC workers on ports 50052 and 50053
  2. Start swarm_node.exe
  3. Check that worker processes are created
  4. Verify workers reach READY state via /workers endpoint
  5. Stop swarm_node.exe
  6. Verify that worker processes are terminated
- **Expected**: 
  - Worker processes started and tracked
  - Workers reach READY state
  - All tracked processes stopped on shutdown

#### Test 2.2: Port Conflict Handling
- **Description**: Verify that port conflicts are handled gracefully
- **Procedure**:
  1. Start a process on port 50052 (e.g., another ggml-rpc-server)
  2. Configure worker to use port 50052
  3. Start swarm_node.exe
  4. Check error logs
  5. Stop the conflicting process
  6. Restart swarm_node.exe
  7. Verify worker starts successfully
- **Expected**: 
  - Clear error message about port already in use
  - Worker not started or marked as ERROR
  - After conflict resolved, worker starts normally

#### Test 2.3: Missing Executable Handling
- **Description**: Verify that missing RPC worker executable is handled
- **Procedure**:
  1. Rename or move ggml-rpc-server.exe temporarily
  2. Configure local RPC worker
  3. Start swarm_node.exe
  4. Check error logs
  5. Restore executable
  6. Restart swarm_node.exe
  7. Verify worker starts successfully
- **Expected**: 
  - Clear error about missing executable
  - Worker marked as ERROR
  - After restoring, worker starts normally

#### Test 2.4: Unexpected Worker Termination
- **Description**: Verify that unexpected worker termination is detected
- **Procedure**:
  1. Start swarm_node.exe with one worker
  2. Wait for worker to reach READY state
  3. Manually terminate the worker process (taskkill)
  4. Check that worker state updates to ERROR or UNAVAILABLE
  5. Check that error is logged
- **Expected**: 
  - Worker state changes appropriately
  - Error logged with details
  - Gateway continues to operate

### 3. Health and Status Tests

#### Test 3.1: Health Endpoint
- **Description**: Verify /health endpoint returns correct information
- **Procedure**:
  1. Start swarm_node.exe with valid configuration
  2. Send GET request to /health
  3. Check response
- **Expected**: 
  - Status code: 200
  - JSON response with server, model, context, inference, and workers sections
  - inference.ready true when model loaded and workers available
  - workers section shows configured workers with correct states

#### Test 3.2: Workers Endpoint
- **Description**: Verify /workers endpoint returns worker information
- **Procedure**:
  1. Start swarm_node.exe with worker configuration
  2. Send GET request to /workers
  3. Check response
- **Expected**: 
  - Status code: 200
  - JSON array of worker objects
  - Each worker has id, host, port, type, state, etc.
  - States reflect actual worker conditions

#### Test 3.3: Metrics Endpoint
- **Description**: Verify /metrics endpoint returns Prometheus-format metrics
- **Procedure**:
  1. Start swarm_node.exe
  2. Send GET request to /metrics
  3. Check response
- **Expected**: 
  - Status code: 200
  - Text/plain response
  - Contains metric definitions and values
  - Includes worker state metrics

### 4. Error Handling Tests

#### Test 4.1: Invalid JSON Handling
- **Description**: Verify proper error response for malformed JSON
- **Procedure**:
  1. Start swarm_node.exe
  2. Send POST request with invalid JSON body to /v1/chat/completions
  3. Check response status and body
- **Expected**: 
  - Status code: 400
  - Body: {"error":"invalid JSON"}

#### Test 4.2: Missing Messages Field
- **Description**: Verify error when messages field is missing
- **Procedure**:
  1. Start swarm_node.exe
  2. Send POST request with JSON missing "messages" field
  3. Check response
- **Expected**: 
  - Status code: 400
  - Body: {"error":"messages is required"}

#### Test 4.3: Invalid Max Tokens
- **Description**: Verify error handling for out-of-range max_tokens
- **Procedure**:
  1. Start swarm_node.exe
  2. Send request with max_tokens=0
  3. Send request with max_tokens=513
  4. Check responses
- **Expected**: 
  - Status code: 400 for both
  - Body: {"error":"max_tokens must be 1..512"}

### 5. Inference Tests (Resource Permitting)

#### Test 5.1: CUDA-only Inference
- **Description**: Verify that CUDA-only mode still works
- **Procedure**:
  1. Set SWARM_USE_RPC=0 (or disable all workers)
  2. Start swarm_node.exe
  3. Send test prompt via PowerShell Invoke-RestMethod
  4. Verify response
- **Expected**: 
  - Gateway starts without RPC workers
  - Streaming response received
  - Coherent answer generated
  - Proper [DONE] termination

#### Test 5.2: Legacy Single-RPC Inference
- **Description**: Verify that legacy single-worker mode still works
- **Procedure**:
  1. Ensure no SWARM_WORKER_* variables set (to trigger legacy mode)
  2. Set SWARM_USE_RPC=1 and SWARM_RPC_ENDPOINT=127.0.0.1:50052
  3. Start RPC worker: .\build\bin\Release\ggml-rpc-server.exe --host 127.0.0.1 --port 50052
  4. Start swarm_node.exe
  5. Send test prompt
  6. Verify response
- **Expected**: 
  - Gateway starts and connects to RPC worker
  - Streaming response received
  - Coherent answer generated
  - Proper [DONE] termination

#### Test 5.3: Multi-RPC Worker Inference (If Supported)
- **Description**: Verify that multiple RPC workers can participate in same inference
- **Procedure**:
  1. Configure two local RPC workers
  2. Start both RPC workers
  3. Start swarm_node.exe
  4. Send test prompt
  5. Monitor logs for evidence of both workers participating
  6. Check that request completes successfully
- **Expected**: 
  - If upstream supports multi-backend inference:
    - Both workers show state changes to BUSY during request
    - Logs indicate both workers participating
    - Successful response generated
  - If upstream does not support multi-backend inference:
    - Only one worker used (or fallback behavior)
    - This would be documented as a limitation

### 6. Failure Handling Tests

#### Test 6.1: Worker Failure During Inference
- **Description**: Verify handling of worker failure during active request
- **Procedure**:
  1. Start swarm_node.exe with two workers
  2. Start a long-running request (high max_tokens)
  3. While request is processing, terminate one worker process
  4. Check response and logs
- **Expected**: 
  - Request either completes with available workers or returns error
  - Error logged with details about worker failure
  - Gateway continues to operate for subsequent requests

#### Test 6.2: Shutdown Signal Handling
- **Description**: Verify that CTRL+C triggers graceful shutdown
- **Procedure**:
  1. Start swarm_node.exe in background
  2. Send CTRL+C signal
  3. Wait for process termination
  4. Check shutdown logs
- **Expected**: 
  - Process terminates cleanly
  - Log shows shutdown message
  - Worker processes stopped
  - No error codes or crash dialogs

## Test Execution Instructions

### Setting Up Test Environment
```powershell
# Navigate to project directory
cd C:\Users\kunal\OneDrive\Desktop\swarm

# Ensure build is up to date
# (Run build_swarm.bat if needed)

# For tests requiring RPC worker, start it first in a separate console:
# .\build\bin\Release\ggml-rpc-server.exe --host 127.0.0.1 --port 50052
```

### Running Configuration Tests
```powershell
# Test 1.1: Default configuration
$env:SWARM_MODEL_PATH = $null
$env:SWARM_HTTP_PORT = $null
# ... unset all SWARM_* variables
.\build-cuda\swarm_node.exe
# Observe startup logs, then terminate with CTRL+C after a few seconds
```

### Running API Tests
```powershell
# Start the server in background
Start-Process .\build-cuda\swarm_node.exe -WindowStyle Hidden

# Give it a moment to start
Start-Sleep -seconds 2

# Run tests using Invoke-RestMethod or curl
# Then stop the server when done
Stop-Process -Name swarm_node -Force
```

## Test Classification System

Each test result will be classified as:
- **PASS**: Test executed successfully and all assertions passed
- **FAIL**: Test executed but one or more assertions failed
- **BLOCKED**: Test could not be executed due to missing dependencies or resources
- **NOT RUN**: Test was not executed
- **NOT IMPLEMENTED**: Test procedure defined but feature not yet implemented

## Resource Considerations

To avoid overloading the development system (8GB RAM / 4GB VRAM):
- Only one instance of swarm_node.exe should run at a time
- RPC worker and gateway should not both be running with large models unless necessary for specific tests
- End-to-end tests should be limited in duration
- Test scripts should clean up processes after completion

## Baseline Measurements

Before running tests, record:
- Executable size and build timestamp
- DLL versions and timestamps
- Default startup behavior
- Memory usage at idle

These will help detect any regressions introduced by the changes.

---
*Test suite defined as of 2026-10-09*
*Tests to be executed in subsequent validation steps*