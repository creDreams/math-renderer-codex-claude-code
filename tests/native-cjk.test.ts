import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCodexInline, assistantTextMatches } from '../packages/adapter-codex/src/inline-math.js';
import { renderCodexSpatialDisplay } from '../packages/adapter-codex/src/native-display.js';
import { findDisplayMath } from '../packages/core/src/display-math.js';
import { matchVisibleText, NativeAnalyzer } from '../packages/windows-companion/src/analyzer.js';

const normalization = String.raw`F_{\mathrm{norm}}(\mathcal Z)
=
\operatorname{std}(\mathcal Z)+\delta,
\qquad
\text{或}
\qquad
F_{\mathrm{norm}}(\mathcal Z)=1.`;
const normalizationText = 'Fₙₒᵣₘ(𝒵) = std(𝒵)+δ,   或   Fₙₒᵣₘ(𝒵)=1.';
const block = (tex: string) => '\\[\n' + tex + '\n\\]';
const physical = (text: string, margin = '  ') => margin + text.replaceAll('\n', '\r\n  ');

test('Chinese text in native math is verified literally, including the reported normalization', () => {
  assert.equal(renderCodexSpatialDisplay(normalization), normalizationText);
  assert.equal(renderCodexInline(String.raw`\text{或}\quad x=1`), '或  x=1');
  assert.ok(assistantTextMatches(block(normalization), normalizationText));
  for (const changed of [normalizationText.replace('或', '且'), normalizationText.replace('δ', 'β'),
    normalizationText.replace('std', 'mean'), normalizationText.replace('𝒵', 'Z')])
    assert.ok(!assistantTextMatches(block(normalization), changed));
  for (const tex of [String.raw`\text{或\unknown{x}}`, String.raw`\text{或}😀`, String.raw`\text{或`])
    assert.equal(renderCodexSpatialDisplay(tex), undefined);
});

test('native CJK layouts use terminal columns for fraction bars, padding and bounds', () => {
  for (const [tex, expected] of [
    [String.raw`\frac{\text{中文}}{x}`, '中文\n────\n x'],
    [String.raw`\frac{\text{（或）}}{x}`, '（或）\n──────\n  x'],
    [String.raw`\frac{\text{한글}}{x}`, '한글\n────\n x'],
    [String.raw`\frac{\text{カナ}}{x}`, 'カナ\n────\n x'],
    [String.raw`\frac{\text{ｶﾅ}}{x}`, 'ｶﾅ\n──\nx'],
    [String.raw`\frac{\text{é}}{x}`, 'é\n─\nx'],
    [String.raw`\boxed{\text{或}}`, '┌────┐\n│ 或 │\n└────┘'],
  ]) assert.equal(renderCodexSpatialDisplay(tex!), expected, tex);
  assert.equal(renderCodexSpatialDisplay('\\text{' + '中'.repeat(129) + '}'), undefined);
});

const heading = '这段独立推导检查轨迹优势、组合优势以及新旧策略更新，公式在任意完整可见位置都应保持显示。';
const literal = block(String.raw`\rho_{i,t}(\theta)=\frac{\pi_\theta(a\mid s)}{\pi_{\mathrm{old}}(a\mid s)}.`);
const objective = block(String.raw`\mathbb E_q[Q]-\eta\mathrm{KL}(q\|p).`);
const chineseFraction = block(String.raw`\frac{\text{中文}}{x}`);
const code = '```text\n' + literal + '\n' + block(normalization) + '\n```';
const source = heading + '\n\n' + chineseFraction + '\n\n因此，步骤级优势为：\n\n' + objective +
  '\n\n新旧策略的概率比为：\n\n' + literal + '\n\n最终，最大化以下目标：\n\n' + objective +
  '\n\n其中，归一化因子可取：\n\n' + block(normalization) + '\n\n代码示例：\n\n' + code + '\n\n以上。';
// Display expectations are explicit; the parser under test does not generate them.
const displayed = source.replace(chineseFraction, '中文\n────\n x').replace(block(normalization), normalizationText)
  .replace('```text\n', '').replace('\n```', '');
const session = { id: 'cjk-regression', cwd: 'D:/fixture', file: 'fixture', assistant: [source] };
const lines = displayed.split('\n');
const literalBlocks = findDisplayMath(displayed.slice(0, displayed.indexOf('代码示例：')));

test('Chinese native math at either viewport edge never hides neighboring complete TeX blocks', () => {
  let checked = 0;
  for (const height of [3, 5, 9, 16, 28, 44, 80]) for (let top = 0; top < lines.length; top++) {
    const visible = lines.slice(top, top + height).join('\n');
    const offset = lines.slice(0, top).reduce((size, line) => size + line.length + 1, 0);
    const expected = literalBlocks.filter(block => block.start >= offset && block.end <= offset + visible.length);
    const leading = top ? physical(lines.slice(0, top).join('\n'), '• ') + '\r\n' : '';
    const result = matchVisibleText(physical(visible, top ? '  ' : '• '), [session], leading);
    assert.deepEqual(result.regions.map(region => region.tex), expected.map(block => block.tex), `top=${top}, height=${height}`);
    for (const [index, block] of expected.entries()) {
      const startRow = displayed.slice(0, block.start).split('\n').length - 1 - top;
      assert.equal(result.regions[index]!.startRow, startRow);
      assert.equal(result.regions[index]!.endRow, startRow + block.tex.split('\n').length + 1);
    }
    checked++;
  }
  assert.ok(checked > 300);
});

test('mixed Chinese native math renders at the default bottom with code and source protections', () => {
  const text = physical(displayed, '• ') + '\r\n  Worked for 26s • 15:14\r\n› Ask Codex\r\nstatus';
  const input = { type: 'analyze' as const, id: 1, text, rowHeight: 28, width: 2400,
    foreground: '#cccccc', background: '#0c0c0c' };
  const analyzer = new NativeAnalyzer(), result = analyzer.analyze(input, [session]);
  assert.equal(result.formulas.length, 3);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.formulas.map(formula => formula.startRow), literalBlocks.map(block => displayed.slice(0, block.start).split('\n').length - 1));
  for (const changed of [text.replace('或', '且'), text.replace('std', 'mean'), text.replace('中文', '中午'),
    text.replace('新旧策略', '其他策略'), text.replace('• ', '› ')])
    assert.equal(analyzer.analyze({ ...input, text: changed }, [session]).formulas.length, 0);
  assert.equal(analyzer.analyze(input, [session, { ...session, id: 'copy' }]).state, 'ambiguous');
});
