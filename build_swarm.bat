@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SWARM_DIR=%~dp0."
set "BUILD_DIR=%SWARM_DIR%build-cuda"

:: Dynamically locate Visual Studio installation using vswhere
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "VCVARS="
if exist "%VSWHERE%" (
    for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do (
        if exist "%%i\VC\Auxiliary\Build\vcvars64.bat" (
            set "VCVARS=%%i\VC\Auxiliary\Build\vcvars64.bat"
        )
    )
)
if not defined VCVARS (
    if exist "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" (
        set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
    ) else if exist "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" (
        set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
    )
)

if not defined CUDA_ARCH set "CUDA_ARCH=61"

echo === Step 1: Preserve and prepare build directory ===
if not exist "%BUILD_DIR%" mkdir "%BUILD_DIR%"
if errorlevel 1 (
    echo ERROR: Could not create "%BUILD_DIR%".
    exit /b 1
)
cd /d "%SWARM_DIR%"
if errorlevel 1 (
    echo ERROR: Could not enter "%SWARM_DIR%".
    exit /b 1
)

echo === Step 2: Set up Visual Studio environment ===
if not exist "%VCVARS%" (
    echo ERROR: Visual Studio environment script not found:
    echo        "%VCVARS%"
    exit /b 1
)
call "%VCVARS%"
if errorlevel 1 (
    echo ERROR: Failed to initialize the Visual Studio build environment.
    exit /b 1
)

echo === Step 3: Configure with NMake ===
cmake -S "%SWARM_DIR%" -B "%BUILD_DIR%" -G "NMake Makefiles" ^
    -DGGML_CUDA=ON -DGGML_RPC=ON -DGGML_BACKEND_DL=OFF ^
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_ARCHITECTURES=%CUDA_ARCH%
if errorlevel 1 (
    echo ERROR: CMake configuration failed. Existing build artifacts were preserved.
    exit /b 1
)

echo === Step 4: Build swarm_node ===
cmake --build "%BUILD_DIR%" --target swarm_node
if errorlevel 1 (
    echo ERROR: swarm_node build failed. Existing build artifacts were preserved.
    exit /b 1
)

echo === Step 5: Validate runtime layout ===
set "SWARM_EXE=%BUILD_DIR%\swarm_node.exe"
if not exist "%SWARM_EXE%" (
    echo ERROR: Build reported success, but "%SWARM_EXE%" was not produced.
    exit /b 1
)

set "MISSING_DLLS="
for %%D in (ggml-base.dll ggml-cpu.dll ggml-cuda.dll ggml-rpc.dll llama.dll) do (
    if not exist "%BUILD_DIR%\bin\%%D" set "MISSING_DLLS=!MISSING_DLLS! %%D"
)
if defined MISSING_DLLS (
    echo ERROR: Missing runtime DLLs:%MISSING_DLLS%
    echo        Expected them under "%BUILD_DIR%\bin".
    exit /b 1
)

echo Build completed successfully.
echo Executable: "%SWARM_EXE%"
echo Runtime DLLs: "%BUILD_DIR%\bin"
exit /b 0