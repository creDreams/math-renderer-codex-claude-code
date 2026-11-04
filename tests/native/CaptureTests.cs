using System;
using System.Drawing;
using AgentMath;

internal static class CaptureTests {
    static Capture Snapshot() {
        var lines = new[] { "• Complete assistant message", "  \\[", "  x^2", "  \\]", "  End of answer.", "", "› Ask a question", "" };
        var rows = new Rectangle[lines.Length];
        for (int row = 0; row < rows.Length; row++) rows[row] = new Rectangle(10, 20 + row * 28, 1400, 28);
        return new Capture { Key = "original", Hwnd = 123, Pane = "pane-1", Lines = lines, Rows = rows,
            RowHeight = 28, Width = 1400, Foreground = "#cccccc", Background = "#0c0c0c" };
    }
    static int Main() {
        var original = Snapshot();
        var result = new RenderResult { Key = original.Key, Source = original,
            SourceRanges = new[] { new SourceRange { startRow = 0, endRow = 5 } } };
        int count = 0;
        Action<string, Action<Capture>, bool> check = (label, mutate, expected) => {
            var current = Snapshot(); current.Key = "changed"; mutate(current);
            if (current.CanReuse(result) != expected) throw new Exception(label);
            count++; Console.WriteLine("PASS " + label);
        };
        check("typing and caret preserve complete evidence", x => x.Lines[6] = "› new input", true);
        check("selection does not invalidate evidence", x => x.Selection = new[] { x.Rows[2] }, true);
        check("application-painted selection preserves source proof", x => x.DisplayBackgrounds["1:3"] = false, true);
        check("changed formula invalidates", x => x.Lines[2] = "  y^2", false);
        check("changed explanatory prose invalidates", x => x.Lines[4] = "  Different explanation", false);
        check("new assistant candidate invalidates", x => x.Lines[7] = "• Another message", false);
        check("extended assistant boundary invalidates", x => x.Lines[6] = "  continued answer", false);
        check("blank assistant boundary invalidates", x => x.Lines[6] = "", false);
        check("footer remains a terminating boundary", x => x.Lines[6] = "  Worked for 2s", true);
        check("footer with actual Codex timestamp remains a boundary", x => x.Lines[6] = "  Worked for 6s • 02:31", true);
        check("footer with seconds and rule remains a boundary", x => x.Lines[6] = "  Worked for 1m 2s • 23:59:01 ───", true);
        check("historical footer with date remains a boundary", x => x.Lines[6] = "  Worked for 1m 56s • Nov 2 at 16:41", true);
        check("historical footer with year remains a boundary", x => x.Lines[6] = "  Worked for 6s • Jan 31, 2026 at 00:01", true);
        check("invalid historical date cannot become a boundary", x => x.Lines[6] = "  Worked for 6s • Nov 32 at 16:41", false);
        check("invalid timestamp cannot become an assistant boundary", x => x.Lines[6] = "  Worked for 6s • 32:99", false);
        check("prose containing footer words extends assistant", x => x.Lines[6] = "  Worked for years on this objective", false);
        check("indented table rule cannot become an assistant boundary", x => x.Lines[6] = "  ─────────  ─────────", false);
        check("pane switch invalidates", x => x.Pane = "pane-2", false);
        check("window switch invalidates", x => x.Hwnd++, false);
        check("theme change invalidates", x => x.Background = "#ffffff", false);
        check("scroll invalidates", x => x.Rows[2].Y -= 28, false);
        check("resize invalidates", x => x.Width -= 20, false);
        check("font change invalidates", x => x.RowHeight++, false);
        // Even an unmatched candidate must remain identical: its identity can
        // affect unique-session resolution on the next worker refresh.
        original.Lines[7] = "• Unmatched candidate";
        result.SourceRanges = new[] { result.SourceRanges[0], new SourceRange { startRow = 7, endRow = 7 } };
        check("unmatched candidate change invalidates", x => x.Lines[7] = "• Changed candidate", false);
        original = Snapshot(); original.Lines[0] = "  Clipped assistant continuation";
        original.LeadingContext = "• Complete assistant message\r\n  Earlier text\r\n";
        result.Source = original;
        result.SourceRanges = new[] { new SourceRange { startRow = 0, endRow = 5 } };
        Action<Capture> continuation = x => { x.Lines[0] = original.Lines[0]; x.LeadingContext = original.LeadingContext; };
        check("clipped continuation survives unrelated input", x => { continuation(x); x.Lines[6] = "› edited input"; }, true);
        check("changed preceding role invalidates continuation", x => { continuation(x); x.LeadingContext = "› user prompt"; }, false);
        check("missing preceding role invalidates continuation", x => { continuation(x); x.LeadingContext = ""; }, false);
        Console.WriteLine(count + " snapshot proof checks passed");
        return 0;
    }
}
