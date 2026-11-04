import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const inline = process.argv.includes('--inline');
const directoryArg = process.argv.indexOf('--binary-dir');
const binaryDirectory = path.resolve(directoryArg < 0 ? 'dist/windows' : process.argv[directoryArg + 1]);
const root = path.resolve('.cache/lazy-history-' + Date.now().toString(36));
const home = path.join(root, 'codex'), cache = path.join(root, 'cache'), directory = path.join(home, 'sessions/2026/11/03');
const checks = [], timings = [], pause = ms => new Promise(resolve => setTimeout(resolve, ms));
await mkdir(directory, { recursive: true }); await mkdir('test-results', { recursive: true });
const record = text => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text }] } }) + '\n';
const meta = id => JSON.stringify({ type: 'session_meta', payload: { id, cwd: 'D:/fixture' } }) + '\n';
const source = n => `Historical equation ${n}: the verified derivation includes 中文 and 🧮.\n` +
  (inline ? `圆的公式 f(x) = x^2 + ${n}，后文继续说明。` : `\\[\n\\frac{${n}+a}{b}=x\n\\]`) +
  '\nThis concludes the independently verified explanation.';
const screen = text => '• ' + text.replaceAll('\n', '\r\n  ') + '\r\n  Worked for 6s • 02:31\r\n› input';
const tool = JSON.stringify({ type: 'tool', payload: 'x'.repeat(256 * 1024) }) + '\n';
let datasetBytes = 0;
for (let i = 0; i < 240; i++) {
  const body = meta('history-' + i) + Array.from({ length: 40 }, (_, j) => record(source(i * 40 + j))).join('') +
    tool.repeat(i === 0 ? 20 : 1);
  datasetBytes += Buffer.byteLength(body);
  await writeFile(path.join(directory, `rollout-${String(i).padStart(4, '0')}.jsonl`), body);
}
const passed = label => { checks.push(label); console.log('PASS ' + label); };
let worker, nextId = 0, buffer = '', waiters, readyResolve, stderr = '';
const replies = [];
let peakRssBytes = 0;
async function start() {
  buffer = ''; stderr = ''; waiters = new Map();
  const ready = new Promise(resolve => { readyResolve = resolve; });
  worker = spawn(path.join(binaryDirectory, 'runtime/node.exe'), [path.join(binaryDirectory, 'worker.cjs')], {
    cwd: root, windowsHide: true, env: { ...process.env, CODEX_HOME: home, AGENT_MATH_CACHE_DIR: cache,
      AGENT_MATH_INLINE_MATH: inline ? '1' : '0', NODE_OPTIONS: '' },
  });
  worker.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  worker.stdout.setEncoding('utf8');
  worker.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const response = JSON.parse(line);
      peakRssBytes = Math.max(peakRssBytes, response.metrics?.rssBytes ?? 0);
      if (response.type === 'ready') readyResolve();
      if (response.type === 'result') {
        replies.push(response.id);
        const resolve = waiters.get(response.id);
        if (resolve) { waiters.delete(response.id); resolve(response); }
      }
    }
  });
  let timeout;
  try {
    await Promise.race([ready, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Worker startup timed out: ' + stderr)), 10000); })]);
  } finally { clearTimeout(timeout); }
}
function send(text, options = {}, wait = true) {
  const id = ++nextId;
  const promise = wait ? new Promise(resolve => waiters.set(id, resolve)) : undefined;
  worker.stdin.write(JSON.stringify({ type: 'analyze', id, text, width: 1500, rowHeight: 28,
    foreground: '#cccccc', background: '#0c0c0c', ...options }) + '\n');
  return { id, promise };
}
async function request(text, options = {}, limit = 15000) {
  const start = performance.now();
  let result;
  do {
    const { promise } = send(text, options);
    let timer;
    try {
      result = await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Worker request timed out: ' + stderr)), limit);
      })]);
    } finally { clearTimeout(timer); }
    if (!result.retryAfterMs) return { ...result, elapsedMs: performance.now() - start };
    await pause(result.retryAfterMs);
  } while (performance.now() - start < limit);
  throw new Error('History index never became ready: ' + JSON.stringify(result.metrics));
}
async function stop() {
  if (!worker || worker.exitCode !== null) return;
  const child = worker;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdin.end('{"type":"quit"}\n');
  let timer;
  try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill(); resolve(); }, 3000); })]); }
  finally { clearTimeout(timer); }
}
let report = {}, failure;
try {
  const started = performance.now(); await start();
  const cold = await request(screen(source(0)));
  const coldMs = performance.now() - started;
  assert.equal(cold.formulas.length, 1); assert.equal(cold.metrics.indexedFiles, 240);
  assert.equal(cold.metrics.indexedMessages, 9600); assert.equal(cold.metrics.imageEntries, 1);
  assert.ok(coldMs < 15000); assert.ok(cold.metrics.sourceReadBytes < 2000);
  passed('cold lookup finds the oldest formula in 240 files / 9600 answers, without prerendering history');
  const first = cold.formulas[0];
  for (let i = 0; i < 35; i++) {
    const result = await request(screen(source(0)));
    assert.equal(result.formulas[0].imageId, first.imageId); assert.equal(result.metrics.sourceReadBytes, 0);
    assert.equal(result.metrics.imageHits, 1); timings.push(result.elapsedMs);
  }
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
  assert.ok(percentile(timings, .95) < 250, 'warm worker p95 should remain below 250ms');
  passed('warm revisits use source and image caches with zero source-body reads');
  const hot = source(500);
  for (let i = 1; i <= (inline ? 1100 : 145); i++) {
    const result = await request(screen(source(i)));
    assert.equal(result.formulas.length, 1); assert.ok(result.metrics.imageEntries <= (inline ? 1024 : 64));
    assert.ok(result.metrics.imageBytes <= 32 * 1024 * 1024); assert.ok(result.metrics.sourceEntries <= 128);
    assert.ok(result.metrics.sourceBytes <= 8 * 1024 * 1024);
    const keep = await request(screen(hot));
    if (i > 1) assert.equal(keep.metrics.imageHits, 1, 'frequently visited formulas survive LRU eviction');
  }
  const evicted = await request(screen(source(0)));
  assert.equal(evicted.formulas[0].imageId, first.imageId); assert.equal(evicted.formulas[0].png, first.png);
  assert.equal(evicted.metrics.imageMisses, 1); assert.equal(evicted.metrics.sourceMisses, 1);
  passed('fixed source/image LRUs preserve hot formulas and regenerate evicted history identically');
  const before = replies.length;
  for (let i = 0; i < 40; i++) send(screen(source(3000 + i)), {}, false);
  const latest = await request(screen(source(9000)));
  assert.equal(latest.formulas.length, 1); assert.equal(replies.at(-1), latest.id);
  assert.ok(replies.length - before <= 5, 'obsolete queued viewports must be coalesced');
  passed('a burst of 41 viewports converges on the latest and drops obsolete queued requests');
  const file = path.join(directory, 'rollout-0000.jsonl'), appended = source(10000);
  await appendFile(file, record(appended));
  let live;
  const deadline = Date.now() + 8000;
  do { live = await request(screen(appended)); if (live.formulas.length) break; await pause(100); } while (Date.now() < deadline);
  assert.equal(live.formulas.length, 1);
  assert.ok(live.metrics.indexReadBytes - cold.metrics.indexReadBytes < 4096, 'only appended bytes are indexed');
  passed('a live append updates the index incrementally rather than rereading the large log');
  const duplicateFile = path.join(directory, 'rollout-duplicate.jsonl');
  await writeFile(duplicateFile, meta('duplicate') + record(source(0)));
  let ambiguous;
  do { ambiguous = await request(screen(source(0))); if (ambiguous.state === 'ambiguous') break; await pause(100); } while (Date.now() < deadline);
  assert.equal(ambiguous.state, 'ambiguous'); assert.equal(ambiguous.formulas.length, 0);
  passed('a newly discovered duplicate session invalidates previously unique source proofs');
  const broad = i => `Candidate derivation ${i} explains a shared mathematical form with its own verified prose.\n` +
    (inline ? '圆的公式 x^2 + y^2 = r^2，后文继续说明。' : '\\[\n\\frac{a}{b}=c\n\\]') +
    '\nThe candidate-specific explanation is complete.';
  await writeFile(path.join(directory, 'rollout-broad.jsonl'), meta('broad') + Array.from({ length: 1200 }, (_, i) => record(broad(i))).join(''));
  const wide = await request(screen(broad(1199)));
  assert.equal(wide.formulas.length, 1); assert.ok(wide.metrics.sourceEntries <= 128);
  passed('a broad search examines all 1200 shared-formula candidates without a first-page cutoff');
  send(screen(broad(1198)), {}, false); await pause(30);
  const cancelled = await request(screen(source(9000)));
  assert.equal(cancelled.formulas.length, 1); assert.ok(cancelled.elapsedMs < 1500);
  passed('changing viewport cancels a broad source search and promptly renders the latest content');
  await stop(); await start();
  const persisted = await request(screen(source(9000)));
  assert.equal(persisted.formulas.length, 1); assert.equal(persisted.metrics.indexReadBytes, 0);
  passed('worker restart reuses the disk index without reparsing historical bodies');
  assert.ok(peakRssBytes > 0 && peakRssBytes < 512 * 1024 * 1024, 'worker including index thread stays within the stress-test memory budget');
  passed('worker and background index thread stay below the 512 MiB stress-test RSS budget');
  report = { datasetBytes, files: 240, answers: 9600, coldMs, warmP50Ms: percentile(timings, .5),
    warmP95Ms: percentile(timings, .95), warmMaxMs: Math.max(...timings),
    sourceCacheBytes: evicted.metrics.sourceBytes, imageCacheBytes: evicted.metrics.imageBytes,
    persistedLookupMs: persisted.elapsedMs, peakRssBytes, cancelledSearchMs: cancelled.elapsedMs };
  console.log(JSON.stringify(report, null, 2));
} catch (error) { failure = String(error); throw error; }
finally {
  await stop();
  await writeFile('test-results/windows-lazy' + (inline ? '-inline' : '') + '.json', JSON.stringify({ checks, passed: checks.length,
    completed: !failure, failure, ...report, runAt: new Date().toISOString() }, null, 2));
}
