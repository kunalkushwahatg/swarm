# Swarm Single-Computer Local Development Guide

**Workspace**: `C:\Users\kunal\OneDrive\Desktop\swarm`

This document outlines how to safely run and test Swarm completely on your laptop without requiring a second machine.

---

## 1. Quick Start Commands

### Start Environment (Local RPC Mode)
Launches the GGML RPC worker strictly bound to `127.0.0.1:50052` and the Swarm Coordinator strictly bound to `http://127.0.0.1:8080`:
```powershell
.\scripts\Start-LocalDev.ps1
```
*If running in a dedicated terminal window where you want the script to keep running in the foreground, use `.\scripts\Start-LocalDev.ps1 -Wait`.*

### Test Inference
Validates coordinator health, node inventory, backend allocation, and runs a real chat completion:
```powershell
.\scripts\Test-LocalDevInference.ps1
```

### Stop Environment Safely
Terminates only the session coordinator and RPC worker processes after verifying their executable identity, polls for process exit, verifies ports 8080 and 50052 are released, and updates session tracking:
```powershell
.\scripts\Stop-LocalDev.ps1
```

---

## 2. Mock-Worker Mode (For UI and Rapid Control Flow Testing)

If you only need to test the coordinator REST API, UI, or control flow without running an RPC process:
```powershell
.\scripts\Start-LocalDev.ps1 -MockWorker
```
Stop it using the same cleanup script:
```powershell
.\scripts\Stop-LocalDev.ps1
```

---

## 3. Network Binding Verification

Both processes listen strictly on loopback (`127.0.0.1`) and are not exposed to the local area network:
- **Coordinator HTTP**: `127.0.0.1:8080` (enforced via `SWARM_HTTP_BIND=127.0.0.1`)
- **RPC Server**: `127.0.0.1:50052` (enforced via `-H 127.0.0.1 -p 50052`)

---

## 4. Logs & Artifacts

All local dev logs and run results are stored under `artifacts\local_dev\`:
- `coordinator.stdout.log` / `coordinator.stderr.log`
- `rpc_worker.stdout.log` / `rpc_worker.stderr.log`
- `active_session.json`
- `local_test_result.json`
