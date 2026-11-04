import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { findDisplayMath } from '../../core/src/display-math.js';
import { LruCache } from '../../core/src/lru.js';
import { findCodexVisibleMath, findCodexVisibleInlineMath, findCodexVisibleInlineScriptKeys, findCodexVisibleNativeKeys, matchCodexText, type CodexSession, type MatchResult } from './matcher.js';
import { displayPresentations } from './display-presentation.js';
import { findInlineMath, INLINE_GRAMMAR } from '../../core/src/implicit-math.js';
import { inlinePresentationKeys } from './inline-math.js';
import { nativeDisplayKey, renderCodexMath } from './native-display.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const formulaHash = (tex: string) => hash(tex.normalize('NFC').replace(/\s+/gu, ''));
const maxRecord = 8 * 1024 * 1024, maxSource = 1024 * 1024;

interface IndexedFile {
  file: string; session_id: string; cwd: string; identity: string; signature: string;
  size: number; offset: number; head_length: number; head_hash: string; tail_hash: string;
  has_primary: number; seen: number;
}
interface Candidate extends IndexedFile { message_id: number; position: number; length: number; line_hash: string }
export interface HistoryMetrics {
  lookupMs: number; sourceHits: number; sourceMisses: number; sourceReadBytes: number;
  sourceEntries: number; sourceBytes: number; indexedFiles: number; indexedMessages: number;
  indexReadBytes: number; indexing: boolean;
}
export interface HistoryResolution { match: MatchResult; pending: boolean; revision: number; metrics: HistoryMetrics }
export interface HistoryAdapter {
  version: string;
  directory(home: string): string;
  directoryEntry(name: string, depth: number): boolean;
  fileEntry(name: string): boolean;
  record(record: any): { id?: string; cwd?: string; text?: string };
  sourceKeys(text: string): string[];
  keyLength?(key: string): number;
  visibleKeys(text: string, context: string, lengths?: ReadonlySet<number>): string[];
  match(text: string, sessions: CodexSession[], context: string, inline: boolean): MatchResult;
}

/** A rebuildable, local offset index. Original messages remain in Codex JSONL.
 * Used on a separate thread by the Windows companion, never the UI thread.
 * No total-history cutoff; working buffers and source cache have fixed limits. */
export class HistoryIndex {
  readonly directory: string;
  readonly databaseFile: string;
  private readonly db: DatabaseSync;
  private readonly sources = new LruCache<string>(128, 8 * 1024 * 1024);
  private scanning?: Promise<void>;
  private ready = false;
  private closed = false;
  private files = 0;
  private messages = 0;
  private readBytes = 0;
  private nativeLengths?: { revision: number; values: ReadonlySet<number> };
  revision = 0;

  constructor(codexHome: string, cacheDirectory: string, readonly inlineMath = false, private readonly adapter?: HistoryAdapter) {
    this.directory = adapter ? adapter.directory(codexHome) : path.resolve(codexHome, 'sessions');
    mkdirSync(cacheDirectory, { recursive: true });
    // Parser revision: rebuild unchanged historical answers when supported
    // display syntax changes. This cache is derived; Codex logs stay untouched.
    this.databaseFile = path.join(cacheDirectory, `history-${adapter?.version ?? (inlineMath ? INLINE_GRAMMAR + '-v4' : 'v4')}-${hash(this.directory).slice(0, 20)}.sqlite`);
    const connect = () => {
      const db = new DatabaseSync(this.databaseFile);
      try {
        db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;
          PRAGMA busy_timeout=1000;
          CREATE TABLE IF NOT EXISTS files (
            file TEXT PRIMARY KEY, session_id TEXT NOT NULL, cwd TEXT NOT NULL,
            identity TEXT NOT NULL, signature TEXT NOT NULL, size INTEGER NOT NULL, offset INTEGER NOT NULL,
            head_length INTEGER NOT NULL, head_hash TEXT NOT NULL, tail_hash TEXT NOT NULL,
            has_primary INTEGER NOT NULL, seen INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY, file TEXT NOT NULL REFERENCES files(file) ON DELETE CASCADE,
            position INTEGER NOT NULL, length INTEGER NOT NULL, kind INTEGER NOT NULL, line_hash TEXT NOT NULL,
            UNIQUE(file, position));
          CREATE TABLE IF NOT EXISTS formulas (
            hash TEXT NOT NULL, message INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            native_length INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(hash, message));
          CREATE INDEX IF NOT EXISTS formulas_native_length ON formulas(native_length) WHERE native_length>0;
          CREATE INDEX IF NOT EXISTS messages_file ON messages(file);
          CREATE TEMP TABLE discovered(file TEXT PRIMARY KEY);`);
        return db;
      } catch (error) { db.close(); throw error; }
    };
    try { this.db = connect(); }
    catch (error) {
      if (!/corrupt|malformed|not a database/i.test(String(error))) throw error;
      // Only these derived cache files may be removed. Never touch session data.
      for (const suffix of ['', '-wal', '-shm']) rmSync(this.databaseFile + suffix, { force: true });
      this.db = connect();
    }
  }

  get metrics(): HistoryMetrics {
    return { lookupMs: 0, sourceHits: 0, sourceMisses: 0, sourceReadBytes: 0,
      sourceEntries: this.sources.size, sourceBytes: this.sources.bytes,
      indexedFiles: this.files, indexedMessages: this.messages, indexReadBytes: this.readBytes, indexing: !this.ready };
  }

  scan(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.scanning) return this.scanning;
    this.scanning = this.update().finally(() => { this.scanning = undefined; });
    return this.scanning;
  }

  private changed(): void { this.ready = false; this.revision++; }

  private async *discover(directory: string, depth = 0): AsyncGenerator<string> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      if (this.closed) return;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && (this.adapter ? this.adapter.directoryEntry(entry.name, depth) : depth < 3 && /^\d{2,4}$/.test(entry.name))) yield* this.discover(file, depth + 1);
      else if (entry.isFile() && (this.adapter ? this.adapter.fileEntry(entry.name) : /^rollout-.*\.jsonl$/.test(entry.name))) yield file;
    }
  }

  private async update(): Promise<void> {
    // Discovery marks are temporary: idle polling must not rewrite the disk
    // index or grow its WAL just to mark unchanged files as seen again.
    const seen = Date.now();
    this.db.exec('DELETE FROM discovered');
    const discovered = this.db.prepare('INSERT INTO discovered(file) VALUES(?)');
    let changed = false;
    try {
      for await (const file of this.discover(this.directory)) {
        if (this.closed) return;
        const info = await stat(file).catch((error: any) => { if (error.code === 'ENOENT') return; throw error; });
        if (!info) continue;
        discovered.run(file);
        const signature = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
        const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
        const previous = this.db.prepare('SELECT * FROM files WHERE file=?').get(file) as unknown as IndexedFile | undefined;
        if (previous?.signature === signature && previous.identity === identity) {
          continue;
        }
        if (!changed) { this.changed(); changed = true; }
        await this.indexFile(file, identity, signature, info.size, seen, previous);
        await yieldTurn();
      }
      const missing = 'NOT EXISTS(SELECT 1 FROM discovered d WHERE d.file=files.file)';
      const removed = this.db.prepare('SELECT 1 FROM files WHERE ' + missing + ' LIMIT 1').get();
      if (removed) { if (!changed) this.changed(); this.db.prepare('DELETE FROM files WHERE ' + missing).run(); }
      this.files = Number((this.db.prepare('SELECT COUNT(*) AS n FROM files').get() as any).n);
      this.messages = Number((this.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as any).n);
      this.ready = true;
    } catch (error) { this.changed(); throw error; }
  }

  private async readAt(handle: FileHandle, size: number, position: number): Promise<Buffer> {
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, position + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  }

  private async indexFile(file: string, identity: string, signature: string, size: number, seen: number, previous?: IndexedFile) {
    const handle = await open(file, 'r');
    try {
      let append = !!previous && previous.identity === identity && size > previous.size;
      if (append && previous) {
        append = hash(await this.readAt(handle, previous.head_length, 0)) === previous.head_hash &&
          hash(await this.readAt(handle, Math.min(256, previous.offset), Math.max(0, previous.offset - 256))) === previous.tail_hash;
      }
      let offset = append ? previous!.offset : 0;
      let sessionId = append ? previous!.session_id : '', cwd = append ? previous!.cwd : '';
      let primary = append ? previous!.has_primary : 0;
      if (!append) this.db.prepare('DELETE FROM files WHERE file=?').run(file);
      // An unfinished scan must not look complete after a crash. Its signature
      // stays empty until all bytes from the size snapshot have been processed.
      this.db.prepare(`INSERT INTO files VALUES (?, ?, ?, ?, '', ?, ?, 0, '', '', ?, ?)
        ON CONFLICT(file) DO UPDATE SET signature='', seen=excluded.seen`).run(file, sessionId, cwd, identity, size, offset, primary, seen);
      const insert = this.db.prepare('INSERT OR IGNORE INTO messages(file, position, length, kind, line_hash) VALUES(?,?,?,?,?)');
      const insertFormula = this.db.prepare('INSERT OR IGNORE INTO formulas(hash, message) VALUES(?,?)');
      const insertNative = this.db.prepare('INSERT OR IGNORE INTO formulas(hash, message, native_length) VALUES(?,?,?)');
      let carry: Buffer = Buffer.alloc(0), dropping = false, lineStart = offset, position = offset;
      while (position < size) {
        if (this.closed) return;
        const chunk = await this.readAt(handle, Math.min(256 * 1024, size - position), position);
        if (!chunk.length) break;
        this.readBytes += chunk.length;
        let start = 0;
        this.db.exec('BEGIN');
        try {
          for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
            const part = chunk.subarray(start, end);
            if (!dropping && carry.length + part.length <= maxRecord) {
              const line = carry.length ? Buffer.concat([carry, part]) : part;
              try {
                const record = JSON.parse(line.toString('utf8')), payload = record.payload;
                const adapted = this.adapter?.record(record);
                if (adapted?.id && adapted.cwd) { sessionId = adapted.id; cwd = adapted.cwd; }
                if (record.type === 'session_meta' && typeof (payload?.id ?? payload?.session_id) === 'string' && typeof payload.cwd === 'string') {
                  sessionId = payload.id ?? payload.session_id; cwd = payload.cwd;
                }
                let text: string | undefined, kind = 0;
                if (this.adapter) { text = adapted?.text; kind = 1; primary = 1; }
                else if (record.type === 'response_item' && payload?.type === 'message' && payload.role === 'assistant') {
                  kind = 1;
                  text = (Array.isArray(payload.content) ? payload.content : []).filter((x: any) => x?.type === 'output_text' && typeof x.text === 'string')
                    .map((x: any) => x.text).join('\n');
                  if (text && text.length <= maxSource) primary = 1;
                } else if (record.type === 'event_msg' && payload?.type === 'agent_message' && typeof payload.message === 'string') text = payload.message;
                if (text && text.length <= maxSource) {
                  const displays = this.adapter ? [] : findDisplayMath(text);
                  const hashes = new Set(displays.flatMap(formula => displayPresentations(formula.tex).map(formulaHash)));
                  const natives = new Map<string, number>();
                  if (this.adapter) for (const key of this.adapter.sourceKeys(text)) {
                    const length=this.adapter.keyLength?.(key) ?? 0;
                    if(length>0) natives.set(hash(key),length); else hashes.add(hash(key));
                  }
                  for (const formula of displays) for (const mode of ['inline', 'display'] as const) {
                    const native = renderCodexMath(mode === 'inline' ? formula.tex.replace(/[\r\n]+/g, ' ') : formula.tex, mode);
                    const key = native === undefined ? undefined : nativeDisplayKey(native);
                    if (key) natives.set(hash(key.key), key.length);
                  }
                  if (!this.adapter && this.inlineMath) for (const span of findInlineMath(text)) for (const key of inlinePresentationKeys(span)) hashes.add(hash(key));
                  if (hashes.size || natives.size) {
                    const result = insert.run(file, lineStart, line.length, kind, hash(line));
                    const messageId = result.changes ? result.lastInsertRowid :
                      (this.db.prepare('SELECT id FROM messages WHERE file=? AND position=?').get(file, lineStart) as any).id;
                    for (const digest of hashes) insertFormula.run(digest, messageId);
                    for (const [digest, length] of natives) insertNative.run(digest, messageId, length);
                  }
                }
              } catch (error) {
                if (!(error instanceof SyntaxError)) throw error; // Incomplete/malformed JSON is never evidence.
              }
            }
            carry = Buffer.alloc(0); dropping = false;
            offset = position + end + 1; lineStart = offset; start = end + 1;
          }
          const remainder = chunk.subarray(start);
          if (!dropping && carry.length + remainder.length <= maxRecord)
            carry = carry.length ? Buffer.concat([carry, remainder]) : Buffer.from(remainder);
          else { carry = Buffer.alloc(0); dropping = true; }
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        position += chunk.length;
        await yieldTurn();
      }
      const headLength = Math.min(4096, offset);
      const headHash = hash(await this.readAt(handle, headLength, 0));
      const tailHash = hash(await this.readAt(handle, Math.min(256, offset), Math.max(0, offset - 256)));
      this.db.prepare(`UPDATE files SET session_id=?, cwd=?, identity=?, signature=?, size=?, offset=?,
        head_length=?, head_hash=?, tail_hash=?, has_primary=?, seen=? WHERE file=?`)
        .run(sessionId, cwd, identity, signature, size, offset, headLength, headHash, tailHash, primary, seen, file);
    } finally { await handle.close(); }
  }

  async resolve(text: string, leadingContext = '', signal?: AbortSignal): Promise<HistoryResolution> {
    const started = performance.now(), revision = this.revision;
    const metrics = this.metrics;
    const match = this.adapter?.match ?? matchCodexText;
    const empty = match(text, [], leadingContext, this.inlineMath);
    const done = (match: MatchResult = empty, pending = false): HistoryResolution => ({ match: pending ? empty : match,
      pending, revision: this.revision, metrics: { ...metrics, sourceEntries: this.sources.size, sourceBytes: this.sources.bytes,
        lookupMs: performance.now() - started, indexing: !this.ready } });
    if (!this.ready || this.closed) return done(empty, true);
    if (this.nativeLengths?.revision !== revision) this.nativeLengths = { revision,
      values: new Set((this.db.prepare('SELECT DISTINCT native_length AS n FROM formulas WHERE native_length>0').all() as { n: number }[])
        .map(row => Number(row.n))) };
    const visible = this.adapter ? [] : findCodexVisibleMath(text, leadingContext);
    const hashes = this.adapter ? this.adapter.visibleKeys(text, leadingContext, this.nativeLengths.values).map(hash) : [...new Set(visible.map(formula => formulaHash(formula.tex)))];
    const inline = !this.adapter && this.inlineMath ? findCodexVisibleInlineMath(text, leadingContext) : [];
    hashes.push(...inline.flatMap(span => inlinePresentationKeys(span).map(hash)));
    if (!this.adapter && this.inlineMath) hashes.push(...findCodexVisibleInlineScriptKeys(text, leadingContext).map(hash));
    const native = this.adapter ? [] : findCodexVisibleNativeKeys(text, leadingContext, this.nativeLengths.values);
    hashes.push(...native.map(hash));
    if (!hashes.length) return done();
    const digests = [...new Set(hashes)];
    // Seek each (hash, message) index directly, then merge one small page.
    // DISTINCT/ORDER BY over a joined full candidate set can repeatedly sort
    // the entire remaining history, despite an outer LIMIT, on broad searches.
    const seek = this.db.prepare('SELECT message FROM formulas WHERE hash=? AND message>? ORDER BY message LIMIT 64');
    let after = 0;
    const matches = new Map<string, { id: string; regions: Map<string, MatchResult['regions'][number]>;
      verifiedRanges: Map<string, { startRow: number; endRow: number }> }>();
    const checked = new Set<string>();
    const visibleCount = this.adapter ? Infinity : visible.length + inline.length;
    while (true) {
      signal?.throwIfAborted();
      if (!this.ready || this.revision !== revision) return done(empty, true);
      const ids = [...new Set(digests.flatMap(digest => seek.all(digest, after).map(row => Number(row.message))))]
        .sort((a, b) => a - b).slice(0, 64);
      if (!ids.length) break;
      after = ids.at(-1)!;
      const rows = this.db.prepare(`SELECT f.*, m.id AS message_id, m.position, m.length, m.line_hash
        FROM messages m JOIN files f ON f.file=m.file WHERE m.id IN (${ids.map(() => '?').join(',')})
        AND f.session_id<>'' AND f.cwd<>'' AND (m.kind=1 OR f.has_primary=0) ORDER BY m.id`)
        .all(...ids) as unknown as Candidate[];
      for (const row of rows) {
        signal?.throwIfAborted();
        if (!this.ready || this.revision !== revision) return done(empty, true);
        if (!native.length && matches.get(row.file)?.regions.size === visibleCount) continue;
        if (!checked.has(row.file)) {
          const info = await stat(row.file).catch(() => undefined);
          if (!info || `${info.size}:${info.mtimeMs}:${info.ctimeMs}` !== row.signature ||
              `${info.dev}:${info.ino}:${info.birthtimeMs}` !== row.identity) {
            this.changed(); return done(empty, true);
          }
          checked.add(row.file);
        }
        const key = `${row.file}\0${row.signature}\0${row.position}`;
        let source = this.sources.get(key);
        if (source === undefined) {
          metrics.sourceMisses++;
          const handle = await open(row.file, 'r').catch(() => undefined);
          if (!handle) { this.changed(); return done(empty, true); }
          let bytes;
          try { bytes = await this.readAt(handle, row.length, row.position); }
          finally { await handle.close(); }
          metrics.sourceReadBytes += bytes.length;
          if (hash(bytes) !== row.line_hash) { this.changed(); return done(empty, true); }
          try {
            const record = JSON.parse(bytes.toString('utf8')), payload = record.payload;
            source = this.adapter ? this.adapter.record(record).text : record.type === 'response_item' ? payload.content.filter((x: any) => x?.type === 'output_text' && typeof x.text === 'string')
              .map((x: any) => x.text).join('\n') : payload.message;
          } catch { this.changed(); return done(empty, true); }
          if (typeof source !== 'string') { this.changed(); return done(empty, true); }
          this.sources.set(key, source, source.length * 2);
        } else metrics.sourceHits++;
        const session: CodexSession = { id: row.session_id, cwd: row.cwd, file: row.file, assistant: [source] };
        const proof = match(text, [session], leadingContext, this.inlineMath);
        if (proof.state === 'matched') {
          const existing = matches.get(row.file) ?? { id: row.session_id, regions: new Map(), verifiedRanges: new Map() };
          for (const region of proof.regions) existing.regions.set(`${region.startRow}:${region.endRow}:${region.startColumn}:${region.endColumn}:${region.kind ?? 'display'}`, region);
          for (const range of proof.verifiedRanges ?? []) existing.verifiedRanges.set(`${range.startRow}:${range.endRow}`, range);
          matches.set(row.file, existing);
          // Two verified sessions are sufficient to prove ambiguity, never
          // choose the first or the newest from an arbitrary candidate limit.
          if (matches.size > 1) return done({ ...empty, state: 'ambiguous' });
        }
        await yieldTurn(); // Let a new viewport cancel a large candidate search.
      }
      await yieldTurn();
    }
    if (!this.ready || this.revision !== revision) return done(empty, true);
    const selected = matches.values().next().value;
    return done(selected ? { ...empty, state: 'matched', sessionId: selected.id,
      verifiedRanges: [...selected.verifiedRanges.values()].sort((a, b) => a.startRow - b.startRow),
      regions: [...selected.regions.values()].sort((a, b) => a.startRow - b.startRow) } : empty);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.scanning?.catch(() => {});
    this.sources.clear(); this.db.close();
  }
}
