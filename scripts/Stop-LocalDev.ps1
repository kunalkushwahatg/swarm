# Stop-LocalDev.ps1
# Safe stop and cleanup script for single-computer Swarm local development

[CmdletBinding()]
param(
    [int]$Port = 8080,
    [int]$RpcPort = 50052,
    [int]$TimeoutSeconds = 8
)

$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkspaceRoot = (Get-Item $ScriptDir).Parent.FullName

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Swarm: Single-Computer Local Development Stop & Cleanup" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$sessionFile = Join-Path $WorkspaceRoot "artifacts\local_dev\active_session.json"
$coordPid = $null
$rpcPid = $null
$sessionActive = $false

# Helper: Safely validate and stop a specific session process
function Stop-ValidatedProcess {
    param(
        [int]$TargetPid,
        [string]$ExpectedName,
        [string]$RoleName
    )

    if (-not $TargetPid -or $TargetPid -le 4) { return $true }

    $p = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
    if (-not $p) {
        Write-Host "  $RoleName (PID $TargetPid) is not currently running." -ForegroundColor Gray
        return $true
    }

    # Validate process identity
    $procName = $p.ProcessName
    $procPath = ""
    try { $procPath = $p.Path } catch {}

    $nameMatches = (-not $ExpectedName) -or ($procName -like "*$ExpectedName*")
    $pathMatches = (-not $procPath) -or ($procPath -like "*$WorkspaceRoot*")

    if (-not $nameMatches -or -not $pathMatches) {
        Write-Warning "Refusing to kill PID ${TargetPid} - Identity mismatch (Name='$procName', Path='$procPath'). Does not match $RoleName in $WorkspaceRoot."
        return $false
    }

    Write-Host "Stopping $RoleName (PID $TargetPid, Process: $procName)..." -ForegroundColor Yellow
    Stop-Process -Id $TargetPid -Force -ErrorAction SilentlyContinue

    # Poll for process termination (up to 5 seconds)
    $terminated = $false
    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Milliseconds 500
        $check = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
        if (-not $check) {
            $terminated = $true
            break
        }
    }

    if ($terminated) {
        Write-Host "  [OK] $RoleName (PID $TargetPid) stopped successfully." -ForegroundColor Green
        return $true
    } else {
        Write-Warning "  [WARN] $RoleName (PID $TargetPid) did not exit within timeout."
        return $false
    }
}

# 1. Read session file if available
if (Test-Path $sessionFile) {
    try {
        $session = Get-Content $sessionFile -Raw | ConvertFrom-Json
        if ($session) {
            $coordPid = $session.CoordinatorPid
            $rpcPid   = $session.RpcWorkerPid
            if ($session.CoordinatorPort) { $Port = $session.CoordinatorPort }
            if ($session.RpcWorkerPort)   { $RpcPort = $session.RpcWorkerPort }
            $sessionActive = $true
            Write-Host "Loaded active session recorded at $($session.StartedAt)" -ForegroundColor Gray
            if ($coordPid) { Write-Host "  Session Coordinator PID: $coordPid (Port $Port)" -ForegroundColor Gray }
            if ($rpcPid)   { Write-Host "  Session RPC Worker PID:  $rpcPid (Port $RpcPort)" -ForegroundColor Gray }
        }
    } catch {
        Write-Warning "Could not parse session file: $_"
    }
}

# 2. Terminate session coordinator
if ($coordPid) {
    Stop-ValidatedProcess -TargetPid $coordPid -ExpectedName "swarm_node" -RoleName "Coordinator" | Out-Null
}

# 3. Terminate session RPC worker
if ($rpcPid) {
    Stop-ValidatedProcess -TargetPid $rpcPid -ExpectedName "ggml-rpc-server" -RoleName "RPC Worker" | Out-Null
}

# 4. Check for orphaned local swarm processes strictly bound to this workspace on target ports
$targetPorts = @($Port, $RpcPort)
foreach ($p in $targetPorts) {
    $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if ($conns) {
        foreach ($c in $conns) {
            $owningPid = $c.OwningProcess
            if ($owningPid -gt 4) {
                $proc = Get-Process -Id $owningPid -ErrorAction SilentlyContinue
                if ($proc) {
                    $procPath = ""
                    try { $procPath = $proc.Path } catch {}
                    $isSwarmNode = ($proc.ProcessName -like "*swarm_node*") -and ($procPath -like "*$WorkspaceRoot*")
                    $isRpcServer = ($proc.ProcessName -like "*ggml-rpc-server*") -and ($procPath -like "*$WorkspaceRoot*")

                    if ($isSwarmNode) {
                        Write-Host "Found orphaned local swarm_node listening on port $p (PID $owningPid). Terminating..." -ForegroundColor Yellow
                        Stop-ValidatedProcess -TargetPid $owningPid -ExpectedName "swarm_node" -RoleName "Orphaned Coordinator" | Out-Null
                    } elseif ($isRpcServer) {
                        Write-Host "Found orphaned local ggml-rpc-server listening on port $p (PID $owningPid). Terminating..." -ForegroundColor Yellow
                        Stop-ValidatedProcess -TargetPid $owningPid -ExpectedName "ggml-rpc-server" -RoleName "Orphaned RPC Worker" | Out-Null
                    } else {
                        Write-Warning "Port $p is occupied by PID $owningPid ($($proc.ProcessName)), which is NOT a Swarm process belonging to this workspace. Leaving it untouched."
                    }
                }
            }
        }
    }
}

# 5. Wait and verify socket release with polling loop
Write-Host "`nVerifying port release status (waiting up to $TimeoutSeconds s)..." -ForegroundColor Yellow
$portsReleased = $true

foreach ($p in $targetPorts) {
    $released = $false
    $maxAttempts = [math]::Max(1, [int]($TimeoutSeconds * 2))
    for ($i = 0; $i -lt $maxAttempts; $i++) {
        $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
        if (-not $conn) {
            $released = $true
            break
        }
        Start-Sleep -Milliseconds 500
    }

    if ($released) {
        Write-Host "  [OK]   Port $p is completely free." -ForegroundColor Green
    } else {
        $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
        $owning = if ($conn) { "PID $($conn.OwningProcess)" } else { "unknown" }
        Write-Host "  [FAIL] Port $p is still in LISTEN state ($owning)!" -ForegroundColor Red
        $portsReleased = $false
    }
}

# 6. Update or clean session tracking file
if (Test-Path $sessionFile) {
    try {
        $cleanupRecord = [ordered]@{
            "Status"         = "Stopped"
            "StoppedAt"      = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
            "LastCoordPid"   = $coordPid
            "LastRpcPid"     = $rpcPid
            "PortsReleased"  = $portsReleased
        }
        $cleanupRecord | ConvertTo-Json | Set-Content $sessionFile -Force
    } catch {}
}

if ($portsReleased) {
    Write-Host "`nEnvironment cleanup completed successfully." -ForegroundColor Green
    exit 0
} else {
    Write-Error "Some ports could not be released."
    exit 1
}
