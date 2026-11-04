import { mathjax } from '@mathjax/src/js/mathjax.js';
import { TeX } from '@mathjax/src/js/input/tex.js';
import { SVG } from '@mathjax/src/js/output/svg.js';
import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import '@mathjax/src/js/input/tex/ams/AmsConfiguration.js';
import { MathJaxNewcmFont } from '@mathjax/mathjax-newcm-font/mjs/svg.js';
import './fonts.js';
import { LruCache } from './lru.js';
import type ParseOptions from '@mathjax/src/js/input/tex/ParseOptions.js';

export interface MathImage { svg: string; width: number; height: number; baseline: number }

class OfflineFont extends MathJaxNewcmFont {
  constructor() {
    super();
    for (const table of Object.values(OfflineFont.dynamicFiles)) table.setup(this);
  }
}

/** Restricted, synchronous and offline. No autoload, HTML, URLs or user macros. */
export class MathRenderer {
  private readonly adaptor = liteAdaptor();
  private readonly cache = new LruCache<MathImage>(128, 16 * 1024 * 1024);
  private readonly document;
  private largerScripts = false;

  constructor() {
    RegisterHTMLHandler(this.adaptor);
    const font = new OfflineFont();
    const input = new TeX({ packages: ['base', 'ams'], maxBuffer: 8192,
      formatError: (_jax: unknown, error: Error) => { throw error; } });
    // Set this before MathJax propagates inherited attributes (-6). This is
    // typography only: keep the original script levels and math variants.
    input.postFilters.add((argument: unknown) => {
      const { math, data } = argument as { math: { display: boolean }; data: ParseOptions };
      if (this.largerScripts && !math.display) data.root.attributes.set('scriptsizemultiplier', 0.82);
    }, -6.5);
    // Tables are imported above. Apply them to this instance without async loaders.
    this.document = mathjax.document('', {
      InputJax: input,
      // MathJax 4 otherwise splits inline math into one SVG per break point.
      // Our native bitmap represents the whole expression in one fixed row.
      OutputJax: new SVG({ fontCache: 'none', fontData: font, linebreaks: { inline: false } }),
    });
  }

  render(tex: string, display = true, options: { largerScripts?: boolean } = {}): MathImage {
    if (!tex.trim() || tex.length > 8192) throw new Error('Formula length is unsupported');
    if (/\\(?:def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|newenvironment|renewenvironment|DeclareMathOperator|csname|catcode|require|href|url|html[A-Za-z]*)\b/.test(tex)) {
      throw new Error('Macro definitions and external content are unsupported');
    }
    const largerScripts = !display && options.largerScripts === true;
    const cacheKey = (display ? 'display:' : largerScripts ? 'inline-larger-scripts:' : 'inline:') + tex;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    let node;
    this.largerScripts = largerScripts;
    try { node = this.document.convert(tex, { display, em: 16, ex: 8, containerWidth: 1280 }); }
    finally { this.largerScripts = false; }
    const svgs = this.adaptor.tags(node, 'svg');
    if (svgs.length !== 1) throw new Error('Formula must produce exactly one complete SVG');
    const svgNode = svgs[0]!;
    const box = this.adaptor.getAttribute(svgNode, 'viewBox')!.split(/\s+/).map(Number);
    const width = box[2]! / 1000 * 16;
    const height = box[3]! / 1000 * 16;
    // Standalone SVG is XML. HTML serialization leaves '<' in data-latex
    // attributes unescaped, causing valid TeX such as o_{<t} to fail in resvg.
    const svg = this.adaptor.serializeXML(svgNode);
    // Generated SVG uses paths, not untrusted HTML. Reject external/active content.
    if (/<(?:script|foreignObject|image|a)\b|\bon\w+\s*=|(?:href|src)\s*=/i.test(svg)) {
      throw new Error('Unsupported SVG content');
    }
    if (![width, height].every(x => Number.isFinite(x) && x > 0)) throw new Error('Invalid SVG size');
    const result = { svg, width, height, baseline: -box[1]! / 1000 * 16 };
    this.cache.set(cacheKey, result, (cacheKey.length + svg.length) * 2);
    return result;
  }
}
