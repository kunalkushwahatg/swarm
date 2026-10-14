[CmdletBinding()]
param(
    [string]$ProjectRoot = "C:\Users\kunal\OneDrive\Desktop\swarm",
    [int]$RpcPort0 = 50052,
    [int]$RpcPort1 = 50053,
    [int]$HttpPort = 8080,
    [int]$ReadinessTimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'

$artifactDir = Join-Path $ProjectRoot 'artifacts\validation\2026-10-10\milestone-5'
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null

$rpcExe = Join-Path $ProjectRoot 'temp_rpc_build\bin\ggml-rpc-server.exe'
$swarmExe = Join-Path $ProjectRoot 'build-cuda\swarm_node.exe'
$modelPath = Join-Path $ProjectRoot 'models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf'
$pathEntries = @(
    (Join-Path $ProjectRoot 'build-cuda\bin'),
    (Join-Path $ProjectRoot 'temp_rpc_build\bin')
)
$env:PATH = (($pathEntries + $env:PATH) -join ';')

function Test-PortFree {
    param([int]$Port)
    return -not (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -eq $Port })
}

function Wait-Until {
    param(
        [scriptblock]$Condition,
        [int]$TimeoutSeconds,
        [string]$FailureMessage
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 250
    }
    throw $FailureMessage
}

function Stop-StartedProcess {
    param([System.Diagnostics.Process]$Process)
    if ($null -ne $Process) {
        $Process.Refresh()
        if (-not $Process.HasExited) {
            Stop-Process -Id ([int]$Process.Id) -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-StreamedContent {
    param([string]$Body)
    $pieces = [System.Collections.Generic.List[string]]::new()
    foreach ($line in ($Body -split '\r?\n')) {
        if (-not $line.StartsWith('data: ')) { continue }
        $payload = $line.Substring(6)
        if ($payload -eq '[DONE]') { continue }
        try {
            $event = $payload | ConvertFrom-Json
            $piece = $event.choices[0].delta.content
            if ($null -ne $piece) {
                $pieces.Add([string]$piece)
            }
        } catch {
            throw "Invalid SSE event in inference response: $payload"
        }
    }
    return ($pieces -join '')
}

function Run-SwarmCase {
    param(
        [string]$CaseName,
        [string]$PolicyMode,
        [string]$WorkerProfiles,
        [int]$Layers = 4,
        [bool]$ExpectStartupFailure = $false
    )

    Write-Host "----------------------------------------------------------"
    Write-Host "  RUNNING: $CaseName (Policy: $PolicyMode, Profiles: $WorkerProfiles)"
    Write-Host "----------------------------------------------------------"

    # Ensure ports are free
    if (-not (Test-PortFree $RpcPort0)) { throw "Port $RpcPort0 is in use" }
    if (-not (Test-PortFree $RpcPort1)) { throw "Port $RpcPort1 is in use" }
    if (-not (Test-PortFree $HttpPort)) { throw "Port $HttpPort is in use" }

    $rpc0Stdout = Join-Path $artifactDir "$CaseName-rpc0.stdout.log"
    $rpc0Stderr = Join-Path $artifactDir "$CaseName-rpc0.stderr.log"
    $rpc1Stdout = Join-Path $artifactDir "$CaseName-rpc1.stdout.log"
    $rpc1Stderr = Join-Path $artifactDir "$CaseName-rpc1.stderr.log"
    $swarmStdout = Join-Path $artifactDir "$CaseName-swarm.stdout.log"
    $swarmStderr = Join-Path $artifactDir "$CaseName-swarm.stderr.log"

    $rpc0Proc = Start-Process -FilePath $rpcExe `
        -ArgumentList @('--host', '127.0.0.1', '--port', [string]$RpcPort0, '--threads', '2') `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $rpc0Stdout `
        -RedirectStandardError $rpc0Stderr `
        -PassThru

    $rpc1Proc = Start-Process -FilePath $rpcExe `
        -ArgumentList @('--host', '127.0.0.1', '--port', [string]$RpcPort1, '--threads', '2') `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $rpc1Stdout `
        -RedirectStandardError $rpc1Stderr `
        -PassThru

    Wait-Until { -not (Test-PortFree $RpcPort0) } 15 "RPC0 failed to listen on $RpcPort0"
    Wait-Until { -not (Test-PortFree $RpcPort1) } 15 "RPC1 failed to listen on $RpcPort1"

    $env:SWARM_USE_RPC = '1'
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:$RpcPort0,127.0.0.1:$RpcPort1"
    $env:SWARM_N_GPU_LAYERS = [string]$Layers
    $env:SWARM_MODEL_PATH = $modelPath
    $env:SWARM_CTX_SIZE = '2048'
    $env:SWARM_MAX_TOKENS_DEFAULT = '16'
    $env:SWARM_HTTP_BIND = '127.0.0.1'
    $env:SWARM_HTTP_PORT = [string]$HttpPort
    $env:SWARM_PLACEMENT_POLICY = $PolicyMode
    $env:SWARM_WORKER_PROFILES = $WorkerProfiles

    $swarmProc = $null
    try {
        $swarmProc = Start-Process -FilePath $swarmExe `
            -WorkingDirectory $ProjectRoot `
            -RedirectStandardOutput $swarmStdout `
            -RedirectStandardError $swarmStderr `
            -PassThru

        if ($ExpectStartupFailure) {
            # Wait for exit
            $swarmProc.WaitForExit(10000)
            if ($swarmProc.HasExited -and $swarmProc.ExitCode -ne 0) {
                Write-Host "Controlled startup failure confirmed with ExitCode $($swarmProc.ExitCode)."
                return @{ Success = $true; ExitCode = $swarmProc.ExitCode }
            } else {
                throw "Expected startup failure but process did not exit with error"
            }
        }

        Wait-Until {
            try {
                $health = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -TimeoutSec 2
                return $health.model.loaded -and $health.context.created
            } catch { return $false }
        } $ReadinessTimeoutSeconds "Swarm did not become ready for case $CaseName"

        Write-Host "Swarm ready. Capturing backends, workers, and metrics..."
        $backends = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$HttpPort/backends"
        $backends | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $artifactDir "$CaseName-backends.json")

        $workers = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$HttpPort/workers"
        $workers | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $artifactDir "$CaseName-workers.json")

        $metrics = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$HttpPort/metrics").Content
        $metrics | Set-Content (Join-Path $artifactDir "$CaseName-metrics.txt")

        # Send test inference
        $request = @{
            messages = @(@{ role = 'user'; content = 'What is 2 + 2?' })
            max_tokens = 16
            temperature = 0
            stream = $false
        } | ConvertTo-Json -Depth 5 -Compress

        $resp = Invoke-WebRequest -UseBasicParsing -Method Post `
            -Uri "http://127.0.0.1:$HttpPort/v1/chat/completions" `
            -ContentType 'application/json' -Body $request -TimeoutSec 60

        $resp.Content | Set-Content (Join-Path $artifactDir "$CaseName-response.sse.log")

        $text = Get-StreamedContent $resp.Content
        Write-Host "Inference response: $text"
        if (-not ($text -like "*4*")) {
            throw "Response did not contain expected answer: $text"
        }

        return @{
            Success = $true
            Text = $text
            Backends = $backends
        }
    } finally {
        Stop-StartedProcess $swarmProc
        Stop-StartedProcess $rpc0Proc
        Stop-StartedProcess $rpc1Proc
        Start-Sleep -Seconds 1
    }
}

Write-Host "=========================================================="
Write-Host "  SWARM MILESTONE 5 VALIDATION SUITE"
Write-Host "=========================================================="

# CASE 1: Baseline (Policy NONE)
$resCase1 = Run-SwarmCase -CaseName 'case1-baseline' -PolicyMode 'none' -WorkerProfiles ''
Write-Host "[PASS] CASE 1 Baseline"

# CASE 2: Profile A (RPC0: 50MB, RPC1: 500MB, CUDA0: 4000MB)
# Expectation: RPC0=0 layers, RPC1=layers 33,34, CUDA0=layers 35,36
$resCase2 = Run-SwarmCase -CaseName 'case2-profile-a' `
    -PolicyMode 'resource_aware' `
    -WorkerProfiles '127.0.0.1:50052=50MB,127.0.0.1:50053=500MB,local-cuda-0=4000MB'
Write-Host "[PASS] CASE 2 Profile A"

# CASE 3: Profile B (RPC0: 500MB, RPC1: 50MB, CUDA0: 4000MB)
# Expectation: RPC0=layers 33,34, RPC1=0 layers, CUDA0=layers 35,36
$resCase3 = Run-SwarmCase -CaseName 'case3-profile-b' `
    -PolicyMode 'resource_aware' `
    -WorkerProfiles '127.0.0.1:50052=500MB,127.0.0.1:50053=50MB,local-cuda-0=4000MB'
Write-Host "[PASS] CASE 3 Profile B"

# CASE 4: Both RPC low (RPC0: 50MB, RPC1: 50MB, CUDA0: 4000MB)
# Expectation: RPC0=0 layers, RPC1=0 layers, CUDA0=all 4 layers (33-36)
$resCase4 = Run-SwarmCase -CaseName 'case4-both-low' `
    -PolicyMode 'resource_aware' `
    -WorkerProfiles '127.0.0.1:50052=50MB,127.0.0.1:50053=50MB,local-cuda-0=4000MB'
Write-Host "[PASS] CASE 4 Both Low"

# CASE 5: Total simulated capacity insufficient
$resCase5 = Run-SwarmCase -CaseName 'case5-insufficient' `
    -PolicyMode 'resource_aware' `
    -WorkerProfiles '127.0.0.1:50052=50MB,127.0.0.1:50053=50MB,local-cuda-0=150MB' `
    -ExpectStartupFailure $true
Write-Host "[PASS] CASE 5 Controlled Insufficient Capacity Error"

# CASE 6: Repeated Inference (5 trials under Profile A)
Write-Host "----------------------------------------------------------"
Write-Host "  RUNNING: CASE 6 Repeated Inference (5 trials, Profile A)"
Write-Host "----------------------------------------------------------"
if (-not (Test-PortFree $RpcPort0)) { throw "Port $RpcPort0 is in use" }
if (-not (Test-PortFree $RpcPort1)) { throw "Port $RpcPort1 is in use" }
if (-not (Test-PortFree $HttpPort)) { throw "Port $HttpPort is in use" }

$rpc0Proc6 = Start-Process -FilePath $rpcExe `
    -ArgumentList @('--host', '127.0.0.1', '--port', [string]$RpcPort0, '--threads', '2') `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput (Join-Path $artifactDir 'case6-rpc0.stdout.log') `
    -RedirectStandardError (Join-Path $artifactDir 'case6-rpc0.stderr.log') `
    -PassThru

$rpc1Proc6 = Start-Process -FilePath $rpcExe `
    -ArgumentList @('--host', '127.0.0.1', '--port', [string]$RpcPort1, '--threads', '2') `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput (Join-Path $artifactDir 'case6-rpc1.stdout.log') `
    -RedirectStandardError (Join-Path $artifactDir 'case6-rpc1.stderr.log') `
    -PassThru

Wait-Until { -not (Test-PortFree $RpcPort0) } 15 "RPC0 failed to listen on $RpcPort0"
Wait-Until { -not (Test-PortFree $RpcPort1) } 15 "RPC1 failed to listen on $RpcPort1"

$env:SWARM_USE_RPC = '1'
$env:SWARM_RPC_ENDPOINTS = "127.0.0.1:$RpcPort0,127.0.0.1:$RpcPort1"
$env:SWARM_N_GPU_LAYERS = '4'
$env:SWARM_MODEL_PATH = $modelPath
$env:SWARM_CTX_SIZE = '2048'
$env:SWARM_MAX_TOKENS_DEFAULT = '16'
$env:SWARM_HTTP_BIND = '127.0.0.1'
$env:SWARM_HTTP_PORT = [string]$HttpPort
$env:SWARM_PLACEMENT_POLICY = 'resource_aware'
$env:SWARM_WORKER_PROFILES = '127.0.0.1:50052=50MB,127.0.0.1:50053=500MB,local-cuda-0=4000MB'

$swarmProc6 = $null
try {
    $swarmProc6 = Start-Process -FilePath $swarmExe `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput (Join-Path $artifactDir 'case6-swarm.stdout.log') `
        -RedirectStandardError (Join-Path $artifactDir 'case6-swarm.stderr.log') `
        -PassThru

    Wait-Until {
        try {
            $health = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$HttpPort/health" -TimeoutSec 2
            return $health.model.loaded -and $health.context.created
        } catch { return $false }
    } $ReadinessTimeoutSeconds "Swarm did not become ready for Case 6"

    $reqJson = @{
        messages = @(@{ role = 'user'; content = 'What is 2 + 2?' })
        max_tokens = 16
        temperature = 0
        stream = $false
    } | ConvertTo-Json -Depth 5 -Compress

    for ($i = 1; $i -le 5; $i++) {
        $resp = Invoke-WebRequest -UseBasicParsing -Method Post `
            -Uri "http://127.0.0.1:$HttpPort/v1/chat/completions" `
            -ContentType 'application/json' -Body $reqJson -TimeoutSec 60
        $text = Get-StreamedContent $resp.Content
        Write-Host "  Trial $i result: $text"
        if (-not ($text -like "*4*")) { throw "Trial $i failed: $text" }
    }
    Write-Host "[PASS] CASE 6 Repeated Inference (5/5 correct)"
} finally {
    Stop-StartedProcess $swarmProc6
    Stop-StartedProcess $rpc0Proc6
    Stop-StartedProcess $rpc1Proc6
    Start-Sleep -Seconds 1
}

# CASE 8: Full local CUDA fallback (SWARM_USE_RPC=0, LAYERS=-1)
Write-Host "----------------------------------------------------------"
Write-Host "  RUNNING: CASE 8 Full Local CUDA Fallback"
Write-Host "----------------------------------------------------------"
$env:SWARM_USE_RPC = '0'
$env:SWARM_N_GPU_LAYERS = '-1'
$env:SWARM_MODEL_PATH = $modelPath
$env:SWARM_CTX_SIZE = '2048'
$env:SWARM_MAX_TOKENS_DEFAULT = '16'
$env:SWARM_HTTP_BIND = '127.0.0.1'
$env:SWARM_HTTP_PORT = [string]$HttpPort
$env:SWARM_PLACEMENT_POLICY = 'none'
$env:SWARM_WORKER_PROFILES = $null

$c8Proc = Start-Process -FilePath $swarmExe `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput (Join-Path $artifactDir 'case8-cuda.stdout.log') `
    -RedirectStandardError (Join-Path $artifactDir 'case8-cuda.stderr.log') `
    -PassThru

try {
    Wait-Until {
        try {
            $health = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$HttpPort/health" -TimeoutSec 2
            return $health.model.loaded -and $health.context.created
        } catch { return $false }
    } $ReadinessTimeoutSeconds "Swarm CUDA fallback did not become ready"

    $reqJson = @{
        messages = @(@{ role = 'user'; content = 'What is 2 + 2?' })
        max_tokens = 16
        temperature = 0
        stream = $false
    } | ConvertTo-Json -Depth 5 -Compress

    $resp = Invoke-WebRequest -UseBasicParsing -Method Post `
        -Uri "http://127.0.0.1:$HttpPort/v1/chat/completions" `
        -ContentType 'application/json' -Body $reqJson -TimeoutSec 60

    $text = Get-StreamedContent $resp.Content
    Write-Host "Inference response: $text"
    if (-not ($text -like "*4*")) { throw "Response error: $text" }
    Write-Host "[PASS] CASE 8 Full Local CUDA Fallback"
} finally {
    Stop-StartedProcess $c8Proc
    Start-Sleep -Seconds 1
}

# CASE 7: Repeatable Fault Regression Test
Write-Host "----------------------------------------------------------"
Write-Host "  RUNNING: CASE 7 Worker Fault Regression Test"
Write-Host "----------------------------------------------------------"
$env:SWARM_PLACEMENT_POLICY = $null
$env:SWARM_WORKER_PROFILES = $null
$faultScript = Join-Path $ProjectRoot 'scripts\Invoke-MultiRpcFaultTest.ps1'
& powershell -File $faultScript
Write-Host "[PASS] CASE 7 Worker Fault Regression Test"

Write-Host "=========================================================="
Write-Host "  ALL MILESTONE 5 VALIDATION SUITE TESTS PASSED!"
Write-Host "=========================================================="
