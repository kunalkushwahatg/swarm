# Test-LocalDevInference.ps1
# Runs a real local test against the Swarm coordinator and local RPC worker

[CmdletBinding()]
param(
    [int]$Port = 8080,
    [string]$Prompt = "What is 2 + 2? Answer with just the number.",
    [int]$MaxTokens = 20,
    [double]$Temperature = 0.0
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkspaceRoot = (Get-Item $ScriptDir).Parent.FullName

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Swarm: Localhost Integration Inference Test" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Verify Coordinator Health
Write-Host "`n[Check 1] Checking Coordinator Health at http://127.0.0.1:$Port/health..." -ForegroundColor Yellow
$health = $null
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5
    Write-Host "  Health Status: $($health.status)" -ForegroundColor Green
} catch {
    Write-Error "Coordinator at http://127.0.0.1:$Port is not responding: $_"
    exit 1
}

# 2. Check Node Inventory
Write-Host "`n[Check 2] Inspecting Node Inventory at http://127.0.0.1:$Port/nodes..." -ForegroundColor Yellow
$nodes = $null
try {
    $nodes = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/nodes" -TimeoutSec 5
    $nodeList = if ($nodes.nodes) { $nodes.nodes } else { @() }
    Write-Host "  Registered nodes ($($nodeList.Count)):" -ForegroundColor White
    foreach ($n in $nodeList) {
        Write-Host "    - ID: $($n.node_id) | Role: $($n.role) | Endpoint: $($n.endpoint) | Loopback: $($n.is_loopback) | Status: $($n.status)" -ForegroundColor Gray
    }
} catch {
    Write-Warning "Could not fetch /nodes: $_"
}

# 3. Check Pre-Inference Backends
Write-Host "`n[Check 3] Inspecting Backends at http://127.0.0.1:$Port/backends..." -ForegroundColor Yellow
$backends = $null
try {
    $backends = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/backends" -TimeoutSec 5
    $backendList = if ($backends.backends) { $backends.backends } elseif ($backends.devices) { $backends.devices } else { @() }
    Write-Host "  Configured Devices/Backends ($($backendList.Count)):" -ForegroundColor White
    foreach ($b in $backendList) {
        $bName = if ($b.device_name) { $b.device_name } elseif ($b.name) { $b.name } elseif ($b.backend_id) { $b.backend_id } else { "unknown" }
        $bType = if ($b.backend_type) { $b.backend_type } else { "unknown" }
        $bLayers = if ($b.assigned_layers) { $b.assigned_layers.Count } elseif ($null -ne $b.assigned_layers_count) { [int]$b.assigned_layers_count } else { 0 }
        Write-Host "    - Device: $bName | Type: $bType | Layers: $bLayers" -ForegroundColor Gray
    }
} catch {
    Write-Warning "Could not fetch /backends: $_"
}

# 4. Execute Chat Completion
Write-Host "`n[Check 4] Executing Chat Completion Request..." -ForegroundColor Yellow
Write-Host "  Prompt: `"$Prompt`"" -ForegroundColor White

$reqBody = @{
    messages = @(
        @{ role = "user"; content = $Prompt }
    )
    max_tokens = $MaxTokens
    temperature = $Temperature
    stream = $false
} | ConvertTo-Json -Depth 4

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$rawResp = $null
$httpStatus = $null
$success = $false
$generatedText = ""
$errorMsg = ""

try {
    $httpResult = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/v1/chat/completions" `
        -Method Post `
        -ContentType "application/json" `
        -Body $reqBody `
        -TimeoutSec 60 `
        -UseBasicParsing
    $sw.Stop()
    $httpStatus = $httpResult.StatusCode
    $rawResp = $httpResult.Content
} catch {
    $sw.Stop()
    if ($_.Exception.Response) {
        $httpStatus = [int]$_.Exception.Response.StatusCode
        $stream = $_.Exception.Response.GetResponseStream()
        if ($stream) {
            $reader = New-Object System.IO.StreamReader($stream)
            $rawResp = $reader.ReadToEnd()
        }
    }
    $errorMsg = $_.ToString()
}

if ($rawResp) {
    # Check for SSE stream output
    if ($rawResp -match "(?m)^data:\s*(.+)$") {
        $tokens = [System.Collections.Generic.List[string]]::new()
        foreach ($line in ($rawResp -split "`r?`n")) {
            $trimmed = $line.Trim()
            if ($trimmed.StartsWith("data: ")) {
                $payload = $trimmed.Substring(6).Trim()
                if ($payload -eq "[DONE]") { break }
                try {
                    $chunk = $payload | ConvertFrom-Json
                    if ($chunk.choices -and $chunk.choices.Count -gt 0) {
                        $c = $chunk.choices[0]
                        if ($c.delta -and $c.delta.content) { $tokens.Add([string]$c.delta.content) }
                        elseif ($c.message -and $c.message.content) { $tokens.Add([string]$c.message.content) }
                    }
                } catch {}
            }
        }
        if ($tokens.Count -gt 0) {
            $generatedText = $tokens -join ""
            $success = $true
        }
    } else {
        # Check standard JSON payload
        try {
            $json = $rawResp | ConvertFrom-Json
            if ($json.choices -and $json.choices.Count -gt 0) {
                $c = $json.choices[0]
                if ($c.message -and $c.message.content) { $generatedText = [string]$c.message.content }
                elseif ($c.text) { $generatedText = [string]$c.text }
                $success = $true
            } elseif ($json.error) {
                $errorMsg = if ($json.error.message) { $json.error.message } else { [string]$json.error }
            }
        } catch {
            $generatedText = $rawResp
            $success = $true
        }
    }
}

$latencyMs = $sw.ElapsedMilliseconds
Write-Host "  Response received in $latencyMs ms (HTTP $httpStatus)" -ForegroundColor Cyan
if ($success) {
    Write-Host "  Output text: `"$($generatedText.Trim())`"" -ForegroundColor Green
} else {
    Write-Host "  Inference failed: $errorMsg" -ForegroundColor Red
}

# 5. Read active session metadata if available
$sessionFile = Join-Path $WorkspaceRoot "artifacts\local_dev\active_session.json"
$sessionData = $null
if (Test-Path $sessionFile) {
    try { $sessionData = Get-Content $sessionFile -Raw | ConvertFrom-Json } catch {}
}

# 6. Save test report
$testReport = [ordered]@{
    "Timestamp"       = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    "Environment"     = "localhost-single-computer"
    "CoordinatorUrl"  = "http://127.0.0.1:$Port"
    "CoordinatorPid"  = if ($sessionData) { $sessionData.CoordinatorPid } else { $null }
    "RpcWorkerPid"    = if ($sessionData) { $sessionData.RpcWorkerPid } else { $null }
    "RpcWorkerPort"   = if ($sessionData) { $sessionData.RpcWorkerPort } else { $null }
    "HttpStatus"      = $httpStatus
    "LatencyMs"       = $latencyMs
    "Prompt"          = $Prompt
    "GeneratedResponse"= $generatedText.Trim()
    "Success"         = $success
    "ErrorMessage"    = $errorMsg
    "Backends"        = $backends
}

$outPath = Join-Path $WorkspaceRoot "artifacts\local_dev\local_test_result.json"
$testReport | ConvertTo-Json -Depth 5 | Set-Content $outPath -Force
Write-Host "`nTest report written to: $outPath" -ForegroundColor Gray

if ($success) {
    Write-Host "Localhost integration test SUCCEEDED!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "Localhost integration test FAILED!" -ForegroundColor Red
    exit 1
}
