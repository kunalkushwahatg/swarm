# Swarm Troubleshooting Guide

This guide covers common issues encountered when running Swarm distributed inference, specifically focused on remote worker deployment, network connectivity, and coordinator-worker communication.

---

## 1. Missing DLL or Runtime Errors

### Symptom:
A Windows system error dialog pops up: `"The code execution cannot proceed because ggml.dll (or ggml-base.dll, ggml-cpu.dll, ggml-rpc.dll, VCRUNTIME140.dll) was not found."`

### Root Causes & Fixes:
1. **Dynamic libraries not in application directory**:
   - On Windows, `ggml-rpc-server.exe` searches the current directory of the executable, directories listed in the `PATH` environment variable, and the Windows System32 directory.
   - **Fix**: Ensure all 4 DLLs (`ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`, `ggml-rpc.dll`) are placed in the exact same directory as `ggml-rpc-server.exe`.
   - When running via PowerShell, `Start-RemoteWorker.ps1` automatically prepends its own script directory to `$env:PATH`:
     ```powershell
     $env:PATH = "$PSScriptRoot;$env:PATH"
     ```
2. **Missing Microsoft Visual C++ Redistributable**:
   - If `VCRUNTIME140.dll` or `MSVCP140.dll` is missing, Computer B needs the standard Microsoft Visual C++ 2015–2022 Redistributable (x64).
   - **Fix**: Download and install the official Microsoft x64 redistributable from:
     `https://aka.ms/vs/17/release/vc_redist.x64.exe`

---

## 2. Port Conflicts & Address Already in Use

### Symptom:
`ggml-rpc-server.exe` immediately exits or logs `"Failed to bind to 0.0.0.0:50052"`, or `Start-RemoteWorker.ps1` reports exit code 1.

### Diagnosis:
Run the following PowerShell command on Computer B to identify any existing process holding the port:
```powershell
Get-NetTCPConnection -LocalPort 50052 -ErrorAction SilentlyContinue | Select-Object LocalAddress, LocalPort, OwningProcess, State
```
Or with netstat:
```powershell
netstat -ano | findstr :50052
```

### Fixes:
1. **Terminate existing worker process**:
   ```powershell
   Stop-Process -Id <OwningProcessPID> -Force
   ```
2. **Select an alternate port**:
   You can specify an alternate port when starting the worker:
   ```powershell
   .\Start-RemoteWorker.ps1 -RpcPort 50053
   ```
   Remember to notify Computer A to connect to the new port:
   `SWARM_RPC_ENDPOINTS=192.168.x.x:50053`

---

## 3. Network Connectivity & Routing Failures

### Symptom:
Coordinator logs: `[RPC Error] Failed to connect to <Computer_B_IP>:50052`, or `Test-NetConnection` fails.

### Diagnosis Steps:
1. **Verify Computer B IP address**:
   On Computer B, run:
   ```powershell
   Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } | Select-Object InterfaceAlias, IPAddress
   ```
2. **Verify Coordinator IP address**:
   On Computer A, run the same command to get its LAN or VPN IP.
3. **Test reachability from Computer A to Computer B**:
   On Computer A:
   ```powershell
   Test-NetConnection -ComputerName <Computer_B_IP> -Port 50052
   ```
   If `TcpTestSucceeded` is `False`, check Computer B's firewall.
4. **Test reachability from Computer B to Computer A**:
   On Computer B:
   ```powershell
   Test-NetConnection -ComputerName <Computer_A_IP> -Port 8080
   ```
   If `TcpTestSucceeded` is `False`, check Computer A's firewall for port 8080.

---

## 4. Windows Defender Firewall Configuration

### Symptom:
Ping works between machines, but TCP connection to port 50052 or port 8080 times out.

### Fix on Computer B (Allow Inbound RPC):
By default, Windows blocks incoming TCP connections from other LAN devices on non-standard ports.
Run PowerShell as Administrator on Computer B:
```powershell
# Allow inbound TCP port 50052 for GGML RPC:
New-NetFirewallRule -DisplayName "Swarm GGML RPC" -Direction Inbound -LocalPort 50052 -Protocol TCP -Action Allow -Profile Private,Public
```
To restrict the rule strictly to Computer A's IP address:
```powershell
New-NetFirewallRule -DisplayName "Swarm GGML RPC Restricted" -Direction Inbound -LocalPort 50052 -Protocol TCP -Action Allow -RemoteAddress <Computer_A_IP>
```

### Fix on Computer A (Allow Inbound Telemetry):
Run PowerShell as Administrator on Computer A:
```powershell
# Allow inbound TCP port 8080 for Swarm Coordinator:
New-NetFirewallRule -DisplayName "Swarm Coordinator HTTP" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow -Profile Private,Public
```

### Wi-Fi Hotspot & ICMP vs TCP Diagnostic Note:
- **Ping vs TCP Reachability:** On Windows, when connecting via a Wi-Fi hotspot, the network connection profile is categorized as **`Public`** by default. Windows Defender Firewall silences and drops all inbound ICMPv4 echo requests (pings) on Public networks unless explicitly enabled.
- A failing `ping <IP>` does **not** indicate network failure or that Swarm is unreachable. ICMP and TCP are completely independent protocols.
- Always verify actual Swarm service connectivity using TCP socket checks:
  ```powershell
  Test-NetConnection -ComputerName <Target_IP> -Port 50052
  ```


---

## 5. Telemetry Authentication Failures (HTTP 401 / 403)

### Symptom:
`swarm_agent.exe` logs:
- `Report rejected: HTTP 401 Unauthorized`
- `Report rejected: HTTP 403 Forbidden`

### Root Causes & Fixes:
1. **HTTP 401 (Missing Authentication Header)**:
   - The coordinator is running in production mode (`SWARM_DEPLOYMENT_ENV=production`) or has a token configured, but the agent was run without a token.
   - **Fix**: Provide the token file via `--token-file token.txt` or configure `SWARM_TELEMETRY_TOKEN_FILE`.
2. **HTTP 403 (Invalid Token or Remote Unauthenticated)**:
   - In production mode: The token in `token.txt` on Computer B does not match the token configured on Computer A.
   - In development mode: The coordinator allows unauthenticated loopback reports, but strictly denies remote (non-loopback) requests without a valid token.
   - **Fix**: Ensure both machines share the exact same Bearer token string in their respective token files.
3. **Secret Token File Format**:
   - `token.txt` should contain only the secret token string on a single line. Swarm automatically trims whitespace and newlines, but avoid non-ASCII characters or extra commentary.

---

## 6. Remote Inference Abort & Disconnection Behavior

### Symptom:
Inference starts, but if Computer B is shut down, disconnected, or kills `ggml-rpc-server.exe`, Computer A halts or reports an RPC transport error.

### Root Cause:
GGML RPC is a tightly coupled tensor execution backend. When a model's layers are split across multiple devices, matrix multiplications across distributed buffers require all participating RPC servers to remain active and synchronized.

### Operational Recovery:
1. GGML RPC does not support automatic hot-reconnection into an existing in-memory model context.
2. If a worker goes offline mid-inference:
   - Restart the worker daemon on Computer B: `.\Start-RemoteWorker.ps1`
   - Restart the coordinator on Computer A: `.\scripts\Start-ProductionCoordinator.ps1`
   - The coordinator will reconnect, re-register the RPC devices, and re-allocate tensors cleanly.
