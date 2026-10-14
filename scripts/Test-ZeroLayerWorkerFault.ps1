# Test-ZeroLayerWorkerFault.ps1
# Deterministic regression test for Audit B: Zero-layer RPC worker fault resilience.
# Verifies that when an RPC worker with 0 assigned layers fails, inference continues uninterrupted.
# Verifies that when an RPC worker with >0 assigned layers fails, inference is rejected with HTTP 503.

param(
    [int]$HttpPort = 8080,
    [int]$RpcPort0 = 50052,
    [int]$RpcPort1 = 50053,
    [int]$ReadinessTimeoutSeconds = 45,
    [int]$InferenceTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$swarmExe = Join-Path $ProjectRoot "build-cuda\swarm_node.exe"
$rpcExe = Join-Path $ProjectRoot "temp_rpc_build\bin\ggml-rpc-server.exe"
$modelPath = Join-Path $ProjectRoot "models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf"
$artifactRoot = Join-Path $ProjectRoot "artifacts\validation\2026-10-10\milestone-6"

if (-not (Test-Path $artifactRoot)) {
    New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
}

function Test-PortFree([int]$Port) {
    $conn = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
    return ($null -eq $conn)
}

function Wait-Until([scriptblock]$Condition, [int]$TimeoutSeconds, [string]$FailureMessage) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (& $Condition) { return $true }
        Start-Sleep -Milliseconds 250
    }
    throw $FailureMessage
}

function Stop-StartedProcess($proc) {
    if ($null -ne $proc) {
        try {
            if (-not $proc.HasExited) {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                $proc.WaitForExit(3000)
            }
        } catch {}
    }
}

function Get-StreamedContent([string]$RawBody) {
    $tokens = [System.Collections.Generic.List[string]]::new()
    foreach ($line in ($RawBody -split "`r?`n")) {
        if ($line.StartsWith("data: ")) {
            $data = $line.Substring(6).Trim()
            if ($data -eq "[DONE]") { break }
            try {
                $j = $data | ConvertFrom-Json
                if ($j.choices -and $j.choices[0].delta -and $j.choices[0].delta.content) {
                    $tokens.Add($j.choices[0].delta.content)
                }
            } catch {}
        }
    }
    return ($tokens -join "")
}

Write-Host "=== Testing Audit B: Zero-Layer Worker Fault Resilience ===" -ForegroundColor Cyan

# Ensure clean starting state
foreach ($p in @($HttpPort, $RpcPort0, $RpcPort1)) {
    if (-not (Test-PortFree $p)) {
        throw "Port $p is already in use before test start."
    }
}

$rpc0 = $null; $rpc1 = $null; $swarm = $null
$results = [ordered]@{}

try {
    # 1. Start RPC0 (port 50052) and RPC1 (port 50053)
    Write-Host "  Starting RPC servers..." -ForegroundColor Gray
    $rpc0 = Start-Process -FilePath $rpcExe -ArgumentList "--host 127.0.0.1 --port $RpcPort0 --threads 2" `
        -WorkingDirectory $ProjectRoot -PassThru
    $rpc1 = Start-Process -FilePath $rpcExe -ArgumentList "--host 127.0.0.1 --port $RpcPort1 --threads 2" `
        -WorkingDirectory $ProjectRoot -PassThru

    Wait-Until { (-not (Test-PortFree $RpcPort0)) -and (-not (Test-PortFree $RpcPort1)) } 10 "RPC listeners not ready"

    # 2. Start Swarm with Profile A (RPC0=50MB [0 layers], RPC1=500MB [2 layers], CUDA0=4000MB [2 layers])
    Write-Host "  Starting Swarm with Resource-Aware Profile A..." -ForegroundColor Gray
    $env:SWARM_USE_RPC = "1"
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:$RpcPort0, 127.0.0.1:$RpcPort1"
    $env:SWARM_PLACEMENT_POLICY = "resource_aware"
    $env:SWARM_WORKER_PROFILES = "127.0.0.1:$RpcPort0=50MB,127.0.0.1:$RpcPort1=500MB,local-cuda-0=4000MB"
    $env:SWARM_MODEL_PATH = $modelPath
    $env:SWARM_N_GPU_LAYERS = "4"
    $env:SWARM_CTX_SIZE = "2048"
    $env:SWARM_MAX_TOKENS_DEFAULT = "16"
    $env:SWARM_HTTP_BIND = "127.0.0.1"
    $env:SWARM_HTTP_PORT = "$HttpPort"
    $env:PATH = "$ProjectRoot\build-cuda\bin;$env:PATH"

    $sStdout = Join-Path $artifactRoot "audit-b-swarm.stdout.log"
    $sStderr = Join-Path $artifactRoot "audit-b-swarm.stderr.log"
    $swarm = Start-Process -FilePath $swarmExe -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $sStdout -RedirectStandardError $sStderr -PassThru

    Wait-Until {
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing -TimeoutSec 2
            return $h.model.loaded -and $h.context.created -and $h.inference.ready
        } catch { return $false }
    } $ReadinessTimeoutSeconds "Swarm did not report inference ready at startup"

    # 3. Verify initial layer distribution
    $hInit = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing
    $wRpc0 = $hInit.workers | Where-Object { $_.port -eq $RpcPort0 }
    $wRpc1 = $hInit.workers | Where-Object { $_.port -eq $RpcPort1 }

    $rpc0Layers = $wRpc0.assigned_layers.Count
    $rpc1Layers = $wRpc1.assigned_layers.Count
    Write-Host "  Initial: RPC0 assigned layers: $rpc0Layers | RPC1 assigned layers: $rpc1Layers" -ForegroundColor Gray
    Write-Host "  Required RPC workers: $($hInit.inference.required_rpc_workers) / $($hInit.inference.total_rpc_workers)" -ForegroundColor Gray

    if ($rpc0Layers -ne 0 -or $rpc1Layers -le 0) {
        throw "Placement did not match expected Profile A: RPC0 must have 0 layers, RPC1 must have >0 layers."
    }

    # 4. Stop RPC0 (the zero-layer worker)
    Write-Host "  Stopping zero-layer worker RPC0 (port $RpcPort0)..." -ForegroundColor Yellow
    Stop-StartedProcess $rpc0
    $rpc0 = $null

    Start-Sleep -Milliseconds 500

    # 5. Check /health after stopping zero-layer worker
    $hAfterZero = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing
    Write-Host "  After RPC0 stop: inference.ready = $($hAfterZero.inference.ready), ready_required = $($hAfterZero.inference.ready_required_rpc_workers) / $($hAfterZero.inference.required_rpc_workers)" -ForegroundColor Gray

    $zeroWorkerLossReady = ($hAfterZero.inference.ready -eq $true) -and `
                           ($hAfterZero.inference.ready_required_rpc_workers -eq 1) -and `
                           ($hAfterZero.inference.required_rpc_workers -eq 1)

    # 6. Send inference request - MUST SUCCEED with HTTP 200
    Write-Host "  Sending inference request with zero-layer worker down..." -ForegroundColor Yellow
    $reqBody = @{
        messages = @(@{ role = "user"; content = "What is 2 + 2?" })
        max_tokens = 16
        temperature = 0
    } | ConvertTo-Json -Depth 5 -Compress

    $resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$HttpPort/v1/chat/completions" `
        -ContentType "application/json" -Body $reqBody -TimeoutSec $InferenceTimeoutSeconds
    $text = Get-StreamedContent $resp.Content
    Write-Host "  Response text: '$text'" -ForegroundColor Gray

    $zeroLossInferenceSuccess = ($resp.StatusCode -eq 200) -and ($text -match '2\s*\+\s*2\s*(equals|is)\s*4')

    # 7. Now stop RPC1 (the required-layer worker)
    Write-Host "  Stopping required worker RPC1 (port $RpcPort1)..." -ForegroundColor Yellow
    Stop-StartedProcess $rpc1
    $rpc1 = $null

    Start-Sleep -Milliseconds 500

    # 8. Check /health after stopping required worker
    $hAfterReq = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing
    Write-Host "  After RPC1 stop: inference.ready = $($hAfterReq.inference.ready), unready_reason = '$($hAfterReq.inference.unready_reason)'" -ForegroundColor Gray

    $reqLossUnready = ($hAfterReq.inference.ready -eq $false) -and `
                      ($hAfterReq.inference.unready_reason -match 'rpc-endpoint-1')

    # 9. Send inference request - MUST BE REJECTED with controlled HTTP 503
    Write-Host "  Sending inference request with required worker down..." -ForegroundColor Yellow
    $caught503 = $false
    $errRespCode = 0
    try {
        $resp503 = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$HttpPort/v1/chat/completions" `
            -ContentType "application/json" -Body $reqBody -TimeoutSec 10
        $errRespCode = $resp503.StatusCode
    } catch {
        if ($_.Exception.Response) {
            $errRespCode = [int]$_.Exception.Response.StatusCode
            if ($errRespCode -eq 503) {
                $caught503 = $true
            }
        }
    }
    Write-Host "  Caught 503: $caught503 (StatusCode: $errRespCode)" -ForegroundColor Gray

    # 10. Confirm Swarm remained alive throughout
    $swarmAlive = -not $swarm.HasExited
    Write-Host "  Swarm remained alive: $swarmAlive" -ForegroundColor Gray

    $allPassed = $zeroWorkerLossReady -and $zeroLossInferenceSuccess -and $reqLossUnready -and $caught503 -and $swarmAlive

    $results["ZeroLayerFaultTest"] = [ordered]@{
        Status = if ($allPassed) { "PASS" } else { "FAIL" }
        Rpc0AssignedLayers = $rpc0Layers
        Rpc1AssignedLayers = $rpc1Layers
        InferenceReadyWithZeroWorkerDown = $hAfterZero.inference.ready
        ZeroWorkerLossInferenceText = $text
        ZeroWorkerLossInferenceSuccess = $zeroLossInferenceSuccess
        InferenceReadyWithRequiredWorkerDown = $hAfterReq.inference.ready
        CaughtExpected503OnRequiredLoss = $caught503
        SwarmRemainedAlive = $swarmAlive
    }

    $results | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $artifactRoot "zero_layer_fault_test.json")

    Write-Host "`nTest Result: $(if ($allPassed) {'PASS'} else {'FAIL'})" -ForegroundColor $(if ($allPassed) {'Green'} else {'Red'})

} finally {
    Stop-StartedProcess $swarm
    Stop-StartedProcess $rpc0
    Stop-StartedProcess $rpc1
    Start-Sleep -Seconds 1
}
