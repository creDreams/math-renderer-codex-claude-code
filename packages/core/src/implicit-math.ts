import { findDisplayMath } from './display-math.js';
import { findCodeRanges, type TextRange } from './markdown-code.js';
import { LruCache } from './lru.js';

/** Bump with grammar changes: history and negative caches are derived data. */
export const INLINE_GRAMMAR = 'inline-1';
export interface InlineMath extends TextRange {
  raw: string; tex: string; marked: boolean; reason: 'delimited' | 'structure' | 'equation' | 'context';
}
const cache = new LruCache<InlineMath[]>(128, 8 * 1024 * 1024);
const hint = /公式|函数|梯度|损失|概率|期望|方差|变量|定义|满足|其中|(?:令|设|取)\s*|\b(?:equation|formula|gradient|loss|probability|variance|where|let|define)\b/iu;
const labels = new Set(['total', 'CLIP', 'VF', 'prior', 'old', 'new', 'gen', 'ref', 'mean', 'max', 'min']);
const functions = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh', 'exp', 'log', 'ln',
  'sqrt', 'min', 'max', 'argmin', 'argmax', 'clip', 'KL', 'Pr', 'det', 'tr']);
const symbols: Record<string, string> = {
  'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta', 'ε': '\\varepsilon', 'ϵ': '\\epsilon',
  'ζ': '\\zeta', 'η': '\\eta', 'θ': '\\theta', 'ϑ': '\\vartheta', 'ι': '\\iota', 'κ': '\\kappa',
  'λ': '\\lambda', 'μ': '\\mu', 'ν': '\\nu', 'ξ': '\\xi', 'π': '\\pi', 'ϖ': '\\varpi', 'ρ': '\\rho',
  'ϱ': '\\varrho', 'σ': '\\sigma', 'ς': '\\varsigma', 'τ': '\\tau', 'υ': '\\upsilon', 'φ': '\\varphi',
  'ϕ': '\\phi', 'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega', 'Γ': '\\Gamma', 'Δ': '\\Delta',
  'Θ': '\\Theta', 'Λ': '\\Lambda', 'Ξ': '\\Xi', 'Π': '\\Pi', 'Σ': '\\Sigma', 'Υ': '\\Upsilon',
  'Φ': '\\Phi', 'Ψ': '\\Psi', 'Ω': '\\Omega', '∞': '\\infty', 'ℝ': '\\mathbb{R}', 'ℤ': '\\mathbb{Z}',
  'ℕ': '\\mathbb{N}', 'ℚ': '\\mathbb{Q}', 'ℂ': '\\mathbb{C}', 'ℙ': '\\mathbb{P}', '𝔼': '\\mathbb{E}',
};
const relations: Record<string, string> = { '=': '=', '<': '<', '>': '>', '≤': '\\leq', '≥': '\\geq',
  '≠': '\\neq', '≈': '\\approx', '≃': '\\simeq', '∝': '\\propto', '∈': '\\in', '∉': '\\notin',
  '⊂': '\\subset', '⊆': '\\subseteq', '→': '\\to', '↦': '\\mapsto' };
const operators: Record<string, string> = { '+': '+', '-': '-', '−': '-', '*': '*', '/': '/', '±': '\\pm',
  '∓': '\\mp', '×': '\\times', '·': '\\cdot', '÷': '\\div', '∪': '\\cup', '∩': '\\cap' };
const prefixes: Record<string, string> = { '∇': '\\nabla', '∂': '\\partial', '∑': '\\sum', '∏': '\\prod', '∫': '\\int' };
const superChars = '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ', subChars = '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ';
const superValues = '0123456789+-=()ni', subValues = '0123456789+-=()aehijklmnoprstuvx';
const accents: Record<string, string> = { '\u0302': 'hat', '\u0303': 'tilde', '\u0304': 'bar', '\u0307': 'dot', '\u0308': 'ddot', '\u20d7': 'vec' };
const greekNames = new Set(Object.values(symbols).filter(x => /^\\[a-zA-Z]+$/.test(x)).map(x => x.slice(1)));
const opCommands = new Map([...Object.values(relations).filter(x => x.startsWith('\\')).map(x => [x.slice(1), 'relation'] as const),
  ...Object.values(operators).filter(x => x.startsWith('\\')).map(x => [x.slice(1), 'op'] as const)]);
type Kind = 'atom' | 'number' | 'label' | 'fn' | 'prefix' | 'open' | 'close' | 'op' | 'relation' | 'script' | 'accent' | 'command' | 'space' | 'stop' | 'error';
interface Token extends TextRange { kind: Kind; raw: string; tex: string; strong?: boolean }

/** Tokenization is linear; words remain words, never products of letters. */
function lex(line: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < line.length;) {
    const start = i, cp = String.fromCodePoint(line.codePointAt(i)!); i += cp.length;
    let kind: Kind = 'stop', tex = cp, strong = false;
    if (/\s/u.test(cp)) { while (/\s/u.test(line[i] ?? '') && i < line.length) i++; kind = 'space'; }
    else if (cp === '\\') {
      const command = /^[A-Za-z]+/.exec(line.slice(i));
      if (!command) {
        if (/[!,; ]/.test(line[i] ?? '\0')) { tex = '\\' + line[i++]; kind = 'space'; }
        else { if (i < line.length) i++; kind = 'error'; }
      } else {
        i += command[0].length; tex = '\\' + command[0]; strong = true;
        if (greekNames.has(command[0])) kind = 'atom';
        else if (opCommands.has(command[0])) kind = opCommands.get(command[0])!;
        else if (['sum', 'prod', 'int', 'nabla', 'partial'].includes(command[0])) kind = 'prefix';
        else if (['frac', 'sqrt', 'hat', 'widehat', 'bar', 'overline', 'tilde', 'vec', 'dot', 'ddot',
          'mathbb', 'mathcal', 'mathbf', 'mathit', 'mathrm', 'operatorname', 'text'].includes(command[0])) kind = 'command';
        else if (functions.has(command[0])) kind = 'fn';
        else kind = 'error';
      }
    } else if (/[A-Za-z]/.test(cp)) {
      while (/[A-Za-z0-9]/.test(line[i] ?? '\0')) i++;
      const word = line.slice(start, i);
      kind = word.length === 1 ? 'atom' : functions.has(word) ? 'fn' : 'label';
      if (kind === 'fn') tex = ['clip', 'KL', 'Pr', 'tr', 'argmin', 'argmax'].includes(word)
        ? `\\operatorname{${word}}` : word === 'sqrt' ? '\\operatorname{sqrt}' : '\\' + word;
      else tex = word;
    } else if (/\d/.test(cp)) {
      const number = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(line.slice(start))![0];
      i = start + number.length; tex = number; kind = 'number';
    } else if (/^[A-Za-z][\u0302\u0303\u0304\u0307\u0308]+$/u.test(cp.normalize('NFD'))) {
      const [base, ...marks] = cp.normalize('NFD');
      kind = 'atom'; tex = marks.reduce((body, mark) => `\\${accents[mark]}{${body}}`, base!); strong = true;
    } else if (symbols[cp]) { kind = 'atom'; tex = symbols[cp]!; strong = true; }
    else if (prefixes[cp]) { kind = 'prefix'; tex = prefixes[cp]!; strong = true; }
    else if (/^[\u{1d400}-\u{1d7ff}]$/u.test(cp)) { kind = 'atom'; strong = true; }
    else if (relations[cp]) { kind = 'relation'; tex = relations[cp]!; strong = cp !== '=' && cp !== '<' && cp !== '>'; }
    else if (operators[cp]) { kind = 'op'; tex = operators[cp]!; }
    else if ('([{'.includes(cp)) kind = 'open';
    else if (')]}'.includes(cp)) kind = 'close';
    else if (cp === '_' || cp === '^') kind = 'script';
    else if (superChars.includes(cp) || subChars.includes(cp)) {
      const superscript = superChars.includes(cp), chars = superscript ? superChars : subChars;
      const values = superscript ? superValues : subValues;
      let body = values[chars.indexOf(cp)]!;
      while (i < line.length && chars.includes(line[i]!)) body += values[chars.indexOf(line[i++]!)]!;
      kind = 'script'; tex = (superscript ? '^' : '_') + '{' + body + '}'; strong = true;
    } else if (accents[cp]) { kind = 'accent'; tex = accents[cp]!; strong = true; }
    out.push({ kind, raw: line.slice(start, i), tex, start, end: i, strong });
  }
  return out;
}

interface Stats { atoms: number; binary: number; relations: number; features: number; scripts: number; structures: number }
class LinearParser {
  index: number;
  depth = 0;
  stats: Stats = { atoms: 0, binary: 0, relations: 0, features: 0, scripts: 0, structures: 0 };
  constructor(readonly tokens: Token[], start: number) { this.index = start; }
  next() { while (this.tokens[this.index]?.kind === 'space') this.index++; return this.tokens[this.index]; }
  group(grouping = false): string {
    if (++this.depth > 16) throw Error('depth');
    const open = this.next(); if (open?.kind !== 'open') throw Error('group'); this.index++;
    const body = this.expression(true), close = this.next();
    if (!body || close?.raw !== ({ '(': ')', '[': ']', '{': '}' } as Record<string, string>)[open.raw]) throw Error('bracket');
    this.index++; this.depth--;
    return open.raw === '{' ? (grouping ? '{' + body + '}' : '\\{' + body + '\\}') : open.raw + body + close!.raw;
  }
  argument(text = false): string {
    const open = this.next(); if (!open) throw Error('argument');
    if (text && open.raw === '{') {
      this.index++; let value = '';
      while (this.tokens[this.index] && this.tokens[this.index]!.raw !== '}') {
        const token = this.tokens[this.index++]!;
        if (/[\\{}$%#&]/.test(token.raw) || value.length + token.raw.length > 96) throw Error('text');
        value += token.raw;
      }
      if (!value.trim() || this.tokens[this.index++]?.raw !== '}') throw Error('text');
      this.stats.atoms++; return '{' + value + '}';
    }
    if (open.kind === 'open' && open.raw === '{') return this.group(true);
    if (open.kind !== 'atom' && open.kind !== 'number') throw Error('argument');
    this.index++; this.stats.atoms++; return '{' + open.tex + '}';
  }
  atom(): { tex: string; pending: boolean } {
    const token = this.next(); if (!token) throw Error('atom');
    let tex = token.tex, pending = token.kind === 'prefix';
    if (token.kind === 'open') tex = this.group();
    else {
      this.index++; this.stats.atoms++; if (token.strong) this.stats.features++;
      if (token.kind === 'command') {
        this.stats.structures++;
        const text = ['\\mathrm', '\\operatorname', '\\text'].includes(token.tex);
        tex += this.argument(text);
        if (token.tex === '\\frac') tex += this.argument();
      } else if (!['atom', 'number', 'fn', 'prefix'].includes(token.kind)) throw Error('atom');
    }
    const seen = new Set<string>();
    for (;;) {
      const after = this.next(); if (!after) break;
      if (after.kind === 'accent') { tex = `\\${after.tex}{${tex}}`; this.stats.features++; this.index++; continue; }
      if (after.kind !== 'script') break;
      this.index++;
      const operator = after.tex[0]!;
      if (seen.has(operator)) throw Error('duplicate-script'); seen.add(operator);
      this.stats.features++; this.stats.scripts++;
      if (after.strong) { tex += after.tex; continue; }
      const arg = this.next(); if (!arg) throw Error('script');
      if (arg.kind === 'label') {
        if (!labels.has(arg.raw)) throw Error('ambiguous-label');
        this.index++; tex += operator + '{\\mathrm{' + arg.raw + '}}';
      } else if (arg.kind === 'open' && arg.raw === '{') {
        // Braced labels explicitly specify their boundaries.
        const saved = this.index; this.index++;
        const label = this.next();
        if (label?.kind === 'label') {
          this.index++; const end = this.next(); if (end?.raw !== '}') throw Error('label');
          this.index++; tex += operator + '{' + label.raw + '}';
        } else { this.index = saved; tex += operator + this.group(true); }
      } else {
        if (arg.kind === 'number' && arg.raw.length !== 1) throw Error('ambiguous-script');
        tex += operator + this.argument();
      }
    }
    return { tex, pending };
  }
  expression(group = false): string {
    const output: string[] = []; let expecting = true, any = false;
    for (let count = 0; count < 256; count++) {
      const token = this.next(); if (!token) break;
      if (token.kind === 'close') { if (!group) throw Error('extra-close'); break; }
      if (group && token.raw === ',') {
        if (expecting) throw Error('comma'); output.push(','); this.index++; expecting = true; continue;
      }
      if (token.kind === 'error' || token.kind === 'script' || token.kind === 'accent') throw Error('unsupported');
      if (token.kind === 'op' || token.kind === 'relation') {
        if (expecting && !['+', '-', '−'].includes(token.raw)) throw Error('operand');
        if (!expecting) {
          if (token.kind === 'relation') this.stats.relations++; else this.stats.binary++;
        }
        output.push(token.tex); this.index++; expecting = true; continue;
      }
      if (!['atom', 'number', 'fn', 'prefix', 'open', 'command'].includes(token.kind)) break;
      const atom = this.atom(); output.push(atom.tex); expecting = atom.pending; any = true;
      if (count === 255) throw Error('tokens');
    }
    if (!any || expecting) throw Error('incomplete');
    return output.join(' ');
  }
}

function protectedRanges(text: string): TextRange[] {
  const ranges = [...findCodeRanges(text), ...findDisplayMath(text)];
  // Match unmistakable non-math contexts, not all slash-separated operands.
  const patterns = [/(?:https?:\/\/|www\.)[^\s<>]+/giu, /\b[A-Za-z]:[\\/][^\s]+/gu,
    /(?:^|\s)(?:\.{1,2}[/\\]|\/[A-Za-z][\w.-]*\/)[^\s]+/gmu,
    /\b[A-Za-z][A-Za-z0-9.-]+[/\\][\w./\\-]+/gu, /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gu,
    /<\/?[A-Za-z][^<>\r\n]*>/gu];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) ranges.push({ start: match.index!, end: match.index! + match[0].length });
  return ranges.sort((a, b) => a.start - b.start);
}
function mergeRanges(ranges: TextRange[]) {
  const merged: TextRange[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

/** High-precision, presentation-only grammar. No evaluation or inferred algebra.
 * Offsets always refer to the original UTF-16 text, never normalized text. */
export function findInlineMath(text: string): InlineMath[] {
  const cached = cache.get(text); if (cached) return cached;
  if (text.length > 1024 * 1024 || !/[=$\\_^\u0302\u0303\u0304\u0307\u0308\u20d7\u0370-\u03ff\u2070-\u22ff\u{1d400}-\u{1d7ff}]/u.test(text)) return [];
  let protected_ = mergeRanges(protectedRanges(text));
  const result: InlineMath[] = [];
  const overlaps = (start: number, end: number) => {
    let left = 0, right = protected_.length;
    while (left < right) { const middle = (left + right) >>> 1; if (protected_[middle]!.end <= start) left = middle + 1; else right = middle; }
    return !!protected_[left] && protected_[left]!.start < end;
  };
  // Explicit inline boundaries take precedence; dollars use non-space and
  // non-digit closing constraints to avoid common currency prose.
  const marked = /\\\([^\r\n]{0,1020}?\\\)|(?<![\\$])\$(?![\s$])[^$\r\n]{1,1022}?(?<!\s)\$(?![\d$])/gu;
  for (const match of text.matchAll(marked)) {
    const raw = match[0], start = match.index!, end = start + raw.length;
    if (overlaps(start, end) || raw.length > 1024) continue;
    const tex = raw.startsWith('\\(') ? raw.slice(2, -2) : raw.slice(1, -1);
    if (!tex.trim() || /^\d[\d., ]*$/.test(tex) || raw[0] === '$' && /\b(?:USD|dollars?|cost|price|for|each)\b/i.test(tex)) continue;
    result.push({ start, end, raw, tex: tex.trim(), marked: true, reason: 'delimited' });
  }
  protected_ = mergeRanges([...protected_, ...result]);
  let offset = 0;
  for (const line of text.split('\n')) {
    if (line.length > 4096 || /^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)?(?:(?:PS\s+\S+>|[>$])\s|(?:const|let|var|return|import|export|def|class|function|SELECT|INSERT|UPDATE)\b|(?:if|for|while|switch)\s*\(|(?:console\.\w+|print|printf|echo)\s*[( ]|(?:python3?|node|npm|pnpm|pip3?|git|curl|powershell|pwsh|cmd)\s+(?:-|[a-z]))/i.test(line) ||
        /^\s*(?:[\[{]\s*["']|["'][\w-]+["']\s*:|at\s+[\w.$]+\(|Traceback\b|File\s+["'])/.test(line) ||
        /^\s*(?:\[\d{4}-\d{2}-\d{2}|(?:INFO|DEBUG|WARN|WARNING|ERROR|TRACE)(?:\s|:|\]))/.test(line) ||
        /(?:^|[\s,{])(?:[A-Za-z][\w-]{2,})\s*(?:=|:)\s*(?:["']|\d|true\b|false\b|null\b)/.test(line) ||
        /==|!=|:=|=>|\+=|-=|&&|\|\||(?:^|\s)--[a-z]/.test(line)) { offset += line.length + 1; continue; }
    const tokens = lex(line);
    for (let i = 0; i < tokens.length;) {
      const token = tokens[i]!;
      if (!['atom', 'number', 'fn', 'prefix', 'open', 'command', 'error'].includes(token.kind) || overlaps(offset + token.start, offset + token.end)) { i++; continue; }
      const parser = new LinearParser(tokens, i);
      try {
        const tex = parser.expression(), endIndex = parser.index;
        let last = endIndex - 1; while (tokens[last]?.kind === 'space') last--;
        const start = offset + token.start, end = offset + tokens[last]!.end, raw = text.slice(start, end), s = parser.stats;
        i = Math.max(i + 1, endIndex);
        if (raw.length > 1024 || overlaps(start, end)) continue;
        // ASCII punctuation next to a word can be a path, version or sentence.
        if (/[\w.@\\]/u.test(line[token.start - 1] ?? '') || /[\w@\\]/u.test(line[tokens[last]!.end] ?? '')) continue;
        const context = hint.test(line.slice(Math.max(0, token.start - 64), Math.min(line.length, tokens[last]!.end + 32)));
        const reason = s.structures > 0 && s.atoms >= 2 ? 'structure' :
          s.relations > 0 && s.atoms >= 3 && (s.binary > 0 || s.features > 0) ? 'equation' :
          s.relations > 0 && s.features >= 2 && s.atoms >= 2 ? 'equation' :
          context && s.features > 0 && s.atoms >= 2 && (s.relations > 0 || s.binary > 0) ? 'context' : undefined;
        if (reason) result.push({ start, end, raw, tex, marked: false, reason });
      } catch {
        // Do not rescue a smaller, apparently valid tail of malformed math.
        i = Math.max(i + 1, parser.index);
        while (tokens[i] && !['stop', 'label'].includes(tokens[i]!.kind)) i++;
        if (tokens[i]?.kind === 'label') {
          i++; while (tokens[i] && !['stop', 'label'].includes(tokens[i]!.kind)) i++;
        }
      }
    }
    offset += line.length + 1;
  }
  result.sort((a, b) => a.start - b.start || b.end - a.end);
  cache.set(text, result, text.length * 2 + result.reduce((n, span) => n + (span.raw.length + span.tex.length) * 2 + 64, 0));
  return result;
}
