// Research-only sidecar. No PTY, terminal writes, process injection or input hooks.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using System.Windows.Forms;

public sealed class MathProbeForm : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            var value = base.CreateParams;
            // LAYERED | TRANSPARENT | TOOLWINDOW | NOACTIVATE
            value.ExStyle |= 0x00080000 | 0x20 | 0x80 | 0x08000000;
            return value;
        }
    }
}

public static class WindowsTerminalOverlayProbe {
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder value, int max);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flag);
    [DllImport("user32.dll")] static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
    [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint color, byte alpha, uint flags);
    static string Compact(string value) { return Regex.Replace(value, @"\s+", ""); }

    public static void Run(string title, string manifestPath, string logPath, string stopPath, int maxSeconds) {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        var json = new JavaScriptSerializer();
        var manifest = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(manifestPath));
        var expected = Compact((string)manifest["block"]);
        IntPtr target = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
            var text = new StringBuilder(1024);
            GetWindowText(hwnd, text, text.Capacity);
            if (text.ToString() == title) { target = hwnd; return false; }
            return true;
        }, IntPtr.Zero);
        if (target == IntPtr.Zero) throw new Exception("Named research terminal not found");
        var root = AutomationElement.FromHandle(target);
        var element = root.FindFirst(TreeScope.Descendants,
            new PropertyCondition(AutomationElement.ClassNameProperty, "TermControl"));
        if (element == null) throw new Exception("TermControl not found");
        var pattern = (TextPattern)element.GetCurrentPattern(TextPattern.Pattern);
        int textEvents = 0, selectionEvents = 0;
        AutomationEventHandler textHandler = delegate { Interlocked.Increment(ref textEvents); };
        AutomationEventHandler selectionHandler = delegate { Interlocked.Increment(ref selectionEvents); };
        Automation.AddAutomationEventHandler(TextPattern.TextChangedEvent, element, TreeScope.Element, textHandler);
        Automation.AddAutomationEventHandler(TextPattern.TextSelectionChangedEvent, element, TreeScope.Element, selectionHandler);

        var form = new MathProbeForm { FormBorderStyle = FormBorderStyle.None,
            ShowInTaskbar = false, StartPosition = FormStartPosition.Manual,
            BackColor = ColorTranslator.FromHtml((string)manifest["background"]),
            BackgroundImage = Image.FromFile((string)manifest["image"]),
            BackgroundImageLayout = ImageLayout.Zoom };
        var overlayHandle = form.Handle;
        SetWindowLongPtr(overlayHandle, -8, target); // Own only to this terminal.
        SetLayeredWindowAttributes(overlayHandle, 0, 255, 2);
        var context = new ApplicationContext();
        var timer = new System.Windows.Forms.Timer { Interval = 100 };
        var started = DateTime.UtcNow;
        var records = new List<object>();
        string lastState = "", lastBounds = "";
        int frames = 0;
        var samples = new List<double>();
        Action<string, object> record = delegate(string state, object detail) {
            records.Add(new { seconds = (DateTime.UtcNow - started).TotalSeconds,
                state = state, detail = detail, textEvents = textEvents, selectionEvents = selectionEvents });
            File.WriteAllText(logPath, json.Serialize(new { hwnd = target.ToInt64(), overlayHwnd = overlayHandle.ToInt64(),
                records = records, readMilliseconds = samples, frames = frames }));
        };
        timer.Tick += delegate {
            if (!IsWindow(target) || (DateTime.UtcNow - started).TotalSeconds > maxSeconds ||
                (File.Exists(stopPath) && File.ReadAllText(stopPath).Trim() == "stop")) {
                record("stopped", null); context.ExitThread(); return;
            }
            string state = "hidden-background";
            Rectangle bounds = Rectangle.Empty;
            var watch = System.Diagnostics.Stopwatch.StartNew();
            try {
                if (GetForegroundWindow() == target && !IsIconic(target)) {
                    state = "hidden-no-formula";
                    var selections = pattern.GetSelection();
                    bool selected = selections.Length > 0 && selections[0].GetText(1).Length > 0;
                    if (selected) state = "hidden-selection";
                    else {
                        var ranges = pattern.GetVisibleRanges();
                        if (ranges.Length > 0) {
                            var source = ranges[0].FindText("\\[", false, false);
                            var tail = ranges[0].FindText("\\]", false, false);
                            if (source != null && tail != null) {
                                source.MoveEndpointByRange(TextPatternRangeEndpoint.End, tail, TextPatternRangeEndpoint.End);
                                if (Compact(source.GetText(8192)) == expected) {
                                    var rects = source.GetBoundingRectangles();
                                    if (rects.Length > 0) {
                                        var union = rects[0];
                                        foreach (var rectangle in rects) union.Union(rectangle);
                                        bounds = new Rectangle((int)union.X, (int)union.Y, (int)union.Width, (int)union.Height);
                                        state = "visible";
                                    }
                                }
                            }
                        }
                    }
                }
                if (state == "visible") {
                    form.Bounds = bounds;
                    if (!form.Visible) form.Show();
                } else form.Hide();
            } catch (Exception error) { state = "hidden-error:" + error.GetType().Name; form.Hide(); }
            watch.Stop(); frames++;
            if (samples.Count < 1000) samples.Add(watch.Elapsed.TotalMilliseconds);
            if (state != lastState || bounds.ToString() != lastBounds) {
                var point = new Point { X = bounds.Left + bounds.Width / 2, Y = bounds.Top + bounds.Height / 2 };
                record(state, new { bounds = bounds.ToString(), foregroundUnchanged = GetForegroundWindow() == target,
                    windowUnderOverlay = GetAncestor(WindowFromPoint(point), 2).ToInt64() });
                lastState = state; lastBounds = bounds.ToString();
            }
        };
        try { timer.Start(); Application.Run(context); }
        finally {
            timer.Stop(); timer.Dispose(); form.Hide(); form.BackgroundImage.Dispose(); form.Dispose();
            Automation.RemoveAutomationEventHandler(TextPattern.TextChangedEvent, element, textHandler);
            Automation.RemoveAutomationEventHandler(TextPattern.TextSelectionChangedEvent, element, selectionHandler);
            context.Dispose();
        }
    }
}
