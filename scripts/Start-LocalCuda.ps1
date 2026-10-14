# Swarm Operational Script: Start-LocalCuda.ps1
# Mode A: Standalone In-Process Local CUDA Inference
# Date: 2026-10-10

param(
    [string]$ModelPath = "$PSScriptRoot\..\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf",
    [int]$Port = 8080,
    [int]$GpuLayers = 36
)

$ErrorActionPreference = "Stop"
$workspaceRoot = (Resolve-Path "$PSScriptRoot\..").Path

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Swarm: Starting Local CUDA Inference (Mode A)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

if (-not (Test-Path $ModelPath)) {
    throw "Model file not found at: $ModelPath"
}

# Ensure existing processes are stopped
Get-Process -Name "swarm_node" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "Stopping existing swarm_node process (PID: $($_.Id))..." -ForegroundColor Yellow
    Stop-Process -Id $_.Id -Force
}

# Verify port is free
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    throw "Port $Port is already in use by PID $($conn.OwningProcess)"
}

$env:PATH = "$workspaceRoot\build-cuda\bin;$workspaceRoot\build-cuda;$workspaceRoot\temp_rpc_build\bin;$env:PATH"
$env:SWARM_USE_RPC = "0"
$env:PORT = $Port.ToString()
$env:SWARM_MODEL_PATH = $ModelPath
$env:SWARM_N_GPU_LAYERS = $GpuLayers.ToString()
$env:SWARM_PLACEMENT_POLICY = "none"
$env:SWARM_DEPLOYMENT_ENV = "development"

Write-Host "Configuration:" -ForegroundColor White
Write-Host "  Model Path:    $ModelPath" -ForegroundColor Gray
Write-Host "  Port:          $Port" -ForegroundColor Gray
Write-Host "  GPU Layers:    $GpuLayers" -ForegroundColor Gray
Write-Host "  RPC:           Disabled (Native in-process CUDA)" -ForegroundColor Gray

$nodeExe = "$workspaceRoot\build-cuda\swarm_node.exe"
if (-not (Test-Path $nodeExe)) {
    throw "swarm_node.exe not found at $nodeExe. Please build the project first."
}

Write-Host "`nLaunching coordinator..." -ForegroundColor Cyan
$proc = Start-Process -FilePath $nodeExe -WorkingDirectory $workspaceRoot -PassThru

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
    Write-Host "`nSwarm Local CUDA is READY at http://127.0.0.1:$Port/v1/chat/completions (PID: $($proc.Id))" -ForegroundColor Green
} else {
    Write-Host "`nSwarm did not respond to /health check within 30 seconds." -ForegroundColor Red
}
