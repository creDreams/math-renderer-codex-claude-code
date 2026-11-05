using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace AgentMath {
    internal sealed class AppContext : ApplicationContext {
        private readonly UiaObserver observer;
        private WorkerBridge worker;
        private readonly string directory, profile, codexHome, diagnostics;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 30 };
        private readonly NotifyIcon tray;
        private readonly ToolStripMenuItem toggle;
        private readonly ToolStripMenuItem inlineToggle;
        private readonly Dictionary<string, FormulaWindow> windows = new Dictionary<string, FormulaWindow>();
        private readonly EventWaitHandle stopEvent, showEvent, pauseEvent, resumeEvent;
        private readonly EventWaitHandle inlineOnEvent, inlineOffEvent;
        private readonly Native.WinEventProc nativeChanged;
        private readonly List<IntPtr> hooks = new List<IntPtr>();
        private DateTime lastRequest = DateTime.MinValue, lastDiagnostics = DateTime.MinValue, lastRestart = DateTime.MinValue;
        private string lastRequestKey;
        private bool enabled = true, closing;
        private bool inlineEnabled;
        private long hiddenTransitions;
        private readonly Dictionary<string, long> hiddenReasons = new Dictionary<string, long>();
        private string lastPaintKey;
        private DateTime lastPaintAt;
        private Form statusWindow;
        private Label statusLabel;
        private string state = "starting";
        private int inlineGeometryPending, inlineTooWide, displayGeometryPending, styledSourceAreas;
        internal AppContext(string baseDirectory, string dataDirectory, string title, string customHome, string diagnosticPath,
            string eventPrefix, bool quiet) {
            directory = baseDirectory; profile = dataDirectory; codexHome = customHome; diagnostics = diagnosticPath;
            Directory.CreateDirectory(profile);
            try {
                var config = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(profile, "settings.json")));
                if (config.ContainsKey("enabled")) enabled = (bool)config["enabled"];
                if (config.ContainsKey("inlineMath")) inlineEnabled = (bool)config["inlineMath"];
            } catch { }
            stopEvent = new EventWaitHandle(false, EventResetMode.AutoReset, eventPrefix + ".stop");
            showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, eventPrefix + ".show");
            pauseEvent = new EventWaitHandle(false, EventResetMode.AutoReset, eventPrefix + ".pause");
            resumeEvent = new EventWaitHandle(false, EventResetMode.AutoReset, eventPrefix + ".resume");
            inlineOnEvent = new EventWaitHandle(false, EventResetMode.AutoReset, eventPrefix + ".inline-on");
            inlineOffEvent = new EventWaitHandle(false, EventResetMode.AutoReset, eventPrefix + ".inline-off");
            observer = new UiaObserver(title);
            observer.Enabled = enabled;
            observer.InlineMath = inlineEnabled;
            var menu = new ContextMenuStrip();
            toggle = new ToolStripMenuItem("启用公式显示") { Checked = enabled, CheckOnClick = true };
            toggle.CheckedChanged += delegate { SetEnabled(toggle.Checked); };
            menu.Items.Add(toggle);
            inlineToggle = new ToolStripMenuItem("行内与无标记公式（预览）") { Checked = inlineEnabled, CheckOnClick = true };
            inlineToggle.CheckedChanged += delegate { SetInline(inlineToggle.Checked); };
            menu.Items.Add(inlineToggle);
            menu.Items.Add("查看状态", null, delegate { ShowStatus(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, delegate { ExitThread(); });
            tray = new NotifyIcon { Icon = SystemIcons.Information, Text = "Agent Math · 公式显示", ContextMenuStrip = menu, Visible = true };
            tray.DoubleClick += delegate { ShowStatus(); };
            nativeChanged = delegate(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time) {
                var capture = observer.Current;
                if (ev == 3 || capture == null || hwnd.ToInt64() == capture.Hwnd || Native.GetAncestor(hwnd, 2).ToInt64() == capture.Hwnd) {
                    // Caret/client location changes are routine while typing.
                    // Only a window location change invalidates geometry immediately.
                    if ((ev == 0x800B && obj != 0) || obj == -8) observer.Refresh();
                    else observer.Invalidate();
                }
            };
            foreach (uint ev in new uint[] { 3, 6, 7, 16, 17, 0x8005, 0x800B }) {
                var hook = Native.SetWinEventHook(ev, ev, IntPtr.Zero, nativeChanged, 0, 0, 2);
                if (hook != IntPtr.Zero) hooks.Add(hook);
            }
            RestartWorker();
            timer.Tick += Tick; timer.Start();
            if (!quiet) ShowStatus();
        }
        private void SetEnabled(bool value) {
            enabled = value; toggle.Checked = value;
            observer.Enabled = value;
            SaveSettings();
            observer.Invalidate(); if (!enabled) HideAll();
            UpdateLabel();
        }
        private void SaveSettings() {
            try { File.WriteAllText(Path.Combine(profile, "settings.json"), json.Serialize(new { enabled = enabled, inlineMath = inlineEnabled })); } catch { }
        }
        private void SetInline(bool value) {
            if (inlineEnabled == value) return;
            inlineEnabled = value; inlineToggle.Checked = value; observer.InlineMath = value;
            SaveSettings(); HideAll("inline-setting"); observer.Invalidate(); RestartWorker(); UpdateLabel();
        }
        private void ShowStatus() {
            if (statusWindow == null || statusWindow.IsDisposed) {
                statusWindow = new Form { Text = "Agent Math", Size = new Size(430, 220), StartPosition = FormStartPosition.CenterScreen,
                    FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false };
                var heading = new Label { Text = "终端公式显示", AutoSize = true, Font = new Font(SystemFonts.MessageBoxFont.FontFamily, 15), Location = new Point(22, 22) };
                statusLabel = new Label { AutoSize = false, Size = new Size(375, 52), Location = new Point(24, 63) };
                var close = new Button { Text = "返回终端", Location = new Point(284, 126), Size = new Size(105, 32) };
                close.Click += delegate { statusWindow.Hide(); };
                statusWindow.Controls.Add(heading); statusWindow.Controls.Add(statusLabel); statusWindow.Controls.Add(close);
                statusWindow.FormClosing += delegate(object sender, FormClosingEventArgs args) { if (!closing) { args.Cancel = true; statusWindow.Hide(); } };
            }
            UpdateLabel(); statusWindow.Show(); statusWindow.Activate();
        }
        private void UpdateLabel() {
            if (statusLabel == null || statusLabel.IsDisposed) return;
            statusLabel.Text = enabled ? "已启用。照常使用 Codex 或 Claude Code。\r\nClaude 无标记公式需开启托盘中的预览选项。\r\n关闭此窗口后，应用会继续在系统托盘运行。" : "已暂停。可从系统托盘重新启用。";
        }
        private void RestartWorker() {
            lastRestart = DateTime.UtcNow;
            if (worker != null) worker.Dispose();
            worker = null;
            try { worker = new WorkerBridge(directory, codexHome, Path.Combine(profile, "cache"), inlineEnabled); }
            catch (Exception error) { Log("Worker start: " + error.GetType().Name); }
            lastRequestKey = null;
        }
        private void Tick(object sender, EventArgs args) {
            if (stopEvent.WaitOne(0)) { ExitThread(); return; }
            if (showEvent.WaitOne(0)) ShowStatus();
            if (pauseEvent.WaitOne(0)) SetEnabled(false);
            if (resumeEvent.WaitOne(0)) SetEnabled(true);
            if (inlineOnEvent.WaitOne(0)) SetInline(true);
            if (inlineOffEvent.WaitOne(0)) SetInline(false);
            var now = DateTime.UtcNow;
            if (worker != null && worker.TimedOut(now)) { worker.Fail(); Log("Worker timed out"); }
            if ((worker == null || worker.Failed) && (now - lastRestart).TotalSeconds > 5) RestartWorker();
            var capture = observer.Current;
            bool valid = enabled && capture != null && (now - capture.CapturedAt).TotalMilliseconds < 500 &&
                capture.CapturedAt.Ticks >= observer.DirtyTicks &&
                Native.GetForegroundWindow().ToInt64() == capture.Hwnd;
            state = !enabled ? "paused" : observer.State;
            var latest = worker == null ? null : worker.Latest;
            var retryMs = latest != null && latest.Key == (capture == null ? null : capture.Key) && latest.RetryAfterMs > 0 ? latest.RetryAfterMs : 2000;
            if (enabled && capture != null && worker != null && worker.Ready &&
                (lastRequestKey != capture.Key || (now - lastRequest).TotalMilliseconds > retryMs)) {
                if (worker.Send(capture)) { lastRequestKey = capture.Key; lastRequest = now; }
            }
            var result = worker == null ? null : worker.Latest;
            bool expired = result != null && !result.IsFresh(now);
            var display = valid && result != null && !expired && result.State == "matched"
                ? capture.CanReuse(result) ? result : capture.CarryForward(result) : null;
            if (display == null) {
                string reason = !valid ? capture == null ? observer.State :
                    (now - capture.CapturedAt).TotalMilliseconds >= 500 ? "capture-expired" :
                    capture.CapturedAt.Ticks < observer.DirtyTicks ? "capture-invalidated" : "foreground-changed" :
                    result == null ? "awaiting-worker" : expired ? "proof-expired" : result.State != "matched" ? "worker-" + result.State : "source-changed";
                HideAll(reason);
                if (valid && result != null && !expired && result.Key == capture.Key) state = result.State;
            } else {
                try { state = Display(capture, display) > 0 ? "rendered" : capture.Selection.Length > 0 || styledSourceAreas > 0 ? "selection" : "source"; }
                catch (Exception error) { HideAll(); state = "unavailable"; Log("Display: " + error.GetType().Name); }
            }
            if ((now - lastDiagnostics).TotalMilliseconds > 500) { WriteStatus(capture); lastDiagnostics = now; }
        }
        private int Display(Capture capture, RenderResult result) {
            var keep = new HashSet<string>();
            int shown = 0;
            inlineGeometryPending = 0; inlineTooWide = 0;
            displayGeometryPending = 0; styledSourceAreas = 0;
            observer.RequestInline(capture, result.Formulas);
            observer.RequestDisplay(capture, result.Formulas);
            foreach (var formula in result.Formulas) {
                if (formula.startRow < 0 || formula.endRow < formula.startRow || formula.endRow >= capture.Rows.Length) continue;
                var bounds = capture.Rows[formula.startRow];
                if (formula.kind == "inline") {
                    if (!capture.InlineMath || !capture.InlineSlots.TryGetValue(formula.SlotKey, out bounds)) { inlineGeometryPending++; continue; }
                } else for (int row = formula.startRow + 1; row <= formula.endRow; row++) bounds = Rectangle.Union(bounds, capture.Rows[row]);
                if (bounds.Width < formula.width || bounds.Height < formula.height) { if (formula.kind == "inline") inlineTooWide++; continue; }
                bool clearBackground = true;
                if (formula.kind != "inline" && !capture.UniformBackground &&
                    !capture.DisplayBackgrounds.TryGetValue(formula.startRow + ":" + formula.endRow, out clearBackground)) {
                    displayGeometryPending++; continue;
                }
                string key = capture.Hwnd + ":" + formula.startRow + ":" + formula.imageId + ":" + capture.Background;
                FormulaWindow window;
                // Reposition the existing bitmap when terminal rows scroll.
                // Images may be shared; source proof is always checked above.
                int distance = Int32.MaxValue;
                foreach (var existing in windows) {
                    if (keep.Contains(existing.Key) || existing.Value.ImageId != formula.imageId ||
                        existing.Value.OwnerHwnd != capture.Hwnd || existing.Value.BackColor != ColorTranslator.FromHtml(capture.Background)) continue;
                    int candidate = Math.Abs(existing.Value.Bounds.Y - bounds.Y) + Math.Abs(existing.Value.Bounds.X - bounds.X);
                    if (candidate < distance) { key = existing.Key; distance = candidate; }
                }
                if (distance == Int32.MaxValue) while (windows.ContainsKey(key) || keep.Contains(key)) key += ":";
                keep.Add(key);
                if (!windows.TryGetValue(key, out window)) {
                    window = new FormulaWindow(new IntPtr(capture.Hwnd), formula, ColorTranslator.FromHtml(capture.Background));
                    windows.Add(key, window);
                }
                if (window.Bounds != bounds) window.Bounds = bounds;
                bool selected = false;
                foreach (var area in capture.Selection) if (bounds.IntersectsWith(area)) { selected = true; break; }
                if (!clearBackground) styledSourceAreas++;
                if (selected || !clearBackground) { if (window.Visible) { window.Hide(); RecordHide(selected ? "selection" : "styled-source"); } }
                else { if (!window.Visible) window.Show(); window.EnsureAboveOwner(); shown++; }
            }
            foreach (var key in new List<string>(windows.Keys)) {
                if (!keep.Contains(key)) {
                    if (windows[key].Visible) RecordHide("formula-removed");
                    windows[key].Dispose(); windows.Remove(key);
                }
            }
            if (shown > 0 && lastPaintKey != capture.Key) { lastPaintKey = capture.Key; lastPaintAt = DateTime.UtcNow; }
            return shown;
        }
        private void HideAll(string reason = "lifecycle") {
            bool hidden = false;
            foreach (var window in windows.Values) if (window.Visible) { window.Hide(); hidden = true; }
            if (hidden) RecordHide(reason);
        }
        private void RecordHide(string reason) {
            hiddenTransitions++;
            if (!hiddenReasons.ContainsKey(reason)) hiddenReasons[reason] = 0;
            hiddenReasons[reason]++;
            if (diagnostics != null) Log("Hide: " + reason);
        }
        private void WriteStatus(Capture capture) {
            try {
                var overlays = new List<object>();
                foreach (var window in windows.Values) if (window.Visible) {
                    var bounds = window.Bounds;
                    var point = new Native.POINT { X = bounds.Left + bounds.Width / 2, Y = bounds.Top + bounds.Height / 2 };
                    overlays.Add(new { x = bounds.X, y = bounds.Y, width = bounds.Width, height = bounds.Height,
                        imageId = window.ImageId,
                        kind = window.Kind ?? "display",
                        imageWidth = window.ImageWidth, imageHeight = window.ImageHeight,
                        hitTestOwner = Native.GetAncestor(Native.WindowFromPoint(point), 2).ToInt64() });
                }
                var status = new { version = "0.2.0-preview.31", pid = Process.GetCurrentProcess().Id,
                    enabled = enabled, inlineMath = inlineEnabled, state = state, observerError = observer.Error, workerReady = worker != null && worker.Ready,
                    workerPid = worker != null ? worker.Pid : 0,
                    targetHwnd = capture != null ? capture.Hwnd : 0,
                    leadingContextChars = capture != null ? capture.LeadingContext.Length : 0,
                    inlineGeometryPending = inlineGeometryPending, inlineTooWide = inlineTooWide,
                    displayGeometryPending = displayGeometryPending, styledSourceAreas = styledSourceAreas,
                    displayBackgroundMs = capture != null ? capture.DisplayBackgroundMs : 0,
                    captureKey = capture != null ? capture.Key : null,
                    foreground = capture != null ? capture.Foreground : null,
                    background = capture != null ? capture.Background : null,
                    renderedAt = lastPaintAt.ToString("o"),
                    hiddenTransitions = hiddenTransitions,
                    hiddenReasons = hiddenReasons,
                    metrics = worker != null && worker.Latest != null ? worker.Latest.Metrics : null,
                    overlays = overlays, updatedAt = DateTime.UtcNow.ToString("o") };
                AtomicWrite(Path.Combine(profile, "status.json"), json.Serialize(status));
                if (diagnostics != null) AtomicWrite(diagnostics, json.Serialize(status));
            } catch { }
        }
        private static void AtomicWrite(string path, string value) {
            var temp = path + ".tmp"; File.WriteAllText(temp, value);
            if (File.Exists(path)) File.Replace(temp, path, null); else File.Move(temp, path);
        }
        private void Log(string message) {
            try {
                var path = Path.Combine(profile, "app.log");
                if (File.Exists(path) && new FileInfo(path).Length > 262144) File.Delete(path);
                File.AppendAllText(path, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine);
            } catch { }
        }
        protected override void ExitThreadCore() {
            if (closing) return; closing = true;
            timer.Stop(); HideAll();
            foreach (var window in windows.Values) window.Dispose(); windows.Clear();
            tray.Visible = false; tray.Dispose();
            foreach (var hook in hooks) Native.UnhookWinEvent(hook);
            observer.Dispose(); if (worker != null) worker.Dispose();
            if (statusWindow != null) statusWindow.Dispose();
            stopEvent.Dispose(); showEvent.Dispose(); pauseEvent.Dispose(); resumeEvent.Dispose(); inlineOnEvent.Dispose(); inlineOffEvent.Dispose(); timer.Dispose();
            base.ExitThreadCore();
        }
    }
}
