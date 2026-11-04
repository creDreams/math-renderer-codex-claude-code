import { MathRenderer, type MathImage } from '../../core/src/renderer.js';

const scaleInRow = (math: MathImage, rowHeight: number) =>
  Math.min(rowHeight * 1.05 / 16, (rowHeight - 2) / math.height);

export function inlineOffset(rowHeight: number, imageHeight: number, baseline: number): number | undefined {
  const offset = Math.max(1, Math.min(rowHeight - imageHeight - 1, Math.round(rowHeight * 0.79 - baseline)));
  return offset + imageHeight > rowHeight - 1 || Math.abs(offset + baseline - rowHeight * 0.79) > rowHeight * 0.15
    ? undefined : offset;
}

/** Improve small glyphs without changing variants, meaning or the terminal row. */
export function readableInline(renderer: MathRenderer, tex: string, rowHeight: number): MathImage {
  const original = renderer.render(tex, false);
  const originalScale = scaleInRow(original, rowHeight);
  const originalWidth = Math.floor(original.width * originalScale);
  const larger = renderer.render(tex, false, { largerScripts: true });
  for (const math of [larger, original]) {
    // Padding is in MathJax's 1000 units/em viewBox. It contains the optical
    // stroke, including at the original minimum readable size, without clipping.
    const padding = 16, emPadding = padding / 1000 * 16;
    const width = math.width + emPadding * 2, height = math.height + emPadding * 2;
    const scale = scaleInRow({ ...math, width, height }, rowHeight);
    if (scale < rowHeight * 0.76 * 0.85 / 16 || scale < originalScale * 0.94) continue;
    const pixels = Math.floor(width * scale);
    // The native host owns the real substring width. A style change must not
    // make a previously fitting image wider, or fail its existing baseline.
    if (pixels > originalWidth || inlineOffset(rowHeight, Math.ceil(height * pixels / width),
      (math.baseline + emPadding) * pixels / width) === undefined) continue;
    const box = /viewBox="([^"]+)"/.exec(math.svg)![1]!.split(/\s+/).map(Number);
    const strokePixels = Math.max(0.25, Math.min(0.6, rowHeight * 0.016));
    const stroke = strokePixels * 1000 / (16 * scale);
    const svg = math.svg.replace(/viewBox="[^"]+"/,
      `viewBox="${box[0]! - padding} ${box[1]! - padding} ${box[2]! + padding * 2} ${box[3]! + padding * 2}"`)
      .replace(/<path\b([^>]*)>/g, (path, attributes: string) => /\bstroke(?:-width)?=/.test(attributes) ? path :
        `<path stroke="currentColor" stroke-width="${stroke}" stroke-linejoin="round"${attributes}>`);
    return { svg, width, height, baseline: math.baseline + emPadding };
  }
  // A dense fraction or nested script must not become smaller or disappear
  // just to use the new style. Keep the previous readable layout in that case.
  return original;
}
