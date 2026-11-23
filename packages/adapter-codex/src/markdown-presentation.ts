import { fromMarkdown } from 'mdast-util-from-markdown';
import { findCodeRanges } from '../../core/src/markdown-code.js';
import { findDisplayMath } from '../../core/src/display-math.js';
import { LruCache } from '../../core/src/lru.js';

// Count the retained key as well as the value. A cache eviction never changes
// the source proof: the same presentation can be derived again on demand.
interface Presentation { styled: string; linkLabels: string; forms: readonly string[] }
const cache = new LruCache<Presentation>(64, 4 * 1024 * 1024);

/** Local links may display their destination relative to the transcript cwd.
 * Derive the complete visible suffix from source metadata; never discard an
 * arbitrary parenthesized terminal substring or consult the filesystem. */
function localLinkPath(url: string, cwd: string): string | undefined {
  let target = url;
  if (/^file:\/\//i.test(target)) {
    target = target.replace(/^file:\/\/\/(?=[A-Za-z]:\/)/i, '').replace(/^file:\/\//i, '');
    try { target = decodeURIComponent(target); } catch { return; }
  } else if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(target) && !/^[A-Za-z]:[\\/]/.test(target)) return;
  if (!target || /^[?#]/.test(target) || /[\r\n\x00]/.test(target)) return;
  const path = target.replaceAll('\\', '/'), root = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
  const windows = /^[A-Za-z]:(?:\/|$)/.test(root) || root.startsWith('//');
  const prefix = root + '/';
  if (root && (windows ? path.toLowerCase().startsWith(prefix.toLowerCase()) : path.startsWith(prefix)))
    return path.slice(prefix.length);
  return path;
}

/** Finite, source-derived terminal presentations. Codex can retain ATX heading
 * markers while styling emphasis, and show local link paths beside labels. */
export function markdownPresentations(text: string, cwd: string): readonly string[] {
  return deriveMarkdown(text, cwd).forms;
}

/** Derive known Codex Markdown styling without changing code or math content.
 * Parse emphasis as Markdown, including nesting and spans across inline math;
 * stripping each unprotected substring separately loses those relationships.
 */
export function plainMarkdown(text: string, options: { linkLabels?: boolean } = {}): string {
  const result = deriveMarkdown(text);
  return options.linkLabels ? result.linkLabels : result.styled;
}

function deriveMarkdown(text: string, cwd = ''): Presentation {
  const key = JSON.stringify([text, cwd]);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const code = findCodeRanges(text);
  const math = [...findDisplayMath(text),
    ...[...text.matchAll(/\\\([^\r\n]*?\\\)|(?<![\\$])\$(?!\$)[^$\r\n]+\$/g)]
      .map(span => ({ start: span.index!, end: span.index! + span[0].length }))]
    // A display can contain indented TeX lines or backticks of its own. Only
    // an opener already inside Markdown code makes the entire span literal code.
    .filter(span => !code.some(range => span.start >= range.start && span.start < range.end))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  // Mask math for the parser only, preserving UTF-16 offsets and line/indent
  // structure. An underscore in q_s or a TeX star must never become emphasis.
  let offset = 0, masked = '';
  for (const span of math) {
    if (span.start < offset) continue;
    masked += text.slice(offset, span.start) + text.slice(span.start, span.end).replace(/[^\s]/g, 'x');
    offset = span.end;
  }
  masked += text.slice(offset);
  type Edit = { start: number; end: number; replacement?: string };
  const remove: Edit[] = [], headings: Edit[] = [];
  const links: { start: number; end: number }[] = [];
  const pathLinks: Edit[] = [];
  const tree = fromMarkdown(masked);
  const definitions = new Map(tree.children.filter(node => node.type === 'definition').map(node => [node.identifier, node.url]));
  const visit = (node: ReturnType<typeof fromMarkdown>['children'][number]) => {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === 'code' || node.type === 'inlineCode') return;
    if (node.type === 'link' || node.type === 'linkReference') {
      // The AST identifies the label, including nested emphasis/math/code.
      // In label-only presentation the URL and title are hidden. Keep a separate
      // literal presentation so Markdown output remains verifiable too.
      const labelStart = node.children[0]?.position?.start.offset;
      const labelEnd = node.children.at(-1)?.position?.end.offset;
      if (labelStart !== undefined && labelEnd !== undefined && start <= labelStart && labelEnd <= end) {
        links.push({ start, end: labelStart }, { start: labelEnd, end });
        const url = node.type === 'link' ? node.url : definitions.get(node.identifier);
        const path = url === undefined ? undefined : localLinkPath(url, cwd);
        pathLinks.push({ start, end: labelStart }, { start: labelEnd, end,
          ...(path === undefined ? {} : { replacement: ` (${path})` }) });
      }
    } else if (node.type === 'definition') {
      // A resolved reference definition supplies metadata, not visible prose.
      links.push({ start, end });
      pathLinks.push({ start, end });
    }
    if (node.type === 'emphasis' || node.type === 'strong') {
      const size = node.type === 'strong' ? 2 : 1;
      remove.push({ start, end: start + size }, { start: end - size, end });
    } else if (node.type === 'heading') {
      // Keep setext headings literal until their terminal presentation is
      // supported. Only remove actual ATX delimiters identified by the AST.
      const opening = /^#{1,6}[ \t]+/.exec(text.slice(start, end));
      if (opening) {
        headings.push({ start, end: start + opening[0].length });
        const closing = /[ \t]+#+[ \t]*$/.exec(text.slice(start, end));
        if (closing) headings.push({ start: start + closing.index, end });
      }
    }
    if ('children' in node) for (const child of node.children) visit(child);
  };
  for (const child of tree.children) visit(child);
  const apply = (ranges: typeof remove) => {
    let result = '', offset = 0;
    for (const range of ranges.sort((a, b) => a.start - b.start || b.end - a.end)) {
      if (range.start < offset) continue;
      result += text.slice(offset, range.start) + (range.replacement ?? ''); offset = range.end;
    }
    return result + text.slice(offset);
  };
  const styled = apply([...remove, ...headings]);
  const linkLabels = links.length ? apply([...remove, ...headings, ...links]) : styled;
  const forms = [...new Set([styled, linkLabels, apply([...remove]), apply([...remove, ...links]),
    apply([...remove, ...headings, ...pathLinks]), apply([...remove, ...pathLinks])])];
  const result = { styled, linkLabels, forms };
  cache.set(key, result, (key.length + forms.reduce((size, form) => size + form.length, 0)) * 2);
  return result;
}
