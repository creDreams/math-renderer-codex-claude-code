import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HistoryIndex } from '../packages/adapter-codex/src/history-index.js';
import { findDisplayMath } from '../packages/core/src/display-math.js';
import { LruCache } from '../packages/core/src/lru.js';
import { DatabaseSync } from 'node:sqlite';

const meta = (id: string) => JSON.stringify({ type: 'session_meta', payload: { id, cwd: 'D:/fixture' } }) + '\n';
const record = (text: string, role = 'assistant') => JSON.stringify({ type: 'response_item', payload: {
  type: 'message', role, content: [{ type: 'output_text', text }] } }) + '\n';
const message = (n: number) => `Historical derivation ${n} includes 中文, e\u0301 and 🧮.\n\\[\n\\frac{${n}+a}{b}=x\n\\]\nThis concludes the independently verified explanation.`;
const screen = (text: string) => '• ' + text.replaceAll('\n', '\r\n  ') + '\r\n  Worked for 6s • 02:31\r\n› input';
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'amt-history-'));
  const home = path.join(root, 'codex'), cache = path.join(root, 'cache'), directory = path.join(home, 'sessions/2026/11/03');
  await mkdir(directory, { recursive: true });
  const indexes: HistoryIndex[] = [];
  t.after(async () => {
    for (const index of indexes) await index.close();
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'amt-history-')));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, home, cache, directory, open(inline = false) { const index = new HistoryIndex(home, cache, inline); indexes.push(index); return index; } };
}
function renders(result: Awaited<ReturnType<HistoryIndex['resolve']>>, source: string) {
  assert.equal(result.pending, false);
  assert.equal(result.match.state, 'matched');
  assert.deepEqual(result.match.regions.map(x => x.tex), findDisplayMath(source).map(x => x.tex));
}

test('parser revision rebuilds unchanged old environment answers and persists their lookup across restart', async t => {
  const f = await fixture(t), first = f.open();
  const tex = '\\begin{align*}\nx&=y\\\\\nz&=w\n\\end{align*}';
  const source = 'Historical environment answer includes independently verified surrounding prose.\n' + tex + '\nFinished.';
  await writeFile(path.join(f.directory, 'rollout-environment.jsonl'), meta('environment') + record(source));
  await writeFile(path.join(f.directory, 'rollout-code.jsonl'), meta('code') + record(source, 'user') +
    record(source, 'tool') + record('```tex\n' + source + '\n```'));
  // Simulate the previous derived index: unchanged files already scanned, but
  // no environment formulas indexed. Do not modify the original session logs.
  await first.scan(); await first.close();
  const legacy = first.databaseFile.replace('history-v4-', 'history-v3-');
  await writeFile(legacy, await readFile(first.databaseFile));
  const db = new DatabaseSync(legacy); db.exec('DELETE FROM formulas; DELETE FROM messages'); db.close();
  const previous = await readFile(legacy);
  await rm(first.databaseFile);
  const rebuilt = f.open();
  assert.match(rebuilt.databaseFile, /history-v4-/);
  await rebuilt.scan(); renders(await rebuilt.resolve(screen(source)), source);
  assert.equal(rebuilt.metrics.indexedMessages, 1, 'code and non-assistant environments are not indexed');
  assert.deepEqual(await readFile(legacy), previous, 'the legacy derived database is not opened or changed');
  await rebuilt.close();
  const reopened = f.open(); await reopened.scan();
  assert.equal(reopened.metrics.indexReadBytes, 0, 'an unchanged new index is reusable');
  renders(await reopened.resolve(screen(source)), source);
});

test('disk history forwards only verified candidate anchors during progress and the next answer', async t => {
  const f = await fixture(t), index = f.open(), source = message(31), next = message(32);
  const file = path.join(f.directory, 'rollout-stream.jsonl');
  await writeFile(file, meta('stream') + record(source)); await index.scan();
  const baseline = await index.resolve(screen(source));
  assert.ok(baseline.match.verifiedRanges?.length);
  for (const tail of ['• Working (0s • esc to interrupt)', '◦ Working (1s • esc to interrupt)', screen(next)]) {
    const result = await index.resolve(screen(source) + '\r\n' + tail + '\r\n› Input');
    renders(result, source);
    assert.deepEqual(result.match.verifiedRanges, baseline.match.verifiedRanges);
  }
  const combined = screen(source) + '\r\n' + screen(next);
  await appendFile(file, record(next)); await index.scan();
  const both = await index.resolve(combined);
  assert.equal(both.match.regions.length, 2); assert.equal(both.match.verifiedRanges?.length, 2);
  for (const formula of both.match.regions) assert.ok(both.match.verifiedRanges!.some(range =>
    formula.startRow >= range.startRow && formula.endRow <= range.endRow));
  await writeFile(path.join(f.directory, 'rollout-conflict.jsonl'), meta('conflict') + record(next)); await index.scan();
  const ambiguous = await index.resolve(combined);
  assert.equal(ambiguous.match.state, 'ambiguous'); assert.equal(ambiguous.match.verifiedRanges, undefined);
});

test('environment candidate hashes include the observed Codex escape presentation but render original TeX', async t => {
  const f = await fixture(t), index = f.open();
  const original = '\\begin{align*}\nf(x)&=x^2\\\\\ng(x)&=x+1\n\\end{align*}';
  const shown = '\\begin{align*}\nf(x)&=x^2\\\ng(x)&=x+1\n\\end{align*}';
  const source = 'The independently verified environment explains both functions.\n' + original + '\nFinished.';
  const file = path.join(f.directory, 'rollout-escape.jsonl');
  await writeFile(file, meta('escape') + record(source)); await index.scan();
  const result = await index.resolve(screen(source.replace(original, shown)));
  assert.equal(result.match.state, 'matched');
  assert.deepEqual(result.match.regions.map(x => x.tex), [original]);
  assert.equal((await index.resolve(screen(source.replace(original, shown).replace('x+1', 'x-1')))).match.regions.length, 0);
  await writeFile(path.join(f.directory, 'rollout-other-meaning.jsonl'), meta('other-meaning') + record(source.replace(original, shown)));
  await index.scan();
  assert.equal((await index.resolve(screen(source.replace(original, shown)))).match.state, 'ambiguous',
    'different canonical TeX with identical visible escapes cannot borrow a source proof');
});

test('on-demand history finds old formulas beyond 160 files, 80 answers and a 4 MiB log tail', async t => {
  const f = await fixture(t), index = f.open(), source = message(1);
  const file = path.join(f.directory, 'rollout-000-old.jsonl');
  await writeFile(file, meta('old') + record(source) + JSON.stringify({ type: 'tool', payload: '中'.repeat(1500000) }) + '\n' +
    Array.from({ length: 240 }, (_, i) => record(message(i + 2))).join(''));
  for (let i = 0; i < 170; i++) await writeFile(path.join(f.directory, `rollout-new-${i}.jsonl`), meta('new-' + i));
  assert.equal((await index.resolve(screen(source))).pending, true, 'unindexed history cannot prove uniqueness');
  await index.scan();
  const cold = await index.resolve(screen(source)); renders(cold, source);
  assert.equal(cold.metrics.indexedFiles, 171); assert.equal(cold.metrics.indexedMessages, 241);
  assert.ok(cold.metrics.sourceReadBytes < 2000, 'a lookup reads only its indexed JSONL record');
  const warm = await index.resolve(screen(source)); renders(warm, source);
  assert.equal(warm.metrics.sourceReadBytes, 0); assert.equal(warm.metrics.sourceHits, 1);
  const before = index.metrics.indexReadBytes;
  await index.scan(); assert.equal(index.metrics.indexReadBytes, before, 'unchanged logs are not rescanned');
  // A fresh process can reuse offsets without reparsing any session bodies.
  const reopened = f.open(); await reopened.scan();
  assert.equal(reopened.metrics.indexReadBytes, 0); renders(await reopened.resolve(screen(source)), source);
});

test('history candidate hashes retain dollar delimiter state when the viewport starts inside an earlier formula', async t => {
  const f = await fixture(t), index = f.open();
  const heading = 'This historical derivation explains the sampling distribution and its transformed target.';
  const first = '$$\nq_s(v)\\propto p_0(v)^{1/T}\n$$';
  const second = '$$\np_{\\mathrm{SSD}}(v)^{1/T}\\approx q_s(v)^{1/T}\\propto p_0(v)^{1/T^2}\n$$';
  const source = heading + '\n\n' + first + '\n\nThe next complete equation follows the preceding local approximation.\n\n' + second +
    '\n\nThe remaining explanation keeps the support fixed and states the assumptions explicitly.';
  await writeFile(path.join(f.directory, 'rollout-dollar.jsonl'), meta('dollar-history') + record(source));
  await index.scan();
  const lines = source.split('\n');
  for (const top of [3, 4, 5, 6]) {
    const visible = '  ' + lines.slice(top).join('\r\n  ');
    const leading = '• ' + lines.slice(0, top).join('\r\n  ') + '\r\n';
    const result = await index.resolve(visible, leading);
    assert.equal(result.match.state, 'matched', 'viewport top ' + top);
    assert.deepEqual(result.match.regions.map(x => x.tex), findDisplayMath(second).map(x => x.tex));
    assert.equal((await index.resolve(visible, leading.replace('• ', '› '))).match.regions.length, 0);
  }
});

test('append, incomplete UTF-8 records, replacement, truncation and removal invalidate proofs', async t => {
  const f = await fixture(t), index = f.open(), source = message(7), file = path.join(f.directory, 'rollout-live.jsonl');
  const bytes = Buffer.from(record(source));
  const cut = bytes.indexOf(Buffer.from('中')) + 1;
  await writeFile(file, Buffer.concat([Buffer.from(meta('live')), bytes.subarray(0, cut)]));
  await index.scan(); assert.equal((await index.resolve(screen(source))).match.state, 'waiting');
  await appendFile(file, bytes.subarray(cut)); await index.scan(); renders(await index.resolve(screen(source)), source);
  const later = message(8); await appendFile(file, record(later));
  assert.equal((await index.resolve(screen(source))).pending, true, 'a changed source cannot use a cached proof');
  await index.scan(); renders(await index.resolve(screen(later)), later); renders(await index.resolve(screen(source)), source);
  const replacement = message(9); await writeFile(file, meta('replaced') + record(replacement));
  await index.scan(); assert.equal((await index.resolve(screen(source))).match.state, 'waiting');
  renders(await index.resolve(screen(replacement)), replacement);
  await writeFile(file, meta('empty')); await index.scan(); assert.equal((await index.resolve(screen(replacement))).match.state, 'waiting');
  await rm(file); await index.scan(); assert.equal(index.metrics.indexedFiles, 0);
});

test('shared formulas across old and new sessions stay ambiguous; wrong roles and code do not become candidates', async t => {
  const f = await fixture(t), index = f.open(), source = message(11);
  for (const id of ['old', 'new']) await writeFile(path.join(f.directory, `rollout-${id}.jsonl`), meta(id) + record(source));
  await writeFile(path.join(f.directory, 'rollout-untrusted.jsonl'), meta('untrusted') + record(source, 'user') +
    record(source, 'tool') + record('```tex\n' + source + '\n```') + '{malformed}\n');
  await index.scan();
  const result = await index.resolve(screen(source)); assert.equal(result.match.state, 'ambiguous');
  assert.equal(result.match.regions.length, 0);
  await rm(path.join(f.directory, 'rollout-new.jsonl')); await index.scan(); renders(await index.resolve(screen(source)), source);
  assert.equal((await index.resolve(screen(source).replace('• ', '› '))).match.regions.length, 0);
});

test('common scripts do not broaden exact, native, mixed or wrapped viewport history reads', async t => {
  const f = await fixture(t);
  const block = (tex: string) => '\\[\n' + tex + '\n\\]';
  const tex = (n: number) => `G_{i,t}=\\sum_{k=t}^{T}\\gamma^{k-t}r_{i,k}+${n}.`;
  const native = (n: number) => `          T\nG_{i,t}= ∑ γᵏ⁻ᵗr_{i,k}+${n}.\n         k=t`;
  const source = (n: number) => `Independently verified historical derivation number ${n}.\n\n` + block(tex(n)) +
    '\n\nA second independently explained objective.\n\n' + block(`\\mathbb E_q[Q]-\\eta\\mathrm{KL}(q\\|p)+${n}.`) + '\nFinished.';
  for (let file = 0; file < 30; file++) await writeFile(path.join(f.directory, `rollout-scripts-${file}.jsonl`),
    meta('scripts-' + file) + Array.from({ length: 20 }, (_, i) => record(source(file * 20 + i))).join(''));
  const target = source(599), shown = target.replace(block(tex(599)), native(599));
  for (const inline of [false, true]) {
    const index = f.open(inline); await index.scan();
    for (const [label, text] of [['explicit', target], ['mixed', shown]] as const) {
      for (const columns of [13, 45, 300]) {
        const wrapped = text.split('\n').flatMap(line => {
          const rows = []; for (let i = 0; i < line.length; i += columns) rows.push(line.slice(i, i + columns));
          return rows.length ? rows : [''];
        }).join('\n');
        const result = await index.resolve(screen(wrapped));
        assert.equal(result.match.state, 'matched');
        const expected = findDisplayMath(target).map(formula => formula.tex);
        assert.deepEqual(result.match.regions.map(region => region.tex), label === 'mixed' && !inline ? expected.slice(1) : expected);
        assert.equal(result.metrics.sourceHits + result.metrics.sourceMisses, 1,
          `${label} at width ${columns}, inline=${inline} must read only the exact source, not 600 common-script answers`);
      }
    }
    const prefix = shown.slice(0, shown.indexOf(native(599)));
    const clipped = await index.resolve('  ' + native(599).replaceAll('\n', '\r\n  '),
      '• ' + prefix.replaceAll('\n', '\r\n  '));
    assert.deepEqual(clipped.match.regions.map(region => region.tex), inline ? [tex(599)] : []);
    assert.equal(clipped.metrics.sourceHits + clipped.metrics.sourceMisses, 1);
  }
});

test('precise native lookup keeps hidden code separate and checks competing sessions and changed lengths', async t => {
  const f = await fixture(t), index = f.open(true);
  const literal = '\\[\nx_{i,j}+1\n\\]';
  const nativeTex = '\\boxed{\\hat A_{i,t}=A_i^{E}+\\omega A_{i,t}^{S}}';
  const native = '┌──────────────────────────────┐\n│ Â_{i,t}=Aᵢ^{E}+ω A_{i,t}^{S} │\n└──────────────────────────────┘';
  const source = 'An independently verified answer keeps this first example as protected code.\n\n```tex\n' + literal +
    '\n```\n\nThe real boxed objective follows the example.\n\n\\[\n' + nativeTex + '\n\\]\nFinished.';
  const shown = source.replace('```tex\n', '').replace('\n```', '').replace('\\[\n' + nativeTex + '\n\\]', native);
  const file = path.join(f.directory, 'rollout-code-native.jsonl');
  await writeFile(file, meta('code-native') + record(source)); await index.scan();
  let result = await index.resolve(screen(shown));
  assert.equal(result.match.state, 'matched'); assert.deepEqual(result.match.regions.map(region => region.tex), [nativeTex]);
  await writeFile(path.join(f.directory, 'rollout-other.jsonl'), meta('other') + record(source)); await index.scan();
  assert.equal((await index.resolve(screen(shown))).match.state, 'ambiguous', 'precise hints must not bypass source uniqueness');
  await rm(path.join(f.directory, 'rollout-other.jsonl'));
  const longer = source.replace('A_i^{E}', 'A_i^{EFG}'), longerShown = shown.replace('Aᵢ^{E}', 'Aᵢ^{EFG}');
  // Refresh the independently observed box to fit the longer inner label.
  const expanded = longerShown.replaceAll('──────────────────────────────', '────────────────────────────────');
  await writeFile(file, meta('code-native') + record(longer)); await index.scan();
  result = await index.resolve(screen(expanded));
  assert.equal(result.match.state, 'matched');
  assert.deepEqual(result.match.regions.map(region => region.tex), [nativeTex.replace('A_i^{E}', 'A_i^{EFG}')]);
  assert.equal((await index.resolve(screen(shown))).match.regions.length, 0, 'old native keys do not prove a changed source');
});

test('native marked inline atoms have exact hints while unmarked identifiers and code stay literal', async t => {
  const f = await fixture(t), index = f.open(true);
  const source = 'This independently verified answer defines the marked variable \\(a_{i,t}\\) here.\n' +
    'The code example `a_{i,t}` stays literal, as does the unmarked identifier b_{j,t}.';
  const shown = source.replace('\\(a_{i,t}\\)', 'a_{i,t}').replace('`a_{i,t}`', 'a_{i,t}');
  await writeFile(path.join(f.directory, 'rollout-atom.jsonl'), meta('atom') + record(source)); await index.scan();
  const result = await index.resolve(screen(shown));
  assert.equal(result.match.state, 'matched');
  assert.deepEqual(result.match.regions.map(region => [region.kind, region.tex]), [['inline', 'a_{i,t}']]);
  assert.equal(result.metrics.sourceHits + result.metrics.sourceMisses, 1);
});

test('event fallbacks are used only until canonical assistant records are available', async t => {
  const f = await fixture(t), index = f.open(), file = path.join(f.directory, 'rollout-events.jsonl'), source = message(12);
  await writeFile(file, meta('events') + JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: source } }) + '\n');
  await index.scan(); renders(await index.resolve(screen(source)), source);
  await appendFile(file, record('A canonical assistant message without any display math.')); await index.scan();
  assert.equal((await index.resolve(screen(source))).match.state, 'waiting');
});

test('fully filtered candidate pages cannot hide a later valid source', async t => {
  const f = await fixture(t), index = f.open(), source = message(13);
  const fallback = JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: source } }) + '\n';
  await writeFile(path.join(f.directory, 'rollout-z-fallback.jsonl'), meta('fallback') + fallback.repeat(140) + record('Canonical source without math.'));
  await writeFile(path.join(f.directory, 'rollout-a-valid.jsonl'), meta('valid') + record(source));
  await index.scan();
  const result = await index.resolve(screen(source)); renders(result, source);
  assert.equal(result.match.sessionId, 'valid');
});

test('source LRU evicts memory without removing historical coverage and supports cancellation', async t => {
  const f = await fixture(t), index = f.open(), file = path.join(f.directory, 'rollout-many.jsonl');
  await writeFile(file, meta('many') + Array.from({ length: 145 }, (_, i) => record(message(i))).join(''));
  await index.scan();
  for (let i = 0; i < 145; i++) renders(await index.resolve(screen(message(i))), message(i));
  assert.equal(index.metrics.sourceEntries, 128); assert.ok(index.metrics.sourceBytes <= 8 * 1024 * 1024);
  const evicted = await index.resolve(screen(message(0))); renders(evicted, message(0)); assert.equal(evicted.metrics.sourceMisses, 1);
  assert.equal((await index.resolve(screen(message(0)))).metrics.sourceHits, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(index.resolve(screen(message(0)), '', controller.signal), { name: 'AbortError' });
  renders(await index.resolve(screen(message(144))), message(144));
});

test('oversized tool lines are skipped with bounded buffers and a damaged derived index rebuilds', async t => {
  const f = await fixture(t), file = path.join(f.directory, 'rollout-big.jsonl'), source = message(20);
  await writeFile(file, meta('big') + JSON.stringify({ type: 'tool', payload: 'x'.repeat(9 * 1024 * 1024) }) + '\n' + record(source));
  const index = f.open(); await index.scan(); renders(await index.resolve(screen(source)), source);
  const database = index.databaseFile;
  // Close explicitly; the fixture cleanup also tolerates an already closed index.
  await index.close();
  await writeFile(database, 'damaged derived cache');
  const recovered = f.open(); await recovered.scan(); renders(await recovered.resolve(screen(source)), source);
  assert.ok(!(await readFile(database)).includes(Buffer.from('damaged derived cache')));
});

test('LRU promotes reads, enforces byte and entry budgets, and does not retain an oversized item', () => {
  const cache = new LruCache<number>(2, 10);
  cache.set('a', 1, 4); cache.set('b', 2, 4); assert.equal(cache.get('a'), 1);
  cache.set('c', 3, 4); assert.equal(cache.get('b'), undefined); assert.equal(cache.get('a'), 1);
  cache.set('a', 4, 8); assert.equal(cache.get('c'), undefined); assert.equal(cache.bytes, 8);
  cache.set('huge', 5, 11); assert.equal(cache.get('huge'), undefined); assert.equal(cache.get('a'), 4);
  cache.clear(); assert.equal(cache.size, 0); assert.equal(cache.bytes, 0);
});
