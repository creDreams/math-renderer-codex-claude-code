import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCodexInline, assistantTextMatches } from '../packages/adapter-codex/src/inline-math.js';
import { NativeAnalyzer } from '../packages/windows-companion/src/analyzer.js';

const source = String.raw`PPO（近端策略优化）通过截断新旧策略的概率比，限制策略更新幅度，其目标函数为：

\[
\begin{aligned}
\max_{\theta}\quad
L^{\mathrm{CLIP}}(\theta)
&=
\mathbb{E}_{t}\!\left[
\min\!\left(
r_t(\theta)\hat{A}_t,\,
\operatorname{clip}\!\left(r_t(\theta),1-\epsilon,1+\epsilon\right)\hat{A}_t
\right)
\right],\\
r_t(\theta)
&=
\frac{\pi_{\theta}(a_t\mid s_t)}
{\pi_{\theta_{\mathrm{old}}}(a_t\mid s_t)}.
\end{aligned}
\]

其中，\(\pi_{\theta}\) 和 \(\pi_{\theta_{\mathrm{old}}}\) 分别表示当前策略与采样时的旧策略，\(\hat{A}_t\) 为优势函数估计，\(\epsilon\) 为截断阈值。`;
const visible = source.replaceAll(String.raw`\(\pi_{\theta}\)`, 'π_{θ}')
  .replaceAll(String.raw`\(\pi_{\theta_{\mathrm{old}}}\)`, 'π_{θ_{old}}')
  .replaceAll(String.raw`\(\hat{A}_t\)`, 'A\u0302ₜ')
  .replaceAll(String.raw`\(\epsilon\)`, 'ϵ');
const request = (text: string) => ({ type: 'analyze' as const, id: 1, rowHeight: 28, width: 3780,
  foreground: '#cccccc', background: '#0c0c0c',
  text: '• ' + text.replaceAll('\n', '\r\n  ') + '\r\n\r\n  Worked for 12s\r\n\r\n› Ask Codex' });
const session = { id: 'ppo-regression', file: 'synthetic', cwd: 'D:/fixture', assistant: [source] };

test('PPO aligned block renders when Codex converts surrounding inline Greek, accents and scripts', () => {
  const output = new NativeAnalyzer().analyze(request(visible), [session]);
  assert.equal(output.state, 'matched'); assert.equal(output.formulas.length, 1);
  assert.equal(output.formulas[0]!.startRow, 2); assert.equal(output.formulas[0]!.endRow, 18);
  assert.ok(output.formulas[0]!.width > 600); assert.ok(output.formulas[0]!.height > 100);
});

test('inline equivalence still requires complete prose, exact display source and unique session', () => {
  const analyzer = new NativeAnalyzer();
  for (const text of [visible.replace('近端策略优化', '其他策略'), visible.replace('1+\\epsilon', '2+\\epsilon'),
    visible.slice(0, visible.indexOf('其中')), visible.replace('π_{θ_{old}}', 'π_{θ}')]) {
    assert.equal(analyzer.analyze(request(text), [session]).formulas.length, 0);
  }
  assert.equal(analyzer.analyze(request(visible), [session, { ...session, id: 'other' }]).state, 'ambiguous');
  assert.equal(analyzer.analyze({ ...request(visible), text: request(visible).text.replace('• ', '› ') }, [session]).formulas.length, 0);
  assert.equal(analyzer.analyze(request(source), [session]).formulas.length, 1);
});

test('supported inline math has literal alternatives without discarding unsupported content', () => {
  assert.equal(renderCodexInline(String.raw`\hat{A}_t`), 'A\u0302ₜ');
  assert.equal(renderCodexInline(String.raw`\pi_{\theta_{\mathrm{old}}}`), 'π_{θ_{old}}');
  assert.equal(renderCodexInline(String.raw`\epsilon`), 'ϵ');
  assert.equal(renderCodexInline(String.raw`x^2+\frac{1}{2}`), 'x²+((1)/(2))');
  for (const tex of [String.raw`\unknown{x}`, String.raw`\sqrt[3]{x}`, 'x_{', String.raw`\hat{AB}`, 'x__2'])
    assert.equal(renderCodexInline(tex), undefined);
  assert.ok(assistantTextMatches(String.raw`Given $x^2$ and \(\theta\), end.`, String.raw`Given x² and \(\theta\), end.`));
  assert.equal(assistantTextMatches(String.raw`Given \(\unknown{x}\), end.`, 'Given x, end.'), false);
  assert.equal(assistantTextMatches('Code `\\(\\theta\\)` end.', 'Code `θ` end.'), false);
});
