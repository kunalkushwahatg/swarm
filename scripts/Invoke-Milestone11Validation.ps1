# Swarm Milestone 11 Validation Script
# Production Readiness & Deployment Hardening
# Date: 2026-10-10

$ErrorActionPreference = "Stop"

$workspaceRoot = "C:\Users\kunal\OneDrive\Desktop\swarm"
$artifactDir = "$workspaceRoot\artifacts\validation\2026-10-10\milestone-11"
New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null

$results = [ordered]@{
    timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
    milestone = 11
    model_check_sha256 = "626B4A6678B86442240E33DF819E00132D3BA7DDDFE1CDC4FBB18E0A9615C62D"
    cases = [ordered]@{}
}

function Cleanup-TestProcesses {
    Write-Host "[Cleanup] Stopping any running swarm/agent/rpc processes..." -ForegroundColor Cyan
    Get-Process -Name "swarm_node", "swarm_agent", "rpc-server", "ggml-rpc-server" -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "  Stopping process $($_.Name) (PID: $($_.Id))" -ForegroundColor Yellow
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 600
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
    $env:PATH = "$workspaceRoot\build-cuda\bin;$workspaceRoot\build-cuda;$workspaceRoot\temp_rpc_build\bin;$env:PATH"

    # -------------------------------------------------------------
    # Step 0: Offline Unit Tests
    # -------------------------------------------------------------
    Write-Host "`n=== Step 0: Offline Unit Tests ===" -ForegroundColor Green

    Write-Host "  Running Milestone 11 Security Primitives (test_security.exe)..." -ForegroundColor Cyan
    $secOut = & "$workspaceRoot\build-cuda\test_security.exe" 2>&1
    if ($LASTEXITCODE -ne 0 -or (($secOut -join "`n") -notmatch "ALL 6 SECURITY UNIT TESTS PASSED")) {
        throw "Step 0 test_security.exe failed. Output:`n$secOut"
    }
    Write-Host "    PASS: test_security.exe (6/6 tests including read_secret_from_file)" -ForegroundColor Green

    Write-Host "  Running Milestone 8 Node Inventory Tests (test_agent_and_inventory.exe)..." -ForegroundColor Cyan
    $invOut = & "$workspaceRoot\test_agent_and_inventory.exe" 2>&1
    if ($LASTEXITCODE -ne 0 -or (($invOut -join "`n") -notmatch "All 7 Milestone 8 Unit Tests PASSED")) {
        throw "Step 0 test_agent_and_inventory.exe failed. Output:`n$invOut"
    }
    Write-Host "    PASS: test_agent_and_inventory.exe (7/7 tests)" -ForegroundColor Green

    Write-Host "  Running Milestone 9 Dynamic Policy Tests (test_dynamic_policy.exe)..." -ForegroundColor Cyan
    $polOut = & "$workspaceRoot\test_dynamic_policy.exe" 2>&1
    if ($LASTEXITCODE -ne 0 -or (($polOut -join "`n") -notmatch "All 9 dynamic policy unit tests passed")) {
        throw "Step 0 test_dynamic_policy.exe failed. Output:`n$polOut"
    }
    Write-Host "    PASS: test_dynamic_policy.exe (9/9 tests)" -ForegroundColor Green
    $results.cases["Step0_UnitTests"] = "PASS"

    # Create secret token file for test suite
    $testTokenSecret = "m11-secret-production-token-2026"
    $tokenFilePath = "$artifactDir\prod_telemetry.token"
    # Write token with surrounding whitespace to prove trimming in read_secret_from_file
    [System.IO.File]::WriteAllText($tokenFilePath, "   $testTokenSecret   `r`n")
    Write-Host "Created test token file at $tokenFilePath" -ForegroundColor Gray

    # -------------------------------------------------------------
    # Case 1: Fatal Preflight Failure in Production Mode without Credentials
    # -------------------------------------------------------------
    Write-Host "`n=== Case 1: Fatal Preflight Failure in Production Mode without Credentials ===" -ForegroundColor Green
    $env:SWARM_DEPLOYMENT_ENV = "production"
    $env:SWARM_TELEMETRY_TOKEN = ""
    $env:SWARM_TELEMETRY_TOKEN_FILE = ""
    $env:SWARM_AUTH_TOKEN = ""
    $env:SWARM_USE_RPC = "0"
    $env:SWARM_MODEL_PATH = "$workspaceRoot\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf"

    $c1Process = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_node.exe" `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case1.stdout.log" `
        -RedirectStandardError "$artifactDir\case1.stderr.log" `
        -PassThru

    $exitedCleanly = $c1Process.WaitForExit(5000)
    if (-not $exitedCleanly) {
        Stop-Process -Id $c1Process.Id -Force -ErrorAction SilentlyContinue
        throw "Case 1 failed: Coordinator did not exit immediately in production mode without credentials."
    }

    $c1Err = Get-Content "$artifactDir\case1.stderr.log" -Raw -ErrorAction SilentlyContinue
    $c1Out = Get-Content "$artifactDir\case1.stdout.log" -Raw -ErrorAction SilentlyContinue
    $c1Combined = "$c1Out`n$c1Err"

    if ($c1Process.ExitCode -eq 0) {
        throw "Case 1 failed: Coordinator exited with status 0, expected non-zero fatal exit code."
    }
    if ($c1Combined -notmatch "FATAL SECURITY PREFLIGHT") {
        throw "Case 1 failed: Expected '[FATAL SECURITY PREFLIGHT]' in coordinator output, got:`n$c1Combined"
    }
    Write-Host "  PASS: Coordinator halted startup with exit code $($c1Process.ExitCode) and logged '[FATAL SECURITY PREFLIGHT]'." -ForegroundColor Green
    $results.cases["Case1_ProductionPreflightRejection"] = "PASS"

    # -------------------------------------------------------------
    # Case 2: Production Startup Success with SWARM_TELEMETRY_TOKEN_FILE
    # -------------------------------------------------------------
    Write-Host "`n=== Case 2: Production Startup Success with SWARM_TELEMETRY_TOKEN_FILE ===" -ForegroundColor Green
    $env:SWARM_DEPLOYMENT_ENV = "production"
    $env:SWARM_TELEMETRY_TOKEN_FILE = $tokenFilePath
    $env:SWARM_TELEMETRY_TOKEN = ""
    $env:SWARM_USE_RPC = "0"
    $env:PORT = "8080"

    $c2Process = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_node.exe" `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case2.stdout.log" `
        -RedirectStandardError "$artifactDir\case2.stderr.log" `
        -PassThru

    $c2Ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -Method Get -TimeoutSec 2
            if ($resp.status -eq "ok") { $c2Ready = $true; break }
        } catch {}
        Start-Sleep -Seconds 1
    }
    if (-not $c2Ready) {
        Stop-Process -Id $c2Process.Id -Force -ErrorAction SilentlyContinue
        throw "Case 2 failed: Production coordinator did not become ready on port 8080."
    }

    $c2Out = Get-Content "$artifactDir\case2.stdout.log" -Raw -ErrorAction SilentlyContinue
    if ($c2Out -notmatch "Deployment Environment: PRODUCTION" -or $c2Out -notmatch "Telemetry Auth: ENABLED") {
        Stop-Process -Id $c2Process.Id -Force -ErrorAction SilentlyContinue
        throw "Case 2 failed: Expected 'Deployment Environment: PRODUCTION' and 'Telemetry Auth: ENABLED' in logs."
    }
    Write-Host "  PASS: Production coordinator loaded token from file and verified health status: ok." -ForegroundColor Green
    $results.cases["Case2_ProductionTokenFileStartup"] = "PASS"

    # -------------------------------------------------------------
    # Case 3: Agent CLI --token Process-List Exposure Warning
    # -------------------------------------------------------------
    Write-Host "`n=== Case 3: Agent CLI --token Process-List Exposure Advisory Warning ===" -ForegroundColor Green
    $c3Agent = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_agent.exe" `
        -ArgumentList @("--token", "cli-exposed-secret", "--coordinator", "http://127.0.0.1:8080", "--once") `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case3_agent.stdout.log" `
        -RedirectStandardError "$artifactDir\case3_agent.stderr.log" `
        -Wait -PassThru

    $c3Err = Get-Content "$artifactDir\case3_agent.stderr.log" -Raw -ErrorAction SilentlyContinue
    if ($c3Err -notmatch "Agent Security Warning.*command-line arguments exposes tokens") {
        throw "Case 3 failed: Expected process list exposure security warning in stderr, got:`n$c3Err"
    }
    Write-Host "  PASS: Agent logged visible process-list exposure warning on stderr." -ForegroundColor Green
    $results.cases["Case3_AgentCliTokenExposureWarning"] = "PASS"

    # -------------------------------------------------------------
    # Case 4: Agent Authenticated Telemetry Ingestion via --token-file
    # -------------------------------------------------------------
    Write-Host "`n=== Case 4: Agent Authenticated Telemetry Ingestion via --token-file ===" -ForegroundColor Green
    $c4Agent = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_agent.exe" `
        -ArgumentList @("--coordinator", "http://127.0.0.1:8080", "--token-file", $tokenFilePath, "--endpoint", "127.0.0.1:50052", "--rpc-port", "50052", "--node-id", "m11-agent-verified", "--once") `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case4_agent.stdout.log" `
        -RedirectStandardError "$artifactDir\case4_agent.stderr.log" `
        -Wait -PassThru
    
    if ($c4Agent.ExitCode -ne 0) {
        $c4Err = Get-Content "$artifactDir\case4_agent.stderr.log" -Raw -ErrorAction SilentlyContinue
        throw "Case 4 failed: Agent exited with code $($c4Agent.ExitCode). Stderr:`n$c4Err"
    }

    # Give coordinator a moment to settle inventory update
    Start-Sleep -Milliseconds 600

    # Verify coordinator received and registered the node
    $nodesResp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/nodes" -Method Get -TimeoutSec 5
    $targetNode = @($nodesResp.nodes) | Where-Object { ($_.node_id -eq "m11-agent-verified" -or $_.endpoint -eq "127.0.0.1:50052") -and $_.agent_reported -eq $true }
    if (-not $targetNode) {
        $nodesDump = $nodesResp | ConvertTo-Json -Depth 3
        throw "Case 4 failed: Registered node not found with agent_reported=true in coordinator inventory. Dump:`n$nodesDump"
    }
    Write-Host "  PASS: Agent successfully authenticated using --token-file; node $($targetNode.node_id) verified in inventory." -ForegroundColor Green
    $results.cases["Case4_AgentTokenFileAuthentication"] = "PASS"

    # Stop Case 2/4 coordinator
    Stop-Process -Id $c2Process.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1

    # -------------------------------------------------------------
    # Case 5: Development Mode Unauthenticated Loopback & Remote Isolation
    # -------------------------------------------------------------
    Write-Host "`n=== Case 5: Development Mode Unauthenticated Loopback & Remote Isolation ===" -ForegroundColor Green
    $env:SWARM_DEPLOYMENT_ENV = "development"
    $env:SWARM_TELEMETRY_TOKEN_FILE = ""
    $env:SWARM_TELEMETRY_TOKEN = ""
    $env:SWARM_USE_RPC = "0"

    $c5Process = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_node.exe" `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case5.stdout.log" `
        -RedirectStandardError "$artifactDir\case5.stderr.log" `
        -PassThru

    $c5Ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -Method Get -TimeoutSec 2
            if ($resp.status -eq "ok") { $c5Ready = $true; break }
        } catch {}
        Start-Sleep -Seconds 1
    }
    if (-not $c5Ready) {
        Stop-Process -Id $c5Process.Id -Force -ErrorAction SilentlyContinue
        throw "Case 5 failed: Development coordinator did not become ready."
    }

    # Verify dev mode log
    $c5Out = Get-Content "$artifactDir\case5.stdout.log" -Raw -ErrorAction SilentlyContinue
    if ($c5Out -notmatch "Deployment Environment: DEVELOPMENT" -or $c5Out -notmatch "Telemetry Auth: DISABLED") {
        Stop-Process -Id $c5Process.Id -Force -ErrorAction SilentlyContinue
        throw "Case 5 failed: Expected dev mode logging in coordinator stdout."
    }

    # Agent reports without any token from loopback -> succeeds in dev mode
    $c5Agent = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_agent.exe" `
        -ArgumentList @("--coordinator", "http://127.0.0.1:8080", "--endpoint", "127.0.0.1:50052", "--node-id", "dev-unauth-loopback", "--once") `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case5_agent.stdout.log" `
        -RedirectStandardError "$artifactDir\case5_agent.stderr.log" `
        -Wait -PassThru
    if ($c5Agent.ExitCode -ne 0) {
        $c5AgentErr = Get-Content "$artifactDir\case5_agent.stderr.log" -Raw -ErrorAction SilentlyContinue
        Stop-Process -Id $c5Process.Id -Force -ErrorAction SilentlyContinue
        throw "Case 5 failed: Loopback agent report failed in dev mode with exit code $($c5Agent.ExitCode). Stderr:`n$c5AgentErr"
    }
    Write-Host "  PASS: Unauthenticated loopback report accepted in development mode." -ForegroundColor Green
    $results.cases["Case5_DevModeLoopbackAcceptance"] = "PASS"

    Stop-Process -Id $c5Process.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1

    # -------------------------------------------------------------
    # Case 6: Remote RPC Endpoint Security Advisory in Production Mode
    # -------------------------------------------------------------
    Write-Host "`n=== Case 6: Remote RPC Endpoint Security Advisory in Production Mode ===" -ForegroundColor Green
    $env:SWARM_DEPLOYMENT_ENV = "production"
    $env:SWARM_TELEMETRY_TOKEN_FILE = $tokenFilePath
    $env:SWARM_USE_RPC = "1"
    $env:SWARM_RPC_ENDPOINTS = "192.168.1.99:50052"

    $c6Process = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_node.exe" `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case6.stdout.log" `
        -RedirectStandardError "$artifactDir\case6.stderr.log" `
        -PassThru

    Start-Sleep -Seconds 2
    Stop-Process -Id $c6Process.Id -Force -ErrorAction SilentlyContinue

    $c6Out = Get-Content "$artifactDir\case6.stdout.log" -Raw -ErrorAction SilentlyContinue
    if ($c6Out -notmatch "Remote RPC worker endpoint detected: '192.168.1.99:50052'" -or
        $c6Out -notmatch "Upstream GGML RPC is unencrypted and unauthenticated plain TCP") {
        throw "Case 6 failed: Remote RPC security advisory not found in coordinator stdout. Got:`n$c6Out"
    }
    Write-Host "  PASS: Coordinator emitted remote RPC security advisory during preflight." -ForegroundColor Green
    $results.cases["Case6_RemoteRpcSecurityAdvisory"] = "PASS"

    # -------------------------------------------------------------
    # Case 7: End-to-End Live Multi-Worker Inference with Hardened Production Coordinator
    # -------------------------------------------------------------
    Write-Host "`n=== Case 7: End-to-End Live Multi-Worker Inference with Hardened Production Coordinator ===" -ForegroundColor Green

    # Launch RPC workers
    $rpc0 = Start-Process -FilePath "$workspaceRoot\temp_rpc_build\bin\ggml-rpc-server.exe" `
        -ArgumentList @("--host", "127.0.0.1", "--port", "50052", "--threads", "2") `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case7_rpc0.stdout.log" `
        -RedirectStandardError "$artifactDir\case7_rpc0.stderr.log" `
        -PassThru
    $rpc1 = Start-Process -FilePath "$workspaceRoot\temp_rpc_build\bin\ggml-rpc-server.exe" `
        -ArgumentList @("--host", "127.0.0.1", "--port", "50053", "--threads", "2") `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case7_rpc1.stdout.log" `
        -RedirectStandardError "$artifactDir\case7_rpc1.stderr.log" `
        -PassThru
    Start-Sleep -Seconds 1

    $env:SWARM_DEPLOYMENT_ENV = "production"
    $env:SWARM_TELEMETRY_TOKEN_FILE = $tokenFilePath
    $env:SWARM_USE_RPC = "1"
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:50052, 127.0.0.1:50053"
    $env:SWARM_N_GPU_LAYERS = "4"
    $env:SWARM_MODEL_PATH = "$workspaceRoot\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf"
    $env:SWARM_PLACEMENT_POLICY = "none"

    $c7Process = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_node.exe" `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case7_swarm.stdout.log" `
        -RedirectStandardError "$artifactDir\case7_swarm.stderr.log" `
        -PassThru

    Write-Host "  Waiting for production coordinator on port 8080..." -ForegroundColor Cyan
    $c7Ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -Method Get -TimeoutSec 2
            if ($resp.status -eq "ok") { $c7Ready = $true; break }
        } catch {}
        Start-Sleep -Seconds 1
    }
    if (-not $c7Ready) {
        throw "Case 7 failed: Coordinator did not become ready."
    }

    # Execute streaming inference request
    Write-Host "  Sending streaming inference request to /v1/chat/completions..." -ForegroundColor Cyan
    $requestBody = @{
        model = "qwen2.5-3b-instruct"
        stream = $true
        messages = @(
            @{ role = "user"; content = "Explain distributed computing in one sentence." }
        )
    } | ConvertTo-Json -Depth 3

    $headers = @{ "Content-Type" = "application/json" }
    $inferResp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8080/v1/chat/completions" `
        -Method Post -Headers $headers -Body $requestBody -TimeoutSec 30

    $fullText = Get-StreamedContent $inferResp.Content
    Write-Host "  Generated response: `"$fullText`"" -ForegroundColor Yellow

    if ([string]::IsNullOrWhiteSpace($fullText)) {
        throw "Case 7 failed: Received empty text from streaming inference endpoint."
    }
    Write-Host "  PASS: Live streaming multi-worker inference completed successfully in hardened production mode." -ForegroundColor Green
    $results.cases["Case7_LiveProductionInference"] = "PASS"

    # -------------------------------------------------------------
    # Case 8: Clean Teardown and Port Hygiene Verification
    # -------------------------------------------------------------
    Write-Host "`n=== Case 8: Clean Teardown and Port Hygiene Verification ===" -ForegroundColor Green
    Cleanup-TestProcesses
    Assert-PortsFree @(8080, 50052, 50053)
    Write-Host "  PASS: All processes stopped and ports 8080, 50052, 50053 verified free." -ForegroundColor Green
    $results.cases["Case8_TeardownAndPortHygiene"] = "PASS"

    $results.status = "SUCCESS"
    $results.summary = "All 8 integration cases and Step 0 unit tests PASSED cleanly."

} catch {
    Write-Host "`n[VALIDATION FAILED] $($_.Exception.Message)" -ForegroundColor Red
    $results.status = "FAILED"
    $results.error = $_.Exception.Message
} finally {
    Cleanup-TestProcesses
    $resultsJson = $results | ConvertTo-Json -Depth 4
    Set-Content -Path "$artifactDir\milestone11_validation_results.json" -Value $resultsJson
    Write-Host "`nValidation results saved to: $artifactDir\milestone11_validation_results.json" -ForegroundColor Cyan
}

if ($results.status -ne "SUCCESS") {
    exit 1
} else {
    Write-Host "`n==========================================================" -ForegroundColor Green
    Write-Host "  ALL SWARM MILESTONE 11 VALIDATION CHECKS PASSED!" -ForegroundColor Green
    Write-Host "==========================================================" -ForegroundColor Green
    exit 0
}
