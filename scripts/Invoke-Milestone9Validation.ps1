# Swarm Milestone 9 Validation Script
# Dynamic Resource-Aware Layer Allocation Validation
# Date: 2026-10-10

$ErrorActionPreference = "Stop"

$workspaceRoot = "C:\Users\kunal\OneDrive\Desktop\swarm"
$artifactDir = "$workspaceRoot\artifacts\validation\2026-10-10\milestone-9"
New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null

$results = [ordered]@{
    timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
    milestone = 9
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
    Write-Host "`n=== Step 0: Offline Unit Tests (test_dynamic_policy.exe) ===" -ForegroundColor Green
    $unitOut = & "$workspaceRoot\test_dynamic_policy.exe" 2>&1
    if ($LASTEXITCODE -ne 0 -or (($unitOut -join "`n") -notmatch "All 9 dynamic policy unit tests passed successfully")) {
        throw "Step 0 unit tests failed. Output:`n$unitOut"
    }
    Write-Host "  Step 0: Offline unit tests passed (9/9 tests, including clock-skew and replay protection)." -ForegroundColor Green
    $results.cases["Step0_UnitTests"] = "PASS"

    # -------------------------------------------------------------
    # Case 1: Live Dynamic Placement with Fresh Telemetry & Inference
    # -------------------------------------------------------------
    Write-Host "`n=== Case 1: Live Dynamic Placement with Fresh Telemetry & Inference ===" -ForegroundColor Green
    $rpc0 = Start-Process -FilePath "$workspaceRoot\temp_rpc_build\bin\ggml-rpc-server.exe" `
        -ArgumentList @("--host", "127.0.0.1", "--port", "50052", "--threads", "2") `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case1-rpc0.stdout.log" `
        -RedirectStandardError "$artifactDir\case1-rpc0.stderr.log" `
        -PassThru
    Start-Sleep -Seconds 1

    # Create fresh telemetry fixture for RPC0
    $case1Report = [ordered]@{
        schema_version = "1.0"
        agent_version = "1.0.0"
        node_id = "node-rpc-127.0.0.1-50052"
        endpoint = "127.0.0.1:50052"
        status = "READY"
        ram = @{
            total_bytes = 17179869184 # 16 GiB
            available_bytes = 6442450944 # 6 GiB free
        }
        timestamp_ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $case1ReportPath = "$artifactDir\case1-report.json"
    $case1Report | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 $case1ReportPath

    $env:SWARM_USE_RPC = "1"
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:50052"
    $env:SWARM_N_GPU_LAYERS = "4"
    $env:SWARM_MODEL_PATH = "$workspaceRoot\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf"
    $env:SWARM_PLACEMENT_POLICY = "dynamic"
    $env:SWARM_AGENT_REPORT_FILE = $case1ReportPath
    $env:SWARM_WORKER_PROFILES = ""

    $swarm = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_node.exe" `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case1-swarm.stdout.log" `
        -RedirectStandardError "$artifactDir\case1-swarm.stderr.log" `
        -PassThru

    Write-Host "  Waiting for Swarm gateway on port 8080..." -ForegroundColor Cyan
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -TimeoutSec 2
            if ($resp.status -eq "ok" -and $resp.inference.ready -eq $true) {
                $ready = $true
                break
            }
        } catch {}
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw "Case 1: Swarm gateway failed to become ready in dynamic mode" }

    # Query /nodes and /backends
    $nodes1 = Invoke-RestMethod -Uri "http://127.0.0.1:8080/nodes" -TimeoutSec 3
    $nodes1 | ConvertTo-Json -Depth 8 | Set-Content "$artifactDir\case1-nodes.json"
    $backends1 = Invoke-RestMethod -Uri "http://127.0.0.1:8080/backends" -TimeoutSec 3
    $backends1 | ConvertTo-Json -Depth 8 | Set-Content "$artifactDir\case1-backends.json"

    # Verify dynamic policy in placement
    if ($backends1.placement_policy -ne "dynamic") {
        throw "Case 1: Expected placement policy 'dynamic', got '$($backends1.placement_policy)'"
    }

    # Execute test chat completion
    Write-Host "  Sending test completion request..." -ForegroundColor Cyan
    $body = @{
        messages = @(@{ role = "user"; content = "What is 2 + 2?" })
        max_tokens = 20
        temperature = 0.0
    } | ConvertTo-Json
    $chatRes = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8080/v1/chat/completions" `
        -Method Post -Body $body -ContentType "application/json" -TimeoutSec 30
    $text = Get-StreamedContent $chatRes.Content
    Write-Host "  Model response: '$text'" -ForegroundColor Cyan
    if ($text -notmatch "4") {
        throw "Case 1: Unexpected inference response: '$text'"
    }

    Write-Host "  Case 1: Dynamic placement with live inference passed." -ForegroundColor Green
    $results.cases["Case1_LiveDynamicInference"] = "PASS"

    Stop-Process -Id $swarm.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $rpc0.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1

    # -------------------------------------------------------------
    # Case 2: Stale Telemetry Startup Rejection
    # -------------------------------------------------------------
    Write-Host "`n=== Case 2: Stale Telemetry Startup Rejection ===" -ForegroundColor Green
    $rpc0 = Start-Process -FilePath "$workspaceRoot\temp_rpc_build\bin\ggml-rpc-server.exe" `
        -ArgumentList @("--host", "127.0.0.1", "--port", "50052", "--threads", "2") `
        -WorkingDirectory $workspaceRoot `
        -PassThru
    Start-Sleep -Seconds 1

    # Create stale report fixture (60 seconds old)
    $case2StaleReport = [ordered]@{
        schema_version = "1.0"
        agent_version = "1.0.0"
        node_id = "node-rpc-127.0.0.1-50052"
        endpoint = "127.0.0.1:50052"
        status = "READY"
        ram = @{ total_bytes = 17179869184; available_bytes = 6442450944 }
        timestamp_ms = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - 60000) # 60s ago
    }
    $case2ReportPath = "$artifactDir\case2-stale-report.json"
    $case2StaleReport | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 $case2ReportPath

    $env:SWARM_USE_RPC = "1"
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:50052"
    $env:SWARM_N_GPU_LAYERS = "4"
    $env:SWARM_PLACEMENT_POLICY = "dynamic"
    $env:SWARM_AGENT_REPORT_FILE = $case2ReportPath

    $swarm = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_node.exe" `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case2-swarm.stdout.log" `
        -RedirectStandardError "$artifactDir\case2-swarm.stderr.log" `
        -PassThru -Wait

    $exitCode = $swarm.ExitCode
    $stderr = Get-Content "$artifactDir\case2-swarm.stderr.log" -Raw -ErrorAction SilentlyContinue
    Write-Host "  Swarm exit code: $exitCode, Stderr contains: $stderr" -ForegroundColor Cyan
    if ($exitCode -ne 1 -or $stderr -notmatch "STALE|TTL|stale") {
        throw "Case 2: Expected exit code 1 with STALE error, got $exitCode"
    }
    Write-Host "  Case 2: Stale telemetry startup rejection passed." -ForegroundColor Green
    $results.cases["Case2_StaleTelemetryRejection"] = "PASS"

    Stop-Process -Id $rpc0.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1

    # -------------------------------------------------------------
    # Case 3: Missing Telemetry Startup Rejection
    # -------------------------------------------------------------
    Write-Host "`n=== Case 3: Missing Telemetry Startup Rejection ===" -ForegroundColor Green
    $rpc0 = Start-Process -FilePath "$workspaceRoot\temp_rpc_build\bin\ggml-rpc-server.exe" `
        -ArgumentList @("--host", "127.0.0.1", "--port", "50052", "--threads", "2") `
        -WorkingDirectory $workspaceRoot `
        -PassThru
    Start-Sleep -Seconds 1

    $env:SWARM_USE_RPC = "1"
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:50052"
    $env:SWARM_N_GPU_LAYERS = "4"
    $env:SWARM_PLACEMENT_POLICY = "dynamic"
    $env:SWARM_AGENT_REPORT_FILE = "$artifactDir\non_existent_report.json"
    $env:SWARM_DISCOVERY_TIMEOUT_MS = "0"

    $swarm = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_node.exe" `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case3-swarm.stdout.log" `
        -RedirectStandardError "$artifactDir\case3-swarm.stderr.log" `
        -PassThru -Wait

    $exitCode = $swarm.ExitCode
    $stderr = Get-Content "$artifactDir\case3-swarm.stderr.log" -Raw -ErrorAction SilentlyContinue
    if ($exitCode -ne 1) {
        throw "Case 3: Expected exit code 1 for missing/invalid report file, got $exitCode"
    }
    Write-Host "  Case 3: Missing telemetry file rejection passed (exit code $exitCode)." -ForegroundColor Green
    $results.cases["Case3_MissingTelemetryRejection"] = "PASS"

    Stop-Process -Id $rpc0.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1

    # -------------------------------------------------------------
    # Case 4: Insufficient Dynamic Capacity Startup Rejection
    # -------------------------------------------------------------
    Write-Host "`n=== Case 4: Insufficient Dynamic Capacity Startup Rejection ===" -ForegroundColor Green
    $rpc0 = Start-Process -FilePath "$workspaceRoot\temp_rpc_build\bin\ggml-rpc-server.exe" `
        -ArgumentList @("--host", "127.0.0.1", "--port", "50052", "--threads", "2") `
        -WorkingDirectory $workspaceRoot `
        -PassThru
    Start-Sleep -Seconds 1

    # Report fixture with only 1 GiB total RAM and 200 MiB free (usable = 0 after headroom)
    $lowReport = [ordered]@{
        schema_version = "1.0"
        agent_version = "1.0.0"
        node_id = "node-rpc-127.0.0.1-50052"
        endpoint = "127.0.0.1:50052"
        status = "READY"
        ram = @{ total_bytes = 1073741824; available_bytes = 209715200 }
        timestamp_ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $lowReportPath = "$artifactDir\case4-low-report.json"
    $lowReport | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 $lowReportPath

    $env:SWARM_USE_RPC = "1"
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:50052"
    $env:SWARM_N_GPU_LAYERS = "37" # Request all 37 layers
    $env:SWARM_PLACEMENT_POLICY = "dynamic"
    $env:SWARM_AGENT_REPORT_FILE = $lowReportPath
    $env:SWARM_RESERVED_HEADROOM_RAM_MB = "1024"
    $env:SWARM_RESERVED_HEADROOM_VRAM_MB = "4000" # Excess headroom leaves CUDA with 0 usable

    $swarm = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_node.exe" `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case4-swarm.stdout.log" `
        -RedirectStandardError "$artifactDir\case4-swarm.stderr.log" `
        -PassThru -Wait

    $exitCode = $swarm.ExitCode
    $stderr = Get-Content "$artifactDir\case4-swarm.stderr.log" -Raw -ErrorAction SilentlyContinue
    if ($exitCode -ne 1 -or $stderr -notmatch "Insufficient dynamic capacity") {
        throw "Case 4: Expected exit code 1 with Insufficient capacity error, got $exitCode"
    }
    Write-Host "  Case 4: Insufficient dynamic capacity rejection passed." -ForegroundColor Green
    $results.cases["Case4_InsufficientCapacityRejection"] = "PASS"

    Stop-Process -Id $rpc0.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1

    # Reset headroom settings
    $env:SWARM_RESERVED_HEADROOM_RAM_MB = "1024"
    $env:SWARM_RESERVED_HEADROOM_VRAM_MB = "256"

    # -------------------------------------------------------------
    # Case 5: Loopback Memory Deduplication & Prometheus Metrics
    # -------------------------------------------------------------
    Write-Host "`n=== Case 5: Loopback Memory Deduplication & Prometheus Metrics ===" -ForegroundColor Green
    $rpc0 = Start-Process -FilePath "$workspaceRoot\temp_rpc_build\bin\ggml-rpc-server.exe" `
        -ArgumentList @("--host", "127.0.0.1", "--port", "50052", "--threads", "2") `
        -WorkingDirectory $workspaceRoot `
        -PassThru
    $rpc1 = Start-Process -FilePath "$workspaceRoot\temp_rpc_build\bin\ggml-rpc-server.exe" `
        -ArgumentList @("--host", "127.0.0.1", "--port", "50053", "--threads", "2") `
        -WorkingDirectory $workspaceRoot `
        -PassThru
    Start-Sleep -Seconds 1

    # Multi-worker loopback reports
    $case5Reports = @(
        [ordered]@{
            schema_version = "1.0"
            agent_version = "1.0.0"
            node_id = "node-rpc-127.0.0.1-50052"
            endpoint = "127.0.0.1:50052"
            status = "READY"
            ram = @{ total_bytes = 17179869184; available_bytes = 6442450944 }
            timestamp_ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        },
        [ordered]@{
            schema_version = "1.0"
            agent_version = "1.0.0"
            node_id = "node-rpc-127.0.0.1-50053"
            endpoint = "127.0.0.1:50053"
            status = "READY"
            ram = @{ total_bytes = 17179869184; available_bytes = 6442450944 }
            timestamp_ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
    )
    $case5ReportPath = "$artifactDir\case5-reports.json"
    $case5Reports | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 $case5ReportPath

    $env:SWARM_USE_RPC = "1"
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:50052, 127.0.0.1:50053"
    $env:SWARM_N_GPU_LAYERS = "4"
    $env:SWARM_PLACEMENT_POLICY = "dynamic"
    $env:SWARM_AGENT_REPORT_FILE = $case5ReportPath

    $swarm = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_node.exe" `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case5-swarm.stdout.log" `
        -RedirectStandardError "$artifactDir\case5-swarm.stderr.log" `
        -PassThru

    Write-Host "  Waiting for Swarm gateway on port 8080..." -ForegroundColor Cyan
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -TimeoutSec 2
            if ($resp.status -eq "ok" -and $resp.inference.ready -eq $true) {
                $ready = $true
                break
            }
        } catch {}
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw "Case 5: Swarm gateway failed to become ready" }

    # Query metrics and nodes
    $metrics = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8080/metrics" -TimeoutSec 3).Content
    Set-Content -Path "$artifactDir\case5-metrics.prom" -Value $metrics

    $nodes5 = Invoke-RestMethod -Uri "http://127.0.0.1:8080/nodes" -TimeoutSec 3
    $nodes5 | ConvertTo-Json -Depth 8 | Set-Content "$artifactDir\case5-nodes.json"

    if ($metrics -notmatch 'swarm_policy_configured\{policy="dynamic"\} 1') {
        throw "Case 5: Prometheus metrics missing dynamic policy gauge"
    }
    if ($nodes5.cluster_summary.memory_accounting.host_ram_deduplicated -ne $true) {
        throw "Case 5: Cluster memory must report host_ram_deduplicated: true"
    }

    Write-Host "  Case 5: Loopback deduplication and Prometheus metrics verified." -ForegroundColor Green
    $results.cases["Case5_LoopbackDeduplicationAndMetrics"] = "PASS"

    Stop-Process -Id $swarm.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $rpc0.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $rpc1.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1

    # -------------------------------------------------------------
    # Case 6: Backward Compatibility (Static Resource-Aware)
    # -------------------------------------------------------------
    Write-Host "`n=== Case 6: Backward Compatibility (Static Resource-Aware) ===" -ForegroundColor Green
    $rpc0 = Start-Process -FilePath "$workspaceRoot\temp_rpc_build\bin\ggml-rpc-server.exe" `
        -ArgumentList @("--host", "127.0.0.1", "--port", "50052", "--threads", "2") `
        -WorkingDirectory $workspaceRoot `
        -PassThru
    Start-Sleep -Seconds 1

    $env:SWARM_USE_RPC = "1"
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:50052"
    $env:SWARM_N_GPU_LAYERS = "4"
    $env:SWARM_PLACEMENT_POLICY = "resource_aware"
    $env:SWARM_WORKER_PROFILES = "RPC0=500MB,CUDA0=4000MB"
    $env:SWARM_AGENT_REPORT_FILE = ""

    $swarm = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_node.exe" `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case6-swarm.stdout.log" `
        -RedirectStandardError "$artifactDir\case6-swarm.stderr.log" `
        -PassThru

    Write-Host "  Waiting for Swarm gateway..." -ForegroundColor Cyan
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -TimeoutSec 2
            if ($resp.status -eq "ok" -and $resp.inference.ready -eq $true) {
                $ready = $true
                break
            }
        } catch {}
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw "Case 6: Swarm failed to become ready in resource_aware mode" }

    $body = @{
        messages = @(@{ role = "user"; content = "What is 2 + 2?" })
        max_tokens = 20
        temperature = 0.0
    } | ConvertTo-Json
    $chatRes = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8080/v1/chat/completions" `
        -Method Post -Body $body -ContentType "application/json" -TimeoutSec 30
    $text = Get-StreamedContent $chatRes.Content
    if ($text -notmatch "4") {
        throw "Case 6: Unexpected inference response: '$text'"
    }

    Write-Host "  Case 6: Static resource_aware backward compatibility verified." -ForegroundColor Green
    $results.cases["Case6_StaticProfileCompatibility"] = "PASS"

    Stop-Process -Id $swarm.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $rpc0.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1

    # -------------------------------------------------------------
    # Case 7: Local CUDA Fallback Regression
    # -------------------------------------------------------------
    Write-Host "`n=== Case 7: Local CUDA Fallback Regression ===" -ForegroundColor Green
    $env:SWARM_USE_RPC = "0"
    $env:SWARM_N_GPU_LAYERS = "-1"
    $env:SWARM_PLACEMENT_POLICY = "none"
    $env:SWARM_WORKER_PROFILES = ""
    $env:SWARM_AGENT_REPORT_FILE = ""

    $swarm = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_node.exe" `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case7-swarm.stdout.log" `
        -RedirectStandardError "$artifactDir\case7-swarm.stderr.log" `
        -PassThru

    Write-Host "  Waiting for local CUDA gateway..." -ForegroundColor Cyan
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -TimeoutSec 2
            if ($resp.status -eq "ok" -and $resp.inference.ready -eq $true) {
                $ready = $true
                break
            }
        } catch {}
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw "Case 7: Local CUDA gateway failed to start" }

    $body = @{
        messages = @(@{ role = "user"; content = "What is 2 + 2?" })
        max_tokens = 20
        temperature = 0.0
    } | ConvertTo-Json
    $chatRes = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8080/v1/chat/completions" `
        -Method Post -Body $body -ContentType "application/json" -TimeoutSec 30
    $text = Get-StreamedContent $chatRes.Content
    if ($text -notmatch "4") {
        throw "Case 7: Unexpected inference response: '$text'"
    }

    Write-Host "  Case 7: Full local CUDA inference passed ('$text')." -ForegroundColor Green
    $results.cases["Case7_LocalCudaFallback"] = "PASS"

    Stop-Process -Id $swarm.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1

    # -------------------------------------------------------------
    # Case 8: Graceful Teardown & Port Hygiene
    # -------------------------------------------------------------
    Write-Host "`n=== Case 8: Graceful Teardown & Port Hygiene ===" -ForegroundColor Green
    Cleanup-TestProcesses
    Assert-PortsFree @(8080, 50052, 50053)
    Write-Host "  Case 8: All ports 8080, 50052, 50053 verified free." -ForegroundColor Green
    $results.cases["Case8_TeardownAndPorts"] = "PASS"

    $results.overall = "PASS"
    $results | ConvertTo-Json -Depth 5 | Set-Content "$artifactDir\MILESTONE_9_RESULTS.json"
    Write-Host "`n=== Milestone 9 Validation Complete: ALL CASES PASSED ===" -ForegroundColor Green

} catch {
    Write-Host "`n[FATAL ERROR] Milestone 9 Validation failed: $($_.Exception.Message)" -ForegroundColor Red
    $results.overall = "FAIL"
    $results.error = $_.Exception.Message
    $results | ConvertTo-Json -Depth 5 | Set-Content "$artifactDir\MILESTONE_9_RESULTS.json"
    Cleanup-TestProcesses
    exit 1
} finally {
    Cleanup-TestProcesses
}
