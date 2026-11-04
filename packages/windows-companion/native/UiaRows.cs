using System;
using System.Collections.Generic;
using System.Windows.Automation;
using System.Windows.Automation.Text;

namespace AgentMath {
    // GetText joins soft wraps, whereas GetBoundingRectangles describes physical
    // rows. Recover those boundaries from UIA itself; never divide UTF-16 text
    // by a guessed cell width (CJK, combining marks and emoji differ).
    internal sealed class UiaRows {
        private string cachedText;
        private string cachedScope;
        private System.Windows.Rect[] cachedBounds;
        private string[] cachedLines;

        internal bool Read(TextPatternRange visible, string scope, string text, System.Windows.Rect[] bounds, out string[] lines) {
            lines = null;
            if (cachedScope == scope && cachedText == text && SameBounds(cachedBounds, bounds)) { lines = cachedLines; return true; }
            var result = new List<string>();
            var cursor = visible.Clone();
            cursor.MoveEndpointByRange(TextPatternRangeEndpoint.End, visible, TextPatternRangeEndpoint.Start);
            int consumed = 0;
            while (result.Count < bounds.Length) {
                var line = cursor.Clone();
                line.ExpandToEnclosingUnit(TextUnit.Line);
                if (line.CompareEndpoints(TextPatternRangeEndpoint.Start, visible, TextPatternRangeEndpoint.Start) < 0)
                    line.MoveEndpointByRange(TextPatternRangeEndpoint.Start, visible, TextPatternRangeEndpoint.Start);
                if (line.CompareEndpoints(TextPatternRangeEndpoint.End, visible, TextPatternRangeEndpoint.End) > 0)
                    line.MoveEndpointByRange(TextPatternRangeEndpoint.End, visible, TextPatternRangeEndpoint.End);
                // WT can clamp TextUnit.Line at the last written buffer row,
                // even though GetVisibleRanges includes blank viewport rows.
                if (line.CompareEndpoints(TextPatternRangeEndpoint.Start, cursor, TextPatternRangeEndpoint.Start) != 0 ||
                    line.CompareEndpoints(TextPatternRangeEndpoint.End, cursor, TextPatternRangeEndpoint.Start) <= 0) break;
                var rectangles = line.GetBoundingRectangles();
                if (rectangles.Length != 1 || !SameRow(rectangles[0], bounds[result.Count])) return false;
                string raw = line.GetText(65537);
                if (raw.Length == 0 || raw.Length > text.Length - consumed ||
                    String.CompareOrdinal(text, consumed, raw, 0, raw.Length) != 0) return false;
                string content = raw.EndsWith("\r\n") ? raw.Substring(0, raw.Length - 2) :
                    raw.EndsWith("\n") ? raw.Substring(0, raw.Length - 1) : raw;
                if (content.IndexOfAny(new char[] { '\r', '\n' }) >= 0) return false;
                result.Add(content); consumed += raw.Length;
                if (line.CompareEndpoints(TextPatternRangeEndpoint.End, visible, TextPatternRangeEndpoint.End) >= 0) break;
                cursor.MoveEndpointByRange(TextPatternRangeEndpoint.Start, line, TextPatternRangeEndpoint.End);
                cursor.MoveEndpointByRange(TextPatternRangeEndpoint.End, line, TextPatternRangeEndpoint.End);
            }
            string remainder = text.Substring(consumed);
            if (result.Count < bounds.Length) {
                if (remainder.Trim().Length != 0) return false;
                var blanks = remainder.Split(new string[] { "\r\n", "\n" }, StringSplitOptions.None);
                int missing = bounds.Length - result.Count;
                if (blanks.Length != missing && !(blanks.Length == missing + 1 && blanks[missing] == "")) return false;
                for (int i = 0; i < missing; i++) result.Add(blanks[i]);
            } else if (remainder.Length != 0) return false;
            if (text.EndsWith("\n")) result.Add("");
            lines = result.ToArray();
            cachedScope = scope; cachedText = text; cachedBounds = (System.Windows.Rect[])bounds.Clone(); cachedLines = lines;
            return true;
        }
        private static bool SameRow(System.Windows.Rect a, System.Windows.Rect b) {
            return !a.IsEmpty && !b.IsEmpty && Math.Abs(a.X - b.X) <= 1 && Math.Abs(a.Y - b.Y) <= 1 &&
                Math.Abs(a.Width - b.Width) <= 1 && Math.Abs(a.Height - b.Height) <= 1;
        }
        private static bool SameBounds(System.Windows.Rect[] a, System.Windows.Rect[] b) {
            if (a == null || a.Length != b.Length) return false;
            for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
            return true;
        }
    }
}
