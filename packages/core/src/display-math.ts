import { markdownContext } from './markdown-code.js';

export interface DisplayMath { tex: string; start: number; end: number }

/** Inner structures such as aligned, split, cases and matrices need an outer block. */
const environment = /^(?:equation\*?|align\*?|alignat\*?|flalign\*?|gather\*?|multline\*?|eqnarray\*?|displaymath)$/;
export const isDisplayEnvironment = (name: string): boolean => environment.test(name);

/** Scan TeX control sequences, respecting escaped slashes and percent comments. */
function environmentTokens(line: string) {
  const tokens: { command: string; name: string; end: number }[] = [];
  let end = line.length;
  for (let i = 0; i < line.length;) {
    if (line[i] === '%') { end = i; break; }
    if (line[i] !== '\\') { i++; continue; }
    const token = /^\\(begin|end)\{([A-Za-z]+\*?)\}/.exec(line.slice(i));
    if (token) {
      i += token[0].length; tokens.push({ command: token[1]!, name: token[2]!, end: i });
    } else i += 2; // includes escaped backslashes and escaped percent signs
  }
  return { tokens, active: line.slice(0, end) };
}

/** Complete display blocks outside code; offsets cover physical source rows.
 * Leading context restores fence, container and delimiter state after clipping. */
export function findDisplayMath(text: string, leadingContext = ''): DisplayMath[] {
  if (leadingContext) {
    const prefix = leadingContext.endsWith('\n') ? leadingContext : leadingContext + '\n';
    return findDisplayMath(prefix + text).filter(block => block.start >= prefix.length)
      .map(block => ({ ...block, start: block.start - prefix.length, end: block.end - prefix.length }));
  }
  if (!text.includes('\\[') && !text.includes('$$') && !text.includes('\\begin{')) return [];
  const context = markdownContext(text), results: DisplayMath[] = [];
  type Scope = (typeof context.containers)[number];
  type Open = { close?: string; name?: string; stack: string[]; start: number; body: string[];
    scopes: Scope[]; quotes: number; indent: number; size: number };
  let offset = 0, open: Open | undefined;
  const complete = (end: number) => {
    const tex = open!.body.join('\n').trim();
    if (tex && tex.length <= 8192) results.push({ tex, start: open!.start, end });
    open = undefined;
  };
  const appendEnvironment = (content: string, rowEnd: number) => {
    const scanned = environmentTokens(content);
    for (const token of scanned.tokens) {
      if (token.command === 'begin') open!.stack.push(token.name);
      else if (open!.stack.pop() !== token.name) { open = undefined; return; }
      if (!open!.stack.length && scanned.active.slice(token.end).trim()) { open = undefined; return; }
    }
    open!.body.push(content); open!.size += content.length + 1;
    if (!open!.stack.length) complete(rowEnd);
  };
  for (const line of text.split('\n')) {
    const scopesAt = (position: number) => context.containers.filter(scope => position >= scope.start && position < scope.end);
    const rawPosition = offset + line.length - line.trimStart().length;
    if (open && line.trim() && open.scopes.some(scope => rawPosition < scope.start || rawPosition >= scope.end)) open = undefined;
    if (open && (open.body.length >= 100 || open.size > 8192)) open = undefined;
    let body = line;
    if (open) {
      for (let i = 0; i < open.quotes; i++) {
        const quote = /^\s*>[ \t]?/.exec(body);
        if (!quote && body.trim()) { open = undefined; break; }
        if (quote) body = body.slice(quote[0].length);
      }
    }
    if (open) {
      body = body.slice(Math.min(open.indent, /^\s*/.exec(body)![0].length));
      const trimmed = body.trim();
      const begin = /^\\begin\{([A-Za-z]+\*?)\}/.exec(trimmed);
      if (open.close && trimmed === open.close) {
        complete(offset + line.length); offset += line.length + 1; continue;
      }
      if (trimmed === '\\[' || trimmed === '$$' || begin && environment.test(begin[1]!)) {
        open = undefined; // abandoned block: try the fresh explicit opener below
      } else {
        if (/^(?:`{3,}|~{3,})/.test(trimmed)) open = undefined;
        else if (open.name) appendEnvironment(body, offset + line.length);
        else { open.body.push(body); open.size += body.length + 1; }
        offset += line.length + 1; continue;
      }
    }
    // Strip Markdown containers only when locating an opener. Within TeX, '-'
    // and '>' are operators, so the body uses only its established quote prefix.
    let content = line, quotes = 0, listIndent = 0;
    for (;;) {
      const quote = /^\s*>[ \t]?/.exec(content);
      const list = /^\s*(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(content);
      const prefixScopes = scopesAt(offset + line.length - content.trimStart().length);
      if (quote && prefixScopes.some(scope => scope.kind === 'blockquote')) {
        content = content.slice(quote[0].length); quotes++; listIndent = 0;
      } else if (list && prefixScopes.some(scope => scope.kind === 'listItem')) {
        content = content.slice(list[0].length); listIndent += list[0].length;
      } else break;
    }
    const position = offset + line.length - content.trimStart().length;
    const scopes = scopesAt(position);
    const isCode = context.code.some(range => position >= range.start && position < range.end);
    const trimmed = content.trim();
    const begin = /^\\begin\{([A-Za-z]+\*?)\}/.exec(trimmed);
    const opener = trimmed === '\\[' || trimmed === '$$' || !!begin && environment.test(begin[1]!);
    if (opener && !isCode) {
      open = { close: trimmed === '\\[' ? '\\]' : trimmed === '$$' ? '$$' : undefined,
        name: begin?.[1], stack: [], start: offset, body: [], scopes, quotes, size: 0,
        indent: listIndent + /^\s*/.exec(content)![0].length };
      if (open.name) appendEnvironment(trimmed, offset + line.length);
    } else if (!isCode) {
      const single = /^(?:\\\[(.+)\\\]|\$\$(.+)\$\$)$/.exec(trimmed);
      const tex = (single?.[1] ?? single?.[2])?.trim();
      if (tex && tex.length <= 8192) results.push({ tex, start: offset, end: offset + line.length });
    }
    offset += line.length + 1;
  }
  return results;
}
