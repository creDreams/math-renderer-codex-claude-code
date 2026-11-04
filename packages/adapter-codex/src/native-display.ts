// Bounded layout verification adapted from OpenAI Codex (Apache-2.0),
// codex-rs/tui/src/markdown_render/math/render{,/structured}.rs.
// Unknown syntax fails closed; no character region becomes a wildcard.
import { symbols, delimiters } from './native-symbols.js';
import { eastAsianWidth } from 'get-east-asian-width';

interface Layout { rows: string[]; baseline: number }
type Mode = 'inline' | 'display';
// Layout padding and bars use terminal columns, not character counts. NFC
// keeps Hangul syllables together; accents occupy no additional column.
const width = (text: string) => [...text.normalize('NFC')].reduce((size, char) =>
  size + (/\p{M}/u.test(char) ? 0 : eastAsianWidth(char.codePointAt(0)!)), 0);
const extent = (layout: Layout) => Math.max(0, ...layout.rows.map(width));
const plain = (text: string): Layout => ({ rows: [text], baseline: 0 });
const fail = (): never => { throw new Error('Unsupported native math'); };
const bounded = (layout: Layout): Layout => {
  if (layout.rows.length > 16 || extent(layout) > 256) fail();
  return layout;
};
const single = (layout: Layout): string => layout.rows.length === 1 ? layout.rows[0]! : fail();
const grapheme = (text: string) => /^\P{M}\p{M}*$/u.test(text.normalize('NFD'));

function join(left: Layout, right: Layout): Layout {
  const baseline = Math.max(left.baseline, right.baseline);
  const height = baseline + Math.max(left.rows.length - left.baseline, right.rows.length - right.baseline);
  const size = extent(left) + Number(left.rows.length > 1 && right.rows.length > 1);
  if (height > 16 || size + extent(right) > 256) fail();
  return { baseline, rows: Array.from({ length: height }, (_, row) => {
    const text = left.rows[row - baseline + left.baseline] ?? '';
    return text + ' '.repeat(size - width(text)) + (right.rows[row - baseline + right.baseline] ?? '');
  }) };
}

function annotated(base: Layout, note: Layout, above: boolean): Layout {
  const size = Math.max(extent(base), extent(note));
  const rows = (above ? [note, base] : [base, note]).flatMap(part =>
    part.rows.map(row => ' '.repeat(Math.floor((size - extent(part)) / 2)) + row));
  return bounded({ rows, baseline: base.baseline + (above ? note.rows.length : 0) });
}

class Parser {
  private index = 0;
  private depth = 0;
  private stack: boolean;
  constructor(private text: string, private mode: Mode) { this.stack = mode === 'display'; }
  private skip() { while (/\s/u.test(this.text[this.index] ?? '') && this.index < this.text.length) this.index++; }
  private take() { const char = [...this.text.slice(this.index)][0] ?? fail(); this.index += char.length; return char; }
  private consume(value: string) {
    if (!this.text.startsWith(value, this.index)) return false;
    this.index += value.length; return true;
  }
  sequence(end: 'input' | 'group' | 'cell'): Layout {
    if (++this.depth >= 32) fail();
    let result = plain(''), scripts = '', hasBase = false;
    while (this.index < this.text.length) {
      const remaining = this.text.slice(this.index).trimStart(), char = this.text[this.index]!;
      if (end === 'cell' && /^(?:[&}]|\\\\|\\end\{)/.test(remaining)) {
        this.skip(); this.depth--; return result;
      }
      if (char === '}') {
        if (end !== 'group') fail();
        this.index++; this.depth--; return result;
      }
      if (char === '^' || char === '_') {
        if (!hasBase || scripts.includes(char)) fail();
        scripts += char;
      } else if (!/\s/u.test(char)) scripts = '';
      const atom = this.atom();
      if (!/[\s^_]/u.test(char)) hasBase = atom.rows.length === 1 && grapheme(atom.rows[0]!);
      result = join(result, atom);
    }
    this.depth--;
    return end === 'input' ? result : fail();
  }
  private argument(): Layout {
    this.skip();
    if (/^[\^_]/.test(this.text.slice(this.index))) fail();
    return this.atom();
  }
  private compactArgument(): Layout {
    const stack = this.stack; this.stack = false;
    try { return this.argument(); } finally { this.stack = stack; }
  }
  private atom(): Layout {
    if (++this.depth >= 32) fail();
    try {
      const char = this.take();
      if (char === '{') return this.sequence('group');
      if (char === '\\') return this.command();
      if (char === '^' || char === '_') {
        const text = single(this.compactArgument());
        const basic = char === '^' ? '0123456789+-=()abcdefghijklmnoprstuvwxyz' : '0123456789+-=()aehijklmnoprstuvx';
        const alphabet = [...(char === '^' ? '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ' : '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ')];
        return plain([...text].every(value => basic.includes(value))
          ? [...text].map(value => alphabet[basic.indexOf(value)]).join('') : `${char}{${text}}`);
      }
      if (/[}$%#&`]/u.test(char)) fail();
      if (/\s/u.test(char)) { this.skip(); return plain(' '); }
      if (/\p{Cc}/u.test(char)) fail();
      return plain(char);
    } finally { this.depth--; }
  }
  private command(): Layout {
    const name = /^[A-Za-z]+/.exec(this.text.slice(this.index))?.[0];
    if (!name) {
      const char = this.take();
      if (',;: '.includes(char)) return plain(' ');
      if (char === '!') return plain('');
      if ('%{}'.includes(char)) return plain(char);
      if (char === '|') return plain('‖');
      return fail();
    }
    this.index += name.length;
    if (['sum', 'bigwedge', 'int'].includes(name) && this.stack) return this.operator(symbols[name]!);
    if (name === 'begin') return this.grid();
    if (name === 'boxed') {
      if (this.mode === 'inline') fail();
      const inner = this.argument(), size = extent(inner), border = '─'.repeat(size + 2);
      return bounded({ baseline: inner.baseline + 1, rows: ['┌' + border + '┐',
        ...inner.rows.map(row => '│ ' + row + ' '.repeat(size - width(row)) + ' │'), '└' + border + '┘'] });
    }
    if (name === 'underset' || name === 'overset') {
      const note = this.compactArgument(), base = this.argument();
      return this.stack ? annotated(base, note, name === 'overset')
        : plain(`(${single(base)})${name === 'overset' ? '^' : '_'}{${single(note)}}`);
    }
    if (name === 'substack') {
      this.skip(); if (!this.consume('{')) fail();
      const rows: string[] = [];
      for (;;) {
        if (rows.length >= 16) fail();
        this.skip(); rows.push(single(this.sequence('cell')).trim());
        if (this.consume('}')) break;
        if (!this.consume('\\\\')) fail();
      }
      return plain('(' + rows.join('; ') + ')');
    }
    if (name === 'mathcal') {
      const text = single(this.argument()), alphabet = [...'𝒜ℬ𝒞𝒟ℰℱ𝒢ℋℐ𝒥𝒦ℒℳ𝒩𝒪𝒫𝒬ℛ𝒮𝒯𝒰𝒱𝒲𝒳𝒴𝒵'];
      if (!/^[A-Z]*$/.test(text)) fail();
      return plain([...text].map(char => alphabet[char.charCodeAt(0) - 65]).join(''));
    }
    if (['frac', 'dfrac', 'tfrac'].includes(name)) {
      const numerator = single(this.compactArgument()), denominator = single(this.compactArgument());
      if (this.mode === 'inline') return plain(`((${numerator})/(${denominator}))`);
      const size = Math.max(1, width(numerator), width(denominator));
      return bounded({ baseline: 1, rows: [' '.repeat(Math.floor((size - width(numerator)) / 2)) + numerator,
        '─'.repeat(size), ' '.repeat(Math.floor((size - width(denominator)) / 2)) + denominator] });
    }
    if (name === 'sqrt') {
      if (this.text.slice(this.index).trimStart().startsWith('[')) fail();
      return plain(`√(${single(this.compactArgument())})`);
    }
    if (name === 'mathbb') {
      const text = single(this.argument()), alphabet: Record<string, string> = { R: 'ℝ', C: 'ℂ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', P: 'ℙ' };
      return plain(Object.hasOwn(alphabet, text) ? alphabet[text]! : fail());
    }
    const accents: Record<string, string> = { hat: '\u0302', widehat: '\u0302', bar: '\u0304', tilde: '\u0303', vec: '\u20d7', dot: '\u0307', ddot: '\u0308' };
    if (Object.hasOwn(accents, name)) {
      const text = single(this.argument());
      if (!grapheme(text) || !text.trim() || !width(text)) fail();
      return plain(text + accents[name]);
    }
    if (['mathrm', 'mathbf', 'mathit'].includes(name)) return this.argument();
    if (name === 'text' || name === 'operatorname') {
      this.skip(); if (!this.consume('{')) fail();
      const end = this.text.indexOf('}', this.index); if (end < 0) fail();
      const text = this.text.slice(this.index, end); if (/[{\\$%#&\p{Cc}]/u.test(text)) fail();
      this.index = end + 1; return plain(text);
    }
    if (['left', 'right', 'bigl', 'bigr'].includes(name)) {
      this.skip(); const char = this.take();
      if (char === '.') return plain('');
      if ('()[]|'.includes(char)) return plain(char);
      if (char === '<' || char === '>') return plain(char === '<' ? '⟨' : '⟩');
      if (char !== '\\') fail();
      const delimiter = /^[A-Za-z]+|^./u.exec(this.text.slice(this.index))?.[0] ?? fail();
      this.index += delimiter.length; return plain(delimiters[delimiter] ?? fail());
    }
    if (name === 'quad' || name === 'qquad') return plain(' ');
    if (['sin', 'cos', 'tan', 'log', 'ln', 'exp', 'lim', 'max', 'min'].includes(name)) return plain(name);
    return plain(symbols[name] ?? fail());
  }
  private operator(symbol: string): Layout {
    const limits: { lower?: Layout; upper?: Layout } = {};
    for (;;) {
      const saved = this.index; this.skip();
      const char = this.text[this.index];
      if (char !== '_' && char !== '^') { this.index = saved; break; }
      this.index++; const key = char === '_' ? 'lower' : 'upper';
      if (limits[key]) fail();
      limits[key] = this.compactArgument();
    }
    const size = Math.max(1, ...Object.values(limits).map(extent));
    let base = plain(' '.repeat(Math.floor((size - 1) / 2)) + symbol + ' '.repeat(Math.ceil((size - 1) / 2)));
    if (limits.lower) base = annotated(base, limits.lower, false);
    if (limits.upper) base = annotated(base, limits.upper, true);
    return base;
  }
  private grid(): Layout {
    if (this.mode === 'inline') fail();
    this.skip(); if (!this.consume('{')) fail();
    const close = this.text.indexOf('}', this.index); if (close < 0) fail();
    const name = this.text.slice(this.index, close), matrix = name === 'pmatrix';
    if (!matrix && name !== 'aligned') fail();
    this.index = close + 1;
    if (!matrix && this.text.slice(this.index).trimStart().startsWith('[')) fail();
    const end = `\\end{${name}}`, rows: Layout[][] = [], widths: number[] = [];
    let cells: Layout[] = [];
    for (;;) {
      this.skip();
      if (!cells.length && this.consume(end)) break;
      if (rows.length >= 16 || cells.length >= 16) fail();
      const cell = this.sequence('cell');
      if (cell.rows.length === 1) cell.rows[0] = cell.rows[0]!.trim();
      if (matrix && !extent(cell)) fail();
      widths[cells.length] = Math.max(widths[cells.length] ?? 0, extent(cell)); cells.push(cell);
      if (this.consume('&')) continue;
      if (this.consume(end)) { rows.push(cells); break; }
      if (!this.consume('\\\\')) fail();
      if (matrix) this.consume('*'); else this.skip();
      if (this.consume('[')) {
        const spacing = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|pc|in|bp|cm|mm|dd|cc|sp|em|ex)\s*\]/.exec(this.text.slice(this.index));
        this.index += (spacing ?? fail())[0].length;
      }
      rows.push(cells); cells = [];
    }
    const output: string[] = []; let baseline = 0;
    for (const row of rows) {
      if (matrix && row.length !== widths.length) fail();
      const base = Math.max(...row.map(cell => cell.baseline));
      if (!output.length) baseline = base;
      const height = Math.max(...row.map(cell => base + cell.rows.length - cell.baseline));
      if (height + output.length > 16) fail();
      for (let line = 0; line < height; line++) {
        let text = '';
        row.forEach((cell, index) => {
          const value = cell.rows[line - base + cell.baseline] ?? '', size = widths[index]!;
          const leading = matrix ? Math.floor((size - extent(cell)) / 2) : index % 2 === 0 ? size - extent(cell) : 0;
          text += ' '.repeat(leading) + value + ' '.repeat(size - leading - width(value));
          if (index + 1 < row.length) text += !matrix && index % 2 === 0 ? ' ' : '  ';
        });
        if (width(text) > (matrix ? 252 : 256)) fail();
        output.push(matrix ? text : text.trimEnd());
      }
    }
    if (!output.length) fail();
    if (matrix) {
      const last = output.length - 1; baseline = Math.floor(last / 2);
      output.forEach((text, index) => { output[index] = last === 0 ? `( ${text} )` : index === 0 ? `⎛ ${text} ⎞`
        : index === last ? `⎝ ${text} ⎠` : `⎜ ${text} ⎟`; });
    }
    return bounded({ rows: output, baseline });
  }
}

export function renderCodexMath(tex: string, mode: Mode): string | undefined {
  if (!tex.trim() || tex.length > (mode === 'inline' ? 1024 : 4096)) return;
  // Emoji sequences still require grapheme-aware terminal width prediction.
  if (/\p{Extended_Pictographic}/u.test(tex)) return;
  try {
    const result = new Parser(tex.trim(), mode).sequence('input');
    return result.rows.some(row => row.trim()) ? result.rows.join('\n') : undefined;
  } catch { return; }
}

export function renderCodexSpatialDisplay(tex: string, _inline?: (tex: string) => string | undefined): string | undefined {
  return renderCodexMath(tex, 'display');
}

/** A complete predicted character formula, never a shared subscript fragment.
 * Whitespace-free keys survive physical wrapping. Source proof still decides
 * whether this presentation is a complete display block outside code. */
export function nativeDisplayKey(text: string): { key: string; length: number } | undefined {
  const normalized = text.normalize('NFC').replace(/\s+/gu, '');
  return /[_^]/u.test(normalized) ? { key: 'native-display:' + normalized, length: normalized.length } : undefined;
}
