import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resvg } from '@resvg/resvg-js';
import { MathRenderer } from '../packages/core/src/renderer.js';
import { NativeAnalyzer } from '../packages/windows-companion/src/analyzer.js';

const variance = String.raw`\underbrace{\hat p(1-\hat p)
=\frac14-\left(\hat p-\frac12\right)^2}_{\text{理论奖励方差}}`;
const reward = String.raw`\underbrace{r_{\mathrm{uncertainty}}
=1-2\left|\hat p-\frac12\right|}_{\text{不确定性奖励}}`;
const block = (tex: string) => '\\[\n' + tex + '\n\\]';
const source = '比较以下两个完整的数学目标，保留括号下方的中文说明。\n\n' + block(variance) +
  '\n\n另一个奖励定义如下，中文标签属于公式的一部分。\n\n' + block(reward) + '\n\n两个目标都关于中心位置对称。';
const session = { id: 'stretch-fixture', file: 'synthetic', cwd: 'D:/fixture', assistant: [source] };
const request = { type: 'analyze' as const, id: 1, rowHeight: 28, width: 1800,
  foreground: '#cccccc', background: '#0c0c0c' };

test('stretchy braces preserve internal SVG viewports and complete multilingual annotations', () => {
  const renderer = new MathRenderer();
  for (const tex of [variance, reward, variance.replace('underbrace', 'overbrace').replace('}_{', '}^{'),
    variance.replace('理论奖励方差', 'theoretical variance')]) {
    for (const display of [true, false]) {
      const image = renderer.render(tex, display);
      assert.ok((image.svg.match(/<svg\b/g)?.length ?? 0) > 1, 'exercise a stretched glyph with nested SVG viewports');
      assert.ok(image.svg.startsWith('<svg '));
      assert.ok(image.width > 100 && image.height > 20);
      assert.doesNotMatch(image.svg, /mjx-merror|<script|foreignObject|href=|src=/);
      assert.match(image.svg, /data-mml-node="mfrac"/, 'the fraction remains in the full equation');
      if (tex.includes('理论奖励方差')) assert.ok(image.svg.includes('理论奖励方差'), 'the full Chinese label is retained');
      assert.strictEqual(renderer.render(tex, display), image, 'cache retains the complete outer SVG');
      const svg = image.svg.replace(/width="[^"]+"/, `width="${image.width}"`)
        .replace(/height="[^"]+"/, `height="${image.height}"`);
      const rendered = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'Microsoft YaHei' } }).render();
      assert.ok(rendered.width >= 100 && rendered.height >= 20);
      assert.equal(rendered.asPng().subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }
  }
});

test('marked stretchy blocks render without preview and retain cached images during status redraws', () => {
  const analyzer = new NativeAnalyzer();
  const text = '• ' + source.replaceAll('\n', '\r\n  ') + '\r\n\r\n› Ask Codex';
  const first = analyzer.analyze({ ...request, text, inlineMath: false }, [session]);
  assert.equal(first.state, 'matched'); assert.equal(first.skipped, 0);
  assert.equal(first.formulas.length, 2);
  for (const formula of first.formulas) {
    const png = Buffer.from(formula.png, 'base64');
    assert.equal(png.readUInt32BE(16), formula.width);
    assert.equal(png.readUInt32BE(20), formula.height);
    assert.ok(formula.height <= (formula.endRow - formula.startRow + 1) * request.rowHeight);
  }
  for (let frame = 0; frame < 12; frame++) {
    const next = analyzer.analyze({ ...request, text: text + `\r\n• Working (${frame}s • esc to interrupt)` }, [session]);
    assert.deepEqual(next.formulas, first.formulas);
    assert.equal(next.metrics.imageMisses, 0);
  }
  const changed = analyzer.analyze({ ...request, text: text.replace('理论奖励方差', '其他奖励方差') }, [session]);
  assert.equal(changed.formulas.length, 0, 'source verification still rejects changed annotations');
});

test('each complete marked brace renders independently at either viewport edge', () => {
  const lines = source.split('\n'), analyzer = new NativeAnalyzer();
  const expected = [variance, reward].map(tex => {
    const start = lines.findIndex(line => line === tex.split('\n')[0]) - 1;
    return { tex, start, end: start + tex.split('\n').length + 1 };
  });
  for (const height of [3, 4, 5, 8, 12, 24]) for (let top = 0; top < lines.length; top++) {
    const shown = lines.slice(top, top + height);
    const text = (top ? '  ' : '• ') + shown.join('\r\n  ');
    const leadingContext = top ? '• ' + lines.slice(0, top).join('\r\n  ') + '\r\n' : '';
    const result = analyzer.analyze({ ...request, text, leadingContext }, [session]);
    const complete = expected.filter(f => f.start >= top && f.end < top + shown.length);
    assert.deepEqual(result.formulas.map(f => [f.startRow, f.endRow]),
      complete.map(f => [f.start - top, f.end - top]), `top=${top}, height=${height}`);
    assert.equal(result.skipped, 0);
  }
});
