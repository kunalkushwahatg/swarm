# Swarm Operational Script: Start-LoopbackRpc.ps1
# Mode B: Loopback RPC Simulation (Multi-Worker on Localhost)
# Date: 2026-10-10

param(
    [string]$ModelPath = "$PSScriptRoot\..\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf",
    [int]$Port = 8080,
    [int]$Worker0Port = 50052,
    [int]$Worker1Port = 50053,
    [int]$Threads = 2,
    [string]$PlacementPolicy = "none",
    [switch]$StartCoordinator = $true
)

$ErrorActionPreference = "Stop"
$workspaceRoot = (Resolve-Path "$PSScriptRoot\..").Path

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Swarm: Starting Loopback RPC Simulation (Mode B)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# Cleanup old processes
Get-Process -Name "swarm_node", "rpc-server", "ggml-rpc-server" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "Stopping existing process $($_.Name) (PID: $($_.Id))..." -ForegroundColor Yellow
    Stop-Process -Id $_.Id -Force
}
Start-Sleep -Milliseconds 600

$rpcExe = "$workspaceRoot\temp_rpc_build\bin\ggml-rpc-server.exe"
if (-not (Test-Path $rpcExe)) {
    throw "ggml-rpc-server.exe not found at $rpcExe"
}

Write-Host "Launching Worker 0 on 127.0.0.1:$Worker0Port..." -ForegroundColor Cyan
$w0 = Start-Process -FilePath $rpcExe -ArgumentList @("--host", "127.0.0.1", "--port", $Worker0Port.ToString(), "--threads", $Threads.ToString()) -WorkingDirectory $workspaceRoot -PassThru

Write-Host "Launching Worker 1 on 127.0.0.1:$Worker1Port..." -ForegroundColor Cyan
$w1 = Start-Process -FilePath $rpcExe -ArgumentList @("--host", "127.0.0.1", "--port", $Worker1Port.ToString(), "--threads", $Threads.ToString()) -WorkingDirectory $workspaceRoot -PassThru

Start-Sleep -Seconds 1

if ($StartCoordinator) {
    $env:SWARM_USE_RPC = "1"
    $env:PORT = $Port.ToString()
    $env:SWARM_MODEL_PATH = $ModelPath
    $env:SWARM_N_GPU_LAYERS = "4"
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:$Worker0Port, 127.0.0.1:$Worker1Port"
    $env:SWARM_PLACEMENT_POLICY = $PlacementPolicy
    $env:SWARM_DEPLOYMENT_ENV = "development"

    $nodeExe = "$workspaceRoot\build-cuda\swarm_node.exe"
    Write-Host "`nLaunching Swarm Coordinator on port $Port..." -ForegroundColor Cyan
    $coord = Start-Process -FilePath $nodeExe -WorkingDirectory $workspaceRoot -PassThru

    Write-Host "Waiting for coordinator readiness on port $Port..." -ForegroundColor Cyan
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -Method Get -TimeoutSec 2
            if ($resp.status -eq "ok") {
                $ready = $true
                break
            }
        } catch {}
        Start-Sleep -Seconds 1
    }

    if ($ready) {
        Write-Host "`nSwarm Loopback Simulation is READY at http://127.0.0.1:$Port" -ForegroundColor Green
        Write-Host "  Coordinator PID: $($coord.Id)" -ForegroundColor White
        Write-Host "  Worker 0 PID:    $($w0.Id) (127.0.0.1:$Worker0Port)" -ForegroundColor White
        Write-Host "  Worker 1 PID:    $($w1.Id) (127.0.0.1:$Worker1Port)" -ForegroundColor White
    } else {
        Write-Host "`nCoordinator did not respond within 30 seconds." -ForegroundColor Red
    }
} else {
    Write-Host "`nRPC Workers running: Worker 0 (PID: $($w0.Id)), Worker 1 (PID: $($w1.Id))" -ForegroundColor Green
}
