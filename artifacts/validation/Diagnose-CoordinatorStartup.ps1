# Diagnose-CoordinatorStartup.ps1
$ErrorActionPreference = "Stop"
$WorkspaceRoot = "C:\Users\kunal\OneDrive\Desktop\swarm"
$artifactDir = Join-Path $WorkspaceRoot "artifacts\validation"
if (-not (Test-Path $artifactDir)) { New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null }

$stdoutFile = Join-Path $artifactDir "m12_diag_stdout.log"
$stderrFile = Join-Path $artifactDir "m12_diag_stderr.log"
if (Test-Path $stdoutFile) { Remove-Item $stdoutFile -Force }
if (Test-Path $stderrFile) { Remove-Item $stderrFile -Force }

$env:SWARM_USE_RPC = "1"
$env:SWARM_RPC_ENDPOINTS = "192.168.137.1:50052"
$env:SWARM_MODEL_PATH = "$WorkspaceRoot\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf"
$env:SWARM_N_GPU_LAYERS = "4"
$env:SWARM_DEPLOYMENT_ENV = "production"
$env:SWARM_TELEMETRY_TOKEN_FILE = "$WorkspaceRoot\secrets\m12_telemetry_token.txt"
$env:SWARM_PLACEMENT_POLICY = "dynamic"
$env:PATH = "$WorkspaceRoot\build-cuda;$WorkspaceRoot\build-cuda\bin;$env:PATH"

Write-Host "Starting diagnostic coordinator launch..."
$proc = Start-Process -FilePath "$WorkspaceRoot\build-cuda\swarm_node.exe" `
    -WorkingDirectory "$WorkspaceRoot\build-cuda" `
    -RedirectStandardOutput $stdoutFile `
    -RedirectStandardError $stderrFile `
    -PassThru

Write-Host "Diagnostic Coordinator PID: $($proc.Id)"

$ready = $false
for ($i = 0; $i -lt 15; $i++) {
    if ($proc.HasExited) {
        Write-Host "Process exited early with ExitCode: $($proc.ExitCode)"
        break
    }
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($resp.status -eq "ok" -or $resp.status -eq "degraded") {
            $ready = $true
            Write-Host "Coordinator became healthy within $i seconds!"
            break
        }
    } catch {}
    Start-Sleep -Seconds 1
}

Write-Host "Cleaning up diagnostic coordinator process..."
if (-not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    $proc.WaitForExit(3000)
}

Write-Host "Diagnostic Coordinator run finished. Output logs saved to:"
Write-Host "  $stdoutFile"
Write-Host "  $stderrFile"
