using System;
using System.Text.RegularExpressions;

namespace AgentMath {
    // Kept in sync with adapter-claude/viewport.ts by shared layout fixtures.
    // Provider identity comes from the stable input frame; the worker still
    // independently verifies each mathematical expression against its source.
    internal static class ClaudeViewport {
        internal static bool IsLabel(string line) {
            return Regex.IsMatch(line, @"\bJump to bottom \(ctrl\+End\) ↓\s*$");
        }
        internal static bool IsStatus(string line) {
            return Regex.IsMatch(line, @"^\s*[✻✢✳✽✶](?:\s|$)");
        }
        internal static SourceRange Body(string[] rows) {
            for (int separator = rows.Length - 4; separator >= 0; separator--) {
                if (!Regex.IsMatch(rows[separator].TrimEnd(), @"^─{3,}$") || !Regex.IsMatch(rows[separator + 1], @"^❯(?:\s|$)")) continue;
                int closing = separator + 2;
                while (closing < rows.Length && !Regex.IsMatch(rows[closing].TrimEnd(), @"^─{3,}$")) closing++;
                if (closing == rows.Length) continue;
                int label = separator - 1;
                while (label >= 0 && rows[label].Trim().Length == 0) label--;
                if (label < 0 || !IsLabel(rows[label])) label = -1;
                bool mode = false;
                for (int row = closing + 1; row < rows.Length; row++)
                    if (Regex.IsMatch(rows[row], @"(?:shift\+tab to cycle|\? for shortcuts)")) { mode = true; break; }
                if (label < 0 && !mode) continue;
                int first = Regex.IsMatch(rows[0], @"^❯(?:\s|$)") ? 1 : 0;
                int last = (label < 0 ? separator : label) - 1;
                if (first <= last) return new SourceRange { startRow = first, endRow = last };
            }
            return null;
        }
        internal static bool Contains(string[] rows, int first, int last) {
            var body = Body(rows);
            return body != null && first >= body.startRow && last <= body.endRow;
        }
    }
}
