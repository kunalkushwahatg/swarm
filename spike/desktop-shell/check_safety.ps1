# Preflight Hardware Safety Check
$os = Get-CimInstance Win32_OperatingSystem
$availRam = [math]::Round($os.FreePhysicalMemory / 1024)
$totalRam = [math]::Round($os.TotalVisibleMemorySize / 1024)
Write-Output "AVAILABLE_RAM_MB=$availRam"
Write-Output "TOTAL_RAM_MB=$totalRam"

# GPU VRAM
try {
    $gpuOutput = nvidia-smi --query-gpu=memory.free,memory.total,name --format=csv,noheader,nounits
    Write-Output "NVIDIA_SMI=$gpuOutput"
} catch {
    Write-Output "NVIDIA_SMI_ERROR=$($_)"
}

# Ports 8080 and 50052
$c8080 = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
$c50052 = Get-NetTCPConnection -LocalPort 50052 -State Listen -ErrorAction SilentlyContinue
Write-Output "PORT_8080_LISTENING=$(if ($c8080) { 'YES' } else { 'NO' })"
Write-Output "PORT_50052_LISTENING=$(if ($c50052) { 'YES' } else { 'NO' })"

# Existing Swarm processes
$procs = Get-Process -Name swarm_node, ggml-rpc-server, app -ErrorAction SilentlyContinue
Write-Output "SWARM_PROCESSES_COUNT=$(($procs | Measure-Object).Count)"
if ($procs) {
    foreach ($p in $procs) {
        Write-Output "PROC=$($p.Id):$($p.ProcessName):$([math]::Round($p.WorkingSet64/1MB))MB"
    }
}

# Model file check
$model = "C:\Users\kunal\OneDrive\Desktop\swarm\models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf"
if (Test-Path $model) {
    $mItem = Get-Item $model
    Write-Output "MODEL_FILE_EXISTS=YES"
    Write-Output "MODEL_SIZE_BYTES=$($mItem.Length)"
} else {
    Write-Output "MODEL_FILE_EXISTS=NO"
}
