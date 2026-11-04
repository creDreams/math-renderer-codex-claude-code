import { fromMarkdown } from 'mdast-util-from-markdown';
import { findCodeRanges } from '../../core/src/markdown-code.js';
import { findDisplayMath } from '../../core/src/display-math.js';
import { LruCache } from '../../core/src/lru.js';

// Count the retained key as well as the value. A cache eviction never changes
// the source proof: the same presentation can be derived again on demand.
interface Presentation { styled: string; linkLabels: string }
const cache = new LruCache<Presentation>(64, 4 * 1024 * 1024);

/** Derive known Codex Markdown styling without changing code or math content.
 * Parse emphasis as Markdown, including nesting and spans across inline math;
 * stripping each unprotected substring separately loses those relationships.
 */
export function plainMarkdown(text: string, options: { linkLabels?: boolean } = {}): string {
  const hit = cache.get(text);
  if (hit !== undefined) return options.linkLabels ? hit.linkLabels : hit.styled;
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
  const remove: { start: number; end: number }[] = [];
  const links: { start: number; end: number }[] = [];
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
      }
    } else if (node.type === 'definition') {
      // A resolved reference definition supplies metadata, not visible prose.
      links.push({ start, end });
    }
    if (node.type === 'emphasis' || node.type === 'strong') {
      const size = node.type === 'strong' ? 2 : 1;
      remove.push({ start, end: start + size }, { start: end - size, end });
    } else if (node.type === 'heading') {
      // Keep setext headings literal until their terminal presentation is
      // supported. Only remove actual ATX delimiters identified by the AST.
      const opening = /^#{1,6}[ \t]+/.exec(text.slice(start, end));
      if (opening) {
        remove.push({ start, end: start + opening[0].length });
        const closing = /[ \t]+#+[ \t]*$/.exec(text.slice(start, end));
        if (closing) remove.push({ start: start + closing.index, end });
      }
    }
    if ('children' in node) for (const child of node.children) visit(child);
  };
  for (const child of fromMarkdown(masked).children) visit(child);
  const apply = (ranges: typeof remove) => {
    let result = '', offset = 0;
    for (const range of ranges.sort((a, b) => a.start - b.start || b.end - a.end)) {
      if (range.start < offset) continue;
      result += text.slice(offset, range.start); offset = range.end;
    }
    return result + text.slice(offset);
  };
  const styled = apply(remove);
  const linkLabels = links.length ? apply([...remove, ...links]) : styled;
  cache.set(text, { styled, linkLabels }, (text.length + styled.length + (links.length ? linkLabels.length : 0)) * 2);
  return options.linkLabels ? linkLabels : styled;
}
