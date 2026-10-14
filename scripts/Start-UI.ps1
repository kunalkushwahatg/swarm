# Start-UI.ps1
# Development and Preview launcher for Swarm UI
# Connects frontend to Swarm coordinator on 127.0.0.1:8080 via Vite development proxy

[CmdletBinding()]
param(
    [int]$Port = 5173,
    [switch]$Preview = $false
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkspaceRoot = (Get-Item $ScriptDir).Parent.FullName
$UiDir = Join-Path $WorkspaceRoot "ui"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Swarm: Web UI Launcher" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Verify Node and npm
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "npm is not installed or not in PATH. Please install Node.js."
    exit 1
}

# 2. Check port 5173
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    Write-Warning "Port $Port is already occupied by PID $($conn.OwningProcess)."
}

Write-Host "Starting Swarm UI from $UiDir..." -ForegroundColor Green
Write-Host "Vite dev proxy is configured to route API calls to http://127.0.0.1:8080" -ForegroundColor Gray
Write-Host "Local URL: http://127.0.0.1:$Port/" -ForegroundColor Cyan

Push-Location $UiDir
try {
    if ($Preview) {
        npm run preview -- --port $Port
    } else {
        npm run dev -- --port $Port
    }
}
finally {
    Pop-Location
}
