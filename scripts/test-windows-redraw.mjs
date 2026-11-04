// Replay the real Codex progress animation and an unrecorded next answer.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile), run = Date.now().toString(36), observe = process.argv.includes('--observe');
const native = process.argv.includes('--native');
const reportName = 'windows-redraw' + (native ? '-native' : '') + (observe ? '-baseline' : '');
const work = path.resolve('.cache/redraw-' + run), profile = path.join(work, 'profile'), home = path.join(work, 'codex');
const title = 'AgentMathResearch-Redraw-' + run, control = path.join(work, 'control.txt'), input = path.join(work, 'input.json');
const binaryArgument = process.argv.indexOf('--binary');
const binary = path.resolve(binaryArgument >= 0 ? process.argv[binaryArgument + 1] : 'dist/windows/AgentMath.exe');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ps = (file, args) => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(file), ...args],
  { windowsHide: true, maxBuffer: 1024 * 1024 });
const act = (action, args = []) => ps('scripts/research/control-windows-terminal-probe.ps1', ['-WindowTitle', title, '-Action', action, ...args]);
const report = { checks: [], phases: [], observe, runAt: new Date().toISOString() };
const sourceFile = path.join(home, 'sessions/rollout-redraw.jsonl');
const seedTex = native ? String.raw`\boxed{\hat A_{i,t}=A_i^{E}+\omega A_{i,t}^{S}}` : String.raw`\mathbb E_q[Q]-\eta\mathrm{KL}(q\|p)`;
const seedBlock = '\\[\n' + seedTex + '\n\\]';
const seed = `Verified historical policy derivation ${run}.\n${seedBlock}\nThe original objective remains unchanged.`;
const seedVisible = native ? seed.replace(seedBlock, '┌──────────────────────────────┐\n│ Â_{i,t}=Aᵢ^{E}+ω A_{i,t}^{S} │\n└──────────────────────────────┘') : seed;
const next = `A new streaming assistant answer ${run}.\n\\[\na^2+b^2=c^2\n\\]\nExplanation: `;
const prose = Array.from({ length: 45 }, (_, i) => String.fromCharCode(97 + i % 26));
const fullNext = next + prose.join('');
const physical = text => '• ' + text.replaceAll('\n', '\r\n  ');
const first = physical(seedVisible) + '\r\n\r\n  Worked for 2s • 16:52\r\n\r\n› Give another formula\r\n\r\n';
const prompt = '\r\n\r\n› Ask Codex to do anything\r\n\r\n  model status';
const initial = first + prompt;
const progress = Array.from({ length: 45 }, (_, i) => first +
  `${i % 2 ? '◦' : '•'} Working (${Math.floor(i / 6)}s • esc to interrupt)` + prompt);
const streaming = prose.map((_, i) => first + physical(next + prose.slice(0, i + 1).join('')) + prompt);
const final = first + physical(fullNext) + prompt;
const record = (id, text) => JSON.stringify({ type: 'response_item', payload: {
  type: 'message', role: 'assistant', content: [{ type: 'output_text', text }], id } }) + '\n';
async function status() {
  for (let i = 0; ; i++) {
    try { return JSON.parse(await readFile(path.join(profile, 'status.json'), 'utf8')); }
    catch (error) { if (i > 20 || !['ENOENT', 'EBUSY', 'EPERM'].includes(error.code)) throw error; await pause(10); }
  }
}
async function until(predicate, label) {
  let value; const start = Date.now();
  do { try { value = await status(); if (predicate(value)) return value; } catch {} await pause(50); }
  while (Date.now() - start < 15000);
  throw new Error(label + ': ' + JSON.stringify(value));
}
function passed(label) { report.checks.push(label); console.log('PASS ' + label); }
async function phase(name) {
  const before = await status(), samples = [];
  await writeFile(control, name);
  do { samples.push(await status()); await pause(40); }
  while (await readFile(control + '.ready', 'utf8').catch(() => '') !== name);
  await pause(600); const after = await status(); samples.push(after);
  const summary = { name, captures: new Set(samples.map(x => x.captureKey).filter(Boolean)).size,
    hiddenTransitions: after.hiddenTransitions - before.hiddenTransitions,
    emptySamples: samples.filter(x => x.overlays.length === 0).length,
    hiddenReasons: after.hiddenReasons };
  report.phases.push(summary); console.log(JSON.stringify(summary));
  assert.ok(summary.captures >= 8, 'phase must capture multiple real redraws');
  if (!observe) {
    assert.equal(summary.hiddenTransitions, 0, 'unchanged historical formula must never be hidden');
    assert.ok(samples.every(x => x.overlays.length === 1), 'unrecorded new formula must not borrow the old proof');
    assert.ok(samples.every(x => x.overlays[0].imageId === before.overlays[0].imageId));
  }
}
await mkdir(path.join(home, 'sessions'), { recursive: true }); await mkdir(profile, { recursive: true });
if (native) await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ enabled: true, inlineMath: true }));
await mkdir('test-results', { recursive: true });
await writeFile(sourceFile, JSON.stringify({ type: 'session_meta', payload: { id: run, cwd: 'D:/fixture' } }) + '\n' + record('seed', seed));
await writeFile(input, JSON.stringify({ normal: initial, 'redraw-progress': progress, 'redraw-answer': streaming,
  final, tampered: native ? final.replace('A_{i,t}^{S}', 'A_{i,t}^{E}') : final.replace('\\mathbb E_q[Q]', '\\mathbb E_q[R]') }));
await writeFile(control, 'normal');
await exec(path.resolve('dist/windows/AgentMath.exe'), ['--pause']);
try {
  await exec('wt.exe', ['-w', 'AgentMathRedraw-' + run, 'new-tab', '--title', title, '--suppressApplicationTitle',
    'powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve('scripts/research/windows-stream-fixture.ps1'), '-InputPath', input, '-ControlPath', control]);
  // wt.exe can return before a new window is discoverable, especially just
  // after another test closed its window. Wait for this exact disposable title.
  const focusDeadline = Date.now() + 10000;
  for (;;) {
    try { await act('focus'); break; }
    catch (error) {
      if (!String(error).includes('Named disposable window not found') || Date.now() > focusDeadline) throw error;
      await pause(200);
    }
  }
  await act('move', ['-X', '10', '-Y', '10']);
  await act('resize', ['-Width', '1700', '-Height', '1200']);
  spawn(binary, ['--quiet', '--profile', profile, '--codex-home', home, '--window-title', title,
    '--diagnostics', path.join(work, 'diagnostics.json')], { windowsHide: true, stdio: 'ignore' }).unref();
  await until(x => x.state === 'rendered' && x.overlays.length === 1, 'seed');
  await phase('redraw-progress'); passed(observe ? 'baseline progress animation observed' : 'actual Codex solid/hollow Working animation keeps historical formula stable');
  await phase('redraw-answer'); passed(observe ? 'baseline unrecorded answer observed' : 'unrecorded next answer streams without hiding history or borrowing its proof');
  await writeFile(control, 'final'); await appendFile(sourceFile, record('next', fullNext));
  await until(x => x.state === 'rendered' && x.overlays.length === 2, 'new source');
  passed('new formula renders independently once its source is recorded');
  const conflict = path.join(home, 'sessions/rollout-conflict.jsonl');
  await writeFile(conflict, JSON.stringify({ type: 'session_meta', payload: { id: 'conflict', cwd: 'D:/other' } }) + '\n' + record('conflict', fullNext));
  await until(x => x.state === 'ambiguous' && x.overlays.length === 0, 'conflicting session');
  passed('new conflicting session immediately removes carried images after source verification');
  await unlink(conflict); await until(x => x.overlays.length === 2, 'conflict removed');
  await act('capture', ['-OutputPath', path.resolve('test-results/' + reportName + '.png')]);
  await writeFile(control, 'tampered');
  const changed = await until(x => x.overlays.length === 1, 'tampered old math');
  assert.ok(changed.overlays[0].y > 300, 'remaining image belongs to the next answer');
  passed('changed historical formula loses its image while independently verified next answer remains');
} finally {
  await exec(binary, ['--profile', profile, '--quit']).catch(() => {});
  await writeFile(control, 'exit');
  await exec(path.resolve('dist/windows/AgentMath.exe'), ['--resume']);
  await writeFile('test-results/' + reportName + '.json', JSON.stringify(report, null, 2));
}
