import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDisplayMath } from '../packages/core/src/display-math.js';
import { MathRenderer } from '../packages/core/src/renderer.js';

test('display blocks: complete, repeated and mixed delimiters', () => {
  const source = 'Before\n\\[\nx^2\n\\]\n$$y$$\n$$\nx^2\n$$\nAfter';
  const found = findDisplayMath(source);
  assert.deepEqual(found.map(x => x.tex), ['x^2', 'y', 'x^2']);
  assert.equal(source.slice(found[0]!.start, found[0]!.end), '\\[\nx^2\n\\]');
});

test('incomplete, inline and fenced expressions remain source', () => {
  const source = 'Inline $x$ and \\(y\\)\n```tex\n\\[\nx\n\\]\n```\n~~~\n$$y$$\n~~~\n\\[\nz';
  assert.deepEqual(findDisplayMath(source), []);
  assert.deepEqual(findDisplayMath('    \\[\n    code\n    \\]'), []);
});

test('bounded local SVG supports expectation, KL, fractions and matrices', () => {
  const renderer = new MathRenderer();
  for (const tex of [String.raw`\max_q\{\mathbb E_{a\sim q}[\widehat Q(s,a)]-\eta\,\mathrm{KL}(q\|q_{\mathrm{prior}})\}`,
    String.raw`\frac{a+b}{c}`, String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`]) {
    const result = renderer.render(tex);
    assert.ok(result.width > 0 && result.height > 0);
    assert.match(result.svg, /<path/);
    assert.doesNotMatch(result.svg, /<script|foreignObject|href=|src=/);
  }
  for (const tex of [String.raw`\href{https://example.com}{x}`, String.raw`\require{html}`,
    String.raw`\def\foo{evil}\foo`, String.raw`\unknowncommand`, 'x'.repeat(8193)]) {
    assert.throws(() => renderer.render(tex));
  }
  assert.ok(renderer.render('x^2').svg);
});
