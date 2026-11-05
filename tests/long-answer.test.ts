import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeAnalyzer, matchVisibleText } from '../packages/windows-companion/src/analyzer.js';
import { assistantTextMatches } from '../packages/adapter-codex/src/inline-math.js';
import type { CodexSession } from '../packages/adapter-codex/src/matcher.js';
import { findDisplayMath } from '../packages/core/src/display-math.js';

const excerpt = String.raw`一个实现途径是将已有分布作为先验，构造价值加权目标：

\[
q^\*(a\mid s)
\propto
q_{\mathrm{prior}}(a\mid s)
\exp\left(\frac{\widehat Q(s,a)}{\eta}\right).
\]

它对应一个局部优化问题：

\[
\max_q
\left\{
\mathbb E_{a\sim q}[\widehat Q(s,a)]
-
\eta\,\mathrm{KL}(q\|q_{\mathrm{prior}})
\right\}.
\]`;
const introduction = 'SSD reading fixture: compare several approaches and examine their mathematical objectives.\n\n' +
  'Earlier discussion of sampling and semantic candidates.\n'.repeat(80);
const ending = '\n\nThe remainder of this long answer discusses execution budgets and experimental controls.';
const source = introduction + excerpt + ending;
const session: CodexSession = { id: 'ssd-fixture', cwd: 'D:/fixture', file: 'fixture', assistant: [source] };
const tui = (text: string) => text.split('\n').map(line => line ? '  ' + line : '').join('\r\n');
const leadingContext = '• ' + introduction.replaceAll('\n', '\r\n  ');
const request = { type: 'analyze' as const, id: 1, text: tui(excerpt), leadingContext,
  rowHeight: 28, width: 1600, foreground: '#cccccc', background: '#0c0c0c' };

test('long historical SSD answer renders the two visible prior/KL formulas without the whole answer on screen', () => {
  const result = new NativeAnalyzer().analyze(request, [session]);
  assert.equal(result.state, 'matched'); assert.equal(result.formulas.length, 2);
  assert.equal(result.skipped, 0);
  assert.ok(result.formulas.every(image => image.width > 100 && image.height > 30));
});

test('clipped continuation requires its actual preceding assistant heading and exact contextual prose', () => {
  const analyzer = new NativeAnalyzer();
  for (const input of [
    { ...request, leadingContext: '' },
    { ...request, leadingContext: '› user pasted an old answer\r\n  ' },
    { ...request, leadingContext: '• Ran a command\r\n  command output\r\n' },
    { ...request, leadingContext: leadingContext + '  Worked for 2s\r\n' },
    { ...request, text: request.text.replace('构造价值加权目标', '构造完全不同的目标') },
    { ...request, text: request.text.replace('\\max_q', '\\min_q') },
    { ...request, text: tui(excerpt.slice(excerpt.indexOf('\\['), excerpt.indexOf('它对应'))) },
  ]) assert.equal(analyzer.analyze(input, [session]).formulas.length, 0);
  assert.equal(analyzer.analyze(request, [session, { ...session, id: 'duplicate' }]).state, 'ambiguous');
  assert.throws(() => analyzer.analyze({ ...request, leadingContext: 'x'.repeat(65537) }, [session]));
});

test('only complete visible blocks render when a long answer is clipped at both ends', () => {
  const split = excerpt.indexOf('\\exp');
  const visible = excerpt.slice(split) + '\n\nThe remainder of this long answer discusses execution';
  const result = new NativeAnalyzer().analyze({ ...request, text: tui(visible),
    leadingContext: leadingContext + tui(excerpt.slice(0, split)) }, [session]);
  assert.equal(result.formulas.length, 1);
  assert.ok(matchVisibleText(tui(visible), [session], leadingContext + tui(excerpt.slice(0, split)))
    .regions[0]!.tex.includes('\\max_q'));
});

test('visible assistant prefix renders complete blocks before the answer continues off screen', () => {
  const text = excerpt + ending;
  const session = { id: 'prefix', cwd: 'D:/fixture', file: 'fixture', assistant: [text] };
  const result = new NativeAnalyzer().analyze({ ...request, text: '• ' + excerpt.replaceAll('\n', '\r\n  '),
    leadingContext: '' }, [session]);
  assert.equal(result.formulas.length, 2);
});

test('clipped edge matching accepts only bounded literal or known inline Unicode alternatives', () => {
  const text = 'Earlier discussion. The coefficient \\(\\epsilon\\) controls the update, with \\(\\hat{A}_t\\) as advantage. Later discussion.';
  assert.ok(assistantTextMatches(text, 'Earlier discussion. The coefficient ϵ controls', 'prefix'));
  assert.ok(assistantTextMatches(text, 'with Âₜ as advantage. Later discussion.', 'suffix'));
  assert.ok(!assistantTextMatches(text, 'with a different advantage. Later discussion.', 'suffix'));
  assert.ok(!assistantTextMatches(text, 'Earlier discussion. The coefficient anything controls', 'prefix'));
  assert.ok(!assistantTextMatches(text, 'with Âₜ as advantage.', 'suffix'));
});

const tableSource = '\n\n| Metric | Meaning |\n|---|---|\n| Expected return | Estimated outcome |\n\n';
const tableContext = '\r\n  Metric       Meaning\r\n  ━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━\r\n' +
  '  Return       Estimated outcome\r\n  ──────────  ──────────────────\r\n';
const listSource = 'The following questions compare useful branches and uncertain continuations.\n\n' +
  '- Does this choice change the final success rate?\n' +
  '- Do the candidates lead to distinct valid programs?\n' +
  '- Does uncertainty come from useful alternatives?\n\n';
const beforeList = 'Estimate candidate values and construct a local advantage before choosing a prior.\n\n' +
  '\\[\n\\widehat Q(s,a)=\\mathbb E[R\\mid s,a].\n\\]\n\n' +
  '\\[\n\\widehat A(s,a)=\\widehat Q(s,a)\n- \\sum_u w(u\\mid s)\\widehat Q(s,u).\n\\]\n\n';
const structuredSource = introduction + tableSource + beforeList + listSource + excerpt + ending;
const structuredSession = { ...session, assistant: [structuredSource] };
const structuredRequest = { ...request, text: tui(beforeList + listSource.replace(/^- /gm, '• ') + excerpt + ending),
  leadingContext: leadingContext + tableContext };

test('realistic historical table rules and rendered lists preserve all four visible SSD formulas', () => {
  const result = new NativeAnalyzer().analyze(structuredRequest, [structuredSession]);
  assert.equal(result.state, 'matched'); assert.equal(result.formulas.length, 4); assert.equal(result.skipped, 0);
  assert.equal(result.sourceRanges[0]!.startRow, 0);
  // The minus with a following space inside display math must stay exact TeX.
  const literal = { ...structuredRequest, text: tui(beforeList + listSource + excerpt + ending) };
  assert.equal(new NativeAnalyzer().analyze(literal, [structuredSession]).formulas.length, 4);
});

test('rendered list support still rejects changed list text, TeX minus, roles and duplicate sessions', () => {
  const analyzer = new NativeAnalyzer();
  for (const input of [
    { ...structuredRequest, text: structuredRequest.text.replace('final success rate', 'unrelated criterion') },
    { ...structuredRequest, text: structuredRequest.text.replace('- \\sum_u', '• \\sum_u') },
    { ...structuredRequest, leadingContext: '› user copied this answer\r\n  ' + tableContext },
    { ...structuredRequest, leadingContext: leadingContext + tableContext + '  Worked for 3s\r\n' },
  ]) assert.equal(analyzer.analyze(input, [structuredSession]).formulas.length, 0);
  assert.equal(analyzer.analyze(structuredRequest, [structuredSession, { ...structuredSession, id: 'copy' }]).state, 'ambiguous');
});

test('list conversion preserves fenced and indented code while other display formulas render', () => {
  for (const code of ['\n\n```text\n- literal code item\n```\n', '\n\n    - literal code item\n']) {
    const source = beforeList + listSource + code;
    const input = { ...request, leadingContext: '', text: '• ' +
      (beforeList + listSource.replace(/^- /gm, '• ') + code).replaceAll('\n', '\r\n  ') + '\r\n  Worked for 1s' };
    const session = { ...structuredSession, assistant: [source] };
    const analyzer = new NativeAnalyzer();
    assert.equal(analyzer.analyze(input, [session]).formulas.length, 2);
    assert.equal(analyzer.analyze({ ...input, text: input.text.replace('- literal code item', '• literal code item') }, [session]).formulas.length, 0);
  }
});

const massTableSource = '| Term | Meaning |\n|---|---|\n| Conditional entropy | Explore useful branches |\n' +
  '| \\(\\log M_\\theta\\) | Keep probability in the trusted set |\n\n';
const massTableDisplay = 'Term                   Meaning\n━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
  'Conditional entropy    Explore useful branches\n─────────────────────  ──────────────────────────────────────\n' +
  'log M_{θ}              Keep probability in the trusted set\n\n';
const nativeSource = 'The temperature depends on the current prefix.\n\\[\nT(s)=T_L+(T_F-T_L)g(s),\n\\]\n\n';
const nativeDisplay = 'The temperature depends on the current prefix.\nT(s)=T_{L}+(T_{F}-T_{L})g(s),\n\n';
// Interleave a formula Codex converted to Unicode with blocks still shown as TeX.
const firstEnd = beforeList.indexOf('\\]') + 2;
const mixedSource = introduction + massTableSource + beforeList.slice(0, firstEnd) + '\n\n' + nativeSource +
  beforeList.slice(firstEnd) + listSource + excerpt + ending;
const mixedDisplay = massTableDisplay + beforeList.slice(0, firstEnd) + '\n\n' + nativeDisplay +
  beforeList.slice(firstEnd) + listSource.replace(/^- /gm, '• ') + excerpt + ending;
const mixedSession = { ...session, assistant: [mixedSource] };

test('visible table tails and native character formulas do not remove neighboring display images while scrolling', () => {
  const lines = mixedDisplay.split('\n'), analyzer = new NativeAnalyzer();
  for (const inlineMath of [false, true]) for (let row = 0; row <= 6; row++) {
    const input = { ...request, inlineMath, text: tui(lines.slice(row).join('\n')),
      leadingContext: leadingContext + tui(lines.slice(0, row).join('\n')) + '\r\n' };
    let result = analyzer.analyze(input, [mixedSession]);
    for (let retry = 0; result.pendingRender && retry < 10; retry++) result = analyzer.analyze(input, [mixedSession]);
    assert.equal(result.state, 'matched', 'viewport starts at table row ' + row);
    assert.equal(result.formulas.length, inlineMath ? 5 : 4, 'viewport table row ' + row); assert.equal(result.skipped, 0);
    const text = lines.slice(row).join('\n');
    const nativeRow = text.slice(0, text.indexOf('T(s)=T_{L}')).split('\n').length - 1;
    // The compact display may use the empty paragraph row immediately below it.
    assert.equal(text.split('\n')[nativeRow + 1], '');
    const expected = [...findDisplayMath(text).map(block =>
      [text.slice(0, block.start).split('\n').length - 1, text.slice(0, block.end).split('\n').length - 1]),
      ...(inlineMath ? [[nativeRow, nativeRow + 1]] : [])].sort((a, b) => a[0]! - b[0]!);
    assert.deepEqual(result.formulas.map(block => [block.startRow, block.endRow]), expected);
  }
});

test('table and native math equivalence still verifies every cell, operator, role and unique session', () => {
  const analyzer = new NativeAnalyzer(), input = { ...request, text: tui(mixedDisplay) };
  for (const text of [
    input.text.replace('Keep probability in the trusted set', 'Keep probability in another set'),
    input.text.replace('T_{F}-T_{L}', 'T_{F}+T_{L}'),
    input.text.replace('Explore useful branches', 'Explore arbitrary branches'),
    input.text.replace('\\max_q', '\\min_q'),
  ]) assert.equal(analyzer.analyze({ ...input, text }, [mixedSession]).formulas.length, 0);
  for (const leadingContext of ['› A user copied the answer\r\n', '• Ran a command\r\n', ''])
    assert.equal(analyzer.analyze({ ...input, leadingContext }, [mixedSession]).formulas.length, 0);
  assert.equal(analyzer.analyze(input, [mixedSession, { ...mixedSession, id: 'duplicate' }]).state, 'ambiguous');
});

test('table conversions preserve fenced and indented code tables', () => {
  for (const code of ['```text\n' + massTableSource + '```\n', massTableSource.split('\n').map(line => '    ' + line).join('\n')]) {
    const source = 'A complete answer retains its literal code sample.\n\n' + code + '\n' + excerpt;
    const input = { ...request, leadingContext: '', text: '• ' + source.replaceAll('\n', '\r\n  ') + '\r\n  Worked for 1s' };
    const sessions = [{ ...session, assistant: [source] }], analyzer = new NativeAnalyzer();
    assert.equal(analyzer.analyze(input, sessions).formulas.length, 2);
    assert.equal(analyzer.analyze({ ...input, text: input.text.replace('| Term | Meaning |', 'Term Meaning') }, sessions).formulas.length, 0);
  }
});
