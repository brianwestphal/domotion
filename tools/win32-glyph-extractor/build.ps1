# Build the Windows DirectWrite glyph extractor.
#
#   pwsh tools/win32-glyph-extractor/build.ps1
#
# Requires: CMake + the Visual Studio Build Tools (MSVC v143) with the Windows
# SDK (both preinstalled on GitHub's windows-latest runners). DirectWrite
# (dwrite.lib) and the D2D headers ship with the Windows SDK.
#
# Output: tools/win32-glyph-extractor/domotion-glyph-paths.exe (statically
# linked CRT, /MT — runs on a clean Windows with no VC++ redistributable).
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release

# Multi-config MSVC generators place the binary under build\Release\.
$built = Join-Path $PSScriptRoot "build\Release\domotion-glyph-paths.exe"
if (-not (Test-Path $built)) {
  $built = Join-Path $PSScriptRoot "build\domotion-glyph-paths.exe"
}
Copy-Item -Path $built -Destination (Join-Path $PSScriptRoot "domotion-glyph-paths.exe") -Force
Write-Host "Built domotion-glyph-paths.exe"
