using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace AgentMath {
    internal sealed class WorkerBridge : IDisposable {
        private readonly Process process;
        private readonly StreamWriter input;
        private readonly object gate = new object();
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 24 * 1024 * 1024 };
        private Capture pending;
        private int writing;
        private readonly DateTime startedAt = DateTime.UtcNow;
        private DateTime pendingSince;
        private bool disposed;
        public volatile RenderResult Latest;
        public volatile bool Failed;
        public volatile bool Ready;
        public int Pid { get { return process.Id; } }
        // One request in flight prevents an output burst from continually
        // replacing the ID whose response the host is waiting for.
        internal bool TimedOut(DateTime now) {
            lock (gate) return !disposed && !Failed &&
                ((!Ready && (now - startedAt).TotalSeconds > 12) ||
                 (pending != null && (now - pendingSince).TotalSeconds > 12));
        }
        internal void Fail() { lock (gate) { Failed = true; Ready = false; Latest = null; } }
        public WorkerBridge(string directory, string codexHome, string cacheDirectory = null, bool inlineMath = false) {
            var info = new ProcessStartInfo {
                FileName = Path.Combine(directory, "runtime", "node.exe"),
                Arguments = "\"" + Path.Combine(directory, "worker.cjs") + "\"",
                WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false), StandardErrorEncoding = new UTF8Encoding(false)
            };
            info.EnvironmentVariables.Remove("NODE_OPTIONS"); info.EnvironmentVariables.Remove("NODE_PATH");
            if (codexHome != null) info.EnvironmentVariables["CODEX_HOME"] = codexHome;
            if (cacheDirectory != null) info.EnvironmentVariables["AGENT_MATH_CACHE_DIR"] = cacheDirectory;
            info.EnvironmentVariables["AGENT_MATH_INLINE_MATH"] = inlineMath ? "1" : "0";
            process = new Process { StartInfo = info, EnableRaisingEvents = true };
            process.OutputDataReceived += Read;
            process.ErrorDataReceived += delegate { /* Terminal and model text never enters this stream. */ };
            process.Exited += delegate { Fail(); };
            process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine();
            input = new StreamWriter(process.StandardInput.BaseStream, new UTF8Encoding(false)) { AutoFlush = true };
        }
        public bool Send(Capture capture) {
            lock (gate) {
                if (!Ready || Failed || disposed || pending != null ||
                    System.Threading.Interlocked.CompareExchange(ref writing, 1, 0) != 0) return false;
                pending = capture; pendingSince = DateTime.UtcNow;
            }
            System.Threading.ThreadPool.QueueUserWorkItem(delegate {
                try {
                    string line;
                    lock (gate) {
                        line = json.Serialize(new { type = "analyze", id = capture.Id,
                            text = capture.Text, rowHeight = capture.RowHeight, width = capture.Width,
                            leadingContext = capture.LeadingContext,
                            foreground = capture.Foreground, background = capture.Background });
                    }
                    input.WriteLine(line);
                } catch { Fail(); }
                finally { System.Threading.Interlocked.Exchange(ref writing, 0); }
            });
            return true;
        }
        private void Read(object sender, DataReceivedEventArgs args) {
            if (args.Data == null || Failed || disposed) return;
            if (args.Data.Length > 24 * 1024 * 1024) { Fail(); return; }
            try {
                WorkerMessage message;
                lock (gate) message = json.Deserialize<WorkerMessage>(args.Data);
                if (message == null) { Fail(); return; }
                if (message.type == "ready") { if (message.protocol != 1) Fail(); else Ready = true; return; }
                if (message.type != "result") return;
                lock (gate) {
                    if (Failed || disposed) return;
                    if (pending == null || pending.Id != message.id) return;
                    if (!ValidResult(message, pending)) { Fail(); return; }
                    if (message.pendingSource && message.retryAfterMs > 0 && Latest != null && Latest.State == "matched" &&
                        Latest.IsFresh(DateTime.UtcNow) && (pending.CanReuse(Latest) || pending.CarryForward(Latest) != null)) {
                        // A short background index update is not evidence that
                        // an unchanged formula became invalid. Keep its original
                        // proof deadline; never extend it with a pending response.
                        var previous = Latest;
                        Latest = new RenderResult { Key = previous.Key, State = previous.State,
                            Source = previous.Source, SourceRanges = previous.SourceRanges,
                            VerifiedRanges = previous.VerifiedRanges, Formulas = previous.Formulas,
                            ReceivedAt = previous.ReceivedAt, RetryAfterMs = Math.Max(1, Math.Min(1000, message.retryAfterMs)),
                            Metrics = message.metrics };
                        pending = null; return;
                    }
                    Latest = new RenderResult { Key = pending.Key, State = message.state,
                        Source = pending, SourceRanges = message.sourceRanges, VerifiedRanges = message.verifiedRanges,
                        RetryAfterMs = Math.Max(0, Math.Min(1000, message.retryAfterMs)), Metrics = message.metrics,
                        Formulas = message.formulas ?? new WorkerFormula[0], ReceivedAt = DateTime.UtcNow };
                    pending = null;
                }
            } catch { Fail(); }
        }
        private static bool ValidResult(WorkerMessage message, Capture capture) {
            if (message.state != "matched" && message.state != "waiting" && message.state != "ambiguous" && message.state != "error") return false;
            var formulas = message.formulas ?? new WorkerFormula[0];
            if (formulas.Length > (capture.InlineMath ? 256 : 16) || (message.state != "matched" && formulas.Length > 0)) return false;
            if (message.sourceRanges != null) foreach (var range in message.sourceRanges)
                if (range == null || range.startRow < 0 || range.endRow < range.startRow || range.endRow >= capture.Lines.Length) return false;
            if (message.verifiedRanges != null) foreach (var range in message.verifiedRanges) {
                bool candidate = false;
                if (range == null) return false;
                if (message.sourceRanges != null) foreach (var source in message.sourceRanges)
                    if (range.startRow == source.startRow && range.endRow == source.endRow) { candidate = true; break; }
                if (!candidate) return false;
            }
            foreach (var formula in formulas) {
                if (formula == null || formula.startRow < 0 || formula.endRow < formula.startRow || formula.endRow >= capture.Rows.Length ||
                    formula.width <= 0 || formula.width > capture.Width || formula.height <= 0 ||
                    formula.height > (formula.endRow - formula.startRow + 1) * capture.RowHeight ||
                    String.IsNullOrEmpty(formula.png) || formula.png.Length > 2800000 ||
                    !System.Text.RegularExpressions.Regex.IsMatch(formula.imageId ?? "", "^[0-9a-f]{64}$")) return false;
                if (formula.kind != null && formula.kind != "inline") return false;
                if (formula.kind == "inline") {
                    if (!capture.InlineMath || formula.startRow != formula.endRow || formula.startColumn < 0 ||
                        formula.endColumn <= formula.startColumn || formula.endColumn > capture.Lines[formula.startRow].Length ||
                        String.IsNullOrEmpty(formula.visibleText) || formula.visibleText.Length > 1024 ||
                        capture.Lines[formula.startRow].Substring(formula.startColumn, formula.endColumn - formula.startColumn) != formula.visibleText ||
                        formula.offsetY < 0 || formula.offsetY + formula.height > capture.RowHeight) return false;
                }
                bool proved = false;
                var proofRanges = message.verifiedRanges ?? message.sourceRanges;
                if (proofRanges != null) foreach (var range in proofRanges)
                    if (formula.startRow >= range.startRow && formula.endRow <= range.endRow) { proved = true; break; }
                if (!proved) return false;
            }
            return true;
        }
        public void Dispose() {
            lock (gate) { disposed = true; Ready = false; Latest = null; }
            // A stalled worker may also block its input pipe. Never write a
            // second message on the UI thread while an async write is blocked.
            try { if (System.Threading.Interlocked.CompareExchange(ref writing, 0, 0) == 0) input.WriteLine("{\"type\":\"quit\"}"); } catch { }
            try { if (!process.WaitForExit(1500)) process.Kill(); } catch { }
            try { input.Dispose(); } catch { }
            process.Dispose();
        }
    }
}
