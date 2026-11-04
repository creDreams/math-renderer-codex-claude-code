const rule = /^─{3,}$/u;
const prompt = /^❯(?:\s|$)/u;
export const claudeHistoryLabel = /\bJump to bottom \(ctrl\+End\) ↓\s*$/u;
const mode = /(?:shift\+tab to cycle|\? for shortcuts)/u;

/** Claude redraws its viewport, including the input frame, instead of keeping
 * the whole answer in terminal scrollback. Neither a pinned question, a jump
 * hint nor an assistant bullet is guaranteed at the bottom. The stable frame
 * establishes the provider; exact assistant source matching proves the math. */
export function claudeViewport(rows: readonly string[]): { startRow: number; endRow: number } | undefined {
    for (let separator = rows.length - 4; separator >= 0; separator--) {
        if (!rule.test(rows[separator]!.trimEnd()) || !prompt.test(rows[separator + 1]!))
            continue;
        let closing = separator + 2;
        while (closing < rows.length && !rule.test(rows[closing]!.trimEnd()))
            closing++;
        if (closing === rows.length)
            continue;
        let label = separator - 1;
        while (label >= 0 && !rows[label]!.trim()) label--;
        if (label < 0 || !claudeHistoryLabel.test(rows[label]!)) label = -1;
        if (label < 0 && !rows.slice(closing + 1).some(row => mode.test(row)))
            continue;
        // A floating hint can share a content row. Keep that row literal so
        // an overlay never erases the terminal's navigation control.
        const startRow = prompt.test(rows[0] ?? '') ? 1 : 0;
        const endRow = (label < 0 ? separator : label) - 1;
        if (startRow <= endRow)
            return { startRow, endRow };
    }
}
