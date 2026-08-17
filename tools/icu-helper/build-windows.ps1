$ErrorActionPreference = "Stop"
$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
$IcuSource = "$Root\external\chromium\third_party\icu\source"
$BuildRoot = Join-Path $env:RUNNER_TEMP "domotion-icu-build"
$InstallRoot = Join-Path $BuildRoot "install"
Remove-Item -Recurse -Force $BuildRoot -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$BuildRoot\build" | Out-Null

# ICU's supported MSVC configure path uses the POSIX tools included with Git
# for Windows while invoking the runner's native cl/lib toolchain.
$Bash = "C:\Program Files\Git\bin\bash.exe"
$PosixSource = (& $Bash -lc "cygpath -u '$IcuSource'").Trim()
$PosixInstall = (& $Bash -lc "cygpath -u '$InstallRoot'").Trim()
$PosixBuild = (& $Bash -lc "cygpath -u '$BuildRoot\build'").Trim()
& $Bash -lc "cd '$PosixBuild' && '$PosixSource/runConfigureICU' Cygwin/MSVC --prefix='$PosixInstall' --enable-static --disable-shared --disable-tests --disable-samples --disable-extras --disable-tools && make -j2 && make install"
if ($LASTEXITCODE -ne 0) { throw "ICU build failed" }

cmake -S "$Root\tools\icu-helper" -B "$BuildRoot\helper" -A $env:CMAKE_GENERATOR_PLATFORM -DDOMOTION_ICU_ROOT="$InstallRoot"
cmake --build "$BuildRoot\helper" --config Release --parallel
Copy-Item "$BuildRoot\helper\Release\domotion-icu.exe" "$Root\tools\icu-helper\domotion-icu.exe"
