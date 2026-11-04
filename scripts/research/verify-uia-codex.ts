// Semantic bridge probe only. Physical coordinates come from UIA text ranges.
import { readFile, writeFile } from 'node:fs/promises';
import { SessionStore } from '../../packages/adapter-codex/src/sessions.js';
import { matchCodex } from '../../packages/adapter-codex/src/matcher.js';
import type { ScreenSnapshot } from '../../packages/xterm-addon/src/snapshot.js';

const input = process.argv[2] ?? 'test-results/wt-uia-codex-before.json';
const capture = JSON.parse(await readFile(input, 'utf8'));
const terminal = capture.elements.find((x: any) => x.className === 'TermControl');
if (!terminal) throw new Error('No terminal UIA element');
const lines = terminal.visible[0].text.split(/\r?\n/).map((x: string) => x.trimEnd());
const snapshot: ScreenSnapshot = { buffer: 'normal', cols: Math.max(...lines.map((x: string) => x.length)),
  lines: lines.map((text: string, row: number) => ({ text, startRow: row, endRow: row,
    // Placeholder cell columns are sufficient for semantic verification, not drawing.
    locations: Array.from({ length: text.length }, (_, column) => ({ row, column })) })) };
const sessions = await new SessionStore().refresh();
const match = matchCodex(snapshot, sessions);
const compact = (text: string) => text.replace(/\s+/g, '');
const observed = terminal.formula?.text.split(/\r?\n/).map((x: string) => x.trim()).join('\n');
const result = { discoveredSessions: sessions.length, match: match.state, formulas: match.regions.length,
  formulaAgreesWithAssistantRecord: !!observed && match.regions.some(x => compact('\\[' + x.tex + '\\]') === compact(observed)),
  coordinatesFrom: 'UIA GetBoundingRectangles; placeholder columns are not used for drawing',
  writesToAgentOrTerminal: false };
await writeFile('test-results/wt-uia-codex-provenance.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
if (result.match !== 'matched' || !result.formulaAgreesWithAssistantRecord) process.exitCode = 1;
