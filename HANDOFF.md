# SwarmNode Handoff

## Project

This workspace is a C++ llama.cpp application named `swarm_node`.

Important paths:

- Source: `main.cpp`
- Build configuration: `CMakeLists.txt`
- llama.cpp checkout: `llama.cpp/`
- Model: `models/llama-3-8b.gguf`
- CPU/RPC build: `build/`
- CUDA/RPC build: `build-cuda/`

The model file is approximately 4.9 GB.

## Current Application Behavior

`main.cpp` starts an HTTP gateway on:

```text
http://localhost:8080
```

It exposes:

```text
POST /v1/chat/completions
```

The request must contain a non-empty `messages` array. Each message should contain `role` and string `content` fields. `max_tokens` defaults to 50 and must be between 1 and 512.

Responses are streamed as Server-Sent Events:

```text
data: {"choices":[{"delta":{"content":"..."}}]}

data: [DONE]
```

Inference is serialized with a mutex, so requests run one at a time.

## Device Modes

The current code requires a local CUDA GPU and supports an optional RPC worker.

RPC is enabled by default. The environment variable controls it:

```text
SWARM_USE_RPC=1  Mixed CUDA + RPC mode (default)
SWARM_USE_RPC=0  Local CUDA-only mode
```

In mixed mode, the code explicitly registers these devices in this order:

1. RPC device at `127.0.0.1:50052`
2. Local CUDA GPU
3. Null terminator

llama.cpp uses layer-based placement across the registered devices. It does not split the model by exact file-size percentage.

In the successful mixed-mode test, the model was approximately distributed as:

```text
RPC CPU/RAM: layers 0-14
Local CUDA/VRAM: layers 15-31
```

The exact split can change based on available memory.

The RPC worker used during testing was CPU-only. Therefore:

- Local CUDA layers use the GTX 1050 GPU and VRAM.
- RPC layers use the CPU and system RAM.
- RPC inference traffic uses the RPC TCP connection.

## CUDA Build

The local GPU is:

```text
NVIDIA GeForce GTX 1050
Compute capability: 6.1
VRAM: 4096 MiB
```

CUDA compiler/toolkit:

```text
CUDA toolkit: 12.6.20
NVIDIA driver-reported CUDA compatibility: 12.5
```

The CUDA build uses:

```text
GGML_CUDA=ON
GGML_RPC=ON
GGML_BACKEND_DL=OFF
CMAKE_CUDA_ARCHITECTURES=61
CMAKE_BUILD_TYPE=Release
```

`CMAKE_CUDA_ARCHITECTURES=61` is correct for the GTX 1050. Do not use 75 for this GPU.

The build uses the Visual Studio 2022 Build Tools developer environment because the Visual Studio 2026 toolset/CUDA compiler detection path stalled. The working build generator is `NMake Makefiles`.

## Build Commands

Open the workspace root in PowerShell:

```powershell
cd C:\Users\kunal\OneDrive\Desktop\swarm
```

Build the CUDA/RPC target:

```powershell
cmd /c 'call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" && cmake -S . -B build-cuda -G "NMake Makefiles" -DGGML_CUDA=ON -DGGML_RPC=ON -DGGML_BACKEND_DL=OFF -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_ARCHITECTURES=61 && cmake --build build-cuda --target swarm_node'
```

Expected result:

```text
[100%] Built target swarm_node
```

Executable:

```text
build-cuda\swarm_node.exe
```

## Run: CUDA-Only Mode

Stop stale processes first if needed:

```powershell
Get-Process swarm_node,ggml-rpc-server -ErrorAction SilentlyContinue | Stop-Process -Force
```

Set the environment and start the app:

```powershell
$env:SWARM_USE_RPC = "0"
$env:PATH = "$PWD\build-cuda\bin;$env:PATH"
.\build-cuda\swarm_node.exe
```

The app should eventually listen on port 8080.

Check readiness from another terminal:

```powershell
Test-NetConnection 127.0.0.1 -Port 8080 -InformationLevel Quiet
```

Expected:

```text
True
```

## Run: Mixed CUDA + RPC Mode

Use two terminals.

### Terminal 1: RPC Worker

The current RPC worker binary is from the CPU/RPC build:

```powershell
$env:PATH = "$PWD\build\bin\Release;$env:PATH"
.\build\bin\Release\ggml-rpc-server.exe --host 127.0.0.1 --port 50052 --threads 8
```

Leave this terminal running.

The worker reports a CPU device. It does not use the GTX 1050 GPU. To use a remote GPU, build the RPC worker itself with the appropriate CUDA backend on that remote machine.

### Terminal 2: CUDA App

```powershell
$env:SWARM_USE_RPC = "1"
$env:PATH = "$PWD\build-cuda\bin;$PWD\build\bin\Release;$env:PATH"
.\build-cuda\swarm_node.exe
```

The app connects to `127.0.0.1:50052`, loads the model, splits layers across RPC and local CUDA, and listens on port 8080.

Check both ports:

```powershell
Test-NetConnection 127.0.0.1 -Port 50052 -InformationLevel Quiet
Test-NetConnection 127.0.0.1 -Port 8080 -InformationLevel Quiet
```

## Send a Prompt

Use a third terminal after port 8080 is ready:

```powershell
$body = @{
  messages = @(
    @{
      role = "user"
      content = "Hello"
    }
  )
  max_tokens = 64
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Uri "http://127.0.0.1:8080/v1/chat/completions" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

Example coding prompt:

```powershell
$body = @{
  messages = @(
    @{
      role = "user"
      content = "Give Python code for the three sum problem."
    }
  )
  max_tokens = 128
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Uri "http://127.0.0.1:8080/v1/chat/completions" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

Use `Invoke-RestMethod` rather than `curl.exe` from PowerShell because PowerShell quoting can cause the JSON body to arrive malformed.

## Monitoring

GPU usage:

```powershell
nvidia-smi -l 1
```

Process and memory usage:

```powershell
Get-Process swarm_node,ggml-rpc-server | Select-Object Id,ProcessName,CPU,PM,WS
```

Ports:

```powershell
Get-NetTCPConnection -LocalPort 50052,8080 -ErrorAction SilentlyContinue
```

## Cleanup

Stop the app and worker:

```powershell
Get-Process swarm_node,ggml-rpc-server -ErrorAction SilentlyContinue | Stop-Process -Force
```

## Important Debugging History

### Old llama.cpp API

The original source used an older llama.cpp API:

- `llama_tokenize(model, ...)` was changed to use `llama_model_get_vocab(model)`.
- `llama_token_to_piece(model, ...)` was changed to use the vocabulary.
- Removed `llama_batch_add()` usage and populated batch fields directly.
- Deprecated model functions were replaced with current names.

### One-token output

The original sample generated only one token. The current HTTP gateway generates up to `max_tokens` tokens and streams each token piece.

### CUDA configuration

CMake initially stalled after `CUDA Toolkit found` while using the Visual Studio generator. The working solution was:

- VS 2022 Build Tools developer environment
- `NMake Makefiles`
- CUDA architecture `61`
- Static backend libraries with `GGML_BACKEND_DL=OFF`
- Both `GGML_CUDA=ON` and `GGML_RPC=ON`

### Link fixes

The gateway uses `httplib::Server`, so `httplib.cpp` is compiled directly in the executable by `CMakeLists.txt`. The target links `llama` and `ggml-rpc`.

### Mixed-backend crash

An earlier version allowed llama.cpp to discover CPU, CUDA, and RPC implicitly. It crashed with a Visual C++ `abort()` dialog after scheduler setup. The crash was traced to the optional `get_device_report()` call after context creation. The call is no longer made during startup.

The device-report helper functions remain in `main.cpp`, but they are not called. Do not re-enable them without testing backend enumeration after context creation.

### Device-list bug

When RPC was disabled, a device array beginning with `nullptr` accidentally prevented CUDA from being selected. The current code places CUDA first when `SWARM_USE_RPC=0`.

## Current Limitations

- The RPC worker used in testing is CPU-only.
- Mixed CUDA+CPU-RPC can be slower than local CUDA because RPC graph and tensor traffic still crosses the RPC interface.
- The model is large for an 8 GB RAM laptop and a 4 GB GTX 1050. Close other applications before loading it.
- The app currently uses a fixed RPC endpoint: `127.0.0.1:50052`.
- The app currently uses a fixed model path: `models/llama-3-8b.gguf`.
- The HTTP API does not yet expose model path, RPC endpoint, or device split as request/configuration options.
- The model appears to behave like a base model, so responses may not follow chat instructions perfectly. An instruct-tuned GGUF model would likely produce better answers.
- RPC has no authentication or encryption. Use only on a trusted network if changing the endpoint to a remote machine.

## Handoff Summary

The verified working path is:

1. Build `build-cuda\swarm_node.exe` with CUDA 12.6, architecture 61, and RPC enabled.
2. For CUDA-only testing, set `SWARM_USE_RPC=0` and run the app.
3. For mixed testing, start `build\bin\Release\ggml-rpc-server.exe` on port 50052, set `SWARM_USE_RPC=1`, and run the CUDA app.
4. Wait for port 8080.
5. Send prompts to `/v1/chat/completions` using `Invoke-RestMethod`.
6. Monitor `nvidia-smi` and process memory to verify CUDA/RPC placement.
