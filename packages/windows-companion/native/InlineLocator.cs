using System;
using System.Drawing;
using System.Windows.Automation;
using System.Windows.Automation.Text;

namespace AgentMath {
    internal sealed class InlineTarget {
        public int Row, Start, End;
        public string Text;
        public string Key { get { return Row + ":" + Start + ":" + End + ":" + Text; } }
    }
    internal sealed class InlineRequest {
        public string CaptureKey, Signature;
        public InlineTarget[] Targets;
    }
    internal static class InlineLocator {
        private static TextPatternRange Find(TextPatternRange scope, string text, bool backward) {
            try {
                var found = scope.FindText(text, backward, false);
                return found != null && found.GetText(text.Length) == text ? found : null;
            } catch { return null; }
        }
        private static bool AtRow(TextPatternRange range, Rectangle row, bool left, out double x) {
            x = 0;
            var rectangles = range.GetBoundingRectangles();
            if (rectangles.Length == 0 || Math.Abs(rectangles[0].Y - row.Y) > 1 ||
                Math.Abs(rectangles[0].Height - row.Height) > 1 || left && Math.Abs(rectangles[0].X - row.X) > 1) return false;
            x = rectangles[0].X;
            return x >= row.Left && x < row.Right;
        }
        /** FindText's end can include an extra cell in WT 1.24. Use verified
         * suffix STARTS as exclusive boundaries; UTF-16 lengths never move UIA
         * endpoints. The original punctuation and prose retain their own cells. */
        internal static bool Locate(TextPatternRange visible, string line, Rectangle row, InlineTarget target, out Rectangle bounds) {
            bounds = Rectangle.Empty;
            if (target.Start < 0 || target.End <= target.Start || target.End > line.Length ||
                line.Substring(target.Start, target.End - target.Start) != target.Text) return false;
            string whole = line.TrimEnd();
            var search = visible.Clone(); TextPatternRange found = null;
            double ignored;
            for (int i = 0; i < 300; i++) {
                found = Find(search, whole, false);
                if (found == null) return false;
                if (AtRow(found, row, true, out ignored)) break;
                search.MoveEndpointByRange(TextPatternRangeEndpoint.Start, found, TextPatternRangeEndpoint.End);
                found = null;
            }
            if (found == null) return false;
            string first = line.Substring(target.Start).TrimEnd();
            var start = Find(found, first, true);
            double left, right = row.Right;
            if (start == null || !AtRow(start, row, false, out left)) return false;
            string tail = line.Substring(target.End).TrimEnd();
            if (tail.Length > 0) {
                var end = Find(found, tail, true);
                if (end == null || !AtRow(end, row, false, out right)) return false;
            }
            if (right <= left || right > row.Right) return false;
            bounds = Rectangle.FromLTRB((int)Math.Ceiling(left), row.Top, (int)Math.Floor(right), row.Bottom);
            return bounds.Width > 0;
        }
    }
}
