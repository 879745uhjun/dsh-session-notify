#requires -Version 5.1
<#
.SYNOPSIS
  Shows the session-finish card once, with sample text.

.DESCRIPTION
  This is the same renderer the plugin runs after a finished turn, so what you
  see here is exactly what the plugin shows — nothing about this script is a
  mock. Use it to judge the look, the placement, and the timing before the
  plugin is installed, or after installation to check a different -Accent.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File demo\preview.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File demo\preview.ps1 -Title "另一个会话" -Accent error -DurationMs 4000
#>
[CmdletBinding()]
param(
  [string] $Title = '大学俄语·语法总纲',
  [string] $Body = '此对话已结束',
  [string] $Meta = '已完成 · 现在 · 点击关闭',
  [ValidateSet('done', 'warn', 'error')]
  [string] $Accent = 'done',
  [int] $DurationMs = 8000,
  [ValidateSet('auto', 'dark', 'light')]
  [string] $Theme = 'auto'
)

$popup = Join-Path (Split-Path -Parent $PSScriptRoot) 'popup.ps1'
if (-not (Test-Path -LiteralPath $popup)) {
  throw "popup.ps1 not found next to this demo: $popup"
}

& $popup -Title $Title -Body $Body -Meta $Meta -Accent $Accent -DurationMs $DurationMs -Theme $Theme
