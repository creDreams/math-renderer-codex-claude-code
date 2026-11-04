import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { CodexSession } from './matcher.js';

export function parseSession(contents: string, file: string): CodexSession | undefined {
  let id = '', cwd = '';
  const assistant: string[] = [];
  const fallback: string[] = [];
  for (const line of contents.split('\n')) {
    try {
      const record = JSON.parse(line);
      const payload = record.payload;
      if (!payload) continue;
      if (record.type === 'session_meta') {
        id = payload.id ?? payload.session_id;
        cwd = payload.cwd;
      }
      if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
        const text = (Array.isArray(payload.content) ? payload.content : []).filter((x: any) => x?.type === 'output_text' && typeof x.text === 'string')
          .map((x: any) => x.text).join('\n');
        if (text && text.length <= 65536) assistant.push(text);
      }
      if (record.type === 'event_msg' && payload.type === 'agent_message' && typeof payload.message === 'string') {
        if (payload.message.length <= 65536) fallback.push(payload.message);
      }
    } catch { /* Incomplete trailing JSONL record: retry on the next file revision. */ }
  }
  if (typeof id !== 'string' || !id || typeof cwd !== 'string' || !cwd) return;
  return { id, cwd, file, assistant: (assistant.length ? assistant : fallback).slice(-80) };
}

export function sameDirectory(a: string, b: string): boolean {
  const normalize = (value: string) => {
    const normalized = value.replace(/^\\\\\?\\/, '').replaceAll('\\', '/').replace(/\/$/, '');
    return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  return normalize(a) === normalize(b);
}

/** Bounded, read-only discovery. No auth/config files or output-stream subscriptions. */
export class SessionStore {
  private readonly cache = new Map<string, { signature: string; session?: CodexSession }>();
  private pending?: Promise<CodexSession[]>;
  private updated = 0;
  private sessions: CodexSession[] = [];
  readonly directory: string;

  constructor(codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')) {
    this.directory = path.join(codexHome, 'sessions');
  }

  async refresh(): Promise<CodexSession[]> {
    if (this.pending) return this.pending;
    if (Date.now() - this.updated < 1500) return this.sessions;
    this.pending = this.load();
    try { return await this.pending; }
    finally { this.pending = undefined; }
  }

  private async load(): Promise<CodexSession[]> {
    const files: string[] = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 3 || files.length >= 160) return;
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
        if (files.length >= 160) break;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) await visit(file, depth + 1);
        else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(file);
      }
    };
    await visit(this.directory, 0);
    const readSession = async (file: string): Promise<CodexSession | undefined> => {
      try {
        const info = await stat(file);
        const signature = `${info.size}:${info.mtimeMs}`;
        if (this.cache.get(file)?.signature === signature) return this.cache.get(file)?.session;
        const handle = await open(file, 'r');
        let contents: string;
        try {
          const max = 4 * 1024 * 1024;
          const readAt = async (size: number, position: number) => {
            const buffer = Buffer.alloc(size);
            let offset = 0;
            while (offset < size) {
              const { bytesRead } = await handle.read(buffer, offset, size - offset, position + offset);
              if (!bytesRead) break;
              offset += bytesRead;
            }
            return buffer.subarray(0, offset).toString('utf8');
          };
          // Reading a live append-only file must stay bounded even when it
          // grows between stat() and read(). Retry new bytes on the next refresh.
          if (info.size <= max) contents = await readAt(info.size, 0);
          else {
            const head = await readAt(256 * 1024, 0), tail = await readAt(max, info.size - max);
            contents = head.split('\n')[0] + '\n' + tail.split('\n').slice(1).join('\n');
          }
        } finally { await handle.close(); }
        const session = parseSession(contents, file);
        this.cache.set(file, { signature, session });
        return session;
      } catch { return undefined; }
    };
    const results: (CodexSession | undefined)[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
      while (next < files.length) {
        const index = next++;
        results[index] = await readSession(files[index]!);
      }
    }));
    for (const file of this.cache.keys()) if (!files.includes(file)) this.cache.delete(file);
    this.sessions = results.filter((x): x is CodexSession => !!x);
    this.updated = Date.now();
    return this.sessions;
  }
}
