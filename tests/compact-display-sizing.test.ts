import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeAnalyzer } from '../packages/windows-companion/src/analyzer.js';
import { matchCodexText } from '../packages/adapter-codex/src/matcher.js';

const tex = String.raw`\{x_{i,1},x_{i,2},x_{i,3},x_{i,4}\}.`;
// An observed Codex display: braces become glyphs, compound scripts stay raw.
const shown = '{x_{i,1},x_{i,2},x_{i,3},x_{i,4}}.';
const block = '\\[\n' + tex + '\n\\]';
const heading = '同一个独立提示采样四条输出，接下来列出各个样本。';
const ending = '随后在这四个奖励内部计算均值、标准差和相对优势。';
const source = heading + '\n\n' + block + '\n\n' + ending;
const display = source.replace(block, shown);
const fixture = (source: string) => ({ id: 'compact-display', file: 'synthetic', cwd: 'D:/fixture', assistant: [source] });
const physical = (text: string, prefix = '• ') => prefix + text.replaceAll('\n', '\r\n  ');
const input = { type: 'analyze' as const, id: 1, width: 3780, rowHeight: 28,
  foreground: '#cccccc', background: '#0c0c0c', inlineMath: true };
function analyze(text: string, original = source, leadingContext = '') {
  const analyzer = new NativeAnalyzer();
  let result = analyzer.analyze({ ...input, text, leadingContext }, [fixture(original)]);
  for (let retry = 0; result.pendingRender && retry < 10; retry++)
    result = analyzer.analyze({ ...input, text, leadingContext }, [fixture(original)]);
  return result;
}

test('collapsed standalone displays use neighbouring blank rows for readable compound subscripts', () => {
  const roomy = analyze(physical(display));
  const tightSource = heading + '\n' + block + '\n' + ending;
  const tight = analyze(physical(tightSource.replace(block, shown)), tightSource);
  assert.equal(roomy.formulas.length, 1); assert.equal(tight.formulas.length, 1);
  const image = roomy.formulas[0]!, small = tight.formulas[0]!;
  assert.deepEqual([image.startRow, image.endRow], [1, 3]);
  assert.deepEqual([small.startRow, small.endRow], [1, 1]);
  assert.ok(image.height >= small.height * 2, 'use actual vertical space to make symbols at least twice as tall');
  assert.ok(image.height > input.rowHeight && image.height <= 3 * input.rowHeight - 8);
  assert.ok(image.width < input.width, 'horizontal whitespace is not stretched to fill the window');
  assert.equal(analyze(physical(display).replace('• ', '› ')).formulas.length, 0);
  assert.equal(analyze(physical(display).replace('x_{i,4}', 'x_{i,5}')).formulas.length, 0);
  assert.equal(matchCodexText(physical(display), [fixture(source)], '', false).regions.length, 0);
});

test('compact displays never cover prose, code, controls or another formula sharing a blank row', () => {
  const raw = heading + '\n\n' + block + '\n\n' + block + '\n\n' + ending;
  const text = physical(raw.replaceAll(block, shown)) + '\r\n  Worked for 1s\r\n\r\n› Input';
  const result = analyze(text, raw);
  assert.equal(result.formulas.length, 2);
  assert.ok(result.formulas[0]!.endRow < result.formulas[1]!.startRow);
  const rows = text.split(/\r?\n/);
  for (const f of result.formulas) for (let row = f.startRow; row <= f.endRow; row++)
    assert.ok(!rows[row]!.trim() || rows[row]!.trim() === shown, 'every covered row is formula or genuine whitespace');
  const tailSource = heading + '\n\n' + block;
  const tail = analyze(physical(tailSource.replace(block, shown)) + '\r\n\r\n  Worked for 1s\r\n› Input', tailSource);
  assert.deepEqual(tail.formulas.map(f => [f.startRow, f.endRow]), [[1, 2]], 'trailing padding remains outside the streaming proof');
  const codeSource = heading + '\n\n```text\n' + shown + '\n```\n\n' + ending;
  assert.equal(analyze(physical(codeSource.replace('```text\n', '').replace('\n```', '')), codeSource).formulas.length, 0);
});

test('every visible compact display renders independently and equal slots reuse the same image at all scroll positions', () => {
  const lines = display.split('\n');
  const ids = new Map<number, string>();
  for (const height of [1, 2, 3, 4, 5, 8]) for (let top = 0; top < lines.length; top++) {
    const visible = lines.slice(top, top + height), leading = top ? physical(lines.slice(0, top).join('\n')) + '\r\n' : '';
    const result = analyze(physical(visible.join('\n'), top ? '  ' : '• '), source, leading);
    const complete = top <= 2 && top + visible.length > 2;
    assert.equal(result.formulas.length, complete ? 1 : 0, `top=${top}, height=${height}`);
    if (!complete) continue;
    const image = result.formulas[0]!, originalRow = 2 - top;
    assert.ok(image.startRow <= originalRow && image.endRow >= originalRow);
    for (let row = image.startRow; row <= image.endRow; row++)
      assert.ok(row === originalRow || !visible[row]!.trim());
    const span = image.endRow - image.startRow;
    if (ids.has(span)) assert.equal(image.imageId, ids.get(span), 'moving the slot never changes its cached image');
    else ids.set(span, image.imageId);
  }
});
