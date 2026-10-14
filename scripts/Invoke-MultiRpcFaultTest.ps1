[CmdletBinding()]
param(
    [string]$ProjectRoot = "C:\Users\kunal\OneDrive\Desktop\swarm",
    [int]$RpcPort0 = 50052,
    [int]$RpcPort1 = 50053,
    [int]$HttpPort = 8080,
    [int]$ReadinessTimeoutSeconds = 60,
    [int]$FailureTimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'

$artifactRoot = Join-Path $ProjectRoot 'artifacts\validation\2026-10-10\fault-handling'
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null

$rpcExe = Join-Path $ProjectRoot 'temp_rpc_build\bin\ggml-rpc-server.exe'
$swarmExe = Join-Path $ProjectRoot 'build-cuda\swarm_node.exe'
$modelPath = Join-Path $ProjectRoot 'models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf'
$pathEntries = @(
    (Join-Path $ProjectRoot 'build-cuda\bin'),
    (Join-Path $ProjectRoot 'temp_rpc_build\bin')
)

$startedPids = [System.Collections.Generic.List[int]]::new()
$rpc0 = $null
$rpc1 = $null
$swarm = $null

function Write-Record {
    param(
        [string]$Name,
        [object]$Value
    )

    $Value | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (
        Join-Path $artifactRoot "$Name.json"
    )
}

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
        [string]$Name
    )

    $stdout = Join-Path $artifactRoot "$Name.stdout.log"
    $stderr = Join-Path $artifactRoot "$Name.stderr.log"
    $process = Start-Process -FilePath $rpcExe `
        -ArgumentList '--host', '127.0.0.1', '--port', $Port, '--threads', '2' `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -PassThru
    $startedPids.Add([int]$process.Id)

    Wait-Until {
        $listener = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object {
                $_.LocalAddress -eq '127.0.0.1' -and
                $_.LocalPort -eq $Port -and
                $_.OwningProcess -eq $process.Id
            }
        $listener -ne $null
    } $ReadinessTimeoutSeconds "$Name did not own 127.0.0.1:$Port"

    return $process
}

function Stop-StartedProcess {
    param([System.Diagnostics.Process]$Process)

    if ($null -eq $Process) {
        return
    }

    $Process.Refresh()
    if (-not $Process.HasExited) {
        Stop-Process -Id ([int]$Process.Id)
    }
}

function Get-ExitRecord {
    param([System.Diagnostics.Process]$Process)

    if ($null -eq $Process) {
        return $null
    }

    $Process.Refresh()
    if (-not $Process.HasExited) {
        return [ordered]@{
            pid = $Process.Id
            exited = $false
            exit_code = $null
        }
    }

    return [ordered]@{
        pid = $Process.Id
        exited = $true
        exit_code = $Process.ExitCode
    }
}

function Get-StreamedContent {
    param([string]$Body)

    $pieces = [System.Collections.Generic.List[string]]::new()
    foreach ($line in ($Body -split '\r?\n')) {
        if (-not $line.StartsWith('data: ')) {
            continue
        }

        $payload = $line.Substring(6)
        if ($payload -eq '[DONE]') {
            continue
        }

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

function Get-SwarmCrashEvent {
    param([int]$ProcessId)

    $processHex = ('0x{0:X}' -f $ProcessId)
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        $events = Get-WinEvent -FilterHashtable @{
            LogName = 'Application'
            ProviderName = 'Application Error'
            StartTime = (Get-Date).AddMinutes(-2)
        } -ErrorAction SilentlyContinue

        foreach ($event in $events) {
            if ($event.Message -match 'Faulting application name: swarm_node\.exe' -and
                $event.Message -match "Faulting process id: $processHex") {
                return [ordered]@{
                    time = $event.TimeCreated
                    event_id = $event.Id
                    message = $event.Message
                }
            }
        }
        Start-Sleep -Milliseconds 250
    }

    return $null
}

try {
    foreach ($port in @($RpcPort0, $RpcPort1, $HttpPort)) {
        if (-not (Test-PortFree $port)) {
            throw "Port $port is already occupied"
        }
    }

    foreach ($path in @($rpcExe, $swarmExe, $modelPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Required file is missing: $path"
        }
    }

    $env:PATH = (($pathEntries + $env:PATH) -join ';')
    $env:SWARM_USE_RPC = '1'
    $env:SWARM_RPC_ENDPOINTS = "127.0.0.1:$RpcPort0,127.0.0.1:$RpcPort1"
    $env:SWARM_MODEL_PATH = $modelPath
    $env:SWARM_N_GPU_LAYERS = '4'
    $env:SWARM_CTX_SIZE = '2048'
    $env:SWARM_MAX_TOKENS_DEFAULT = '16'
    $env:SWARM_HTTP_BIND = '127.0.0.1'
    $env:SWARM_HTTP_PORT = [string]$HttpPort

    $rpc0 = Start-RpcServer $RpcPort0 'rpc-50052'
    $rpc1 = Start-RpcServer $RpcPort1 'rpc-50053'

    $swarmStdout = Join-Path $artifactRoot 'harness-swarm.stdout.log'
    $swarmStderr = Join-Path $artifactRoot 'harness-swarm.stderr.log'
    $swarm = Start-Process -FilePath $swarmExe `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $swarmStdout `
        -RedirectStandardError $swarmStderr `
        -PassThru
    $startedPids.Add([int]$swarm.Id)

    $healthUri = "http://127.0.0.1:$HttpPort/health"
    Wait-Until {
        try {
            $health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 2
            return $health.model.loaded -and $health.context.created
        } catch {
            return $false
        }
    } $ReadinessTimeoutSeconds 'Swarm model/context did not become ready'

    $request = @{
        messages = @(@{
            role = 'user'
            content = 'What is 2 + 2?'
        })
        max_tokens = 16
        temperature = 0
        stream = $false
    } | ConvertTo-Json -Depth 5 -Compress

    $response = Invoke-WebRequest -UseBasicParsing -Method Post `
        -Uri "http://127.0.0.1:$HttpPort/v1/chat/completions" `
        -ContentType 'application/json' -Body $request -TimeoutSec 90
    $response.Content | Set-Content -Encoding utf8 (
        Join-Path $artifactRoot 'harness-before-failure.response.txt'
    )
    $baselineText = Get-StreamedContent $response.Content
    if ($baselineText -notmatch '2\s*\+\s*2\s*(equals|is)\s*4') {
        throw "The baseline inference response was not correct: $baselineText"
    }

    Wait-Until {
        if (-not (Test-Path -LiteralPath $swarmStderr)) {
            return $false
        }
        $log = Get-Content -Raw -LiteralPath $swarmStderr
        return $log -match 'RPC0\[127\.0\.0\.1:50052\].*model buffer' -and
            $log -match 'RPC0\[127\.0\.0\.1:50053\].*model buffer'
    } $ReadinessTimeoutSeconds 'Both RPC devices did not show model-buffer allocation'

    $allocationEvidence = [ordered]@{
        rpc0_model_buffer = $true
        rpc1_model_buffer = $true
        log = $swarmStderr
    }
    Write-Record 'allocation-evidence' $allocationEvidence

    Stop-StartedProcess $rpc1
    $rpc1 = $null

    $failureResponse = [ordered]@{
        request = 'not sent yet'
        outcome = $null
        error = $null
    }
    try {
        $failureResponse.request = 'sent'
        $failureResponse.outcome = (Invoke-WebRequest -UseBasicParsing -Method Post `
            -Uri "http://127.0.0.1:$HttpPort/v1/chat/completions" `
            -ContentType 'application/json' -Body $request `
            -TimeoutSec $FailureTimeoutSeconds).Content
    } catch {
        $failureResponse.outcome = 'request_failed'
        $failureResponse.error = $_.Exception.Message
    }
    Write-Record 'harness-after-failure' $failureResponse

    $swarmExited = $false
    $deadline = (Get-Date).AddSeconds($FailureTimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $swarm.Refresh()
        if ($swarm.HasExited) {
            $swarmExited = $true
            break
        }
        Start-Sleep -Milliseconds 250
    }

    $failureRecord = [ordered]@{
        swarm = Get-ExitRecord $swarm
        windows_application_error = if ($swarmExited) {
            Get-SwarmCrashEvent ([int]$swarm.Id)
        } else {
            $null
        }
        rpc0 = Get-ExitRecord $rpc0
        rpc1_stopped = $true
        response = $failureResponse
        rpc0_listener = -not (Test-PortFree $RpcPort0)
        rpc1_listener = -not (Test-PortFree $RpcPort1)
        http_listener = -not (Test-PortFree $HttpPort)
        swarm_exited_within_timeout = $swarmExited
    }
    Write-Record 'harness-failure-result' $failureRecord

    if (-not $swarmExited) {
        Write-Warning 'Swarm remained alive after the failed request; inspect the failure response and logs.'
    }

    Write-Output ($failureRecord | ConvertTo-Json -Depth 8)
} finally {
    Stop-StartedProcess $swarm
    Stop-StartedProcess $rpc0
    Stop-StartedProcess $rpc1

    $released = [ordered]@{}
    foreach ($port in @($RpcPort0, $RpcPort1, $HttpPort)) {
        $released["$port"] = Test-PortFree $port
    }
    Write-Record 'ports-released' $released
}
