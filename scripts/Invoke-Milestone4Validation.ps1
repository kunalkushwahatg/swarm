[CmdletBinding()]
param(
    [string]$ProjectRoot = "C:\Users\kunal\OneDrive\Desktop\swarm",
    [int]$RpcPort0 = 50052,
    [int]$RpcPort1 = 50053,
    [int]$HttpPort = 8080,
    [int]$ReadinessTimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'

$artifactDir = Join-Path $ProjectRoot 'artifacts\validation\2026-10-10\milestone-4'
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

Write-Host "=========================================================="
Write-Host "  TEST 1: LOCAL CUDA INFERENCE (SWARM_USE_RPC=0, LAYERS=-1)"
Write-Host "=========================================================="

$env:SWARM_USE_RPC = '0'
$env:SWARM_N_GPU_LAYERS = '-1'
$env:SWARM_MODEL_PATH = $modelPath
$env:SWARM_CTX_SIZE = '2048'
$env:SWARM_MAX_TOKENS_DEFAULT = '16'
$env:SWARM_HTTP_BIND = '127.0.0.1'
$env:SWARM_HTTP_PORT = [string]$HttpPort

$swarmLocalStdout = Join-Path $artifactDir 'local-cuda-swarm.stdout.log'
$swarmLocalStderr = Join-Path $artifactDir 'local-cuda-swarm.stderr.log'

$swarmProc = $null
try {
    if (-not (Test-PortFree $HttpPort)) {
        throw "Port $HttpPort is already in use"
    }

    $swarmProc = Start-Process -FilePath $swarmExe `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $swarmLocalStdout `
        -RedirectStandardError $swarmLocalStderr `
        -PassThru

    Wait-Until {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -TimeoutSec 2
            return $health.model.loaded -and $health.context.created
        } catch { return $false }
    } $ReadinessTimeoutSeconds "Swarm local CUDA did not become ready"

    Write-Host "Swarm Local CUDA ready. Fetching endpoints..."
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health"
    $health | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $artifactDir 'local-cuda-health.json')

    $workers = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/workers"
    $workers | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $artifactDir 'local-cuda-workers.json')

    $backends = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/backends"
    $backends | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $artifactDir 'local-cuda-backends.json')

    Write-Host "Sending inference request..."
    $request = @{
        messages = @(@{ role = 'user'; content = 'What is 2 + 2?' })
        max_tokens = 16
        temperature = 0
        stream = $false
    } | ConvertTo-Json -Depth 5 -Compress

    $resp = Invoke-WebRequest -UseBasicParsing -Method Post `
        -Uri "http://127.0.0.1:$HttpPort/v1/chat/completions" `
        -ContentType 'application/json' -Body $request -TimeoutSec 60
    $resp.Content | Set-Content (Join-Path $artifactDir 'local-cuda-response.sse.log')

    $text = Get-StreamedContent $resp.Content
    Write-Host "Local CUDA generated text: $text"
    if ($text -notmatch '2\s*\+\s*2\s*(equals|is)\s*4') {
        throw "Unexpected local CUDA inference result: $text"
    }

    $metrics = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$HttpPort/metrics").Content
    $metrics | Set-Content (Join-Path $artifactDir 'local-cuda-metrics.txt')

    Write-Host "Test 1 Local CUDA PASS!"
} finally {
    Stop-StartedProcess $swarmProc
    Start-Sleep -Seconds 2
}

Write-Host "`n=========================================================="
Write-Host "  TEST 2: TWO LOOPBACK RPC WORKERS (50052, 50053, LAYERS=4)"
Write-Host "=========================================================="

$rpc0Proc = $null
$rpc1Proc = $null
$swarmRpcProc = $null

try {
    foreach ($p in @($RpcPort0, $RpcPort1, $HttpPort)) {
        if (-not (Test-PortFree $p)) {
            throw "Port $p is already occupied before Test 2"
        }
    }

    $rpc0Stdout = Join-Path $artifactDir 'rpc-50052.stdout.log'
    $rpc0Stderr = Join-Path $artifactDir 'rpc-50052.stderr.log'
    $rpc0Proc = Start-Process -FilePath $rpcExe `
        -ArgumentList '--host', '127.0.0.1', '--port', $RpcPort0, '--threads', '2' `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $rpc0Stdout `
        -RedirectStandardError $rpc0Stderr `
        -PassThru

    $rpc1Stdout = Join-Path $artifactDir 'rpc-50053.stdout.log'
    $rpc1Stderr = Join-Path $artifactDir 'rpc-50053.stderr.log'
    $rpc1Proc = Start-Process -FilePath $rpcExe `
        -ArgumentList '--host', '127.0.0.1', '--port', $RpcPort1, '--threads', '2' `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $rpc1Stdout `
        -RedirectStandardError $rpc1Stderr `
        -PassThru

    Wait-Until { -not (Test-PortFree $RpcPort0) -and -not (Test-PortFree $RpcPort1) } `
        $ReadinessTimeoutSeconds "RPC servers did not open ports"

    Write-Host "RPC servers listening. Starting Swarm..."

    $env:SWARM_USE_RPC = '1'
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:$RpcPort0,127.0.0.1:$RpcPort1"
    $env:SWARM_N_GPU_LAYERS = '4'
    $env:SWARM_MODEL_PATH = $modelPath
    $env:SWARM_CTX_SIZE = '2048'
    $env:SWARM_MAX_TOKENS_DEFAULT = '16'
    $env:SWARM_HTTP_BIND = '127.0.0.1'
    $env:SWARM_HTTP_PORT = [string]$HttpPort

    $swarmRpcStdout = Join-Path $artifactDir 'multi-rpc-swarm.stdout.log'
    $swarmRpcStderr = Join-Path $artifactDir 'multi-rpc-swarm.stderr.log'
    $swarmRpcProc = Start-Process -FilePath $swarmExe `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $swarmRpcStdout `
        -RedirectStandardError $swarmRpcStderr `
        -PassThru

    Wait-Until {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -TimeoutSec 2
            return $health.model.loaded -and $health.context.created
        } catch { return $false }
    } $ReadinessTimeoutSeconds "Swarm Multi-RPC did not become ready"

    Write-Host "Swarm Multi-RPC ready. Fetching endpoints..."
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health"
    $health | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $artifactDir 'multi-rpc-health.json')

    $workers = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/workers"
    $workers | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $artifactDir 'multi-rpc-workers.json')

    $backends = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/backends"
    $backends | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $artifactDir 'multi-rpc-backends.json')

    Write-Host "Sending inference request to Multi-RPC Swarm..."
    $request = @{
        messages = @(@{ role = 'user'; content = 'What is 2 + 2?' })
        max_tokens = 16
        temperature = 0
        stream = $false
    } | ConvertTo-Json -Depth 5 -Compress

    $resp = Invoke-WebRequest -UseBasicParsing -Method Post `
        -Uri "http://127.0.0.1:$HttpPort/v1/chat/completions" `
        -ContentType 'application/json' -Body $request -TimeoutSec 90
    $resp.Content | Set-Content (Join-Path $artifactDir 'multi-rpc-response.sse.log')

    $text = Get-StreamedContent $resp.Content
    Write-Host "Multi-RPC generated text: $text"
    if ($text -notmatch '2\s*\+\s*2\s*(equals|is)\s*4') {
        throw "Unexpected Multi-RPC inference result: $text"
    }

    $metrics = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$HttpPort/metrics").Content
    $metrics | Set-Content (Join-Path $artifactDir 'multi-rpc-metrics.txt')

    Write-Host "Test 2 Multi-RPC PASS!"
} finally {
    Stop-StartedProcess $swarmRpcProc
    Stop-StartedProcess $rpc0Proc
    Stop-StartedProcess $rpc1Proc
    Start-Sleep -Seconds 2
}

$allPortsFree = (Test-PortFree $RpcPort0) -and (Test-PortFree $RpcPort1) -and (Test-PortFree $HttpPort)
Write-Host "Cleanup check: all ports free = $allPortsFree"
if (-not $allPortsFree) {
    throw "Ports were not cleanly released!"
}

Write-Host "=========================================================="
Write-Host "  ALL VALIDATION TESTS PASSED SUCCESSFULLY!"
Write-Host "=========================================================="
