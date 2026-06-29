@echo off
REM Build the Windows DirectWrite glyph extractor directly with MSVC (no CMake).
REM
REM   tools\win32-glyph-extractor\build-msvc-direct.bat
REM
REM Use this when the VS Build Tools install has MSVC but NOT the CMake component
REM (e.g. the Parallels desktop Win11 VM), so build.ps1's cmake path can't run.
REM It sets up the MSVC environment via vcvars then compiles src\main.cpp the same
REM way build.ps1 does (/O2 /EHsc /MT static CRT, dwrite.lib), emitting
REM domotion-glyph-paths.exe next to this script.
REM
REM On an ARM64 Windows host the native arm64->arm64 build tools may be absent;
REM this script falls back to the arm64-hosted amd64 cross-compiler
REM (vcvarsarm64_amd64.bat) — the resulting amd64 .exe runs fine under the
REM Windows-on-ARM x64 emulator (DirectWrite works there). Override the vcvars by
REM setting DOMOTION_VCVARS to a full path before invoking.
REM
REM NOTE: single-line `if`s + quoted `set "VAR=..."` below are deliberate — the
REM vcvars path contains `(x86)`, and a parenthesized if/else block would let that
REM `)` close the block early ("\Microsoft was unexpected at this time").
setlocal
set "HERE=%~dp0"
set "VSROOT=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build"

set "VCVARS="
if defined DOMOTION_VCVARS set "VCVARS=%DOMOTION_VCVARS%"
if not defined VCVARS if exist "%VSROOT%\vcvars64.bat" set "VCVARS=%VSROOT%\vcvars64.bat"
if not defined VCVARS if exist "%VSROOT%\vcvarsarm64_amd64.bat" set "VCVARS=%VSROOT%\vcvarsarm64_amd64.bat"
if not defined VCVARS echo Could not find a vcvars bat under "%VSROOT%". Set DOMOTION_VCVARS.& exit /b 1

call "%VCVARS%" || exit /b 1

pushd "%HERE%"
cl /nologo /std:c++17 /O2 /EHsc /MT /W3 src\main.cpp /Fedomotion-glyph-paths.exe dwrite.lib
set "RC=%ERRORLEVEL%"
del /q main.obj 2>nul
popd
if "%RC%"=="0" echo Built domotion-glyph-paths.exe
if not "%RC%"=="0" echo BUILD_FAILED rc=%RC%
exit /b %RC%
