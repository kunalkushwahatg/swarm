# Workspace map

## Essential source

- `main.cpp` — gateway, model/context setup, HTTP routes, inference.
- `worker.cpp`, `worker.h` — worker lifecycle and retained RPC devices.
- `config.h` — environment configuration and defaults.
- `CMakeLists.txt` — Swarm target and llama.cpp linkage.
- `build_swarm.bat` — Windows configure/build/runtime-layout check.

## Dependencies and builds

- `llama.cpp/` — bundled llama.cpp, GGML, CUDA, and RPC source.
- `build-cuda/` — active Release CUDA+RPC Swarm build; preserve.
- `temp_rpc_build/` — compatible CPU RPC server build used by the loopback test.
- `build-rpc-server/` — older CPU RPC build; DLL compatibility requires checking.
- `llama.cpp/build/` — stale candidate; its
  `CMakeCache.txt` stores the exact source path
  `C:/Users/kunal/OneDrive/Desktop/llama.cpp-master/llama.cpp-master`, which is
  not the current bundled source. Do not reuse or delete without approval.
- `build-reference-cpu/` — absent.

## Models and evidence

- `models/` contains the verified official Qwen model, the original unverified
  Qwen artifact, and an additional retained model asset.
- `artifacts/validation/2026-10-10/` contains the moved CUDA, RPC, fallback, and
  benchmark logs, CSVs, responses, and request payload.
- `docs/` contains this documentation plus pre-existing notes under `audits/`,
  `implementation/`, and the existing writing notes.

Other duplicate build directories and older root logs remain untouched because
their ownership or compatibility was not established.
