param(
    [Parameter(Mandatory=$true)][string]$WindowTitle,
    [Parameter(Mandatory=$true)][string]$Binary,
    [Parameter(Mandatory=$true)][string]$InputPath,
    [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
if (-not $WindowTitle.StartsWith('AgentMathResearch-')) { throw 'Only disposable research windows may be read' }
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase,System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class MathBackgroundWindow {
 delegate bool EnumProc(IntPtr hwnd, IntPtr data);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc call, IntPtr data);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
 public static IntPtr Find(string title) {
  IntPtr found=IntPtr.Zero;
  EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
   var text=new StringBuilder(1024); GetWindowText(hwnd,text,text.Capacity);
   if(text.ToString()==title) { found=hwnd; return false; } return true;
  }, IntPtr.Zero); return found;
 }
}
'@
[void][MathBackgroundWindow]::SetProcessDpiAwarenessContext([IntPtr](-4))
$target = [MathBackgroundWindow]::Find($WindowTitle)
if ($target -eq [IntPtr]::Zero) { throw 'Research window missing' }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($target)
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty,'TermControl')
$pane = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
$pattern = $pane.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
$visible = $pattern.GetVisibleRanges()[0]
$data = [IO.File]::ReadAllText([IO.Path]::GetFullPath($InputPath)) | ConvertFrom-Json
$assembly = [Reflection.Assembly]::LoadFrom([IO.Path]::GetFullPath($Binary))
$reader = $assembly.GetType('AgentMath.UiaObserver').GetMethod('ReadDisplayBackground',[Reflection.BindingFlags]'NonPublic,Static')
$checks = @()
foreach ($formula in $data.formulae) {
    $start = [string]$formula.start; $end = [string]$formula.end
    $range = $visible.FindText($start,$false,$false)
    $tail = $visible.FindText($end,$false,$false)
    if (-not $range -or $range.GetText($start.Length) -ne $start -or
        -not $tail -or $tail.GetText($end.Length) -ne $end) { throw "Formula anchors not found: $start" }
    $rects = $range.GetBoundingRectangles(); $ends = $tail.GetBoundingRectangles()
    $first = $rects[0]; $last = $ends[$ends.Length-1]
    $before = [int]$formula.padBefore; $after = [int]$formula.padAfter
    $one = [Drawing.Rectangle]::FromLTRB([int]$first.Left,[int]($first.Top-$before*$first.Height),[int]$first.Right,[int]($first.Bottom-$before*$first.Height))
    $two = [Drawing.Rectangle]::FromLTRB([int]$last.Left,[int]($last.Top+$after*$last.Height),[int]$last.Right,[int]($last.Bottom+$after*$last.Height))
    $invoke = [object[]]@($pattern,$visible,$one,$two,[string]$data.background,$false)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $available = $reader.Invoke($null,$invoke)
    $watch.Stop()
    $checks += @{ available=$available; clear=$invoke[5]; physicalRows=[int](1+($last.Top-$first.Top)/$first.Height); elapsedMs=$watch.Elapsed.TotalMilliseconds }
}
$result = @{ checks=$checks; nativeSelectionChars=(@($pattern.GetSelection() | ForEach-Object { $_.GetText(500).Length }) | Measure-Object -Sum).Sum }
[IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputPath),($result | ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding($false)))
