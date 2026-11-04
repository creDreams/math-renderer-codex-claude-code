import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assistantTextProof, expandCompactRanges } from '../packages/adapter-codex/src/inline-math.js';
import { findInlineMath } from '../packages/core/src/implicit-math.js';
import { matchCodexText } from '../packages/adapter-codex/src/matcher.js';
import { NativeAnalyzer } from '../packages/windows-companion/src/analyzer.js';
import { HistoryIndex } from '../packages/adapter-codex/src/history-index.js';

const equation = 'x^2 + y^2 = r^2', second = 'θ_{t+1} = θ_t − α∇J(θ_t)';
const source = `验证中文与 emoji 😀 的行内数学显示。\n圆的公式 ${equation}，原文保留。\n更新公式 ${second}，原文保留。\n重复 ${equation} 和 ${equation}。\n以上完整结束。`;
const screen = (text: string) => '• ' + text.replaceAll('\n', '\r\n  ') + '\r\n  Worked for 1s\r\n› Input';
const session = (text = source) => ({ id: 'inline', file: 'fixture', cwd: 'D:/fixture', assistant: [text] });

test('tracked proofs map the exact occurrences and do not accept a matching unfinished tail', () => {
  const original = '先定义 x² + y²，随后定义 x² + y² = r²，结束。';
  const spans = findInlineMath(original);
  const prefix = original.slice(0, original.lastIndexOf(' ='));
  const proof = assistantTextProof(original, prefix, 'prefix', spans)!;
  assert.equal(proof.trackedRanges!.some(range => range.index === 1), false,
    'an earlier matching expression cannot authorize the unfinished second occurrence');
  const marked = String.raw`前文 \(x^2 + y^2 = r^2\)，后文 Âₜ。`;
  const visible = '前文 x² + y² = r²，后文 Âₜ。';
  const p = assistantTextProof(marked, visible, 'exact', findInlineMath(marked))!;
  const mapped = expandCompactRanges(visible, p.trackedRanges!);
  assert.equal(mapped.length, 1); assert.equal(visible.slice(mapped[0]!.start, mapped[0]!.end), 'x² + y² = r²');
});

test('inline positions are UTF-16 substrings, including repeated formulas on the same row', () => {
  const visible = screen(source), match = matchCodexText(visible, [session()], '', true);
  assert.equal(match.state, 'matched'); assert.equal(match.regions.length, 4);
  for (const region of match.regions) {
    assert.equal(region.kind, 'inline'); assert.equal(region.startRow, region.endRow);
    assert.equal(visible.split(/\r?\n/)[region.startRow]!.slice(region.startColumn, region.endColumn), region.visibleText);
  }
  assert.equal(match.regions[2]!.startRow, match.regions[3]!.startRow);
  assert.ok(match.regions[2]!.endColumn < match.regions[3]!.startColumn);
  assert.equal(matchCodexText(visible, [session()]).regions.length, 0, 'preview is opt-in');
});

test('every viewport row preserves complete single-line spans with actual assistant context', () => {
  const lines = screen(source).split(/\r?\n/);
  for (let start = 0; start < lines.length; start++) for (let size = 1; size <= 5; size++) {
    const text = lines.slice(start, start + size).join('\r\n'), context = lines.slice(0, start).join('\r\n') + (start ? '\r\n' : '');
    const match = matchCodexText(text, [session()], context, true);
    const expected = [1, 2, 3, 3].filter(row => row >= start && row < start + size).length;
    assert.equal(match.regions.length, expected, `start ${start}, size ${size}`);
  }
});

test('inline provenance rejects code copies, user roles, edits and ambiguous sessions', () => {
  const actual = source + '\n代码 `' + equation + '`，结束。';
  const displayed = screen(actual.replace('`' + equation + '`', equation));
  assert.equal(matchCodexText(displayed, [session(actual)], '', true).regions.length, 4);
  for (const text of [displayed.replace('圆的公式', '其他内容'), displayed.replace('r^2', 'r^3'), displayed.replace('• ', '› ')])
    assert.equal(matchCodexText(text, [session(actual)], '', true).regions.length, 0);
  assert.equal(matchCodexText(displayed, [session(actual), { ...session(actual), id: 'other' }], '', true).state, 'ambiguous');
});

test('wrapped or clipped inline math stays literal without covering its valid-looking tail', () => {
  const text = '本回答明确给出圆的公式 ' + equation + '，解释到此结束。';
  for (let split = 1; split < equation.length; split++) {
    const display = text.replace(equation, equation.slice(0, split) + '\n' + equation.slice(split));
    assert.equal(matchCodexText(screen(display), [session(text)], '', true).regions.length, 0, 'physical wrap at ' + split);
  }
});

test('bounded image cache evicts and recreates old inline images; rendering budget eventually completes', () => {
  const analyzer = new NativeAnalyzer();
  const request = { type: 'analyze' as const, id: 1, text: 'fixture', rowHeight: 28, width: 1680,
    foreground: '#cccccc', background: '#0c0c0c', inlineMath: true };
  const region = (n: number) => ({ tex: `x^2+${n}=y^2`, kind: 'inline' as const, startRow: 0, endRow: 0,
    startColumn: 0, endColumn: 12, visibleText: equation });
  const match = (n: number) => ({ state: 'matched' as const, sourceRanges: [{ startRow: 0, endRow: 0 }], regions: [region(n)] });
  const first = analyzer.analyze(request, [], match(0)).formulas[0]!;
  for (let n = 1; n <= 1030; n++) {
    const result = analyzer.analyze(request, [], match(n));
    assert.ok(result.metrics.imageEntries <= 1024); assert.ok(result.metrics.imageBytes <= 32 * 1024 * 1024);
  }
  const revisited = analyzer.analyze(request, [], match(0));
  assert.equal(revisited.metrics.imageMisses, 1); assert.equal(revisited.formulas[0]!.imageId, first.imageId);
  const many = { state: 'matched' as const, sourceRanges: [{ startRow: 0, endRow: 0 }],
    regions: Array.from({ length: 100 }, (_, n) => region(2000 + n)) };
  let batch = analyzer.analyze(request, [], many), retries = 0;
  while (batch.pendingRender && retries++ < 100) batch = analyzer.analyze(request, [], many);
  assert.equal(batch.pendingRender, false); assert.equal(batch.formulas.length, 100);
});

test('inline images fit one row and retain native substring information and cache identity', () => {
  const analyzer = new NativeAnalyzer(), request = { type: 'analyze' as const, id: 1, text: screen(source),
    rowHeight: 28, width: 1680, foreground: '#cccccc', background: '#0c0c0c', inlineMath: true };
  let output = analyzer.analyze(request, [session()]);
  for (let retry = 0; output.pendingRender && retry < 10; retry++) output = analyzer.analyze(request, [session()]);
  assert.equal(output.formulas.length, 4);
  for (const formula of output.formulas) {
    assert.equal(formula.kind, 'inline'); assert.ok(formula.height + formula.offsetY! <= 28); assert.ok(formula.visibleText);
  }
  const again = analyzer.analyze(request, [session()]);
  assert.deepEqual(again.formulas.map(x => x.imageId), output.formulas.map(x => x.imageId));
  assert.equal(again.metrics.imageMisses, 0);
});

test('readable inline sizing uses row height across DPI sizes without covering adjacent rows', () => {
  const text = '本回答检查清晰字号与相邻正文。圆的公式 x^2 + y^2 = r^2，后文。';
  for (const rowHeight of [18, 28, 40, 56]) {
    const analyzer = new NativeAnalyzer();
    const request = { type: 'analyze' as const, id: 1, text: screen(text), inlineMath: true,
      rowHeight, width: 1680, foreground: '#cccccc', background: '#0c0c0c' };
    const output = analyzer.analyze(request, [session(text)]);
    assert.equal(output.formulas.length, 1);
    const image = output.formulas[0]!;
    assert.ok(image.height >= rowHeight - 3, 'ordinary superscripts should use the available vertical space');
    assert.ok(image.offsetY! >= 1 && image.offsetY! + image.height <= rowHeight - 1);
    assert.equal(analyzer.analyze({ ...request, inlineMath: false }, [session(text)]).formulas.length, 0,
      'disabling preview removes cached inline images immediately');
    assert.equal(analyzer.analyze(request, [session(text)]).formulas[0]!.imageId, image.imageId);
  }
});

test('PPO, explicit marked math and unmarked math produce single-row PNGs together', () => {
  const ppo = 'L_total(θ) = E_t[L_CLIP(θ) - c₁L_VF(θ) + c₂S[π_θ](s_t)]';
  const text = source + '\n优势 Âₜ = Qₜ − Vₜ，后文。\n总损失 ' + ppo + '，后文。\n' +
    String.raw`明确标记 \(x^2+y^2=r^2\) 和 $x^2$，后文。`;
  const analyzer = new NativeAnalyzer();
  const request = { type: 'analyze' as const, id: 1, text: screen(text), rowHeight: 28, width: 1680,
    foreground: '#cccccc', background: '#0c0c0c', inlineMath: true };
  let result = analyzer.analyze(request, [session(text)]);
  for (let retry = 0; result.pendingRender && retry < 20; retry++) result = analyzer.analyze(request, [session(text)]);
  assert.equal(result.formulas.length, 7); assert.equal(result.skipped, 0);
  assert.ok(result.formulas.some(formula => formula.visibleText === ppo));
});

test('inline history adds old answers and same-row occurrences without altering the block-only index', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'amt-inline-'));
  const home = path.join(root, 'codex'), cache = path.join(root, 'cache');
  await mkdir(path.join(home, 'sessions'), { recursive: true });
  const file = path.join(home, 'sessions/rollout-inline.jsonl');
  const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'inline', cwd: 'D:/fixture' } });
  const record = (text: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) + '\n';
  await writeFile(file, meta + '\n' + record(source));
  const blocks = new HistoryIndex(home, cache), index = new HistoryIndex(home, cache, true);
  t.after(async () => { await blocks.close(); await index.close(); assert.ok(root.startsWith(path.join(os.tmpdir(), 'amt-inline-'))); await rm(root, { recursive: true, force: true }); });
  await blocks.scan(); await index.scan();
  assert.equal(blocks.metrics.indexedMessages, 0); assert.equal(index.metrics.indexedMessages, 1);
  assert.notEqual(index.databaseFile, blocks.databaseFile);
  const result = await index.resolve(screen(source));
  assert.equal(result.pending, false); assert.equal(result.match.regions.length, 4);
  const warm = await index.resolve(screen(source)); assert.equal(warm.metrics.sourceMisses, 0);
  const marked = String.raw`本回答的公式使用明确标记，内容是 \(x^2 + y^2 = r^2\)，后文结束。`;
  await appendFile(file, record(marked)); await index.scan();
  assert.equal((await index.resolve(screen(marked.replace(String.raw`\(x^2 + y^2 = r^2\)`, 'x² + y² = r²')))) .match.regions.length, 0,
    'already readable native Unicode is retained even with marked source');
  const accent = '本回答的优势函数定义为 Âₜ = Qₜ − Vₜ，说明到此结束。';
  await appendFile(file, record(accent)); await index.scan();
  const readable = await index.resolve(screen(accent.normalize('NFC')));
  assert.equal(readable.match.state, 'matched', 'precomposed accents still prove the decomposed source');
  assert.equal(readable.match.regions.length, 0, 'native Unicode keeps its terminal font and spacing');
});

test('readable Unicode remains untouched while neighboring raw scripts and visible delimiters render', () => {
  const text = '本回答检查最终呈现是否确实需要替换，中文标点与相邻正文应保持正常。\n' +
    '圆的公式 x² + y² = r²，优势 Âₜ = Qₜ − Vₜ。\n' +
    String.raw`需增强的公式 G_{i,t} = γ^{k-t}r_{i,k}，以及 \(x^2+y^2=r^2\) 和 $x²$。`;
  const match = matchCodexText(screen(text), [session(text)], '', true);
  assert.equal(match.state, 'matched');
  assert.deepEqual(match.regions.map(region => region.visibleText),
    ['G_{i,t} = γ^{k-t}r_{i,k}', String.raw`\(x^2+y^2=r^2\)`, '$x²$']);
  assert.ok(match.regions.every(region => region.startRow === 2));
});

test('simultaneous upper and lower scripts fit a normal row without shrinking below the readable limit', () => {
  const text = String.raw`本回答验证同时带上下标的行内公式 \(a_{i,j}^2+b_{i,j}^2=c_{i,j}^2\)，中文标点与后文保持正常。`;
  const analyzer = new NativeAnalyzer();
  const request = { type: 'analyze' as const, id: 1, text: screen(text), rowHeight: 28, width: 1680,
    foreground: '#cccccc', background: '#0c0c0c', inlineMath: true };
  let result = analyzer.analyze(request, [session(text)]);
  for (let retry = 0; result.pendingRender && retry < 10; retry++) result = analyzer.analyze(request, [session(text)]);
  assert.equal(result.formulas.length, 1); assert.equal(result.skipped, 0);
  const image = result.formulas[0]!;
  assert.ok(image.height >= 24 && image.height <= 26, 'full scripts use the available row height');
  assert.ok(image.width >= 120, 'a 102 px formula at 16 px/em retains a readable em above 19 px');
  assert.ok(image.offsetY! >= 1 && image.offsetY! + image.height <= 27, 'one pixel separates adjacent rows');
});
