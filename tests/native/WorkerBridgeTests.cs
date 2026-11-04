using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using AgentMath;

internal static class WorkerBridgeTests {
    static int count;
    static void Check(string label, bool value) {
        if (!value) throw new Exception(label);
        count++; Console.WriteLine("PASS " + label);
    }
    static void Wait(Func<bool> predicate) {
        var clock = Stopwatch.StartNew();
        while (!predicate()) {
            if (clock.ElapsedMilliseconds > 5000) throw new Exception("Worker fixture did not respond");
            Thread.Sleep(10);
        }
    }
    static Capture Snapshot(long id) {
        return new Capture { Id = id, Key = "capture-" + id, Text = "• Verified answer", LeadingContext = "",
            Lines = new[] { "• Verified answer" }, Rows = new[] { new Rectangle(0, 0, 1400, 28) },
            RowHeight = 28, Width = 1400, Foreground = "#cccccc", Background = "#0c0c0c" };
    }
    static int Main(string[] args) {
        using (var bridge = new WorkerBridge(args[0], "normal")) {
            Wait(() => bridge.Ready);
            Check("ready worker can remain idle without timing out", !bridge.TimedOut(DateTime.UtcNow.AddHours(1)));
            Check("first capture accepted", bridge.Send(Snapshot(1)));
            Check("second capture is deferred while a request is in flight", !bridge.Send(Snapshot(2)));
            Wait(() => File.Exists(Path.Combine(args[0], "seen-1")));
            Check("response for an unrelated ID is ignored", bridge.Latest == null);
            File.WriteAllText(Path.Combine(args[0], "release-1"), "release");
            Wait(() => bridge.Latest != null);
            Check("matching response retains the exact capture proof", bridge.Latest.Key == "capture-1" && bridge.Latest.Source.Id == 1);
            Check("completed request clears its deadline", !bridge.TimedOut(DateTime.UtcNow.AddHours(1)));
            File.WriteAllText(Path.Combine(args[0], "release-2"), "release");
            Wait(() => bridge.Send(Snapshot(2)));
            Wait(() => bridge.Latest != null && bridge.Latest.Source.Id == 2);
            Check("newest capture runs after prior response completes", bridge.Latest.Key == "capture-2");
            Check("fresh proof is usable", bridge.Latest.IsFresh(DateTime.UtcNow));
            Check("old proof expires even if terminal pixels remain unchanged", !bridge.Latest.IsFresh(DateTime.UtcNow.AddSeconds(7)));
        }
        using (var bridge = new WorkerBridge(args[0], "stall")) {
            Wait(() => bridge.Ready); bridge.Send(Snapshot(3));
            Check("pending analysis has a deadline", bridge.TimedOut(DateTime.UtcNow.AddSeconds(13)));
            Check("rejected later captures cannot reset the deadline", !bridge.Send(Snapshot(4)) && bridge.TimedOut(DateTime.UtcNow.AddSeconds(13)));
            bridge.Fail(); Check("timeout removes readiness and stale proof", bridge.Failed && !bridge.Ready && bridge.Latest == null);
        }
        using (var bridge = new WorkerBridge(args[0], "indexing")) {
            Wait(() => bridge.Ready); bridge.Send(Snapshot(1)); Wait(() => bridge.Latest != null);
            var approved = bridge.Latest;
            var same = Snapshot(2); same.Key = approved.Key;
            Wait(() => bridge.Send(same)); Wait(() => bridge.Latest.RetryAfterMs == 150);
            Check("pending index refresh preserves identical current proof", bridge.Latest.State == "matched" && bridge.Latest.Source.Id == 1);
            Check("pending refresh never extends proof lifetime", bridge.Latest.ReceivedAt == approved.ReceivedAt);
            bridge.Latest.ReceivedAt = DateTime.UtcNow.AddSeconds(-7);
            Wait(() => bridge.Send(same)); Wait(() => bridge.Latest.State == "waiting");
            Check("pending index cannot preserve an expired proof", bridge.Latest.Formulas.Length == 0);
            bridge.Latest = approved; approved.ReceivedAt = DateTime.UtcNow;
            var changed = Snapshot(3); changed.Text = "• Changed answer"; changed.Lines = new[] { changed.Text };
            Wait(() => bridge.Send(changed)); Wait(() => bridge.Latest.Source.Id == 3);
            Check("pending index cannot reuse proof for a changed viewport", bridge.Latest.State == "waiting");
        }
        using (var bridge = new WorkerBridge(args[0], "indexing-stream")) {
            var source = Snapshot(1);
            source.Lines = new[] { "• A verified streaming policy derivation", "  \\[", "  x^2", "  \\]", "  Explanation" };
            source.Rows = new Rectangle[source.Lines.Length];
            for (int row = 0; row < source.Rows.Length; row++) source.Rows[row] = new Rectangle(0, row * 28, 1400, 28);
            source.Text = String.Join("\r\n", source.Lines);
            Wait(() => bridge.Ready); bridge.Send(source); Wait(() => bridge.Latest != null);
            var approved = bridge.Latest;
            var appended = Snapshot(2); appended.Lines = (string[])source.Lines.Clone();
            appended.Lines[4] += " continues"; appended.Rows = source.Rows; appended.Text = String.Join("\r\n", appended.Lines);
            Wait(() => bridge.Send(appended)); Wait(() => bridge.Latest.RetryAfterMs == 150);
            Check("pending index keeps an immutable streaming prefix", bridge.Latest.Source.Id == 1 && bridge.Latest.Formulas.Length == 1);
            Check("streaming refresh cannot renew source proof", bridge.Latest.ReceivedAt == approved.ReceivedAt);
            appended = Snapshot(3); appended.Lines = (string[])source.Lines.Clone();
            appended.Lines[2] = "  y^2"; appended.Rows = source.Rows; appended.Text = String.Join("\r\n", appended.Lines);
            Wait(() => bridge.Send(appended)); Wait(() => bridge.Latest.Source.Id == 3);
            Check("pending streaming refresh rejects changed mathematics", bridge.Latest.State == "waiting" && bridge.Latest.Formulas.Length == 0);
        }
        using (var bridge = new WorkerBridge(args[0], "startup-stall"))
            Check("startup has a deadline before ready arrives", bridge.TimedOut(DateTime.UtcNow.AddSeconds(13)));
        using (var bridge = new WorkerBridge(args[0], "rejected")) {
            Wait(() => bridge.Ready); bridge.Send(Snapshot(1)); Wait(() => bridge.Latest != null);
            Check("initial unique match can render before a new answer", bridge.Latest.State == "matched");
            Wait(() => bridge.Send(Snapshot(2))); Wait(() => bridge.Latest.Source.Id == 2);
            Check("explicit ambiguity immediately replaces a prior matched proof", bridge.Latest.State == "ambiguous" && bridge.Latest.Formulas.Length == 0);
        }
        foreach (var mode in new[] { "protocol", "malformed", "null-formula", "outside-proof", "unverified-range", "unverified-formula", "exit" }) {
            using (var bridge = new WorkerBridge(args[0], mode)) {
                if (mode != "protocol") { Wait(() => bridge.Ready); bridge.Send(Snapshot(10)); }
                Wait(() => bridge.Failed);
                Check("invalid or failed worker is rejected: " + mode, !bridge.Ready && bridge.Latest == null);
            }
        }
        foreach (var mode in new[] { "inline-normal", "inline-disabled", "inline-wrong-text", "inline-negative-column",
            "inline-outside-column", "inline-empty-span", "inline-kind", "inline-height", "inline-offset", "inline-multiline", "inline-unproved" }) {
            using (var bridge = new WorkerBridge(args[0], mode, null, mode != "inline-disabled")) {
                var capture = Snapshot(11); capture.InlineMath = mode != "inline-disabled";
                capture.Text = "• x² + y² = r²，后文"; capture.Lines = new[] { capture.Text, "  next" };
                capture.Rows = new[] { capture.Rows[0], new Rectangle(0, 28, 1400, 28) };
                Wait(() => bridge.Ready); bridge.Send(capture);
                Wait(() => bridge.Failed || bridge.Latest != null);
                Check("inline IPC validation: " + mode, mode == "inline-normal" ?
                    !bridge.Failed && bridge.Latest.Formulas.Length == 1 && bridge.Latest.Formulas[0].visibleText == "x² + y² = r²" :
                    bridge.Failed && bridge.Latest == null);
            }
        }
        var blocked = new WorkerBridge(args[0], "blocked-input");
        try {
            Wait(() => blocked.Ready);
            var large = Snapshot(20); large.Text = new String('x', 130000);
            blocked.Send(large); Thread.Sleep(100);
            int pid = blocked.Pid; var elapsed = Stopwatch.StartNew(); blocked.Dispose();
            Check("blocked input does not hang shutdown", elapsed.ElapsedMilliseconds < 4000);
            bool alive;
            try { using (var child = Process.GetProcessById(pid)) alive = !child.WaitForExit(1000); } catch (ArgumentException) { alive = false; }
            Check("shutdown terminates its own blocked worker", !alive);
        } finally { blocked.Dispose(); }
        Console.WriteLine(count + " worker lifecycle checks passed"); return 0;
    }
}
