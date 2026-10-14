# Start-LocalDev.ps1
# Safe single-computer local development launcher for Swarm
# Establishes local TCP communication between coordinator and GGML RPC worker on 127.0.0.1:50052

[CmdletBinding()]
param(
    [string]$ModelPath = "",
    [int]$Port = 8080,
    [int]$RpcPort = 50052,
    [int]$GpuLayers = 4,
    [int]$Threads = 2,
    [string]$PlacementPolicy = "none",
    [switch]$MockWorker = $false,
    [switch]$ForceClean = $false,
    [switch]$Wait = $false
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkspaceRoot = (Get-Item $ScriptDir).Parent.FullName

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Swarm: Single-Computer Local Development Launcher" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Resolve model path
if ([string]::IsNullOrWhiteSpace($ModelPath)) {
    $ModelPath = Join-Path $WorkspaceRoot "models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf"
}
if (-not (Test-Path $ModelPath)) {
    Write-Error "Official model not found at: $ModelPath"
    exit 1
}

# 2. Check & handle port collisions
$targetPorts = if ($MockWorker) { @($Port) } else { @($Port, $RpcPort) }
foreach ($p in $targetPorts) {
    $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        $owningPid = $conn.OwningProcess
        $pObj = Get-Process -Id $owningPid -ErrorAction SilentlyContinue
        $pName = if ($pObj) { $pObj.ProcessName } else { "Unknown" }
        $pPath = if ($pObj) { try { $pObj.Path } catch { "" } } else { "" }
        $isWorkspaceSwarm = ($pPath -like "*$WorkspaceRoot*") -and ($pName -like "*swarm*" -or $pName -like "*rpc*")

        if ($ForceClean -and $isWorkspaceSwarm) {
            Write-Host "Port $p is occupied by prior Swarm PID $owningPid ($pName). ForceClean terminating..." -ForegroundColor Yellow
            Stop-Process -Id $owningPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        } else {
            if ($isWorkspaceSwarm) {
                Write-Error "Port $p is already in use by orphaned Swarm process PID $owningPid ($pName). Run .\scripts\Stop-LocalDev.ps1 or pass -ForceClean."
            } else {
                Write-Error "Port $p is in use by UNRELATED process PID $owningPid ($pName). Cannot start Swarm on port $p."
            }
            exit 1
        }
    }
}

# 3. Locate binaries and runtime DLL directories
$coordinatorBin = Join-Path $WorkspaceRoot "build-cuda\swarm_node.exe"
$rpcServerBin = Join-Path $WorkspaceRoot "dist\swarm-worker-windows-x64\ggml-rpc-server.exe"

if (-not (Test-Path $coordinatorBin)) {
    Write-Error "Coordinator binary not found at: $coordinatorBin"
    exit 1
}
if (-not $MockWorker -and -not (Test-Path $rpcServerBin)) {
    Write-Error "RPC server binary not found at: $rpcServerBin"
    exit 1
}

# 4. Create log directory
$logDir = Join-Path $WorkspaceRoot "artifacts\local_dev"
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$coordOutLog = Join-Path $logDir "coordinator.stdout.log"
$coordErrLog = Join-Path $logDir "coordinator.stderr.log"
$rpcOutLog   = Join-Path $logDir "rpc_worker.stdout.log"
$rpcErrLog   = Join-Path $logDir "rpc_worker.stderr.log"

Remove-Item $coordOutLog, $coordErrLog, $rpcOutLog, $rpcErrLog -ErrorAction SilentlyContinue

# 5. Launch RPC Worker (if not in MockWorker mode)
$rpcProc = $null
if (-not $MockWorker) {
    Write-Host "`n[Step 1] Launching Local RPC Worker on 127.0.0.1:$RpcPort..." -ForegroundColor Yellow
    $rpcProc = Start-Process -FilePath $rpcServerBin `
        -ArgumentList @("-H", "127.0.0.1", "-p", $RpcPort.ToString(), "-t", $Threads.ToString()) `
        -WorkingDirectory (Join-Path $WorkspaceRoot "dist\swarm-worker-windows-x64") `
        -RedirectStandardOutput $rpcOutLog `
        -RedirectStandardError $rpcErrLog `
        -PassThru

    Write-Host "  RPC Worker started with PID $($rpcProc.Id)" -ForegroundColor Green

    # Wait for RPC listener
    $rpcReady = $false
    for ($i = 0; $i -lt 10; $i++) {
        if ($rpcProc.HasExited) {
            $errText = if (Test-Path $rpcErrLog) { Get-Content $rpcErrLog -Raw } else { "" }
            Write-Error "RPC worker process exited unexpectedly with code $($rpcProc.ExitCode). Stderr:`n$errText"
            exit 1
        }
        Start-Sleep -Milliseconds 400
        $check = Test-NetConnection -ComputerName "127.0.0.1" -Port $RpcPort -WarningAction SilentlyContinue
        if ($check.TcpTestSucceeded) {
            $rpcReady = $true
            break
        }
    }
    if (-not $rpcReady) {
        Write-Error "Timed out waiting for RPC worker to listen on 127.0.0.1:$RpcPort"
        exit 1
    }
    Write-Host "  RPC Worker verified listening on 127.0.0.1:$RpcPort (Loopback only)" -ForegroundColor Green
} else {
    Write-Host "`n[Step 1] MockWorker mode active: skipping RPC process launch." -ForegroundColor Yellow
}

# 6. Launch Swarm Coordinator
Write-Host "`n[Step 2] Launching Swarm Coordinator on port $Port..." -ForegroundColor Yellow
$env:SWARM_USE_RPC = if ($MockWorker) { "0" } else { "1" }
$env:SWARM_RPC_ENDPOINTS = if ($MockWorker) { "" } else { "127.0.0.1:$RpcPort" }
$env:SWARM_MODEL_PATH = $ModelPath
$env:SWARM_N_GPU_LAYERS = $GpuLayers.ToString()
$env:PORT = $Port.ToString()
$env:SWARM_HTTP_PORT = $Port.ToString()
$env:SWARM_HTTP_BIND = "127.0.0.1"
$env:SWARM_DEPLOYMENT_ENV = "development"
$env:SWARM_PLACEMENT_POLICY = $PlacementPolicy
$env:PATH = "$WorkspaceRoot\build-cuda;$WorkspaceRoot\build-cuda\bin;$env:PATH"

$coordProc = Start-Process -FilePath $coordinatorBin `
    -WorkingDirectory (Join-Path $WorkspaceRoot "build-cuda") `
    -RedirectStandardOutput $coordOutLog `
    -RedirectStandardError $coordErrLog `
    -PassThru

Write-Host "  Coordinator started with PID $($coordProc.Id)" -ForegroundColor Green

# 7. Wait for Coordinator readiness
Write-Host "`n[Step 3] Waiting for Coordinator health check..." -ForegroundColor Yellow
$coordReady = $false
for ($i = 0; $i -lt 30; $i++) {
    if ($coordProc.HasExited) {
        $errText = if (Test-Path $coordErrLog) { Get-Content $coordErrLog -Raw } else { "" }
        Write-Error "Coordinator exited prematurely with code $($coordProc.ExitCode). Stderr:`n$errText"
        exit 1
    }
    Start-Sleep -Seconds 1
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($resp.status -eq "ok" -or $resp.status -eq "degraded") {
            $coordReady = $true
            break
        }
    } catch {}
}

if (-not $coordReady) {
    Write-Error "Coordinator failed to respond on http://127.0.0.1:$Port/health within 30 seconds."
    exit 1
}

# Verify network socket binding addresses
$coordConn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
$coordBindAddr = if ($coordConn) { ($coordConn.LocalAddress | Select-Object -Unique) -join ", " } else { "unknown" }
$rpcConn = if ($rpcProc) { Get-NetTCPConnection -LocalPort $RpcPort -State Listen -ErrorAction SilentlyContinue } else { $null }
$rpcBindAddr = if ($rpcConn) { ($rpcConn.LocalAddress | Select-Object -Unique) -join ", " } else { "n/a" }

# 8. Record active session state to file for easy cleanup
$sessionInfo = [ordered]@{
    "Mode"            = if ($MockWorker) { "MockWorker" } else { "LocalRpc" }
    "CoordinatorPid"  = $coordProc.Id
    "CoordinatorPort" = $Port
    "CoordinatorBind" = $coordBindAddr
    "CoordinatorPath" = $coordinatorBin
    "RpcWorkerPid"    = if ($rpcProc) { $rpcProc.Id } else { $null }
    "RpcWorkerPort"   = if ($rpcProc) { $RpcPort } else { $null }
    "RpcWorkerBind"   = $rpcBindAddr
    "RpcWorkerPath"   = if ($rpcProc) { $rpcServerBin } else { $null }
    "StartedAt"       = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
}
$sessionFile = Join-Path $logDir "active_session.json"
$sessionInfo | ConvertTo-Json -Depth 3 | Set-Content $sessionFile -Force

Write-Host "`n==========================================================" -ForegroundColor Green
Write-Host "  Swarm Local Development Environment is READY!" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  Mode:             $($sessionInfo.Mode)" -ForegroundColor White
Write-Host "  Coordinator URL:  http://127.0.0.1:$Port (Bound: $coordBindAddr)" -ForegroundColor White
Write-Host "  Coordinator PID:  $($coordProc.Id)" -ForegroundColor White
if ($rpcProc) {
    Write-Host "  RPC Worker:       127.0.0.1:$RpcPort (Bound: $rpcBindAddr)" -ForegroundColor White
    Write-Host "  RPC Worker PID:   $($rpcProc.Id)" -ForegroundColor White
}
Write-Host "`nLogs available under: $logDir" -ForegroundColor Cyan
Write-Host "To test inference:    .\scripts\Test-LocalDevInference.ps1" -ForegroundColor Cyan
Write-Host "To stop environment:  .\scripts\Stop-LocalDev.ps1" -ForegroundColor Cyan

if ($Wait) {
    Write-Host "`n[-Wait specified] Holding session open. Press Ctrl+C or run Stop-LocalDev.ps1 to stop..." -ForegroundColor Yellow
    try {
        while (-not $coordProc.HasExited) {
            Start-Sleep -Seconds 1
        }
    } finally {
        Write-Host "Launcher wait loop terminated." -ForegroundColor Gray
    }
}
