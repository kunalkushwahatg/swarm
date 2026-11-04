# Start-RemoteWorker.ps1 - Swarm Remote Worker & Hardware Agent Launcher
# Run this script on Computer B to participate in distributed Swarm inference.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [string]$CoordinatorUrl = "http://127.0.0.1:8080",

    [Parameter(Mandatory=$false)]
    [string]$ListenHost = "127.0.0.1",

    [Parameter(Mandatory=$false)]
    [int]$RpcPort = 50052,

    [Parameter(Mandatory=$false)]
    [string]$WorkerIp = "",

    [Parameter(Mandatory=$false)]
    [string]$TokenFile = "token.txt",

    [Parameter(Mandatory=$false)]
    [int]$Threads = 4,

    [Parameter(Mandatory=$false)]
    [string]$NodeId = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Swarm Remote Worker Node Launcher (Computer B)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# Ensure runtime DLLs are found
$env:PATH = "$ScriptDir;$env:PATH"

# Auto-generate node id if not provided
if ([string]::IsNullOrWhiteSpace($NodeId)) {
    $NodeId = "worker-$($env:COMPUTERNAME.ToLower())"
}

# Determine advertised worker IP
if ([string]::IsNullOrWhiteSpace($WorkerIp)) {
    $nonLoopback = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
        Select-Object -First 1
    if ($nonLoopback) {
        $WorkerIp = $nonLoopback.IPAddress
    } else {
        $WorkerIp = "127.0.0.1"
    }
}
$WorkerEndpoint = "$WorkerIp`:$RpcPort"

Write-Host "[Configuration]" -ForegroundColor Yellow
Write-Host "  Script Dir:       $ScriptDir"
Write-Host "  Coordinator URL:  $CoordinatorUrl"
Write-Host "  RPC Listen Host:  $ListenHost"
Write-Host "  RPC Port:         $RpcPort"
Write-Host "  Worker Endpoint:  $WorkerEndpoint"
Write-Host "  Node ID:          $NodeId"
Write-Host "  CPU Threads:      $Threads"
Write-Host "  Token File:       $TokenFile"

# Verify binaries
$rpcBin = Join-Path $ScriptDir "ggml-rpc-server.exe"
$agentBin = Join-Path $ScriptDir "swarm_agent.exe"
if (-not (Test-Path $rpcBin)) {
    Write-Error "ggml-rpc-server.exe not found in $ScriptDir"
    exit 1
}
if (-not (Test-Path $agentBin)) {
    Write-Error "swarm_agent.exe not found in $ScriptDir"
    exit 1
}

# Verify token file
$resolvedTokenPath = Join-Path $ScriptDir $TokenFile
if (-not (Test-Path $resolvedTokenPath)) {
    Write-Host "[WARNING] Token file '$resolvedTokenPath' does not exist." -ForegroundColor Yellow
    Write-Host "          Creating template '$resolvedTokenPath'. Please paste your Bearer token into it." -ForegroundColor Yellow
    Set-Content -Path $resolvedTokenPath -Value "REPLACE_WITH_YOUR_BEARER_TOKEN"
}

$rpcProc = $null
$agentProc = $null

try {
    Write-Host "`n[1/3] Starting GGML RPC Server..." -ForegroundColor Green
    $rpcArgs = "-H $ListenHost -p $RpcPort -t $Threads"
    $rpcProc = Start-Process -FilePath $rpcBin -ArgumentList $rpcArgs -PassThru -NoNewWindow
    Write-Host "  GGML RPC server running with PID $($rpcProc.Id)"

    # Wait briefly for RPC server to bind
    Start-Sleep -Seconds 2
    if ($rpcProc.HasExited) {
        Write-Error "ggml-rpc-server.exe exited prematurely with code $($rpcProc.ExitCode)"
        exit 1
    }

    Write-Host "`n[2/3] Starting Swarm Hardware Reporting Agent..." -ForegroundColor Green
    $agentArgs = "--coordinator $CoordinatorUrl --endpoint $WorkerEndpoint --rpc-port $RpcPort --node-id $NodeId --token-file `"$resolvedTokenPath`" --interval-ms 5000"
    $agentProc = Start-Process -FilePath $agentBin -ArgumentList $agentArgs -PassThru -NoNewWindow
    Write-Host "  Swarm Agent running with PID $($agentProc.Id)"

    Write-Host "`n[3/3] Worker is ACTIVE and reporting to Coordinator." -ForegroundColor Cyan
    Write-Host "  On Computer A (Coordinator), configure:" -ForegroundColor Yellow
    Write-Host "    SWARM_USE_RPC=1"
    Write-Host "    SWARM_RPC_ENDPOINTS=$WorkerEndpoint"
    Write-Host "    SWARM_PLACEMENT_POLICY=dynamic"
    Write-Host "`nPress Ctrl+C to stop worker and agent cleanly..." -ForegroundColor White

    while (-not $rpcProc.HasExited -and -not $agentProc.HasExited) {
        Start-Sleep -Seconds 1
    }
}
finally {
    Write-Host "`nCleaning up processes..." -ForegroundColor Yellow
    if ($agentProc -and -not $agentProc.HasExited) {
        Write-Host "  Stopping swarm_agent.exe (PID $($agentProc.Id))..."
        Stop-Process -Id $agentProc.Id -Force -ErrorAction SilentlyContinue
    }
    if ($rpcProc -and -not $rpcProc.HasExited) {
        Write-Host "  Stopping ggml-rpc-server.exe (PID $($rpcProc.Id))..."
        Stop-Process -Id $rpcProc.Id -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Clean teardown completed." -ForegroundColor Green
}
