param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("get", "set")]
  [string]$Mode,
  [string]$Family = ""
)

$ErrorActionPreference = "Stop"

if (-not ("Domotion.SystemUiMetric" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Domotion {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct LOGFONT {
    public int lfHeight;
    public int lfWidth;
    public int lfEscapement;
    public int lfOrientation;
    public int lfWeight;
    public byte lfItalic;
    public byte lfUnderline;
    public byte lfStrikeOut;
    public byte lfCharSet;
    public byte lfOutPrecision;
    public byte lfClipPrecision;
    public byte lfQuality;
    public byte lfPitchAndFamily;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string lfFaceName;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct NONCLIENTMETRICS {
    public uint cbSize;
    public int iBorderWidth;
    public int iScrollWidth;
    public int iScrollHeight;
    public int iCaptionWidth;
    public int iCaptionHeight;
    public LOGFONT lfCaptionFont;
    public int iSmCaptionWidth;
    public int iSmCaptionHeight;
    public LOGFONT lfSmCaptionFont;
    public int iMenuWidth;
    public int iMenuHeight;
    public LOGFONT lfMenuFont;
    public LOGFONT lfStatusFont;
    public LOGFONT lfMessageFont;
    public int iPaddedBorderWidth;
  }

  public static class SystemUiMetric {
    const uint SPI_GETNONCLIENTMETRICS = 0x0029;
    const uint SPI_SETNONCLIENTMETRICS = 0x002A;
    const uint SPIF_UPDATEINIFILE = 0x0001;
    const uint SPIF_SENDCHANGE = 0x0002;

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool SystemParametersInfo(uint action, uint parameter, ref NONCLIENTMETRICS metrics, uint flags);

    public static NONCLIENTMETRICS Read() {
      var metrics = new NONCLIENTMETRICS();
      metrics.cbSize = (uint)Marshal.SizeOf<NONCLIENTMETRICS>();
      if (!SystemParametersInfo(SPI_GETNONCLIENTMETRICS, metrics.cbSize, ref metrics, 0))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      return metrics;
    }

    public static NONCLIENTMETRICS SetMenuFamily(string family) {
      if (String.IsNullOrWhiteSpace(family) || family.Length >= 32)
        throw new ArgumentException("menu font family must contain 1-31 characters", nameof(family));
      var metrics = Read();
      var menu = metrics.lfMenuFont;
      menu.lfFaceName = family;
      metrics.lfMenuFont = menu;
      if (!SystemParametersInfo(SPI_SETNONCLIENTMETRICS, metrics.cbSize, ref metrics,
                                SPIF_UPDATEINIFILE | SPIF_SENDCHANGE))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      return Read();
    }
  }
}
"@
}

if ($Mode -eq "set") {
  if ([string]::IsNullOrWhiteSpace($Family)) {
    throw "-Family is required for -Mode set"
  }
  $metric = [Domotion.SystemUiMetric]::SetMenuFamily($Family)
} else {
  $metric = [Domotion.SystemUiMetric]::Read()
}

[ordered]@{
  menuFamily = $metric.lfMenuFont.lfFaceName
  messageFamily = $metric.lfMessageFont.lfFaceName
  menuHeight = $metric.lfMenuFont.lfHeight
} | ConvertTo-Json -Compress
