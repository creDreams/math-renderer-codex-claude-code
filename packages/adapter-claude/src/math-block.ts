import { convertClaudeNotation, hasClaudeProgramSyntax, parseClaudeNotation } from './notation.js';

export interface MathBlockCandidate {
    raw: string; start: number; end: number; tex?: string;
    reason?: 'unsupported' | 'incomplete' | 'limit';
}
export interface MathBlockSpan extends MathBlockCandidate { tex: string }
export interface MathBlockReport {
    candidates: MathBlockCandidate[];
    reason?: 'program' | 'not-math' | 'limit';
}
const chineseCue = '(?:当|若|如果|其中|式中|这里|此处|否则|对应|表示|单位|说明|注[：:])';
const annotation = new RegExp('[ \\t]+(?=' + chineseCue + ')|(?:[ \\t]{2,}|,[ \\t]+)(?=(?:where|if|when|otherwise|for|with)\\b)', 'u');
const explanation = /^(?:其中|式中|这里|此处|说明[：:]|注[：:]|where\b|with\b|note\s*:)/iu;
const contextMath = /公式|目标|损失|梯度|概率|数学|方程|定义|推导|derivation|equation|mathemat|objective|gradient|probability|definition|formula/iu;
const continuation = /^(?:[=+−*/≈≃≡≤≥<>∝≻≺·×]|-(?!\s+[A-Za-z]{2,})|\\(?:approx|sim|propto|leq?|geq?|equiv|cdot|times)\b)/u;
const escapeText = (raw: string) => raw.replace(/[\\{}$]/g, ch => '\\' + ch);
const gathered = (values: string[]) => values.length === 1 ? values[0]! : '\\begin{gathered}' + values.join('\\\\') + '\\end{gathered}';

/** Written mathematical evidence, independent of the converter's dictionary. */
export function hasClaudeMathEvidence(raw: string): boolean {
    return /[\p{Script=Greek}\u2190-\u22ff\u27c0-\u2aff‖]|\\[A-Za-z]+/u.test(raw) ||
        /[_^][{(\\\p{L}\p{N}*]/u.test(raw) && /[=+−*/<>≤≥]|\w\s*\(/u.test(raw);
}
function prose(raw: string): boolean {
    return explanation.test(raw.trimStart()) || !hasClaudeMathEvidence(raw) &&
        (/\p{Script=Han}/u.test(raw) || /(?:[A-Za-z]{2,}[ \t]+){2,}[A-Za-z]/u.test(raw));
}
function balance(raw: string): number {
    let level = 0;
    const suffixAt = (start: number) => {
        const end = raw.indexOf('\n', start), at = annotation.exec(raw.slice(start, end < 0 ? raw.length : end))?.index;
        return at === undefined ? -1 : start + at;
    };
    let suffix = suffixAt(0);
    for (let at = 0; at < raw.length; at++) {
        const ch = raw[at]!;
        if (ch === '\n') suffix = suffixAt(at + 1);
        if (at === suffix && level === 0) {
            const end = raw.indexOf('\n', at);
            if (end < 0) break;
            at = end - 1; continue;
        }
        if (ch === '\\') {
            const text = /^\\(?:text|mathrm|operatorname)\s*\{/.exec(raw.slice(at));
            if (text) {
                let braces = 1;
                at += text[0].length;
                for (; at < raw.length; at++) {
                    if (raw[at] === '\\') { at++; continue; }
                    if (raw[at] === '{') braces++;
                    if (raw[at] === '}' && --braces === 0) break;
                }
                if (braces) return level + 1;
                continue;
            }
        }
        if (ch === '\\' && /[{},;! ]/.test(raw[at + 1] ?? '')) { at++; continue; }
        if ('([{'.includes(ch)) level++;
        if (')]}'.includes(ch)) level--;
    }
    return level;
}
function program(raw: string): boolean {
    if (hasClaudeProgramSyntax(raw) || /\bfor\s+\w+\s+in\b|\+=|-=|\*=|\/=|(?:^|[=(,])\s*'[^'\r\n]*'/m.test(raw)) return true;
    let depth = 0;
    for (let at = 0; at < raw.length; at++) {
        const ch = raw[at]!;
        if (ch === '\\') { at++; continue; }
        if ('([{'.includes(ch)) depth++;
        if (')]}'.includes(ch)) depth--;
        if (ch === ';' && depth <= 0) return true;
    }
    return false;
}
const endsOperator = (raw: string) => /[=+−*/·×,]\s*$/u.test(raw);
const independent = (raw: string) => /^[^=<>≤≥\r\n]{1,128}=(?!=)/u.test(raw.trimStart());

function annotated(raw: string): string | undefined {
    const split = annotation.exec(raw);
    if (!split || /[\r\n]/.test(raw)) return;
    const prefix = raw.slice(0, split.index), suffix = raw.slice(split.index);
    if (suffix.length > 256) return;
    const tex = parseClaudeNotation(prefix) ?? convertClaudeNotation(prefix).tex;
    return tex ? tex + '\\text{' + escapeText(suffix) + '}' : undefined;
}

/** Complete physical lines are independent unless an operator continues them. */
function units(raw: string): { raw: string; start: number }[] {
    const out: { raw: string; start: number }[] = [];
    const lines = [...raw.matchAll(/[^\n]*(?:\n|$)/g)].filter(m => m[0]);
    const following: (typeof lines[number] | undefined)[] = [];
    let nextLine: typeof lines[number] | undefined;
    for (let i = lines.length - 1; i >= 0; i--) {
        following[i] = nextLine;
        if (lines[i]![0].trim()) nextLine = lines[i];
    }
    let begin = 0, level = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!, next = following[i];
        level += balance(line[0]);
        if (level !== 0 || !next || continuation.test(next[0].trimStart()) || endsOperator(line[0])) continue;
        const end = line.index! + line[0].length;
        const value = raw.slice(begin, end).trim();
        if (value) out.push({ raw: value, start: begin + raw.slice(begin, end).indexOf(value) });
        begin = end;
    }
    const value = raw.slice(begin).trim();
    if (value) out.push({ raw: value, start: begin + raw.slice(begin).indexOf(value) });
    return out;
}
function expression(raw: string): Pick<MathBlockCandidate, 'tex' | 'reason'> {
    if (raw.length > 4096 || raw.split('\n').length > 64) return { reason: 'limit' };
    if (balance(raw) !== 0) return { reason: 'incomplete' };
    const rows: string[] = [];
    let begin = 0, level = 0;
    for (const line of raw.matchAll(/[^\n]*(?:\n|$)/g)) {
        if (!line[0]) continue;
        if (level === 0 && continuation.test(line[0].trimStart()) && raw.slice(begin, line.index).trim()) {
            rows.push(raw.slice(begin, line.index).trim()); begin = line.index!;
        }
        level += balance(line[0]);
    }
    rows.push(raw.slice(begin).trim());
    const values = rows.map((row, i) => parseClaudeNotation(row) ?? annotated(row) ?? convertClaudeNotation(row, i > 0).tex);
    if (values.some(value => !value)) return { reason: 'unsupported' };
    return { tex: gathered(values as string[]) };
}

export function inspectClaudeMathBlock(body: string, context = ''): MathBlockReport {
    if (body.length > 65536 || body.split('\n').length > 2048) return { candidates: [], reason: 'limit' };
    if (program(body)) return { candidates: [], reason: 'program' };
    if (!hasClaudeMathEvidence(body) && !(contextMath.test(context) && /[=<>≤≥]/u.test(body)))
        return { candidates: [], reason: 'not-math' };
    const candidates: MathBlockCandidate[] = [];
    const emit = (raw: string, start: number) => {
        const value = raw.trim();
        if (!value) return;
        start += raw.indexOf(value);
        const parts = units(value).map(part => ({ raw: part.raw, start: start + part.start,
            end: start + part.start + part.raw.length, ...expression(part.raw) }));
        if (parts.length > 1 && parts.every(part => part.tex)) {
            candidates.push({ raw: value, start, end: start + value.length, tex: gathered(parts.map(part => part.tex!)) });
        } else candidates.push(...parts);
    };
    // A broken structure cannot consume a later standalone equation.
    const paragraphs: { raw: string; start: number }[] = [];
    let offset = 0;
    for (const part of body.split(/\r?\n[ \t]*\r?\n/)) {
        const local = body.indexOf(part, offset); offset = local + part.length;
        const raw = part.trim();
        if (!raw) continue;
        const start = local + part.indexOf(raw), previous = paragraphs.at(-1);
        if (previous && (continuation.test(raw) || balance(previous.raw) > 0 && !independent(raw)))
            previous.raw = body.slice(previous.start, start + raw.length);
        else paragraphs.push({ raw, start });
    }
    for (const paragraph of paragraphs) {
        let begin = 0, level = 0;
        for (const line of paragraph.raw.matchAll(/[^\n]*(?:\n|$)/g)) {
            if (!line[0]) continue;
            if (level === 0 && prose(line[0])) {
                emit(paragraph.raw.slice(begin, line.index), paragraph.start + begin);
                begin = line.index! + line[0].length;
            } else level += balance(line[0]);
        }
        emit(paragraph.raw.slice(begin), paragraph.start + begin);
    }
    return { candidates };
}

export function parseClaudeMathBlock(body: string, context = ''): MathBlockSpan[] | undefined {
    const values = inspectClaudeMathBlock(body, context).candidates.filter((span): span is MathBlockSpan => !!span.tex);
    return values.length ? values : undefined;
}
