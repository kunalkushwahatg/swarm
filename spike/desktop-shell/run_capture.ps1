param(
    [string]$OutputName = "gate2_diagnostics_live_window.png"
)

$workspaceRoot = (Get-Item $PSScriptRoot).Parent.Parent.FullName
$appPath = Join-Path $PSScriptRoot "src-tauri\target\debug\app.exe"
$outDir = Join-Path $workspaceRoot "artifacts\spike_screenshots"
if (!(Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force }
$outPath = Join-Path $outDir $OutputName

Write-Host "Starting app from: $appPath"
$proc = Start-Process -FilePath $appPath -PassThru
Write-Host "App started with PID: $($proc.Id). Waiting 5 seconds for WebView2 render..."
Start-Sleep -Seconds 5

$captureScript = Join-Path $PSScriptRoot "Capture-Window.ps1"
Write-Host "Invoking $captureScript with OutputPath $outPath"
& $captureScript -ProcessName "app" -WindowTitle "Swarm Desktop" -OutputPath $outPath

Write-Host "Terminating app PID: $($proc.Id)"
Stop-Process -Id $proc.Id -Force
Write-Host "Capture completed: $outPath"
