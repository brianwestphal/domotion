$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$sourceDirectory = Join-Path $PSScriptRoot '..\assets\fonts\fixture'
$fontDirectory = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts'
$registryPath = 'HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts'
$fonts = @(
  @{ File = 'DomotionProfileDevanagariOne-Regular.ttf'; Name = 'Domotion Profile Devanagari One' },
  @{ File = 'DomotionProfileDevanagariTwo-Regular.ttf'; Name = 'Domotion Profile Devanagari Two' }
)

New-Item -ItemType Directory -Path $fontDirectory -Force | Out-Null
New-Item -Path $registryPath -Force | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DomotionProfileFontInstaller {
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int AddFontResourceExW(string fileName, uint flags, IntPtr reserved);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeoutW(
        IntPtr window, uint message, UIntPtr wParam, IntPtr lParam,
        uint flags, uint timeout, out UIntPtr result);
}
'@

foreach ($font in $fonts) {
  $source = Join-Path $sourceDirectory $font.File
  $destination = Join-Path $fontDirectory $font.File
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Missing deterministic profile fixture font: $source"
  }

  Copy-Item -LiteralPath $source -Destination $destination -Force
  New-ItemProperty -Path $registryPath -Name "$($font.Name) (TrueType)" `
    -Value $destination -PropertyType String -Force | Out-Null

  # Zero flags makes the resource session-visible. FR_PRIVATE would expose it
  # only to this short-lived PowerShell process, so Chrome could not authenticate
  # it through DirectWrite's system collection after the step exits.
  $added = [DomotionProfileFontInstaller]::AddFontResourceExW(
    $destination, 0, [IntPtr]::Zero)
  if ($added -eq 0) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "AddFontResourceExW failed for $destination (Win32 error $errorCode)"
  }
}

$broadcast = [IntPtr]0xffff
$fontChange = 0x001d
$abortIfHung = 0x0002
$result = [UIntPtr]::Zero
[void][DomotionProfileFontInstaller]::SendMessageTimeoutW(
  $broadcast, $fontChange, [UIntPtr]::Zero, [IntPtr]::Zero,
  $abortIfHung, 5000, [ref]$result)

Write-Host "Installed $($fonts.Count) deterministic Devanagari profile fixture fonts."
