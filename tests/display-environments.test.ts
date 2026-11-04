import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resvg } from '@resvg/resvg-js';
import { findDisplayMath } from '../packages/core/src/display-math.js';
import { MathRenderer } from '../packages/core/src/renderer.js';
import { NativeAnalyzer, matchVisibleText } from '../packages/windows-companion/src/analyzer.js';

const names = ['equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'flalign', 'flalign*',
  'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'eqnarray*', 'displaymath'];
const formula = (name = 'equation', body = String.raw`\frac{a+b}{c}=x`) =>
  `\\begin{${name}}${name.startsWith('alignat') ? '{2}' : ''}\n${body}\n\\end{${name}}`;
const context = 'This independently verified derivation includes 中文, e\u0301 and 🧮.';
const session = (source: string, id = 'environments') => ({ id, cwd: 'D:/fixture', file: id, assistant: [source] });
const tui = (source: string) => '• ' + source.replaceAll('\n', '\r\n  ') + '\r\n  Worked for 6s • 02:31\r\n› input';

test('all explicit display environments have exact row bounds and render to offline PNG', () => {
  const renderer = new MathRenderer();
  for (const name of names) {
    const body = name.startsWith('eqnarray') ? 'x&=&y' : name.startsWith('alignat') ? 'x&=y&z&=w' :
      /^(?:align|flalign)/.test(name) ? 'x&=y' : 'x=y';
    const tex = formula(name, body);
    for (const block of [tex, tex.replaceAll('\n', '')]) {
      const source = context + '\n\n' + block + '\nFinished.';
      assert.deepEqual(findDisplayMath(source), [{ tex: block, start: context.length + 2, end: context.length + 2 + block.length }], name);
      const rendered = renderer.render(block);
      assert.ok(rendered.width > 0 && rendered.height > 0, name);
      assert.doesNotMatch(rendered.svg, /mjx-merror|<script|foreignObject|href=|src=/);
      assert.equal(new Resvg(rendered.svg).render().asPng().subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(matchVisibleText(tui(source), [session(source)]).regions.length, 1, name);
    }
  }
});

test('inner environments require a display wrapper and preserve nested structures', () => {
  const renderer = new MathRenderer();
  for (const [name, body] of [['aligned', 'x&=y\\\\z&=w'], ['split', 'x&=y\\\\&=z'],
    ['gathered', 'x=y\\\\z=w'], ['cases', '1&x>0\\\\0&x\\le0'], ['pmatrix', '1&2\\\\3&4']]) {
    const inner = `\\begin{${name}}${body}\\end{${name}}`;
    assert.deepEqual(findDisplayMath(inner), []);
    const tex = formula('equation', inner);
    assert.equal(findDisplayMath(tex)[0]!.tex, tex);
    assert.ok(renderer.render(tex).svg);
  }
  const aligned = formula('align*', 'f(x)&=\\begin{cases}x&x>0\\\\0&x\\le0\\end{cases}\\\\\ng(x)&=x^2');
  assert.equal(findDisplayMath(aligned)[0]!.tex, aligned);
  assert.ok(renderer.render(aligned).svg);
});

test('display parsing preserves mathematical operators rather than interpreting them as Markdown', () => {
  for (const body of ['a\n- b', 'a\n> b', 'a\n> > b', 'x\n  - y', '\\begin{aligned}\nx&=y\\\\\n&>z\n\\end{aligned}']) {
    const tex = formula('equation', body);
    assert.equal(findDisplayMath(tex)[0]!.tex, tex, body);
    assert.equal(findDisplayMath('\\[\n' + body + '\n\\]')[0]!.tex, body, body);
  }
});

test('lists, nested lists and blockquotes retain formula context and code boundaries', () => {
  const tex = formula('align*', 'x&=y\\\\\nz&=w');
  for (const [prefix, continuation] of [['> ', '> '], ['> > ', '> > '], ['- ', '  '], ['1. ', '   '],
    ['- > ', '  > '], ['> - ', '>   '], ['- Outer item\n  - ', '    '], ['- Item\n\n  ', '  ']]) {
    const source = context + '\n\n' + prefix + tex.replaceAll('\n', '\n' + continuation) + '\n\nFinished.';
    const found = findDisplayMath(source);
    assert.equal(found.length, 1, prefix);
    assert.equal(found[0]!.tex, tex, prefix);
    assert.equal(matchVisibleText(tui(source), [session(source)]).regions.length, 1, prefix);
  }
  for (const code of ['`' + tex.replaceAll('\n', ' ') + '`', '``literal `\n' + tex + '\n``',
    '```latex\n' + tex + '\n```', '~~~~tex\n' + tex + '\n~~~~', '    ' + tex.replaceAll('\n', '\n    '),
    '> ```latex\n> ' + tex.replaceAll('\n', '\n> ') + '\n> ```',
    '- Example\n\n  ```tex\n  ' + tex.replaceAll('\n', '\n  ') + '\n  ```',
    '- Example\n\n      ' + tex.replaceAll('\n', '\n      ')]) {
    const source = context + '\n\n' + code + '\n\nA real formula follows the literal example.\n' + tex;
    assert.equal(findDisplayMath(code).length, 0, code);
    assert.equal(findDisplayMath(source).length, 1, code);
    assert.equal(matchVisibleText(tui(source), [session(source)]).regions.length, 1, code);
  }
});

test('a block cannot close across list items or quote boundaries, or erase same-row prose', () => {
  for (const source of ['- \\begin{equation}\n  x=y\n- \\end{equation}',
    '> \\begin{equation}\n> x=y\n\\end{equation}',
    '\\begin{equation}\nx=y\n\\end{equation} unrelated prose',
    'Explanation: ' + formula().replaceAll('\n', ''), formula().replaceAll('\n', '') + ' explanation',
    '\\\\begin{equation}\nx=y\n\\end{equation}', String.raw`\begin{unknown}x=y\end{unknown}`])
    assert.deepEqual(findDisplayMath(source), [], source);
});

test('comments, escaped literals, nested closures and malformed blocks recover conservatively', () => {
  const valid = formula('equation*');
  for (const body of [String.raw`x=y % \end{equation}`, String.raw`x=\%y`,
    String.raw`x=\\% \end{equation}`, String.raw`\begin{aligned}x&=y\\\end{aligned}`]) {
    const tex = formula('equation', body);
    assert.equal(findDisplayMath(tex)[0]!.tex, tex, body);
  }
  const commented = formula().replace('\\end{equation}', '\\end{equation} % a trailing comment');
  assert.equal(findDisplayMath(commented)[0]!.tex, commented);
  for (const broken of ['\\begin{align}\nx&=y\n\\end{equation}',
    '\\begin{equation}\n\\begin{cases}x&y\n\\end{equation}',
    '\\begin{equation}\nunfinished', '\\begin{equation}\n' + 'x\n'.repeat(105),
    '\\begin{equation}\n' + 'x'.repeat(8193) + '\n\\end{equation}']) {
    assert.deepEqual(findDisplayMath(broken + '\n\n' + valid).map(x => x.tex), [valid], broken.slice(0, 70));
  }
  assert.deepEqual(findDisplayMath('% ' + valid.replaceAll('\n', '')), []);
});

test('streaming environments wait for complete closure without destabilizing earlier blocks', () => {
  const first = formula('equation*'), second = formula('alignat*', 'x&=y&z&=w');
  const prefix = context + '\n' + first + '\nThe next formula is independently verified.\n';
  for (let end = 0; end <= second.length; end++) {
    const text = prefix + second.slice(0, end), expected = end === second.length ? 2 : 1;
    const result = matchVisibleText('• ' + text.replaceAll('\n', '\r\n  '), [session(prefix + second)]);
    assert.equal(result.regions.length, expected, 'stream offset ' + end);
  }
  const full = tui(prefix + second);
  assert.equal(matchVisibleText(full.replace('a+b', 'a-b'), [session(prefix + second)]).regions.length, 0);
  assert.equal(matchVisibleText(full, [session(prefix + second), session(prefix + second, 'other')]).state, 'ambiguous');
  assert.equal(matchVisibleText(full.replace('• ', '› '), [session(prefix + second)]).regions.length, 0);
});

test('actual Codex Markdown escapes in bare environments preserve canonical TeX and code protection', () => {
  const tex = formula('align*', 'x&=y\\\\\nz&=\\{w\\}');
  const shown = formula('align*', 'x&=y\\\nz&={w}');
  for (const [prefix, continuation] of [['', ''], ['- Context\n\n  ', '  '], ['> ', '> ']]) {
    const source = context + '\n\n' + prefix + tex.replaceAll('\n', '\n' + continuation) + '\nFinished.';
    const displayed = source.replace(tex.replaceAll('\n', '\n' + continuation), shown.replaceAll('\n', '\n' + continuation));
    const result = matchVisibleText(tui(displayed), [session(source)]);
    assert.equal(result.regions.length, 1, prefix);
    assert.equal(result.regions[0]!.tex, tex, 'render original row breaks and escaped braces, not displayed Markdown');
    assert.equal(matchVisibleText(tui(displayed.replace('x&=y', 'x&=-y')), [session(source)]).regions.length, 0);
    assert.equal(matchVisibleText(tui(displayed), [session(source), session(source, 'duplicate')]).state, 'ambiguous');
  }
  const code = '```tex\n' + tex + '\n```';
  const source = context + '\n' + code + '\nA real environment follows the literal example.\n' + tex;
  const displayed = source.replace('```tex\n', '').replace('\n```', '').replaceAll(tex, shown);
  assert.equal(matchVisibleText(tui(displayed), [session(source)]).regions.length, 0, 'code body cannot borrow Markdown unescaping');
  const valid = source.replace('```tex\n', '').replace('\n```', '');
  const visible = valid.slice(0, valid.lastIndexOf(tex)) + shown;
  const result = matchVisibleText(tui(visible), [session(source)]);
  assert.equal(result.regions.length, 1, 'the duplicate code occurrence remains protected when its fence is hidden');
  assert.equal(result.regions[0]!.tex, tex);
});

test('real PPO environment retains scripts when Codex consumes underscore emphasis in its display', () => {
  const original = String.raw`L^{\mathrm{CLIP}}(\theta)=\widehat{\mathbb E}_t\!\left[\min\!\left(r_t(\theta)\widehat A_t,\operatorname{clip}\!\left(r_t(\theta),1-\epsilon,1+\epsilon\right)\widehat A_t\right)\right],\qquad r_t(\theta)=\frac{\pi_\theta(a_t\mid s_t)}{\pi_{\theta_{\mathrm{old}}}(a_t\mid s_t)}.`;
  const displayed = String.raw`L^{\mathrm{CLIP}}(\theta)=\widehat{\mathbb E}t!\left[\min!\left(r_t(\theta)\widehat A_t,\operatorname{clip}!\left(r_t(\theta),1-\epsilon,1+\epsilon\right)\widehat A_t\right)\right],\qquad r_t(\theta)=\frac{\pi\theta(a_t\mid s_t)}{\pi_{\theta_{\mathrm{old}}}(a_t\mid s_t)}.`;
  const tex = formula('equation*', original), shown = formula('equation*', displayed);
  for (const prefix of ['', '> ']) {
    const block = prefix + tex.replaceAll('\n', '\n' + prefix);
    const source = context + '\n\n' + block + '\nFinished.';
    const visible = source.replace(block, prefix + shown.replaceAll('\n', '\n' + prefix));
    const result = matchVisibleText(tui(visible), [session(source)]);
    assert.deepEqual(result.regions.map(x => x.tex), [tex]);
    assert.equal(matchVisibleText(tui(visible.replace('1-\\epsilon', '2-\\epsilon')), [session(source)]).regions.length, 0);
    assert.equal(matchVisibleText(tui(visible), [session(source), session(visible, 'other-source')]).state, 'ambiguous');
  }
  const source = context + '\n' + tex;
  const result = new NativeAnalyzer().analyze({ type: 'analyze', id: 1, text: tui(context + '\n' + shown),
    rowHeight: 28, width: 2000, foreground: '#cccccc', background: '#0c0c0c' }, [session(source)]);
  assert.equal(result.formulas.length, 1); assert.equal(result.skipped, 0);
});

test('context and physical rows survive every viewport position across mixed display formats', () => {
  const blocks = [formula('equation*'), '\\[\nx^2+y^2=z^2\n\\]', '$$\nx=y\n$$',
    formula('align*', 'x&=y\\\\\nz&=w'), formula('equation*')];
  const sections = blocks.map((block, i) => `Section ${i}: ${context}\n\n` + block +
    '\n\nThe derivation continues with independently verified surrounding prose.');
  const source = sections.join('\n\n'), lines = source.split('\n');
  // Expected ranges are assembled from the fixture, independently of the parser.
  let row = 0;
  const bounds = blocks.map((block, i) => {
    const start = row + 2, end = start + block.split('\n').length - 1;
    row += sections[i]!.split('\n').length + 1;
    return { start, end, tex: block.startsWith('\\begin') ? block : block.split('\n')[1]! };
  });
  let checked = 0;
  for (const height of [6, 14, 23]) for (let top = 0; top < lines.length; top++) {
    const expected = bounds.filter(bound => bound.start >= top && bound.end < top + height);
    const visible = lines.slice(top, top + height).join('\r\n  ');
    const text = (top ? '  ' : '• ') + visible;
    const leading = top ? '• ' + lines.slice(0, top).join('\r\n  ') + '\r\n' : '';
    const result = matchVisibleText(text, [session(source)], leading);
    assert.deepEqual(result.regions.map(x => ({ start: x.startRow + top, end: x.endRow + top, tex: x.tex })),
      expected, `top=${top},height=${height}`);
    checked++;
  }
  assert.ok(checked > 100);
});

test('context sweep combines styles, link labels, quotes, lists, escaped row breaks and duplicate code', () => {
  const tex = formula('align*', 'x&=y\\\\\nz&=w');
  const shown = formula('align*', 'x&=y\\\nz&=w');
  const code = '> ```tex\n> ' + tex.replaceAll('\n', '\n> ') + '\n> ```';
  const quoted = '> ' + tex.replaceAll('\n', '\n> ');
  const source = '# A verified heading\n\n' + context + '\n\n' + code +
    '\n\n**A real quoted derivation follows the code example.**\n\n' + quoted +
    '\n\n- A listed derivation continues with exact surrounding prose.\n\n  ' + tex.replaceAll('\n', '\n  ') +
    '\n\nRead [the original paper](https://example.org/paper) for the assumptions.\n\n' + tex +
    '\n\nThis concludes the independently verified discussion.';
  const styled = source.replace('# A verified heading', 'A verified heading')
    .replace('**A real quoted derivation follows the code example.**', 'A real quoted derivation follows the code example.')
    .replace('- A listed derivation', '• A listed derivation')
    .replace('[the original paper](https://example.org/paper)', 'the original paper')
    .replace('  ' + tex.replaceAll('\n', '\n  '), '  ' + shown.replaceAll('\n', '\n  '));
  const quoteAt = styled.lastIndexOf(quoted);
  const displayed = styled.slice(0, quoteAt) + '> ' + shown.replaceAll('\n', '\n> ') + styled.slice(quoteAt + quoted.length);
  const last = displayed.lastIndexOf(tex);
  const final = displayed.slice(0, last) + shown + displayed.slice(last + tex.length);
  const lines = final.split('\n');
  const bounds = [source.lastIndexOf(quoted), source.indexOf('  \\begin{'), source.lastIndexOf(tex)].map(start => ({
    start: source.slice(0, start).split('\n').length - 1,
    end: source.slice(0, start).split('\n').length + 2, tex,
  }));
  for (const height of [7, 14, 25]) for (let top = 0; top < lines.length; top++) {
    const text = (top ? '  ' : '• ') + lines.slice(top, top + height).join('\r\n  ');
    const leading = top ? '• ' + lines.slice(0, top).join('\r\n  ') + '\r\n' : '';
    const result = matchVisibleText(text, [session(source)], leading);
    assert.deepEqual(result.regions.map(region => ({ start: region.startRow + top, end: region.endRow + top, tex: region.tex })),
      bounds.filter(bound => bound.start >= top && bound.end < top + height), `top=${top},height=${height}`);
  }
});

test('unsupported TeX is isolated and cached environment images remain stable during the next answer', () => {
  const good = formula('align*', 'x&=y\\\\\nz&=w');
  const bad = formula('equation', '\\unknowncommand');
  const source = context + '\n' + bad + '\nA separate correct derivation follows.\n' + good;
  const analyzer = new NativeAnalyzer();
  const request = { type: 'analyze' as const, id: 1, text: tui(source), rowHeight: 28,
    width: 1500, foreground: '#cccccc', background: '#0c0c0c' };
  const first = analyzer.analyze(request, [session(source)]);
  assert.equal(first.formulas.length, 1); assert.equal(first.skipped, 1);
  const next = analyzer.analyze({ ...request, id: 2, text: request.text + '\r\n• Working (1s • esc to interrupt)' }, [session(source)]);
  assert.equal(next.formulas[0]!.imageId, first.formulas[0]!.imageId);
  assert.equal(next.metrics.imageHits, 1); assert.equal(next.metrics.imageMisses, 0);
  assert.equal(next.skipped, 1); // unsupported TeX has a bounded negative cache; the valid image stays cached
});
