# Two-worker loopback RPC test

## Commands

Two independently managed CPU RPC servers were started with:

```bat
temp_rpc_build\bin\ggml-rpc-server.exe --host 127.0.0.1 --port 50052 --threads 2
temp_rpc_build\bin\ggml-rpc-server.exe --host 127.0.0.1 --port 50053 --threads 2
```

Swarm was started with:

```bat
set SWARM_USE_RPC=1
set SWARM_RPC_ENDPOINTS=127.0.0.1:50052,127.0.0.1:50053
set SWARM_MODEL_PATH=C:\Users\kunal\OneDrive\Desktop\swarm\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf
set SWARM_N_GPU_LAYERS=4
set SWARM_CTX_SIZE=2048
set SWARM_MAX_TOKENS_DEFAULT=16
set SWARM_HTTP_BIND=127.0.0.1
set SWARM_HTTP_PORT=8080
```

The request was:

```json
{"messages":[{"role":"user","content":"What is 2 + 2?"}],"max_tokens":16,"temperature":0,"stream":false}
```

## Successful clean run

- RPC A: `127.0.0.1:50052`, PID `10184`.
- RPC B: `127.0.0.1:50053`, PID `12928`.
- Swarm: PID `19620`, HTTP `127.0.0.1:8080`.
- Registration: `RPC0` and `RPC1` registered before model loading.
- Placement: layer 33 on RPC0, layer 34 on RPC1, layers 35-36 on CUDA0.
- Remote buffers: model, KV, and compute buffers allocated on both RPC devices.
- Prompt logits: `151936` finite, `0` nonfinite.
- Response: `2 + 2 equals 4.`
- Worker resources after inference:
  - RPC A: approximately `1.02` CPU seconds, `58.3 MiB` working set.
  - RPC B: approximately `1.05` CPU seconds, `58.4 MiB` working set.

The two workers reported the same approximately `7.84 GiB` total memory view.
They are processes on one host and do not provide additive independent memory.

## Failure test

Worker B was stopped while the model/context was loaded. The next request
failed with an RPC transport error, and the Swarm process terminated. Worker B
was restarted on port `50053` (PID `21428`), but the existing Swarm process did
not recover because it had already terminated. A clean Swarm restart is the
documented recovery path.

## Files

- `clean-swarm.stdout.log` and `clean-swarm.stderr.log` contain the successful
  run and placement evidence.
- `fallback-swarm.stdout.log` and `fallback-swarm.stderr.log` contain the
  RPC-disabled CUDA fallback check.
- `rpc-50052*.log` and `rpc-50053*.log` contain the independently redirected
  worker logs.

## Source and rollback

Affected source files:

- `config.h` — final SHA-256:
  `6B10AD1A5BEBE9E9D0DA4A065D2F70BC178BA9049B4200951C82E6920B89B841`
- `main.cpp` — final SHA-256:
  `394E96987479B9D27EBC54ED96418589AED283F39B21FF567D70FCAB5292DFE2`

Pre-edit copies and hashes are preserved under:

`C:\Users\kunal\.copilot\session-state\e7cae967-b0d7-4b35-b24e-d625c68fc156\files\multi-rpc-before-edit`

The final executable is
`build-cuda\swarm_node.exe` with SHA-256
`57AC8093F23CCDFA909DB5D17D2F8F96D27B614A485B13CA275E70457B416A2A`.
