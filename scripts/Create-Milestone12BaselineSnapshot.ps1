# Create-Milestone12BaselineSnapshot.ps1
# Preserves source, binaries, configs, scripts, docs, and validation evidence for Milestone 12

param(
    [string]$SnapshotName = "milestone12-final-baseline-20261011"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkspaceRoot = (Get-Item $ScriptDir).Parent.FullName

$baseDir = Join-Path $WorkspaceRoot "backups\$SnapshotName"
$srcDir = Join-Path $baseDir "source"
$binDir = Join-Path $baseDir "binaries"
$scriptsDir = Join-Path $baseDir "scripts"
$docsDir = Join-Path $baseDir "docs"
$evidenceDir = Join-Path $baseDir "validation_evidence"

Write-Host "Creating snapshot directories under: $baseDir" -ForegroundColor Cyan
New-Item -ItemType Directory -Path $srcDir -Force | Out-Null
New-Item -ItemType Directory -Path $binDir -Force | Out-Null
New-Item -ItemType Directory -Path $scriptsDir -Force | Out-Null
New-Item -ItemType Directory -Path $docsDir -Force | Out-Null
New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null

# 1. Copy source files
Write-Host "Preserving source files..." -ForegroundColor Yellow
$sources = @(
    "main.cpp", "worker.cpp", "worker.h", "node.h", "agent.h", "agent_main.cpp",
    "config.h", "estimator.h", "policy.h", "placement.h", "CMakeLists.txt",
    "test_rpc_health.cpp", "test_security.cpp", "test_dynamic_policy.cpp",
    "test_agent_and_inventory.cpp", "test_placement.cpp", "test_policy.cpp", "test_config.cpp"
)
foreach ($s in $sources) {
    $srcPath = Join-Path $WorkspaceRoot $s
    if (Test-Path $srcPath) {
        Copy-Item -Path $srcPath -Destination $srcDir -Force
    }
}

# 2. Copy binaries
Write-Host "Preserving runtime & test binaries..." -ForegroundColor Yellow
$binaries = @(
    "build-cuda\swarm_node.exe",
    "build-cuda\swarm_agent.exe",
    "build-cuda\test_security.exe",
    "build-cuda\test_rpc_health.exe",
    "test_dynamic_policy.exe",
    "test_agent_and_inventory.exe"
)
foreach ($b in $binaries) {
    $binPath = Join-Path $WorkspaceRoot $b
    if (Test-Path $binPath) {
        Copy-Item -Path $binPath -Destination $binDir -Force
    }
}

# 3. Copy scripts
Write-Host "Preserving operational & validation scripts..." -ForegroundColor Yellow
Get-ChildItem -Path (Join-Path $WorkspaceRoot "scripts") -File | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $scriptsDir -Force
}

# 4. Copy documentation
Write-Host "Preserving documentation..." -ForegroundColor Yellow
Get-ChildItem -Path (Join-Path $WorkspaceRoot "docs") -File | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $docsDir -Force
}
$readmePath = Join-Path $WorkspaceRoot "README.md"
if (Test-Path $readmePath) {
    Copy-Item -Path $readmePath -Destination $docsDir -Force
}

# 5. Copy validation evidence
Write-Host "Preserving Milestone 12 validation evidence..." -ForegroundColor Yellow
$evidence = @(
    "artifacts\validation\m12_backends.json",
    "artifacts\validation\m12_coordinator.stdout.log",
    "artifacts\validation\m12_coordinator.stderr.log",
    "artifacts\validation\m12_inference_response.raw.txt",
    "milestone12_rpc_health_fix_report.md"
)
foreach ($e in $evidence) {
    $evPath = Join-Path $WorkspaceRoot $e
    if (Test-Path $evPath) {
        Copy-Item -Path $evPath -Destination $evidenceDir -Force
    }
}

# 6. Archive evidence into artifacts\validation\2026-10-11\milestone-12
$m12ArtifactDir = Join-Path $WorkspaceRoot "artifacts\validation\2026-10-11\milestone-12"
New-Item -ItemType Directory -Path $m12ArtifactDir -Force | Out-Null
foreach ($e in $evidence) {
    $evPath = Join-Path $WorkspaceRoot $e
    if (Test-Path $evPath) {
        Copy-Item -Path $evPath -Destination $m12ArtifactDir -Force
    }
}

# 7. Generate baseline manifest with SHA256 hashes
Write-Host "Generating BASELINE_MANIFEST.md..." -ForegroundColor Yellow
$manifestLines = [System.Collections.Generic.List[string]]::new()
$manifestLines.Add("# Milestone 12 Baseline Snapshot Manifest")
$manifestLines.Add("")
$manifestLines.Add("- **Created:** " + (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"))
$manifestLines.Add("- **Snapshot Location:** ``" + $baseDir + "``")
$manifestLines.Add("- **Workspace:** ``" + $WorkspaceRoot + "``")
$manifestLines.Add("")
$manifestLines.Add("## Official Model Verification")
$modelCheckPath = Join-Path $WorkspaceRoot "models\qwen2.5-3b-instruct-q4_k_m.official-check.gguf"
if (Test-Path $modelCheckPath) {
    $mHash = (Get-FileHash -Path $modelCheckPath -Algorithm SHA256).Hash
    $mItem = Get-Item $modelCheckPath
    $mSizeGb = [Math]::Round($mItem.Length / 1GB, 2)
    $manifestLines.Add("- **Official Model Path:** ``" + $modelCheckPath + "``")
    $manifestLines.Add("- **Size:** " + $mItem.Length + " bytes (" + $mSizeGb + " GB)")
    $manifestLines.Add("- **SHA-256:** ``" + $mHash + "``")
    $statusText = if ($mHash -eq "626B4A6678B86442240E33DF819E00132D3BA7DDDFE1CDC4FBB18E0A9615C62D") { "MATCH (VERIFIED)" } else { "MISMATCH" }
    $manifestLines.Add("- **Reference Verified:** " + $statusText)
} else {
    $manifestLines.Add("- **Official Model:** NOT FOUND")
}
$manifestLines.Add("")
$manifestLines.Add("## Preserved Files & Cryptographic Hashes")
$manifestLines.Add("")
$manifestLines.Add("| Relative Path | Size (Bytes) | SHA-256 |")
$manifestLines.Add("| :--- | :--- | :--- |")

Get-ChildItem -Path $baseDir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($baseDir.Length).TrimStart('\', '/')
    $h = (Get-FileHash -Path $_.FullName -Algorithm SHA256).Hash
    $manifestLines.Add("| ``" + $rel + "`` | " + $_.Length + " | ``" + $h + "`` |")
}

$manifestPath = Join-Path $baseDir "BASELINE_MANIFEST.md"

[System.IO.File]::WriteAllLines($manifestPath, $manifestLines)
Write-Host "Manifest written to: $manifestPath" -ForegroundColor Green
Write-Host "Snapshot successfully created!" -ForegroundColor Green
