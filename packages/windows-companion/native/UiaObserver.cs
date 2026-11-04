using System;
using System.Collections.Generic;
using System.Drawing;
using System.Security.Cryptography;
using System.Text;
using System.Diagnostics;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Automation.Text;

namespace AgentMath {
    // All cross-process accessibility calls stay off the overlay/UI thread.
    internal sealed class UiaObserver : IDisposable {
        private readonly string restrictTitle;
        private readonly AutoResetEvent wake = new AutoResetEvent(false);
        private readonly Thread thread;
        private volatile bool stopped;
        private AutomationElement subscribed;
        private AutomationEventHandler changed;
        private long dirtyTicks, nextId;
        public volatile Capture Current;
        public volatile bool Enabled = true;
        public volatile string State = "waiting";
        public volatile string Error;
        private string readStage;
        public long DirtyTicks { get { return Interlocked.Read(ref dirtyTicks); } }
        public void Invalidate() { Interlocked.Exchange(ref dirtyTicks, DateTime.UtcNow.Ticks); wake.Set(); }
        public void Refresh() { wake.Set(); }
        private volatile InlineRequest inlineRequest;
        private volatile DisplayRequest displayRequest;
        private sealed class DisplayTarget {
            public int First, Last;
            public string[] Lines;
            public string Key { get { return First + ":" + Last; } }
            public bool Matches(string[] current) {
                if (First < 0 || Last >= current.Length || Last < First) return false;
                for (int row = First; row <= Last; row++) if (current[row] != Lines[row - First]) return false;
                return true;
            }
        }
        private sealed class DisplayRequest {
            public long Hwnd;
            public string Pane, Signature;
            public DisplayTarget[] Targets;
        }
        public void RequestDisplay(Capture capture, WorkerFormula[] formulas) {
            var targets = new List<DisplayTarget>();
            var signature = new StringBuilder(capture.Key);
            foreach (var formula in formulas) if (formula.kind != "inline" && formula.startRow >= 0 &&
                formula.endRow >= formula.startRow && formula.endRow < capture.Lines.Length) {
                var lines = new string[formula.endRow - formula.startRow + 1];
                Array.Copy(capture.Lines, formula.startRow, lines, 0, lines.Length);
                var target = new DisplayTarget { First = formula.startRow, Last = formula.endRow, Lines = lines };
                targets.Add(target); signature.Append('\0').Append(target.Key);
            }
            string key = signature.ToString();
            var previous = displayRequest;
            if (previous != null && previous.Signature == key) return;
            displayRequest = new DisplayRequest { Hwnd = capture.Hwnd, Pane = capture.Pane, Signature = key, Targets = targets.ToArray() };
            wake.Set();
        }
        private sealed class InlineSlot {
            public Rectangle Bounds;
            public InlineTarget Target;
            public string RowKey;
            public LinkedListNode<string> Node;
        }
        private readonly Dictionary<string, InlineSlot> inlineCache = new Dictionary<string, InlineSlot>();
        private readonly Dictionary<string, Dictionary<string, InlineSlot>> inlineRows = new Dictionary<string, Dictionary<string, InlineSlot>>();
        private readonly LinkedList<string> inlineOrder = new LinkedList<string>();
        private readonly UiaRows physicalRows = new UiaRows();
        public volatile bool InlineMath;
        private static string InlineRowKey(string pane, string font, Rectangle row, string line) {
            // A terminal scroll changes Y, while the exact same row layout
            // retains its X offsets. Font, pane, row size and all text must agree.
            return pane + "\0" + font + "\0" + row.X + ":" + row.Width + ":" + row.Height + "\0" + line;
        }
        private void ForgetInline(string key) {
            var cached = inlineCache[key];
            var row = inlineRows[cached.RowKey];
            row.Remove(key);
            if (row.Count == 0) inlineRows.Remove(cached.RowKey);
            inlineCache.Remove(key); inlineOrder.Remove(cached.Node);
        }
        public void RequestInline(Capture capture, WorkerFormula[] formulas) {
            if (!InlineMath) return;
            var targets = new List<InlineTarget>();
            var signature = new StringBuilder(capture.Key);
            foreach (var formula in formulas) if (formula.kind == "inline") {
                targets.Add(new InlineTarget { Row = formula.startRow, Start = formula.startColumn, End = formula.endColumn, Text = formula.visibleText });
                signature.Append('\0').Append(formula.SlotKey);
            }
            string key = signature.ToString();
            var current = inlineRequest;
            if (current != null && current.Signature == key) return;
            inlineRequest = new InlineRequest { CaptureKey = capture.Key, Signature = key, Targets = targets.ToArray() };
            wake.Set();
        }

        public UiaObserver(string title) {
            restrictTitle = title;
            changed = delegate { Refresh(); };
            thread = new Thread(Loop) { IsBackground = true, Name = "Agent Math UIA" };
            thread.SetApartmentState(ApartmentState.MTA);
            thread.Start();
        }

        private void Subscribe(AutomationElement element) {
            if (subscribed != null && Automation.Compare(subscribed, element)) return;
            Unsubscribe(); subscribed = element;
            Automation.AddAutomationEventHandler(TextPattern.TextChangedEvent, element, TreeScope.Element, changed);
            Automation.AddAutomationEventHandler(TextPattern.TextSelectionChangedEvent, element, TreeScope.Element, changed);
            Invalidate();
        }
        private void Unsubscribe() {
            if (subscribed == null) return;
            try {
                Automation.RemoveAutomationEventHandler(TextPattern.TextChangedEvent, subscribed, changed);
                Automation.RemoveAutomationEventHandler(TextPattern.TextSelectionChangedEvent, subscribed, changed);
            } catch { }
            subscribed = null;
        }
        private void Hide(string state) { Current = null; State = state; }
        private static string ColorValue(object value) {
            if (!(value is int)) return null;
            int color = (int)value;
            return String.Format("#{0:x2}{1:x2}{2:x2}", color & 255, (color >> 8) & 255, (color >> 16) & 255);
        }
        private static TextPatternRange FindLiteral(TextPatternRange visible, string literal, bool backward = false) {
            try {
                var found = visible.FindText(literal, backward, false);
                // Windows Terminal 1.24 may return a non-null range with invalid
                // endpoints for a missing needle. Validate it before reading
                // attributes, and allow the other delimiter to be tried.
                return found != null && found.GetText(literal.Length) == literal ? found : null;
            } catch { return null; }
        }
        private static bool ReadDisplayBackground(TextPattern pattern, TextPatternRange visible, Rectangle first, Rectangle last,
            string background, out bool clear) {
            clear = false;
            // Claude paints its own selection as ANSI background colours. It
            // does not expose that selection through TextPattern.GetSelection.
            // Read the actual formula rows; any mixed/styled background stays
            // literal so an overlay cannot erase a selection or other emphasis.
            var range = pattern.RangeFromPoint(new System.Windows.Point(first.Left + 1, first.Top + first.Height / 2.0));
            range.ExpandToEnclosingUnit(TextUnit.Line);
            if (first.Top != last.Top) {
                var end = pattern.RangeFromPoint(new System.Windows.Point(last.Left + 1, last.Top + last.Height / 2.0));
                end.ExpandToEnclosingUnit(TextUnit.Line);
                range.MoveEndpointByRange(TextPatternRangeEndpoint.End, end, TextPatternRangeEndpoint.End);
            }
            if (range.CompareEndpoints(TextPatternRangeEndpoint.Start, visible, TextPatternRangeEndpoint.Start) < 0)
                range.MoveEndpointByRange(TextPatternRangeEndpoint.Start, visible, TextPatternRangeEndpoint.Start);
            if (range.CompareEndpoints(TextPatternRangeEndpoint.End, visible, TextPatternRangeEndpoint.End) > 0)
                range.MoveEndpointByRange(TextPatternRangeEndpoint.End, visible, TextPatternRangeEndpoint.End);
            var bounds = range.GetBoundingRectangles();
            if (bounds.Length == 0 || Math.Abs(bounds[0].Top - first.Top) > 1 ||
                Math.Abs(bounds[bounds.Length - 1].Bottom - last.Bottom) > 1) return false;
            var value = range.GetAttributeValue(TextPattern.BackgroundColorAttribute);
            if (value == AutomationElement.NotSupported) return false;
            clear = ColorValue(value) == background;
            return true;
        }
        private void Loop() {
            Native.SetThreadDpiAwarenessContext(new IntPtr(-4));
            try {
                while (!stopped) {
                    try { Read(); }
                    catch { Hide("unavailable"); Unsubscribe(); }
                    wake.WaitOne(100);
                }
            } finally { Unsubscribe(); }
        }
        private void Read(int attempt = 0) {
            try { ReadSnapshot(attempt); }
            catch (Exception error) {
                // UIA can transiently reject a query while the TUI rebuilds
                // its layout. Retry the entire snapshot, never mixed ranges.
                if (attempt < 2) Read(attempt + 1);
                else { Error = readStage + ":" + error.GetType().Name; Hide("unavailable"); Unsubscribe(); }
            }
        }
        private void RetryGeometry(int attempt, string reason = "geometry") {
            if (attempt < 2) Read(attempt + 1);
            else { Error = reason; Hide("unavailable"); }
        }
        private void ReadSnapshot(int attempt) {
            readStage = "focus";
            if (!Enabled) { Hide("paused"); return; }
            var hwnd = Native.GetForegroundWindow();
            if (!Native.IsTerminal(hwnd, restrictTitle)) { Hide("waiting"); return; }
            var focused = AutomationElement.FocusedElement;
            if (focused == null || focused.Current.ClassName != "TermControl" || focused.Current.IsOffscreen ||
                !focused.Current.HasKeyboardFocus) { Hide("terminal-ui"); return; }
            uint pid; Native.GetWindowThreadProcessId(hwnd, out pid);
            if (focused.Current.ProcessId != (int)pid) { Hide("terminal-ui"); return; }
            var root = AutomationElement.FromHandle(hwnd);
            var panes = root.FindAll(TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ClassNameProperty, "TermControl"));
            bool belongs = false;
            foreach (AutomationElement pane in panes) {
                if (Automation.Compare(pane, focused)) { belongs = true; break; }
            }
            if (!belongs) { Hide("terminal-ui"); return; }
            Subscribe(focused);
            long epoch = DirtyTicks;
            var pattern = (TextPattern)focused.GetCurrentPattern(TextPattern.Pattern);
            readStage = "visible-text";
            var ranges = pattern.GetVisibleRanges();
            if (ranges.Length != 1) { RetryGeometry(attempt, "visible-range-count:" + ranges.Length); return; }
            var visible = ranges[0];
            string paneId = String.Join(":", focused.GetRuntimeId());
            var text = visible.GetText(65537);
            // This is only a cheap wake-up filter. The shared parser validates
            // supported display environments, code boundaries and assistant role.
            if (text.Length > 65536 || (!InlineMath && !text.Contains("\\[") && !text.Contains("$$") && !text.Contains("\\begin{") &&
                !text.Contains("_") && !text.Contains("^"))) { Hide("no-formula"); return; }
            var rectangles = visible.GetBoundingRectangles();
            var lines = text.Split(new string[] { "\r\n", "\n" }, StringSplitOptions.None);
            string leadingContext = "";
            // Claude's proven input frame bounds the current answer. Reading
            // terminal scrollback here would add unrelated, changing pages to
            // the capture key during full-screen status redraws. Its assistant
            // source is independently verified from the current viewport.
            if (ClaudeViewport.Body(lines) == null) foreach (var line in lines) {
                if (line.Trim().Length == 0) continue;
                if (line.StartsWith("  ")) {
                    var before = visible.Clone();
                    before.MoveEndpointByRange(TextPatternRangeEndpoint.End, visible, TextPatternRangeEndpoint.Start);
                    before.MoveEndpointByUnit(TextPatternRangeEndpoint.Start, TextUnit.Character, -65536);
                    // UIA character units and UTF-16 text lengths differ (for
                    // example CRLF occupies one unit but two UTF-16 chars).
                    // Keep the tail ending at visible.Start, never a truncated
                    // prefix that could omit the nearest role boundary.
                    var context = before.GetText(131073);
                    if (context.Length > 131072) { Hide("context-limit"); return; }
                    leadingContext = context.Length > 65536 ? context.Substring(context.Length - 65536) : context;
                }
                break;
            }
            if (rectangles.Length == 0 || rectangles.Length > 300) {
                RetryGeometry(attempt, "row-count:" + lines.Length + ":" + rectangles.Length); return;
            }
            int textRows = lines.Length - (lines[lines.Length - 1] == "" ? 1 : 0);
            if (textRows != rectangles.Length) {
                readStage = "physical-rows";
                string scope = hwnd.ToInt64() + ":" + paneId + ":" +
                    Convert.ToString(visible.GetAttributeValue(TextPattern.FontNameAttribute)) + ":" +
                    Convert.ToString(visible.GetAttributeValue(TextPattern.FontSizeAttribute));
                if (!physicalRows.Read(visible, scope, text, rectangles, out lines)) {
                    RetryGeometry(attempt, "row-mapping"); return;
                }
            }
            string snapshotText = String.Join("\r\n", lines);
            var colorRange = text.Contains("\\[") ? FindLiteral(visible, "\\[") : null;
            if (colorRange == null && text.Contains("$$")) colorRange = FindLiteral(visible, "$$");
            if (colorRange == null && text.Contains("\\begin{")) colorRange = FindLiteral(visible, "\\begin{");
            if (colorRange == null) {
                var trigger = System.Text.RegularExpressions.Regex.Match(text, @"[=$\\_^\u0370-\u03ff\u2070-\u22ff]");
                if (trigger.Success) colorRange = FindLiteral(visible, trigger.Value);
            }
            if (colorRange == null) { Hide("no-formula"); return; }
            var claudeBody = ClaudeViewport.Body(lines);
            var uniformBackground = ColorValue(visible.GetAttributeValue(TextPattern.BackgroundColorAttribute));
            // A custom selection can include the first mathematical glyph.
            // Claude's input prompt remains outside transcript selections and
            // supplies the base background when the viewport is mixed.
            var promptRange = uniformBackground == null && claudeBody != null ? FindLiteral(visible, "❯", true) : null;
            var bg = uniformBackground ?? (promptRange == null ? null : ColorValue(promptRange.GetAttributeValue(TextPattern.BackgroundColorAttribute))) ??
                ColorValue(colorRange.GetAttributeValue(TextPattern.BackgroundColorAttribute));
            if (bg == null) { Hide("unsupported-theme"); return; }
            var fg = MathPalette.Foreground(bg);
            var rows = new List<Rectangle>();
            double rowHeight = rectangles[0].Height, width = rectangles[0].Width;
            for (int index = 0; index < rectangles.Length; index++) {
                var rect = rectangles[index];
                if (rect.IsEmpty || rect.Height < 6 || Math.Abs(rect.Height - rowHeight) > 1 ||
                    (index > 0 && Math.Abs(rect.Y - rectangles[index - 1].Bottom) > 1)) { RetryGeometry(attempt, "row-shape:" + index); return; }
                rows.Add(Rectangle.FromLTRB((int)Math.Floor(rect.Left), (int)Math.Floor(rect.Top),
                    (int)Math.Ceiling(rect.Right), (int)Math.Ceiling(rect.Bottom)));
                width = Math.Min(width, rect.Width);
            }
            // Guard against a repaint between text and geometry queries.
            if (visible.GetText(65537) != text) {
                // A real TUI may repaint while accessibility calls are in
                // flight. Retry the complete capture before publishing failure;
                // never combine text and geometry from different reads.
                if (attempt < 2) { Read(attempt + 1); return; }
                Hide("changing"); return;
            }
            if (Native.GetForegroundWindow() != hwnd || DirtyTicks != epoch ||
                !Automation.Compare(AutomationElement.FocusedElement, focused)) { Hide("changing"); return; }
            readStage = "selection";
            var selection = new List<Rectangle>();
            foreach (var selected in pattern.GetSelection()) {
                if (selected.GetText(1).Length == 0) continue; // A caret is not a selection.
                foreach (var rect in selected.GetBoundingRectangles())
                    if (!rect.IsEmpty && rect.Width > 0 && rect.Height > 0)
                        selection.Add(Rectangle.FromLTRB((int)Math.Floor(rect.Left), (int)Math.Floor(rect.Top),
                            (int)Math.Ceiling(rect.Right), (int)Math.Ceiling(rect.Bottom)));
            }
            var displayBackgrounds = new Dictionary<string, bool>();
            var surfaces = displayRequest;
            var surfaceWatch = Stopwatch.StartNew();
            bool uniformSurface = uniformBackground != null;
            var body = uniformSurface ? null : claudeBody;
            if (body != null && body.endRow < rows.Count) {
                bool clear;
                // Pinned prompts and navigation hints have coloured backgrounds
                // even when the answer itself is uniform. Check the body once
                // before doing any work per formula.
                if (ReadDisplayBackground(pattern, visible, rows[body.startRow], rows[body.endRow], bg, out clear) && clear)
                    uniformSurface = true;
            }
            if (!uniformSurface && surfaces != null && surfaces.Hwnd == hwnd.ToInt64() && surfaces.Pane == paneId) {
                readStage = "display-background";
                foreach (var target in surfaces.Targets) {
                    if (!target.Matches(lines) || target.Last >= rows.Count) continue;
                    bool clear;
                    if (ReadDisplayBackground(pattern, visible, rows[target.First], rows[target.Last], bg, out clear))
                        displayBackgrounds[target.Key] = clear;
                }
            }
            surfaceWatch.Stop();
            var signature = new StringBuilder(snapshotText).Append('\0').Append(leadingContext).Append(fg).Append(bg).Append(hwnd.ToInt64()).Append(paneId).Append(InlineMath);
            foreach (var row in rows) signature.Append(row.ToString());
            string key;
            using (var hash = SHA256.Create()) key = Convert.ToBase64String(hash.ComputeHash(Encoding.UTF8.GetBytes(signature.ToString())));
            var slots = new Dictionary<string, Rectangle>();
            var request = inlineRequest;
            if (InlineMath) {
                readStage = "inline-font";
                var watch = Stopwatch.StartNew();
                int newLookups = 0;
                string font = Convert.ToString(visible.GetAttributeValue(TextPattern.FontNameAttribute)) + ":" +
                    Convert.ToString(visible.GetAttributeValue(TextPattern.FontSizeAttribute));
                var rowKeys = new string[rows.Count];
                for (int row = 0; row < rows.Count; row++) rowKeys[row] = InlineRowKey(paneId, font, rows[row], lines[row]);
                if (request != null) foreach (var target in request.Targets) {
                    readStage = "inline-geometry";
                    if (target.Row < 0 || target.Row >= rows.Count || target.Row >= lines.Length) continue;
                    string rowKey = rowKeys[target.Row];
                    string slotCacheKey = rowKey + "\0" + target.Start + ":" + target.End + ":" + target.Text;
                    Rectangle slot; InlineSlot cached;
                    if (!inlineCache.TryGetValue(slotCacheKey, out cached)) {
                        if (request.CaptureKey != key || newLookups > 0 && watch.ElapsedMilliseconds > 35) continue;
                        newLookups++;
                        if (!InlineLocator.Locate(visible, lines[target.Row], rows[target.Row], target, out slot)) continue;
                        if (inlineCache.Count >= 1024) ForgetInline(inlineOrder.First.Value);
                        cached = new InlineSlot { Bounds = slot, Target = target, RowKey = rowKey, Node = inlineOrder.AddLast(slotCacheKey) };
                        inlineCache[slotCacheKey] = cached;
                        Dictionary<string, InlineSlot> rowEntries;
                        if (!inlineRows.TryGetValue(rowKey, out rowEntries)) inlineRows[rowKey] = rowEntries = new Dictionary<string, InlineSlot>();
                        rowEntries[slotCacheKey] = cached;
                    } else {
                        slot = cached.Bounds; inlineOrder.Remove(cached.Node); inlineOrder.AddLast(cached.Node);
                    }
                }
                // Publish cached substring geometry on its CURRENT physical
                // row before the worker requests rebased row numbers. These
                // slots are layout hints only; Display still needs fresh source
                // proof for the exact formula occurrence before using one.
                for (int row = 0; row < rows.Count; row++) {
                    Dictionary<string, InlineSlot> entries;
                    if (!inlineRows.TryGetValue(rowKeys[row], out entries)) continue;
                    foreach (var entry in entries) {
                        var cached = entry.Value;
                        var target = cached.Target;
                        slots[row + ":" + target.Start + ":" + target.End + ":" + target.Text] =
                            new Rectangle(cached.Bounds.X, rows[row].Top, cached.Bounds.Width, rows[row].Height);
                        inlineOrder.Remove(cached.Node); inlineOrder.AddLast(cached.Node);
                    }
                }
            }
            if (visible.GetText(65537) != text || Native.GetForegroundWindow() != hwnd || DirtyTicks != epoch) { RetryGeometry(attempt, "snapshot-changed"); return; }
            var previous = Current;
            var id = previous != null && previous.Key == key ? previous.Id : Interlocked.Increment(ref nextId);
            Current = new Capture { Id = id, Hwnd = hwnd.ToInt64(), Key = key, Text = snapshotText, Lines = lines, Pane = paneId,
                LeadingContext = leadingContext,
                Selection = selection.ToArray(),
                UniformBackground = uniformSurface,
                DisplayBackgroundMs = surfaceWatch.Elapsed.TotalMilliseconds,
                DisplayBackgrounds = displayBackgrounds,
                Foreground = fg, Background = bg, Rows = rows.ToArray(), RowHeight = rowHeight, Width = width,
                InlineMath = InlineMath, InlineSlots = slots, CapturedAt = DateTime.UtcNow };
            Error = null; State = "observing";
        }
        public void Dispose() { stopped = true; wake.Set(); }
    }
}
