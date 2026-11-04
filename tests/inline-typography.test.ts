import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resvg } from '@resvg/resvg-js';
import { MathRenderer, type MathImage } from '../packages/core/src/renderer.js';
import { readableInline } from '../packages/windows-companion/src/inline-typography.js';
import { NativeAnalyzer } from '../packages/windows-companion/src/analyzer.js';

const glyphs = (math: MathImage) => Array.from(math.svg.matchAll(/data-c="([^"]+)"/g), match => match[1]);
const scale = (math: MathImage, row: number) => Math.min(row * 1.05 / 16, (row - 2) / math.height);
function raster(math: MathImage, row: number) {
  const svg = math.svg.replace(/width="[^"]+"/, `width="${math.width}"`)
    .replace(/height="[^"]+"/, `height="${math.height}"`);
  return new Resvg(svg, { fitTo: { mode: 'width', value: Math.floor(math.width * scale(math, row)) },
    font: { loadSystemFonts: false } }).render();
}
const ink = (pixels: Uint8Array) => pixels.reduce((sum, value, index) => sum + (index % 4 === 3 ? value : 0), 0);

test('larger scripts retain every glyph and explicit math variant without leaking into default or display rendering', () => {
  const renderer = new MathRenderer();
  for (const tex of ['x_i+x^2+y_{j+1}', String.raw`\mathbf v_i+\mathbb E_q[Q]=\hat A_t`,
    String.raw`e^{x_i^2}+\frac{a+b}{c}=y_j`]) {
    const inline = renderer.render(tex, false), display = renderer.render(tex);
    const larger = renderer.render(tex, false, { largerScripts: true });
    assert.deepEqual(glyphs(larger), glyphs(inline));
    assert.notEqual(larger.svg, inline.svg);
    assert.equal(renderer.render(tex, false), inline, 'standard cache stays separate');
    assert.equal(renderer.render(tex, true, { largerScripts: true }), display, 'display layout stays identical');
  }
  assert.throws(() => renderer.render(String.raw`\unknowncommand`, false, { largerScripts: true }));
  assert.doesNotMatch(renderer.render('x_i', false).svg, /scale\(0\.82\)/);
});

test('readable inline typography strengthens real glyph pixels while retaining row and main-text size limits', () => {
  const renderer = new MathRenderer();
  for (const row of [18, 28, 40, 56]) for (const tex of [String.raw`\hat A_t=Q_t-V_t`,
    String.raw`\theta_{t+1}=\theta_t-\alpha\nabla J(\theta_t)`,
    String.raw`L_{total}(\theta)=E_t[L_{CLIP}(\theta)-c_1L_{VF}(\theta)]`]) {
    const original = renderer.render(tex, false), readable = readableInline(renderer, tex, row);
    assert.deepEqual(glyphs(readable), glyphs(original));
    if (row === 28 && (tex.includes('hat A') || tex.startsWith('\\theta')))
      assert.match(readable.svg, /scale\(0\.82\)/, 'roomy subscripts actually grow relative to main glyphs');
    assert.ok(scale(readable, row) >= scale(original, row) * 0.94, 'main glyphs retain at least 94% of previous size');
    const before = raster(original, row), after = raster(readable, row);
    assert.ok(after.height <= row - 2, 'optical stroke stays inside the padded row');
    assert.ok(after.width <= before.width, 'the new style fits every previously wide-enough substring');
    assert.ok(ink(after.pixels) > ink(before.pixels) * 1.1, 'rasterized symbols gain visible ink, not just a CSS hint');
    assert.ok(after.asPng().byteLength < 2 * 1024 * 1024);
  }
});

test('baseline-sensitive descenders keep their images at small and large DPI sizes', () => {
  const renderer = new MathRenderer(), analyzer = new NativeAnalyzer();
  for (const rowHeight of [18, 28, 40, 56]) for (const tex of ['a_{i,j}=x_t+y_{t+1}',
    'x_{i,j}=x_t+y_{t+1}', 'y_{i,j}=x_t+y_{t+1}', String.raw`\theta_{i,j}^2=x_t+y_{t+1}`,
    String.raw`\pi_{i,j}=x_t+y_{t+1}`, String.raw`\mathbf v_{i,j}=x_t+y_{t+1}`]) {
    const result = analyzer.analyze({ type: 'analyze', id: 1, text: '', rowHeight, width: 4096,
      foreground: '#cccccc', background: '#0c0c0c', inlineMath: true }, [],
    { state: 'matched', sourceRanges: [], regions: [{ tex, kind: 'inline', startRow: 0, endRow: 0,
      startColumn: 0, endColumn: 200, visibleText: tex }] });
    assert.equal(result.formulas.length, 1, `row ${rowHeight}: ${tex}`);
    const image = result.formulas[0]!;
    assert.ok(image.width <= raster(renderer.render(tex, false), rowHeight).width);
    assert.ok(image.offsetY! >= 1 && image.offsetY! + image.height <= rowHeight - 1);
  }
});

test('dense fractions and simultaneous or nested scripts retain readable main glyphs and their full content', () => {
  const renderer = new MathRenderer();
  for (const row of [18, 28, 40, 56]) for (const tex of ['a_{i,j}^2+b_{i,j}^2=c_{i,j}^2',
    String.raw`\frac{a+b}{c+d}=x_i^2`, 'e^{x_i^2}=y_{j+1}']) {
    const original = renderer.render(tex, false), readable = readableInline(renderer, tex, row);
    assert.deepEqual(glyphs(readable), glyphs(original));
    assert.doesNotMatch(readable.svg, /scale\(0\.82\)/, 'expanding scripts must not squeeze the main glyphs');
    assert.ok(scale(readable, row) >= scale(original, row) * 0.94);
    assert.ok(raster(readable, row).height <= row - 2);
  }
});
