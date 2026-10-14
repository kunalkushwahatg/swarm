# Test-HotspotTcpReachability.ps1 - Temporary Standalone TCP Reachability Test
# Listens briefly on a designated port to verify Computer B -> Computer A TCP connectivity.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [int]$Port = 58080,

    [Parameter(Mandatory=$false)]
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Swarm Hotspot TCP Reachability Diagnostic Listener" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Listening on: 0.0.0.0:$Port" -ForegroundColor Yellow
Write-Host "Timeout:      $TimeoutSeconds seconds" -ForegroundColor Yellow
Write-Host "`nOn Computer B (192.168.137.1), run this command now:" -ForegroundColor Cyan
Write-Host "  Test-NetConnection -ComputerName 192.168.137.174 -Port $Port" -ForegroundColor White
Write-Host "----------------------------------------------------------" -ForegroundColor Gray

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $Port)

try {
    $listener.Start()
    Write-Host "[WAITING] Waiting for inbound TCP connection from Computer B..." -ForegroundColor Yellow

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $connected = $false

    while ($stopwatch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        if ($listener.Pending()) {
            $client = $listener.AcceptTcpClient()
            $remoteEndpoint = $client.Client.RemoteEndPoint.ToString()
            Write-Host "`n[SUCCESS] Inbound TCP connection accepted from: $remoteEndpoint" -ForegroundColor Green

            # Send brief greeting
            $stream = $client.GetStream()
            $writer = New-Object System.IO.StreamWriter($stream, [System.Text.Encoding]::ASCII)
            $writer.WriteLine("SWARM_TCP_PROBE_ACK")
            $writer.Flush()
            $client.Close()

            $connected = $true
            break
        }
        Start-Sleep -Milliseconds 250
    }

    if (-not $connected) {
        Write-Host "`n[TIMEOUT] No connection received within $TimeoutSeconds seconds." -ForegroundColor Red
        exit 1
    } else {
        exit 0
    }
}
finally {
    $listener.Stop()
    Write-Host "Listener closed and port $Port released cleanly." -ForegroundColor Gray
}
