#requires -Version 5.1
<#
.SYNOPSIS
    Assembles a portable Swarm RPC worker bundle for Windows x64.

.DESCRIPTION
    Copies the GGML runtime that matches the requested backend into dist/.
    Use -Backend cuda for a GPU-capable bundle; the default CPU bundle stays small.

.PARAMETER Backend
    "cpu" (default) or "cuda".

.PARAMETER BuildDir
    CMake build directory. Defaults to <repo>\build-cuda.

.PARAMETER OutDir
    Destination directory. Defaults to <repo>\dist\swarm-worker-windows-x64[-cuda].
#>
[CmdletBinding()]
param(
    [ValidateSet("cpu", "cuda")]
    [string]$Backend = "cpu",
    [string]$BuildDir = "",
    [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
if (-not $BuildDir) { $BuildDir = Join-Path $repo "build-cuda" }

# CMake puts runtime DLLs under <build>\bin on Windows. The RPC server and the
# CUDA runtime may live in separate build or redist folders, so search all of
# the known locations instead of assuming one directory.
$searchDirs = @(
    (Join-Path $BuildDir "bin"),
    $BuildDir,
    (Join-Path $repo "temp_rpc_build\bin"),
    (Join-Path $repo "dist\swarm-worker-windows-x64"),
    (Join-Path $repo "dist\cuda-redist"),
    (Join-Path $repo "spike\desktop-shell\src-tauri\target\release\bin")
)
if ($env:CUDA_PATH) { $searchDirs += (Join-Path $env:CUDA_PATH "bin") }
$searchDirs = $searchDirs | Where-Object { Test-Path $_ } | Select-Object -Unique

function Copy-RuntimeFile {
    param([string]$FileName)
    foreach ($dir in $searchDirs) {
        $candidate = Join-Path $dir $FileName
        $destination = Join-Path $OutDir $FileName
        if ((Test-Path $candidate) -and ([System.IO.Path]::GetFullPath($candidate) -ne [System.IO.Path]::GetFullPath($destination))) {
            Copy-Item $candidate $destination -Force
            return
        }
        if (Test-Path $candidate) {
            return
        }
    }
    throw "Missing '$FileName'. Build the runtime first, or pass -BuildDir pointing at a folder that contains it."
}

if (-not $OutDir) {
    $name = if ($Backend -eq "cuda") { "swarm-worker-windows-x64-cuda" } else { "swarm-worker-windows-x64" }
    $OutDir = Join-Path $repo "dist\$name"
}

$coreFiles = @(
    "ggml-rpc-server.exe",
    "ggml.dll",
    "ggml-base.dll",
    "ggml-rpc.dll",
    "ggml-cpu.dll"
)
$cudaFiles = @(
    "ggml-cuda.dll",
    "cudart64_12.dll",
    "cublas64_12.dll",
    "cublasLt64_12.dll"
)

$files = @($coreFiles)
if ($Backend -eq "cuda") { $files += $cudaFiles }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

foreach ($file in $files) {
    Copy-RuntimeFile $file
}

# Reuse the telemetry agent and launcher from an existing package when present.
$agentSources = @(
    (Join-Path $BuildDir "swarm_agent.exe"),
    (Join-Path $repo "dist\swarm-worker-windows-x64\swarm_agent.exe")
)
$agent = $agentSources | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($agent -and ([System.IO.Path]::GetFullPath($agent) -ne [System.IO.Path]::GetFullPath((Join-Path $OutDir "swarm_agent.exe")))) {
    Copy-Item $agent (Join-Path $OutDir "swarm_agent.exe") -Force
}

$launcher = Join-Path $repo "dist\swarm-worker-windows-x64\Start-RemoteWorker.ps1"
if ((Test-Path $launcher) -and ([System.IO.Path]::GetFullPath($launcher) -ne [System.IO.Path]::GetFullPath((Join-Path $OutDir "Start-RemoteWorker.ps1")))) {
    Copy-Item $launcher (Join-Path $OutDir "Start-RemoteWorker.ps1") -Force
}

$backendLabel = if ($Backend -eq "cuda") { "CUDA + CPU" } else { "CPU only" }
$readme = @"
# Swarm Remote Worker Node (Windows x64)

Backend: $backendLabel

## Device selection

ggml-rpc-server accepts an explicit device list:

    ggml-rpc-server.exe -H 0.0.0.0 -p 50052 -d CUDA0
    ggml-rpc-server.exe -H 0.0.0.0 -p 50052 -d CUDA0,CUDA1
    ggml-rpc-server.exe -H 0.0.0.0 -p 50052 -d CPU

Leave out -d to export every non-CPU device (all GPUs, or CPU when no GPU exists).

## Firewall

Inbound TCP port 50052 must be reachable from the coordinator:

    New-NetFirewallRule -DisplayName "Swarm GGML RPC" -Direction Inbound -LocalPort 50052 -Protocol TCP -Action Allow
"@
Set-Content -Path (Join-Path $OutDir "README.md") -Value $readme -Encoding UTF8

$totalMb = [math]::Round((Get-ChildItem $OutDir -File | Measure-Object Length -Sum).Sum / 1MB)
Write-Host "Worker bundle ready: $OutDir"
Write-Host "Backend: $backendLabel, size: $totalMb MB"
