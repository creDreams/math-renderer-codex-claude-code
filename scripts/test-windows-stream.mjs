import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile), run = Date.now().toString(36), observe = process.argv.includes('--observe');
const work = path.resolve('.cache/stream-' + run), profile = path.join(work, 'profile'), home = path.join(work, 'codex');
const title = 'AgentMathResearch-Stream-' + run, control = path.join(work, 'control.txt'), input = path.join(work, 'input.json');
const binaryArgument = process.argv.indexOf('--binary');
const binary = path.resolve(binaryArgument >= 0 ? process.argv[binaryArgument + 1] : 'dist/windows/AgentMath.exe');
const statusFile = path.join(profile, 'status.json');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const heading = 'Streaming policy derivation with stable verified equations [' + run + '].';
const first = '\\[\n\\mathbb E_q[Q]-\\eta\\mathrm{KL}(q\\|p).\n\\]';
const second = '\\[\nx^2+y^2=z^2\n\\]';
const context = Array.from({ length: 14 }, (_, i) => 'Context line ' + i + ' establishes the streaming derivation.').join('\n');
const initial = heading + '\n\n' + context + '\n\n' + first + '\n\n' + second + '\n\nDetails: ';
const fixed = Array.from({ length: 100 }, (_, i) => String.fromCharCode(97 + i % 26));
const moving = Array.from({ length: 10 }, (_, i) => '\n\nStep ' + i + ': continuing the derivation.');
const source = initial + fixed.join('') + moving.join('');
const physical = text => text.replaceAll('\n', '\r\n  ');
const report = { checks: [], phases: [], observe, runAt: new Date().toISOString() };
const ps = (file, args) => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(file), ...args],
  { windowsHide: true, maxBuffer: 1024 * 1024 });
const act = (action, args = []) => ps('scripts/research/control-windows-terminal-probe.ps1', ['-WindowTitle', title, '-Action', action, ...args]);
async function status() {
  for (let attempt = 0; ; attempt++) {
    try { return JSON.parse(await readFile(statusFile, 'utf8')); }
    catch (error) {
      if (attempt >= 20 || !['ENOENT', 'EBUSY', 'EPERM'].includes(error.code)) throw error;
      await pause(10); // The host atomically replaces this diagnostic file.
    }
  }
}
async function until(predicate, label) {
  const start = Date.now(); let value;
  do {
    try { value = await status(); if (predicate(value)) return value; } catch {}
    await pause(50);
  } while (Date.now() - start < 15000);
  throw new Error(label + ': ' + JSON.stringify(value));
}
const passed = text => { report.checks.push(text); console.log('PASS ' + text); };
async function stream(phase, expectedCount) {
  const before = await status(), samples = [];
  await writeFile(control, phase);
  do {
    samples.push(await status());
    await pause(40);
  } while (await readFile(control + '.ready', 'utf8').catch(() => '') !== phase);
  await pause(600);
  const after = await status(); samples.push(after);
  const keys = new Set(samples.map(value => value.captureKey).filter(Boolean));
  const summary = { phase, captures: keys.size, hiddenTransitions: after.hiddenTransitions - before.hiddenTransitions,
    emptySamples: samples.filter(value => value.overlays.length === 0).length,
    sourceChangedSamples: samples.filter(value => value.state !== 'rendered').length,
    formulasMoved: after.overlays.some(overlay => before.overlays.some(previous =>
      previous.imageId === overlay.imageId && previous.y !== overlay.y)) };
  report.phases.push(summary); console.log(JSON.stringify(summary));
  assert.ok(keys.size >= (phase === 'fixed' ? 5 : 2), 'stream must exercise multiple independently captured snapshots');
  if (phase === 'moving') assert.ok(summary.formulasMoved, 'newline stream must actually scroll the formula rectangles');
  if (!observe && expectedCount) {
    assert.equal(summary.hiddenTransitions, 0, 'fixed formula windows must never be hidden during streaming');
    assert.ok(samples.every(value => value.overlays.length === expectedCount), 'every sampled frame retains both formulas');
    assert.deepEqual(after.overlays.map(value => value.imageId).sort(), before.overlays.map(value => value.imageId).sort());
  }
  return after;
}
await mkdir(path.join(home, 'sessions'), { recursive: true }); await mkdir(profile, { recursive: true });
await mkdir('test-results', { recursive: true });
await writeFile(path.join(home, 'sessions/rollout-stream.jsonl'), [
  { type: 'session_meta', payload: { id: run, cwd: 'D:/fixture' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: source }] } },
].map(value => JSON.stringify(value)).join('\n') + '\n');
await writeFile(input, JSON.stringify({ normal: '• ' + physical(initial), fixed,
  moving: moving.map(physical), final: '• ' + physical(source), tampered: '• ' + physical(source.replace('x^2+y^2=z^2', 'x^2+y^2=w^2')) }));
await writeFile(control, 'normal');
try {
  await exec('wt.exe', ['-w', 'AgentMathStream-' + run, 'new-tab', '--title', title, '--suppressApplicationTitle',
    'powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve('scripts/research/windows-stream-fixture.ps1'), '-InputPath', input, '-ControlPath', control]);
  await pause(1200); await act('focus'); await act('move', ['-X', '10', '-Y', '10']);
  await act('resize', ['-Width', '1700', '-Height', '1200']);
  spawn(binary, ['--quiet', '--profile', profile, '--codex-home', home, '--window-title', title,
    '--diagnostics', path.join(work, 'diagnostics.json')], { windowsHide: true, stdio: 'ignore' }).unref();
  await until(value => value.state === 'rendered' && value.overlays.length === 2, 'initial prefix must render');
  passed('incomplete streaming answer renders its two complete verified blocks');
  await stream('fixed', 2);
  passed(observe ? 'baseline same-line streaming observed' : '100 streaming writes keep both formula windows continuously visible');
  await stream('moving', 2);
  passed(observe ? 'baseline newline streaming observed' : 'newline streaming repositions both complete formulas without hiding their windows');
  await writeFile(control, 'final');
  await pause(400);
  // Revisit the formulas after enough output has scrolled them out of view.
  const anchor = path.join(work, 'anchor.json'); await writeFile(anchor, JSON.stringify({ anchor: heading }));
  await act('scroll-formulas', ['-InputPath', anchor]);
  // A rendered status from before ScrollIntoView is not evidence for its new
  // viewport. Beyond the 500 ms capture lifetime, any rendered status must use
  // a capture made after the scroll, even when the formula count is unchanged.
  const settledAfter = Date.now() + 500;
  await until(value => Date.parse(value.updatedAt) >= settledAfter &&
    value.state === 'rendered' && value.overlays.length === 2, 'return to formula prefix');
  const probe = path.join(work, 'visible.json');
  await ps('scripts/research/probe-windows-terminal-uia.ps1', ['-WindowTitle', title, '-OutputPath', probe]);
  const view = JSON.parse(await readFile(probe, 'utf8'));
  assert.equal(view.foregroundHwnd, view.hwnd);
  const visible = view.elements[0].visible[0], lines = visible.text.split(/\r?\n/), current = await status();
  for (const overlay of current.overlays) {
    const start = visible.rectangles.findIndex(rect => Math.floor(rect.y) === overlay.y);
    assert.equal(lines[start].trim(), '\\[');
    assert.equal(lines[start + 2].trim(), '\\]');
    assert.equal(overlay.y + overlay.height, Math.ceil(visible.rectangles[start + 2].y + visible.rectangles[start + 2].height));
    assert.equal(overlay.hitTestOwner, view.hwnd);
  }
  await act('capture', ['-OutputPath', path.resolve('test-results/windows-stream.png')]);
  passed('returning to streamed history has exact formula geometry and native mouse passthrough');
  await writeFile(control, 'tampered'); await pause(400); await act('scroll-formulas', ['-InputPath', anchor]);
  await until(value => value.overlays.length === 0 && value.state !== 'rendered', 'modified formula removes old images');
  passed('changed mathematical content removes the previous images');
  report.completed = true;
} catch (error) { report.failure = String(error); throw error; }
finally {
  await exec(binary, ['--profile', profile, '--quit'], { windowsHide: true }).catch(() => {});
  await writeFile(control, 'exit');
  await writeFile('test-results/windows-stream' + (observe ? '-baseline' : '') + '.json', JSON.stringify(report, null, 2));
}
