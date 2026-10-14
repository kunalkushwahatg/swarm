# Swarm Phase 1 Test Suite

## Test Overview

This document outlines the test suite for Phase 1 improvements, focusing on:
- Configuration loading and validation
- Logging functionality
- Request ID generation
- Error handling
- Graceful shutdown
- Health endpoint (planned)

Due to resource constraints and the need to avoid multiple large-model instances, most tests are unit-level or use mocks where appropriate. One end-to-end test with the Qwen2.5-3B model is included if resources permit.

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
  - RPC endpoint: 127.0.0.1:50052
  - Context size: 2048
  - Default max tokens: 50
  - Log timestamps: true

#### Test 1.2: Environment Variable Override
- **Description**: Verify that environment variables override defaults
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
  - Other values remain defaults

#### Test 1.3: Invalid Configuration Handling
- **Description**: Verify graceful handling of invalid configuration values
- **Procedure**:
  1. Set SWARM_HTTP_PORT=invalid
  2. Start swarm_node.exe
  3. Check that default port (8080) is used
  4. Set SWARM_CTX_SIZE=-1
  5. Check that default context size (2048) is used
- **Expected**: Invalid values fall back to defaults without crashing

### 2. Logging Tests

#### Test 2.1: Log Levels and Format
- **Description**: Verify that INFO, WARN, and ERROR logs are produced with correct format
- **Procedure**:
  1. Start swarm_node.exe
  2. Send a valid request to trigger INFO logs
  3. Send an invalid JSON request to trigger WARN/ERROR logs
  4. Check log output format
- **Expected**: 
  - Logs include timestamp when SWARM_LOG_TIMESTAMPS=true
  - Format: [TIMESTAMP] LEVEL: message
  - Correct level for each message type

#### Test 2.2: Timestamp Control
- **Description**: Verify that timestamps can be disabled
- **Procedure**:
  1. Set SWARM_LOG_TIMESTAMPS=0
  2. Start swarm_node.exe
  3. Check log output
- **Expected**: Logs do not contain timestamps

### 3. Request ID Tests

#### Test 3.1: Request ID Generation
- **Description**: Verify that each request gets a unique ID
- **Procedure**:
  1. Start swarm_node.exe
  2. Send two separate requests
  3. Capture streaming responses
  4. Extract request IDs from responses
- **Expected**: 
  - Each response contains an "id" field
  - IDs are different for each request
  - IDs are positive 64-bit integers

#### Test 3.2: Request ID in Logs
- **Description**: Verify that request IDs appear in log messages
- **Procedure**:
  1. Start swarm_node.exe
  2. Send a request
  3. Check log output for request ID
- **Expected**: 
  - Log messages include [" + request_id + "] prefix
  - ID matches the one in the response

### 4. Error Handling Tests

#### Test 4.1: Invalid JSON Handling
- **Description**: Verify proper error response for malformed JSON
- **Procedure**:
  1. Start swarm_node.exe
  2. Send POST request with invalid JSON body
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

### 5. Health Endpoint Tests (Planned for Implementation)

#### Test 5.1: Health Endpoint Exists
- **Description**: Verify /health endpoint is available
- **Procedure**:
  1. Start swarm_node.exe
  2. Send GET request to /health
  3. Check response
- **Expected**: 
  - Status code: 200
  - JSON response with status information

#### Test 5.2: Health Endpoint Content
- **Description**: Verify health endpoint reports correct status
- **Procedure**:
  1. Start swarm_node.exe with valid configuration
  2. Send GET request to /health
  3. Check response fields
- **Expected**: 
  - server: "running"
  - model: "loaded" (if model loads successfully)
  - rpc: "connected" or "disabled" as appropriate
  - inference: "ready"

### 6. Graceful Shutdown Tests

#### Test 6.1: Shutdown Signal Response
- **Description**: Verify that CTRL+C triggers graceful shutdown
- **Procedure**:
  1. Start swarm_node.exe in background
  2. Send CTRL+C signal
  3. Wait for process termination
  4. Check shutdown logs
- **Expected**: 
  - Process terminates cleanly
  - Log shows shutdown message
  - No error codes or crash dialogs

#### Test 6.2: Active Request Handling During Shutdown
- **Description**: Verify shutdown waits for active requests
- **Procedure**:
  1. Start swarm_node.exe
  2. Send a long-running request (high max_tokens)
  3. Immediately send CTRL+C
  4. Verify request completes before shutdown
- **Expected**: 
  - Request finishes and returns [DONE]
  - Then shutdown proceeds
  - No truncated responses

### 7. End-to-End Functional Test (Resource Permitting)

#### Test 7.1: Mixed CUDA+RPC Inference
- **Description**: Verify that the core inference functionality still works
- **Procedure**:
  1. Start RPC worker: `build/bin/Release/ggml-rpc-server.exe --host 127.0.0.1 --port 50052`
  2. Start gateway: `SWARM_USE_RPC=1 SWARM_RPC_ENDPOINT=127.0.0.1:50052 .\build-cuda\swarm_node.exe`
  3. Send test prompt via PowerShell Invoke-RestMethod
  4. Verify response
- **Expected**: 
  - Gateway starts and shows device report
  - RPC worker accepts connection
  - Streaming response received
  - Coherent answer generated
  - Proper [DONE] termination

#### Test 7.2: CUDA-Only Mode
- **Description**: Verify CUDA-only mode still works
- **Procedure**:
  1. Start gateway: `SWARM_USE_RPC=0 .\build-cuda\swarm_node.exe`
  2. Send test prompt
  3. Verify response
- **Expected**: 
  - Gateway starts without RPC worker
  - Streaming response received
  - Coherent answer generated

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