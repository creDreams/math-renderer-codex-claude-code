param(
    [Parameter(Mandatory = $true)][string]$WindowTitle,
    [Parameter(Mandatory = $true)][string]$OutputPath
)

# Research only: read a specifically named, disposable terminal window.
# Never reads unrelated desktop windows or writes to the terminal stream.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class MathProbeWindow {
    private delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder value, int max);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    public static IntPtr Find(string title) {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
            var value = new StringBuilder(1024);
            GetWindowText(hwnd, value, value.Capacity);
            if (value.ToString() == title) { result = hwnd; return false; }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
'@
[void][MathProbeWindow]::SetProcessDpiAwarenessContext([IntPtr](-4))
function Find-Literal($range, [string]$needle) {
    try {
        $found = $range.FindText($needle, $false, $false)
        if ($found -and $found.GetText($needle.Length) -eq $needle) { return $found }
    } catch { }
    return $null
}
$windowHandle = [MathProbeWindow]::Find($WindowTitle)
if ($windowHandle -eq [IntPtr]::Zero) { throw "Probe window not found: $WindowTitle" }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($windowHandle)
$condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty, $true)
$elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
$reports = @()
function Convert-Rectangles($rectangles) {
    @($rectangles | ForEach-Object { @{ x = $_.X; y = $_.Y; width = $_.Width; height = $_.Height } })
}
foreach ($element in $elements) {
    if ($element.Current.ClassName -ne 'TermControl') { continue }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    $document = $pattern.DocumentRange
    $text = $document.GetText(12000)
    $visibleRanges = $pattern.GetVisibleRanges()
    $visible = @($visibleRanges | ForEach-Object {
        @{ text = $_.GetText(65536); rectangles = @(Convert-Rectangles $_.GetBoundingRectangles()) }
    })
    $physicalLines = @()
    if ($visibleRanges.Length -eq 1) {
        $scope = $visibleRanges[0]
        $cursor = $scope.Clone()
        $cursor.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,
            $scope, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
        for ($row = 0; $row -lt 300; $row++) {
            $line = $cursor.Clone()
            $line.ExpandToEnclosingUnit([System.Windows.Automation.Text.TextUnit]::Line)
            if ($line.CompareEndpoints([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start,
                $scope, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start) -lt 0) {
                $line.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start,
                    $scope, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
            }
            if ($line.CompareEndpoints([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,
                $scope, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End) -gt 0) {
                $line.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,
                    $scope, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End)
            }
            if ($line.CompareEndpoints([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start,
                $cursor, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start) -ne 0) { break }
            $physicalLines += @{ text = $line.GetText(65536); rectangles = @(Convert-Rectangles $line.GetBoundingRectangles()) }
            if ($line.CompareEndpoints([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,
                $scope, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End) -ge 0) { break }
            if ($line.CompareEndpoints([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,
                $cursor, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start) -le 0) { break }
            $cursor.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start,
                $line, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End)
            $cursor.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,
                $line, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End)
        }
    }
    $formulaReport = $null
    $findError = $null
    try {
        $delimiter = '\['
        $visibleText = if ($visibleRanges.Length -gt 0) { $visibleRanges[0].GetText(65536) } else { '' }
        $formula = if ($visibleText.Contains($delimiter)) { Find-Literal $visibleRanges[0] $delimiter } else { $null }
        if (-not $formula -and $visibleRanges.Length -gt 0) {
            $delimiter = '$$'
            $formula = Find-Literal $visibleRanges[0] $delimiter
        }
        if ($formula) {
            $remaining = $visibleRanges[0].Clone()
            $remaining.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start,
                $formula, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End)
            $tail = Find-Literal $remaining $(if ($delimiter -eq '\[') { '\]' } else { '$$' })
            if ($tail) {
                $formula.MoveEndpointByRange(
                    [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,
                    $tail, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End)
                $formulaReport = @{
                    text = $formula.GetText(8192)
                    rectangles = @(Convert-Rectangles $formula.GetBoundingRectangles())
                    background = $formula.GetAttributeValue([System.Windows.Automation.TextPattern]::BackgroundColorAttribute)
                    foreground = $formula.GetAttributeValue([System.Windows.Automation.TextPattern]::ForegroundColorAttribute)
                    fontSize = $formula.GetAttributeValue([System.Windows.Automation.TextPattern]::FontSizeAttribute)
                }
            }
        }
    } catch { $findError = $_.Exception.Message }
    $selection = @($pattern.GetSelection() | ForEach-Object { $_.GetText(2048) })
    $watch.Stop()
    $bounds = $element.Current.BoundingRectangle
    $reports += @{
        name = $element.Current.Name
        automationId = $element.Current.AutomationId
        controlType = $element.Current.ControlType.ProgrammaticName
        className = $element.Current.ClassName
        frameworkId = $element.Current.FrameworkId
        offscreen = $element.Current.IsOffscreen
        bounds = @{ x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height }
        text = $text
        visible = $visible
        physicalLines = $physicalLines
        formula = $formulaReport
        findError = $findError
        selection = $selection
        readMilliseconds = $watch.Elapsed.TotalMilliseconds
    }
}
$report = @{
    windowTitle = $WindowTitle
    hwnd = $windowHandle.ToInt64()
    foregroundHwnd = [MathProbeWindow]::GetForegroundWindow().ToInt64()
    capturedAt = [DateTime]::UtcNow.ToString('o')
    elements = $reports
    controls = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object {
        @{ name = $_.Current.Name; className = $_.Current.ClassName; id = $_.Current.AutomationId;
           offscreen = $_.Current.IsOffscreen; focused = $_.Current.HasKeyboardFocus; type = $_.Current.ControlType.ProgrammaticName }
    })
}
$json = $report | ConvertTo-Json -Depth 12
[IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputPath), $json, (New-Object Text.UTF8Encoding($false)))
@{ hwnd = $report.hwnd; elements = @($reports | ForEach-Object {
    @{ className = $_.className; textLength = $_.text.Length; formula = $_.formula; findError = $_.findError; readMilliseconds = $_.readMilliseconds }
}) } | ConvertTo-Json -Depth 8
