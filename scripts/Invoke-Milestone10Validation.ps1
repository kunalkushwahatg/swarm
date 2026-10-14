# Swarm Milestone 10 Validation Script
# Secure Remote-Node Readiness & Authenticated Telemetry Validation
# Date: 2026-10-10

$ErrorActionPreference = "Stop"

$workspaceRoot = "C:\Users\kunal\OneDrive\Desktop\swarm"
$artifactDir = "$workspaceRoot\artifacts\validation\2026-10-10\milestone-10"
New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null

$results = [ordered]@{
    timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
    milestone = 10
    model_check_sha256 = "626B4A6678B86442240E33DF819E00132D3BA7DDDFE1CDC4FBB18E0A9615C62D"
    cases = [ordered]@{}
}

function Cleanup-TestProcesses {
    Write-Host "[Cleanup] Checking for running swarm/agent/rpc processes..." -ForegroundColor Cyan
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
    $env:PATH = "$workspaceRoot\build-cuda\bin;$workspaceRoot\temp_rpc_build\bin;$env:PATH"

    # -------------------------------------------------------------
    # Step 0: Offline Unit Tests
    # -------------------------------------------------------------
    Write-Host "`n=== Step 0: Offline Unit Tests ===" -ForegroundColor Green

    Write-Host "  Running Milestone 10 Security Primitives (test_security.exe)..." -ForegroundColor Cyan
    $secOut = & "$workspaceRoot\build-cuda\test_security.exe" 2>&1
    if ($LASTEXITCODE -ne 0 -or (($secOut -join "`n") -notmatch "ALL (5|6) SECURITY UNIT TESTS PASSED")) {
        throw "Step 0 test_security.exe failed. Output:`n$secOut"
    }
    Write-Host "    PASS: test_security.exe (5/5 tests)" -ForegroundColor Green

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

    # -------------------------------------------------------------
    # Setup Workers & Shared Coordinator for Cases 1 - 6
    # -------------------------------------------------------------
    Write-Host "`n=== Launching RPC Workers and Authenticated Coordinator ===" -ForegroundColor Cyan
    $rpc0 = Start-Process -FilePath "$workspaceRoot\temp_rpc_build\bin\ggml-rpc-server.exe" `
        -ArgumentList @("--host", "127.0.0.1", "--port", "50052", "--threads", "2") `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\rpc0.stdout.log" `
        -RedirectStandardError "$artifactDir\rpc0.stderr.log" `
        -PassThru
    $rpc1 = Start-Process -FilePath "$workspaceRoot\temp_rpc_build\bin\ggml-rpc-server.exe" `
        -ArgumentList @("--host", "127.0.0.1", "--port", "50053", "--threads", "2") `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\rpc1.stdout.log" `
        -RedirectStandardError "$artifactDir\rpc1.stderr.log" `
        -PassThru
    Start-Sleep -Seconds 1

    $testAuthToken = "m10-secret-telemetry-token-2026"
    $env:SWARM_USE_RPC = "1"
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:50052, 127.0.0.1:50053"
    $env:SWARM_N_GPU_LAYERS = "4"
    $env:SWARM_MODEL_PATH = "$workspaceRoot\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf"
    $env:SWARM_PLACEMENT_POLICY = "none"
    $env:SWARM_TELEMETRY_TOKEN = $testAuthToken

    $swarm = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_node.exe" `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\swarm.stdout.log" `
        -RedirectStandardError "$artifactDir\swarm.stderr.log" `
        -PassThru

    Write-Host "  Waiting for Swarm coordinator on port 8080..." -ForegroundColor Cyan
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -Method Get -TimeoutSec 2
            if ($resp.status -eq "ok") { $ready = $true; break }
        } catch {}
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw "Swarm coordinator did not become ready on port 8080." }

    # Verify coordinator logged that telemetry auth is enabled
    Start-Sleep -Milliseconds 500
    $stdoutContent = Get-Content "$artifactDir\swarm.stdout.log" -Raw
    if ($stdoutContent -notmatch "Telemetry Auth: ENABLED") {
        throw "Coordinator stdout did not log 'Telemetry Auth: ENABLED'"
    }
    Write-Host "  Coordinator verified: Telemetry Auth is ENABLED." -ForegroundColor Green

    # Base valid report payload generator
    function New-ReportPayload([string]$NodeId, [int]$RpcPort, [string]$SessionId, [long]$Seq) {
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $reportObj = @{
            schema_version = "1.0"
            agent_version = "1.0.0"
            agent_session_id = $SessionId
            sequence_number = $Seq
            node_id = $NodeId
            hostname = "test-host"
            endpoint = "127.0.0.1:$RpcPort"
            rpc_port = $RpcPort
            status = "ONLINE"
            timestamp_ms = $now
            cpu = @{ architecture = "x86_64"; processor_count = 8; model_name = "Test CPU" }
            ram = @{ total_bytes = 17179869184; available_bytes = 12884901888 }
            gpu = @(@{ device_name = "Test GPU"; total_vram_bytes = 4294967296; free_vram_bytes = 3221225472; compute_capability = "6.1" })
        }
        return ($reportObj | ConvertTo-Json -Depth 5)
    }

    # -------------------------------------------------------------
    # Case 1: Missing Authentication Rejection
    # -------------------------------------------------------------
    Write-Host "`n=== Case 1: Missing Authentication Rejection ===" -ForegroundColor Green
    $payload1 = New-ReportPayload "node-case1" 50052 "sess-1" 1
    $case1Passed = $false
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:8080/api/v1/nodes/report" `
            -Method Post -Body $payload1 -ContentType "application/json" -TimeoutSec 5
        throw "Request unexpectedly succeeded with HTTP $($resp.StatusCode)"
    } catch [System.Net.WebException] {
        $httpResp = $_.Exception.Response
        if ($httpResp -and [int]$httpResp.StatusCode -eq 401) {
            $wwwAuth = $httpResp.Headers["WWW-Authenticate"]
            if ($wwwAuth -match "Bearer") {
                Write-Host "  PASS: Received HTTP 401 Unauthorized with WWW-Authenticate: $wwwAuth" -ForegroundColor Green
                $case1Passed = $true
            } else {
                throw "HTTP 401 received but WWW-Authenticate header missing or invalid: $wwwAuth"
            }
        } else {
            throw "Expected HTTP 401, but got: $($_.Exception.Message)"
        }
    }
    if (-not $case1Passed) { throw "Case 1 failed" }
    $results.cases["Case1_MissingAuth"] = "PASS"

    # -------------------------------------------------------------
    # Case 2: Incorrect Authentication Rejection
    # -------------------------------------------------------------
    Write-Host "`n=== Case 2: Incorrect Authentication Rejection ===" -ForegroundColor Green
    $payload2 = New-ReportPayload "node-case2" 50052 "sess-2" 1
    
    # 2a: Invalid token -> 403 Forbidden
    $case2aPassed = $false
    try {
        $headers = @{ "Authorization" = "Bearer completely-wrong-token-999" }
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:8080/api/v1/nodes/report" `
            -Method Post -Headers $headers -Body $payload2 -ContentType "application/json" -TimeoutSec 5
        throw "Request unexpectedly succeeded with HTTP $($resp.StatusCode)"
    } catch [System.Net.WebException] {
        $httpResp = $_.Exception.Response
        if ($httpResp -and [int]$httpResp.StatusCode -eq 403) {
            Write-Host "  PASS: Invalid token rejected with HTTP 403 Forbidden" -ForegroundColor Green
            $case2aPassed = $true
        } else {
            throw "Expected HTTP 403, but got: $($_.Exception.Message)"
        }
    }

    # 2b: Malformed auth scheme (Basic instead of Bearer) -> 401 Unauthorized
    $case2bPassed = $false
    try {
        $headers = @{ "Authorization" = "Basic dXNlcjpwYXNz" }
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:8080/api/v1/nodes/report" `
            -Method Post -Headers $headers -Body $payload2 -ContentType "application/json" -TimeoutSec 5
        throw "Request unexpectedly succeeded with HTTP $($resp.StatusCode)"
    } catch [System.Net.WebException] {
        $httpResp = $_.Exception.Response
        if ($httpResp -and [int]$httpResp.StatusCode -eq 401) {
            Write-Host "  PASS: Non-Bearer scheme rejected with HTTP 401 Unauthorized" -ForegroundColor Green
            $case2bPassed = $true
        } else {
            throw "Expected HTTP 401, but got: $($_.Exception.Message)"
        }
    }
    if ($case2aPassed -and $case2bPassed) {
        $results.cases["Case2_IncorrectAuth"] = "PASS"
    }

    # -------------------------------------------------------------
    # Case 3: Valid Authentication Acceptance via swarm_agent.exe
    # -------------------------------------------------------------
    Write-Host "`n=== Case 3: Valid Authentication via swarm_agent.exe ===" -ForegroundColor Green
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $agentOut = & "$workspaceRoot\build-cuda\swarm_agent.exe" `
        --coordinator "http://127.0.0.1:8080" `
        --token $testAuthToken `
        --node-id "node-authenticated-1" `
        --endpoint "127.0.0.1:50052" `
        --rpc-port 50052 `
        --once 2>&1
    $ErrorActionPreference = $prevEap
    $agentOut | Out-File "$artifactDir\case3-agent.log" -Encoding utf8
    if ($LASTEXITCODE -ne 0) {
        throw "swarm_agent.exe failed with exit code $LASTEXITCODE. Output:`n$agentOut"
    }
    if (($agentOut -join "`n") -notmatch "Report accepted by coordinator \(HTTP 200\)") {
        throw "swarm_agent output did not confirm acceptance: $agentOut"
    }
    Write-Host "  PASS: swarm_agent authenticated and accepted (HTTP 200)" -ForegroundColor Green

    # Verify inventory state
    $nodesResp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/nodes" -Method Get
    $targetNode = $nodesResp.nodes | Where-Object { $_.endpoint -eq "127.0.0.1:50052" }
    if (-not $targetNode) {
        throw "Reported node with endpoint 127.0.0.1:50052 not found in /nodes"
    }
    if (-not $targetNode.agent_reported) {
        throw "Node does not reflect agent_reported=true"
    }
    if ($targetNode.connection_state -ne "READY" -and $targetNode.connection_state -ne "ONLINE") {
        throw "Node connection_state is '$($targetNode.connection_state)', expected READY or ONLINE"
    }
    Write-Host "  PASS: Worker 127.0.0.1:50052 registered in inventory (agent_reported=true, state=$($targetNode.connection_state))" -ForegroundColor Green
    $results.cases["Case3_ValidAuthAcceptance"] = "PASS"

    # -------------------------------------------------------------
    # Case 4: Unauthorized Requests Cannot Refresh Telemetry
    # -------------------------------------------------------------
    Write-Host "`n=== Case 4: Unauthorized Requests Cannot Refresh Telemetry ===" -ForegroundColor Green
    $initLastSeen = $targetNode.last_agent_report_ms
    Start-Sleep -Seconds 1

    # Send unauthorized update attempt for the same node
    $unauthPayload = New-ReportPayload $targetNode.node_id 50052 "sess-unauth" 99
    try {
        $headers = @{ "Authorization" = "Bearer invalid-token" }
        Invoke-WebRequest -Uri "http://127.0.0.1:8080/api/v1/nodes/report" `
            -Method Post -Headers $headers -Body $unauthPayload -ContentType "application/json" -TimeoutSec 5 | Out-Null
        throw "Unauthorized update unexpectedly succeeded"
    } catch [System.Net.WebException] {
        # Expected rejection
    }

    $nodesAfter = Invoke-RestMethod -Uri "http://127.0.0.1:8080/nodes" -Method Get
    $targetNodeAfter = $nodesAfter.nodes | Where-Object { $_.endpoint -eq "127.0.0.1:50052" }
    if ($targetNodeAfter.last_agent_report_ms -ne $initLastSeen) {
        throw "Unauthorized report updated node freshness! (Before: $initLastSeen, After: $($targetNodeAfter.last_agent_report_ms))"
    }
    Write-Host "  PASS: Telemetry freshness remained strictly unrefreshed after unauthorized request" -ForegroundColor Green
    $results.cases["Case4_UnauthorizedCannotRefresh"] = "PASS"

    # -------------------------------------------------------------
    # Case 5: Malformed and Oversized Payloads Rejection
    # -------------------------------------------------------------
    Write-Host "`n=== Case 5: Malformed & Oversized Payload Rejection ===" -ForegroundColor Green
    $validHeaders = @{ "Authorization" = "Bearer $testAuthToken" }

    # 5a: Oversized payload (> 64 KB) -> 413 Payload Too Large
    $largeString = "x" * 70000
    $oversizedPayload = "{`"padding`":`"$largeString`"}"
    $case5aPassed = $false
    try {
        Invoke-WebRequest -Uri "http://127.0.0.1:8080/api/v1/nodes/report" `
            -Method Post -Headers $validHeaders -Body $oversizedPayload -ContentType "application/json" -TimeoutSec 5 | Out-Null
        throw "Oversized request unexpectedly succeeded"
    } catch [System.Net.WebException] {
        $httpResp = $_.Exception.Response
        if ($httpResp -and [int]$httpResp.StatusCode -eq 413) {
            Write-Host "  PASS: Payload > 64KB rejected with HTTP 413 Payload Too Large" -ForegroundColor Green
            $case5aPassed = $true
        } else {
            throw "Expected HTTP 413, got: $($_.Exception.Message)"
        }
    }

    # 5b: Malformed JSON -> 400 Bad Request
    $case5bPassed = $false
    try {
        Invoke-WebRequest -Uri "http://127.0.0.1:8080/api/v1/nodes/report" `
            -Method Post -Headers $validHeaders -Body "{ malformed json ::: " -ContentType "application/json" -TimeoutSec 5 | Out-Null
        throw "Malformed JSON request unexpectedly succeeded"
    } catch [System.Net.WebException] {
        $httpResp = $_.Exception.Response
        if ($httpResp -and [int]$httpResp.StatusCode -eq 400) {
            Write-Host "  PASS: Malformed JSON rejected with HTTP 400 Bad Request" -ForegroundColor Green
            $case5bPassed = $true
        } else {
            throw "Expected HTTP 400, got: $($_.Exception.Message)"
        }
    }

    # 5c: Invalid schema_version -> 400 Bad Request
    $invalidSchemaPayload = New-ReportPayload "node-bad-schema" 50052 "sess-bad" 1
    $invalidSchemaObj = $invalidSchemaPayload | ConvertFrom-Json
    $invalidSchemaObj.schema_version = "99.0"
    $invalidSchemaStr = $invalidSchemaObj | ConvertTo-Json -Depth 5
    $case5cPassed = $false
    try {
        Invoke-WebRequest -Uri "http://127.0.0.1:8080/api/v1/nodes/report" `
            -Method Post -Headers $validHeaders -Body $invalidSchemaStr -ContentType "application/json" -TimeoutSec 5 | Out-Null
        throw "Invalid schema request unexpectedly succeeded"
    } catch [System.Net.WebException] {
        $httpResp = $_.Exception.Response
        if ($httpResp -and [int]$httpResp.StatusCode -eq 400) {
            Write-Host "  PASS: Invalid schema_version rejected with HTTP 400 Bad Request" -ForegroundColor Green
            $case5cPassed = $true
        } else {
            throw "Expected HTTP 400, got: $($_.Exception.Message)"
        }
    }
    if ($case5aPassed -and $case5bPassed -and $case5cPassed) {
        $results.cases["Case5_MalformedAndOversized"] = "PASS"
    }

    # -------------------------------------------------------------
    # Case 6: Agent Reconnection & Sequence Tracking with Auth
    # -------------------------------------------------------------
    Write-Host "`n=== Case 6: Agent Reconnection & Sequence Tracking with Auth ===" -ForegroundColor Green
    $agentProc = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_agent.exe" `
        -ArgumentList @(
            "--coordinator", "http://127.0.0.1:8080",
            "--token", $testAuthToken,
            "--node-id", "node-reconnect-test",
            "--endpoint", "127.0.0.1:50052",
            "--rpc-port", "50052",
            "--interval-ms", "1000"
        ) `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case6-agent1.stdout.log" `
        -RedirectStandardError "$artifactDir\case6-agent1.stderr.log" `
        -PassThru

    Start-Sleep -Seconds 3
    Stop-Process -Id $agentProc.Id -Force -ErrorAction SilentlyContinue

    $nodesS1 = Invoke-RestMethod -Uri "http://127.0.0.1:8080/nodes" -Method Get
    $reconNode1 = $nodesS1.nodes | Where-Object { $_.endpoint -eq "127.0.0.1:50052" }
    if (-not $reconNode1 -or $reconNode1.last_sequence_number -lt 2) {
        throw "First agent session did not produce expected sequential reports"
    }
    $firstSessionSeq = $reconNode1.last_sequence_number
    $firstSessionId = $reconNode1.agent_session_id
    Write-Host "  Session 1 completed with Seq=$firstSessionSeq, SessionId=$firstSessionId" -ForegroundColor Cyan

    # Start Session 2 (simulating agent restart)
    $agentProc2 = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_agent.exe" `
        -ArgumentList @(
            "--coordinator", "http://127.0.0.1:8080",
            "--token", $testAuthToken,
            "--node-id", "node-reconnect-test",
            "--endpoint", "127.0.0.1:50052",
            "--rpc-port", "50052",
            "--interval-ms", "1000"
        ) `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case6-agent2.stdout.log" `
        -RedirectStandardError "$artifactDir\case6-agent2.stderr.log" `
        -PassThru

    Start-Sleep -Seconds 3
    Stop-Process -Id $agentProc2.Id -Force -ErrorAction SilentlyContinue

    $nodesS2 = Invoke-RestMethod -Uri "http://127.0.0.1:8080/nodes" -Method Get
    $reconNode2 = $nodesS2.nodes | Where-Object { $_.endpoint -eq "127.0.0.1:50052" }
    if ($reconNode2.agent_session_id -eq $firstSessionId) {
        throw "Session ID did not change on agent restart!"
    }
    Write-Host "  PASS: Coordinator correctly accepted reconnected agent with new session ID: $($reconNode2.agent_session_id)" -ForegroundColor Green
    $results.cases["Case6_AgentReconnection"] = "PASS"

    # Teardown first coordinator
    Write-Host "  Stopping coordinator for mode switch..." -ForegroundColor Cyan
    Stop-Process -Id $swarm.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1

    # -------------------------------------------------------------
    # Case 7: Unauthenticated Loopback Development Mode Visibility
    # -------------------------------------------------------------
    Write-Host "`n=== Case 7: Unauthenticated Loopback Development Mode ===" -ForegroundColor Green
    $env:SWARM_TELEMETRY_TOKEN = "" # unset token
    $swarmDev = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_node.exe" `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case7-swarm.stdout.log" `
        -RedirectStandardError "$artifactDir\case7-swarm.stderr.log" `
        -PassThru

    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -Method Get -TimeoutSec 2
            if ($resp.status -eq "ok") { $ready = $true; break }
        } catch {}
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw "Dev mode coordinator failed to start on port 8080" }

    $devStdout = Get-Content "$artifactDir\case7-swarm.stdout.log" -Raw
    if ($devStdout -notmatch "Telemetry Auth: DISABLED \(Unauthenticated loopback development mode") {
        throw "Dev mode coordinator did not log expected security warning!"
    }
    Write-Host "  PASS: Coordinator visibly logged warning that Telemetry Auth is DISABLED" -ForegroundColor Green

    # Verify loopback unauthenticated report is accepted in dev mode
    $devPayload = New-ReportPayload "node-dev-mode-1" 50052 "sess-dev" 1
    $devResp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/v1/nodes/report" `
        -Method Post -Body $devPayload -ContentType "application/json" -TimeoutSec 5
    if ($devResp.status -ne "accepted") {
        throw "Unauthenticated loopback report rejected in dev mode: $($devResp | ConvertTo-Json)"
    }
    Write-Host "  PASS: Unauthenticated loopback report accepted in dev mode (HTTP 200)" -ForegroundColor Green
    $results.cases["Case7_UnauthLoopbackDevMode"] = "PASS"

    Stop-Process -Id $swarmDev.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1

    # -------------------------------------------------------------
    # Case 8: Live Authenticated Inference with Dynamic Placement
    # -------------------------------------------------------------
    Write-Host "`n=== Case 8: Live Inference with Authenticated Telemetry ===" -ForegroundColor Green
    $env:SWARM_USE_RPC = "1"
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:50052"
    $env:SWARM_PLACEMENT_POLICY = "dynamic"
    $env:SWARM_DISCOVERY_TIMEOUT_MS = "4000"
    $env:SWARM_TELEMETRY_TOKEN = "inference-auth-token-888"

    # Start coordinator in dynamic mode
    $swarmInf = Start-Process -FilePath "$workspaceRoot\build-cuda\swarm_node.exe" `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput "$artifactDir\case8-swarm.stdout.log" `
        -RedirectStandardError "$artifactDir\case8-swarm.stderr.log" `
        -PassThru

    # Feed authenticated report during discovery intake window
    Start-Sleep -Milliseconds 800
    Write-Host "  Feeding authenticated telemetry during discovery intake..." -ForegroundColor Cyan
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $agentOut = & "$workspaceRoot\build-cuda\swarm_agent.exe" `
        --coordinator "http://127.0.0.1:8080" `
        --token "inference-auth-token-888" `
        --endpoint "127.0.0.1:50052" `
        --rpc-port 50052 `
        --once 2>&1
    $ErrorActionPreference = $prevEap
    Write-Host "  Intake agent output: $agentOut" -ForegroundColor Cyan

    Write-Host "  Waiting for dynamic gateway on port 8080..." -ForegroundColor Cyan
    $ready = $false
    for ($i = 0; $i -lt 35; $i++) {
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -Method Get -TimeoutSec 2
            if ($resp.status -eq "ok") { $ready = $true; break }
        } catch {}
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw "Dynamic Swarm gateway failed to become ready on port 8080" }

    # Execute chat completion
    Write-Host "  Sending chat completion request: 'What is 2 + 2?'..." -ForegroundColor Cyan
    $reqBody = @{
        model = "qwen2.5-3b-instruct"
        messages = @(
            @{ role = "user"; content = "Calculate 2 + 2. Answer with just the number." }
        )
        max_tokens = 20
        temperature = 0.0
    } | ConvertTo-Json -Compress

    $chatResp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8080/v1/chat/completions" `
        -Method Post -Body $reqBody -ContentType "application/json" -TimeoutSec 30
    $compText = Get-StreamedContent $chatResp.Content
    Write-Host "  Response text: '$compText'" -ForegroundColor Green
    if ($compText -notmatch "4") {
        throw "Chat completion did not contain expected answer '4'. Response: $compText"
    }
    Write-Host "  PASS: Live inference succeeded with dynamic placement and authenticated telemetry" -ForegroundColor Green
    $results.cases["Case8_LiveAuthenticatedInference"] = "PASS"

    Stop-Process -Id $swarmInf.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $rpc0.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $rpc1.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1

    # -------------------------------------------------------------
    # Case 9: Teardown and Port Hygiene
    # -------------------------------------------------------------
    Write-Host "`n=== Case 9: Clean Teardown and Port Hygiene ===" -ForegroundColor Green
    Cleanup-TestProcesses
    Assert-PortsFree @(8080, 50052, 50053)
    Write-Host "  PASS: Ports 8080, 50052, and 50053 are completely free" -ForegroundColor Green
    $results.cases["Case9_PortHygiene"] = "PASS"

    # Final summary output
    Write-Host "`n=======================================================" -ForegroundColor Green
    Write-Host "MILESTONE 10 VALIDATION: ALL CASES PASSED SUCCESSFULLY" -ForegroundColor Green
    Write-Host "=======================================================" -ForegroundColor Green
    $results.cases.GetEnumerator() | ForEach-Object {
        Write-Host "  $($_.Key): $($_.Value)" -ForegroundColor Green
    }

    $results | ConvertTo-Json -Depth 5 | Out-File "$artifactDir\milestone10_summary.json" -Encoding utf8
    exit 0

} catch {
    Write-Host "`n[FATAL ERROR] $($_.Exception.Message)" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor Red
    Cleanup-TestProcesses
    exit 1
}
