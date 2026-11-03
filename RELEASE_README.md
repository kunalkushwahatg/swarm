# Swarm Desktop — Release Candidate (Windows x64)

Swarm is a high-performance desktop application for local and distributed LLM inference built on Tauri 2, React, Rust, and a C++ GGML/llama.cpp inference engine.

---

## 1. Release Deliverables

| Deliverable | Format | File Path | Size | SHA-256 Checksum |
| :--- | :--- | :--- | :--- | :--- |
| **Swarm Desktop Installer (Recommended)** | NSIS Setup | `spike\desktop-shell\src-tauri\target\release\bundle\nsis\Swarm Desktop_0.1.0_x64-setup.exe` | 298,278,259 bytes (284.46 MiB) | `6aa04f6a5b6d0ea00ac66c8b616b7a139b7f3088c4001448427bf4bc0fb6e2aa` |
| **Swarm Desktop MSI Installer** | WiX MSI | `spike\desktop-shell\src-tauri\target\release\bundle\msi\Swarm Desktop_0.1.0_x64_en-US.msi` | 451,379,200 bytes (430.47 MiB) | `0891618b756392cacbf64d080179d6e70f06e4c13ca16f0044a0ce381bf4dcf5` |
| **NSIS Checksum File** | SHA256 | `spike\desktop-shell\src-tauri\target\release\bundle\nsis\Swarm Desktop_0.1.0_x64-setup.exe.sha256` | 100 bytes | — |
| **MSI Checksum File** | SHA256 | `spike\desktop-shell\src-tauri\target\release\bundle\msi\Swarm Desktop_0.1.0_x64_en-US.msi.sha256` | 94 bytes | — |

---

## 2. System Requirements

### Hardware Requirements
- **Architecture:** Windows 10 or Windows 11 (64-bit x86_64).
- **CPU:** x86_64 CPU with AVX2 support.
- **System RAM:** 
  - Minimum 1,000 MB available for Standalone Single-GPU profile.
  - Minimum 1,500 MB available for Distributed Cluster profile.
  - 8+ GB total system physical memory recommended.
- **GPU (for CUDA acceleration):**
  - NVIDIA GeForce, RTX, or Quadro GPU with Compute Capability >= 6.1 (Pascal or newer, e.g., GTX 1050+, GTX 1650+, RTX 2060+, RTX 30/40 series).
  - VRAM: Minimum 3,100 MiB free VRAM for full GPU layer offloading (Qwen 2.5 3B Q4_K_M).
- **Storage:** ~1.2 GB disk space for installed application binaries and CUDA runtime libraries; an additional 2.2 GB for the external GGUF model file.

### Prerequisites (Not Bundled in Installer)
1. **NVIDIA GPU Driver:**
   - NVIDIA Driver version **>= 527.41** (CUDA 12 compatible).
   - Driver provides `nvcuda.dll` in `C:\Windows\System32\nvcuda.dll`. **Do not attempt to bundle `nvcuda.dll` with the installer.**
2. **Microsoft Visual C++ Redistributable (x64):**
   - Visual Studio 2015–2022 x64 Runtime (`vc_redist.x64.exe`).
3. **Microsoft Edge WebView2 Runtime:**
   - Standard evergreen WebView2 runtime (pre-installed on Windows 10/11; bootstrapped automatically if absent).

---

## 3. Installation Instructions

### GUI Installation
1. Download `Swarm Desktop_0.1.0_x64-setup.exe`.
2. Verify the SHA-256 hash against `Swarm Desktop_0.1.0_x64-setup.exe.sha256`:
   ```cmd
   certutil -hashfile "Swarm Desktop_0.1.0_x64-setup.exe" SHA256
   ```
3. Double-click the installer and follow the on-screen instructions.
4. By default, Swarm installs per-user into:
   ```
   %LOCALAPPDATA%\Swarm Desktop\
   ```

### Silent / Enterprise Installation
To install silently without user prompts:
```cmd
"Swarm Desktop_0.1.0_x64-setup.exe" /S
```
To specify a custom installation directory:
```cmd
"Swarm Desktop_0.1.0_x64-setup.exe" /S /D=C:\CustomPath\Swarm
```
*(Note: `/D=` must be the final parameter and must not have enclosing quotes).*

---

## 4. External Model Setup

To keep the application installer compact and avoid duplicating multi-gigabyte models across updates, **the GGUF model file is external to the installer**.

### Verified Official Model
- **Model:** Qwen 2.5 3B Instruct (Quantization: `Q4_K_M`)
- **Filename:** `qwen2.5-3b-instruct-q4_k_m.official-check.gguf`
- **File Size:** `2,104,932,768` bytes (~2.0 GB)
- **SHA-256:** `9fe1b0b54e79ec3798cf0f1c3f91ba73ef2c10b7f61ad88b8d96096a666e8140`

### Model Directory Discovery Order
The installed supervisor locates the model in this order of precedence:
1. **Environment Variable:** `SWARM_MODEL_PATH` pointing directly to the `.gguf` file.
2. **System-wide Location:**
   ```
   %ProgramData%\Swarm\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf
   ```
3. **Per-user Location (Recommended):**
   ```
   %LocalAppData%\Swarm\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf
   ```
4. **Development Fallback:** `<workspace_root>\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf`

### Setup Command
Create the directory and place the model file:
```cmd
mkdir "%LOCALAPPDATA%\Swarm\models"
copy "path\to\qwen2.5-3b-instruct-q4_k_m.official-check.gguf" "%LOCALAPPDATA%\Swarm\models\"
```

If the model file is absent, the application launches normally and displays a clear diagnostic warning detailing the expected locations.

---

## 5. Runtime Profiles

Swarm provides two execution profiles selectable from the desktop UI:

### Profile A: Standalone Single-GPU (Low Memory) — `low_memory_cuda_standalone`
- **Target:** Single-computer desktop or laptop with a local NVIDIA GPU.
- **Topology:** Single-process coordinator (`swarm_node.exe`) directly utilizing local CUDA.
- **Offload:** Offloads all 37 model layers to GPU (`SWARM_N_GPU_LAYERS=-1`).
- **Context Size:** 512 tokens (`SWARM_CTX_SIZE=512`).
- **RPC Worker:** Not required (`SWARM_USE_RPC=0`).
- **Preflight Guards:**
  - System RAM >= 1,000 MB free.
  - GPU VRAM >= 3,100 MiB free.
  - Port 8080 free.

### Profile B: Standard Distributed Cluster — `default`
- **Target:** Multi-device inference or loopback RPC worker topology.
- **Topology:** Supervised C++ coordinator on port 8080 and local/remote RPC workers (`ggml-rpc-server.exe`) on port 50052.
- **Offload:** Hybrid GPU/RPC offloading.
- **Context Size:** 2048 tokens (`SWARM_CTX_SIZE=2048`).
- **Preflight Guards:**
  - System RAM >= 1,500 MB free.
  - Ports 8080 & 50052 free.

---

## 6. Remote Worker Setup

To connect a remote computer as an RPC worker:
1. On the worker machine, copy `dist\swarm-worker-windows-x64\` or run:
   ```cmd
   ggml-rpc-server.exe -H 0.0.0.0 -p 50052
   ```
2. In the Swarm Desktop application, navigate to the **Devices** section.
3. Click **Add Worker Computer**, enter the worker's IP address and port (e.g. `192.168.1.100:50052`), and click **Register Worker**.
4. The coordinator automatically verifies worker connectivity and incorporates it into the cluster topology.

---

## 7. Troubleshooting

| Issue | Cause | Solution |
| :--- | :--- | :--- |
| **"Official GGUF model not found"** | Model file is not in `%LocalAppData%\Swarm\models\` or `%ProgramData%\Swarm\models\`. | Download or copy the official model to `%LocalAppData%\Swarm\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf` or set `SWARM_MODEL_PATH`. |
| **"Port 8080 is already occupied"** | Another service or orphaned process is bound to port 8080. | Run `netstat -ano \| findstr :8080` to find the process ID and terminate it, or restart the desktop app. |
| **"RAM / VRAM deficit error"** | Free physical RAM < 1,000 MB or free VRAM < 3,100 MiB. | Close heavy background applications (browser tabs, games) to free memory. |
| **"Failed to load nvcuda.dll"** | NVIDIA display driver is missing or outdated. | Update to the latest official NVIDIA graphics driver (version >= 527.41) from nvidia.com. |
| **"Coordinator offline"** | Engine not started yet or crashed during initialization. | Go to Settings/Diagnostics to check the runtime log; ensure all preflight guards are green. |

---

## 8. Uninstallation

To cleanly remove Swarm:
1. Open Windows **Settings > Apps > Installed apps**, find **Swarm Desktop**, and click **Uninstall**.
2. Or run the uninstaller directly:
   ```cmd
   "%LOCALAPPDATA%\Swarm Desktop\uninstall.exe"
   ```
3. **Data Protection Guarantee:** Uninstallation removes installed application binaries and bundled libraries. It does **not** delete your external GGUF models (`%LocalAppData%\Swarm\models\` or `%ProgramData%\Swarm\models\`), telemetry tokens, or workspace projects.
