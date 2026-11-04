param(
    [Parameter(Mandatory = $true)][string]$WindowTitle,
    [Parameter(Mandatory = $true)][string]$InputPath,
    [Parameter(Mandatory = $true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
if (-not $WindowTitle.StartsWith('AgentMathResearch')) { throw 'Only disposable research windows are allowed' }
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class InlineProbeWindow {
    delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    public static IntPtr Find(string title) {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
            var text = new StringBuilder(1024); GetWindowText(hwnd, text, text.Capacity);
            if (text.ToString() == title) { result = hwnd; return false; } return true;
        }, IntPtr.Zero); return result;
    }
}
'@
[void][InlineProbeWindow]::SetProcessDpiAwarenessContext([IntPtr](-4))
$target = [InlineProbeWindow]::Find($WindowTitle)
if ($target -eq [IntPtr]::Zero) { throw 'Research window not found' }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($target)
$pane = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'TermControl')))
$pattern = $pane.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
$visible = $pattern.GetVisibleRanges()[0]
$visibleText = $visible.GetText(65536)
$physicalLines = $visibleText.Split(@("`r`n", "`n"), [StringSplitOptions]::None)
$physicalRows = $visible.GetBoundingRectangles()
$inputData = Get-Content -Raw -Encoding UTF8 -LiteralPath $InputPath | ConvertFrom-Json
function Find-Literal($scope, [string]$text) {
    try {
        $match = $scope.FindText($text, $false, $false)
        if ($match -and $match.GetText($text.Length) -eq $text) { return $match }
    } catch { }
    return $null
}
$spans = @()
foreach ($needle in $inputData.needles) {
    $remaining = $visible.Clone()
    $found = @()
    for ($i = 0; $i -lt 32; $i++) {
        $range = Find-Literal $remaining ([string]$needle)
        if (-not $range) { break }
        if ($range.GetText(([string]$needle).Length) -ne $needle) { break }
        $rawRect = $range.GetBoundingRectangles()[0]
        $rowIndex = -1
        for ($r = 0; $r -lt $physicalRows.Length; $r++) { if ([Math]::Abs($physicalRows[$r].Y - $rawRect.Y) -lt 1) { $rowIndex = $r; break } }
        if ($rowIndex -lt 0) { throw 'Range is outside visible rows' }
        $line = $physicalLines[$rowIndex]
        # Use starts of verified suffix ranges as exclusive boundaries. Unlike
        # FindText's end, these remain exact before fullwidth punctuation.
        $column = $line.IndexOf([string]$needle, [StringComparison]::Ordinal)
        if ($found.Count -gt 0 -and $found[-1].rectangles[0].y -eq $rawRect.Y) {
            $column = $line.IndexOf([string]$needle, $found[-1].column + ([string]$needle).Length, [StringComparison]::Ordinal)
        }
        $tail = $line.Substring($column + ([string]$needle).Length).TrimEnd()
        $endX = $physicalRows[$rowIndex].Right
        if ($tail.Length -gt 0) {
            $tailRange = Find-Literal $visible $tail
            if (-not $tailRange -or $tailRange.GetText($tail.Length) -ne $tail) { throw 'Cannot verify suffix' }
            $tailRects = $tailRange.GetBoundingRectangles()
            # Padded suffixes are unique at their physical row; a shorter
            # suffix can repeat in other rows, so enumerate until the same row.
            for ($seek = 0; $seek -lt 300 -and [Math]::Abs($tailRects[0].Y - $rawRect.Y) -ge 1; $seek++) {
                $tailSearch = $visible.Clone()
                $tailSearch.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start,
                    $tailRange, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End)
                $tailRange = Find-Literal $tailSearch $tail
                if (-not $tailRange -or $tailRange.GetText($tail.Length) -ne $tail) { throw 'Cannot locate suffix on expected row' }
                $tailRects = $tailRange.GetBoundingRectangles()
            }
            $endX = $tailRects[0].X
        }
        $found += @{
            text = $range.GetText(([string]$needle).Length)
            providerText = $range.GetText(4096)
            column = $column
            prefix = $range.GetText(([string]$needle).Length)
            fontName = $range.GetAttributeValue([System.Windows.Automation.TextPattern]::FontNameAttribute)
            fontSize = $range.GetAttributeValue([System.Windows.Automation.TextPattern]::FontSizeAttribute)
            rectangles = @(@{ x = $rawRect.X; y = $rawRect.Y; width = $endX - $rawRect.X; height = $rawRect.Height })
        }
        $remaining.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start,
            $range, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End)
    }
    $spans += @{ needle = $needle; matches = $found }
}
$result = @{ spans = $spans; text = $visible.GetText(65536); rows = @($visible.GetBoundingRectangles() | ForEach-Object {
    @{ x = $_.X; y = $_.Y; width = $_.Width; height = $_.Height }
}) }
[IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputPath), ($result | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
