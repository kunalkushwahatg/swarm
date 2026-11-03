# Swarm Production Deployment and Operational Hardening Guide

## 1. Architectural Deployment Modes

Swarm supports three operational profiles depending on the infrastructure environment and reliability requirements:

| Operational Mode | Target Environment | Networking & RPC | Telemetry & Security | Typical Use Case |
| :--- | :--- | :--- | :--- | :--- |
| **Mode A: Local CUDA** | Single GPU Workstation | `SWARM_USE_RPC=0`. Direct in-process CUDA execution. | Telemetry optional. No network RPC listening required. | Low-latency single-box inference, local development, baseline benchmarking. |
| **Mode B: Loopback Simulation** | Single Machine Testing | `SWARM_USE_RPC=1`. Workers bound to `127.0.0.1:50052`, `127.0.0.1:50053`. | Unauthenticated or token-authenticated loopback telemetry. | Integration testing, dynamic placement algorithm validation, multi-worker simulation without physical hardware. |
| **Mode C: Remote Multi-Computer (Production)** | Distributed Heterogeneous Cluster | `SWARM_USE_RPC=1`. Remote worker endpoints (e.g., `10.0.0.2:50052`). | `SWARM_DEPLOYMENT_ENV=production`. Mandatory token file auth. VPN tunnel encapsulation. | Real distributed tensor splitting across physical heterogeneous machines. |

---

## 2. Port and Listener Matrix

| Service | Default Port | Protocol | Encryption / Auth Status | Security Boundary & Recommendation |
| :--- | :--- | :--- | :--- | :--- |
| **Swarm Coordinator HTTP API** | `8080` (or `PORT`) | HTTP / REST | HTTP Bearer Token (`SWARM_TELEMETRY_TOKEN_FILE` / `SWARM_TELEMETRY_TOKEN`) | Exposes `/v1/chat/completions` and `/api/v1/nodes/report`. Reverse-proxy behind TLS in production (Nginx/Caddy) or bind strictly to private VPN interface. |
| **GGML RPC Worker 0** | `50052` | TCP (Custom GGML RPC) | **UNENCRYPTED, UNAUTHENTICATED** (Native GGML protocol limitation) | **CRITICAL:** Do NOT expose to public internet or untrusted LAN. Encapsulate exclusively within WireGuard / Tailscale VPN tunnel. |
| **GGML RPC Worker 1..N** | `50053`+ | TCP (Custom GGML RPC) | **UNENCRYPTED, UNAUTHENTICATED** (Native GGML protocol limitation) | Same as Worker 0. Bind exclusively to VPN mesh IP (e.g. `100.x.y.z` or `10.x.y.z`). |
| **Swarm Agent Telemetry** | Outbound to `8080` | HTTP POST | Bearer token authenticated, SHA-256 integrity checked | Outbound HTTP client reporting local CPU, RAM, and VRAM telemetry every 5 seconds. |

> [!WARNING]
> **Native GGML RPC Protocol Limitation:**
> The underlying llama.cpp / GGML RPC wire protocol is raw TCP with zero built-in authentication, authorization, or encryption. Anyone with network reachability to an RPC worker port can execute arbitrary tensor operations or allocate memory on that worker. For this reason, securing the coordinator's HTTP telemetry endpoint alone is **insufficient** for cluster security. All cross-computer RPC links must be secured at the network layer via encrypted tunnels and firewall rules.

---

## 3. Network Isolation and Firewall Rules

### 3.1 Windows Defender Firewall Configuration

On Windows worker machines running `ggml-rpc-server.exe`:

```powershell
# 1. Block all unsolicited inbound access to RPC ports from public networks
New-NetFirewallRule -DisplayName "Swarm-Block-Public-RPC" `
    -Direction Inbound `
    -Action Block `
    -Protocol TCP `
    -LocalPort 50052-50060 `
    -Profile Public

# 2. Allow inbound RPC traffic ONLY from the Tailscale / WireGuard private network adapter
New-NetFirewallRule -DisplayName "Swarm-Allow-VPN-RPC" `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 50052-50060 `
    -InterfaceAlias "Tailscale" `
    -RemoteAddress 100.64.0.0/10

# 3. Allow inbound Coordinator API (Port 8080) only from trusted local/management subnets
New-NetFirewallRule -DisplayName "Swarm-Coordinator-API" `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 8080 `
    -RemoteAddress 127.0.0.1, 100.64.0.0/10
```

### 3.2 Linux `ufw` Configuration

On Linux nodes acting as coordinator or workers:

```bash
# Allow Tailscale / WireGuard interface traffic
sudo ufw allow in on tailscale0 to any port 50052:50060 proto tcp comment "Allow Swarm RPC over Tailscale"
sudo ufw allow in on tailscale0 to any port 8080 proto tcp comment "Allow Swarm Coordinator over Tailscale"

# Deny access from physical interfaces
sudo ufw deny in on eth0 to any port 50052:50060 proto tcp comment "Block public RPC"
```

---

## 4. Overlay Network Encapsulation (Tailscale / WireGuard)

To deploy across heterogeneous physical machines without exposing unauthenticated RPC ports:

1. **Install Tailscale or WireGuard** on the coordinator and all worker machines:
   - Coordinator IP: `100.80.10.1`
   - Worker A IP: `100.80.10.2`
   - Worker B IP: `100.80.10.3`
2. **Bind RPC Daemons to the VPN Interface**:
   ```powershell
   # On Worker A
   .\temp_rpc_build\bin\ggml-rpc-server.exe --host 100.80.10.2 --port 50052 --threads 4
   ```
3. **Configure Swarm Coordinator with VPN Endpoints**:
   ```powershell
   $env:SWARM_RPC_ENDPOINTS = "100.80.10.2:50052, 100.80.10.3:50052"
   ```
4. All GGML RPC data transfers, weight shards, and layer computations are automatically encrypted using WireGuard ChaCha20-Poly1305 in flight.

---

## 5. Production Credential Management

### 5.1 The Process-List Exposure Vulnerability

On multi-user Windows and Linux systems, arguments passed to running executables (e.g. `swarm_agent.exe --token my-secret-token`) are readable by:
- Windows Task Manager
- PowerShell `Get-Process | Select-Object Id, ProcessName, CommandLine` or `Get-CimInstance Win32_Process`
- Linux `/proc/<pid>/cmdline` or `ps aux`

### 5.2 Hardened File-Based Credential Ingestion

In Milestone 11, Swarm introduced file-based credential loading to prevent process argument leakage:

1. Create a secure token file containing only the secret token:
   ```powershell
   # Create a secure token directory and file
   New-Item -ItemType Directory -Path "$env:ProgramData\Swarm\secrets" -Force | Out-Null
   Set-Content -Path "$env:ProgramData\Swarm\secrets\telemetry.token" -Value "super-secret-random-telemetry-token-2026" -NoNewline

   # Lock down file ACLs so only the Swarm service account and Administrators can read it
   icacls "$env:ProgramData\Swarm\secrets\telemetry.token" /inheritance:r /grant:r "SYSTEM:(F)" "Administrators:(F)" "$($env:USERNAME):(R)"
   ```

2. Run Swarm Agent using `--token-file`:
   ```powershell
   .\build-cuda\swarm_agent.exe --coordinator http://100.80.10.1:8080 --token-file "$env:ProgramData\Swarm\secrets\telemetry.token"
   ```
   *(Or set `$env:SWARM_TELEMETRY_TOKEN_FILE = "$env:ProgramData\Swarm\secrets\telemetry.token"`).*

3. Run Swarm Coordinator using `SWARM_TELEMETRY_TOKEN_FILE`:
   ```powershell
   # Ensure runtime DLL directory is on PATH
   $env:PATH = "$PWD\build-cuda\bin;$PWD\temp_rpc_build\bin;$env:PATH"

   $env:SWARM_DEPLOYMENT_ENV = "production"
   $env:SWARM_TELEMETRY_TOKEN_FILE = "$env:ProgramData\Swarm\secrets\telemetry.token"
   .\build-cuda\swarm_node.exe
   ```
   *(Alternatively, run via the operational helper script `.\scripts\Start-ProductionCoordinator.ps1 -TokenFile "$env:ProgramData\Swarm\secrets\telemetry.token"`).*

---

## 6. Preflight Enforcement Checklist

When `SWARM_DEPLOYMENT_ENV=production` is active:
- [x] **Fatal Preflight:** The coordinator will immediately exit with code 1 if no telemetry authentication token is configured.
- [x] **Advisory Logging:** The coordinator will inspect configured `SWARM_RPC_ENDPOINTS`. If remote (non-loopback) addresses are detected, it outputs security advisories reminding operators that GGML RPC is unauthenticated and must be VPN-encapsulated.
- [x] **Agent Argument Audit:** If `--token` is provided on the agent CLI, `swarm_agent.exe` outputs a visible warning prompting the operator to migrate to `--token-file`.
- [x] **Replay Protection:** Coordinator enforces strictly monotonic sequence numbers (`sequence_number > last_seq`) per `agent_session_id`.

---

## 7. Single-Computer Local Development & Testing

For developing and testing Swarm entirely on a single machine without remote devices:

1. **Start Environment (Local RPC Mode):**
   Launches loopback RPC worker bound strictly to `127.0.0.1:50052` and Swarm Coordinator bound strictly to `127.0.0.1:8080`:
   ```powershell
   .\scripts\Start-LocalDev.ps1
   ```
   *(For rapid UI and control-flow testing without RPC, use `.\scripts\Start-LocalDev.ps1 -MockWorker`).*

2. **Validate Inference:**
   Runs complete health, backend allocation check, and test prompt inference:
   ```powershell
   .\scripts\Test-LocalDevInference.ps1
   ```

3. **Stop Environment Cleanly:**
   Terminates coordinator and worker processes, verifies process exit, and confirms ports 8080 and 50052 are released:
   ```powershell
   .\scripts\Stop-LocalDev.ps1
   ```

