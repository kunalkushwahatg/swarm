# Swarm Desktop — Release Verification & Portability Report

**Target Platform:** Windows x64 (Windows 10 / 11)  
**Verification Date:** 2026-10-15  
**Evaluation Host:** Windows 10 x64, Intel CPU, 8 GB RAM, NVIDIA GeForce GTX 1050 (4 GB VRAM)  

---

## 1. Release Deliverables & Artifact Hashes

| Deliverable | Package Format | Location | Size (Bytes) | SHA-256 Hash |
| :--- | :--- | :--- | :--- | :--- |
| **Primary Installer (NSIS)** | Portable Windows Executable | `spike\desktop-shell\src-tauri\target\release\bundle\nsis\Swarm Desktop_0.1.0_x64-setup.exe` | 298,278,259 | `6aa04f6a5b6d0ea00ac66c8b616b7a139b7f3088c4001448427bf4bc0fb6e2aa` |
| **Enterprise Installer (MSI)** | WiX MSI Package | `spike\desktop-shell\src-tauri\target\release\bundle\msi\Swarm Desktop_0.1.0_x64_en-US.msi` | 451,379,200 | `0891618b756392cacbf64d080179d6e70f06e4c13ca16f0044a0ce381bf4dcf5` |
| **NSIS Checksum File** | SHA256 Text | `spike\desktop-shell\src-tauri\target\release\bundle\nsis\Swarm Desktop_0.1.0_x64-setup.exe.sha256` | 100 | — |
| **MSI Checksum File** | SHA256 Text | `spike\desktop-shell\src-tauri\target\release\bundle\msi\Swarm Desktop_0.1.0_x64_en-US.msi.sha256` | 94 | — |

---

## 2. High-Level Release Status Matrix

| Stage | Status | Notes |
| :--- | :---: | :--- |
| **Frontend Production Build** | **PASS** | React + Vite built to `ui/dist` in 10.50s (`index-B9aN5_GZ.js` 436.18 kB, `index-BEnasyqp.css` 46.29 kB). |
| **C++ Coordinator Release Build** | **PASS** | `build-cuda\bin\Release\swarm_node.exe` and GGML CUDA shared libraries built via CMake `Release` config. |
| **Rust Desktop Shell & Supervisor** | **PASS** | `cargo build --release` completed in 7m 17s producing `spike\desktop-shell\src-tauri\target\release\app.exe`. |
| **NSIS Installer Packaging** | **PASS** | Bundled app shell, coordinator, RPC worker, and CUDA runtime DLLs (284.46 MiB). |
| **MSI Installer Packaging** | **PASS** | Built via WiX 3.14 (`candle` and `light`) producing `Swarm Desktop_0.1.0_x64_en-US.msi` (430.47 MiB). |
| **Package Portability & Path Independence** | **PASS** | Installed app starts coordinator from installed `bin\` folder and resolves external model dynamically. |
| **Installed Package Smoke Test (Live Native)** | **PASS** | CDP-driven automation verified full launch, UI rendering, Standalone CUDA streaming, stop, and cleanup. |
| **Safe Uninstallation & Model Preservation** | **PASS** | Uninstaller removed application files cleanly without altering external GGUF models. |
| **Clean Separate-Computer Compatibility** | **NOT TESTED** | Physical verification on a separate, non-development clean PC could not be performed due to single-host availability. Tested strictly in isolated user-directory path on development machine. |

---

## 3. Detailed Verification Results (Phase 4 Checks)

| # | Check Description | Status | Evidence / Observed Output |
| :-: | :--- | :---: | :--- |
| **1** | Installed executable launches | **PASS** | Launched `C:\Users\kunal\AppData\Local\SwarmDesktopRC\app.exe` via spawn; PID spawned, WebView2 attached. |
| **2** | React UI loads; all 4 nav sections accessible | **PASS** | Tested `#nav-chat`, `#nav-devices`, `#nav-session`, and `#nav-settings`. Each rendered appropriate headers and panels without runtime errors. |
| **3** | Application starts and stops inference engine | **PASS** | Started engine via UI dialog (`#profile-standalone-cuda` -> `#start-engine-btn` -> `#confirm-launch-btn`); stopped via `#topbar-stop-engine-btn`. |
| **4** | Coordinator starts from installed resources | **PASS** | Supervisor diagnostics confirmed `coord_executable: C:\Users\kunal\AppData\Local\SwarmDesktopRC\bin\swarm_node.exe` (`exists: true`), not source tree. |
| **5** | External model discovered at documented location | **PASS** | Model resolved dynamically to `%LocalAppData%\Swarm\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf` (`2,104,932,768` bytes). |
| **6** | Standalone CUDA inference passes guards & streams | **PASS** | Health reached `inference.ready: true` in 8,120 ms. Chat prompt `"Reply with exactly: SWARM RC TEST SUCCESS"` yielded streamed tokens at **19.2 tok/s** (579 ms TTFT). |
| **7** | RPC-enabled profile & local worker prerequisites | **PASS** | Preflight guards properly evaluated RAM (1214 MB available vs 1500 MB required), correctly reporting deficit and preventing illegal out-of-memory cluster starts. |
| **8** | Missing models & port conflicts handled | **PASS** | Error handling validated; port 8080 guard asserts port availability; missing model outputs clear setup instructions to `%ProgramData%\Swarm\models` / `%LocalAppData%\Swarm\models`. |
| **9** | Application cleanup & port release | **PASS** | When engine stopped, `swarm_node.exe` exited cleanly within 2 seconds; port 8080 was confirmed released; app shutdown left 0 orphan processes. |
| **10** | Uninstallation removes files, preserves model | **PASS** | Silent uninstallation via `uninstall.exe /S` deleted `app.exe` and installed `bin\` folder; external model `qwen2.5-3b-instruct-q4_k_m.official-check.gguf` remained intact with exact byte size (`2,104,932,768` bytes). |

---

## 4. Portability & Runtime Dependency Analysis

### Bundled vs Host Prerequisites
- **Bundled in Package (`bin\` folder):**
  - `swarm_node.exe` (C++ Coordinator)
  - `ggml-rpc-server.exe` (RPC Worker)
  - `llama.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`, `ggml-cuda.dll`, `ggml-rpc.dll` (Engine core libraries)
  - `cudart64_12.dll`, `cublas64_12.dll`, `cublasLt64_12.dll` (CUDA 12 runtime redistributables)
- **Host System Prerequisites (Not Bundled):**
  - `nvcuda.dll`: Provided by host NVIDIA Display Driver (Driver version >= 527.41 required).
  - `msvcp140.dll`, `vcruntime140.dll`: Microsoft Visual C++ 2015–2022 Redistributable (x64).
  - Microsoft Edge WebView2 Evergreen Runtime.

### Path Independence
The application dynamically uses `std::env::current_exe()` to anchor its native binary search path (`<exe_dir>\bin` and `<exe_dir>`). At no point during execution did the installed application invoke binaries or libraries from `C:\Users\kunal\OneDrive\Desktop\swarm`.

---

## 5. Dependency & Licensing Notices Checklist

### Inventory of Bundled Components & Licenses

| Component | Upstream Project | License | Included in Package | Upstream Notice Status |
| :--- | :--- | :--- | :---: | :--- |
| **Tauri Desktop Shell** | Tauri Apps (`tauri-apps/tauri`) | MIT / Apache-2.0 | Yes (executable) | Standard crate metadata in Cargo.lock. |
| **React UI & Icons** | React (`facebook/react`), Lucide (`lucide-react`) | MIT | Yes (compiled assets) | Present in node_modules; bundled into webview assets. |
| **C++ Inference Engine** | GGML / llama.cpp (`ggerganov/llama.cpp`) | MIT | Yes (`llama.dll`, `ggml*.dll`) | Notice required by MIT terms. |
| **RPC Worker** | GGML RPC (`ggml-rpc-server.exe`) | MIT | Yes | Notice required by MIT terms. |
| **CUDA Runtime DLLs** | NVIDIA Corporation | NVIDIA CUDA Toolkit EULA | Yes (`cudart64_12.dll`, `cublas*.dll`) | Allowed for redistribution under EULA Attachment A. |
| **MSVC Runtime** | Microsoft Corporation | Microsoft Visual Studio EULA | Dependent (Host) | End-user redistributable terms apply. |

### Identified Missing Notices
> [!IMPORTANT]
> The repository currently lacks a top-level `LICENSE` file and an aggregated `THIRD-PARTY-NOTICES.txt` / `NOTICES.md` file in the project root. While component licenses are standard permissive (MIT / Apache-2.0 / NVIDIA Redistributable), for formal public distribution, a centralized notice file acknowledging the copyright notices of Georgi Gerganov & llama.cpp contributors and NVIDIA redistributable notices should be added before general release.
