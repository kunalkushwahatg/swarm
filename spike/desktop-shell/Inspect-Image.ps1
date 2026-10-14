Add-Type -AssemblyName System.Drawing
$file = "artifacts\spike_screenshots\tauri_spike_live_window.png"
if (Test-Path $file) {
    $img = [System.Drawing.Image]::FromFile($file)
    Write-Host "Width: $($img.Width), Height: $($img.Height)"
    $img.Dispose()
} else {
    Write-Host "File not found: $file"
}
