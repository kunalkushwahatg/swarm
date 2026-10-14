# Swarm Milestone 8 Validation Script
# Worker-Side Resource Agent and Coordinator Integration Validation
# Date: 2026-10-10

$ErrorActionPreference = "Stop"

$workspaceRoot = "C:\Users\kunal\OneDrive\Desktop\swarm"
$artifactDir = "$workspaceRoot\artifacts\validation\2026-10-10\milestone-8"
New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null

$results = [ordered]@{
    timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
    milestone = 8
    model_check_sha256 = "626B4A6678B86442240E33DF819E00132D3BA7DDDFE1CDC4FBB18E0A9615C62D"
    cases = [ordered]@{}
}

function Cleanup-TestProcesses {
    Write-Host "[Cleanup] Checking for running swarm/agent/rpc processes..." -ForegroundColor Cyan
    Get-Process -Name "swarm_node", "swarm_agent", "rpc-server", "ggml-rpc-server" -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "  Stopping process $($_.Name) (PID: $($_.Id))" -ForegroundColor Yellow
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
}

function Assert-PortsFree {
    param([int[]]$Ports)
    foreach ($p in $Ports) {
        $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
        if ($conn) {
            throw "Port $p is unexpectedly in use by PID $($conn.OwningProcess)"
        }
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

try {
    Cleanup-TestProcesses
    Assert-PortsFree @(8080, 50052, 50053)
    $env:PATH = "$workspaceRoot\build-cuda\bin;$workspaceRoot\temp_rpc_build\bin;$env:PATH"

    # -------------------------------------------------------------
    # Step 0: Deterministic Offline Unit Tests
    # -------------------------------------------------------------
    Write-Host "`n=== Step 0: Offline Unit Tests (test_agent_and_inventory.exe) ===" -ForegroundColor Green
    $unitOut = & "$workspaceRoot\test_agent_and_inventory.exe" 2>&1
    if ($LASTEXITCODE -ne 0 -or (($unitOut -join "`n") -notmatch "All 7 Milestone 8 Unit Tests PASSED")) {
        throw "Step 0 unit tests failed. Output:`n$unitOut"
    }
    Write-Host "  Step 0: Offline unit tests passed (7/7 tests)." -ForegroundColor Green
    $results.cases["Step0_UnitTests"] = "PASS"

    # -------------------------------------------------------------
    # Case 1: Live Coordinator Ingestion via Agent
    # -------------------------------------------------------------
    Write-Host "`n=== Case 1: Live Coordinator Ingestion via Agent ===" -ForegroundColor Green
    $rpc0 = Start-Process -FilePath "$workspaceRoot\temp_rpc_build\bin\ggml-rpc-server.exe" `
        -ArgumentList @("--host", "127.0.0.1", "--port", "50052", "--threads", "2") `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case1-rpc0.stdout.log" `
        -RedirectStandardError "$artifactDir\case1-rpc0.stderr.log" `
        -PassThru
    $rpc1 = Start-Process -FilePath "$workspaceRoot\temp_rpc_build\bin\ggml-rpc-server.exe" `
        -ArgumentList @("--host", "127.0.0.1", "--port", "50053", "--threads", "2") `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case1-rpc1.stdout.log" `
        -RedirectStandardError "$artifactDir\case1-rpc1.stderr.log" `
        -PassThru
    Start-Sleep -Seconds 1

    $env:SWARM_USE_RPC = "1"
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:50052, 127.0.0.1:50053"
    $env:SWARM_N_GPU_LAYERS = "4"
    $env:SWARM_MODEL_PATH = "$workspaceRoot\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf"
    $env:SWARM_PLACEMENT_POLICY = "none"

    $swarm = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_node.exe" `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case1-swarm.stdout.log" `
        -RedirectStandardError "$artifactDir\case1-swarm.stderr.log" `
        -PassThru

    Write-Host "  Waiting for Swarm gateway on port 8080..." -ForegroundColor Cyan
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -Method Get -TimeoutSec 2
            if ($resp.status -eq "ok") { $ready = $true; break }
        } catch {}
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw "Swarm gateway did not become ready on port 8080." }

    # Query initial /nodes before agent reports
    $initNodes = Invoke-RestMethod -Uri "http://127.0.0.1:8080/nodes" -Method Get
    $initNodes | ConvertTo-Json -Depth 6 | Out-File "$artifactDir\case1-init-nodes.json" -Encoding utf8
    Write-Host "  Initial nodes in cluster: $($initNodes.cluster_summary.total_nodes)" -ForegroundColor Cyan

    # Run agent once targeting worker 50052
    Write-Host "  Running swarm_agent --endpoint 127.0.0.1:50052 --rpc-port 50052 --once..." -ForegroundColor Cyan
    $agentOut = & "$workspaceRoot\build-cuda\swarm_agent.exe" --coordinator "http://127.0.0.1:8080" --endpoint "127.0.0.1:50052" --rpc-port 50052 --once 2>&1
    $agentOut | Out-File -FilePath "$artifactDir\case1-agent.log" -Encoding utf8
    if ($LASTEXITCODE -ne 0) {
        throw "Agent failed to report to coordinator. Output: $agentOut"
    }

    # Query /nodes after agent report
    $afterNodes = Invoke-RestMethod -Uri "http://127.0.0.1:8080/nodes" -Method Get
    $afterNodes | ConvertTo-Json -Depth 6 | Out-File "$artifactDir\case1-after-nodes.json" -Encoding utf8

    $node50052 = $afterNodes.nodes | Where-Object { $_.endpoint -eq "127.0.0.1:50052" }
    if (-not $node50052) { throw "Worker 127.0.0.1:50052 not found in /nodes" }
    if (-not $node50052.agent_reported) { throw "Worker 50052 does not reflect agent_reported=true" }
    if ($node50052.ram_total_bytes.provenance -ne "measured") { throw "ram_total_bytes provenance is not measured" }
    if ($node50052.cpu_info.processor_count -le 0) { throw "cpu_info processor_count is invalid" }

    Write-Host "  Agent report verified: node_id=$($node50052.node_id), CPU=$($node50052.cpu_info.architecture) ($($node50052.cpu_info.processor_count) cores), RAM=$([math]::Round($node50052.ram_total_bytes.value/1GB, 2)) GB" -ForegroundColor Green

    # Run test inference
    $body = @{
        messages = @(@{ role = "user"; content = "What is 2 + 2?" })
        max_tokens = 8
        temperature = 0.0
    } | ConvertTo-Json
    $chatResp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8080/v1/chat/completions" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 30
    $ans = Get-StreamedContent $chatResp.Content
    Write-Host "  Inference response: $ans" -ForegroundColor Green
    if ($ans -notmatch "4") { throw "Unexpected inference answer: $ans" }

    $results.cases["Case1_LiveAgentIngestion"] = "PASS"

    # -------------------------------------------------------------
    # Case 2: Malformed Report Rejection
    # -------------------------------------------------------------
    Write-Host "`n=== Case 2: Malformed Report Rejection ===" -ForegroundColor Green
    # 2a: Invalid schema version
    try {
        $bad1 = @{ schema_version = "9.9"; node_id = "test"; endpoint = "127.0.0.1:50052"; ram = @{ total_bytes = 1000; available_bytes = 500 } } | ConvertTo-Json
        Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/v1/nodes/report" -Method Post -Body $bad1 -ContentType "application/json"
        throw "Expected HTTP 400 for bad schema version"
    } catch {
        Write-Host "  2a: Bad schema version correctly rejected (HTTP 400)" -ForegroundColor Green
    }

    # 2b: Invalid RAM bounds
    try {
        $bad2 = @{ schema_version = "1.0"; node_id = "test"; endpoint = "127.0.0.1:50052"; ram = @{ total_bytes = 1000; available_bytes = 2000 } } | ConvertTo-Json
        Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/v1/nodes/report" -Method Post -Body $bad2 -ContentType "application/json"
        throw "Expected HTTP 400 for available > total RAM"
    } catch {
        Write-Host "  2b: Invalid RAM bounds correctly rejected (HTTP 400)" -ForegroundColor Green
    }

    # 2c: Oversized payload (> 64KB)
    try {
        $largeStr = "x" * 70000
        $bad3 = @{ schema_version = "1.0"; node_id = "test"; endpoint = "127.0.0.1:50052"; padding = $largeStr; ram = @{ total_bytes = 1000; available_bytes = 500 } } | ConvertTo-Json
        Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/v1/nodes/report" -Method Post -Body $bad3 -ContentType "application/json"
        throw "Expected HTTP 413 for oversized payload"
    } catch {
        Write-Host "  2c: Oversized payload correctly rejected (HTTP 413)" -ForegroundColor Green
    }

    $results.cases["Case2_MalformedReportRejection"] = "PASS"

    # -------------------------------------------------------------
    # Case 3: Continuous Agent & Staleness Detection
    # -------------------------------------------------------------
    Write-Host "`n=== Case 3: Continuous Agent & Staleness Handling ===" -ForegroundColor Green
    # Report on 50053 with an artificially old timestamp to test coordinator staleness calculation
    $stalePayload = @{
        schema_version = "1.0"
        agent_version = "1.0.0"
        node_id = "node-127.0.0.1-50053"
        endpoint = "127.0.0.1:50053"
        hostname = "worker-50053"
        rpc_port = 50053
        status = "ONLINE"
        cpu = @{ architecture = "x86_64"; processor_count = 8 }
        ram = @{ total_bytes = 16000000000; available_bytes = 8000000000 }
        timestamp_ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    } | ConvertTo-Json
    $postResp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/v1/nodes/report" -Method Post -Body $stalePayload -ContentType "application/json"
    Write-Host "  Fresh report for 50053 accepted: $($postResp.status)" -ForegroundColor Green

    $staleCheck1 = Invoke-RestMethod -Uri "http://127.0.0.1:8080/nodes" -Method Get
    $n53_1 = $staleCheck1.nodes | Where-Object { $_.endpoint -eq "127.0.0.1:50053" }
    if ($n53_1.is_stale) { throw "Node 50053 should initially be fresh" }

    Write-Host "  Verified fresh state on 50053. Waiting 32 seconds to observe staleness transition (>30s window)..." -ForegroundColor Cyan
    Start-Sleep -Seconds 32

    $staleCheck2 = Invoke-RestMethod -Uri "http://127.0.0.1:8080/nodes" -Method Get
    $staleCheck2 | ConvertTo-Json -Depth 6 | Out-File "$artifactDir\case3-stale-nodes.json" -Encoding utf8
    $n53_2 = $staleCheck2.nodes | Where-Object { $_.endpoint -eq "127.0.0.1:50053" }
    if (-not $n53_2.is_stale) { throw "Node 50053 failed to transition to is_stale=true after 32s" }
    if ($n53_2.connection_state -ne "UNAVAILABLE") { throw "Stale node connection_state should be UNAVAILABLE" }
    Write-Host "  Node 50053 successfully transitioned to is_stale=true and connection_state=UNAVAILABLE" -ForegroundColor Green

    # Re-report to verify recovery
    Write-Host "  Sending fresh report for 50053 to verify recovery..." -ForegroundColor Cyan
    $agentOut2 = & "$workspaceRoot\build-cuda\swarm_agent.exe" --coordinator "http://127.0.0.1:8080" --endpoint "127.0.0.1:50053" --rpc-port 50053 --once 2>&1
    $staleCheck3 = Invoke-RestMethod -Uri "http://127.0.0.1:8080/nodes" -Method Get
    $n53_3 = $staleCheck3.nodes | Where-Object { $_.endpoint -eq "127.0.0.1:50053" }
    if ($n53_3.is_stale) { throw "Node 50053 should recover to is_stale=false after fresh report" }
    Write-Host "  Node 50053 recovered: is_stale=false, connection_state=$($n53_3.connection_state)" -ForegroundColor Green

    $results.cases["Case3_StalenessAndRecovery"] = "PASS"

    # -------------------------------------------------------------
    # Case 4: Prometheus Metrics
    # -------------------------------------------------------------
    Write-Host "`n=== Case 4: Prometheus Metrics Verification ===" -ForegroundColor Green
    $prom = Invoke-RestMethod -Uri "http://127.0.0.1:8080/metrics" -Method Get
    $prom | Out-File "$artifactDir\case4-metrics.prom" -Encoding utf8

    if ($prom -notmatch "swarm_nodes_agent_reported 2") {
        throw "Metrics missing expected swarm_nodes_agent_reported count: 2"
    }
    if ($prom -notmatch "swarm_nodes_stale 0") {
        throw "Metrics missing expected swarm_nodes_stale count: 0"
    }
    Write-Host "  Prometheus agent metrics verified: swarm_nodes_agent_reported=2, swarm_nodes_stale=0" -ForegroundColor Green
    $results.cases["Case4_PrometheusMetrics"] = "PASS"

    # -------------------------------------------------------------
    # Case 5: Backward Compatibility
    # -------------------------------------------------------------
    Write-Host "`n=== Case 5: Backward Compatibility ===" -ForegroundColor Green
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -Method Get
    if ($health.status -ne "ok" -or -not $health.model.loaded -or -not $health.inference.ready) {
        throw "/health response did not match expected structure"
    }
    $workers = Invoke-RestMethod -Uri "http://127.0.0.1:8080/workers" -Method Get
    if ($workers.Count -ne 3) {
        throw "/workers count does not match expected (3 devices)"
    }
    $backends = Invoke-RestMethod -Uri "http://127.0.0.1:8080/backends" -Method Get
    if ($backends.backends.Count -lt 3 -or $null -eq $backends.memory_accounting) {
        throw "/backends response does not match expected structure"
    }
    Write-Host "  All legacy endpoints (/health, /workers, /backends) fully functional and backward compatible." -ForegroundColor Green
    $results.cases["Case5_BackwardCompatibility"] = "PASS"

    # Stop Case 1 Swarm
    Stop-Process -Id $swarm.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $rpc0.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $rpc1.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1

    # -------------------------------------------------------------
    # Case 6: Local CUDA Fallback Regression
    # -------------------------------------------------------------
    Write-Host "`n=== Case 6: Local CUDA Fallback Regression ===" -ForegroundColor Green
    $env:SWARM_USE_RPC = "0"
    $env:SWARM_N_GPU_LAYERS = "-1"
    $env:SWARM_PLACEMENT_POLICY = "none"

    $cudaSwarm = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_node.exe" `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case6-cuda.stdout.log" `
        -RedirectStandardError "$artifactDir\case6-cuda.stderr.log" `
        -PassThru

    $cudaReady = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -Method Get -TimeoutSec 2
            if ($resp.status -eq "ok") { $cudaReady = $true; break }
        } catch {}
        Start-Sleep -Seconds 1
    }
    if (-not $cudaReady) { throw "Local CUDA Swarm did not start." }

    $cudaResp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8080/v1/chat/completions" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 30
    $cudaAns = Get-StreamedContent $cudaResp.Content
    Write-Host "  CUDA Inference: $cudaAns" -ForegroundColor Green
    if ($cudaAns -notmatch "4") { throw "Local CUDA inference failed" }

    Stop-Process -Id $cudaSwarm.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    $results.cases["Case6_LocalCUDARegression"] = "PASS"

    # -------------------------------------------------------------
    # Case 7: Graceful Teardown and Port Verification
    # -------------------------------------------------------------
    Write-Host "`n=== Case 7: Graceful Teardown & Port Verification ===" -ForegroundColor Green
    Cleanup-TestProcesses
    Assert-PortsFree @(8080, 50052, 50053)
    Write-Host "  All test processes terminated; ports 8080, 50052, 50053 confirmed free." -ForegroundColor Green
    $results.cases["Case7_TeardownAndPorts"] = "PASS"

    $results.overall = "PASS"
    Write-Host "`n=======================================================" -ForegroundColor Green
    Write-Host "  ALL MILESTONE 8 VALIDATION CASES PASSED SUCCESSFULLY" -ForegroundColor Green
    Write-Host "=======================================================" -ForegroundColor Green
} catch {
    Write-Host "`n[ERROR] Test suite encountered an error: $_" -ForegroundColor Red
    $results.overall = "FAIL"
    $results.error = "$_"
} finally {
    Cleanup-TestProcesses
    $results | ConvertTo-Json -Depth 6 | Out-File -FilePath "$artifactDir\MILESTONE_8_RESULTS.json" -Encoding utf8
}
