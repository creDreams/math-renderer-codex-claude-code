using System;
using System.Drawing;
using AgentMath;

internal static class StreamingProofTests {
    static Capture Snapshot(string[] lines, string context = "") {
        var rows = new Rectangle[lines.Length];
        for (int row = 0; row < rows.Length; row++) rows[row] = new Rectangle(10, 20 + row * 28, 1400, 28);
        return new Capture { Key = Guid.NewGuid().ToString(), Hwnd = 123, Pane = "pane", Lines = lines,
            LeadingContext = context, Rows = rows, Selection = new Rectangle[0], RowHeight = 28, Width = 1400,
            Foreground = "#cccccc", Background = "#0c0c0c" };
    }
    static int Main() {
        var lines = new[] { "• A verified streaming derivation for the current policy.", "  \\[", "  x^2+y^2=z^2", "  \\]", "  Explanation" };
        var source = Snapshot(lines);
        var proof = new RenderResult { Key = source.Key, State = "matched", Source = source,
            ReceivedAt = DateTime.UtcNow.AddSeconds(-2), SourceRanges = new[] { new SourceRange { startRow = 0, endRow = 4 } },
            Formulas = new[] { new WorkerFormula { startRow = 1, endRow = 3, imageId = "image", png = "png", width = 100, height = 30 } } };
        int count = 0;
        Action<string, Capture, bool> check = (label, current, expected) => {
            var carried = current.CarryForward(proof);
            if ((carried != null) != expected) throw new Exception(label);
            if (carried != null && (carried.ReceivedAt != proof.ReceivedAt || carried.Formulas[0].imageId != "image"))
                throw new Exception("Carrying must not renew proof or regenerate image");
            count++; Console.WriteLine("PASS " + label);
        };
        check("same-line streaming suffix preserves verified prefix", Snapshot(new[] { lines[0], lines[1], lines[2], lines[3], "  Explanation continues token by token" }), true);
        if (Snapshot(lines).CarryForward(Snapshot(lines).CarryForward(proof)) != null)
            throw new Exception("A display-only carry must never become a new proof anchor");
        check("new lines preserve the existing formula without verifying appended math", Snapshot(new[] { lines[0], lines[1], lines[2], lines[3], lines[4], "  More prose", "  \\[", "  unverified" }), true);
        var scroll = Snapshot(new[] { lines[1], lines[2], lines[3], lines[4] + " continues" }, lines[0] + "\r\n");
        check("automatic scrolling rebases complete formula using exact preceding evidence", scroll, true);
        if (scroll.CarryForward(proof).Formulas[0].startRow != 0) throw new Exception("Wrong rebased row");
        check("clipped formula is never carried", Snapshot(new[] { lines[2], lines[3], lines[4] }, lines[0] + "\n" + lines[1] + "\n"), false);
        check("changed formula cannot use an old image", Snapshot(new[] { lines[0], lines[1], "  x^2+y^2=w^2", lines[3], lines[4] }), false);
        check("changed verified explanation invalidates prefix", Snapshot(new[] { lines[0], lines[1], lines[2], lines[3], "  Changed explanation" }), false);
        check("new candidate waits for worker without removing unchanged proof", Snapshot(new[] { lines[0], lines[1], lines[2], lines[3], lines[4], "• Another candidate" }), true);
        check("wrong preceding role cannot carry a formula", Snapshot(new[] { lines[1], lines[2], lines[3], lines[4] }, "› User prompt\n"), false);
        check("same TeX in a different message cannot borrow proof", Snapshot(new[] { "• Different derivation", lines[1], lines[2], lines[3], lines[4] }), false);
        check("modified closing delimiter line invalidates image", Snapshot(new[] { lines[0], lines[1], lines[2], lines[3] + " extra", lines[4] }), false);
        var duplicate = Snapshot(new[] { lines[0], lines[1], lines[2], lines[3], lines[4] }, String.Join("\n", lines) + "\n");
        check("repeated evidence remains ambiguous", duplicate, false);
        var changed = Snapshot(lines); changed.Pane = "other"; check("pane changes invalidate carry", changed, false);
        changed = Snapshot(lines); changed.Hwnd++; check("window changes invalidate carry", changed, false);
        changed = Snapshot(lines); changed.Width--; check("resize invalidates carry", changed, false);
        changed = Snapshot(lines); changed.Foreground = "#000000"; check("theme changes invalidate carry", changed, false);
        changed = Snapshot(lines); changed.Rows[2].Height--; check("formula row geometry must still agree", changed, false);
        var withProgress = Snapshot(new[] { lines[0], lines[1], lines[2], lines[3], lines[4], "", "• Working (0s • esc to interrupt)", "", "› Input" });
        proof.Source = withProgress;
        proof.SourceRanges = new[] { new SourceRange { startRow = 0, endRow = 5 }, new SourceRange { startRow = 6, endRow = 7 } };
        proof.VerifiedRanges = new[] { new SourceRange { startRow = 0, endRow = 5 } };
        check("actual Codex hollow progress bullet cannot invalidate a verified answer", Snapshot(new[] { lines[0], lines[1], lines[2], lines[3], lines[4], "", "◦ Working (1s • esc to interrupt)", "", "› Input" }), true);
        check("actual Codex solid progress bullet cannot invalidate a verified answer", Snapshot(new[] { lines[0], lines[1], lines[2], lines[3], lines[4], "", "• Working (2s • esc to interrupt)", "", "› Input" }), true);
        check("unrecorded next answer cannot invalidate unchanged historical proof", Snapshot(new[] { lines[0], lines[1], lines[2], lines[3], lines[4], "", "• An incomplete next answer", "  Growing text", "› Input" }), true);
        check("changed historical math is still rejected during progress animation", Snapshot(new[] { lines[0], lines[1], "  x+y=z", lines[3], lines[4], "", "◦ Working (2s • esc to interrupt)", "", "› Input" }), false);
        proof.VerifiedRanges = new SourceRange[0];
        check("explicitly empty verified evidence cannot borrow candidate ranges", withProgress, false);
        proof.VerifiedRanges = null; proof.Source = source;
        proof.SourceRanges = new[] { new SourceRange { startRow = 0, endRow = 4 } };
        proof.ReceivedAt = DateTime.UtcNow.AddSeconds(-7);
        var expired = Snapshot(lines).CarryForward(proof);
        if (expired == null || expired.IsFresh(DateTime.UtcNow)) throw new Exception("Carried proof must expire at original deadline");
        count++; Console.WriteLine("PASS repeated carries cannot extend the original deadline");
        proof.State = "ambiguous"; check("rejected source cannot be carried", Snapshot(lines), false);
        var inlineLines = new[] { "• 定义圆的公式 x² + y² = r²，继续说明。", "  结尾" };
        var inlineSource = Snapshot(inlineLines); inlineSource.InlineMath = true;
        var inlineProof = new RenderResult { Key = inlineSource.Key, State = "matched", Source = inlineSource,
            ReceivedAt = DateTime.UtcNow, SourceRanges = new[] { new SourceRange { startRow = 0, endRow = 1 } },
            Formulas = new[] { new WorkerFormula { startRow = 0, endRow = 0, startColumn = 9, endColumn = 21,
                visibleText = "x² + y² = r²", kind = "inline", offsetY = 2, width = 120, height = 20 } } };
        var currentInline = Snapshot(inlineLines); currentInline.InlineMath = true;
        if (!currentInline.CanReuse(inlineProof)) throw new Exception("Unchanged inline capture must reuse proof");
        count++; Console.WriteLine("PASS identical inline capture reuses proof");
        var carriedInline = currentInline.CarryForward(inlineProof).Formulas[0];
        if (carriedInline.startColumn != 9 || carriedInline.endColumn != 21 || carriedInline.offsetY != 2 ||
            carriedInline.visibleText != "x² + y² = r²" || carriedInline.kind != "inline") throw new Exception("Inline carry lost substring geometry");
        count++; Console.WriteLine("PASS inline carry retains columns, literal and baseline");
        currentInline.InlineMath = false;
        if (currentInline.CanReuse(inlineProof) || currentInline.CarryForward(inlineProof) != null) throw new Exception("Feature mismatch borrowed inline proof");
        count++; Console.WriteLine("PASS feature changes invalidate inline reuse and carry");
        foreach (var marker in new[] { "● ", "⏺ " }) {
            var claudeLines = new[] { marker + "Verified mathematical answer.", "", "  x^2+y^2=r^2", "", "  End of derivation." };
            var claudeSource = Snapshot(claudeLines);
            var claudeProof = new RenderResult { Key = claudeSource.Key, State = "matched", Source = claudeSource,
                ReceivedAt = DateTime.UtcNow, SourceRanges = new[] { new SourceRange { startRow=0,endRow=4 } },
                Formulas = new[] { new WorkerFormula { startRow=1,endRow=3,imageId="claude",png="png",width=100,height=30 } } };
            if (!Snapshot(claudeLines).CanReuse(claudeProof)) throw new Exception("Claude static proof failed");
            var flowing = Snapshot(new[] { claudeLines[0],claudeLines[1],claudeLines[2],claudeLines[3],claudeLines[4],"✻ Thinking for 2s","❯ next" });
            if (flowing.CarryForward(claudeProof)==null) throw new Exception("Claude progress animation removed old formula");
            var shifted=Snapshot(new[] {claudeLines[1],claudeLines[2],claudeLines[3],claudeLines[4]},claudeLines[0]+"\n");
            if (shifted.CarryForward(claudeProof)==null) throw new Exception("Claude scroll failed");
            shifted.Lines[1]="  x^2+y^2=z^2";
            if (shifted.CarryForward(claudeProof)!=null) throw new Exception("Claude changed formula reused stale proof");
            count+=4; Console.WriteLine("PASS Claude marker, progress, scroll and changed formula: " + marker);
        }
        var historyLines = new[] { "❯ Explain the formula.", "  A verified historical derivation.", "", "  x_t^2+y_t^2=r^2", "  Verified ending.",
            "  Jump to bottom (ctrl+End) ↓", "────────────────────", "❯ ", "────────────────────", "  ⏵⏵ bypass permissions on (shift+tab to cycle)" };
        var historySource = Snapshot(historyLines);
        var historyProof = new RenderResult { Key = historySource.Key, State = "matched", Source = historySource,
            ReceivedAt = DateTime.UtcNow, SourceRanges = new[] { new SourceRange { startRow = 1, endRow = 4 } },
            Formulas = new[] { new WorkerFormula { startRow = 2, endRow = 3, imageId = "history", png = "png", width = 100, height = 30 } } };
        Action<string, int, string, bool> historyCheck = (label, row, text, expected) => {
            var current = Snapshot((string[])historyLines.Clone());
            if (row >= 0) current.Lines[row] = text;
            if (current.CanReuse(historyProof) != expected) throw new Exception(label);
            count++; Console.WriteLine("PASS " + label);
        };
        historyCheck("Claude repainted history reuses exact verified body without assistant marker", -1, "", true);
        historyCheck("Claude history status animation does not hide verified formulas", 9, "  ✻ Thinking for 2s", true);
        historyCheck("Claude history typed input does not hide verified formulas", 7, "❯ next question", true);
        historyCheck("Claude history changed pinned prompt invalidates proof", 0, "❯ A different conversation.", false);
        historyCheck("Claude history changed formula invalidates proof", 3, "  x_t^2+y_t^2=z^2", false);
        var bottomLines = (string[])historyLines.Clone(); bottomLines[5] = "";
        var bottomSource = Snapshot(bottomLines);
        var bottomProof = new RenderResult { Key = bottomSource.Key, State = "matched", Source = bottomSource,
            ReceivedAt = historyProof.ReceivedAt, SourceRanges = new[] { new SourceRange { startRow = 1, endRow = 5 } }, Formulas = historyProof.Formulas };
        if (!Snapshot(bottomLines).CanReuse(bottomProof)) throw new Exception("Claude bottom viewport proof failed");
        var unknownBottom = Snapshot((string[])bottomLines.Clone()); unknownBottom.Lines[9] = "  Unknown application";
        if (unknownBottom.CanReuse(bottomProof)) throw new Exception("Unknown terminal frame reused Claude proof");
        count += 2; Console.WriteLine("PASS Claude bottom frame retains proof and rejects unknown footer");
        var unpinned = new[] { "  A verified historical derivation.", "", "  x_t^2+y_t^2=r^2", "  Verified ending.",
            "  ✻ Churned for 35s · done 17:54", "────────────────────", "❯ ", "────────────────────", "  ⏵⏵ bypass permissions on (shift+tab to cycle)" };
        var unpinnedSource = Snapshot(unpinned);
        var unpinnedProof = new RenderResult { Key = unpinnedSource.Key, State = "matched", Source = unpinnedSource,
            ReceivedAt = historyProof.ReceivedAt, SourceRanges = new[] { new SourceRange { startRow = 0, endRow = 3 } },
            Formulas = new[] { new WorkerFormula { startRow = 1, endRow = 2, imageId = "bottom", png = "png", width = 100, height = 30 } } };
        var animatedBottom = Snapshot((string[])unpinned.Clone()); animatedBottom.Lines[4] += " · 1";
        if (!animatedBottom.CanReuse(unpinnedProof)) throw new Exception("Unpinned bottom completion redraw invalidated unchanged body");
        animatedBottom.Lines[2] = "  x_t^2+y_t^2=z^2";
        if (animatedBottom.CanReuse(unpinnedProof)) throw new Exception("Unpinned bottom redraw retained changed formula");
        count += 2; Console.WriteLine("PASS unpinned bottom animation retains exact proof and rejects altered math");
        historyCheck("Claude history missing input frame invalidates proof", 6, "", false);
        Console.WriteLine(count + " streaming proof checks passed");
        return 0;
    }
}
