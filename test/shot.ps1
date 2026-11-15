#requires -Version 5.1
<#
.SYNOPSIS
  Launches popup.ps1 with sample content and saves a PNG of the card.

.DESCRIPTION
  Verification helper only: it starts the real renderer, waits for it to settle,
  screenshots the exact card rectangle, and stops the process. The PNG shows the
  shipped look, not a mock.

.PARAMETER OutFile
  Destination PNG.

.PARAMETER DelayMs
  Time to wait before capturing, covering process start, Add-Type, and the
  slide-in animation.
#>
[CmdletBinding()]
param(
  [string] $OutFile,
  [int] $DelayMs = 2600,
  [string] $Title = '大学俄语·语法总纲',
  [string] $Body = '此对话已结束',
  [string] $Meta = '示例 · 18:47 · 点击可关闭',
  [ValidateSet('done', 'warn', 'error')]
  [string] $Accent = 'done',
  [ValidateSet('auto', 'dark', 'light')]
  [string] $Theme = 'auto'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ([string]::IsNullOrWhiteSpace($OutFile)) {
  $OutFile = Join-Path $PSScriptRoot 'preview.png'
}
if (-not ('DshShotDpi' -as [type])) {
  Add-Type -Namespace '' -Name 'DshShotDpi' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetProcessDPIAware();
'@
}
[DshShotDpi]::SetProcessDPIAware() | Out-Null

$graphics = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
$scale = $graphics.DpiX / 96.0
$graphics.Dispose()

$height = if ([string]::IsNullOrWhiteSpace($Meta)) { 82 } else { 100 }
$cardWidth = [int] [Math]::Round(372 * $scale)
$cardHeight = [int] [Math]::Round($height * $scale)
$margin = [int] [Math]::Round(16 * $scale)
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

$arguments = @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', ('"' + (Join-Path $PSScriptRoot '..\popup.ps1') + '"'),
  '-Title', ('"' + $Title + '"'),
  '-Body', ('"' + $Body + '"'),
  '-Meta', ('"' + $Meta + '"'),
  '-Accent', $Accent,
  '-DurationMs', '15000',
  '-Theme', $Theme
)
$process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -PassThru -WindowStyle Hidden

try {
  Start-Sleep -Milliseconds $DelayMs
  $left = $area.Right - $margin - $cardWidth
  $top = $area.Bottom - $margin - $cardHeight
  # A little context around the card proves where it sits.
  $pad = [int] [Math]::Round(14 * $scale)
  $shotLeft = [Math]::Max($area.Left, $left - $pad)
  $shotTop = [Math]::Max($area.Top, $top - $pad)
  $shotWidth = [Math]::Min($area.Right - $shotLeft, $cardWidth + ($left - $shotLeft) + $pad)
  $shotHeight = [Math]::Min($area.Bottom - $shotTop, $cardHeight + ($top - $shotTop) + $pad)

  $bitmap = New-Object System.Drawing.Bitmap($shotWidth, $shotHeight)
  $canvas = [System.Drawing.Graphics]::FromImage($bitmap)
  $canvas.CopyFromScreen($shotLeft, $shotTop, 0, 0, (New-Object System.Drawing.Size($shotWidth, $shotHeight)))
  $canvas.Dispose()
  $bitmap.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  Write-Output ("saved {0} ({1}x{2}) scale={3}" -f $OutFile, $shotWidth, $shotHeight, $scale)
} finally {
  if ($null -ne $process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  Get-ChildItem -Path (Join-Path $env:TEMP 'dsh-session-notify\cards') -Filter '*.lock' -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
}
