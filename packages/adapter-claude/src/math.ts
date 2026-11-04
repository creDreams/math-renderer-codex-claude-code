import { fromMarkdown } from 'mdast-util-from-markdown';
import { findDisplayMath } from '../../core/src/display-math.js';
import { LruCache } from '../../core/src/lru.js';
import { parseClaudeNotation } from './notation.js';
import { inspectClaudeMathBlock, type MathBlockCandidate } from './math-block.js';
export interface ClaudeMathCandidate extends MathBlockCandidate {
    marked: boolean;
}
export interface ClaudeFormula extends ClaudeMathCandidate {
    raw: string;
    tex: string;
    start: number;
    end: number;
    marked: boolean;
}
export interface ClaudeMathReport {
    candidates: ClaudeMathCandidate[];
    formulas: ClaudeFormula[];
    rejectedBlocks: { start: number; end: number; reason: string }[];
}
const cache = new LruCache<ClaudeMathReport>(64, 4 * 1024 * 1024);
export const claudeMathTex = parseClaudeNotation;
/** Only complete source blocks qualify. A code fence still open in streamed
 * text never becomes proof. Program-language fences remain protected. */
export function inspectClaudeMath(source: string): ClaudeMathReport {
    const hit = cache.get(source);
    if (hit)
        return hit;
    if (source.length > 1024 * 1024)
        return { candidates: [], formulas: [], rejectedBlocks: [{ start: 0, end: source.length, reason: 'limit' }] };
    const result: ClaudeMathCandidate[] = findDisplayMath(source).map(span => ({ ...span, raw: source.slice(span.start, span.end), marked: true }));
    const rejectedBlocks: ClaudeMathReport['rejectedBlocks'] = [];
    type Node = ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>['children'][number];
    const visit = (node: Node) => {
        if (node.type === 'code') {
            const start = node.position?.start.offset, end = node.position?.end.offset;
            if (start === undefined || end === undefined || !/^(?:|math|latex|tex|text|plaintext)$/i.test(node.lang ?? ''))
                return;
            const original = source.slice(start, end), opener = /^(`{3,}|~{3,})[^\n]*\n/.exec(original);
            if (!opener)
                return; // Indentation alone is not an explicit math container.
            const closing = new RegExp('\\n[ \\t]*' + opener[1]![0] + '{' + opener[1]!.length + ',}[ \\t]*$');
            if (!closing.test(original))
                return;
            const bodyStart = start + opener[0].length, bodyEnd = end - closing.exec(original)![0].length;
            const body = source.slice(bodyStart, bodyEnd);
            const namedMath = /^(math|latex|tex)$/i.test(node.lang ?? '');
            const report = inspectClaudeMathBlock(body, namedMath ? 'formula' : source.slice(Math.max(0, start - 384), start));
            if (report.reason === 'program' || report.reason === 'limit') {
                rejectedBlocks.push({ start, end, reason: report.reason }); return;
            }
            const candidates = report.candidates;
            const wrappedBody = findDisplayMath(body.trim());
            const explicitBody = wrappedBody.length === 1 && wrappedBody[0]!.start === 0 && wrappedBody[0]!.end === body.trim().length;
            if (!candidates.length && (namedMath || explicitBody) && body.trim()) {
                const raw = body.trim(), at = body.indexOf(raw);
                candidates.push({ raw, start: at, end: at + raw.length });
            }
            for (const candidate of candidates) {
                const literal = findDisplayMath(candidate.raw);
                const wrapped = literal.length === 1 && literal[0]!.start === 0 && literal[0]!.end === candidate.raw.length;
                const tex = wrapped ? literal[0]!.tex : candidate.tex ?? (namedMath ? candidate.raw.replace(/^\$([^$]+)\$$/s, '$1') : undefined);
                result.push({ ...candidate, tex, reason: tex ? undefined : candidate.reason,
                    start: bodyStart + candidate.start, end: bodyStart + candidate.end, marked: namedMath || wrapped });
            }
            if (!candidates.length) rejectedBlocks.push({ start, end, reason: report.reason ?? 'not-math' });
            return;
        }
        if ('children' in node)
            for (const child of node.children)
                visit(child as Node);
    };
    visit(fromMarkdown(source));
    result.sort((a, b) => a.start - b.start);
    const report = { candidates: result, formulas: result.filter((value): value is ClaudeFormula => !!value.tex), rejectedBlocks };
    cache.set(source, report, source.length * 2 + result.reduce((n, x) => n + (x.raw.length + (x.tex?.length ?? 0)) * 2 + 96, 0));
    return report;
}

export function findClaudeFormulas(source: string): ClaudeFormula[] { return inspectClaudeMath(source).formulas; }
