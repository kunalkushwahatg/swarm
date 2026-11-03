# Cross-compile swarm-tunnel for Android (arm64) using the Android NDK.
# Produces target/aarch64-linux-android/release/swarm-tunnel, which runs on
# Android/Termux and is also the base for the future APK worker.

$ErrorActionPreference = "Stop"

$ndk = "C:\Users\kunal\AppData\Local\Android\Sdk\ndk\27.2.12479018"
$bin = "$ndk\toolchains\llvm\prebuilt\windows-x86_64\bin"
$api = "26"

if (-not (Test-Path $bin)) { throw "NDK not found at $bin" }

$env:CC_aarch64_linux_android = "$bin\clang.exe"
$env:CXX_aarch64_linux_android = "$bin\clang++.exe"
$env:AR_aarch64_linux_android = "$bin\llvm-ar.exe"
$env:CFLAGS_aarch64_linux_android = "--target=aarch64-linux-android$api"
$env:CXXFLAGS_aarch64_linux_android = "--target=aarch64-linux-android$api"
$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = "$bin\aarch64-linux-android$api-clang.cmd"

Push-Location $PSScriptRoot
$out = Join-Path $PSScriptRoot "target\aarch64-linux-android\release\swarm-tunnel"
try {
    cargo build --release --target aarch64-linux-android
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
} finally {
    Pop-Location
}

if (-not (Test-Path $out)) { throw "missing output $out" }
"built: $out ($([math]::Round((Get-Item $out).Length / 1MB, 1)) MB)"
