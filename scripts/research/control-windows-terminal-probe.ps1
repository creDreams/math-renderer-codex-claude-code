param(
    [Parameter(Mandatory = $true)][string]$WindowTitle,
    [ValidateSet('capture', 'overlay-order', 'move', 'resize', 'select', 'select-inline', 'select-outside', 'hover-inline', 'click-inline', 'drag-inline', 'click-formula', 'click-outside', 'clear-selection', 'minimize', 'restore', 'focus', 'scroll-top', 'scroll-bottom', 'scroll-formulas', 'scroll-formulas-bottom', 'scroll-sequence', 'wheel-up', 'wheel-down', 'palette', 'search', 'escape', 'close-pane', 'focus-up', 'drag-formula', 'input', 'prompt', 'finish-codex')][string]$Action,
    [string]$InputPath,
    [string]$OutputPath = 'test-results/wt-overlay-screen.png',
    [int]$X = 250, [int]$Y = 250, [int]$Width = 1200, [int]$Height = 800,
    [ValidateRange(120,3600)][int]$WheelDelta = 3600,
    [ValidateRange(0,200)][int]$RowOffset = 0
)
$ErrorActionPreference = 'Stop'
if (-not $WindowTitle.StartsWith('AgentMathResearch')) { throw 'Only disposable research windows are allowed' }
Add-Type -AssemblyName System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes, WindowsBase
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class MathResearchControl {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect value);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("gdi32.dll", SetLastError = true)] public static extern bool BitBlt(IntPtr target, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, uint operation);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint thread, uint otherThread, bool attach);
    public static bool ActivateResearchWindow(IntPtr target) {
        uint pid;
        uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        uint currentThread = GetCurrentThreadId();
        bool attached = foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
        try { return SetForegroundWindow(target); }
        finally { if (attached) AttachThreadInput(currentThread, foregroundThread, false); }
    }
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] public static extern bool GetPhysicalCursorPos(out Point point);
    [DllImport("user32.dll")] public static extern bool SetPhysicalCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    public static object OverlayOrder(IntPtr owner) {
        int order = 0, ownerOrder = -1;
        var overlays = new System.Collections.Generic.List<int>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
            int index = order++;
            if (hwnd == owner) ownerOrder = index;
            if (GetWindow(hwnd, 4) == owner && IsWindowVisible(hwnd)) {
                uint pid; GetWindowThreadProcessId(hwnd, out pid);
                try { if (System.Diagnostics.Process.GetProcessById((int)pid).ProcessName == "AgentMath") overlays.Add(index); }
                catch { }
            }
            return true;
        }, IntPtr.Zero);
        return new { ownerOrder = ownerOrder, overlays = overlays.ToArray() };
    }
    [StructLayout(LayoutKind.Explicit, Size = 40)] public struct Input {
        [FieldOffset(0)] public uint Type;
        [FieldOffset(8)] public ushort Key;
        [FieldOffset(10)] public ushort Scan;
        [FieldOffset(12)] public uint Flags;
    }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
    public static void UnicodeText(string value) {
        // Unicode input bypasses the user's active IME without changing its setting or clipboard.
        foreach (char ch in value) {
            var inputs = new Input[] { new Input { Type = 1, Scan = ch, Flags = 4 }, new Input { Type = 1, Scan = ch, Flags = 6 } };
            if (SendInput(2, inputs, 40) != 2) throw new Exception("Unicode input failed");
        }
    }
    public static IntPtr Find(string title) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
            var text = new StringBuilder(1024); GetWindowText(hwnd, text, text.Capacity);
            if (text.ToString() == title) { found = hwnd; return false; } return true;
        }, IntPtr.Zero); return found;
    }
    public static void Wheel(int delta) { mouse_event(0x800, 0, 0, unchecked((uint)delta), UIntPtr.Zero); }
}
'@
[void][MathResearchControl]::SetProcessDpiAwarenessContext([IntPtr](-4))
function Find-Literal($range, [string]$needle) {
    try {
        $found = $range.FindText($needle, $false, $false)
        if ($found -and $found.GetText($needle.Length) -eq $needle) { return $found }
    } catch { }
    return $null
}
$target = [MathResearchControl]::Find($WindowTitle)
if ($target -eq [IntPtr]::Zero) { throw 'Named disposable window not found' }
switch ($Action) {
    'overlay-order' { [MathResearchControl]::OverlayOrder($target) | ConvertTo-Json }
    { $_ -in 'palette','search','escape','close-pane','focus-up' } {
        if ([MathResearchControl]::GetForegroundWindow() -ne $target) { throw 'Research terminal is not foreground' }
        $chords = @{ palette = @(0x11, 0x10, 0x50); search = @(0x11, 0x10, 0x46);
                     escape = @(0x1B); 'close-pane' = @(0x11, 0x10, 0x57); 'focus-up' = @(0x12, 0x26) }
        $chord = $chords[$Action]
        try {
            foreach ($key in $chord) {
                [MathResearchControl]::keybd_event([byte]$key, 0, 0, [UIntPtr]::Zero)
                Start-Sleep -Milliseconds 25
            }
        } finally {
            for ($keyIndex = $chord.Length - 1; $keyIndex -ge 0; $keyIndex--) {
                [MathResearchControl]::keybd_event([byte]$chord[$keyIndex], 0, 2, [UIntPtr]::Zero)
            }
        }
        if ($Action -eq 'search') {
            Start-Sleep -Milliseconds 250
            if ([System.Windows.Automation.AutomationElement]::FocusedElement.Current.ClassName -eq 'TermControl') {
                # A user's Find shortcut can be unavailable. Invoke the existing
                # command from the palette without modifying terminal settings.
                [System.Windows.Forms.SendKeys]::SendWait('^+p')
                Start-Sleep -Milliseconds 300
                [MathResearchControl]::UnicodeText('Find')
                Start-Sleep -Milliseconds 300
                $root = [System.Windows.Automation.AutomationElement]::FromHandle($target)
                $label = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
                    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Find')))
                if (-not $label) { throw 'Find command is unavailable in the research terminal' }
                $item = $label
                while ($item -and $item.Current.ControlType -ne [System.Windows.Automation.ControlType]::ListItem) {
                    $item = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($item)
                }
                if (-not $item) { throw 'Find command list item is unavailable' }
                $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
                [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
            }
        }
    }
    { $_ -in 'wheel-up','wheel-down' } {
        if ([MathResearchControl]::GetForegroundWindow() -ne $target) { throw 'Research terminal is not foreground' }
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($target)
        $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'TermControl')
        $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
        $rect = $element.Current.BoundingRectangle
        $saved = New-Object MathResearchControl+Point
        [void][MathResearchControl]::GetPhysicalCursorPos([ref]$saved)
        try {
            [void][MathResearchControl]::SetPhysicalCursorPos([int]($rect.X + $rect.Width / 2), [int]($rect.Y + $rect.Height / 2))
            [MathResearchControl]::Wheel($(if ($Action -eq 'wheel-up') { $WheelDelta } else { -$WheelDelta }))
        } finally { [void][MathResearchControl]::SetPhysicalCursorPos($saved.X, $saved.Y) }
    }
    'capture' {
        $bounds = New-Object MathResearchControl+Rect
        [void][MathResearchControl]::GetWindowRect($target, [ref]$bounds)
        $bitmap = New-Object Drawing.Bitmap(($bounds.Right - $bounds.Left), ($bounds.Bottom - $bounds.Top))
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $screenDc = [MathResearchControl]::GetDC([IntPtr]::Zero)
        $bitmapDc = $graphics.GetHdc()
        try {
            # CAPTUREBLT includes the companion's layered formula windows.
            if (-not [MathResearchControl]::BitBlt($bitmapDc, 0, 0, $bitmap.Width, $bitmap.Height, $screenDc, $bounds.Left, $bounds.Top, 0x40CC0020)) {
                throw 'Research screenshot capture failed'
            }
        } finally {
            $graphics.ReleaseHdc($bitmapDc)
            [void][MathResearchControl]::ReleaseDC([IntPtr]::Zero, $screenDc)
            $graphics.Dispose()
        }
        try { $bitmap.Save([IO.Path]::GetFullPath($OutputPath), [Drawing.Imaging.ImageFormat]::Png) }
        finally { $bitmap.Dispose() }
    }
    'move' { [void][MathResearchControl]::SetWindowPos($target, [IntPtr]::Zero, $X, $Y, 0, 0, 0x15) }
    'resize' { [void][MathResearchControl]::SetWindowPos($target, [IntPtr]::Zero, 0, 0, $Width, $Height, 0x16) }
    'minimize' { [void][MathResearchControl]::ShowWindow($target, 6) }
    'restore' { [void][MathResearchControl]::ShowWindow($target, 9) }
    'focus' {
        [void][MathResearchControl]::ShowWindow($target, 9)
        [void][MathResearchControl]::SetForegroundWindow($target)
        if ([MathResearchControl]::GetForegroundWindow() -ne $target) {
            [void][MathResearchControl]::ActivateResearchWindow($target)
        }
        if ([MathResearchControl]::GetForegroundWindow() -ne $target) {
            $researchRoot = [System.Windows.Automation.AutomationElement]::FromHandle($target)
            $researchCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'TermControl')
            $researchPane = $researchRoot.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $researchCondition)
            if ($researchPane) { $researchPane.SetFocus() }
        }
        for ($attempt = 0; $attempt -lt 10 -and [MathResearchControl]::GetForegroundWindow() -ne $target; $attempt++) {
            Start-Sleep -Milliseconds 50
        }
        if ([MathResearchControl]::GetForegroundWindow() -ne $target) {
            # OS foreground-lock fallback, confined to our disposable window.
            # Verify hit-test ownership before a physical caption click; never
            # click through another application or send a global keyboard chord.
            $bounds = New-Object MathResearchControl+Rect
            $saved = New-Object MathResearchControl+Point
            [void][MathResearchControl]::GetWindowRect($target, [ref]$bounds)
            [void][MathResearchControl]::GetPhysicalCursorPos([ref]$saved)
            try {
                [void][MathResearchControl]::SetWindowPos($target, [IntPtr](-1), 0, 0, 0, 0, 0x13)
                Start-Sleep -Milliseconds 100
                $point = New-Object MathResearchControl+Point
                $point.X = [int](($bounds.Left + $bounds.Right) / 2); $point.Y = $bounds.Top + 15
                if ([MathResearchControl]::GetAncestor([MathResearchControl]::WindowFromPoint($point), 2) -eq $target) {
                    [void][MathResearchControl]::SetPhysicalCursorPos($point.X, $point.Y)
                    [MathResearchControl]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
                    [MathResearchControl]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
                    Start-Sleep -Milliseconds 150
                }
            } finally {
                [void][MathResearchControl]::SetWindowPos($target, [IntPtr](-2), 0, 0, 0, 0, 0x13)
                [void][MathResearchControl]::SetPhysicalCursorPos($saved.X, $saved.Y)
            }
        }
        if ([MathResearchControl]::GetForegroundWindow() -ne $target) {
            $detail = @{ target = $target.ToInt64(); foreground = [MathResearchControl]::GetForegroundWindow().ToInt64();
                captionHit = [MathResearchControl]::GetAncestor([MathResearchControl]::WindowFromPoint($point), 2).ToInt64();
                captionX = $point.X; captionY = $point.Y; bounds = $bounds }
            throw ('Research terminal could not acquire foreground: ' + ($detail | ConvertTo-Json -Compress))
        }
    }
    default {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($target)
        $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'TermControl')
        $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
        if ($Action -eq 'prompt') {
            if ($WindowTitle -ne 'AgentMathResearch-LiveCodex' -or [MathResearchControl]::GetForegroundWindow() -ne $target) { throw 'Only the foreground disposable Codex test may receive a prompt' }
            $promptText = [IO.File]::ReadAllText([IO.Path]::GetFullPath($InputPath)).Trim()
            if ($promptText.Length -gt 2000 -or $promptText.Contains("`n")) { throw 'Expected one short test prompt' }
            [MathResearchControl]::UnicodeText($promptText)
            # Let Codex finish grouping the Unicode burst as pasted text before
            # Enter. Otherwise Enter can be absorbed into that same paste.
            Start-Sleep -Milliseconds 1000
            [MathResearchControl]::keybd_event(0x0D, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 40
            [MathResearchControl]::keybd_event(0x0D, 0, 2, [UIntPtr]::Zero)
            break
        }
        if ($Action -eq 'finish-codex') {
            if ([MathResearchControl]::GetForegroundWindow() -ne $target) { throw 'Research terminal is not foreground' }
            $shellVisible = $false
            for ($attempt = 0; $attempt -lt 3; $attempt++) {
                [System.Windows.Forms.SendKeys]::SendWait('^c')
                Start-Sleep -Milliseconds 450
                $shellVisible = $pattern.GetVisibleRanges()[0].GetText(16000) -match '(?m)^PS\s+[^\r\n]+>'
                if ($shellVisible) { break }
            }
            if ($shellVisible) {
                [MathResearchControl]::UnicodeText('exit')
                [MathResearchControl]::keybd_event(0x0D, 0, 0, [UIntPtr]::Zero)
                [MathResearchControl]::keybd_event(0x0D, 0, 2, [UIntPtr]::Zero)
            }
            for ($closing = 0; $closing -lt 30 -and [MathResearchControl]::IsWindow($target); $closing++) {
                Start-Sleep -Milliseconds 100
            }
            @{ codexExitedWithCtrlC = $shellVisible; researchWindowClosed = -not [MathResearchControl]::IsWindow($target) } | ConvertTo-Json
            break
        }
        if ($Action -eq 'scroll-top' -or $Action -eq 'scroll-bottom') {
            $pattern.DocumentRange.ScrollIntoView($Action -eq 'scroll-top')
            break
        }
        if ($Action -in 'scroll-formulas','scroll-formulas-bottom','scroll-sequence') {
            $sample = [IO.File]::ReadAllText($(if ($InputPath) { [IO.Path]::GetFullPath($InputPath) } else { Join-Path $PSScriptRoot '../../tests/fixtures/ssd-answer.json' })) | ConvertFrom-Json
            $needles = if ($Action -eq 'scroll-sequence') { $sample.anchors } elseif ($InputPath) { @($sample.anchor) } else { @($sample.excerpt.Split("`n")[0]) }
            # Resolve search ranges before timing the viewport changes. UIA
            # FindText traversal is separate from rendering after a scroll.
            $anchors = @()
            foreach ($needle in $needles) {
                $anchor = Find-Literal $pattern.DocumentRange $needle
                if (-not $anchor) { throw 'Historical fixture anchor not found' }
                if ($RowOffset -gt 0) {
                    $anchor = $anchor.Clone()
                    [void]$anchor.MoveEndpointByUnit([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start,
                        [System.Windows.Automation.Text.TextUnit]::Line, -$RowOffset)
                }
                $anchors += $anchor
            }
            $startedAt = [DateTime]::UtcNow
            foreach ($anchor in $anchors) {
                $anchor.ScrollIntoView($Action -ne 'scroll-formulas-bottom')
                if ($Action -eq 'scroll-sequence') { Start-Sleep -Milliseconds 35 }
            }
            @{ scrolledAt = $startedAt.ToString('o'); finishedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
            break
        }
        if ($Action -eq 'input') {
            if ([MathResearchControl]::GetForegroundWindow() -ne $target) { throw 'Research terminal is not foreground' }
            $before = $pattern.DocumentRange.GetText(16000)
            foreach ($character in 'amtinputcheck'.ToCharArray()) {
                [MathResearchControl]::UnicodeText([string]$character)
                Start-Sleep -Milliseconds 50
            }
            Start-Sleep -Milliseconds 250
            $received = $pattern.DocumentRange.GetText(16000).Contains('amtinputcheck')
            [System.Windows.Forms.SendKeys]::SendWait('{LEFT}{RIGHT}')
            for ($delete = 0; $delete -lt 13; $delete++) {
                [System.Windows.Forms.SendKeys]::SendWait('{BACKSPACE}')
                Start-Sleep -Milliseconds 50
            }
            Start-Sleep -Milliseconds 250
            @{ typedTextVisible = $received; originalTextRestored = ($pattern.DocumentRange.GetText(16000) -eq $before); enterSent = $false } | ConvertTo-Json
            break
        }
        $find = if ($Action -in 'select-outside','click-outside') { 'regular text' } else { '\[' }
        if ($Action -in 'select-inline','hover-inline','click-inline','drag-inline' -or ($Action -eq 'clear-selection' -and $InputPath)) { $find = [string](([IO.File]::ReadAllText($InputPath) | ConvertFrom-Json).selectionNeedle) }
        $visibleText = $pattern.GetVisibleRanges()[0].GetText(65536)
        $range = if ($visibleText.Contains($find)) { Find-Literal $pattern.GetVisibleRanges()[0] $find } else { $null }
        if (-not $range -and $find -eq '\[') {
            $find = '$$'
            $range = Find-Literal $pattern.GetVisibleRanges()[0] $find
        }
        if ($find -in @('\[', '$$')) {
            # A real Codex prompt may quote the same TeX. Target an actual
            # display delimiter on its own line, rather than the prompt example.
            $remaining = $pattern.GetVisibleRanges()[0].Clone()
            while ($range) {
                $line = $range.Clone()
                $line.ExpandToEnclosingUnit([System.Windows.Automation.Text.TextUnit]::Line)
                if ($line.GetText(8192).Trim() -eq $find) { break }
                $remaining.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start,
                    $range, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End)
                $range = Find-Literal $remaining $find
            }
        }
        if (-not $range) { throw 'Formula not found for selection probe' }
        if ($Action -in 'click-formula','click-outside','click-inline','hover-inline') {
            if ([MathResearchControl]::GetForegroundWindow() -ne $target) { throw 'Research terminal is not foreground' }
            $rect = $range.GetBoundingRectangles()[0]
            $saved = New-Object MathResearchControl+Point
            [void][MathResearchControl]::GetPhysicalCursorPos([ref]$saved)
            try {
                [void][MathResearchControl]::SetPhysicalCursorPos([int]($rect.X + $rect.Width / 2), [int]($rect.Y + $rect.Height / 2))
                Start-Sleep -Milliseconds 100
                if ($Action -ne 'hover-inline') { [MathResearchControl]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero) }
                Start-Sleep -Milliseconds 700
            } finally {
                if ($Action -ne 'hover-inline') { [MathResearchControl]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) }
                Start-Sleep -Milliseconds 100
                [void][MathResearchControl]::SetPhysicalCursorPos($saved.X, $saved.Y)
            }
            break
        }
        if ($Action -eq 'drag-inline') {
            if ([MathResearchControl]::GetForegroundWindow() -ne $target) { throw 'Research terminal is not foreground' }
            $rect = $range.GetBoundingRectangles()[0]
            $saved = New-Object MathResearchControl+Point
            [void][MathResearchControl]::GetPhysicalCursorPos([ref]$saved)
            foreach ($key in @(1,2,16,17,18)) { if ([MathResearchControl]::GetAsyncKeyState($key) -lt 0) { throw 'User input is active' } }
            try {
                # Separate this drag from the preceding click. Otherwise WT can
                # interpret it as a word/line-selection double click.
                Start-Sleep -Milliseconds 650
                if ([MathResearchControl]::GetForegroundWindow() -ne $target) { throw 'Research terminal lost foreground before drag' }
                $startX = [int]$rect.X + 3
                [void][MathResearchControl]::SetPhysicalCursorPos($startX,[int]($rect.Y+$rect.Height/2))
                Start-Sleep -Milliseconds 100
                $startPoint = New-Object MathResearchControl+Point
                [void][MathResearchControl]::GetPhysicalCursorPos([ref]$startPoint)
                $startOwner = [MathResearchControl]::GetAncestor([MathResearchControl]::WindowFromPoint($startPoint), 2)
                [MathResearchControl]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
                Start-Sleep -Milliseconds 80
                $buttonDown = [MathResearchControl]::GetAsyncKeyState(1) -lt 0
                for ($step=1;$step -le 6;$step++) {
                    if ([MathResearchControl]::GetForegroundWindow() -ne $target) { throw 'Research terminal lost foreground during drag' }
                    # Generate mouse input as well as moving the cursor. Merely
                    # warping it with SetPhysicalCursorPos does not reliably
                    # trigger Windows Terminal's drag-selection state machine.
                    [MathResearchControl]::mouse_event(1, 12, 0, 0, [UIntPtr]::Zero)
                    Start-Sleep -Milliseconds 40
                }
                Start-Sleep -Milliseconds 300
                $during=@($pattern.GetSelection() | ForEach-Object { $_.GetText(500) })
                [MathResearchControl]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
                Start-Sleep -Milliseconds 150
                $endPoint = New-Object MathResearchControl+Point
                [void][MathResearchControl]::GetPhysicalCursorPos([ref]$endPoint)
                @{selectedSource=@($pattern.GetSelection() | ForEach-Object { $_.GetText(500) });duringDrag=$during;
                  startPoint=$startPoint;endPoint=$endPoint;startOwner=$startOwner.ToInt64();target=$target.ToInt64();buttonDown=$buttonDown;
                  sourceRect=@{x=$rect.X;y=$rect.Y;width=$rect.Width;height=$rect.Height}} | ConvertTo-Json -Depth 4
            } finally {
                [MathResearchControl]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
                [void][MathResearchControl]::SetPhysicalCursorPos($saved.X,$saved.Y)
            }
            break
        }
        if ($Action -eq 'clear-selection') {
            $range.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,
                $range, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
        }
        if ($Action -eq 'drag-formula') {
            if ([MathResearchControl]::GetForegroundWindow() -ne $target) { throw 'Research terminal is not foreground' }
            $block = $pattern.GetVisibleRanges()[0].Clone()
            $block.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start,
                $range, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End)
            $end = $block.FindText('\]', $false, $false)
            if (-not $end) { throw 'Complete display block not found' }
            $block.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,
                $end, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
            $range = $block.FindText('\max_q', $false, $false)
            if (-not $range) { throw 'Visible formula source not found' }
            $rectangles = $range.GetBoundingRectangles()
            if ($rectangles.Length -eq 0) { throw 'No visible formula rectangle' }
            $rect = $rectangles[0]
            $saved = New-Object MathResearchControl+Point
            [void][MathResearchControl]::GetCursorPos([ref]$saved)
            if ([MathResearchControl]::GetAsyncKeyState(0x10) -lt 0) { throw 'Release Shift before the controlled selection test' }
            try {
                # Shift requests terminal selection when the TUI enables mouse reporting.
                [MathResearchControl]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero)
                [void][MathResearchControl]::SetPhysicalCursorPos([int]$rect.X, [int]($rect.Y + $rect.Height / 2))
                [MathResearchControl]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
                Start-Sleep -Milliseconds 80
                $buttonDown = [MathResearchControl]::GetAsyncKeyState(1) -lt 0
                for ($movement = 0; $movement -lt 5; $movement++) {
                    [MathResearchControl]::mouse_event(1, 20, 0, 0, [UIntPtr]::Zero)
                    Start-Sleep -Milliseconds 30
                }
                $moved = $true
                $pointer = New-Object MathResearchControl+Point
                [void][MathResearchControl]::GetPhysicalCursorPos([ref]$pointer)
                Start-Sleep -Milliseconds 150
                $during = @($pattern.GetSelection() | ForEach-Object { $_.GetText(500) })
                [MathResearchControl]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
                [MathResearchControl]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero)
                Start-Sleep -Milliseconds 200
                @{ selectedSource = @($pattern.GetSelection() | ForEach-Object { $_.GetText(500) }); duringDrag = $during; pointerMoved = $moved; buttonDown = $buttonDown; pointer = @{ x = $pointer.X; y = $pointer.Y } } | ConvertTo-Json -Depth 4
            } finally {
                [MathResearchControl]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
                [MathResearchControl]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero)
                [void][MathResearchControl]::SetCursorPos($saved.X, $saved.Y)
            }
            break
        }
        $range.Select()
    }
}
