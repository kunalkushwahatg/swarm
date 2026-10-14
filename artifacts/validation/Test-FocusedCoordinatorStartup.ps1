# Test-FocusedCoordinatorStartup.ps1
# Tests coordinator startup using the exact updated Invoke-Milestone12Validation.ps1 logic
$ErrorActionPreference = "Stop"
$WorkspaceRoot = "C:\Users\kunal\OneDrive\Desktop\swarm"
$coordinatorBin = Join-Path $WorkspaceRoot "build-cuda\swarm_node.exe"
$modelPath = Join-Path $WorkspaceRoot "models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf"
$RemoteWorkerEndpoint = "192.168.137.1:50052"
$TokenFile = ".\secrets\m12_telemetry_token.txt"
$GpuLayers = 4

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Testing Focused Coordinator Startup & Production Auth" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Compile asynchronous stream logger if not already loaded
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

# 2. Token preflight check and absolute path resolution
Write-Host "`n[Check 1] Preflight token validation and path resolution..." -ForegroundColor Yellow
if (-not (Test-Path $TokenFile)) {
    Write-Error "[PREFLIGHT ERROR] Specified -TokenFile does not exist: $TokenFile"
    exit 1
}

$TokenFile = (Resolve-Path $TokenFile).Path
$tokenItem = Get-Item $TokenFile -ErrorAction Stop
if ($tokenItem.Length -eq 0) {
    Write-Error "[PREFLIGHT ERROR] Telemetry token file is empty (0 bytes): $TokenFile"
    exit 1
}
Write-Host "  PASS: Token file exists and is non-empty ($($tokenItem.Length) bytes)." -ForegroundColor Green
Write-Host "  PASS: Resolved absolute path: $TokenFile" -ForegroundColor Green

# 3. Prepare child process environment
$coordEnv = @{
    "SWARM_USE_RPC" = "1"
    "SWARM_RPC_ENDPOINTS" = $RemoteWorkerEndpoint
    "SWARM_MODEL_PATH" = $modelPath
    "SWARM_N_GPU_LAYERS" = $GpuLayers.ToString()
    "SWARM_DEPLOYMENT_ENV" = "production"
    "SWARM_TELEMETRY_TOKEN_FILE" = $TokenFile
    "SWARM_PLACEMENT_POLICY" = "dynamic"
    "PATH" = "$WorkspaceRoot\build-cuda;$WorkspaceRoot\build-cuda\bin;$env:PATH"
}

$logDir = Join-Path $WorkspaceRoot "artifacts\validation"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$stdoutLog = Join-Path $logDir "m12_coordinator.stdout.log"
$stderrLog = Join-Path $logDir "m12_coordinator.stderr.log"
if (Test-Path $stdoutLog) { Remove-Item $stdoutLog -Force }
if (Test-Path $stderrLog) { Remove-Item $stderrLog -Force }

# 4. ProcessStartInfo configuration
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $coordinatorBin
$startInfo.WorkingDirectory = (Join-Path $WorkspaceRoot "build-cuda")
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true

foreach ($key in $coordEnv.Keys) {
    $startInfo.EnvironmentVariables[$key] = $coordEnv[$key]
}

# 5. Launch coordinator
Write-Host "`n[Check 2] Launching Coordinator child process..." -ForegroundColor Yellow
$coordProc = New-Object System.Diagnostics.Process
$coordProc.StartInfo = $startInfo
$coordProc.Start() | Out-Null
[ProcessStreamLogger]::Attach($coordProc, $stdoutLog, $stderrLog)
Write-Host "  Coordinator running with PID $($coordProc.Id)" -ForegroundColor Green

$ready = $false
try {
    Write-Host "`n[Check 3] Waiting for Coordinator Health on http://127.0.0.1:8080/health..." -ForegroundColor Yellow
    for ($i = 0; $i -lt 30; $i++) {
        if ($coordProc.HasExited) {
            Start-Sleep -Milliseconds 200
            $errContent = if (Test-Path $stderrLog) { Get-Content $stderrLog -Raw } else { "" }
            Write-Error "Coordinator process exited prematurely with code $($coordProc.ExitCode). Stderr:`n$errContent"
            exit 1
        }
        Start-Sleep -Seconds 1
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($resp.status -eq "ok" -or $resp.status -eq "degraded") {
                $ready = $true
                Write-Host "  Coordinator health status: $($resp.status) (within $i seconds)!" -ForegroundColor Green
                break
            }
        } catch {}
    }

    if (-not $ready) {
        Write-Error "Coordinator failed to initialize within 30 seconds."
        exit 1
    }

    # 6. Verify security in stdout logs
    Start-Sleep -Milliseconds 500
    $stdoutText = if (Test-Path $stdoutLog) { Get-Content $stdoutLog -Raw } else { "" }
    if ($stdoutText -match "Deployment Environment: PRODUCTION" -and $stdoutText -match "Telemetry Auth: ENABLED") {
        Write-Host "`n[Check 4] Production Security Preflight in Logs:" -ForegroundColor Yellow
        Write-Host "  PASS: 'Deployment Environment: PRODUCTION' confirmed." -ForegroundColor Green
        Write-Host "  PASS: 'Telemetry Auth: ENABLED' confirmed." -ForegroundColor Green
    } else {
        Write-Error "Did not find expected production telemetry log lines in $stdoutLog"
        exit 1
    }

    # 7. Check backend placements
    $backends = Invoke-RestMethod -Uri "http://127.0.0.1:8080/backends"
    Write-Host "`n[Check 5] Backend Placements:" -ForegroundColor Yellow
    foreach ($dev in $backends.devices) {
        Write-Host "  Device: $($dev.name) | Type: $($dev.backend_type) | Layers: $($dev.assigned_layers_count)"
    }
}
finally {
    Write-Host "`n[Check 6] Cleaning up test coordinator process..." -ForegroundColor Yellow
    if ($coordProc -and -not $coordProc.HasExited) {
        $coordProc.Kill()
        $coordProc.WaitForExit(3000)
    }
    Write-Host "  Coordinator PID $($coordProc.Id) cleaned up." -ForegroundColor Green
}

Write-Host "`n==========================================================" -ForegroundColor Green
Write-Host "  FOCUSED COORDINATOR STARTUP TEST: ALL CHECKS PASSED!" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
