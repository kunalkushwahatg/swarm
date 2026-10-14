# Invoke-Milestone7Validation.ps1
# End-to-End Validation Suite for Swarm Milestone 7: Node Inventory and Resource Discovery.

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
$artifactRoot = Join-Path $ProjectRoot "artifacts\validation\2026-10-10\milestone-7"

if (-not (Test-Path $artifactRoot)) {
    New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
}

function Test-PortFree([int]$Port) {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
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

function Start-RpcServer([int]$Port, [string]$Prefix, [System.Collections.Generic.List[int]]$PidList) {
    $stdout = Join-Path $artifactRoot "$Prefix-rpc-$Port.stdout.log"
    $stderr = Join-Path $artifactRoot "$Prefix-rpc-$Port.stderr.log"
    $p = Start-Process -FilePath $rpcExe `
        -ArgumentList @("--host", "127.0.0.1", "--port", "$Port", "--threads", "2") `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $PidList.Add([int]$p.Id)
    Wait-Until { -not (Test-PortFree $Port) } 10 "RPC server failed to listen on port $Port"
    return $p
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

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host " SWARM MILESTONE 7: NODE INVENTORY & RESOURCE DISCOVERY SUITE   " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

$results = [ordered]@{}

# -----------------------------------------------------------------------------
# STEP 0: Deterministic Offline Unit Tests
# -----------------------------------------------------------------------------
Write-Host "`n[Step 0] Running Deterministic Offline Unit Tests..." -ForegroundColor Yellow
$testExe = Join-Path $ProjectRoot "test_node_inventory.exe"
if (-not (Test-Path $testExe)) {
    throw "test_node_inventory.exe not found! Please build it first."
}
$unitProc = Start-Process -FilePath $testExe -WorkingDirectory $ProjectRoot -PassThru -Wait
$unitPass = ($unitProc.ExitCode -eq 0)
$results["Step 0: Offline Unit Tests"] = @{
    Status = if ($unitPass) { "PASS" } else { "FAIL" }
    ExitCode = $unitProc.ExitCode
}
Write-Host "  Result: $(if ($unitPass) {'PASS'} else {'FAIL'}) (ExitCode=$($unitProc.ExitCode))" -ForegroundColor $(if ($unitPass) {'Green'} else {'Red'})
if (-not $unitPass) { throw "Unit tests failed!" }

# -----------------------------------------------------------------------------
# CASE 1: Live Node Inventory & Capabilities Discovery (/nodes)
# -----------------------------------------------------------------------------
Write-Host "`n[Case 1] Live Node Inventory Discovery (/nodes)..." -ForegroundColor Yellow
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
    $env:SWARM_HTTP_PORT = "$HttpPort"
    $env:SWARM_PLACEMENT_POLICY = 'none'
    $env:PATH = "$ProjectRoot\build-cuda\bin;$env:PATH"

    $sStdout1 = Join-Path $artifactRoot "case1-swarm.stdout.log"
    $sStderr1 = Join-Path $artifactRoot "case1-swarm.stderr.log"
    $swarm_1 = Start-Process -FilePath $swarmExe -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $sStdout1 -RedirectStandardError $sStderr1 -PassThru
    $pids1.Add([int]$swarm_1.Id)

    Wait-Until {
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing -TimeoutSec 2
            return $h.model.loaded -and $h.context.created -and $h.inference.ready
        } catch { return $false }
    } $ReadinessTimeoutSeconds "Case 1: Swarm did not report inference ready"

    $nodes = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/nodes" -UseBasicParsing
    $nodes | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $artifactRoot "case1-nodes.json")

    $summary = $nodes.cluster_summary
    $gwNode = $nodes.nodes | Where-Object { $_.node_role -eq "gateway" }
    $w0Node = $nodes.nodes | Where-Object { $_.endpoint -match "$RpcPort0" }
    $w1Node = $nodes.nodes | Where-Object { $_.endpoint -match "$RpcPort1" }

    $gwValid = ($null -ne $gwNode) -and ($gwNode.ram_total_bytes.provenance -eq "measured") -and `
               ($gwNode.vram_total_bytes.provenance -eq "measured")
    $workersValid = ($null -ne $w0Node) -and ($null -ne $w1Node) -and `
                    ($w0Node.ram_total_bytes.provenance -eq "measured")
    $summaryValid = ($summary.total_nodes -eq 3) -and ($summary.memory_accounting.host_ram_deduplicated -eq $true)

    # Perform inference request
    $reqBody = @{
        messages = @(@{ role = "user"; content = "What is 2 + 2?" })
        max_tokens = 16
        temperature = 0
    } | ConvertTo-Json -Depth 5 -Compress

    $resp1 = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$HttpPort/v1/chat/completions" `
        -ContentType "application/json" -Body $reqBody -TimeoutSec 30
    $text1 = Get-StreamedContent $resp1.Content
    $infPass = ($text1 -match '2\s*\+\s*2\s*(equals|is)\s*4')

    $passed1 = $gwValid -and $workersValid -and $summaryValid -and $infPass
    $results["Case 1: Live Node Inventory Discovery"] = @{
        Status = if ($passed1) { "PASS" } else { "FAIL" }
        TotalNodes = $summary.total_nodes
        HostRamDeduplicated = $summary.memory_accounting.host_ram_deduplicated
        GatewayRamProvenance = $gwNode.ram_total_bytes.provenance
        GatewayVramProvenance = $gwNode.vram_total_bytes.provenance
        InferenceText = $text1
    }
    Write-Host "  Result: $(if ($passed1) {'PASS'} else {'FAIL'}) (TotalNodes=$($summary.total_nodes), Text='$text1')" -ForegroundColor $(if ($passed1) {'Green'} else {'Red'})
} finally {
    Stop-StartedProcess $swarm_1; Stop-StartedProcess $rpc0_1; Stop-StartedProcess $rpc1_1
    Wait-Until { (Test-PortFree $HttpPort) -and (Test-PortFree $RpcPort0) -and (Test-PortFree $RpcPort1) } 10 "Ports not free after Case 1"
}

# -----------------------------------------------------------------------------
# CASE 2: Resource-Aware Inventory with Provenance & Budgets (Profile A)
# -----------------------------------------------------------------------------
Write-Host "`n[Case 2] Resource-Aware Inventory with Provenance (Profile A)..." -ForegroundColor Yellow
$pids2 = [System.Collections.Generic.List[int]]::new()
$rpc0_2 = $null; $rpc1_2 = $null; $swarm_2 = $null
try {
    $rpc0_2 = Start-RpcServer $RpcPort0 "case2" $pids2
    $rpc1_2 = Start-RpcServer $RpcPort1 "case2" $pids2

    $env:SWARM_USE_RPC = '1'
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:$RpcPort0, 127.0.0.1:$RpcPort1"
    $env:SWARM_PLACEMENT_POLICY = 'resource_aware'
    $env:SWARM_WORKER_PROFILES = "127.0.0.1:$RpcPort0=50MB,127.0.0.1:$RpcPort1=500MB,local-cuda-0=4000MB"
    $env:SWARM_N_GPU_LAYERS = '4'

    $sStdout2 = Join-Path $artifactRoot "case2-swarm.stdout.log"
    $sStderr2 = Join-Path $artifactRoot "case2-swarm.stderr.log"
    $swarm_2 = Start-Process -FilePath $swarmExe -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $sStdout2 -RedirectStandardError $sStderr2 -PassThru
    $pids2.Add([int]$swarm_2.Id)

    Wait-Until {
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing -TimeoutSec 2
            return $h.model.loaded -and $h.context.created -and $h.inference.ready
        } catch { return $false }
    } $ReadinessTimeoutSeconds "Case 2: Swarm did not report inference ready"

    $nodes2 = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/nodes" -UseBasicParsing
    $nodes2 | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $artifactRoot "case2-nodes-profile-a.json")

    $w0 = $nodes2.nodes | Where-Object { $_.endpoint -match "$RpcPort0" }
    $w1 = $nodes2.nodes | Where-Object { $_.endpoint -match "$RpcPort1" }

    # Verify budgets and assigned layer separation
    $w0BudgetOk = ($w0.placement_budget_bytes.provenance -eq "configured_budget") -and ($w0.placement_budget_bytes.value -eq 50000000)
    $w0ZeroLayers = ($w0.assigned_layers.Count -eq 0) -and ($w0.is_required_by_model -eq $false)

    $w1BudgetOk = ($w1.placement_budget_bytes.provenance -eq "configured_budget") -and ($w1.placement_budget_bytes.value -eq 500000000)
    $w1Assigned = ($w1.assigned_layers.Count -eq 2) -and ($w1.is_required_by_model -eq $true)

    $countsOk = ($nodes2.cluster_summary.required_nodes -eq 2) -and ($nodes2.cluster_summary.unrequired_nodes -eq 1)

    $passed2 = $w0BudgetOk -and $w0ZeroLayers -and $w1BudgetOk -and $w1Assigned -and $countsOk
    $results["Case 2: Resource-Aware Inventory with Provenance"] = @{
        Status = if ($passed2) { "PASS" } else { "FAIL" }
        Rpc0BudgetProvenance = $w0.placement_budget_bytes.provenance
        Rpc0IsRequired = $w0.is_required_by_model
        Rpc1AssignedLayers = $w1.assigned_layers.Count
        Rpc1IsRequired = $w1.is_required_by_model
        RequiredNodes = $nodes2.cluster_summary.required_nodes
        UnrequiredNodes = $nodes2.cluster_summary.unrequired_nodes
    }
    Write-Host "  Result: $(if ($passed2) {'PASS'} else {'FAIL'}) (Rpc0Required=$($w0.is_required_by_model), Rpc1Required=$($w1.is_required_by_model))" -ForegroundColor $(if ($passed2) {'Green'} else {'Red'})

    # -------------------------------------------------------------------------
    # CASE 3: Node Disconnect Visibility in Live /nodes
    # -------------------------------------------------------------------------
    Write-Host "`n[Case 3] Node Disconnect Visibility in Live /nodes..." -ForegroundColor Yellow
    Write-Host "  Stopping zero-layer worker RPC0 (port $RpcPort0)..." -ForegroundColor Gray
    Stop-StartedProcess $rpc0_2
    $rpc0_2 = $null
    Start-Sleep -Milliseconds 500

    $nodes3 = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/nodes" -UseBasicParsing
    $w0_down = $nodes3.nodes | Where-Object { $_.endpoint -match "$RpcPort0" }
    $w0StateDown = ($w0_down.connection_state -eq "UNAVAILABLE") -and ($w0_down.is_ready_for_inference -eq $false)

    # Inference must still succeed
    $resp3 = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$HttpPort/v1/chat/completions" `
        -ContentType "application/json" -Body $reqBody -TimeoutSec 30
    $text3 = Get-StreamedContent $resp3.Content
    $infPass3 = ($text3 -match '2\s*\+\s*2\s*(equals|is)\s*4')

    $passed3 = $w0StateDown -and $infPass3
    $results["Case 3: Node Disconnect Visibility in Live /nodes"] = @{
        Status = if ($passed3) { "PASS" } else { "FAIL" }
        Rpc0ConnectionState = $w0_down.connection_state
        Rpc0IsReady = $w0_down.is_ready_for_inference
        InferenceWithZeroWorkerDown = $infPass3
    }
    Write-Host "  Result: $(if ($passed3) {'PASS'} else {'FAIL'}) (Rpc0State='$($w0_down.connection_state)', InferenceSuccess=$infPass3)" -ForegroundColor $(if ($passed3) {'Green'} else {'Red'})

    # -------------------------------------------------------------------------
    # CASE 4: Prometheus Node Metrics (/metrics)
    # -------------------------------------------------------------------------
    Write-Host "`n[Case 4] Prometheus Node Metrics (/metrics)..." -ForegroundColor Yellow
    $metrics = (Invoke-WebRequest -Uri "http://127.0.0.1:$HttpPort/metrics" -UseBasicParsing).Content
    $hasTotal = ($metrics -match 'swarm_nodes_total\s+3')
    $hasOnline = ($metrics -match 'swarm_nodes_online')
    $hasRequired = ($metrics -match 'swarm_nodes_required\s+2')

    $passed4 = $hasTotal -and $hasOnline -and $hasRequired
    $results["Case 4: Prometheus Node Metrics"] = @{
        Status = if ($passed4) { "PASS" } else { "FAIL" }
        HasNodesTotal = $hasTotal
        HasNodesOnline = $hasOnline
        HasNodesRequired = $hasRequired
    }
    Write-Host "  Result: $(if ($passed4) {'PASS'} else {'FAIL'}) (Total=$hasTotal, Required=$hasRequired)" -ForegroundColor $(if ($passed4) {'Green'} else {'Red'})
} finally {
    Stop-StartedProcess $swarm_2; Stop-StartedProcess $rpc0_2; Stop-StartedProcess $rpc1_2
    Wait-Until { (Test-PortFree $HttpPort) -and (Test-PortFree $RpcPort0) -and (Test-PortFree $RpcPort1) } 10 "Ports not free after Case 2/3/4"
}

# -----------------------------------------------------------------------------
# CASE 5: Backward Compatibility with Existing Endpoints (/health, /workers, /backends)
# -----------------------------------------------------------------------------
Write-Host "`n[Case 5] Backward Compatibility with Existing Endpoints..." -ForegroundColor Yellow
$pids5 = [System.Collections.Generic.List[int]]::new()
$rpc0_5 = $null; $rpc1_5 = $null; $swarm_5 = $null
try {
    $rpc0_5 = Start-RpcServer $RpcPort0 "case5" $pids5
    $rpc1_5 = Start-RpcServer $RpcPort1 "case5" $pids5

    $env:SWARM_USE_RPC = '1'
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:$RpcPort0, 127.0.0.1:$RpcPort1"
    $env:SWARM_PLACEMENT_POLICY = 'none'

    $sStdout5 = Join-Path $artifactRoot "case5-swarm.stdout.log"
    $sStderr5 = Join-Path $artifactRoot "case5-swarm.stderr.log"
    $swarm_5 = Start-Process -FilePath $swarmExe -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $sStdout5 -RedirectStandardError $sStderr5 -PassThru
    $pids5.Add([int]$swarm_5.Id)

    Wait-Until {
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing -TimeoutSec 2
            return $h.model.loaded -and $h.context.created -and $h.inference.ready
        } catch { return $false }
    } $ReadinessTimeoutSeconds "Case 5: Swarm not ready initially"

    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing
    $workers = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/workers" -UseBasicParsing
    $backends = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/backends" -UseBasicParsing

    $healthOk = ($health.status -eq "ok") -and ($health.model.loaded -eq $true) -and ($health.inference.ready -eq $true)
    $workersOk = ($workers.Count -eq 3) -and ($null -ne $workers[0].assigned_layers)
    $backendsOk = ($backends.backends.Count -ge 3) -and ($null -ne $backends.memory_accounting)

    $passed5 = $healthOk -and $workersOk -and $backendsOk
    $results["Case 5: Backward Compatibility with Existing Endpoints"] = @{
        Status = if ($passed5) { "PASS" } else { "FAIL" }
        HealthStatusOk = $healthOk
        WorkersCount = $workers.Count
        BackendsCount = $backends.backends.Count
    }
    Write-Host "  Result: $(if ($passed5) {'PASS'} else {'FAIL'}) (HealthOk=$healthOk, Workers=$($workers.Count), Backends=$($backends.backends.Count))" -ForegroundColor $(if ($passed5) {'Green'} else {'Red'})
} finally {
    Stop-StartedProcess $swarm_5; Stop-StartedProcess $rpc0_5; Stop-StartedProcess $rpc1_5
    Wait-Until { (Test-PortFree $HttpPort) -and (Test-PortFree $RpcPort0) -and (Test-PortFree $RpcPort1) } 10 "Ports not free after Case 5"
}

# -----------------------------------------------------------------------------
# CASE 6: Local CUDA Regression (SWARM_USE_RPC=0, 37 layers)
# -----------------------------------------------------------------------------
Write-Host "`n[Case 6] Local CUDA Regression (SWARM_USE_RPC=0, 37 layers)..." -ForegroundColor Yellow
$pids6 = [System.Collections.Generic.List[int]]::new()
$swarm_6 = $null
try {
    $env:SWARM_USE_RPC = '0'
    $env:SWARM_RPC_ENDPOINTS = ''
    $env:SWARM_N_GPU_LAYERS = '37'
    $env:SWARM_PLACEMENT_POLICY = 'none'

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
    } $ReadinessTimeoutSeconds "Case 6: CUDA fallback not ready"

    $nodes6 = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/nodes" -UseBasicParsing
    $gw6 = $nodes6.nodes | Where-Object { $_.node_role -eq "gateway" }
    $gwHasAllLayers = ($gw6.assigned_layers.Count -eq 37)

    $resp6 = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$HttpPort/v1/chat/completions" `
        -ContentType "application/json" -Body $reqBody -TimeoutSec 15
    $text6 = Get-StreamedContent $resp6.Content
    $passed6 = ($text6 -match '2\s*\+\s*2\s*(equals|is)\s*4') -and $gwHasAllLayers

    $results["Case 6: Local CUDA Fallback Regression"] = @{
        Status = if ($passed6) { "PASS" } else { "FAIL" }
        GatewayLayersAssigned = $gw6.assigned_layers.Count
        InferenceText = $text6
    }
    Write-Host "  Result: $(if ($passed6) {'PASS'} else {'FAIL'}) (Layers=$($gw6.assigned_layers.Count), Text='$text6')" -ForegroundColor $(if ($passed6) {'Green'} else {'Red'})
} finally {
    Stop-StartedProcess $swarm_6
    Wait-Until { Test-PortFree $HttpPort } 10 "Port $HttpPort not free after Case 6"
}

# -----------------------------------------------------------------------------
# CASE 7: Graceful Teardown and Port Verification
# -----------------------------------------------------------------------------
Write-Host "`n[Case 7] Graceful Teardown and Port Verification..." -ForegroundColor Yellow
$portsFree = (Test-PortFree $HttpPort) -and (Test-PortFree $RpcPort0) -and (Test-PortFree $RpcPort1)
$results["Case 7: Graceful Teardown & Port Verification"] = @{
    Status = if ($portsFree) { "PASS" } else { "FAIL" }
    HttpPortFree = (Test-PortFree $HttpPort)
    RpcPort0Free = (Test-PortFree $RpcPort0)
    RpcPort1Free = (Test-PortFree $RpcPort1)
}
Write-Host "  Result: $(if ($portsFree) {'PASS'} else {'FAIL'}) (PortsFree=$portsFree)" -ForegroundColor $(if ($portsFree) {'Green'} else {'Red'})

# Summary serialization
$results | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $artifactRoot "MILESTONE_7_RESULTS.json")
Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host " MILESTONE 7 VALIDATION SUMMARY" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
$results.GetEnumerator() | ForEach-Object {
    Write-Host ("{0,-50}: {1}" -f $_.Key, $_.Value.Status) -ForegroundColor $(if ($_.Value.Status -eq 'PASS') {'Green'} else {'Red'})
}
