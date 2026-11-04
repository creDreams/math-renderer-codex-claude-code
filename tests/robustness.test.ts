import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findDisplayMath } from '../packages/core/src/display-math.js';
import { assistantTextMatches } from '../packages/adapter-codex/src/inline-math.js';
import { SessionStore } from '../packages/adapter-codex/src/sessions.js';
import { NativeAnalyzer, matchVisibleText } from '../packages/windows-companion/src/analyzer.js';

const session = (source: string, id = 'robustness') => ({ id, cwd: 'D:/fixture', file: id, assistant: [source] });
const tui = (source: string) => '• ' + source.replaceAll('\n', '\r\n  ') + '\r\n  Worked for 1m 2s\r\n› input';
const context = 'This verified discussion explains how the mathematical objective is constructed.';
const block = '\\[\n\\frac{a+b}{c}=x\n\\]';
const request = (text: string) => ({ type: 'analyze' as const, id: 1, text, rowHeight: 28,
  width: 1500, foreground: '#cccccc', background: '#0c0c0c' });

test('abandoned, oversized and malformed blocks recover at the next complete formula', () => {
  for (const broken of ['\\[\nunfinished\n', '\\[\n' + 'x\n'.repeat(102), '\\[\n' + 'x'.repeat(8193) + '\n\\]\n']) {
    assert.deepEqual(findDisplayMath(broken + block).map(x => x.tex), ['\\frac{a+b}{c}=x']);
  }
  assert.equal(findDisplayMath('\\[\nunfinished\n$$\ny^2\n$$')[0]!.tex, 'y^2');
  for (const fence of ['```', '~~~~', '   ```'])
    assert.equal(findDisplayMath(fence + '\r\n' + block + '\n' + fence + '\n' + block).length, 1);
});

test('Markdown presentation preserves literal code, display math and inline math', () => {
  const code = '~~~text\n# literal heading\n**literal code**\n\\(\\epsilon\\)\n~~~\n# Following heading\n\n' +
    '    **indented literal**\n\nA `**literal span**` and \\(\\text{**literal math**}\\) stay literal.\n';
  const source = '# A verified heading\n**A clear explanation.**\n' + context + '\n' + code + block + '\nFinished.';
  const display = source.replace('# A verified heading', 'A verified heading').replace('# Following heading', 'Following heading')
    .replace('**A clear explanation.**', 'A clear explanation.');
  const match = (value: string) => matchVisibleText(tui(value), [session(source)]).regions.length;
  assert.equal(match(display), 1);
  assert.equal(match(source), 1, 'literal Markdown is also a valid display');
  for (const [from, to] of [['# literal heading', 'literal heading'], ['**literal code**', 'literal code'],
    ['**indented literal**', 'indented literal'], ['**literal span**', 'literal span'],
    ['**literal math**', 'literal math'], ['\\(\\epsilon\\)', 'ϵ']])
    assert.equal(match(display.replace(from!, to!)), 0, 'literal content changed: ' + from);
});

test('native inline alternatives never convert tilde, indented or multi-backtick code', () => {
  for (const code of ['~~~tex\n\\(\\epsilon\\)\n~~~', '    \\(\\epsilon\\)',
    '`` literal ` \\(\\epsilon\\) ``', '`multi-line\n\\(\\epsilon\\)`']) {
    const source = context + '\n' + code;
    assert.ok(assistantTextMatches(source, source));
    assert.ok(!assistantTextMatches(source, source.replace('\\(\\epsilon\\)', 'ϵ')), code);
  }
});

test('ordinary prose starting with completion-label words is not a footer', () => {
  for (const prose of ['Worked for years on policy optimization, this method is now fully explained.',
    '工作了很久之后，我们解释这个优化目标的数学形式。', '已工作模块的目标函数需要在这里进一步说明。']) {
    const source = context + '\n' + prose + '\n' + block + '\nFinished.';
    assert.equal(matchVisibleText(tui(source), [session(source)]).regions.length, 1);
  }
});

test('actual Codex completion timestamps terminate each assistant answer without becoming prose', () => {
  const source = context + '\n' + block + '\nFinished.';
  for (const footer of ['Worked for 6s • 02:31', 'Worked for 1m 2s • 23:59:01 ───', '工作了 6 秒 • 02:31',
    'Worked for 1m 56s • Nov 2 at 16:41', 'Worked for 6s • Jan 31, 2026 at 00:01']) {
    const screen = tui(source).replace('Worked for 1m 2s', footer);
    assert.equal(matchVisibleText(screen, [session(source)]).regions.length, 1, footer);
    assert.equal(matchVisibleText(screen + '\r\n' + screen, [session(source)]).regions.length, 2, footer);
  }
  for (const footer of ['Worked for 6s • 32:99', 'Worked for 6s • some other explanation', 'Worked for 6s • Nov 32 at 16:41'])
    assert.equal(matchVisibleText(tui(source).replace('Worked for 1m 2s', footer), [session(source)]).regions.length, 0);
});

test('a row-by-row viewport sweep preserves complete formulas, duplicates and exact source bounds', () => {
  const sections = Array.from({ length: 8 }, (_, i) =>
    `Section ${i}: ${context}\nThe Unicode context includes 中文, e\u0301 and 🧮.\n\n` +
    (i % 2 ? block : '\\[\n\\sum_{i=1}^{n}x_i<\\eta\n\\]') +
    '\n\nThe explanation continues with carefully verified surrounding prose.\n');
  const source = 'A uniquely identified mathematical discussion.\n\n' + sections.join('\n');
  const lines = source.split('\n');
  let checked = 0;
  for (const height of [14, 23, 41]) for (let top = 0; top < lines.length - 5; top++) {
    const visible = lines.slice(top, top + height).join('\n');
    const expected = findDisplayMath(visible);
    if (!expected.length) continue;
    const rows = (values: string[]) => values.map(line => line ? '  ' + line : '').join('\r\n');
    const text = top === 0 ? '• ' + visible.replaceAll('\n', '\r\n  ') : rows(lines.slice(top, top + height));
    const leading = top ? '• ' + lines.slice(0, top).join('\r\n  ') + '\r\n' : '';
    const match = matchVisibleText(text, [session(source)], leading);
    assert.equal(match.state, 'matched', `top=${top}, height=${height}`);
    assert.deepEqual(match.regions.map(x => x.tex), expected.map(x => x.tex), `top=${top}, height=${height}`);
    for (const region of match.regions) {
      assert.ok(text.split(/\r?\n/)[region.startRow]!.includes('\\['));
      assert.ok(text.split(/\r?\n/)[region.endRow]!.includes('\\]'));
    }
    checked++;
  }
  assert.ok(checked > 200);
});

test('streaming prefixes render only closed blocks and reject later source edits or ambiguous sessions', () => {
  const source = context + '\n\n' + block + '\n\nAnother contextual explanation of the second equation.\n' + block + '\nDone.';
  for (let end = 1; end <= source.length; end++) {
    const prefix = source.slice(0, end);
    const match = matchVisibleText('• ' + prefix.replaceAll('\n', '\r\n  '), [session(source)]);
    assert.equal(match.regions.length, findDisplayMath(prefix).length, 'stream position ' + end);
  }
  const full = tui(source);
  assert.equal(matchVisibleText(full.replace('a+b', 'a-b'), [session(source)]).regions.length, 0);
  assert.equal(matchVisibleText(full, [session(source), session(source, 'another')]).state, 'ambiguous');
});

test('bad TeX is isolated and subsequent valid formulas and snapshots still render', () => {
  const analyzer = new NativeAnalyzer();
  for (const bad of ['\\unknowncommand', '\\frac{', '\\href{https://example.com}{x}', '\\begin{matrix}1&2']) {
    const source = context + '\n\\[\n' + bad + '\n\\]\n\n' + block + '\nDone.';
    const result = analyzer.analyze(request(tui(source)), [session(source)]);
    assert.equal(result.formulas.length, 1, bad); assert.equal(result.skipped, 1);
    assert.ok(result.formulas[0]!.startRow > 3);
  }
  assert.throws(() => analyzer.analyze({ ...request(tui(context + '\n' + block)), width: NaN }, []));
  const source = context + '\n' + block;
  assert.equal(analyzer.analyze(request(tui(source)), [session(source)]).formulas.length, 1);
});

test('session discovery tolerates incomplete writes, file replacement and bounded large logs', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const home = await mkdtemp(path.join(os.tmpdir(), 'amt-robust-'));
  const dir = path.join(home, 'sessions/2026/11/03');
  const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'large-log', cwd: 'D:/fixture' } }) + '\n';
  const record = (text: string) => JSON.stringify({ type: 'response_item', payload: {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
  try {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'rollout-fixture.jsonl'), store = new SessionStore(home);
    const last = record(context + '\n' + block);
    await writeFile(file, meta + last.slice(0, -5));
    assert.deepEqual((await store.refresh())[0]!.assistant, []);
    await appendFile(file, last.slice(-5) + '\n'); t.mock.timers.tick(1600);
    assert.deepEqual((await store.refresh())[0]!.assistant, [context + '\n' + block]);
    // Large discarded tool records cross the tail-read boundary, including UTF-8.
    await writeFile(file, meta + JSON.stringify({ type: 'tool', payload: '中'.repeat(1500000) }) + '\n' + last + '\n');
    t.mock.timers.tick(1600);
    assert.deepEqual((await store.refresh())[0]!.assistant, [context + '\n' + block]);
    await writeFile(file, meta + record('replacement assistant') + '\n'); t.mock.timers.tick(1600);
    assert.deepEqual((await store.refresh())[0]!.assistant, ['replacement assistant']);
    await rm(file); t.mock.timers.tick(1600);
    assert.deepEqual(await store.refresh(), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});
