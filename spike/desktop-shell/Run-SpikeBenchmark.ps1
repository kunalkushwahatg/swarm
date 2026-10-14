# Run-SpikeBenchmark.ps1
# Repeatable automated measurement and diagnostic capture for Phase C.1 Spike

[CmdletBinding()]
param(
    [int]$SettleSeconds = 8
)

$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkspaceRoot = (Get-Item $ScriptDir).Parent.Parent.FullName
$ExePath = Join-Path $ScriptDir "src-tauri\target\debug\app.exe"
$ArtifactsDir = Join-Path $WorkspaceRoot "artifacts\spike_screenshots"

if (-not (Test-Path $ArtifactsDir)) {
    New-Item -ItemType Directory -Path $ArtifactsDir -Force | Out-Null
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Swarm Phase C.1: Tauri Feasibility Spike Benchmark" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Host and Runtime Metadata
$osVersion = [System.Environment]::OSVersion.VersionString
$wv2Version = (Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue).pv
$rustVersion = (rustc --version)
$cargoVersion = (cargo --version)
$tauriCliVersion = "2.12.2"
$tauriCoreVersion = "2.12.3"

Write-Host "Host OS:           $osVersion" -ForegroundColor Gray
Write-Host "WebView2 Runtime:  $wv2Version" -ForegroundColor Gray
Write-Host "Rust Version:      $rustVersion" -ForegroundColor Gray
Write-Host "Tauri Core:        $tauriCoreVersion" -ForegroundColor Gray

# 2. Check Coordinator Reachability
$coordLive = $false
try {
    $healthCheck = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
    if ($healthCheck.status -eq "ok") {
        $coordLive = $true
        Write-Host "Coordinator:       ONLINE at 127.0.0.1:8080 (Inference Ready: $($healthCheck.inference.ready))" -ForegroundColor Green
    }
} catch {
    Write-Host "Coordinator:       OFFLINE at 127.0.0.1:8080" -ForegroundColor Yellow
}

# 3. Launch app.exe and measure launch-to-window latency
Write-Host "`nLaunching Tauri application: $ExePath" -ForegroundColor Cyan
$sw = [System.Diagnostics.Stopwatch]::StartNew()

$proc = Start-Process -FilePath $ExePath -WorkingDirectory $ScriptDir -PassThru

# Poll for main window handle
$windowVisibleMs = $null
for ($i = 0; $i -lt 50; $i++) {
    Start-Sleep -Milliseconds 50
    $p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne 0) {
        $windowVisibleMs = $sw.ElapsedMilliseconds
        break
    }
}

if (-not $windowVisibleMs) {
    $windowVisibleMs = $sw.ElapsedMilliseconds
}

Write-Host "Time to Window Interactive: ${windowVisibleMs} ms" -ForegroundColor Green

# 4. Settle Period
Write-Host "Settling for $SettleSeconds seconds to allow WebView2 render and automated diagnostics..." -ForegroundColor Yellow
Start-Sleep -Seconds $SettleSeconds

# 5. Capture Process Metrics
$appProcess = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
$appWsMb = if ($appProcess) { [Math]::Round($appProcess.WorkingSet64 / 1MB, 2) } else { 0 }
$appCpu = if ($appProcess) { $appProcess.CPU } else { 0 }

# Find child WebView2 processes
$wv2Processes = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $proc.Id -or ($_.Name -like "*msedgewebview2*" -and $_.CommandLine -like "*SwarmSpike*") }
$wv2List = @()
$totalWv2Ws = 0

foreach ($wp in $wv2Processes) {
    $pObj = Get-Process -Id $wp.ProcessId -ErrorAction SilentlyContinue
    if ($pObj) {
        $wsMb = [Math]::Round($pObj.WorkingSet64 / 1MB, 2)
        $totalWv2Ws += $wsMb
        $wv2List += @{
            "Id" = $wp.ProcessId
            "Name" = $wp.Name
            "WorkingSetMb" = $wsMb
        }
    }
}

$totalTreeWsMb = [Math]::Round($appWsMb + $totalWv2Ws, 2)

Write-Host "`nMemory Overhead Breakdown:" -ForegroundColor Cyan
Write-Host "  • Native Shell (app.exe):            $appWsMb MB (Target: <= 60 MB)" -ForegroundColor $(if ($appWsMb -le 60) { "Green" } else { "Yellow" })
Write-Host "  • WebView2 Helper Processes:         $totalWv2Ws MB ($($wv2List.Count) processes)" -ForegroundColor Gray
Write-Host "  • Total Combined Shell Tree:         $totalTreeWsMb MB" -ForegroundColor Gray

# 6. Capture Desktop Screen Showing Window
$screenshotPath = Join-Path $ArtifactsDir "tauri_spike_live_window.png"
try {
    $captureScript = Join-Path $ScriptDir "Capture-Window.ps1"
    & powershell -ExecutionPolicy Bypass -File $captureScript -ProcessName "app" -OutputPath $screenshotPath
    if (Test-Path $screenshotPath) {
        Write-Host "Screenshot captured: $screenshotPath" -ForegroundColor Green
    } else {
        Write-Warning "Screenshot file was not created by capture script"
    }
} catch {
    Write-Warning "Screenshot capture error: $_"
}

# Wait an additional 2 seconds if diagnostics are still writing
$diagPath = Join-Path $ScriptDir "diagnostic_results.json"
for ($w = 0; $w -lt 10; $w++) {
    if (Test-Path $diagPath) { break }
    Start-Sleep -Milliseconds 500
}

# 7. Close Application Cleanly
Write-Host "`nClosing Tauri spike process (PID $($proc.Id))..." -ForegroundColor Yellow
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# Check for lingering WebView2 processes
$lingering = Get-CimInstance Win32_Process | Where-Object { $_.Name -like "*msedgewebview2*" -and $_.CommandLine -like "*SwarmSpike*" }
foreach ($l in $lingering) {
    Stop-Process -Id $l.ProcessId -Force -ErrorAction SilentlyContinue
}

# 8. Assemble Results Object
$diagnostics = $null
if (Test-Path $diagPath) {
    try {
        $diagnostics = Get-Content $diagPath -Raw | ConvertFrom-Json
        Write-Host "Loaded frontend diagnostics: status=$($diagnostics.status)" -ForegroundColor Green
    } catch {
        Write-Warning "Failed to parse diagnostic_results.json: $_"
    }
}

$results = [ordered]@{
    "BenchmarkDate" = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    "Host" = @{
        "OS" = $osVersion
        "WebView2Runtime" = $wv2Version
        "Rust" = $rustVersion
        "TauriCore" = $tauriCoreVersion
        "TauriCli" = $tauriCliVersion
    }
    "Latency" = @{
        "LaunchToWindowInteractiveMs" = $windowVisibleMs
        "AcceptanceTargetMs" = 1200
        "Pass" = ($windowVisibleMs -le 1200)
    }
    "Memory" = @{
        "NativeShellWorkingSetMb" = $appWsMb
        "AcceptanceTargetMb" = 60
        "NativeShellPass" = ($appWsMb -le 60)
        "WebView2HelperCount" = $wv2List.Count
        "WebView2WorkingSetMb" = $totalWv2Ws
        "TotalCombinedTreeMb" = $totalTreeWsMb
    }
    "Coordinator" = @{
        "Online" = $coordLive
    }
    "Diagnostics" = $diagnostics
    "Artifacts" = @{
        "Screenshot" = $screenshotPath
    }
}

$resultsJsonPath = Join-Path $ScriptDir "benchmark_results.json"
$results | ConvertTo-Json -Depth 6 | Set-Content $resultsJsonPath -Force

Write-Host "Benchmark results saved to: $resultsJsonPath" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
