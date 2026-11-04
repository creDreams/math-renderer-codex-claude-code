import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { matchCodexText } from '../packages/adapter-codex/src/matcher.js';
import { NativeAnalyzer } from '../packages/windows-companion/src/analyzer.js';
import { HistoryIndex } from '../packages/adapter-codex/src/history-index.js';

// Observed Codex character layouts, written independently of the predictor.
const samples = [
  { tex: String.raw`G_{i,t}=\sum_{k=t}^{T}\gamma^{k-t}r_{i,k}.`,
    shown: '          T\nG_{i,t}= ∑ γᵏ⁻ᵗr_{i,k}.\n         k=t' },
  { tex: String.raw`\bar G(s)=\frac{1}{|\mathcal G(s)|}\sum_{(j,u)\in\mathcal G(s)}G_{j,u}.`,
    shown: '        1\nḠ(s)=──────     ∑     G_{j,u}.\n      |𝒢(s)| (j,u)∈𝒢(s)' },
  { tex: String.raw`\boxed{\hat A_{i,t}=A_i^{E}+\omega A_{i,t}^{S}}`,
    shown: '┌──────────────────────────────┐\n│ Â_{i,t}=Aᵢ^{E}+ω A_{i,t}^{S} │\n└──────────────────────────────┘' },
];
const block = (tex: string) => '\\[\n' + tex + '\n\\]';
const heading = '这是一条独立验证的完整助手回答，包含字符求和、分式和边框中残留的脚本。';
const source = heading + '\n\n' + samples.map(sample => block(sample.tex)).join('\n\n步骤之间的说明。\n\n') +
  '\n\n已易读的公式：\n' + block('x^2+y^2=r^2') + '\n结束。';
const shown = heading + '\n\n' + samples.map(sample => sample.shown).join('\n\n步骤之间的说明。\n\n') +
  '\n\n已易读的公式：\nx²+y²=r²\n结束。';
const physical = (text: string, margin = '• ') => margin + text.replaceAll('\n', '\r\n  ');
const screen = (text: string) => physical(text) + '\r\n  Worked for 1s\r\n› Input';
const session = { id: 'native-scripts', file: 'fixture', cwd: 'D:/fixture', assistant: [source] };

test('preview switch controls every native character block while marked display formulas remain enabled', () => {
  for (const inline of [false, true]) {
    const result = matchCodexText(screen(shown), [session], '', inline);
    assert.equal(result.state, 'matched');
    assert.deepEqual(result.regions.map(region => region.tex), inline ? samples.map(sample => sample.tex) : []);
    for (const [i, region] of result.regions.entries()) {
      const start = shown.slice(0, shown.indexOf(samples[i]!.shown)).split('\n').length - 1;
      assert.equal(region.startRow, start); assert.equal(region.endRow, start + 2);
      assert.equal(region.kind, undefined, 'native display keeps whole-block geometry');
      assert.equal(region.requiresPreview, true);
    }
    const analyzer = new NativeAnalyzer();
    const request = { type: 'analyze' as const, id: 1, text: screen(shown), inlineMath: inline,
      rowHeight: 28, width: 1680, foreground: '#cccccc', background: '#0c0c0c' };
    let images = analyzer.analyze(request, [session]);
    for (let retry = 0; images.pendingRender && retry < 10; retry++) images = analyzer.analyze(request, [session]);
    assert.equal(images.formulas.length, inline ? 3 : 0); assert.equal(images.skipped, 0);
    assert.ok(images.formulas.every(image => image.height <= 84 && image.height > 28));
    const marked = analyzer.analyze({ ...request, text: screen(source) }, [session]);
    assert.equal(marked.formulas.length, 4, 'visible explicit blocks render with preview on or off');
  }
});

test('disabling preview rejects previously verified and cached character blocks while retaining explicit displays', () => {
  const mixedSource = source + '\n明确块：\n' + block('\\mathbb E_q[Q]-\\eta\\mathrm{KL}(q\\|p)');
  const mixed = shown + '\n明确块：\n' + block('\\mathbb E_q[Q]-\\eta\\mathrm{KL}(q\\|p)');
  const sessions = [{ ...session, assistant: [mixedSource] }];
  const proof = matchCodexText(screen(mixed), sessions, '', true);
  const analyzer = new NativeAnalyzer(), request = { type: 'analyze' as const, id: 1, text: screen(mixed),
    rowHeight: 28, width: 1680, foreground: '#cccccc', background: '#0c0c0c', inlineMath: true };
  let before = analyzer.analyze(request, [], proof);
  for (let retry = 0; before.pendingRender && retry < 10; retry++) before = analyzer.analyze(request, [], proof);
  assert.equal(before.formulas.length, 4);
  assert.equal(analyzer.analyze({ ...request, inlineMath: false }, [], proof).formulas.length, 1,
    'even an old verified match cannot draw preview-only character blocks after the switch is off');
  assert.equal(analyzer.analyze({ ...request, inlineMath: false }, sessions).formulas.length, 1);
});

test('native script blocks render at every fully visible row; either clipped edge stays literal', () => {
  const lines = shown.split('\n');
  const starts = samples.map(sample => shown.slice(0, shown.indexOf(sample.shown)).split('\n').length - 1);
  for (const height of [1, 2, 3, 4, 7, 12, 32]) for (let top = 0; top < lines.length; top++) {
    const visible = physical(lines.slice(top, top + height).join('\n'), top ? '  ' : '• ');
    const leading = top ? physical(lines.slice(0, top).join('\n')) + '\r\n' : '';
    const match = matchCodexText(visible, [session], leading, true);
    const expected = starts.flatMap((start, i) => start >= top && start + 2 < top + height ? [samples[i]!.tex] : []);
    assert.deepEqual(match.regions.map(region => region.tex), expected, `top ${top}, height ${height}`);
  }
});

test('native enhancement preserves code, prose, roles, script meaning and unique provenance', () => {
  for (const text of [shown.replace('r_{i,k}', 'r_{j,k}'), shown.replace('γᵏ⁻ᵗ', 'γᵏ⁺ᵗ'),
    shown.replace('步骤之间的说明', '另一种解释'), shown.replace('Aᵢ^{E}', 'Aᵢ^{S}')])
    assert.equal(matchCodexText(screen(text), [session], '', true).regions.length, 0);
  assert.equal(matchCodexText(screen(shown).replace('• ', '› '), [session], '', true).regions.length, 0);
  assert.equal(matchCodexText(screen(shown), [session, { ...session, id: 'other' }], '', true).state, 'ambiguous');
  const codeSource = source + '\n代码：\n```text\n' + samples[0]!.shown + '\n```';
  assert.equal(matchCodexText(screen(shown + '\n代码：\n' + samples[0]!.shown),
    [{ ...session, assistant: [codeSource] }], '', true).regions.length, 3, 'hidden code fences do not create another image');
  const joined = shown.replace(samples[0]!.shown, '相邻正文 ' + samples[0]!.shown);
  const joinedSource = source.replace(block(samples[0]!.tex), '相邻正文\n' + block(samples[0]!.tex));
  assert.equal(matchCodexText(screen(joined), [{ ...session, assistant: [joinedSource] }], '', true).regions.length, 2,
    'a display sharing a row with prose cannot own that row');
});

test('history retrieves native-only viewports after index restart and still detects ambiguous sources', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'amt-native-scripts-'));
  const home = path.join(root, 'codex'), cache = path.join(root, 'cache');
  await mkdir(path.join(home, 'sessions'), { recursive: true });
  const record = (id: string) => [
    { type: 'session_meta', payload: { id, cwd: 'D:/fixture' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: source }] } },
  ].map(item => JSON.stringify(item)).join('\n') + '\n';
  const file = path.join(home, 'sessions/rollout-native.jsonl');
  await writeFile(file, record('first'));
  const before = await readFile(file);
  const indexes: HistoryIndex[] = [];
  t.after(async () => { for (const index of indexes) await index.close(); await rm(root, { recursive: true, force: true }); });
  for (const inline of [false, true]) {
    const index = new HistoryIndex(home, cache, inline); indexes.push(index);
    await index.scan(); await index.close();
    const reopened = new HistoryIndex(home, cache, inline); indexes.push(reopened);
    await reopened.scan(); assert.equal(reopened.metrics.indexReadBytes, 0);
    const lines = shown.split('\n');
    for (const sample of samples) {
      const top = shown.slice(0, shown.indexOf(sample.shown)).split('\n').length - 1;
      const visible = physical(lines.slice(top, top + 3).join('\n'), '  ');
      const leading = physical(lines.slice(0, top).join('\n')) + '\r\n';
      const result = await reopened.resolve(visible, leading);
      assert.equal(result.match.state, 'matched');
      assert.deepEqual(result.match.regions.map(region => region.tex), inline ? [sample.tex] : []);
    }
  }
  await writeFile(path.join(home, 'sessions/rollout-copy.jsonl'), record('second'));
  const index = indexes.at(-1)!; await index.scan();
  assert.equal((await index.resolve(screen(shown))).match.state, 'ambiguous');
  assert.deepEqual(await readFile(file), before, 'original Codex session file remains untouched');
});
