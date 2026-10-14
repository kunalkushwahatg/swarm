# Build and run

## Build

The verified build uses Visual Studio 2022 Build Tools, the `NMake Makefiles`
generator, Release configuration, CUDA architecture 61, and the existing
`build-cuda` directory:

```bat
cmake -S C:\Users\kunal\OneDrive\Desktop\swarm ^
  -B C:\Users\kunal\OneDrive\Desktop\swarm\build-cuda ^
  -G "NMake Makefiles" ^
  -DGGML_CUDA=ON -DGGML_RPC=ON -DGGML_BACKEND_DL=OFF ^
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_ARCHITECTURES=61
cmake --build C:\Users\kunal\OneDrive\Desktop\swarm\build-cuda --target swarm_node
```

`build_swarm.bat` performs the same environment setup, configuration, target
build, executable check, and required-DLL check. Do not delete `build-cuda` to
force a rebuild.

## Local CUDA baseline

Run from `build-cuda` with its `bin` directory available on `PATH`:

```bat
set SWARM_USE_RPC=0
set SWARM_MODEL_PATH=C:\Users\kunal\OneDrive\Desktop\swarm\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf
set SWARM_N_GPU_LAYERS=-1
set PATH=C:\Users\kunal\OneDrive\Desktop\swarm\build-cuda\bin;%PATH%
swarm_node.exe
```

`SWARM_N_GPU_LAYERS=0` requests CPU-only inference. A non-negative positive
integer requests that many GPU layers. `-1` requests all layers and is
supported by the bundled llama.cpp version.

## Loopback RPC

RPC is opt-in:

```bat
set SWARM_USE_RPC=1
set SWARM_RPC_ENDPOINT=127.0.0.1:50052
set SWARM_N_GPU_LAYERS=4
```

For two independently managed loopback RPC servers, use:

```bat
set SWARM_USE_RPC=1
set SWARM_RPC_ENDPOINTS=127.0.0.1:50052,127.0.0.1:50053
set SWARM_N_GPU_LAYERS=4
```

`SWARM_RPC_ENDPOINTS` registers every listed endpoint before model loading.
The singular `SWARM_RPC_ENDPOINT` remains a backward-compatible alternative.
These endpoints are externally managed: Swarm does not launch or restart their
server processes.

The compatible CPU RPC server used by the validated test is:

```bat
C:\Users\kunal\OneDrive\Desktop\swarm\temp_rpc_build\bin\ggml-rpc-server.exe ^
  --host 127.0.0.1 --port 50052 --threads 4
```

Keep the experimental RPC protocol on loopback or a trusted private interface.
The current implementation does not validate a real second-device deployment.

## HTTP checks

With Swarm listening on port 8080:

```bat
curl.exe --fail http://127.0.0.1:8080/health
curl.exe --fail http://127.0.0.1:8080/workers
curl.exe --fail http://127.0.0.1:8080/metrics
curl.exe --fail --no-buffer -H "Content-Type: application/json" ^
  --data-binary "@C:\Users\kunal\OneDrive\Desktop\swarm\artifacts\validation\2026-10-10\gpu_sweep.request.json" ^
  http://127.0.0.1:8080/v1/chat/completions
```

The commands above reflect the validated local setup. The two-worker loopback
simulation is documented in `VALIDATION_STATUS.md`; it is not a real-LAN test
and does not provide independent memory capacity.
