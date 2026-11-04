import { fromMarkdown } from 'mdast-util-from-markdown';
import { LruCache } from './lru.js';

export interface TextRange { start: number; end: number }
interface Container extends TextRange { kind: 'blockquote' | 'listItem' }
interface MarkdownContext { code: TextRange[]; containers: Container[] }
const cache = new LruCache<MarkdownContext>(64, 4 * 1024 * 1024);

/** CommonMark positions keep nested lists/quotes and code unambiguous. Offsets
 * are UTF-16; only ranges are retained, never the complete syntax tree. */
export function markdownContext(text: string): MarkdownContext {
  const hit = cache.get(text);
  if (hit) return hit;
  const result: MarkdownContext = { code: [], containers: [] };
  type Node = ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>['children'][number];
  const visit = (node: Node) => {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (node.type === 'code' || node.type === 'inlineCode') {
        result.code.push({ start, end }); return;
      }
      if (node.type === 'blockquote' || node.type === 'listItem')
        result.containers.push({ start, end, kind: node.type });
    }
    if ('children' in node) for (const child of node.children) visit(child as Node);
  };
  visit(fromMarkdown(text));
  // Keep the previous conservative protection for indented examples even when
  // CommonMark treats them as lazy paragraph continuations. List indentation
  // alone is not code: its child nodes already distinguish actual code blocks.
  let offset = 0;
  for (const line of text.split('\n')) {
    if (/^(?: {4}|\t)/.test(line) && !result.containers.some(container =>
      container.kind === 'listItem' && offset >= container.start && offset < container.end))
      result.code.push({ start: offset, end: offset + line.length });
    offset += line.length + 1;
  }
  result.code.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TextRange[] = [];
  for (const range of result.code) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  result.code = merged;
  cache.set(text, result, text.length * 2 + (result.code.length + result.containers.length) * 48);
  return result;
}

/** Literal Markdown code, including nested fences, indented code and spans. */
export function findCodeRanges(text: string): TextRange[] {
  return markdownContext(text).code;
}
