import { findDisplayMath } from '../../core/src/display-math.js';
import type { ScreenSnapshot, CellLocation } from '../../xterm-addon/src/snapshot.js';
import type { FormulaRegion } from '../../xterm-addon/src/overlay.js';
import { assistantTextMatches, assistantTextProof, expandCompactRanges, inlineScriptPresentationKeys } from './inline-math.js';
import { findInlineMath } from '../../core/src/implicit-math.js';
import { plainMarkdown } from './markdown-presentation.js';
import { findCodeRanges } from '../../core/src/markdown-code.js';
import { displayMatches } from './display-presentation.js';
import { nativeDisplayKey } from './native-display.js';

export interface CodexSession {
  id: string;
  cwd: string;
  file: string;
  assistant: string[];
}
export interface MatchResult {
  regions: FormulaRegion[];
  sourceRanges: { startRow: number; endRow: number }[];
  /** Candidates actually checked against the unique source session. */
  verifiedRanges?: { startRow: number; endRow: number }[];
  state: 'waiting' | 'matched' | 'ambiguous';
  sessionId?: string;
}

/** Physical rows supplied by native UIA; no pixel geometry is inferred here. */
function textSnapshot(text: string): ScreenSnapshot {
  const lines = text.split(/\r?\n/).map(x => x.trimEnd());
  return {
    buffer: 'normal', cols: Math.max(1, ...lines.map(x => x.length)),
    lines: lines.map((line, row) => ({ text: line, startRow: row, endRow: row,
      locations: Array.from({ length: line.length }, (_, column) => ({ row, column })) })),
  };
}

export function matchCodexText(text: string, sessions: CodexSession[], leadingContext = '', inlineMath = false) {
  return matchCodex(textSnapshot(text), sessions, { leadingContext, allowClipped: true, inlineMath });
}

/** Candidate hashes must use the same role and delimiter state as the matcher. */
export function findCodexVisibleMath(text: string, leadingContext = '') {
  const continuation = continuationSource(leadingContext);
  return assistantRegions(textSnapshot(text), continuation?.heading)
    .flatMap(screen => findDisplayMath(screen.text, screen.clippedStart ? continuation?.prefix : ''));
}
export function findCodexVisibleInlineMath(text: string, leadingContext = '') {
  const continuation = continuationSource(leadingContext);
  return assistantRegions(textSnapshot(text), continuation?.heading).flatMap(screen => {
    const prefix = screen.clippedStart ? continuation?.prefix ?? '' : '';
    return findInlineMath(prefix + screen.text).filter(span => span.start >= prefix.length);
  });
}
export function findCodexVisibleInlineScriptKeys(text: string, leadingContext = '') {
  const continuation = continuationSource(leadingContext);
  return assistantRegions(textSnapshot(text), continuation?.heading).flatMap(screen => {
    const prefix = screen.clippedStart ? continuation?.prefix ?? '' : '';
    const full = prefix + screen.text;
    return inlineScriptPresentationKeys(full, [...findDisplayMath(full), { start: 0, end: prefix.length }]);
  });
}
export function findCodexVisibleNativeKeys(text: string, leadingContext = '', lengths?: ReadonlySet<number>) {
  const continuation = continuationSource(leadingContext);
  const keys = new Set<string>(), sizes = lengths ? [...lengths].sort((a, b) => a - b) : undefined;
  if (sizes && !sizes.length) return [];
  for (const screen of assistantRegions(textSnapshot(text), continuation?.heading)) {
    if (!/[_^]/u.test(screen.text)) continue;
    // Native display overlays own complete physical rows. Enumerate only
    // whole-row spans with an indexed length, so wrapping and blank rows do
    // not require guesses about formula boundaries or broad script searches.
    const rows = screen.text.split('\n').map(compact);
    const full = rows.join(''), boundaries = new Set<number>([0]);
    let offset = 0;
    for (const row of rows) { offset += row.length; boundaries.add(offset); }
    const positions = [...boundaries];
    const add = (start: number, end: number) => {
      const key = nativeDisplayKey(full.slice(start, end));
      if (key) keys.add(key.key);
    };
    for (const [index, start] of positions.entries()) {
      if (sizes && sizes.length < positions.length - index) {
        for (const size of sizes) {
          const end = start + size;
          if (end > full.length) break;
          if (boundaries.has(end)) add(start, end);
        }
      } else for (let next = index + 1; next < positions.length; next++) {
        const end = positions[next]!;
        if (!lengths || lengths.has(end - start)) add(start, end);
      }
    }
  }
  return [...keys];
}

const compact = (text: string): string => text.normalize('NFC').replace(/\s+/gu, '');

interface AssistantRegion {
  text: string; locations: (CellLocation | undefined)[]; startRow: number; endRow: number;
  clippedStart: boolean; clippedEnd: boolean;
}

// Table rules are indented assistant content. Only an outer rule or the
// explicit completion label can terminate an assistant region.
const footer = (text: string) => /^\s*(?:Worked for\s+\d+(?:\.\d+)?(?:ms|[smh])(?:\s+\d+(?:\.\d+)?(?:ms|[smh]))*|(?:工作了|已工作)\s*\d+(?:\.\d+)?\s*(?:毫秒|秒|分钟|分|小时))(?:\s+•\s+(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12]\d|3[01])(?:, \d{4})? at )?(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)?(?:\s*[─━]+)?\s*$/.test(text) || /^─{3,}\s*$/.test(text);

/** Presentation conversions must preserve display math and code byte-for-byte. */
function presentationLines(text: string, leadingContext = '') {
  const prefix = leadingContext ? leadingContext.endsWith('\n') ? leadingContext : leadingContext + '\n' : '';
  const full = prefix + text, displays = findDisplayMath(full);
  let offset = 0, fence: { char: string; size: number } | undefined;
  return full.split('\n').map(line => {
    const start = offset; offset += line.length + 1;
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    const protectedLine = !!fence || !!marker || /^(?: {4}|\t)/.test(line) ||
      displays.some(block => start >= block.start && start < block.end);
    if (marker) {
      if (!fence) fence = { char: marker[1]![0]!, size: marker[1]!.length };
      else if (marker[1]![0] === fence.char && marker[1]!.length >= fence.size && !marker[2]!.trim()) fence = undefined;
    }
    return { text: line, protected: protectedLine, visible: start >= prefix.length };
  }).filter(line => line.visible);
}

function renderedLists(text: string): string {
  return presentationLines(text).map(line => line.protected ? line.text : line.text.replace(/^- (?=\S)/, '• ')).join('\n');
}

/** Known rectangular pipe tables render as ordered cell text and decorative
 * rules. Verify every cell, including when the viewport starts in the last row. */
function renderedTables(text: string): string {
  const lines = presentationLines(text), output: string[] = [];
  const cells = (index: number) => {
    const line = lines[index];
    if (!line || line.protected || !/^\|.*\|\s*$/.test(line.text) || /\\\|/.test(line.text)) return;
    return line.text.trimEnd().slice(1, -1).split('|').map(cell => cell.trim());
  };
  for (let index = 0; index < lines.length; index++) {
    const header = cells(index), rule = cells(index + 1);
    if (!header || header.length < 2 || header.length > 32 || rule?.length !== header.length ||
        !rule.every(cell => /^:?-{3,}:?$/.test(cell))) { output.push(lines[index]!.text); continue; }
    const rows = [header];
    let end = index + 2, row;
    while ((row = cells(end)) && row.length === header.length) { rows.push(row); end++; }
    if (row) { output.push(lines[index]!.text); continue; } // malformed table: retain literal source
    output.push(...rows.map(cells => cells.join(' '))); index = end - 1;
  }
  return output.join('\n');
}

function withoutTableRules(text: string, leadingContext = ''): string {
  return presentationLines(text, leadingContext).map(line => !line.protected && /^[━─]+(?:\s+[━─]+)*\s*$/.test(line.text.trim())
    ? ' '.repeat(line.text.length) : line.text).join('\n');
}

/** Recover the actual preceding role boundary from bounded, read-only UIA context. */
function continuationSource(context: string): { heading: string; prefix: string } | undefined {
  const lines = context.split(/\r?\n/).map(x => x.trimEnd());
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    if (footer(line)) return;
    if (!line.startsWith('  ')) return line.startsWith('• ')
      ? { heading: line.slice(2), prefix: lines.slice(index).map(line => line.slice(2)).join('\n') + '\n' } : undefined;
  }
}

/** Strict Codex TUI shape: column-zero bullet, two-cell continuation margin. */
function assistantRegions(snapshot: ScreenSnapshot, heading?: string): AssistantRegion[] {
  const regions: AssistantRegion[] = [];
  const leading = snapshot.lines.find(x => x.text.trim());
  const continuation = !!heading && !!leading && leading.text.startsWith('  ') && !footer(leading.text);
  for (let i = 0; i < snapshot.lines.length; i++) {
    const first = snapshot.lines[i]!;
    const clippedStart = i === 0 && continuation;
    if (!first.text.startsWith('• ') && !clippedStart) continue;
    let text = '';
    let endRow = first.endRow;
    let clippedEnd = true;
    const locations: (CellLocation | undefined)[] = [];
    for (let j = i; j < snapshot.lines.length; j++) {
      const line = snapshot.lines[j]!;
      if ((j > i && line.text.trim() && !line.text.startsWith('  ')) || footer(line.text)) {
        clippedEnd = false; break;
      }
      const margin = line.text ? 2 : 0;
      text += line.text.slice(margin) + '\n';
      locations.push(...line.locations.slice(margin), undefined);
      endRow = line.endRow;
    }
    regions.push({ text, locations, startRow: first.startRow, endRow, clippedStart, clippedEnd });
  }
  return regions;
}

function verifySourceForm(source: string, screen: AssistantRegion, heading?: string, allowClipped = false, leadingContext = '', fallback = false) {
  const approved = findDisplayMath(source), visible = findDisplayMath(screen.text, screen.clippedStart ? leadingContext : '');
  // Track native conversions through the same whole-answer proof. Readable
  // Unicode remains literal; residual scripts get the original canonical TeX.
  const nativeDisplays = (text: string, proof: NonNullable<ReturnType<typeof assistantTextProof>>, prefix = 0) => {
    const literal = findDisplayMath(text);
    return expandCompactRanges(text, proof.trackedRanges ?? []).flatMap(range => {
      if (range.start < prefix || literal.some(block => range.start < block.end && range.end > block.start)) return [];
      const shown = text.slice(range.start, range.end);
      if (!/[_^]/u.test(shown)) return [];
      // A display overlay owns whole rows: never erase prose sharing an edge.
      const left = text.slice(text.lastIndexOf('\n', range.start - 1) + 1, range.start);
      const newline = text.indexOf('\n', range.end);
      const right = text.slice(range.end, newline < 0 ? text.length : newline);
      if (left.trim() || right.trim()) return [];
      return [{ tex: approved[range.index]!.tex, start: range.start - prefix, end: range.end - prefix }];
    });
  };
  const visibleSources = (start = 0, blocks = visible) => {
    const mapped = [];
    for (const formula of blocks) {
      const index = approved.findIndex((block, index) => index >= start && displayMatches(block.tex, formula.tex));
      if (index < 0) return;
      mapped.push(approved[index]!); start = index + 1;
    }
    return { approved: mapped, visible: blocks };
  };
  const protectedBlocks = (text: string, proof: NonNullable<ReturnType<typeof assistantTextProof>>) =>
    findDisplayMath(text).filter(block => {
      const start = compact(text.slice(0, block.start)).length, end = compact(text.slice(0, block.end)).length;
      return !proof.codeRanges.some(range => range.start < end && range.end > start);
    });
  if (screen.clippedStart && (!heading || !assistantTextMatches(source, heading, 'prefix'))) return;
  if (screen.clippedStart && leadingContext) {
    // Visibility controls placement, not how much source evidence is available.
    // Verify the actual text from the preceding role boundary through this
    // viewport. Otherwise short prose or a cut inline span at the top makes an
    // unchanged, fully visible equation disappear at certain scroll positions.
    const prefix = leadingContext.endsWith('\n') ? leadingContext : leadingContext + '\n';
    const expanded = prefix + screen.text;
    const proof = assistantTextProof(source, expanded, screen.clippedEnd ? 'prefix' : 'exact', approved);
    if (proof) {
      const mapped: typeof approved = [];
      const shown: typeof visible = [];
      let next = 0;
      for (const block of protectedBlocks(expanded, proof)) {
        const index = approved.findIndex((candidate, index) => index >= next && displayMatches(candidate.tex, block.tex));
        if (index < 0) return;
        if (block.start >= prefix.length) {
          mapped.push(approved[index]!);
          shown.push({ ...block, start: block.start - prefix.length, end: block.end - prefix.length });
        }
        next = index + 1;
      }
      return { approved: mapped, visible: shown, native: nativeDisplays(expanded, proof, prefix.length) };
    }
  }
  const proof = assistantTextProof(source, screen.text, allowClipped && screen.clippedEnd ? 'prefix' : 'exact', approved);
  if (proof) {
    const result = visibleSources(0, protectedBlocks(screen.text, proof));
    if (result) return { ...result, native: nativeDisplays(screen.text, proof) };
    return;
  }
  if (!fallback) return;
  // Without a complete proof, hidden code fences cannot safely be located in a
  // clipped screen. Never guess which duplicate TeX belongs to a code sample.
  if (findCodeRanges(source).some(range => /^ {0,3}(?:`{3,}|~{3,})/.test(source.slice(range.start, range.end)))) return;
  if (!allowClipped || (!screen.clippedStart && !screen.clippedEnd) || !visible.length) return;
  // Require meaningful surrounding prose, never identify a continuation by math alone.
  let prose = '', offset = 0;
  for (const formula of visible) { prose += screen.text.slice(offset, formula.start); offset = formula.end; }
  prose += screen.text.slice(offset);
  const letters = prose.split('\n').filter(line => !/[\\{}_^`]/.test(line)).join('').match(/\p{L}/gu)?.length ?? 0;
  if (letters < 24) return;
  const first = visible[0]!;
  for (let index = 0; index < approved.length; index++) {
    const anchor = approved[index]!;
    if (!displayMatches(anchor.tex, first.tex)) continue;
    if (!assistantTextMatches(source.slice(0, anchor.start), screen.text.slice(0, first.start),
      screen.clippedStart ? 'suffix' : 'exact')) continue;
    if (!assistantTextMatches(source.slice(anchor.end), screen.text.slice(first.end),
      screen.clippedEnd ? 'prefix' : 'exact')) continue;
    const result = visibleSources(index);
    if (result) return { ...result, native: [] };
  }
}

/** Track source spans through the exact presentation proof. A matching substring
 * elsewhere in the answer cannot authorize a partial or different occurrence. */
function verifiedInline(message: string, form: string, screen: AssistantRegion, allowClipped: boolean, leadingContext: string) {
  if (screen.clippedStart && !leadingContext) return [];
  const originals = new Map(findInlineMath(message).map(span => [compact(span.raw) + '\0' + span.tex, span]));
  const spans = findInlineMath(form).flatMap(span => {
    const original = originals.get(compact(span.raw) + '\0' + span.tex);
    return original ? [{ ...span, tex: original.tex }] : [];
  });
  if (!spans.length) return [];
  const prefix = screen.clippedStart ? leadingContext.endsWith('\n') ? leadingContext : leadingContext + '\n' : '';
  const full = prefix + screen.text;
  const proof = assistantTextProof(form, full, allowClipped && screen.clippedEnd ? 'prefix' : 'exact', spans);
  if (!proof?.trackedRanges?.length) return [];
  return expandCompactRanges(full, proof.trackedRanges).flatMap(range => {
    if (range.start < prefix.length) return [];
    // Recognition and presentation are separate. Do not shrink an already
    // readable Unicode equation just to replace it with an equivalent bitmap.
    if (!/[_^\\$]/u.test(full.slice(range.start, range.end))) return [];
    return [{ tex: spans[range.index]!.tex, start: range.start - prefix.length, end: range.end - prefix.length,
      visibleText: full.slice(range.start, range.end) }];
  });
}

function verifiedFormulas(message: string, screen: AssistantRegion, heading?: string, allowClipped = false, leadingContext = '', inlineMath = false) {
  const source = plainMarkdown(message);
  const links = plainMarkdown(message, { linkLabels: true });
  const forms = new Set([message, source, renderedLists(source), links, renderedLists(links)]);
  // Prefer a complete proof in any known presentation before accepting a
  // clipped fallback. A table tail alone must not discard offscreen evidence
  // that also maps the native blocks farther down the same viewport.
  for (const fallback of allowClipped ? [false, true] : [false]) for (const form of forms) {
    const exact = verifySourceForm(form, screen, heading, allowClipped, leadingContext, fallback);
    if (exact) return { ...exact, inline: inlineMath ? verifiedInline(message, form, screen, allowClipped, leadingContext) : [] };
    const tables = renderedTables(form);
    if (tables !== form) {
      const result = verifySourceForm(tables, { ...screen, text: withoutTableRules(screen.text, screen.clippedStart ? leadingContext : '') },
        heading, allowClipped, withoutTableRules(leadingContext), fallback);
      if (result) return { ...result, inline: [] }; // table cell geometry needs separate validation
    }
  }
}

/** All visible assistant text must agree with one uniquely identified session. */
export function matchCodex(snapshot: ScreenSnapshot, sessions: CodexSession[], options: { leadingContext?: string; allowClipped?: boolean; inlineMath?: boolean } = {}): MatchResult {
  const continuation = continuationSource(options.leadingContext ?? '');
  const heading = continuation?.heading;
  const screenRegions = assistantRegions(snapshot, heading);
  // Include every candidate, even unmatched ones: adding/changing a message can
  // change which session is unique. The native host uses these bounds to keep
  // verified images stable while unrelated input changes below the messages.
  const sourceRanges = screenRegions.map(({ startRow, endRow }) => ({ startRow, endRow }));
  const matches = sessions.map(session => {
    const regions: FormulaRegion[] = [];
    const verifiedRanges: { startRow: number; endRow: number }[] = [];
    let evidence = 0;
    for (const screen of screenRegions) {
      const screenText = compact(screen.text);
      if (screenText.length + (screen.clippedStart ? compact(continuation?.prefix ?? '').length : 0) < 24) continue;
      let verified: ReturnType<typeof verifiedFormulas>;
      for (const message of session.assistant) {
        verified = verifiedFormulas(message, screen, heading, options.allowClipped, continuation?.prefix, options.inlineMath);
        if (verified) break;
      }
      if (!verified) continue;
      evidence++;
      verifiedRanges.push({ startRow: screen.startRow, endRow: screen.endRow });
      const { approved, visible } = verified;
      if (approved.length !== visible.length) continue;
      for (const [index, formula] of visible.entries()) {
        const source = approved[index];
        if (!source || !displayMatches(source.tex, formula.tex)) continue;
        const points = screen.locations.slice(formula.start, formula.end).filter((x): x is CellLocation => !!x);
        if (!points.length) continue;
        const startRow = points[0]!.row;
        const endRow = points.at(-1)!.row;
        const startColumn = Math.min(...points.map(x => x.column));
        // The remainder of these rows is blank in this verified display block.
        regions.push({ tex: source.tex, startRow, endRow, startColumn, endColumn: snapshot.cols });
      }
      for (const formula of options.inlineMath ? verified.native : []) {
        const points = screen.locations.slice(formula.start, formula.end).filter((x): x is CellLocation => !!x);
        if (!points.length) continue;
        regions.push({ tex: formula.tex, startRow: points[0]!.row, endRow: points.at(-1)!.row,
          startColumn: Math.min(...points.map(point => point.column)), endColumn: snapshot.cols, requiresPreview: true });
      }
      for (const formula of verified.inline) {
        const points = screen.locations.slice(formula.start, formula.end).filter((x): x is CellLocation => !!x);
        if (!points.length || points[0]!.row !== points.at(-1)!.row || /[\r\n]/.test(formula.visibleText)) continue;
        regions.push({ tex: formula.tex, kind: 'inline', visibleText: formula.visibleText,
          startRow: points[0]!.row, endRow: points[0]!.row, startColumn: points[0]!.column,
          endColumn: points.at(-1)!.column + 1 });
      }
      regions.sort((a, b) => a.startRow - b.startRow || a.startColumn - b.startColumn);
    }
    return { session, regions, evidence, verifiedRanges };
  }).filter(x => x.evidence > 0);
  // Never choose by timestamp. Shared messages are insufficient to distinguish sessions.
  if (matches.length !== 1) return { regions: [], sourceRanges, state: matches.length ? 'ambiguous' : 'waiting' };
  const selected = matches[0]!;
  return { regions: selected.regions, sourceRanges, verifiedRanges: selected.verifiedRanges,
    state: 'matched', sessionId: selected.session.id };
}
