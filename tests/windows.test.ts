import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeAnalyzer, matchVisibleText, type AnalyzeRequest } from '../packages/windows-companion/src/analyzer.js';
import type { CodexSession } from '../packages/adapter-codex/src/matcher.js';
import { MathRenderer } from '../packages/core/src/renderer.js';

const message = '中文目标函数的完整说明：\n\\[\n\\frac{a+b}{c}=x\n\\]\nThe objective has been displayed completely.';
const screen = (text: string) => '• ' + text.replaceAll('\n', '\r\n  ') + '\r\n\r\n  Worked for 1s\r\n\r\n› Ask Codex';
const session: CodexSession = { id: 'fixture', cwd: 'D:/fixture', file: 'fixture', assistant: [message] };
const request: AnalyzeRequest = { type: 'analyze', id: 7, text: screen(message), rowHeight: 28,
  width: 1400, foreground: '#cccccc', background: '#0c0c0c' };

test('streaming proof anchors include verified answers and exclude progress or unrecorded candidates', () => {
  const analyzer = new NativeAnalyzer();
  for (const tail of ['• Working (0s • esc to interrupt)', '◦ Working (1s • esc to interrupt)',
    '• A new answer still streaming\r\n  Its source has not been recorded yet.']) {
    const result = analyzer.analyze({ ...request, text: screen(message) + '\r\n' + tail + '\r\n\r\n› Input' }, [session]);
    assert.equal(result.state, 'matched'); assert.equal(result.formulas.length, 1);
    assert.deepEqual(result.verifiedRanges, [{ startRow: 0, endRow: 5 }]);
    if (tail.startsWith('• ')) assert.equal(result.sourceRanges.length, 2);
    assert.ok(result.formulas.every(formula => result.verifiedRanges!.some(range =>
      formula.startRow >= range.startRow && formula.endRow <= range.endRow)));
  }
  const other = 'This new answer belongs to another recorded session entirely.';
  const conflict = analyzer.analyze({ ...request, text: screen(message) + '\r\n' + screen(other) },
    [session, { ...session, id: 'other', assistant: [other] }]);
  assert.equal(conflict.state, 'ambiguous'); assert.equal(conflict.formulas.length, 0);
  assert.equal(conflict.verifiedRanges, undefined);
});

test('native rendering uses verified Unicode assistant text and produces an actual PNG', () => {
  const result = new NativeAnalyzer().analyze(request, [session]);
  assert.equal(result.state, 'matched'); assert.equal(result.formulas.length, 1);
  const image = result.formulas[0]!;
  const png = Buffer.from(image.png, 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), image.width); assert.equal(png.readUInt32BE(20), image.height);
  assert.ok(image.height <= (image.endRow - image.startRow + 1) * request.rowHeight);
  assert.ok(image.width < request.width); assert.equal(result.id, request.id);
});

test('policy ratios containing a less-than sign survive standalone SVG XML and PNG rendering', () => {
  const ratio = String.raw`r_{i,t}(\theta)
=
\frac{\pi_\theta(o_{i,t}\mid q,o_{i,<t})}
{\pi_{\theta_{\mathrm{old}}}(o_{i,t}\mid q,o_{i,<t})}.`;
  const text = 'The policy ratio compares the current and sampling policy.\n\\[\n' + ratio + '\n\\]\nEnd of the verified ratio.';
  const result = new NativeAnalyzer().analyze({ ...request, text: screen(text) }, [{ ...session, assistant: [text] }]);
  assert.equal(result.state, 'matched'); assert.equal(result.skipped, 0); assert.equal(result.formulas.length, 1);
  const png = Buffer.from(result.formulas[0]!.png, 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(png.readUInt32BE(16) > 100 && png.readUInt32BE(20) > 30);
  const svg = new MathRenderer().render(ratio).svg;
  assert.ok(svg.includes('data-latex="&lt;"'));
  assert.ok(svg.includes('data-c="3C"'), 'the less-than glyph must remain in the rendered formula');
});

test('native row mapping preserves duplicate formula occurrences independently', () => {
  const result = new NativeAnalyzer().analyze({ ...request, text: screen(message) + '\r\n' + screen(message) }, [session]);
  assert.equal(result.formulas.length, 2);
  assert.notEqual(result.formulas[0]!.startRow, result.formulas[1]!.startRow);
  assert.equal(result.formulas[0]!.imageId, result.formulas[1]!.imageId);
});

test('native recognition keeps user, clipped, unfinished and ambiguous content as source', () => {
  for (const text of ['› ' + message.replaceAll('\n', '\r\n  '), screen(message).slice(2),
    screen(message.slice(0, message.indexOf('\\]')))]) {
    assert.equal(new NativeAnalyzer().analyze({ ...request, text }, [session]).formulas.length, 0);
  }
  const result = matchVisibleText(request.text, [session, { ...session, id: 'other' }]);
  assert.equal(result.state, 'ambiguous'); assert.equal(result.regions.length, 0);
});

test('native renderer preserves source when space is insufficient or TeX is unsupported', () => {
  assert.equal(new NativeAnalyzer().analyze({ ...request, width: 40 }, [session]).formulas.length, 0);
  const unsupported = message.replace('\\frac{a+b}{c}=x', '\\href{https://example.com}{x}');
  assert.equal(new NativeAnalyzer().analyze({ ...request, text: screen(unsupported) },
    [{ ...session, assistant: [unsupported] }]).formulas.length, 0);
});

test('large batches retain supported formulas and report the rendering limit', () => {
  const text = 'This answer contains a collection of complete independent display equations.\n' +
    '\\[\nx^2+y^2=z^2\n\\]\n'.repeat(20) + 'End of the verified batch.';
  const result = new NativeAnalyzer().analyze({ ...request, text: screen(text) }, [{ ...session, assistant: [text] }]);
  assert.equal(result.state, 'matched'); assert.equal(result.formulas.length, 16); assert.equal(result.skipped, 4);
  assert.equal(new Set(result.formulas.map(x => x.startRow)).size, 16);
});

test('native image cache separates theme and DPI while keeping stable image identity', () => {
  const analyzer = new NativeAnalyzer();
  const first = analyzer.analyze(request, [session]).formulas[0]!;
  const cached = analyzer.analyze({ ...request, id: 8 }, [session]).formulas[0]!;
  assert.equal(first.imageId, cached.imageId); assert.equal(first.png, cached.png);
  const light = analyzer.analyze({ ...request, foreground: '#111111' }, [session]).formulas[0]!;
  assert.notEqual(light.imageId, first.imageId); assert.notEqual(light.png, first.png);
  const dpi = analyzer.analyze({ ...request, rowHeight: 42 }, [session]).formulas[0]!;
  assert.ok(dpi.width > first.width); assert.ok(dpi.height > first.height);
  assert.throws(() => analyzer.analyze({ ...request, foreground: 'url(file:///x)' }, [session]));
});

test('native formula sizing uses spare space while preserving aspect ratio and fitting narrow slots', () => {
  const analyzer = new NativeAnalyzer();
  const tex = '\\begin{aligned}\na&=b+c\\\\\nd&=e+f\n\\end{aligned}';
  const text = 'A complete multi-line formula with room to render.\n\\[\n' + tex + '\n\\]\nEnd of the verified answer.';
  const input = { ...request, text: screen(text) };
  const sessions = [{ ...session, assistant: [text] }];
  const math = new MathRenderer().render(tex);
  const large = analyzer.analyze(input, sessions).formulas[0]!;
  assert.ok(large.width >= math.width * request.rowHeight * 0.8 / 16 * 1.6,
    'roomy formula should be at least 60% larger than the previous size');
  assert.ok(large.height <= (large.endRow - large.startRow + 1) * input.rowHeight - 8);
  assert.ok(Math.abs(large.width / large.height - math.width / math.height) < 0.05);
  const narrow = analyzer.analyze({ ...input, width: 150 }, sessions).formulas[0]!;
  assert.ok(narrow.width <= 126 && narrow.width < large.width);
});

test('native reuse proof covers all candidates and excludes unrelated prompt input', () => {
  const analyzer = new NativeAnalyzer();
  const before = analyzer.analyze(request, [session]);
  const after = analyzer.analyze({ ...request, text: request.text.replace('Ask Codex', 'draft input') }, [session]);
  assert.deepEqual(before.sourceRanges, after.sourceRanges);
  for (const range of before.sourceRanges) {
    const slice = (text: string) => text.split(/\r?\n/).slice(range.startRow, range.endRow + 1).join('\n');
    assert.equal(slice(request.text), slice(request.text.replace('Ask Codex', 'draft input')));
  }
  const appended = analyzer.analyze({ ...request, text: request.text + '\r\n• another assistant candidate' }, [session]);
  assert.equal(appended.sourceRanges.length, before.sourceRanges.length + 1);
});
