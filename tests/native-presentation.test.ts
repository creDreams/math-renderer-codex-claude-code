import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistantTextMatches } from '../packages/adapter-codex/src/inline-math.js';
import { renderCodexSpatialDisplay } from '../packages/adapter-codex/src/native-display.js';
import { matchVisibleText } from '../packages/windows-companion/src/analyzer.js';
import { findDisplayMath } from '../packages/core/src/display-math.js';

const boxTex = String.raw`\boxed{\hat A_t=\frac{G_t-\mu}{\sigma+\delta}}`;
const boxText = '┌─────────┐\n│    Gₜ-μ │\n│ Âₜ=──── │\n│    σ+δ  │\n└─────────┘';
const literal = '\\[\n\\mathbb E_q[Q]-\\eta\\mathrm{KL}(q\\|p).\n\\]';
const physical = (text: string, margin = '  ') => margin + text.replaceAll('\n', '\r\n  ');
const heading = '下面验证批次回报、归一化优势及策略更新之间的完整推导。';
const code = '```python\n# literal TeX in code\n' + literal + '\nprint("$x^2$")\n```';
const source = heading + '\n\n' + literal + '\n\n归一化：\n\n\\[\n' + boxTex + '\n\\]\n\n代码示例：\n\n' +
  code + '\n\n继续推导：\n\n' + literal + '\n\n以上。';
const displayed = source.replace('\\[\n' + boxTex + '\n\\]', boxText).replace('```python\n', '').replace('\n```', '');
const session = { id: 'native-layout', cwd: 'D:/fixture', file: 'fixture', assistant: [source] };

test('boxed fractions preserve borders, component order and script scopes', () => {
  assert.equal(renderCodexSpatialDisplay(boxTex), boxText);
  assert.ok(assistantTextMatches('\\[\n' + boxTex + '\n\\]', boxText));
  for (const text of [boxText.replace('Gₜ-μ', 'Gₜ+μ'), boxText.replace('σ+δ', 'σ-δ'),
    boxText.replace('─', '-'), boxText.split('\n').reverse().join('\n'), boxText.replace('Âₜ', 'Aₜ')])
    assert.ok(!assistantTextMatches('\\[\n' + boxTex + '\n\\]', text));
  for (const tex of [String.raw`\boxed{\unknown{x}}`, String.raw`\frac{1}{\frac{2}{3}}`,
    String.raw`\boxed{ab}^2`, '\\boxed{'.repeat(40) + 'x' + '}'.repeat(40),
    String.raw`\begin{pmatrix}a&b\\c\end{pmatrix}`, '\\boxed{' + 'x'.repeat(260) + '}'])
    assert.equal(renderCodexSpatialDisplay(tex), undefined, tex);
});

test('aligned, matrix and optimization structures have exact bounded layouts', () => {
  const cases = [
    [String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`, '⎛ a  b ⎞\n⎝ c  d ⎠'],
    [String.raw`\begin{aligned}a&=1\\b&=2\end{aligned}`, 'a =1\nb =2'],
    [String.raw`\underset{x\in\mathbb R}{\max} f(x)`, 'max f(x)\nx∈ℝ'],
    [String.raw`\overset{n}{x}`, 'n\nx'],
    [String.raw`\sum_{\substack{i=1\\j=2}}^n x`, '    n\n    ∑      x\n(i=1; j=2)'],
  ];
  for (const [tex, expected] of cases) {
    assert.equal(renderCodexSpatialDisplay(tex!)?.split('\n').map(row => row.trimEnd()).join('\n'),
      expected!.split('\n').map(row => row.trimEnd()).join('\n'), tex);
    assert.ok(assistantTextMatches('\\[\n' + tex + '\n\\]', expected!));
  }
});

test('default bottom with prompt and hidden code fences renders only genuine formula blocks', () => {
  const terminal = physical(displayed, '• ') + '\r\n\r\n  Worked for 26s • 15:14\r\n\r\n› Ask Codex to do anything\r\nGPT model status';
  const result = matchVisibleText(terminal, [session]);
  assert.deepEqual(result.regions.map(block => block.tex), [findDisplayMath(literal)[0]!.tex, findDisplayMath(literal)[0]!.tex]);
  const lines = displayed.split('\n');
  const starts = result.regions.map(block => block.startRow);
  assert.deepEqual(starts, [lines.indexOf('\\['), lines.lastIndexOf('\\[')]);
  for (const changed of [displayed.replace('print("$x^2$")', 'print("$x^3$")'), displayed.replace('literal TeX', 'other TeX')])
    assert.equal(matchVisibleText(physical(changed, '• ') + '\r\n› prompt', [session]).regions.length, 0);
  assert.equal(matchVisibleText(terminal.replace('• ', '› '), [session]).regions.length, 0);
  assert.equal(matchVisibleText(terminal, [session, { ...session, id: 'duplicate' }]).state, 'ambiguous');
});

test('boxed layouts and hidden code entering either edge never hide complete neighboring formulas', () => {
  const lines = displayed.split('\n');
  const realBlocks = [lines.indexOf('\\['), lines.lastIndexOf('\\[')];
  let checked = 0;
  for (const height of [3, 5, 8, 12, 18, 30, 60]) for (let top = 0; top < lines.length; top++) {
    const visible = physical(lines.slice(top, top + height).join('\n'), top ? '  ' : '• ');
    const leading = top ? physical(lines.slice(0, top).join('\n'), '• ') + '\r\n' : '';
    const expected = realBlocks.filter(row => row >= top && row + 2 < Math.min(lines.length, top + height));
    const result = matchVisibleText(visible, [session], leading);
    assert.deepEqual(result.regions.map(region => region.startRow), expected.map(row => row - top), `top=${top}, height=${height}`);
    checked++;
  }
  assert.ok(checked > 200);
});
