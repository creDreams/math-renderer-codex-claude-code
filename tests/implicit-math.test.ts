import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInlineMath } from '../packages/core/src/implicit-math.js';
import { MathRenderer } from '../packages/core/src/renderer.js';

const examples = [
  ['损失定义为 L(θ) = αL₁(θ) + βL₂(θ)，其中 α 和 β 为权重。', 'L(θ) = αL₁(θ) + βL₂(θ)'],
  ['圆的公式 x² + y² = r²，后文保持可读。', 'x² + y² = r²'],
  ['The formula f(x) = x^2 + 1 is differentiable.', 'f(x) = x^2 + 1'],
  ['更新为 θ_{t+1} = θ_t − α∇J(θ_t)，然后继续。', 'θ_{t+1} = θ_t − α∇J(θ_t)'],
  ['优势 Âₜ = Qₜ − Vₜ，后文。', 'Âₜ = Qₜ − Vₜ'],
  ['优势 Âₜ = Qₜ − Vₜ，后文。', 'Âₜ = Qₜ − Vₜ'],
  ['公式 𝑥² + 𝑦² = 𝑟²，后文。', '𝑥² + 𝑦² = 𝑟²'],
  [String.raw`使用 \frac{a+b}{c} 作为比例。`, String.raw`\frac{a+b}{c}`],
  ['L_total(θ) = E_t[L_CLIP(θ) - c₁L_VF(θ) + c₂S[π_θ](s_t)]',
    'L_total(θ) = E_t[L_CLIP(θ) - c₁L_VF(θ) + c₂S[π_θ](s_t)]'],
];
test('unmarked grammar finds whole spans and keeps exact UTF-16 boundaries', () => {
  const renderer = new MathRenderer();
  for (const [text, raw] of examples) {
    const spans = findInlineMath(text!);
    assert.equal(spans.length, 1, text);
    assert.equal(spans[0]!.raw, raw, text);
    assert.equal(text!.slice(spans[0]!.start, spans[0]!.end), raw);
    assert.ok(renderer.render(spans[0]!.tex).svg, text);
  }
});

test('explicit inline delimiters, code scopes and display scopes stay distinct', () => {
  const text = String.raw`前文 \(\frac{a}{b}\) 和 $x^2$，代码 
` + '`x² + y² = r²`\n```text\nx² + y² = r²\n```\n\n\\[\nx² + y² = r²\n\\]';
  assert.deepEqual(findInlineMath(text).map(x => x.raw), [String.raw`\(\frac{a}{b}\)`, '$x^2$']);
});

test('inline SVG includes all operands and operators instead of only the first break segment', () => {
  const renderer = new MathRenderer();
  const image = renderer.render('x^2+y^2=r^2', false);
  for (const glyph of ['1D465', '1D466', '1D45F', '2B', '3D'])
    assert.ok(image.svg.includes(`data-c="${glyph}"`), 'complete equation contains glyph ' + glyph);
  assert.ok(image.width > 60, 'full equation is wider than its first operand');
  const end = renderer.render('x^2+y^2=z^3', false);
  assert.notEqual(end.svg, image.svg, 'changing the final operand changes the actual SVG');
});

test('plain identifiers, commands, paths, currencies and malformed tails abstain', () => {
  const negatives = ['x=1', 'θ', 'beta version', 'timeout=30', 'L_total=1', '版本 v1.2.3', '2026-11-03',
    '$20,000 and $30,000', '$2.50 for the first and $2.00 each', 'https://example.com/x²+y²=r²',
    String.raw`D:\math\x²+y²=r².txt`, 'src/main.py', 'user@example.com', 'PS D:\repo> x=1',
    'const x = α * y + β;', 'return x² + y² = r²', 'max_steps: 100', 'x² == y² + r²',
    'x² + y² =', 'x² + unknown + y² = r²', String.raw`\unknown{x²+y²=r²}`, 'x^12 + y^2 = r^2',
    'x_ij + y² = r²', 'log level=info', 'A/B testing', 'C++ and C#', '1/2x', 'β版功能',
    '```\n公式 x² + y² = r²\n```', '代码 `公式 x² + y² = r²` 结束。'];
  for (const text of negatives) assert.deepEqual(findInlineMath(text), [], text);
});

test('render conversion preserves solidus, letter E, grouping and Unicode styles', () => {
  const span = findInlineMath('公式 E_t = a_t/b_t + x²，结束。')[0]!;
  assert.ok(span); assert.ok(span.tex.includes('/')); assert.ok(!span.tex.includes('frac'));
  assert.ok(!span.tex.includes('mathbb')); assert.ok(span.tex.includes('E'));
  const unicode = findInlineMath('𝑥² + 𝑦² = 𝑟²')[0]!;
  assert.ok(unicode.tex.includes('𝑥')); assert.ok(unicode.tex.includes('^{2}'));
  const squareRoot = findInlineMath(String.raw`公式 \sqrt{a+b} = x²，结束。`)[0]!;
  assert.ok(squareRoot.tex.includes(String.raw`\sqrt{a + b}`), 'sqrt consumes a TeX argument, without adding visible braces');
  const indexed = findInlineMath('公式 x_{ij} = y² + z²，结束。')[0]!;
  assert.ok(indexed.tex.includes('_{ij}')); assert.ok(!indexed.tex.includes('mathrm'), 'braced TeX letters retain their original style');
  const set = findInlineMath('公式 {a+b} = x²，结束。')[0]!;
  assert.ok(set.tex.includes(String.raw`\{a + b\}`), 'ordinary literal braces remain visible');
});

test('punctuation, multiple spans and emoji do not alter range offsets', () => {
  const text = '😀 前文 x² + y² = r²，另一个 f(x) = x^2 + 1。';
  assert.deepEqual(findInlineMath(text).map(x => x.raw), ['x² + y² = r²', 'f(x) = x^2 + 1']);
  for (const span of findInlineMath(text)) assert.equal(text.slice(span.start, span.end), span.raw);
});

test('character prefixes never rescue an incomplete equation tail', () => {
  const complete = '公式 x² + y² = r²';
  for (let i = 0; i < complete.length; i++) {
    const text = complete.slice(0, i), spans = findInlineMath(text);
    assert.ok(spans.every(span => !/[=+−-]$/.test(span.raw)));
  }
  assert.equal(findInlineMath(complete).length, 1);
});
