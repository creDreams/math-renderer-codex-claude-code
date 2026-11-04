import { findDisplayMath } from '../../core/src/display-math.js';
import { findCodeRanges, type TextRange } from '../../core/src/markdown-code.js';
import { renderCodexMath, renderCodexSpatialDisplay } from './native-display.js';
import { displayPresentations } from './display-presentation.js';
import type { InlineMath } from '../../core/src/implicit-math.js';

const compact = (text: string) => text.normalize('NFC').replace(/\s+/gu, '');
export const renderCodexInline = (tex: string) => renderCodexMath(tex, 'inline');
/** Lookup keys are hints only; every hit still needs the complete source proof. */
export function inlinePresentationKeys(span: InlineMath): string[] {
  return [...new Set([span.raw, ...(span.marked ? [span.tex, renderCodexInline(span.tex)] : [])]
    .filter((value): value is string => value !== undefined).map(value => 'inline:' + compact(value)))];
}

/** A marked source atom may lose its delimiters in Codex's character output.
 * These exact atom hints are retrieval only: an unmarked lone identifier is
 * still not a recognized formula. Never extract hints from display source. */
export function inlineScriptPresentationKeys(text: string, excluded: TextRange[]): string[] {
  return [...text.matchAll(/[A-Za-z\p{Script=Greek}\p{So}][A-Za-z\p{Script=Greek}\p{M}\p{N}]{0,63}(?:[_^](?:\{[^{}\r\n]{1,64}\}|[A-Za-z\p{Script=Greek}\p{N}]{1,64}))+/gu)]
    .filter(match => !excluded.some(range => match.index < range.end && match.index + match[0].length > range.start))
    .map(match => 'inline:' + compact(match[0]));
}

interface Piece { alternatives: string[]; code?: boolean; start: number; end: number; literal?: boolean }
export interface TrackedRange extends TextRange { index: number }
interface ProofState { code: TextRange[]; tracked: TrackedRange[] }
function compactOffsets(source: string, positions: number[]) {
  const offsets = new Map<number, number>(); let previous = 0, length = 0;
  for (const position of [...new Set([0, ...positions])].sort((a, b) => a - b)) {
    length += compact(source.slice(previous, position)).length; offsets.set(position, length); previous = position;
  }
  return offsets;
}

/** Map normalized proof offsets back to original UIA UTF-16 positions. */
export function expandCompactRanges(text: string, ranges: TrackedRange[]): TrackedRange[] {
  if (!ranges.length) return [];
  const length = compact(text).length, starts = new Uint32Array(length), ends = new Uint32Array(length);
  let cursor = 0;
  const append = (raw: string, start: number) => {
    const normalized = compact(raw);
    for (let i = 0; i < normalized.length; i++, cursor++) { starts[cursor] = start; ends[cursor] = start + raw.length; }
  };
  if (text === text.normalize('NFC')) {
    let index = 0;
    for (const char of text) { append(char, index); index += char.length; }
  } else {
    for (const segment of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) append(segment.segment, segment.index);
  }
  return ranges.flatMap(range => range.end > range.start && range.start >= 0 && range.end <= cursor
    ? [{ index: range.index, start: starts[range.start]!, end: ends[range.end - 1]! }] : []);
}
/** Code content remains literal even when Codex hides Markdown delimiters. */
function codePresentation(text: string): string | undefined {
  const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(text);
  if (fence) {
    const lines = text.slice(fence[0].length).split('\n');
    const last = lines.at(-1) === '' ? lines.length - 2 : lines.length - 1;
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[last] ?? '');
    if (close && close[1]![0] === fence[1]![0] && close[1]!.length >= fence[1]!.length) lines.splice(last);
    return lines.join('\n');
  }
  const ticks = /^`+/.exec(text)?.[0];
  return ticks && text.endsWith(ticks) ? text.slice(ticks.length, -ticks.length) : undefined;
}

/** The returned ranges use NFC, whitespace-free visible offsets. They carry
 * protected code through the same exact proof that identifies the answer. */
export function assistantTextProof(source: string, visible: string, mode: 'exact' | 'prefix' | 'suffix' = 'exact', tracked: TextRange[] = []):
  { codeRanges: TextRange[]; trackedRanges?: TrackedRange[] } | undefined {
  const target = compact(visible), displays = findDisplayMath(source);
  const code = findCodeRanges(source).filter(range => !displays.some(block => range.start >= block.start && range.start < block.end));
  const literal = compact(source);
  if (mode === 'exact' ? literal === target : mode === 'prefix' ? literal.startsWith(target) : literal.endsWith(target)) {
    const offset = mode === 'suffix' ? literal.length - target.length : 0;
    const offsets = compactOffsets(source, [...code, ...tracked].flatMap(range => [range.start, range.end]));
    return { codeRanges: code.map(range => ({ start: Math.max(0, offsets.get(range.start)! - offset),
      end: Math.min(target.length, offsets.get(range.end)! - offset) })).filter(range => range.start < range.end),
      ...(tracked.length ? { trackedRanges: tracked.map((range, index) => ({ index, start: offsets.get(range.start)! - offset,
        end: offsets.get(range.end)! - offset })).filter(range => range.start >= 0 && range.end <= target.length) } : {}) };
  }
  if (mode !== 'suffix') {
    // Before the first possible presentation conversion, every character is
    // literal. Reject a different heading before predicting all its equations.
    // This matters when many old answers share the same native script hint.
    const inline = /\\\(|(?<![\\$])\$(?!\$)/.exec(source)?.index ?? source.length;
    const end = Math.min(code[0]?.start ?? source.length, displays[0]?.start ?? source.length, inline);
    const initial = compact(source.slice(0, end));
    if (!target.startsWith(initial) && !(mode === 'prefix' && initial.startsWith(target))) return;
  }
  const pieces: Piece[] = [];
  let literalStart = 0, index = 0, codeIndex = 0;
  const piece = (start: number, end: number, alternatives: string[], protectedCode = false) => {
    pieces.push({ alternatives: [compact(source.slice(literalStart, start))], start: literalStart, end: start, literal: true });
    pieces.push({ alternatives: [...new Set(alternatives.map(compact))], code: protectedCode, start, end });
    literalStart = end;
  };
  while (index < source.length) {
    while (code[codeIndex] && code[codeIndex]!.end <= index) codeIndex++;
    const protectedCode = code[codeIndex];
    if (protectedCode && index >= protectedCode.start) {
      const raw = source.slice(protectedCode.start, protectedCode.end), shown = codePresentation(raw);
      piece(protectedCode.start, protectedCode.end, shown === undefined ? [raw] : [raw, shown], true);
      index = protectedCode.end; continue;
    }
    const display = displays.find(x => index >= x.start && index < x.end);
    if (display) {
      const flat = renderCodexInline(display.tex.replace(/[\r\n]+/g, ' '));
      const spatial = renderCodexSpatialDisplay(display.tex);
      piece(display.start, display.end, [source.slice(display.start, display.end),
        ...displayPresentations(source.slice(display.start, display.end), display.tex).slice(1),
        ...[flat, spatial].filter((value): value is string => value !== undefined)]);
      index = display.end; continue;
    }
    const open = source.startsWith('\\(', index) ? '\\(' : source[index] === '$' && source[index + 1] !== '$' ? '$' : undefined;
    if (!open || source[index - 1] === '\\' || source[index - 1] === '$') { index++; continue; }
    const close = open === '$' ? '$' : '\\)';
    const end = source.indexOf(close, index + open.length);
    if (end < 0) { index += open.length; continue; }
    const body = source.slice(index + open.length, end);
    const rendered = !/[\r\n]/.test(body) ? renderCodexInline(body) : undefined;
    if (rendered !== undefined) piece(index, end + close.length, [source.slice(index, end + close.length), rendered]);
    index = end + close.length;
  }
  pieces.push({ alternatives: [compact(source.slice(literalStart))], start: literalStart, end: source.length, literal: true });
  const offsets = tracked.length ? compactOffsets(source, [...tracked, ...pieces].flatMap(range => [range.start, range.end])) : new Map<number, number>();
  // Reversing both sides turns suffix verification into the same bounded walk.
  const reverse = (text: string) => text.split('').reverse().join('');
  const expected = mode === 'suffix' ? reverse(target) : target;
  const sequence = mode === 'suffix' ? pieces.reverse().map(piece => ({ ...piece, alternatives: piece.alternatives.map(reverse) })) : pieces;
  const proof = (state: ProofState) => ({ codeRanges: mode === 'suffix'
    ? state.code.map(range => ({ start: target.length - range.end, end: target.length - range.start })) : state.code,
    ...(tracked.length ? { trackedRanges: mode === 'suffix'
      ? state.tracked.map(range => ({ ...range, start: target.length - range.end, end: target.length - range.start })) : state.tracked } : {}) });
  let positions = new Map<number, ProofState>([[0, { code: [], tracked: [] }]]);
  for (const piece of sequence) {
    const { alternatives, code: protectedCode } = piece;
    const next = new Map<number, ProofState>();
    for (const [position, state] of positions) for (const text of alternatives) {
      const end = Math.min(expected.length, position + text.length);
      const mapped = tracked.flatMap((span, index) => {
        if (protectedCode || span.start < piece.start || span.end > piece.end ||
            !piece.literal && (span.start !== piece.start || span.end !== piece.end)) return [];
        const left = piece.literal ? offsets.get(span.start)! - offsets.get(piece.start)! : 0;
        const right = piece.literal ? offsets.get(span.end)! - offsets.get(piece.start)! : text.length;
        const start = position + (mode === 'suffix' ? text.length - right : left);
        const finish = position + (mode === 'suffix' ? text.length - left : right);
        return finish <= expected.length ? [{ index, start, end: finish }] : [];
      });
      const combined: ProofState = { code: protectedCode ? [...state.code, { start: position, end }] : state.code,
        tracked: [...state.tracked, ...mapped] };
      if (mode !== 'exact' && text.startsWith(expected.slice(position))) return proof(combined);
      if (expected.startsWith(text, position)) {
        // Union code protection for convergent representations, never discard it.
        const previous = next.get(end);
        const merged = new Map([...(previous?.code ?? []), ...combined.code].map(range => [range.start + ':' + range.end, range]));
        // A tracked formula must have identical boundaries on every converging
        // path; ambiguity can only reduce automatic coverage.
        const common = previous ? combined.tracked.filter(range => previous.tracked.some(other =>
          range.index === other.index && range.start === other.start && range.end === other.end)) : combined.tracked;
        next.set(end, { code: [...merged.values()], tracked: common });
      }
    }
    if (!next.size || next.size > 64) return;
    positions = next;
  }
  const ranges = positions.get(expected.length);
  return ranges ? proof(ranges) : undefined;
}

export function assistantTextMatches(source: string, visible: string, mode: 'exact' | 'prefix' | 'suffix' = 'exact'): boolean {
  return assistantTextProof(source, visible, mode) !== undefined;
}
