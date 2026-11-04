param(
    [ValidateSet('remember','restore','crop','compose')][string]$Action,
    [string]$WindowTitle, [string]$WorkDirectory, [string]$OutputPath,
    [string]$PairName, [string]$EndNeedle, [string]$BeforePath, [string]$AfterPath, [string]$Label
)
$ErrorActionPreference = 'Stop'
if (-not $WindowTitle.StartsWith('AgentMathResearch-Showcase-')) { throw 'Only disposable showcase windows are allowed' }
Add-Type -AssemblyName System.Drawing,UIAutomationClient,UIAutomationTypes,WindowsBase
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ShowcaseNative {
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
 delegate bool EnumProc(IntPtr hwnd, IntPtr data);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
 [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
 [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr target, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, uint operation);
 public static IntPtr Find(string title) {
  IntPtr found=IntPtr.Zero;
  EnumWindows(delegate(IntPtr hwnd, IntPtr data) { var text=new StringBuilder(1024); GetWindowText(hwnd,text,text.Capacity); if(text.ToString()==title){found=hwnd;return false;} return true; },IntPtr.Zero);
  return found;
 }
}
'@
[void][ShowcaseNative]::SetProcessDpiAwarenessContext([IntPtr](-4))
$statePath = Join-Path $WorkDirectory 'desktop-state.json'
if ($Action -eq 'remember') {
    $cursor = New-Object ShowcaseNative+Point
    [void][ShowcaseNative]::GetCursorPos([ref]$cursor)
    @{ window=[ShowcaseNative]::GetForegroundWindow().ToInt64(); x=$cursor.X; y=$cursor.Y } | ConvertTo-Json | Set-Content -Encoding UTF8 $statePath
    return
}
if ($Action -eq 'restore') {
    $state = Get-Content -Encoding UTF8 -Raw $statePath | ConvertFrom-Json
    [void][ShowcaseNative]::SetCursorPos($state.x,$state.y)
    [void][ShowcaseNative]::SetForegroundWindow([IntPtr]$state.window)
    return
}
if ($Action -eq 'compose') {
    $before = [Drawing.Bitmap]::FromFile($BeforePath)
    $after = [Drawing.Bitmap]::FromFile($AfterPath)
    if ($before.Size -ne $after.Size) { throw 'Comparison screenshots must have identical geometry' }
    $padding = 20; $heading = 64
    $image = New-Object Drawing.Bitmap(($before.Width+2*$padding),($before.Height*2+2*$heading+3*$padding))
    $graphics = [Drawing.Graphics]::FromImage($image)
    $font = New-Object Drawing.Font('Segoe UI',17,[Drawing.FontStyle]::Bold)
    $small = New-Object Drawing.Font('Segoe UI',12)
    $muted = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(170,180,192))
    try {
        $graphics.Clear([Drawing.Color]::FromArgb(17,23,32))
        $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $graphics.DrawString('WITHOUT ADD-ON',$font,[Drawing.Brushes]::White,$padding,$padding)
        $graphics.DrawString($Label,$small,$muted,$padding,($padding+33))
        $graphics.DrawImageUnscaled($before,$padding,($padding+$heading))
        $second = $padding*2+$heading+$before.Height
        $graphics.DrawString('WITH ADD-ON',$font,[Drawing.Brushes]::White,$padding,$second)
        $graphics.DrawString($Label,$small,$muted,$padding,($second+33))
        $graphics.DrawImageUnscaled($after,$padding,($second+$heading))
        $image.Save($OutputPath,[Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $image.Dispose(); $font.Dispose(); $small.Dispose(); $muted.Dispose(); $before.Dispose(); $after.Dispose() }
    return
}
if ($PairName -notmatch '^(codex|claude)$') { throw 'Unknown comparison pair' }
$target = [ShowcaseNative]::Find($WindowTitle)
if ($target -eq [IntPtr]::Zero -or [ShowcaseNative]::GetForegroundWindow() -ne $target) { throw 'Showcase window must be foreground' }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($target)
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty,'TermControl')
$pane = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
$pattern = $pane.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
$visible = $pattern.GetVisibleRanges()[0]
$text = $visible.GetText(65536)
$endRange = $visible.FindText($EndNeedle,$false,$false)
if (-not $endRange -or $endRange.GetText($EndNeedle.Length) -ne $EndNeedle) { throw 'Complete demo is not visible' }
$rects = $endRange.GetBoundingRectangles()
if ($rects.Length -lt 1) { throw 'Demo endpoint has no visible geometry' }
$bounds = $pane.Current.BoundingRectangle
$bottom = ($rects | Measure-Object -Property Bottom -Maximum).Maximum
$crop = @{ x=[int]$bounds.X; y=[int]$bounds.Y; width=[int]$bounds.Width; height=[int][Math]::Min($bounds.Height,($bottom-$bounds.Y+16)) }
$pairFile = Join-Path $WorkDirectory ($PairName+'-source.json')
if (Test-Path -LiteralPath $pairFile) {
    $before = Get-Content -Encoding UTF8 -Raw $pairFile | ConvertFrom-Json
    if ($before.text -cne $text -or $before.crop.x -ne $crop.x -or $before.crop.y -ne $crop.y -or $before.crop.width -ne $crop.width -or $before.crop.height -ne $crop.height) { throw 'Source text or viewport changed between screenshots' }
} else {
    @{ text=$text; crop=$crop } | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $pairFile
}
$image = New-Object Drawing.Bitmap($crop.width,$crop.height)
$graphics = [Drawing.Graphics]::FromImage($image)
$screen = [ShowcaseNative]::GetDC([IntPtr]::Zero)
$dc = $graphics.GetHdc()
try {
    if (-not [ShowcaseNative]::BitBlt($dc,0,0,$image.Width,$image.Height,$screen,$crop.x,$crop.y,0x40CC0020)) { throw 'Screen capture failed' }
} finally { $graphics.ReleaseHdc($dc); [void][ShowcaseNative]::ReleaseDC([IntPtr]::Zero,$screen); $graphics.Dispose() }
try { $image.Save($OutputPath,[Drawing.Imaging.ImageFormat]::Png) } finally { $image.Dispose() }
