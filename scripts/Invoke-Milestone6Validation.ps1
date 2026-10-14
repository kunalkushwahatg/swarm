[CmdletBinding()]
param(
    [string]$ProjectRoot = "C:\Users\kunal\OneDrive\Desktop\swarm",
    [int]$RpcPort0 = 50052,
    [int]$RpcPort1 = 50053,
    [int]$HttpPort = 8080,
    [int]$ReadinessTimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'

$artifactRoot = Join-Path $ProjectRoot 'artifacts\validation\2026-10-10\milestone-6'
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null

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
    $conn = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -eq $Port }
    return ($null -eq $conn)
}

function Wait-Until {
    param(
        [scriptblock]$Condition,
        [int]$TimeoutSeconds,
        [string]$FailureMessage
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (& $Condition) {
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw $FailureMessage
}

function Start-RpcServer {
    param(
        [int]$Port,
        [string]$Prefix,
        [System.Collections.Generic.List[int]]$TrackPids
    )
    $stdout = Join-Path $artifactRoot "$Prefix-rpc-$Port.stdout.log"
    $stderr = Join-Path $artifactRoot "$Prefix-rpc-$Port.stderr.log"
    $process = Start-Process -FilePath $rpcExe `
        -ArgumentList '--host', '127.0.0.1', '--port', $Port, '--threads', '2' `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -PassThru
    $TrackPids.Add([int]$process.Id)

    Wait-Until {
        $listener = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object {
                $_.LocalAddress -eq '127.0.0.1' -and
                $_.LocalPort -eq $Port -and
                $_.OwningProcess -eq $process.Id
            }
        $listener -ne $null
    } $ReadinessTimeoutSeconds "RPC server did not listen on 127.0.0.1:$Port within timeout"

    return $process
}

function Stop-StartedProcess {
    param([System.Diagnostics.Process]$Process)
    if ($null -ne $Process) {
        $Process.Refresh()
        if (-not $Process.HasExited) {
            Stop-Process -Id ([int]$Process.Id) -Force -ErrorAction SilentlyContinue
            $Process.WaitForExit(3000) | Out-Null
        }
    }
}

function Get-StreamedContent {
    param([string]$Body)
    $pieces = [System.Collections.Generic.List[string]]::new()
    foreach ($line in ($Body -split '\r?\n')) {
        if (-not $line.StartsWith('data: ')) {
            continue
        }
        $payload = $line.Substring(6).Trim()
        if ($payload -eq '[DONE]' -or $payload -eq '') {
            continue
        }
        try {
            $event = $payload | ConvertFrom-Json
            if ($null -ne $event.choices -and $null -ne $event.choices[0].delta -and $null -ne $event.choices[0].delta.content) {
                $piece = $event.choices[0].delta.content
                $pieces.Add([string]$piece)
            }
        } catch {}
    }
    return ($pieces -join '')
}

$results = [ordered]@{}

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host " SWARM MILESTONE 6: MULTI-NODE ORCHESTRATION & RELIABILITY SUITE" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

# -----------------------------------------------------------------------------
# CASE 1: Worker Registration and Readiness Baseline
# -----------------------------------------------------------------------------
Write-Host "`n[Case 1] Worker Registration and Readiness..." -ForegroundColor Yellow
$pids1 = [System.Collections.Generic.List[int]]::new()
$rpc0_1 = $null; $rpc1_1 = $null; $swarm_1 = $null
try {
    $rpc0_1 = Start-RpcServer $RpcPort0 "case1" $pids1
    $rpc1_1 = Start-RpcServer $RpcPort1 "case1" $pids1

    $env:SWARM_USE_RPC = '1'
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:$RpcPort0, 127.0.0.1:$RpcPort1"
    $env:SWARM_MODEL_PATH = $modelPath
    $env:SWARM_N_GPU_LAYERS = '4'
    $env:SWARM_CTX_SIZE = '2048'
    $env:SWARM_MAX_TOKENS_DEFAULT = '16'
    $env:SWARM_HTTP_BIND = '127.0.0.1'
    $env:SWARM_HTTP_PORT = [string]$HttpPort
    $env:SWARM_PLACEMENT_POLICY = 'none'

    $sStdout = Join-Path $artifactRoot "case1-swarm.stdout.log"
    $sStderr = Join-Path $artifactRoot "case1-swarm.stderr.log"
    $swarm_1 = Start-Process -FilePath $swarmExe -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $sStdout -RedirectStandardError $sStderr -PassThru
    $pids1.Add([int]$swarm_1.Id)

    Wait-Until {
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing -TimeoutSec 2
            return $h.model.loaded -and $h.context.created -and $h.inference.ready
        } catch { return $false }
    } $ReadinessTimeoutSeconds "Case 1: Swarm did not report inference ready"

    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing
    $backends = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/backends" -UseBasicParsing
    $health | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $artifactRoot "case1-health.json")
    $backends | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $artifactRoot "case1-backends.json")

    $reqBody = @{
        messages = @(@{ role = "user"; content = "What is 2 + 2?" })
        max_tokens = 16
        temperature = 0
    } | ConvertTo-Json -Depth 5 -Compress

    $resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$HttpPort/v1/chat/completions" `
        -ContentType "application/json" -Body $reqBody -TimeoutSec 60
    $text = Get-StreamedContent $resp.Content

    $passed = ($text -match '2\s*\+\s*2\s*(equals|is)\s*4') -and ($health.inference.ready -eq $true) -and ($health.inference.ready_workers -eq 2)
    $results["Case 1: Worker Registration and Readiness"] = @{
        Status = if ($passed) { "PASS" } else { "FAIL" }
        InferenceReady = $health.inference.ready
        ReadyWorkers = $health.inference.ready_workers
        ResponseText = $text
    }
    Write-Host "  Result: $(if ($passed) {'PASS'} else {'FAIL'}) (ReadyWorkers=$($health.inference.ready_workers), Text='$text')" -ForegroundColor $(if ($passed) {'Green'} else {'Red'})
} finally {
    Stop-StartedProcess $swarm_1; Stop-StartedProcess $rpc0_1; Stop-StartedProcess $rpc1_1
    Wait-Until { (Test-PortFree $HttpPort) -and (Test-PortFree $RpcPort0) -and (Test-PortFree $RpcPort1) } 10 "Ports not free after Case 1"
}

# -----------------------------------------------------------------------------
# CASE 2: Invalid or Unreachable Endpoints at Startup
# -----------------------------------------------------------------------------
Write-Host "`n[Case 2] Invalid or Unreachable Endpoints at Startup..." -ForegroundColor Yellow
$pids2 = [System.Collections.Generic.List[int]]::new()
$rpc0_2 = $null; $swarm_2a = $null; $swarm_2b = $null
try {
    # 2a: One reachable (50052), one unreachable (59999)
    $rpc0_2 = Start-RpcServer $RpcPort0 "case2" $pids2
    $env:SWARM_USE_RPC = '1'
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:$RpcPort0, 127.0.0.1:59999"
    $env:SWARM_PLACEMENT_POLICY = 'none'

    $sStdout2a = Join-Path $artifactRoot "case2a-unreachable-stdout.log"
    $sStderr2a = Join-Path $artifactRoot "case2a-unreachable-stderr.log"
    $swarm_2a = Start-Process -FilePath $swarmExe -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $sStdout2a -RedirectStandardError $sStderr2a -PassThru -Wait
    $pids2.Add([int]$swarm_2a.Id)
    $exitedCleanly2a = $swarm_2a.HasExited -and ($swarm_2a.ExitCode -eq 1)
    $stderr2a = if (Test-Path $sStderr2a) { Get-Content -Raw $sStderr2a } else { "" }
    $diagnosed2a = ($stderr2a -match 'Failed to connect to RPC server' -or $stderr2a -match 'Failed to register worker')

    # 2b: Malformed endpoint (port out of range)
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:99999"
    $sStdout2b = Join-Path $artifactRoot "case2b-malformed-stdout.log"
    $sStderr2b = Join-Path $artifactRoot "case2b-malformed-stderr.log"
    $swarm_2b = Start-Process -FilePath $swarmExe -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $sStdout2b -RedirectStandardError $sStderr2b -PassThru -Wait
    $pids2.Add([int]$swarm_2b.Id)
    $exitedCleanly2b = $swarm_2b.HasExited -and ($swarm_2b.ExitCode -eq 1)

    $passed2 = $exitedCleanly2a -and $diagnosed2a -and $exitedCleanly2b
    $results["Case 2: Invalid or Unreachable Endpoints"] = @{
        Status = if ($passed2) { "PASS" } else { "FAIL" }
        UnreachableExitCode = $swarm_2a.ExitCode
        UnreachableDiagnosed = $diagnosed2a
        MalformedExitCode = $swarm_2b.ExitCode
    }
    Write-Host "  Result: $(if ($passed2) {'PASS'} else {'FAIL'}) (ExitCode2a=$($swarm_2a.ExitCode), Diagnosed=$diagnosed2a, ExitCode2b=$($swarm_2b.ExitCode))" -ForegroundColor $(if ($passed2) {'Green'} else {'Red'})
} finally {
    Stop-StartedProcess $swarm_2a; Stop-StartedProcess $swarm_2b; Stop-StartedProcess $rpc0_2
    Wait-Until { (Test-PortFree $HttpPort) -and (Test-PortFree $RpcPort0) } 10 "Ports not free after Case 2"
}

# -----------------------------------------------------------------------------
# CASE 3: Controlled Handling when One Worker Becomes Unavailable (Idle)
# -----------------------------------------------------------------------------
Write-Host "`n[Case 3] Controlled Handling when One Worker Becomes Unavailable..." -ForegroundColor Yellow
$pids3 = [System.Collections.Generic.List[int]]::new()
$rpc0_3 = $null; $rpc1_3 = $null; $swarm_3 = $null
try {
    $rpc0_3 = Start-RpcServer $RpcPort0 "case3" $pids3
    $rpc1_3 = Start-RpcServer $RpcPort1 "case3" $pids3

    $env:SWARM_USE_RPC = '1'
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:$RpcPort0, 127.0.0.1:$RpcPort1"
    $env:SWARM_PLACEMENT_POLICY = 'none'
    $sStdout3 = Join-Path $artifactRoot "case3-swarm.stdout.log"
    $sStderr3 = Join-Path $artifactRoot "case3-swarm.stderr.log"
    $swarm_3 = Start-Process -FilePath $swarmExe -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $sStdout3 -RedirectStandardError $sStderr3 -PassThru
    $pids3.Add([int]$swarm_3.Id)

    Wait-Until {
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing -TimeoutSec 2
            return $h.inference.ready
        } catch { return $false }
    } $ReadinessTimeoutSeconds "Case 3: Swarm not ready initially"

    Write-Host "  Stopping RPC1 (port $RpcPort1)..." -ForegroundColor Gray
    Stop-StartedProcess $rpc1_3
    $rpc1_3 = $null

    # Send inference request - expected to return controlled 503 instead of crashing!
    $reqBody = @{
        messages = @(@{ role = "user"; content = "What is 2 + 2?" })
        max_tokens = 16
        temperature = 0
    } | ConvertTo-Json -Depth 5 -Compress

    $caught503 = $false
    $statusCode = 0
    $respContent = ""
    try {
        $resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$HttpPort/v1/chat/completions" `
            -ContentType "application/json" -Body $reqBody -TimeoutSec 15
        $statusCode = $resp.StatusCode
        $respContent = $resp.Content
    } catch {
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
            $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
            $respContent = $reader.ReadToEnd()
        }
        if ($statusCode -eq 503) {
            $caught503 = $true
        }
    }

    $respContent | Set-Content (Join-Path $artifactRoot "case3-503-response.json")

    # Check that Swarm is still alive and serving /health
    $swarmStillAlive = -not $swarm_3.HasExited
    $hAfter = $null
    if ($swarmStillAlive) {
        $hAfter = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing
        $hAfter | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $artifactRoot "case3-health-after.json")
    }

    $passed3 = $caught503 -and ($statusCode -eq 503) -and $swarmStillAlive -and ($hAfter.inference.ready -eq $false)
    $results["Case 3: One Worker Unavailable Controlled 503"] = @{
        Status = if ($passed3) { "PASS" } else { "FAIL" }
        StatusCode = $statusCode
        Caught503 = $caught503
        SwarmRemainedAlive = $swarmStillAlive
        InferenceReadyAfter = $hAfter.inference.ready
        UnreadyReason = $hAfter.inference.unready_reason
    }
    Write-Host "  Result: $(if ($passed3) {'PASS'} else {'FAIL'}) (HTTP=$statusCode, SwarmAlive=$swarmStillAlive, UnreadyReason='$($hAfter.inference.unready_reason)')" -ForegroundColor $(if ($passed3) {'Green'} else {'Red'})

    # -------------------------------------------------------------------------
    # CASE 4: Controlled Recovery via Documented Clean Restart
    # -------------------------------------------------------------------------
    Write-Host "`n[Case 4] Controlled Recovery via Clean Restart..." -ForegroundColor Yellow
    Write-Host "  Stopping Swarm, restarting RPC1, restarting Swarm..." -ForegroundColor Gray
    Stop-StartedProcess $swarm_3
    $swarm_3 = $null
    Wait-Until { Test-PortFree $HttpPort } 10 "Port $HttpPort not released"

    $rpc1_4 = Start-RpcServer $RpcPort1 "case4" $pids3
    $sStdout4 = Join-Path $artifactRoot "case4-recovery-swarm.stdout.log"
    $sStderr4 = Join-Path $artifactRoot "case4-recovery-swarm.stderr.log"
    $swarm_4 = Start-Process -FilePath $swarmExe -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $sStdout4 -RedirectStandardError $sStderr4 -PassThru
    $pids3.Add([int]$swarm_4.Id)

    Wait-Until {
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing -TimeoutSec 2
            return $h.model.loaded -and $h.context.created -and $h.inference.ready
        } catch { return $false }
    } $ReadinessTimeoutSeconds "Case 4: Recovered Swarm did not become ready"

    $hRecovered = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing
    $respRec = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$HttpPort/v1/chat/completions" `
        -ContentType "application/json" -Body $reqBody -TimeoutSec 60
    $textRec = Get-StreamedContent $respRec.Content

    $passed4 = ($textRec -match '2\s*\+\s*2\s*(equals|is)\s*4') -and ($hRecovered.inference.ready -eq $true)
    $results["Case 4: Clean Restart Recovery"] = @{
        Status = if ($passed4) { "PASS" } else { "FAIL" }
        InferenceReady = $hRecovered.inference.ready
        ResponseText = $textRec
    }
    Write-Host "  Result: $(if ($passed4) {'PASS'} else {'FAIL'}) (InferenceReady=$($hRecovered.inference.ready), Text='$textRec')" -ForegroundColor $(if ($passed4) {'Green'} else {'Red'})

    Stop-StartedProcess $swarm_4
    Stop-StartedProcess $rpc1_4
} finally {
    Stop-StartedProcess $swarm_3; Stop-StartedProcess $rpc0_3; Stop-StartedProcess $rpc1_3
    Wait-Until { (Test-PortFree $HttpPort) -and (Test-PortFree $RpcPort0) -and (Test-PortFree $RpcPort1) } 10 "Ports not free after Case 3/4"
}

# -----------------------------------------------------------------------------
# CASE 5: Repeated Inference with Two Loopback RPC Workers
# -----------------------------------------------------------------------------
Write-Host "`n[Case 5] Repeated Inference with Two Loopback Workers (5 Trials)..." -ForegroundColor Yellow
$pids5 = [System.Collections.Generic.List[int]]::new()
$rpc0_5 = $null; $rpc1_5 = $null; $swarm_5 = $null
try {
    $rpc0_5 = Start-RpcServer $RpcPort0 "case5" $pids5
    $rpc1_5 = Start-RpcServer $RpcPort1 "case5" $pids5

    $env:SWARM_USE_RPC = '1'
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:$RpcPort0, 127.0.0.1:$RpcPort1"
    $env:SWARM_PLACEMENT_POLICY = 'resource_aware'
    $env:SWARM_WORKER_PROFILES = "RPC0=50MB,RPC1=500MB,CUDA0=4000MB"

    $sStdout5 = Join-Path $artifactRoot "case5-swarm.stdout.log"
    $sStderr5 = Join-Path $artifactRoot "case5-swarm.stderr.log"
    $swarm_5 = Start-Process -FilePath $swarmExe -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $sStdout5 -RedirectStandardError $sStderr5 -PassThru
    $pids5.Add([int]$swarm_5.Id)

    Wait-Until {
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing -TimeoutSec 2
            return $h.inference.ready
        } catch { return $false }
    } $ReadinessTimeoutSeconds "Case 5: Swarm not ready"

    $reqBody = @{
        messages = @(@{ role = "user"; content = "What is 2 + 2?" })
        max_tokens = 16
        temperature = 0
    } | ConvertTo-Json -Depth 5 -Compress

    $successCount = 0
    for ($i = 1; $i -le 5; $i++) {
        $resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$HttpPort/v1/chat/completions" `
            -ContentType "application/json" -Body $reqBody -TimeoutSec 60
        $t = Get-StreamedContent $resp.Content
        if ($t -match '2\s*\+\s*2\s*(equals|is)\s*4') {
            $successCount++
            Write-Host "    Trial $i/5: OK ('$t')" -ForegroundColor Gray
        } else {
            Write-Host "    Trial $i/5: FAILED ('$t')" -ForegroundColor Red
        }
    }

    $passed5 = ($successCount -eq 5)
    $results["Case 5: Repeated Inference (5/5)"] = @{
        Status = if ($passed5) { "PASS" } else { "FAIL" }
        SuccessCount = $successCount
        TotalTrials = 5
    }
    Write-Host "  Result: $(if ($passed5) {'PASS'} else {'FAIL'}) ($successCount/5 correct)" -ForegroundColor $(if ($passed5) {'Green'} else {'Red'})
} finally {
    Stop-StartedProcess $swarm_5; Stop-StartedProcess $rpc0_5; Stop-StartedProcess $rpc1_5
    Wait-Until { (Test-PortFree $HttpPort) -and (Test-PortFree $RpcPort0) -and (Test-PortFree $RpcPort1) } 10 "Ports not free after Case 5"
}

# -----------------------------------------------------------------------------
# CASE 6: Local CUDA Regression
# -----------------------------------------------------------------------------
Write-Host "`n[Case 6] Local CUDA Regression (SWARM_USE_RPC=0, 37 layers)..." -ForegroundColor Yellow
$pids6 = [System.Collections.Generic.List[int]]::new()
$swarm_6 = $null
try {
    $env:SWARM_USE_RPC = '0'
    $env:SWARM_RPC_ENDPOINTS = $null
    $env:SWARM_N_GPU_LAYERS = '-1'
    $env:SWARM_PLACEMENT_POLICY = 'none'
    $env:SWARM_WORKER_PROFILES = $null

    $sStdout6 = Join-Path $artifactRoot "case6-cuda.stdout.log"
    $sStderr6 = Join-Path $artifactRoot "case6-cuda.stderr.log"
    $swarm_6 = Start-Process -FilePath $swarmExe -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $sStdout6 -RedirectStandardError $sStderr6 -PassThru
    $pids6.Add([int]$swarm_6.Id)

    Wait-Until {
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing -TimeoutSec 2
            return $h.model.loaded -and $h.context.created -and $h.inference.ready
        } catch { return $false }
    } $ReadinessTimeoutSeconds "Case 6: Local CUDA Swarm not ready"

    $reqBody = @{
        messages = @(@{ role = "user"; content = "What is 2 + 2?" })
        max_tokens = 16
        temperature = 0
    } | ConvertTo-Json -Depth 5 -Compress

    $resp6 = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$HttpPort/v1/chat/completions" `
        -ContentType "application/json" -Body $reqBody -TimeoutSec 30
    $t6 = Get-StreamedContent $resp6.Content

    $passed6 = ($t6 -match '2\s*\+\s*2\s*(equals|is)\s*4')
    $results["Case 6: Local CUDA Fallback"] = @{
        Status = if ($passed6) { "PASS" } else { "FAIL" }
        ResponseText = $t6
    }
    Write-Host "  Result: $(if ($passed6) {'PASS'} else {'FAIL'}) (Text='$t6')" -ForegroundColor $(if ($passed6) {'Green'} else {'Red'})
} finally {
    Stop-StartedProcess $swarm_6
    Wait-Until { Test-PortFree $HttpPort } 10 "Port $HttpPort not free after Case 6"
}

# -----------------------------------------------------------------------------
# CASE 7: Graceful Shutdown and Port Cleanup
# -----------------------------------------------------------------------------
Write-Host "`n[Case 7] Graceful Shutdown and Port Cleanup..." -ForegroundColor Yellow
$pids7 = [System.Collections.Generic.List[int]]::new()
$rpc0_7 = $null; $swarm_7 = $null
try {
    $rpc0_7 = Start-RpcServer $RpcPort0 "case7" $pids7
    $env:SWARM_USE_RPC = '1'
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:$RpcPort0"
    $env:SWARM_N_GPU_LAYERS = '4'
    $env:SWARM_PLACEMENT_POLICY = 'none'

    $sStdout7 = Join-Path $artifactRoot "case7-shutdown.stdout.log"
    $sStderr7 = Join-Path $artifactRoot "case7-shutdown.stderr.log"
    $swarm_7 = Start-Process -FilePath $swarmExe -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $sStdout7 -RedirectStandardError $sStderr7 -PassThru
    $pids7.Add([int]$swarm_7.Id)

    Wait-Until {
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing -TimeoutSec 2
            return $h.inference.ready
        } catch { return $false }
    } $ReadinessTimeoutSeconds "Case 7: Swarm not ready"

    # Stop swarm
    Stop-StartedProcess $swarm_7
    $swarm_7.WaitForExit(5000) | Out-Null
    Stop-StartedProcess $rpc0_7

    $portsClean = (Test-PortFree $HttpPort) -and (Test-PortFree $RpcPort0)
    $passed7 = $portsClean
    $results["Case 7: Graceful Shutdown & Port Cleanup"] = @{
        Status = if ($passed7) { "PASS" } else { "FAIL" }
        HttpPortFree = (Test-PortFree $HttpPort)
        RpcPortFree = (Test-PortFree $RpcPort0)
    }
    Write-Host "  Result: $(if ($passed7) {'PASS'} else {'FAIL'}) (PortsClean=$portsClean)" -ForegroundColor $(if ($passed7) {'Green'} else {'Red'})
} finally {
    Stop-StartedProcess $swarm_7; Stop-StartedProcess $rpc0_7
    Wait-Until { (Test-PortFree $HttpPort) -and (Test-PortFree $RpcPort0) } 10 "Ports not free after Case 7"
}

# -----------------------------------------------------------------------------
# CASE 8: Zero-Layer Worker Fault Resilience & Active Required Enforcement
# -----------------------------------------------------------------------------
Write-Host "`n[Case 8] Zero-Layer Worker Fault Resilience & Required Backend Enforcement..." -ForegroundColor Yellow
$pids8 = [System.Collections.Generic.List[int]]::new()
$rpc0_8 = $null; $rpc1_8 = $null; $swarm_8 = $null
try {
    $rpc0_8 = Start-RpcServer $RpcPort0 "case8" $pids8
    $rpc1_8 = Start-RpcServer $RpcPort1 "case8" $pids8

    $env:SWARM_USE_RPC = '1'
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:$RpcPort0, 127.0.0.1:$RpcPort1"
    $env:SWARM_PLACEMENT_POLICY = 'resource_aware'
    $env:SWARM_WORKER_PROFILES = "127.0.0.1:$RpcPort0=50MB,127.0.0.1:$RpcPort1=500MB,local-cuda-0=4000MB"
    $env:SWARM_N_GPU_LAYERS = '4'

    $sStdout8 = Join-Path $artifactRoot "case8-zerolayer.stdout.log"
    $sStderr8 = Join-Path $artifactRoot "case8-zerolayer.stderr.log"
    $swarm_8 = Start-Process -FilePath $swarmExe -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $sStdout8 -RedirectStandardError $sStderr8 -PassThru
    $pids8.Add([int]$swarm_8.Id)

    Wait-Until {
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing -TimeoutSec 2
            return $h.model.loaded -and $h.context.created -and $h.inference.ready
        } catch { return $false }
    } $ReadinessTimeoutSeconds "Case 8: Swarm not ready initially"

    $hInit8 = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing
    $w0 = $hInit8.workers | Where-Object { $_.port -eq $RpcPort0 }
    $w1 = $hInit8.workers | Where-Object { $_.port -eq $RpcPort1 }

    # Stop zero-layer worker (RPC0)
    Stop-StartedProcess $rpc0_8
    $rpc0_8 = $null
    Start-Sleep -Milliseconds 500

    $hAfterZero = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing
    $zeroDownReady = ($hAfterZero.inference.ready -eq $true) -and ($hAfterZero.inference.ready_required_rpc_workers -eq 1)

    # Inference with zero-layer worker down MUST succeed
    $reqBody = @{
        messages = @(@{ role = "user"; content = "What is 2 + 2?" })
        max_tokens = 16
        temperature = 0
    } | ConvertTo-Json -Depth 5 -Compress

    $resp8a = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$HttpPort/v1/chat/completions" `
        -ContentType "application/json" -Body $reqBody -TimeoutSec 30
    $text8a = Get-StreamedContent $resp8a.Content
    $infZeroDownSuccess = ($resp8a.StatusCode -eq 200) -and ($text8a -match '2\s*\+\s*2\s*(equals|is)\s*4')

    # Now stop required worker (RPC1)
    Stop-StartedProcess $rpc1_8
    $rpc1_8 = $null
    Start-Sleep -Milliseconds 500

    $hAfterReq = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing
    $reqDownUnready = ($hAfterReq.inference.ready -eq $false)

    # Inference with required worker down MUST return 503
    $caught503_8 = $false
    try {
        $resp8b = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$HttpPort/v1/chat/completions" `
            -ContentType "application/json" -Body $reqBody -TimeoutSec 10
    } catch {
        if ($_.Exception.Response -and ([int]$_.Exception.Response.StatusCode -eq 503)) {
            $caught503_8 = $true
        }
    }

    $passed8 = ($w0.assigned_layers.Count -eq 0) -and ($w1.assigned_layers.Count -gt 0) -and `
               $zeroDownReady -and $infZeroDownSuccess -and $reqDownUnready -and $caught503_8
    $results["Case 8: Zero-Layer Resilience & Required Enforcement"] = @{
        Status = if ($passed8) { "PASS" } else { "FAIL" }
        Rpc0AssignedLayers = $w0.assigned_layers.Count
        Rpc1AssignedLayers = $w1.assigned_layers.Count
        ZeroWorkerLossInferenceSuccess = $infZeroDownSuccess
        RequiredWorkerLoss503 = $caught503_8
    }
    Write-Host "  Result: $(if ($passed8) {'PASS'} else {'FAIL'}) (ZeroLossSuccess=$infZeroDownSuccess, ReqLoss503=$caught503_8)" -ForegroundColor $(if ($passed8) {'Green'} else {'Red'})
} finally {
    Stop-StartedProcess $swarm_8; Stop-StartedProcess $rpc0_8; Stop-StartedProcess $rpc1_8
    Wait-Until { (Test-PortFree $HttpPort) -and (Test-PortFree $RpcPort0) -and (Test-PortFree $RpcPort1) } 10 "Ports not free after Case 8"
}

# Write summary record
$results | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $artifactRoot "MILESTONE_6_RESULTS.json")
Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host " MILESTONE 6 VALIDATION SUMMARY" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
$results.GetEnumerator() | ForEach-Object {
    Write-Host ("{0,-48}: {1}" -f $_.Key, $_.Value.Status) -ForegroundColor $(if ($_.Value.Status -eq 'PASS') {'Green'} else {'Red'})
}
