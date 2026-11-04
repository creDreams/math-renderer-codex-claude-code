using System;
using System.Drawing;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace AgentMath {
    internal sealed class Capture {
        public long Id, Hwnd;
        public string Key, Text, Pane, LeadingContext, Foreground, Background;
        public string[] Lines;
        public Rectangle[] Rows, Selection;
        public bool InlineMath;
        public bool UniformBackground;
        public double DisplayBackgroundMs;
        public Dictionary<string, bool> DisplayBackgrounds = new Dictionary<string, bool>();
        public Dictionary<string, Rectangle> InlineSlots = new Dictionary<string, Rectangle>();
        public double RowHeight, Width;
        public DateTime CapturedAt;

        // A full-text key may change as the user types. Reuse is permitted only
        // when ALL assistant candidates and their boundaries remain identical.
        // Geometry and pane identity must also agree; formula-only reuse is unsafe.
        internal bool CanReuse(RenderResult result) {
            var source = result.Source;
            if (source == null || Hwnd != source.Hwnd || Pane != source.Pane || LeadingContext != source.LeadingContext ||
                Foreground != source.Foreground || Background != source.Background ||
                InlineMath != source.InlineMath || RowHeight != source.RowHeight || Width != source.Width || Rows.Length != source.Rows.Length) return false;
            for (int row = 0; row < Rows.Length; row++) if (Rows[row] != source.Rows[row]) return false;
            if (Key == result.Key) return true;
            if (result.SourceRanges == null || result.SourceRanges.Length == 0 || Lines.Length != source.Lines.Length) return false;
            var starts = new System.Collections.Generic.HashSet<int>();
            foreach (var range in result.SourceRanges) {
                if (range.startRow < 0 || range.endRow < range.startRow || range.endRow >= Lines.Length) return false;
                bool history = ClaudeViewport.Contains(source.Lines, range.startRow, range.endRow) && ClaudeViewport.Contains(Lines, range.startRow, range.endRow);
                if (IsAssistantLine(source.Lines[range.startRow])) starts.Add(range.startRow);
                else if (!history && (range.startRow != 0 || String.IsNullOrEmpty(LeadingContext))) return false;
                for (int row = range.startRow; row <= range.endRow; row++)
                    if (Lines[row] != source.Lines[row]) return false;
                // A changed prompt must not extend the assistant candidate.
                if (range.endRow + 1 < Lines.Length) {
                    var next = Lines[range.endRow + 1];
                    if (!(history && (ClaudeViewport.IsLabel(next) || ClaudeViewport.IsStatus(next))) && (next.Trim().Length == 0 || next.StartsWith("  ")) &&
                        !Regex.IsMatch(next, @"^\s*(?:Worked for\s+\d+(?:\.\d+)?(?:ms|[smh])(?:\s+\d+(?:\.\d+)?(?:ms|[smh]))*|(?:工作了|已工作)\s*\d+(?:\.\d+)?\s*(?:毫秒|秒|分钟|分|小时))(?:\s+•\s+(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12]\d|3[01])(?:, \d{4})? at )?(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)?(?:\s*[─━]+)?\s*$|^─{3,}\s*$")) return false;
                }
            }
            int first = Lines.Length;
            foreach (var range in result.SourceRanges) first = Math.Min(first, range.startRow);
            for (int row = 0; row < first; row++) if (Lines[row] != source.Lines[row]) return false;
            for (int row = 0; row < Lines.Length; row++)
                if (IsAssistantLine(Lines[row]) != starts.Contains(row)) return false;
            return true;
        }

        // Carry only an immutable, previously verified assistant prefix while a
        // newer snapshot is being checked. The original deadline is unchanged;
        // appended prose never becomes source evidence for another formula.
        internal RenderResult CarryForward(RenderResult result) {
            var source = result.Source;
            var anchors = result.VerifiedRanges ?? result.SourceRanges;
            if (source == null || result.State != "matched" || result.Formulas == null ||
                anchors == null || anchors.Length == 0 ||
                Hwnd != source.Hwnd || Pane != source.Pane || Foreground != source.Foreground ||
                Background != source.Background || InlineMath != source.InlineMath || RowHeight != source.RowHeight || Width != source.Width) return null;
            int first = source.Lines.Length, last = -1;
            foreach (var range in anchors) {
                if (range.startRow < 0 || range.endRow < range.startRow || range.endRow >= source.Lines.Length) return null;
                first = Math.Min(first, range.startRow); last = Math.Max(last, range.endRow);
            }
            while (last >= first && source.Lines[last].Trim().Length == 0) last--;
            if (last < first) return null;
            var oldLines = CleanLines(source.Lines);
            string before = "";
            if (!IsAssistantLine(oldLines[first])) {
                if (first != 0 || String.IsNullOrEmpty(source.LeadingContext)) return null;
                var context = CleanText(source.LeadingContext);
                if (!context.EndsWith("\n")) return null;
                var roles = Regex.Matches(context, @"(?m)^(?:• |● |⏺ )");
                if (roles.Count == 0) return null;
                int role = roles[roles.Count - 1].Index;
                before = context.Substring(role);
            }
            var prefix = before + String.Join("\n", oldLines, first, last - first + 1);
            var leading = CleanText(LeadingContext ?? "");
            if (leading.Length > 0 && !leading.EndsWith("\n")) return null;
            var currentLines = CleanLines(Lines);
            string current = leading + String.Join("\n", currentLines);
            int anchor = current.IndexOf(prefix, StringComparison.Ordinal);
            if (anchor < 0 || (anchor > 0 && current[anchor - 1] != '\n') ||
                current.IndexOf(prefix, anchor + 1, StringComparison.Ordinal) >= 0) return null;
            // Unverified candidates (including Codex's animated Working line)
            // are not source evidence for these images. A newer worker result
            // still replaces this proof immediately, including ambiguity or
            // rejection. Carrying never renews its original deadline.
            var formulas = new List<WorkerFormula>();
            foreach (var formula in result.Formulas) {
                if (formula.startRow < first || formula.endRow > last || formula.startRow < 0 ||
                    formula.endRow >= source.Rows.Length) return null;
                int offset = before.Length;
                for (int row = first; row < formula.startRow; row++) offset += oldLines[row].Length + 1;
                int start = anchor + offset;
                if (start < leading.Length) continue; // Formula is now above the viewport.
                int startRow = 0;
                for (int index = leading.Length; index < start; index++) if (current[index] == '\n') startRow++;
                int endRow = startRow + formula.endRow - formula.startRow;
                if (endRow >= Rows.Length || endRow >= currentLines.Length) continue;
                for (int row = startRow; row <= endRow; row++) {
                    int oldRow = formula.startRow + row - startRow;
                    if (currentLines[row] != oldLines[oldRow] || Rows[row].Size != source.Rows[oldRow].Size) return null;
                }
                formulas.Add(new WorkerFormula { startRow = startRow, endRow = endRow,
                    imageId = formula.imageId, png = formula.png, width = formula.width, height = formula.height,
                    kind = formula.kind, startColumn = formula.startColumn, endColumn = formula.endColumn,
                    visibleText = formula.visibleText, offsetY = formula.offsetY });
            }
            if (formulas.Count == 0) return null;
            return new RenderResult { Key = Key, State = result.State, Source = this,
                // Display-only: do not turn an unverified appended suffix into
                // the anchor of a second carry operation.
                Formulas = formulas.ToArray(), SourceRanges = new SourceRange[0], VerifiedRanges = new SourceRange[0],
                ReceivedAt = result.ReceivedAt, RetryAfterMs = result.RetryAfterMs, Metrics = result.Metrics };
        }
        private static bool IsAssistantLine(string line) {
            return line.StartsWith("• ", StringComparison.Ordinal) || line.StartsWith("● ", StringComparison.Ordinal) ||
                line.StartsWith("⏺ ", StringComparison.Ordinal);
        }
        private static string[] CleanLines(string[] lines) {
            var clean = new string[lines.Length];
            for (int row = 0; row < lines.Length; row++) clean[row] = lines[row].TrimEnd();
            return clean;
        }
        private static string CleanText(string text) {
            return String.Join("\n", CleanLines(text.Split(new string[] { "\r\n", "\n" }, StringSplitOptions.None)));
        }
    }
    public sealed class SourceRange { public int startRow, endRow; }
    public sealed class WorkerFormula {
        public int startRow, endRow, width, height, startColumn, endColumn, offsetY;
        public string imageId, png, kind, visibleText;
        public string SlotKey { get { return startRow + ":" + startColumn + ":" + endColumn + ":" + visibleText; } }
    }
    public sealed class WorkerMessage {
        public string type, state;
        public long id;
        public int skipped, protocol;
        public WorkerFormula[] formulas;
        public SourceRange[] sourceRanges;
        public SourceRange[] verifiedRanges;
        public int retryAfterMs;
        public WorkerMetrics metrics;
        public bool pendingSource;
    }
    public sealed class WorkerMetrics {
        public double lookupMs, matchMs, renderMs;
        public long sourceReadBytes, sourceBytes, indexReadBytes, imageBytes, rssBytes;
        public int sourceHits, sourceMisses, sourceEntries, indexedFiles, indexedMessages, imageHits, imageMisses, imageEntries;
        public int inlineCandidates, inlineImages;
        public bool indexing;
    }
    internal sealed class RenderResult {
        public string Key, State;
        public WorkerFormula[] Formulas;
        public SourceRange[] SourceRanges;
        public SourceRange[] VerifiedRanges;
        public Capture Source;
        public DateTime ReceivedAt;
        public int RetryAfterMs;
        public WorkerMetrics Metrics;
        // A response may arrive just after Tick captured its clock value.
        internal bool IsFresh(DateTime now) { return Math.Abs((now - ReceivedAt).TotalSeconds) <= 6; }
    }
}
