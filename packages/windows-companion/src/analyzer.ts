import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';
import { MathRenderer } from '../../core/src/renderer.js';
import { matchCodexText, type CodexSession, type MatchResult } from '../../adapter-codex/src/matcher.js';
import { LruCache } from '../../core/src/lru.js';
import { inlineOffset, readableInline } from './inline-typography.js';

export interface AnalyzeRequest {
  type: 'analyze'; id: number; text: string; rowHeight: number; width: number;
  foreground: string; background: string;
  leadingContext?: string;
  inlineMath?: boolean;
}
export interface RenderedFormula {
  startRow: number; endRow: number; imageId: string; png: string; width: number; height: number;
  kind?: 'inline'; startColumn?: number; endColumn?: number; visibleText?: string; offsetY?: number;
}

/** Row positions are semantic indices only. Native UIA rectangles supply all pixel geometry. */
export function matchVisibleText(text: string, sessions: CodexSession[], leadingContext = '') {
  return matchCodexText(text, sessions, leadingContext);
}

export class NativeAnalyzer {
  private renderer?: MathRenderer;
  private inlineMode = false;
  private images = new LruCache<Pick<RenderedFormula, 'imageId' | 'png' | 'width' | 'height' | 'offsetY'>>(64, 32 * 1024 * 1024);
  private readonly unrenderable = new LruCache<boolean>(1024, 256 * 1024);

  analyze(request: AnalyzeRequest, sessions: CodexSession[], verifiedMatch?: MatchResult) {
    const started = performance.now();
    if (!Number.isSafeInteger(request.id) || request.text.length > 65536 ||
        (request.leadingContext !== undefined && (typeof request.leadingContext !== 'string' || request.leadingContext.length > 65536)) ||
        !Number.isFinite(request.rowHeight) || request.rowHeight < 6 || request.rowHeight > 200 ||
        !Number.isFinite(request.width) || request.width < 40 || request.width > 16384 ||
        !/^#[0-9a-f]{6}$/i.test(request.foreground) || !/^#[0-9a-f]{6}$/i.test(request.background)) {
      throw new Error('Invalid terminal snapshot');
    }
    if (this.inlineMode !== (request.inlineMath === true)) {
      this.inlineMode = request.inlineMath === true;
      this.images = new LruCache(this.inlineMode ? 1024 : 64, 32 * 1024 * 1024);
    }
    const match = verifiedMatch ?? matchCodexText(request.text, sessions, request.leadingContext, request.inlineMath === true);
    const matchedAt = performance.now();
    const formulas: RenderedFormula[] = [];
    const limit = request.inlineMath ? 256 : 16;
    let skipped = Math.max(0, match.regions.length - limit), pngBytes = 0, imageHits = 0, imageMisses = 0, pendingRender = false;
    for (const region of match.regions.slice(0, limit)) {
      const inline = region.kind === 'inline';
      if ((inline || region.requiresPreview) && !request.inlineMath) continue;
      const height = (region.endRow - region.startRow + 1) * request.rowHeight;
      if (height <= 12 || height > 4096) { skipped++; continue; }
      const imageId = createHash('sha256').update(JSON.stringify([
        region.tex, height, request.rowHeight, request.width, request.foreground, inline, region.compactFallback === true,
      ])).digest('hex');
      if (this.unrenderable.get(imageId)) { skipped++; continue; }
      const reject = () => { this.unrenderable.set(imageId, true, imageId.length * 2 + 8); skipped++; };
      let image = this.images.get(imageId);
      if (image) imageHits++; else imageMisses++;
      if (!image) {
        // A per-turn budget defers new images; cached images are still returned
        // and later requests finish the remainder of the same visible viewport.
        if (request.inlineMath && performance.now() - matchedAt > 25) { pendingRender = true; continue; }
        try {
          this.renderer ??= new MathRenderer();
          let math = inline ? readableInline(this.renderer, region.tex, request.rowHeight) : this.renderer.render(region.tex);
          // Aim for an em 1.3 times the terminal row height (previously 0.8).
          // Large source blocks may grow to 1.7, using at most 72% of the slot
          // height. Short/wide slots can fall back to the original readable size.
          const minimumScale = request.rowHeight * (inline ? 0.76 * 0.85 : 0.6) / 16;
          const preferredScale = request.rowHeight * 1.3 / 16;
          const spaciousScale = Math.min(request.rowHeight * 1.7 / 16, height * 0.72 / math.height);
          // Simultaneous upper/lower scripts can fit the row at normal size
          // while needing slightly more descent than the estimated text font.
          // Fit the full image first, then bound the baseline adjustment below.
          // Use available row height for readable inline glyphs. The old 0.76
          // em cap left ordinary equations visibly smaller than nearby text.
          // Never grow outside the verified row or shrink to fit its width.
          let scale = inline ? Math.min(request.rowHeight * 1.05 / 16, (height - 2) / math.height) :
            Math.min(Math.max(preferredScale, spaciousScale), (request.width - 24) / math.width, (height - 8) / math.height);
          if (!inline && region.compactFallback && scale < minimumScale) {
            // Near a viewport edge Claude may leave only one adjacent blank
            // row. Standard text-style limits preserve every operand while
            // avoiding a tall display sum. Keep the readability threshold.
            const compact = this.renderer.render(region.tex, false);
            const compactScale = Math.min(preferredScale, (request.width - 24) / compact.width, (height - 8) / compact.height);
            if (compactScale > scale) { math = compact; scale = compactScale; }
          }
          if (scale < minimumScale) { reject(); continue; }
          const width = Math.max(1, Math.min(8192, Math.floor(math.width * scale)));
          const svg = math.svg.replace(/width="[^"]+"/, `width="${math.width}"`)
            .replace(/height="[^"]+"/, `height="${math.height}"`)
            .replace('<svg ', `<svg color="${request.foreground}" `);
          const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: width },
            // Math glyphs remain bundled paths. Literal Chinese conditions in
            // mathematical sets use the local UI font, entirely offline.
            font: { loadSystemFonts: /<text\b/.test(svg), defaultFontFamily: 'Microsoft YaHei' } }).render();
          const png = rendered.asPng();
          if (png.length > 2 * 1024 * 1024 || rendered.height > height || rendered.width > request.width) {
            reject(); continue;
          }
          const baseline = math.baseline * rendered.width / math.width;
          const offsetY = inline ? inlineOffset(request.rowHeight, rendered.height, baseline) : undefined;
          if (inline && offsetY === undefined) { reject(); continue; }
          image = { imageId, png: png.toString('base64'), width: rendered.width, height: rendered.height,
            ...(inline ? { offsetY } : {}) };
          this.images.set(imageId, image, image.png.length * 2);
        } catch { reject(); continue; }
      }
      // Bound the entire IPC response as well as individual images. Sixteen
      // individually valid PNGs must not overflow the native JSON reader.
      const bytes = image.png.length / 4 * 3;
      if (pngBytes + bytes > 12 * 1024 * 1024) { skipped++; continue; }
      pngBytes += bytes;
      formulas.push({ ...image, startRow: region.startRow, endRow: region.endRow,
        ...(inline ? { kind: 'inline' as const, startColumn: region.startColumn, endColumn: region.endColumn, visibleText: region.visibleText } : {}) });
    }
    return { type: 'result', id: request.id, state: match.state, sourceRanges: match.sourceRanges,
      verifiedRanges: match.verifiedRanges, formulas, skipped, pendingRender,
      metrics: { matchMs: matchedAt - started, renderMs: performance.now() - matchedAt,
        inlineCandidates: match.regions.filter(region => region.kind === 'inline').length,
        inlineImages: formulas.filter(formula => formula.kind === 'inline').length,
        imageHits, imageMisses, imageEntries: this.images.size, imageBytes: this.images.bytes } };
  }
}
