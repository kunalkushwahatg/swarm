# Project context

Swarm is an experimental C++ distributed-inference gateway. Its long-term goal
is to serve models larger than one device can comfortably hold by using multiple
devices with limited individual RAM and VRAM. The current implementation is
still a local gateway with an experimental GGML RPC integration; it is not yet a
general distributed scheduler.

## Environment

- Windows development host.
- Visual Studio 2022 Build Tools and NMake Makefiles.
- NVIDIA GeForce GTX 1050, compute capability 6.1, approximately 4 GiB VRAM.
- Bundled [llama.cpp](../llama.cpp/) supplies llama.cpp, GGML, CUDA, and RPC.
- The active build enables CUDA and GGML RPC with CUDA architecture 61.

## Baseline model

The validated baseline is
`models/qwen2.5-3b-instruct-q4_k_m.official-check.gguf`.
Its SHA-256 is
`626B4A6678B86442240E33DF819E00132D3BA7DDDFE1CDC4FBB18E0A9615C62D`.
It produces sensible output in the independent CPU reference and in Swarm CPU,
CUDA, and loopback-RPC tests.

The separate `models/qwen2.5-3b-instruct-q4_k_m.gguf` file is retained as an
unverified diagnostic artifact. Its SHA-256 differs:
`B7AA5CE06C2B483A582B81CFC6EF3C379DE3D341BD1C30B69B60396786526A82`.
The original produced non-meaningful output in the reference test, but this
project does not claim a complete forensic proof of corruption.

## Maturity

The local CUDA path is a working baseline. The RPC path has been validated on
loopback using a CPU RPC server, including remote buffer allocation and remote
layer placement. Loopback is not a substitute for a second-device test. Worker
scheduling, balancing, failover, dynamic model recreation, and real-LAN
performance remain unvalidated.

