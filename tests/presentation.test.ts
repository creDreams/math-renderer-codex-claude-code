import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainMarkdown } from '../packages/adapter-codex/src/markdown-presentation.js';
import { assistantTextMatches } from '../packages/adapter-codex/src/inline-math.js';
import { findDisplayMath } from '../packages/core/src/display-math.js';
import { matchVisibleText, NativeAnalyzer } from '../packages/windows-companion/src/analyzer.js';

const dollar = String.raw`$$
p_{\mathrm{SSD}}(v\mid s)^{1/T_{\mathrm{gen}}}
\approx q_s(v)^{1/T_{\mathrm{gen}}}
\propto
p_0(v\mid s)^{1/T_{\mathrm{gen}}^2},
$$`;
const bracket = '\\[\n\\frac{p_0(v)}{Z(s)}=q_s(v).\n\\]';
const session = (text: string, id = 'presentation') => ({ id, cwd: 'D:/fixture', file: id, assistant: [text] });
const tui = (text: string) => '• ' + text.replaceAll('\n', '\r\n  ') + '\r\n  Worked for 1m 56s • Nov 2 at 16:41\r\n› input';
const prologue = 'This independently verified mathematical discussion explains the target sampling distribution.';

test('Markdown emphasis can enclose math and code while literal mathematical markers stay unchanged', () => {
  const source = '# Heading\n**Fit \\(q_s\\), $p_0$ and `literal_code` together.**\n' +
    '*fork positions* and _lock positions_; **strong with *nested emphasis***.\n' +
    '__A second strong span__ and untouched snake_case_names, a*b, \\*literal\\*.\n' +
    '**First line\nsecond line**\n' + dollar + '\n\\[\nx*y*\n    z\na*b*\n\\]\n' +
    '```text\n**literal bold** and *literal italic*\n```\n\n    **indented code**\n\n' +
    'Inline `**code**` and \\(\\text{*literal math*}\\).';
  const expected = 'Heading\nFit \\(q_s\\), $p_0$ and `literal_code` together.\n' +
    'fork positions and lock positions; strong with nested emphasis.\n' +
    'A second strong span and untouched snake_case_names, a*b, \\*literal\\*.\n' +
    'First line\nsecond line\n' + dollar + '\n\\[\nx*y*\n    z\na*b*\n\\]\n' +
    '```text\n**literal bold** and *literal italic*\n```\n\n    **indented code**\n\n' +
    'Inline `**code**` and \\(\\text{*literal math*}\\).';
  assert.equal(plainMarkdown(source), expected);
  assert.equal(plainMarkdown(source), expected, 'cached derivation is identical');
});

const source = prologue + '\n\n' +
  '**The model fits \\(q_s\\) tokens.** The target distribution is explained below.\n\n' + bracket + '\n\n' +
  '- **Temperature**: helps *fork positions* retain multiple useful alternatives.\n' +
  '- **Truncation**: suppresses residual alternatives in *lock positions*.\n\n' +
  'The fixed point corresponds to the following specific untransformed sampling setup.\n\n' +
  '\\[\nT_{\\mathrm{train}}=1\n\\quad+\\quad\n\\text{no truncation}.\n\\]\n\n' +
  '**A second transformation of \\(q_s\\) changes the distribution.**\n\n' + dollar + '\n\n' +
  'Here the support is fixed and the second truncation is ignored for this local approximation.\n\n' +
  '```text\n*literal italic* and **literal strong**\n```\n\n' +
  'The final interpretation remains conditional on the assumptions of the mathematical analysis.\n\n' +
  '| Stage | Behavior |\n|---|---|\n| Training | Fits the target |\n\n' + dollar + '\n\n' +
  'The remaining mathematical explanation distinguishes training from the second decoding transform.';
// Explicit display expectation, independent from the Markdown derivation.
const displayed = prologue + '\n\n' +
  'The model fits qₛ tokens. The target distribution is explained below.\n\n' + bracket + '\n\n' +
  '• Temperature: helps fork positions retain multiple useful alternatives.\n' +
  '• Truncation: suppresses residual alternatives in lock positions.\n\n' +
  'The fixed point corresponds to the following specific untransformed sampling setup.\n\n' +
  'Tₜᵣₐᵢₙ=1 + no truncation.\n\n' +
  'A second transformation of qₛ changes the distribution.\n\n' + dollar + '\n\n' +
  'Here the support is fixed and the second truncation is ignored for this local approximation.\n\n' +
  '```text\n*literal italic* and **literal strong**\n```\n\n' +
  'The final interpretation remains conditional on the assumptions of the mathematical analysis.\n\n' +
  'Stage Behavior\n━━━━━ ━━━━━━━━━━━━━━━\nTraining Fits the target\n\n' + dollar + '\n\n' +
  'The remaining mathematical explanation distinguishes training from the second decoding transform.';

test('a viewport sweep renders bracket and dollar blocks regardless of surrounding styled prose and native displays', () => {
  const lines = displayed.split('\n');
  const blocks = findDisplayMath(displayed);
  let count = 0;
  for (const height of [18, 29, 54]) for (let top = 0; top < lines.length; top++) {
    const fragment = lines.slice(top, top + height).join('\n');
    const start = lines.slice(0, top).reduce((n, line) => n + line.length + 1, 0);
    // Derive expectation from the full display, independently of clipped
    // parsing: a closing $$ at the viewport top must never open a new block.
    const expected = blocks.filter(block => block.start >= start && block.end <= start + fragment.length);
    if (!expected.length) continue;
    const text = top === 0 ? '• ' + fragment.replaceAll('\n', '\r\n  ') : '  ' + fragment.replaceAll('\n', '\r\n  ');
    const context = top ? '• ' + lines.slice(0, top).join('\r\n  ') + '\r\n' : '';
    const result = matchVisibleText(text, [session(source)], context);
    assert.equal(result.state, 'matched', `top=${top}, height=${height}\n${fragment}`);
    assert.deepEqual(result.regions.map(x => x.tex), expected.map(x => x.tex), `top=${top}, height=${height}`);
    count++;
  }
  assert.ok(count > 100);
});

test('the reported SSD dollar formula reaches PNG rendering and still requires exact content, roles and unique source', () => {
  const input = { type: 'analyze' as const, id: 1, text: tui(displayed), rowHeight: 28, width: 2400,
    foreground: '#cccccc', background: '#0c0c0c' };
  const analyzer = new NativeAnalyzer(), sessions = [session(source)];
  const rendered = analyzer.analyze(input, sessions);
  assert.equal(rendered.formulas.length, 3); assert.equal(rendered.skipped, 0);
  for (const tex of [dollar, bracket]) {
    const text = prologue + '\n\n' + tex + '\n\nThe mathematical context concludes here.';
    assert.equal(analyzer.analyze({ ...input, text: tui(text) }, [session(text)]).formulas.length, 1);
  }
  for (const text of [displayed.replace('fork positions', 'unrelated positions'),
    displayed.replace('q_s(v)^{1/T_', 'q_s(v)^{2/T_'), displayed.replace('no truncation.', 'with truncation.'),
    displayed.replace('*literal italic*', 'literal italic'), displayed.replace('**literal strong**', 'literal strong')])
    assert.equal(analyzer.analyze({ ...input, text: tui(text) }, sessions).formulas.length, 0);
  assert.equal(analyzer.analyze({ ...input, text: input.text.replace('• ', '› ') }, sessions).formulas.length, 0);
  assert.equal(analyzer.analyze(input, [...sessions, session(source, 'duplicate')]).state, 'ambiguous');
  assert.ok(!assistantTextMatches('\\[\n\\unknown{x}\n\\]', 'x'));
});
