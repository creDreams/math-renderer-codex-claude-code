import { isDisplayEnvironment } from '../../core/src/display-math.js';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { LruCache } from '../../core/src/lru.js';

const cache = new LruCache<string[]>(64, 4 * 1024 * 1024);

/** Predict only known textual Markdown transformations. Keep physical container
 * prefixes; replacing an AST text node wholesale would erase quote margins. */
function styledEnvironment(text: string): string {
  const edits: { start: number; end: number; value: string }[] = [];
  const code: { start: number; end: number }[] = [];
  type Node = ReturnType<typeof fromMarkdown>['children'][number];
  const visit = (node: Node) => {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === 'inlineCode') {
      code.push({ start, end });
      const size = /^`+/.exec(text.slice(start, end))![0].length;
      edits.push({ start, end: start + size, value: '' }, { start: end - size, end, value: '' });
      return;
    }
    if (node.type === 'emphasis' || node.type === 'strong') {
      const size = node.type === 'strong' ? 2 : 1;
      edits.push({ start, end: start + size, value: '' }, { start: end - size, end, value: '' });
    } else if (node.type === 'break' && text[start] === '\\') edits.push({ start, end: start + 1, value: '' });
    if ('children' in node) for (const child of node.children) visit(child);
  };
  for (const node of fromMarkdown(text).children) visit(node);
  for (const match of text.matchAll(/\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g)) {
    if (!code.some(range => match.index >= range.start && match.index < range.end))
      edits.push({ start: match.index, end: match.index + 2, value: match[1]! });
  }
  let result = '', offset = 0;
  for (const edit of edits.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (edit.start < offset) continue;
    result += text.slice(offset, edit.start) + edit.value; offset = edit.end;
  }
  return result + text.slice(offset);
}

/** Codex treats bare display environments as Markdown, unlike \[...\].
 * Backslash escapes collapse punctuation and emphasis can consume TeX scripts.
 * Keep original TeX for rendering; verify deterministic whole-block alternatives. */
export function displayPresentations(tex: string, canonical = tex): string[] {
  const name = /^\\begin\{([^}]+)\}/.exec(canonical)?.[1];
  if (!name || !isDisplayEnvironment(name)) return [tex];
  const hit = cache.get(tex);
  if (hit) return hit;
  const markdown = tex.replace(/\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g, '$1');
  const variants = [...new Set([tex, markdown, styledEnvironment(tex)])];
  cache.set(tex, variants, (tex.length + variants.reduce((size, value) => size + value.length, 0)) * 2);
  return variants;
}

export function displayMatches(source: string, visible: string): boolean {
  const compact = (text: string) => text.normalize('NFC').replace(/\s+/gu, '');
  return displayPresentations(source).some(text => compact(text) === compact(visible));
}
