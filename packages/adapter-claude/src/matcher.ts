import { fromMarkdown } from 'mdast-util-from-markdown';
import type { CodexSession, MatchResult } from '../../adapter-codex/src/matcher.js';
import { LruCache } from '../../core/src/lru.js';
import { findClaudeFormulas, inspectClaudeMath } from './math.js';
import { findDisplayMath } from '../../core/src/display-math.js';
import { claudeViewport } from './viewport.js';
const compact = (text: string) => text.replace(/\s/gu, '');
const presentationCache = new LruCache<{
    text: string;
    offsets: number[];
}>(64, 4 * 1024 * 1024);
const assistant = /^(?:●|⏺) /u;
const tool = /^(?:●|⏺) (?:Bash|Read|Write|Edit|Glob|Grep|Search|WebSearch|WebFetch|Task|Agent|TodoWrite|ToolSearch|Skill|NotebookEdit|mcp__)[(\s:]/u;
const boundary = /^(?:❯|›|>)(?:\s|$)|^\s*[✻✢✳✽✶](?:\s|$)|^\s*⎿|^─{3,}/u;
export function isClaudeScreen(text: string, context = ''): boolean {
    if (claudeViewport(text.split(/\r?\n/)))
        return true;
    // A terminal can run Claude and later Codex in the same tab. Older Claude
    // scrollback must not select its adapter for the newer Codex answer.
    const roles = [...(context + '\n' + text).matchAll(/(?:^|\n)(•|●|⏺) /gu)];
    return !!roles.length && roles.at(-1)![1] !== '•';
}
export function claudeRegions(text: string, context = '') {
    let continuing = false;
    for (const row of context.split(/\r?\n/)) {
        if (assistant.test(row))
            continuing = !tool.test(row);
        else if (boundary.test(row) || row.trim() && !row.startsWith('  '))
            continuing = false;
    }
    const regions: {
        text: string;
        startRow: number;
        endRow: number;
        clipped: boolean;
        history: boolean;
    }[] = [];
    const rows = text.split(/\r?\n/).map(row => row.trimEnd());
    const history = claudeViewport(rows);
    for (let i = history?.startRow ?? 0; i <= (history?.endRow ?? rows.length - 1);) {
        const first = rows[i]!;
        const starts = assistant.test(first) && !tool.test(first);
        const clipped = i === 0 && continuing || !!history && i === history.startRow && !assistant.test(first.trimStart()) && !boundary.test(first);
        if (!starts && !clipped) {
            i++;
            continue;
        }
        const startRow = i, out: string[] = [];
        for (; i <= (history?.endRow ?? rows.length - 1); i++) {
            const row = rows[i]!;
            if (i > startRow && (assistant.test(history ? row.trimStart() : row) || boundary.test(row) || !history && row.trim() && !row.startsWith('  ')))
                break;
            if (boundary.test(row))
                break;
            out.push(i === startRow && starts ? row.slice(2) : row.startsWith('  ') ? row.slice(2) : row);
        }
        if (out.length)
            regions.push({ text: out.join('\n'), startRow, endRow: i - 1, clipped, history: !!history });
        else
            i++;
    }
    return regions;
}
/** Known Markdown hiding only. Every retained character maps to its source
 * position; code content and math operands are never replaced with wildcards. */
function presentation(source: string) {
    const hit = presentationCache.get(source);
    if (hit)
        return hit;
    const remove: {
        start: number;
        end: number;
    }[] = [];
    type Node = ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>['children'][number];
    const visit = (node: Node) => {
        const start = node.position?.start.offset, end = node.position?.end.offset;
        if (start === undefined || end === undefined)
            return;
        const raw = source.slice(start, end);
        if (node.type === 'code') {
            const first = /^(?:`{3,}|~{3,})[^\n]*\n/.exec(raw);
            const last = /\n[ \t]*(?:`{3,}|~{3,})[ \t]*$/.exec(raw);
            if (first)
                remove.push({ start, end: start + first[0].length });
            if (last)
                remove.push({ start: start + last.index, end });
            return;
        }
        if (node.type === 'inlineCode') {
            const tick = /^`+/.exec(raw)![0].length;
            remove.push({ start, end: start + tick }, { start: end - tick, end });
            return;
        }
        if (node.type === 'emphasis' || node.type === 'strong') {
            const size = node.type === 'strong' ? 2 : 1;
            remove.push({ start, end: start + size }, { start: end - size, end });
        }
        if (node.type === 'heading') {
            const mark = /^#{1,6}\s+/.exec(raw);
            if (mark)
                remove.push({ start, end: start + mark[0].length });
        }
        // Lists keep their labels. Only remove the known bullet character, which
        // Claude can paint using a different glyph; surrounding text still proves it.
        if (node.type === 'listItem') {
            const mark = /^[-*+]\s/.exec(raw);
            if (mark)
                remove.push({ start, end: start + 1 });
        }
        if ('children' in node)
            for (const child of node.children)
                visit(child as Node);
    };
    // Prevent TeX underscores and stars being consumed as Markdown emphasis.
    let masked = source;
    for (const span of findDisplayMath(source).reverse())
        masked = masked.slice(0, span.start) + masked.slice(span.start, span.end).replace(/[^\s]/g, 'x') + masked.slice(span.end);
    visit(fromMarkdown(masked));
    remove.sort((a, b) => a.start - b.start);
    const offsets: number[] = [];
    let text = '', range = 0;
    for (let i = 0; i < source.length; i++) {
        while (range < remove.length && remove[range]!.end <= i)
            range++;
        if (range < remove.length && remove[range]!.start <= i || /\s/u.test(source[i]!))
            continue;
        text += source[i];
        offsets.push(i);
    }
    const result = { text, offsets };
    presentationCache.set(source, result, (source.length + text.length) * 2 + offsets.length * 8);
    return result;
}
export function claudeSourceKeys(source: string): string[] {
    return [...new Set(inspectClaudeMath(source).candidates.flatMap(x => formulaForms(x.raw))
        .filter(x => x.length >= 8 && x.length <= 4096).map(x => 'claude:' + x))];
}
const formulaForms = (raw: string) => [...new Set([compact(raw), compact(raw.replace(/\\(?=[\[\]])/g, ''))])];
export function claudeVisibleKeys(text: string, context: string, lengths?: ReadonlySet<number>): string[] {
    const keys = new Set<string>();
    if (lengths && !lengths.size)
        return [];
    const sizes = lengths ? [...lengths].sort((a, b) => a - b) : undefined;
    for (const region of claudeRegions(text, context)) {
        const rows = region.text.split('\n').map(compact), full = rows.join('');
        const boundaries = new Set<number>([0]);
        let offset = 0;
        for (const row of rows) {
            offset += row.length;
            boundaries.add(offset);
        }
        const positions = [...boundaries];
        for (const [index, start] of positions.entries()) {
            const add = (end: number) => keys.add('claude:' + full.slice(start, end));
            // Seek only lengths present in the disk index. Common prefixes such as
            // J(θ)=E[...] never cause all historical PPO answers to be reread.
            if (sizes && sizes.length < positions.length - index) {
                for (const size of sizes) {
                    const end = start + size;
                    if (end > full.length)
                        break;
                    if (boundaries.has(end))
                        add(end);
                }
            }
            else
                for (let next = index + 1; next < positions.length; next++) {
                    const end = positions[next]!, size = end - start;
                    if (size > 4096)
                        break;
                    if (size >= 8 && (!lengths || lengths.has(size)))
                        add(end);
                }
        }
    }
    return [...keys];
}
export function matchClaudeText(text: string, sessions: CodexSession[], context = '', inline = false): MatchResult {
    const screens = claudeRegions(text, context);
    const sourceRanges = screens.map(({ startRow, endRow }) => ({ startRow, endRow }));
    const empty: MatchResult = { state: 'waiting', regions: [], sourceRanges, verifiedRanges: [] };
    const found = new Map<string, MatchResult>();
    for (const session of sessions)
        for (const source of session.assistant) {
            const sourceView = presentation(source);
            for (const screen of screens) {
                const prior = screen.clipped ? compact(claudeRegions(context).at(-1)?.text ?? '') : '';
                const rows = screen.text.split('\n'), locations: {
                    row: number;
                    column: number;
                }[] = [];
                let shown = '';
                for (const [row, line] of rows.entries())
                    for (let col = 0; col < line.length; col++)
                        if (!/\s/u.test(line[col]!)) {
                            shown += line[col];
                            locations.push({ row: screen.startRow + row, column: col + 2 });
                        }
                for (const formula of findClaudeFormulas(source)) {
                    // Unmarked mathematical code blocks share the existing preview toggle.
                    if (!formula.marked && !inline)
                        continue;
                    const sourceAt = sourceView.offsets.findIndex(x => x >= formula.start);
                    const originalKey = compact(formula.raw);
                    if (sourceAt < 0 || sourceView.text.slice(sourceAt, sourceAt + originalKey.length) !== originalKey)
                        continue;
                    for (const key of formulaForms(formula.raw)) {
                        if (key.length < 8)
                            continue;
                        for (let at = shown.indexOf(key); at >= 0; at = shown.indexOf(key, at + 1)) {
                            const first = locations[at]!, last = locations[at + key.length - 1]!;
                            const start = first.row - screen.startRow, end = last.row - screen.startRow;
                            // No prose may share a covered row, and a clipped formula never owns
                            // another formula's whitespace or its visible tail.
                            const beforeRow = compact(rows[start]!).indexOf(key.slice(0, Math.min(key.length, compact(rows[start]!).length)));
                            if (beforeRow !== 0 || compact(rows.slice(start, end + 1).join('')) !== key)
                                continue;
                            // Require neighbouring literal answer text, or a proven assistant
                            // start. A coloured substring alone is insufficient source evidence.
                            const before = (prior + shown.slice(0, at)).slice(-40).replace(/[•·]/g, '');
                            const after = shown.slice(at + key.length, at + key.length + 40).replace(/[•·]/g, '');
                            const originalBefore = sourceView.text.slice(Math.max(0, sourceAt - 40), sourceAt).replace(/[•·]/g, '');
                            const originalAfter = sourceView.text.slice(sourceAt + originalKey.length, sourceAt + originalKey.length + 40).replace(/[•·]/g, '');
                            const leftSize = Math.min(before.length, originalBefore.length), rightSize = Math.min(after.length, originalAfter.length);
                            const left = leftSize >= 8 && before.slice(-leftSize) === originalBefore.slice(-leftSize);
                            const right = rightSize >= 8 && after.slice(0, rightSize) === originalAfter.slice(0, rightSize);
                            const starts = at === 0 && sourceAt === 0 && !screen.clipped;
                            // A one-row historical viewport can expose only the
                            // complete expression. The proven Claude history frame
                            // and unique exact source still establish its origin;
                            // visible conflicting prose must never be ignored.
                            const isolatedHistory = screen.history && before.length < 8 && after.length < 8;
                            if (!left && !right && !starts && !isolatedHistory)
                                continue;
                            const match = found.get(session.file) ?? { ...empty, state: 'matched' as const, sessionId: session.id, regions: [], verifiedRanges: [] };
                            const region = { tex: formula.tex, startRow: first.row, endRow: last.row, startColumn: 0, endColumn: 0,
                                ...(!formula.marked ? { requiresPreview: true, compactFallback: true } : {}) };
                            if (!match.regions.some(x => x.startRow === region.startRow && x.endRow === region.endRow))
                                match.regions.push(region);
                            const range = { startRow: screen.startRow, endRow: screen.endRow };
                            if (!match.verifiedRanges!.some(x => x.startRow === range.startRow && x.endRow === range.endRow))
                                match.verifiedRanges!.push(range);
                            found.set(session.file, match);
                        }
                    }
                }
            }
        }
    if (found.size > 1)
        return { ...empty, state: 'ambiguous' };
    const selected = found.values().next().value;
    if (!selected)
        return empty;
    // Claude leaves blank rows around rendered code fences. Reuse only actual
    // empty viewport rows, assigning each at most once, to fit readable scripts
    // without changing terminal line heights or covering neighbouring prose.
    const rows = text.split(/\r?\n/), occupied = new Set<number>();
    selected.regions.sort((a, b) => a.startRow - b.startRow);
    for (const region of selected.regions)
        for (let r = region.startRow; r <= region.endRow; r++)
            occupied.add(r);
    for (const region of selected.regions) {
        const source = sourceRanges.find(x => region.startRow >= x.startRow && region.endRow <= x.endRow)!;
        if (region.startRow > source.startRow && !rows[region.startRow - 1]!.trim() && !occupied.has(region.startRow - 1))
            occupied.add(--region.startRow);
        if (region.endRow < source.endRow && !rows[region.endRow + 1]!.trim() && !occupied.has(region.endRow + 1))
            occupied.add(++region.endRow);
    }
    return selected;
}
