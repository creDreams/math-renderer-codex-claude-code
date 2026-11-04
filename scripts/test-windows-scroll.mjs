import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile), run = Date.now().toString(36), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = path.resolve('.cache/scroll-test-' + run), profile = path.join(root, 'profile'), home = path.join(root, 'codex');
const input = path.join(root, 'input.json'), control = path.join(root, 'control.txt'), anchorInput = path.join(root, 'anchor.json');
const title = 'AgentMathResearch-Scroll-' + run, binary = path.resolve('dist/windows/AgentMath.exe');
const checks = [], latencies = [], ids = new Map();
const ps = (file, args) => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(file), ...args],
  { windowsHide: true, maxBuffer: 1024 * 1024 });
const act = (action, args = []) => ps('scripts/research/control-windows-terminal-probe.ps1', ['-WindowTitle', title, '-Action', action, ...args]);
const cli = (...args) => exec(binary, ['--profile', profile, ...args], { windowsHide: true });
const passed = label => { checks.push(label); console.log('PASS ' + label); };
const heading = i => `Historical page ${String(i).padStart(2, '0')} explains its independent optimization objective.`;
const source = i => heading(i) + `\n\n${i % 2 ? '$$' : '\\['}\nq_{${i}}(a\\mid s)=\\frac{\\exp(Q_{${i}}(s,a))}{Z_{${i}}(s)}\n${i % 2 ? '$$' : '\\]'}\n\n` +
  Array.from({ length: 52 }, (_, n) => `The explanation for page ${i}, paragraph ${n}, continues below the displayed equation.`).join('\n');
const sources = Array.from({ length: 16 }, (_, i) => source(i));
let status, failure;
async function until(predicate, label, after = Date.now()) {
  const deadline = Date.now() + 15000;
  do {
    try {
      status = JSON.parse(await readFile(path.join(profile, 'status.json'), 'utf8'));
      if (Date.parse(status.updatedAt) >= after && predicate(status)) return status;
    } catch {}
    await pause(50);
  } while (Date.now() < deadline);
  throw new Error(label + ': ' + JSON.stringify(status));
}
async function visit(i, known = false) {
  await writeFile(anchorInput, JSON.stringify({ anchor: heading(i) }));
  const action = JSON.parse((await act('scroll-formulas', ['-InputPath', anchorInput])).stdout);
  const started = Date.parse(action.scrolledAt);
  const previousKey = status?.captureKey;
  const current = await until(s => s.state === 'rendered' && s.overlays.length === 1 && s.captureKey !== previousKey &&
    Date.parse(s.renderedAt) >= started && (!known || s.overlays[0].imageId === ids.get(i)), 'page ' + i + ' renders', started);
  assert.equal(current.overlays[0].hitTestOwner, current.targetHwnd);
  if (known) latencies.push(Date.parse(current.renderedAt) - started);
  else ids.set(i, current.overlays[0].imageId);
  return current;
}
await mkdir(path.join(home, 'sessions'), { recursive: true }); await mkdir(profile, { recursive: true }); await mkdir('test-results', { recursive: true });
const record = text => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
await writeFile(path.join(home, 'sessions/rollout-history.jsonl'), [
  JSON.stringify({ type: 'session_meta', payload: { id: 'scroll-' + run, cwd: 'D:/fixture' } }), ...sources.map(record),
  ...Array.from({ length: 100 }, (_, i) => record('A much later answer ' + i)),
  JSON.stringify({ type: 'tool', payload: 'x'.repeat(5 * 1024 * 1024) }),
].join('\n') + '\n');
const body = sources.map(text => '• ' + text.replaceAll('\n', '\r\n  ') + '\r\n  Worked for 6s • Nov 2 at 16:41\r\n\r\n').join('') +
  '› Ask Codex\r\n' + 'later filler scrollback\r\n'.repeat(60);
await writeFile(input, JSON.stringify({ normal: body })); await writeFile(control, 'normal');
try {
  await exec('wt.exe', ['-w', 'AgentMathScroll-' + run, 'new-tab', '--title', title, '--suppressApplicationTitle',
    'powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve('scripts/research/windows-history-fixture.ps1'), '-InputPath', input, '-ControlPath', control]);
  await pause(1400); await act('focus'); await act('resize', ['-Width', '1550', '-Height', '850']);
  spawn(binary, ['--quiet', '--profile', profile, '--codex-home', home, '--window-title', title],
    { windowsHide: true, stdio: 'ignore' }).unref();
  await until(s => s.workerReady && !s.overlays.length, 'isolated worker starts');
  for (let i = 0; i < sources.length; i++) await visit(i);
  assert.equal(new Set(ids.values()).size, sources.length);
  passed('16 separated historical viewports alternate bracket/dollar blocks and render 16 distinct mouse-transparent formulas');
  for (const i of [0, 15, 2, 13, 4, 11, 6, 9, 1, 14, 3, 12]) await visit(i, true);
  passed('random backward/forward revisits restore the exact corresponding cached image');
  const indices = [15, 0, 14, 1, 13, 2, 12, 3, 11, 4, 10, 5, 9, 6, 8, 7, 15, 0, 14, 2, 13];
  await writeFile(anchorInput, JSON.stringify({ anchors: indices.map(heading) }));
  const action = JSON.parse((await act('scroll-sequence', ['-InputPath', anchorInput])).stdout);
  await until(s => s.state === 'rendered' && s.overlays.length === 1 && s.overlays[0].imageId === ids.get(indices.at(-1)) &&
    Date.parse(s.renderedAt) >= Date.parse(action.scrolledAt), 'rapid scroll converges on its final viewport', Date.parse(action.scrolledAt));
  passed('21 rapid 35ms viewport changes converge on the final formula without retaining another page image');
  const hidden = status.hiddenTransitions;
  await pause(2400);
  await until(s => s.state === 'rendered' && s.overlays.length === 1, 'final viewport remains stable');
  assert.equal(status.hiddenTransitions, hidden);
  passed('settled cached viewport remains visible through periodic source revalidation');
  await act('capture', ['-OutputPath', path.resolve('test-results/windows-scroll.png')]);
  await act('scroll-bottom'); await until(s => !s.overlays.length, 'scrolling away removes formulas');
  passed('leaving every mathematical region removes all overlays');
  assert.ok(Math.max(...latencies) < 2000, 'native cached revisit should render within 2s');
} catch (error) { failure = String(error); throw error; }
finally {
  await cli('--quit').catch(() => {}); await writeFile(control, 'exit');
  const sorted = [...latencies].sort((a, b) => a - b);
  const report = { checks, passed: checks.length, completed: !failure, failure,
    cachedRevisitP50Ms: sorted[Math.floor(sorted.length * .5)], cachedRevisitP95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))],
    cachedRevisitMaxMs: Math.max(0, ...latencies), runAt: new Date().toISOString() };
  await writeFile('test-results/windows-scroll.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
