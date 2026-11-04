import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDisplayMath } from '../packages/core/src/display-math.js';
import { findCodexVisibleMath } from '../packages/adapter-codex/src/matcher.js';
import { matchVisibleText } from '../packages/windows-companion/src/analyzer.js';
import { assistantTextMatches, renderCodexInline } from '../packages/adapter-codex/src/inline-math.js';
import { renderCodexSpatialDisplay } from '../packages/adapter-codex/src/native-display.js';

const heading = '这段推导依次说明多个相邻的采样分布及其优化关系，下面保留各个公式的原文。';
const first = '\\[\n\\frac{p(a)}{Z}=q(a).\n\\]';
const second = '$$\n\\max_q\\left\\{\\mathbb E_q[Q]-\\eta\\mathrm{KL}(q\\|p)\\right\\}.\n$$';
const source = heading + '\n\n' + first + '\n\n其中：\n\n' + second + '\n\n' +
  first + '\n\n结论：\n\n' + second + '\n\n以上。';
const session = { id: 'positions', file: 'fixture', cwd: 'D:/fixture', assistant: [source] };
const physical = (text: string, initial = '  ') => initial + text.replaceAll('\n', '\r\n  ');

test('dense formulas stay mapped at every row even when visible prose is short or absent', () => {
  const lines = source.split('\n'), blocks = findDisplayMath(source);
  let checked = 0;
  for (const height of [3, 4, 5, 7, 9, 12, 18, 28]) for (let top = 0; top < lines.length; top++) {
    const text = lines.slice(top, top + height).join('\n');
    const offset = lines.slice(0, top).reduce((n, line) => n + line.length + 1, 0);
    const expected = blocks.filter(block => block.start >= offset && block.end <= offset + text.length);
    if (!expected.length) continue;
    const leading = top ? physical(lines.slice(0, top).join('\n'), '• ') + '\r\n' : '';
    const visible = physical(text, top ? '  ' : '• ');
    const result = matchVisibleText(visible, [session], leading);
    assert.deepEqual(result.regions.map(block => block.tex), expected.map(block => block.tex), `top=${top}, height=${height}`);
    assert.equal(findCodexVisibleMath(visible, leading).length, expected.length);
    for (const [index, region] of result.regions.entries()) {
      const row = source.slice(0, expected[index]!.start).split('\n').length - 1 - top;
      assert.equal(region.startRow, row);
      assert.equal(region.endRow, row + 2);
    }
    checked++;
  }
  assert.ok(checked > 100);
});

test('offscreen evidence must join the visible formula exactly and retains role and session checks', () => {
  const split = source.indexOf(first), leading = physical(source.slice(0, split), '• ');
  const visible = physical(first);
  assert.equal(matchVisibleText(visible, [session], leading).regions.length, 1);
  for (const context of ['', '› ' + leading.slice(2), '• Ran a command\r\n  ',
    leading.replace('优化关系', '未知内容'), leading + '  unrelated text\r\n',
    leading + '  Worked for 1s\r\n'])
    assert.equal(matchVisibleText(visible, [session], context).regions.length, 0);
  assert.equal(matchVisibleText(visible.replace('p(a)', 'p(b)'), [session], leading).regions.length, 0);
  assert.equal(matchVisibleText(visible, [session, { ...session, id: 'copy' }], leading).state, 'ambiguous');
});

const spatialTex = '\\sum_{v\\in\\mathcal V}\\frac{p_t(v)}{p_0(v)}';
const spatialText = '    pₜ(v)\n ∑  ─────\nv∈𝒱 p₀(v)';

test('known native fraction and stacked sum layout is verified in exact row order', () => {
  assert.equal(renderCodexSpatialDisplay(spatialTex, renderCodexInline), spatialText);
  assert.equal(renderCodexSpatialDisplay('\\frac{a}{b}\\frac{c}{d}', renderCodexInline), 'a c\n─ ─\nb d');
  assert.equal(renderCodexInline('\\mathcal V'), '𝒱');
  for (const tex of ['\\frac{a}{\\unknown{b}}', '\\sum_{i}^j^k x', '\\frac{a}{b', '\\frac{a}{b}}',
    '\\frac{\\text{😀}}{b}', '\\frac{a}{b}'.repeat(300)])
    assert.equal(renderCodexSpatialDisplay(tex, renderCodexInline), undefined, tex);
  const block = '\\[\n' + spatialTex + '\n\\]';
  assert.ok(assistantTextMatches(block, spatialText));
  for (const wrong of [spatialText.replace('p₀', 'p₁'), spatialText.replace('v∈𝒱', 'v∈𝒰'),
    spatialText.split('\n').reverse().join('\n'), spatialText.replace('─', '-')])
    assert.ok(!assistantTextMatches(block, wrong));
});

test('a neighboring native spatial formula may enter either viewport edge without hiding literal formulas', () => {
  const raw = heading + '\n\n' + first + '\n\n精确形式如下：\n\n\\[\n' + spatialTex + '\n\\]\n\n' +
    '采样估计：\n\n' + second + '\n\n结论：\n\n' + first + '\n\n以上。';
  const display = raw.replace('\\[\n' + spatialTex + '\n\\]', spatialText);
  const lines = display.split('\n'), blocks = findDisplayMath(display), fixture = { ...session, assistant: [raw] };
  let count = 0;
  for (const height of [5, 7, 9, 12, 18, 28]) for (let top = 0; top < lines.length; top++) {
    const visible = lines.slice(top, top + height).join('\n');
    const offset = lines.slice(0, top).reduce((n, line) => n + line.length + 1, 0);
    const expected = blocks.filter(block => block.start >= offset && block.end <= offset + visible.length);
    if (!expected.length) continue;
    const leading = top ? physical(lines.slice(0, top).join('\n'), '• ') + '\r\n' : '';
    const actual = matchVisibleText(physical(visible, top ? '  ' : '• '), [fixture], leading);
    assert.deepEqual(actual.regions.map(block => block.tex), expected.map(block => block.tex), `top=${top}, height=${height}`);
    count++;
  }
  assert.ok(count > 80);
});
