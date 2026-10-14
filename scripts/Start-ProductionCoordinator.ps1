# Swarm Operational Script: Start-ProductionCoordinator.ps1
# Mode C: Hardened Production Coordinator
# Date: 2026-10-10

param(
    [Parameter(Mandatory=$true)]
    [string]$TokenFile,
    [string]$ModelPath = "$PSScriptRoot\..\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf",
    [string]$RpcEndpoints = "",
    [int]$Port = 8080,
    [string]$PlacementPolicy = "resource_aware",
    [int]$GpuLayers = 4
)

$ErrorActionPreference = "Stop"
$workspaceRoot = (Resolve-Path "$PSScriptRoot\..").Path

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Swarm: Starting Hardened Production Coordinator (Mode C)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

if (-not (Test-Path $TokenFile)) {
    throw "Fatal: Token file not found at: $TokenFile"
}

$rawSecret = (Get-Content -Path $TokenFile -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($rawSecret)) {
    throw "Fatal: Token file at $TokenFile is empty."
}

if (-not (Test-Path $ModelPath)) {
    throw "Fatal: Model file not found at: $ModelPath"
}

# Ensure existing processes are stopped
Get-Process -Name "swarm_node" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "Stopping existing swarm_node process (PID: $($_.Id))..." -ForegroundColor Yellow
    Stop-Process -Id $_.Id -Force
}

$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    throw "Port $Port is already in use by PID $($conn.OwningProcess)"
}

$env:PATH = "$workspaceRoot\build-cuda\bin;$workspaceRoot\build-cuda;$workspaceRoot\temp_rpc_build\bin;$env:PATH"
$env:SWARM_DEPLOYMENT_ENV = "production"
$env:SWARM_TELEMETRY_TOKEN_FILE = $TokenFile
$env:PORT = $Port.ToString()
$env:SWARM_MODEL_PATH = $ModelPath
$env:SWARM_N_GPU_LAYERS = $GpuLayers.ToString()
$env:SWARM_PLACEMENT_POLICY = $PlacementPolicy

if ([string]::IsNullOrWhiteSpace($RpcEndpoints)) {
    $env:SWARM_USE_RPC = "0"
    Write-Host "  RPC Endpoints: None configured (Running local CUDA)" -ForegroundColor Yellow
} else {
    $env:SWARM_USE_RPC = "1"
    $env:SWARM_RPC_ENDPOINTS = $RpcEndpoints
    Write-Host "  RPC Endpoints: $RpcEndpoints" -ForegroundColor White
}

$nodeExe = "$workspaceRoot\build-cuda\swarm_node.exe"
if (-not (Test-Path $nodeExe)) {
    throw "swarm_node.exe not found at $nodeExe"
}

Write-Host "`nLaunching Production Coordinator..." -ForegroundColor Cyan
$proc = Start-Process -FilePath $nodeExe -WorkingDirectory $workspaceRoot -PassThru

Write-Host "Waiting for production coordinator readiness on port $Port..." -ForegroundColor Cyan
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
    Write-Host "`nSwarm Production Coordinator is READY at http://127.0.0.1:$Port (PID: $($proc.Id))" -ForegroundColor Green
    Write-Host "  Deployment Env:    production" -ForegroundColor White
    Write-Host "  Telemetry Auth:    ENABLED (Loaded from $TokenFile)" -ForegroundColor White
    Write-Host "  Placement Policy:  $PlacementPolicy" -ForegroundColor White
} else {
    Write-Host "`nProduction Coordinator did not respond within 30 seconds." -ForegroundColor Red
}
