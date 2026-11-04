using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace AgentMath {
    internal static class InlineGeometryTests {
        delegate bool EnumProc(IntPtr hwnd, IntPtr data);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        private static int Main(string[] args) {
            if (!args[0].StartsWith("AgentMathResearch")) throw new Exception("Disposable windows only");
            SetProcessDpiAwarenessContext(new IntPtr(-4));
            IntPtr target = IntPtr.Zero;
            EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
                var title = new StringBuilder(1024); GetWindowText(hwnd, title, title.Capacity);
                if (title.ToString() == args[0]) target = hwnd; return true;
            }, IntPtr.Zero);
            if (target == IntPtr.Zero) throw new Exception("Research window missing");
            var json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
            var expected = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(args[1]));
            var pane = AutomationElement.FromHandle(target).FindFirst(TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ClassNameProperty, "TermControl"));
            var visible = ((TextPattern)pane.GetCurrentPattern(TextPattern.Pattern)).GetVisibleRanges()[0];
            var lines = visible.GetText(65536).Split(new string[] { "\r\n", "\n" }, StringSplitOptions.None);
            var rectangles = visible.GetBoundingRectangles();
            int checkedCount = 0;
            foreach (Dictionary<string, object> span in (IList)expected["spans"]) {
                string needle = (string)span["needle"];
                var matches = (IList)span["matches"]; int occurrence = 0;
                for (int row = 0; row < rectangles.Length; row++) {
                    for (int column = lines[row].IndexOf(needle, StringComparison.Ordinal); column >= 0;
                        column = lines[row].IndexOf(needle, column + needle.Length, StringComparison.Ordinal)) {
                        var r = rectangles[row]; var rectangle = Rectangle.FromLTRB((int)r.Left, (int)r.Top, (int)r.Right, (int)r.Bottom);
                        Rectangle actual;
                        if (!InlineLocator.Locate(visible, lines[row], rectangle,
                            new InlineTarget { Row = row, Start = column, End = column + needle.Length, Text = needle }, out actual))
                            throw new Exception("Native locator failed for occurrence " + occurrence + " of " + needle);
                        var expectedMatch = (Dictionary<string, object>)matches[occurrence++];
                        var box = (Dictionary<string, object>)((IList)expectedMatch["rectangles"])[0];
                        if (actual.X != Convert.ToInt32(box["x"]) || actual.Y != Convert.ToInt32(box["y"]) ||
                            actual.Width != Convert.ToInt32(box["width"]) || actual.Height != Convert.ToInt32(box["height"]))
                            throw new Exception("Native substring bounds differ from independent UIA probe");
                        checkedCount++;
                    }
                }
                if (occurrence != matches.Count) throw new Exception("Not all expected occurrences checked");
            }
            Console.WriteLine("PASS " + checkedCount + " production C# inline locations agree with independent exact UIA geometry");
            return 0;
        }
    }
}
