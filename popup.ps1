#requires -Version 5.1
<#
.SYNOPSIS
  Bottom-right "this conversation has finished" card for Windows.

.DESCRIPTION
  Draws a borderless, always-on-top card anchored to the bottom-right corner of
  the primary screen's working area. The card never takes focus (WS_EX_NOACTIVATE),
  slides in, closes itself after -DurationMs, and closes early on a click. When
  -OpenUrl/-OpenSession are given, that click also asks the Host to open the
  conversation the card stands for.

  This file is the only renderer: the DSH plugin launches it once per finished
  turn, and demo\preview.ps1 launches it for a preview. Nothing here knows about
  DSH; every visible value arrives as a parameter.

.PARAMETER Title
  Small grey line: the session title.

.PARAMETER Body
  Large line: the message, "此对话已结束" by default.

.PARAMETER Meta
  Smallest line under the body: time, reason, or a hint. Empty hides it.

.PARAMETER Accent
  Status colour: done (green), warn (amber), error (red).

.PARAMETER DurationMs
  How long the card stays before it closes itself.

.PARAMETER Sticky
  Keep the card on screen until it is clicked, ignoring -DurationMs.

.PARAMETER SlotsDir
  Where cards claim a vertical slot so several of them stack instead of
  overlapping. Defaults to %TEMP%\dsh-session-notify\cards.

.PARAMETER LogPath
  Optional file for one trace line per lifecycle step: start, DPI, geometry,
  shown, close. Nothing is written without it.

.PARAMETER OpenUrl
  The Host route a click posts to. Omit it and the card only closes.

.PARAMETER OpenSession
  The session id that travels in that click, so the Host opens this exact
  conversation.

.PARAMETER Theme
  auto (default), dark, or light. auto follows the Windows app theme.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File popup.ps1 -Title 'Session' -Body '此对话已结束'
#>
[CmdletBinding()]
param(
  [string] $Title = 'DeepSeek Harness',
  [string] $Body = '此对话已结束',
  [string] $Meta = '',
  [ValidateSet('done', 'warn', 'error')]
  [string] $Accent = 'done',
  [int] $DurationMs = 8000,
  [switch] $Sticky,
  [string] $SlotsDir = '',
  [string] $LogPath = '',
  [string] $OpenUrl = '',
  [string] $OpenSession = '',
  [ValidateSet('auto', 'dark', 'light')]
  [string] $Theme = 'auto'
)

$ErrorActionPreference = 'Stop'

# Diagnostics are off unless -LogPath is given: one line per lifecycle step, so
# "the card never appeared" can be answered from a file instead of a guess.
function Write-Trace([string] $message) {
  if ([string]::IsNullOrWhiteSpace($LogPath)) { return }
  try {
    $line = (Get-Date).ToString('HH:mm:ss.fff') + ' [pid ' + $PID + '] ' + $message
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  } catch {
    # A trace failure must never break the card.
  }
}

Write-Trace ('start title="' + $Title + '" accent=' + $Accent + ' duration=' + $DurationMs + ' sticky=' + $Sticky.IsPresent + ' opens="' + $OpenSession + '"')

# Clicking the card always closes it, and when the Host supplied a target it
# then asks DSH to open that conversation. The request is sent after the card is
# gone, so the click feels immediate.
$script:openRequested = $false
function Send-OpenRequest {
  if ([string]::IsNullOrWhiteSpace($OpenUrl) -or [string]::IsNullOrWhiteSpace($OpenSession)) { return }
  try {
    $body = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress @{ sessionId = $OpenSession }))
    $request = [System.Net.WebRequest]::Create($OpenUrl)
    $request.Method = 'POST'
    $request.ContentType = 'application/json; charset=utf-8'
    $request.Proxy = $null
    $request.Timeout = 1500
    $request.ReadWriteTimeout = 1500
    $stream = $request.GetRequestStream()
    $stream.Write($body, 0, $body.Length)
    $stream.Close()
    $response = $request.GetResponse()
    $response.Close()
    Write-Trace 'open request sent'
  } catch {
    Write-Trace ('open request failed: ' + $_.Exception.Message)
  }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# --- card themes -----------------------------------------------------------
# Only the card's own surface is themed; it is not a DSH page, so it does not
# read DSH theme tokens.
$themes = @{
  dark = @{
    Background = [System.Drawing.Color]::FromArgb(30, 32, 38)
    Border     = [System.Drawing.Color]::FromArgb(58, 62, 74)
    Title      = [System.Drawing.Color]::FromArgb(148, 154, 168)
    Body       = [System.Drawing.Color]::FromArgb(240, 243, 249)
    Meta       = [System.Drawing.Color]::FromArgb(124, 130, 146)
  }
  light = @{
    Background = [System.Drawing.Color]::FromArgb(252, 252, 253)
    Border     = [System.Drawing.Color]::FromArgb(214, 217, 224)
    Title      = [System.Drawing.Color]::FromArgb(104, 110, 124)
    Body       = [System.Drawing.Color]::FromArgb(28, 31, 38)
    Meta       = [System.Drawing.Color]::FromArgb(136, 142, 156)
  }
}
$accents = @{
  done  = [System.Drawing.Color]::FromArgb(48, 196, 124)
  warn  = [System.Drawing.Color]::FromArgb(238, 170, 62)
  error = [System.Drawing.Color]::FromArgb(232, 92, 92)
}
$glyphs = @{ done = [char]0x2713; warn = '!'; error = '!' }

if ($Theme -eq 'auto') {
  $light = $true
  try {
    $value = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name 'AppsUseLightTheme' -ErrorAction Stop).AppsUseLightTheme
    $light = [int] $value -ne 0
  } catch {
    $light = $true
  }
  $Theme = if ($light) { 'light' } else { 'dark' }
}
$palette = $themes[$Theme]

# --- slot allocation -------------------------------------------------------
# Cards stack upwards from the bottom-right corner. Each live card owns one
# lock file named after its process id, so a crashed card leaves a lock that
# the next card prunes.
if ([string]::IsNullOrWhiteSpace($SlotsDir)) {
  $SlotsDir = Join-Path $env:TEMP 'dsh-session-notify\cards'
}
$slot = 0
$lockFile = $null
try {
  if (-not (Test-Path -LiteralPath $SlotsDir)) {
    New-Item -ItemType Directory -Force -Path $SlotsDir | Out-Null
  }
  $live = @()
  foreach ($file in (Get-ChildItem -LiteralPath $SlotsDir -Filter '*.lock' -ErrorAction SilentlyContinue)) {
    $owner = 0
    if ([int]::TryParse([System.IO.Path]::GetFileNameWithoutExtension($file.Name), [ref] $owner)) {
      $process = Get-Process -Id $owner -ErrorAction SilentlyContinue
      if ($null -ne $process -and $process.ProcessName -eq 'powershell') {
        $live += $owner
        continue
      }
    }
    Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
  }
  $slot = [Math]::Min($live.Count, 3)
  $lockFile = Join-Path $SlotsDir ((Get-Process -Id $PID).Id.ToString() + '.lock')
  Set-Content -LiteralPath $lockFile -Value (Get-Date).ToString('o') -Encoding ASCII
} catch {
  $slot = 0
  $lockFile = $null
}

# --- DPI -------------------------------------------------------------------
if (-not ('DshNotifyDpi' -as [type])) {
  Add-Type -Namespace '' -Name 'DshNotifyDpi' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetProcessDPIAware();
'@
}
[DshNotifyDpi]::SetProcessDPIAware() | Out-Null

$scale = 1.0
try {
  $graphics = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
  $scale = $graphics.DpiX / 96.0
  $graphics.Dispose()
} catch {
  $scale = 1.0
}
Write-Trace ('scale=' + $scale)

# --- the card --------------------------------------------------------------
# Compiled once per process; the type carries the whole look so the script
# stays a thin driver. Rounded corners come from DWM on Windows 11 and from a
# clipped region elsewhere.
if (-not ('DshNotifyCard' -as [type])) {
  Add-Type -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing' -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public sealed class DshNotifyCard : Form
{
    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    public string CardTitle = "";
    public string CardBody = "";
    public string CardMeta = "";
    public string Glyph = "\u2713";
    public Color AccentColor = Color.FromArgb(48, 196, 124);
    public Color BackgroundColor = Color.FromArgb(30, 32, 38);
    public Color BorderColor = Color.FromArgb(58, 62, 74);
    public Color TitleColor = Color.FromArgb(148, 154, 168);
    public Color BodyColor = Color.FromArgb(240, 243, 249);
    public Color MetaColor = Color.FromArgb(124, 130, 146);
    public Color IconColor = Color.FromArgb(240, 243, 249);
    public float UiScale = 1f;
    public Font TitleFont;
    public Font BodyFont;
    public Font MetaFont;
    public Font GlyphFont;
    public int Radius = 14;

    public DshNotifyCard()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        BackColor = BackgroundColor;
        DoubleBuffered = true;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
    }

    protected override bool ShowWithoutActivation
    {
        get { return true; }
    }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams parameters = base.CreateParams;
            parameters.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
            parameters.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW: no Alt+Tab entry
            return parameters;
        }
    }

    /// <summary>Ask the window manager for rounded corners; false when unsupported.</summary>
    public bool TryRoundCorners()
    {
        try
        {
            int preference = 2; // DWMWCP_ROUND
            int result = DwmSetWindowAttribute(this.Handle, 33, ref preference, sizeof(int));
            return result == 0;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Clip the window shape when the window manager cannot round it.</summary>
    public void ApplyRegion()
    {
        float radius = Radius * UiScale;
        using (GraphicsPath path = Rounded(new RectangleF(0, 0, ClientSize.Width, ClientSize.Height), radius))
        {
            Region = new Region(path);
        }
    }

    private static GraphicsPath Rounded(RectangleF bounds, float radius)
    {
        GraphicsPath path = new GraphicsPath();
        float diameter = Math.Max(1f, Math.Min(radius * 2f, Math.Min(bounds.Width, bounds.Height)));
        path.AddArc(bounds.X, bounds.Y, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Y, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.X, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        float s = UiScale;

        using (SolidBrush surface = new SolidBrush(BackgroundColor))
        {
            g.FillRectangle(surface, ClientRectangle);
        }
        using (Pen edge = new Pen(BorderColor, Math.Max(1f, 1f * s)))
        {
            float inset = Math.Max(0.5f, 0.5f * s);
            g.DrawRectangle(edge, inset, inset, ClientSize.Width - inset * 2f, ClientSize.Height - inset * 2f);
        }

        // Left status pill.
        float pillWidth = 3f * s;
        float pillInset = 12f * s;
        float pillHeight = Math.Max(10f, ClientSize.Height - pillInset * 2f);
        using (GraphicsPath pill = Rounded(new RectangleF(10f * s, pillInset, pillWidth, pillHeight), pillWidth / 2f))
        using (SolidBrush accent = new SolidBrush(AccentColor))
        {
            g.FillPath(accent, pill);
        }

        // Status disc.
        float disc = 30f * s;
        float discX = 24f * s;
        float discY = (ClientSize.Height - disc) / 2f;
        using (SolidBrush halo = new SolidBrush(Color.FromArgb(38, AccentColor)))
        {
            g.FillEllipse(halo, discX, discY, disc, disc);
        }
        using (SolidBrush stroke = new SolidBrush(AccentColor))
        {
            using (Pen ring = new Pen(stroke, Math.Max(1.4f, 1.6f * s)))
            {
                g.DrawEllipse(ring, discX, discY, disc, disc);
            }
        }
        if (GlyphFont != null && !string.IsNullOrEmpty(Glyph))
        {
            using (SolidBrush glyphBrush = new SolidBrush(AccentColor))
            using (StringFormat center = new StringFormat())
            {
                center.Alignment = StringAlignment.Center;
                center.LineAlignment = StringAlignment.Center;
                g.DrawString(Glyph, GlyphFont, glyphBrush, new RectangleF(discX, discY, disc, disc), center);
            }
        }

        // Text block.
        float textX = 24f * s + disc + 14f * s;
        float textWidth = ClientSize.Width - textX - 18f * s;
        bool hasMeta = !string.IsNullOrEmpty(CardMeta);
        float titleHeight = 18f * s;
        float bodyHeight = 26f * s;
        float metaHeight = hasMeta ? 18f * s : 0f;
        float total = titleHeight + bodyHeight + metaHeight;
        float top = (ClientSize.Height - total) / 2f;

        using (StringFormat line = new StringFormat())
        {
            line.Trimming = StringTrimming.EllipsisCharacter;
            line.FormatFlags = StringFormatFlags.NoWrap;
            line.Alignment = StringAlignment.Near;
            line.LineAlignment = StringAlignment.Center;

            if (TitleFont != null && !string.IsNullOrEmpty(CardTitle))
            {
                using (SolidBrush brush = new SolidBrush(TitleColor))
                {
                    g.DrawString(CardTitle, TitleFont, brush, new RectangleF(textX, top, textWidth, titleHeight), line);
                }
            }
            if (BodyFont != null && !string.IsNullOrEmpty(CardBody))
            {
                using (SolidBrush brush = new SolidBrush(BodyColor))
                {
                    g.DrawString(CardBody, BodyFont, brush, new RectangleF(textX, top + titleHeight, textWidth, bodyHeight), line);
                }
            }
            if (hasMeta && MetaFont != null)
            {
                using (SolidBrush brush = new SolidBrush(MetaColor))
                {
                    g.DrawString(CardMeta, MetaFont, brush, new RectangleF(textX, top + titleHeight + bodyHeight, textWidth, metaHeight), line);
                }
            }
        }
    }
}
'@
}

$height = if ([string]::IsNullOrWhiteSpace($Meta)) { 82 } else { 100 }
$width = 372
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

$form = New-Object DshNotifyCard
$form.UiScale = $scale
$form.Radius = 14
$form.CardTitle = $Title
$form.CardBody = $Body
$form.CardMeta = $Meta
$form.Glyph = $glyphs[$Accent]
$form.AccentColor = $accents[$Accent]
$form.BackgroundColor = $palette.Background
$form.BorderColor = $palette.Border
$form.TitleColor = $palette.Title
$form.BodyColor = $palette.Body
$form.MetaColor = $palette.Meta
$form.TitleFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
$form.BodyFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 12.5, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
$form.MetaFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 8.5, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
$form.GlyphFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 10.5, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)

$cardWidth = [int] [Math]::Round($width * $scale)
$cardHeight = [int] [Math]::Round($height * $scale)
$margin = [int] [Math]::Round(16 * $scale)
$gap = [int] [Math]::Round(10 * $scale)

$form.Width = $cardWidth
$form.Height = $cardHeight
$targetLeft = $area.Right - $margin - $cardWidth
$targetTop = $area.Bottom - $margin - $cardHeight - $slot * ($cardHeight + $gap)
if ($targetTop -lt $area.Top) { $targetTop = $area.Top }
$form.Left = $targetLeft
$form.Top = $targetTop + [int] [Math]::Round(14 * $scale)
$form.Opacity = 0.0

$openable = (-not [string]::IsNullOrWhiteSpace($OpenUrl)) -and (-not [string]::IsNullOrWhiteSpace($OpenSession))
if ($openable) { $form.Cursor = [System.Windows.Forms.Cursors]::Hand }
Write-Trace ('openable=' + $openable + ' openUrl=' + $OpenUrl)

# A click always dismisses the card; a card with a target then jumps to its
# conversation once it is gone.
$form.Add_MouseDown({
  param($sender, $eventArgs)
  $script:openRequested = $true
  $form.Close()
})

$script:slide = 0
$slideTimer = New-Object System.Windows.Forms.Timer
$slideTimer.Interval = 16
$slideTimer.Add_Tick({
  $script:slide++
  $progress = [Math]::Min(1.0, $script:slide / 8.0)
  $eased = 1.0 - [Math]::Pow(1.0 - $progress, 3.0)
  $form.Top = [int] [Math]::Round($targetTop + (1.0 - $eased) * 14 * $scale)
  $form.Opacity = [Math]::Min(1.0, 0.25 + 0.75 * $eased)
  if ($progress -ge 1.0) {
    $slideTimer.Stop()
    $form.Opacity = 1.0
  }
})
$form.Add_Shown({
  $rounded = $form.TryRoundCorners()
  if ($rounded -eq $false) { $form.ApplyRegion() }
  Write-Trace ('shown handle=' + $form.Handle + ' visible=' + $form.Visible + ' rounded=' + $rounded +
    ' bounds=' + $form.Left + ',' + $form.Top + ' ' + $form.Width + 'x' + $form.Height)
  $slideTimer.Start()
})

$closeTimer = New-Object System.Windows.Forms.Timer
$closeTimer.Interval = [Math]::Max(1200, $DurationMs)
Write-Trace ('close timer interval=' + $closeTimer.Interval)
$closeTimer.Add_Tick({
  Write-Trace 'close timer fired'
  $closeTimer.Stop()
  $form.Close()
})
if (-not $Sticky) {
  $form.Add_Shown({ $closeTimer.Start() })
}

$form.Add_FormClosed({
  Write-Trace 'closed'
  if ($null -ne $lockFile -and (Test-Path -LiteralPath $lockFile)) {
    Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
  }
})

try {
  Write-Trace ('entering message loop; working area=' + $area.Left + ',' + $area.Top + ' ' + $area.Width + 'x' + $area.Height + ' slot=' + $slot)
  [System.Windows.Forms.Application]::Run($form)
} catch {
  Write-Trace ('failed: ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message)
  throw
} finally {
  $slideTimer.Dispose()
  $closeTimer.Dispose()
  if ($null -ne $lockFile -and (Test-Path -LiteralPath $lockFile)) {
    Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
  }
}

# Sent after the card is gone, so the jump happens with the card out of the way.
if ($script:openRequested) {
  Send-OpenRequest
}
