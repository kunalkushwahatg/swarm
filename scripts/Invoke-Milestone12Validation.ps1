# Invoke-Milestone12Validation.ps1 - Physical Multi-Device Inference Validation Suite
# Validates Swarm coordinator (Computer A) communicating with remote worker (Computer B)
[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [string]$RemoteWorkerEndpoint = "",

    [Parameter(Mandatory=$false)]
    [string]$TokenFile = "",

    [Parameter(Mandatory=$false)]
    [int]$GpuLayers = 4,

    [Parameter(Mandatory=$false)]
    [int]$HeadroomRamMb = 512,

    [Parameter(Mandatory=$false)]
    [string]$PlacementPolicy = "dynamic"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkspaceRoot = (Get-Item $ScriptDir).Parent.FullName

function Get-StreamedContent([string]$RawBody) {
    if ([string]::IsNullOrWhiteSpace($RawBody)) {
        return ""
    }
    $tokens = [System.Collections.Generic.List[string]]::new()
    foreach ($line in ($RawBody -split "`r?`n")) {
        $trimmed = $line.Trim()
        if ($trimmed.StartsWith("data: ")) {
            $data = $trimmed.Substring(6).Trim()
            if ($data -eq "[DONE]") { break }
            try {
                $j = $data | ConvertFrom-Json
                if ($j -and $j.choices -and $j.choices.Count -gt 0) {
                    $choice = $j.choices[0]
                    if ($choice.delta -and $choice.delta.content) {
                        $tokens.Add([string]$choice.delta.content)
                    } elseif ($choice.message -and $choice.message.content) {
                        $tokens.Add([string]$choice.message.content)
                    }
                }
            } catch {}
        }
    }
    return ($tokens -join "")
}

function Parse-InferenceResponse([string]$RawContent) {
    if ([string]::IsNullOrWhiteSpace($RawContent)) {
        return @{ Success = $false; Error = "Empty or null response body received from coordinator" }
    }

    # 1. Try Server-Sent Events (SSE) streaming format (standard Swarm gateway output)
    $streamed = Get-StreamedContent -RawBody $RawContent
    if (-not [string]::IsNullOrWhiteSpace($streamed)) {
        return @{ Success = $true; Text = $streamed; Format = "SSE" }
    }

    # 2. Try single JSON payload format
    try {
        $json = $RawContent | ConvertFrom-Json
        if ($json -and $json.error) {
            $errMsg = if ($json.error.message) { $json.error.message } else { [string]$json.error }
            return @{ Success = $false; Error = "Coordinator returned API error: $errMsg" }
        }
        if ($json -and $json.choices -and $json.choices.Count -gt 0) {
            $choice = $json.choices[0]
            $content = if ($choice.message -and $choice.message.content) {
                [string]$choice.message.content
            } elseif ($choice.text) {
                [string]$choice.text
            } else {
                ""
            }
            if (-not [string]::IsNullOrWhiteSpace($content)) {
                return @{ Success = $true; Text = $content; Format = "JSON" }
            }
        }
    } catch {
        return @{ Success = $false; Error = "Failed to parse response payload as JSON or SSE: $_" }
    }

    return @{ Success = $false; Error = "No completion text found in coordinator response" }
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Swarm Milestone 12 - Physical Multi-Device Validation" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# Baseline check
$modelPath = Join-Path $WorkspaceRoot "models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf"
$coordinatorBin = Join-Path $WorkspaceRoot "build-cuda\swarm_node.exe"

if (-not (Test-Path $modelPath)) {
    Write-Error "Official model not found at $modelPath"
    exit 1
}
if (-not (Test-Path $coordinatorBin)) {
    Write-Error "Coordinator binary not found at $coordinatorBin"
    exit 1
}

if ([string]::IsNullOrWhiteSpace($RemoteWorkerEndpoint)) {
    Write-Host ""
    Write-Host "[MILESTONE 12 STATUS: BLOCKED / NO REMOTE WORKER SPECIFIED]" -ForegroundColor Yellow
    Write-Host "No remote worker endpoint was provided (-RemoteWorkerEndpoint <IP:Port>)."
    Write-Host "A second physical computer must be online and running Start-RemoteWorker.ps1 to execute physical inference."
    Write-Host ""
    Write-Host "Deployment Package Prepared:" -ForegroundColor Green
    Write-Host "  Package: $WorkspaceRoot\dist\swarm-computer-b-transfer.zip"
    Write-Host "  Copy this package to Computer B and run Start-RemoteWorker.ps1."
    Write-Host ""
    Write-Host "Coordinator Command when Computer B is ready:" -ForegroundColor Cyan
    Write-Host "  .\scripts\Invoke-Milestone12Validation.ps1 -RemoteWorkerEndpoint <Computer_B_IP:50052> -TokenFile .\secrets\m12_telemetry_token.txt"
    exit 2
}

# Parse host and port
$parts = $RemoteWorkerEndpoint.Split(":")
$workerHost = $parts[0]
$workerPort = 50052
if ($parts.Length -gt 1) {
    $workerPort = [int]$parts[1]
}

# Strict guard: Remote worker must NOT be loopback
if ($workerHost -eq "127.0.0.1" -or $workerHost -eq "localhost" -or $workerHost -eq "::1") {
    Write-Host "[VALIDATION REJECTED] RemoteWorkerEndpoint '$RemoteWorkerEndpoint' is a loopback address!" -ForegroundColor Red
    Write-Host "Milestone 12 requires a physically distinct computer. Loopback cannot be accepted." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "[Step 1] Verifying Network Reachability to $workerHost on port $workerPort..." -ForegroundColor Yellow
$tcpCheck = Test-NetConnection -ComputerName $workerHost -Port $workerPort -WarningAction SilentlyContinue
if (-not $tcpCheck.TcpTestSucceeded) {
    Write-Host "[ERROR] Could not establish TCP connection to $workerHost on port $workerPort" -ForegroundColor Red
    Write-Host "Ensure Computer B is powered on, Start-RemoteWorker.ps1 is running, and firewall port $workerPort is open."
    exit 1
}
Write-Host "  TCP reachability verified! Remote worker RPC port is listening." -ForegroundColor Green

# Compile asynchronous stream logger if not already loaded in current session
if (-not ([System.Management.Automation.PSTypeName]'ProcessStreamLogger').Type) {
    Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Diagnostics;

public class ProcessStreamLogger {
    private static readonly object _outLock = new object();
    private static readonly object _errLock = new object();

    public static void Attach(Process proc, string stdoutFile, string stderrFile) {
        proc.OutputDataReceived += (sender, args) => {
            if (args.Data != null) {
                lock (_outLock) {
                    File.AppendAllText(stdoutFile, args.Data + Environment.NewLine);
                }
            }
        };
        proc.ErrorDataReceived += (sender, args) => {
            if (args.Data != null) {
                lock (_errLock) {
                    File.AppendAllText(stderrFile, args.Data + Environment.NewLine);
                }
            }
        };
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();
    }
}
"@
}

# Prepare and strictly validate telemetry token file (Milestone 11/12 fail-secure preflight)
if ([string]::IsNullOrWhiteSpace($TokenFile)) {
    $defaultSecret = Join-Path $WorkspaceRoot "secrets\m12_telemetry_token.txt"
    if (Test-Path $defaultSecret) {
        $TokenFile = $defaultSecret
    } else {
        Write-Error "[PREFLIGHT ERROR] No -TokenFile specified and default secret does not exist at: $defaultSecret"
        exit 1
    }
}

if (-not (Test-Path $TokenFile)) {
    Write-Error "[PREFLIGHT ERROR] Specified -TokenFile does not exist: $TokenFile"
    exit 1
}

# Resolve to full absolute path to ensure child process in build-cuda working directory locates it
$TokenFile = (Resolve-Path $TokenFile).Path

# Verify non-empty file
$tokenItem = Get-Item $TokenFile -ErrorAction Stop
if ($tokenItem.Length -eq 0) {
    Write-Error "[PREFLIGHT ERROR] Telemetry token file is empty (0 bytes): $TokenFile"
    exit 1
}
Write-Host "  Telemetry token file verified: $TokenFile ($($tokenItem.Length) bytes)" -ForegroundColor Green

Write-Host ""
Write-Host "[Step 2] Launching Coordinator connected to Remote Worker..." -ForegroundColor Yellow
$coordEnv = @{
    "SWARM_USE_RPC" = "1"
    "SWARM_RPC_ENDPOINTS" = $RemoteWorkerEndpoint
    "SWARM_MODEL_PATH" = $modelPath
    "SWARM_N_GPU_LAYERS" = $GpuLayers.ToString()
    "SWARM_DEPLOYMENT_ENV" = "production"
    "SWARM_TELEMETRY_TOKEN_FILE" = $TokenFile
    "SWARM_PLACEMENT_POLICY" = $PlacementPolicy
    "SWARM_RESERVED_HEADROOM_RAM_MB" = $HeadroomRamMb.ToString()
    "SWARM_HEADROOM_RAM_MB" = $HeadroomRamMb.ToString()
    "PATH" = "$WorkspaceRoot\build-cuda;$WorkspaceRoot\build-cuda\bin;$env:PATH"
}

$logDir = Join-Path $WorkspaceRoot "artifacts\validation"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$stdoutLog = Join-Path $logDir "m12_coordinator.stdout.log"
$stderrLog = Join-Path $logDir "m12_coordinator.stderr.log"
if (Test-Path $stdoutLog) { Remove-Item $stdoutLog -Force }
if (Test-Path $stderrLog) { Remove-Item $stderrLog -Force }

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $coordinatorBin
$startInfo.WorkingDirectory = (Join-Path $WorkspaceRoot "build-cuda")
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true

foreach ($key in $coordEnv.Keys) {
    $startInfo.EnvironmentVariables[$key] = $coordEnv[$key]
}

$coordProc = New-Object System.Diagnostics.Process
$coordProc.StartInfo = $startInfo
$coordProc.Start() | Out-Null
[ProcessStreamLogger]::Attach($coordProc, $stdoutLog, $stderrLog)

Write-Host "  Coordinator running with PID $($coordProc.Id)"
Write-Host "  Logs redirecting to: $stdoutLog and $stderrLog"

$inferenceSuccess = $false
$statusReport = [ordered]@{
    "RemoteNodeDiscovered"        = $false
    "InferenceSubmitted"          = $false
    "InferenceCompleted"          = $false
    "RemoteRpcLayersAssigned"     = 0
    "RemoteParticipationVerified" = $false
}

$rawRespFile = Join-Path $logDir "m12_inference_response.raw.txt"
$backendsFile = Join-Path $logDir "m12_backends.json"

try {
    Write-Host ""
    Write-Host "[Step 3] Waiting for Coordinator Health and Remote Worker Discovery..." -ForegroundColor Yellow
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        if ($coordProc.HasExited) {
            $errContent = if (Test-Path $stderrLog) { Get-Content $stderrLog -Raw } else { "" }
            Write-Error "Coordinator process exited prematurely with code $($coordProc.ExitCode). Stderr:`n$errContent"
            exit 1
        }
        Start-Sleep -Seconds 1
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($resp.status -eq "ok" -or $resp.status -eq "degraded") {
                $ready = $true
                break
            }
        } catch {}
    }

    if (-not $ready) {
        Write-Error "Coordinator failed to initialize within 30 seconds."
        exit 1
    }
    Write-Host "  Coordinator is healthy and listening on port 8080." -ForegroundColor Green

    Write-Host ""
    Write-Host "[Step 4] Checking Node Inventory for Physical Remote Worker..." -ForegroundColor Yellow
    $nodes = Invoke-RestMethod -Uri "http://127.0.0.1:8080/nodes"
    Write-Host "  Total Nodes in Cluster: $($nodes.cluster_summary.total_nodes)"
    Write-Host "  Remote Nodes:           $($nodes.cluster_summary.remote_nodes)"

    # Verify remote node is present and is NOT loopback
    $remoteNodeFound = $false
    foreach ($n in $nodes.nodes) {
        if ($n.is_loopback -eq $false) {
            $remoteNodeFound = $true
            $statusReport["RemoteNodeDiscovered"] = $true
            Write-Host "  Verified Remote Node: $($n.node_id) | Role: $($n.role) | Endpoint: $($n.endpoint) | Reported: $($n.agent_reported)" -ForegroundColor Green
        }
    }

    if (-not $remoteNodeFound) {
        Write-Error "No non-loopback remote nodes found in cluster inventory!"
        exit 1
    }

    Write-Host ""
    Write-Host "[Step 5] Executing Remote Multi-Device Inference Request..." -ForegroundColor Yellow
    $body = @{
        messages = @(
            @{ role = "user"; content = "Define distributed computing in one sentence." }
        )
        max_tokens = 40
        temperature = 0.1
        stream = $false
    } | ConvertTo-Json -Depth 4

    $statusReport["InferenceSubmitted"] = $true
    $t0 = [System.Diagnostics.Stopwatch]::StartNew()
    $rawResponseText = $null
    $httpStatusCode = $null

    try {
        $httpResp = Invoke-WebRequest -Uri "http://127.0.0.1:8080/v1/chat/completions" `
            -Method Post `
            -ContentType "application/json" `
            -Body $body `
            -TimeoutSec 60 `
            -UseBasicParsing
        $t0.Stop()
        $httpStatusCode = $httpResp.StatusCode
        $rawResponseText = $httpResp.Content
    } catch {
        $t0.Stop()
        if ($_.Exception.Response) {
            $httpStatusCode = [int]$_.Exception.Response.StatusCode
            $stream = $_.Exception.Response.GetResponseStream()
            if ($stream) {
                $reader = New-Object System.IO.StreamReader($stream)
                $rawResponseText = $reader.ReadToEnd()
            }
        }
        $errLog = Join-Path $logDir "m12_inference_error.raw.txt"
        if ($rawResponseText) {
            [System.IO.File]::WriteAllText($errLog, $rawResponseText)
        }
        Write-Error "HTTP request to /v1/chat/completions failed (HTTP $httpStatusCode): $_"
        exit 1
    }

    if ($rawResponseText) {
        [System.IO.File]::WriteAllText($rawRespFile, $rawResponseText)
    }

    $parsed = Parse-InferenceResponse -RawContent $rawResponseText
    if (-not $parsed.Success) {
        Write-Error "Failed to parse inference response: $($parsed.Error)"
        exit 1
    }

    $generatedText = $parsed.Text
    $statusReport["InferenceCompleted"] = $true
    Write-Host ""
    Write-Host "Generated Response ($($t0.ElapsedMilliseconds) ms, Format: $($parsed.Format)):" -ForegroundColor Cyan
    Write-Host "  `"$generatedText`"" -ForegroundColor White

    # Check backends and preserve raw response
    Write-Host ""
    Write-Host "Checking /backends for physical device placement..." -ForegroundColor Yellow
    $backendsRaw = $null
    try {
        $backendsRaw = (Invoke-WebRequest -Uri "http://127.0.0.1:8080/backends" -TimeoutSec 10 -UseBasicParsing).Content
        [System.IO.File]::WriteAllText($backendsFile, $backendsRaw)
    } catch {
        Write-Error "Failed to query /backends endpoint: $_"
        exit 1
    }

    $backends = $null
    try {
        $backends = $backendsRaw | ConvertFrom-Json
    } catch {
        Write-Error "Failed to parse /backends response as JSON: $_"
        exit 1
    }

    Write-Host "Backend Placements:" -ForegroundColor Yellow
    $remoteRpcLayers = 0
    $backendList = if ($backends.backends) { $backends.backends } elseif ($backends.devices) { $backends.devices } else { @() }
    if ($backendList -and ($backendList.Count -gt 0 -or $backendList.Length -gt 0)) {
        foreach ($dev in $backendList) {
            $devName = if ($dev.device_name) { $dev.device_name } elseif ($dev.name) { $dev.name } elseif ($dev.backend_id) { $dev.backend_id } else { "unknown" }
            $devType = if ($dev.backend_type) { $dev.backend_type } else { "unknown" }
            $devLayers = if ($dev.assigned_layers) {
                $dev.assigned_layers.Count
            } elseif ($null -ne $dev.assigned_layers_count) {
                [int]$dev.assigned_layers_count
            } else {
                0
            }
            Write-Host "  Device: $devName | Type: $devType | Layers: $devLayers"

            if ($devType -eq "remote_rpc") {
                $remoteRpcLayers += $devLayers
            }
        }
    } else {
        Write-Host "  [WARN] No backends found in /backends response!" -ForegroundColor Yellow
    }

    $statusReport["RemoteRpcLayersAssigned"] = $remoteRpcLayers
    if ($remoteRpcLayers -gt 0) {
        $statusReport["RemoteParticipationVerified"] = $true
        Write-Host "  Confirmed: Remote physical worker participated in tensor computation ($remoteRpcLayers layers)!" -ForegroundColor Green
        $inferenceSuccess = $true
    } else {
        Write-Host "  [VERIFICATION FAILURE] Remote RPC backend has 0 assigned layers!" -ForegroundColor Red
        Write-Host "  The physical remote worker did not participate in tensor computation." -ForegroundColor Red
        $inferenceSuccess = $false
    }
}
finally {
    Write-Host ""
    Write-Host "[Step 6] Cleaning up Coordinator..." -ForegroundColor Yellow
    if ($coordProc -and -not $coordProc.HasExited) {
        $coordProc.Kill()
        $coordProc.WaitForExit(3000) | Out-Null
    }
}

Write-Host ""
Write-Host "--- Milestone 12 Verification Summary ---" -ForegroundColor Cyan
foreach ($key in $statusReport.Keys) {
    Write-Host ("  {0,-30} : {1}" -f $key, $statusReport[$key])
}

if ($inferenceSuccess) {
    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host "  MILESTONE 12 PHYSICAL INFERENCE VALIDATION: SUCCESS!" -ForegroundColor Green
    Write-Host "==========================================================" -ForegroundColor Green
    exit 0
} else {
    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor Red
    Write-Host "  MILESTONE 12 PHYSICAL INFERENCE VALIDATION: FAILED" -ForegroundColor Red
    Write-Host "==========================================================" -ForegroundColor Red
    exit 1
}
