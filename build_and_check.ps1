Add-Type -AssemblyName System.IO.Compression.FileSystem
function Unzip {
    param([string]$zipfile, [string]$outpath)
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zipfile, $outpath)
}

$swarmDir = if ($env:SWARM_WORKSPACE_ROOT) { $env:SWARM_WORKSPACE_ROOT } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $swarmDir) { $swarmDir = (Get-Location).Path }
Set-Location $swarmDir

# Step 1: Configure with CUDA+RPC
Write-Host "=== Configuring build with CUDA+RPC ===" -ForegroundColor Green
cmd /c "call `"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`" && cmake -S . -B build -G `"Visual Studio 17 2022`" -DGGML_CUDA=ON -DGGML_RPC=ON -DGGML_BACKEND_DL=OFF -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_ARCHITECTURES=61"

# Step 2: Build the solution
Write-Host "=== Building solution ===" -ForegroundColor Green
cmd /c "call `"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`" && cd build && msbuild ALL_BUILD.vcxproj /p:Configuration=Release /p:Platform=x64 /m /verbosity:minimal"

# Step 3: List the Release directory
Write-Host "=== Release directory contents ===" -ForegroundColor Green
Get-ChildItem "$swarmDir\build\Release" -File | Format-Table Name, Length

# Step 4: Check for ggml-cuda.dll
Write-Host "=== Checking for CUDA artifacts ===" -ForegroundColor Green
if (Test-Path "$swarmDir\build\Release\ggml-cuda.dll") {
    Write-Host "ggml-cuda.dll found!" -ForegroundColor Green
} else {
    Write-Host "ggml-cuda.dll NOT found" -ForegroundColor Red
}
if (Test-Path "$swarmDir\build\bin\Release\ggml-cuda.dll") {
    Write-Host "ggml-cuda.dll found in bin\Release!" -ForegroundColor Green
} else {
    Write-Host "ggml-cuda.dll NOT found in bin\Release" -ForegroundColor Red
}