# Swarm Milestone 12 — Computer A Hotspot & Firewall Diagnostic Report

**Date:** 2026-10-10  
**Workspace:** `C:\Users\kunal\OneDrive\Desktop\swarm`  
**Host (Computer A):** `192.168.137.174` (Wi-Fi client)  
**Hotspot Gateway (Computer B):** `192.168.137.1` (Hotspot host)  

---

## 1. Executive Summary & Diagnostic Verdict

Computer A and Computer B are connected over Computer B's Wi-Fi hotspot subnet (`192.168.137.0/24`).
- **Computer A -> Computer B ping**: **PASS** (1 ms round-trip time).
- **Computer B -> Computer A ping**: **TIMEOUT**.
- **Computer B neighbor/ARP table**: Contains `192.168.137.174` with Computer A's valid MAC address.

### Confirmed Findings:
1. **Layer 2 (Data Link) and Layer 3 (IP Routing) Connectivity is 100% Functional**:
   - Computer A successfully pings Computer B (`192.168.137.1`) in 1 ms with zero packet loss.
   - Computer B's ARP cache contains Computer A's IP and MAC address.
   - The route table on Computer A directly associates `192.168.137.0/24` with the `Wi-Fi` interface (`NextHop: 0.0.0.0`).
2. **Ping Timeout is Caused by Windows Defender Firewall ICMP Filtering, NOT a Network Break**:
   - On Computer A, the Wi-Fi connection profile is categorized as **`Public`**.
   - Inspection of Windows Defender Firewall rules reveals that **all inbound ICMPv4 Echo Request rules are `Enabled: False`**.
   - By default on Windows, incoming ICMP echo requests (pings) are silently dropped on Public networks.
   - **ICMP is completely separate from TCP.** A failed ping does **not** indicate that Swarm's TCP telemetry or RPC communication is blocked.
3. **No Active Process is Currently Listening on TCP Port 8080 on Computer A**:
   - The Swarm coordinator (`swarm_node.exe`) is intentionally not running during this diagnostic phase.
   - Any TCP connection attempt from Computer B to `192.168.137.174:8080` will fail with "Connection Refused" (TCP RST) or timeout because the socket is closed, not because of a network routing failure.
4. **Existing Application Firewall Rule for `swarm_node.exe` is Already Present**:
   - An inbound allow rule named `swarm_node` (`TCP Query User{75694747-F8C8-4BD9-966E-F480489CA3DA}C:\users\kunal\onedrive\desktop\swarm\build-cuda\swarm_node.exe`) already exists and is **`Enabled: True` for the Public profile**.
   - When `swarm_node.exe` is launched, Windows Defender Firewall will permit incoming TCP traffic to its listening port.

### Suspected Findings:
1. **Computer B RPC Server Listener Status**:
   - Probing TCP port `50052` on Computer B (`192.168.137.1`) currently returns `TcpTestSucceeded: False`.
   - *Suspected cause*: `ggml-rpc-server.exe` has not yet been started on Computer B, or Computer B's Windows Firewall has not yet permitted inbound TCP port `50052`.

---

## 2. Technical Evidence & System Inspection

### A. Network Interface & Profile Inspection
```powershell
Get-NetConnectionProfile
```
**Observed Output:**
- `InterfaceAlias`: `Wi-Fi`
- `Name`: `TARWISH 3258 2` (Hotspot SSID)
- `NetworkCategory`: **`Public`** (Default Windows categorization for new Wi-Fi hotspots)
- `IPv4Address`: `192.168.137.174/24`

### B. Routing Table Inspection
```powershell
Get-NetRoute -DestinationPrefix "192.168.137.*"
```
**Observed Output:**
- `192.168.137.0/24` -> `NextHop: 0.0.0.0` on `InterfaceAlias: Wi-Fi` (Direct on-link local subnet).

### C. ICMPv4 Inbound Firewall Rules
```powershell
Get-NetFirewallRule -DisplayName "*Echo Request*"
```
**Observed Output:**
- `File and Printer Sharing (Echo Request - ICMPv4-In)`: `Enabled: False`
- `Core Networking Diagnostics - ICMP Echo Request (ICMPv4-In)`: `Enabled: False`
- Every inbound ICMPv4 Echo rule is explicitly disabled, explaining why Computer B's pings to `192.168.137.174` time out.

### D. Application-Level Inbound Firewall Rules for Swarm
```powershell
Get-NetFirewallRule -DisplayName "swarm_node"
```
**Observed Output:**
- `Name`: `TCP Query User{75694747-F8C8-4BD9-966E-F480489CA3DA}C:\users\kunal\onedrive\desktop\swarm\build-cuda\swarm_node.exe`
- `Profile`: `Public`
- `Direction`: `Inbound`
- `Action`: `Allow`
- `Enabled`: `True`
- `Program`: `C:\users\kunal\onedrive\desktop\swarm\build-cuda\swarm_node.exe`

---

## 3. Minimum Safe Remediation

To ensure deterministic, fail-safe communication between Computer A and Computer B while adhering to strict least-privilege security:

### Option A: Allow Inbound TCP 8080 Strictly for Computer B (Recommended)
Rather than opening port 8080 to all devices on the hotspot, create an inbound firewall rule allowing TCP 8080 **only from Computer B's verified IP address (`192.168.137.1`)**:

```powershell
# Run PowerShell as Administrator on Computer A:
New-NetFirewallRule -DisplayName "Swarm Coordinator - Hotspot Worker Restricted" `
    -Direction Inbound `
    -LocalPort 8080 `
    -Protocol TCP `
    -Action Allow `
    -RemoteAddress 192.168.137.1 `
    -Profile Public,Private
```

### Option B: Optional ICMP Ping Verification (Diagnostic Only)
If the operator on Computer B wishes to verify ping reachability before launching Swarm, temporarily permit ICMP Echo Requests strictly from `192.168.137.1`:

```powershell
# Run PowerShell as Administrator on Computer A (Optional):
New-NetFirewallRule -DisplayName "Swarm ICMP Diagnostic - Hotspot Restricted" `
    -Direction Inbound `
    -Protocol ICMPv4 `
    -IcmpType 8 `
    -Action Allow `
    -RemoteAddress 192.168.137.1 `
    -Profile Public,Private
```

---

## 4. Temporary TCP Reachability Verification Test

To prove end-to-end TCP connectivity between Computer B and Computer A **without starting the full Swarm coordinator or touching production model memory**:

1. **On Computer A**:
   Run the temporary standalone TCP listener script:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\Test-HotspotTcpReachability.ps1 -Port 58080 -TimeoutSeconds 30
   ```
2. **On Computer B**:
   While the listener is running, execute:
   ```powershell
   Test-NetConnection -ComputerName 192.168.137.174 -Port 58080
   ```
3. **Outcome**:
   The script will log `[SUCCESS] Inbound TCP connection accepted from: 192.168.137.1:xxxx`, send an acknowledgment (`SWARM_TCP_PROBE_ACK`), and immediately terminate and release port 58080.

---

## 5. Cleanup Instructions

After Milestone 12 physical validation is complete, remove the temporary restricted rules to restore original firewall state:

```powershell
# Run PowerShell as Administrator on Computer A:
Remove-NetFirewallRule -DisplayName "Swarm Coordinator - Hotspot Worker Restricted" -ErrorAction SilentlyContinue
Remove-NetFirewallRule -DisplayName "Swarm ICMP Diagnostic - Hotspot Restricted" -ErrorAction SilentlyContinue
```
