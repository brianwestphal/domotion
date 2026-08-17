$ErrorActionPreference = "Stop"
$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
$BuildRoot = Join-Path $env:RUNNER_TEMP "domotion-icu-build"
Remove-Item -Recurse -Force $BuildRoot -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $BuildRoot | Out-Null

if ($env:CMAKE_GENERATOR_PLATFORM -eq "ARM64") {
  $Archive = "icu4c-78.2-WinARM64-MSVC2022.zip"
  $ExpectedSha512 = "d8bf27d2842846d2b909607b252daee97c619c35f742efb676a0b7fdfb4f9ec108b7f2d2fca5e1da1c7323284fe2d93002254fe1f25f7a71d0f9f58bc0064837"
  $BinDir = "binARM64"
} else {
  $Archive = "icu4c-78.2-Win64-MSVC2022.zip"
  $ExpectedSha512 = "5f1d08daeadb1e7c314981e077d5ed67490390c5c089e6e32d4dab1f79116f59d0c117762a7826c979643dfd23d6482f66950929c5b5d9f0b9deb69d10d08da1"
  $BinDir = "bin64"
}
$ArchivePath = Join-Path $BuildRoot $Archive
Invoke-WebRequest "https://github.com/unicode-org/icu/releases/download/release-78.2/$Archive" -OutFile $ArchivePath
$ActualSha512 = (Get-FileHash $ArchivePath -Algorithm SHA512).Hash.ToLower()
if ($ActualSha512 -ne $ExpectedSha512) { throw "ICU archive SHA-512 mismatch" }
$IcuRoot = Join-Path $BuildRoot "icu"
Expand-Archive $ArchivePath $IcuRoot

cmake -S "$Root\tools\icu-helper" -B "$BuildRoot\helper" -A $env:CMAKE_GENERATOR_PLATFORM -DDOMOTION_ICU_ROOT="$IcuRoot"
cmake --build "$BuildRoot\helper" --config Release --parallel
Copy-Item "$BuildRoot\helper\Release\domotion-icu.exe" "$Root\tools\icu-helper\domotion-icu.exe"
Copy-Item "$IcuRoot\$BinDir\icuuc78.dll" "$Root\tools\icu-helper\icuuc78.dll"
Copy-Item "$IcuRoot\$BinDir\icudt78.dll" "$Root\tools\icu-helper\icudt78.dll"
