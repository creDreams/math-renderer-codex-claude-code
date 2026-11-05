// Replay the real Codex progress animation and an unrecorded next answer.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile), run = Date.now().toString(36), observe = process.argv.includes('--observe');
const compact = process.argv.includes('--compact'), native = process.argv.includes('--native') || compact;
const reportName = 'windows-redraw' + (compact ? '-compact' : native ? '-native' : '') + (observe ? '-baseline' : '');
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
const seedTex = compact ? String.raw`\{x_{i,1},x_{i,2},x_{i,3},x_{i,4}\}.` :
  native ? String.raw`\boxed{\hat A_{i,t}=A_i^{E}+\omega A_{i,t}^{S}}` : String.raw`\mathbb E_q[Q]-\eta\mathrm{KL}(q\|p)`;
const seedBlock = '\\[\n' + seedTex + '\n\\]';
const compactShown = '{x_{i,1},x_{i,2},x_{i,3},x_{i,4}}.';
const seed = compact ? `同一提示采样四条输出，列出样本 ${run}。\n\n${seedBlock}\n\n随后计算四个奖励的均值、标准差和相对优势。` :
  `Verified historical policy derivation ${run}.\n${seedBlock}\nThe original objective remains unchanged.`;
const seedVisible = compact ? seed.replace(seedBlock, compactShown) :
  native ? seed.replace(seedBlock, '┌──────────────────────────────┐\n│ Â_{i,t}=Aᵢ^{E}+ω A_{i,t}^{S} │\n└──────────────────────────────┘') : seed;
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
  const before = await status(), samples = [], deadline = Date.now() + 15000;
  await writeFile(control, name);
  do {
    assert.ok(Date.now() < deadline, 'fixture must finish phase ' + name);
    samples.push(await status()); await pause(40);
  }
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
// Independently use actual terminal text/row rectangles, not matcher output,
// to check that added height contains only the known formula and empty rows.
async function inspectCompact(expectedCount) {
  const probePath = path.join(work, 'compact-uia.json');
  await ps('scripts/research/probe-windows-terminal-uia.ps1', ['-WindowTitle', title, '-OutputPath', probePath]);
  const probe = JSON.parse(await readFile(probePath, 'utf8'));
  assert.equal(probe.foregroundHwnd, probe.hwnd, 'research window must remain foreground');
  const view = probe.elements[0].visible[0], lines = view.text.split(/\r?\n/);
  // Clearing/redrawing can preserve earlier copies in Terminal scrollback.
  // Count every complete known occurrence independently in the visible text.
  const expected = [];
  for (let row = 0; row < lines.length; row++) {
    if (lines[row].trim() === compactShown) {
      const start = row > 0 && !lines[row - 1].trim() ? row - 1 : row;
      const end = row + 1 < lines.length && !lines[row + 1].trim() ? row + 1 : row;
      expected.push({ row, start, end, compact: true });
    } else if (lines[row].trim() === '\\[' && lines[row + 1]?.trim() === 'a^2+b^2=c^2' && lines[row + 2]?.trim() === '\\]') {
      expected.push({ row, start: row, end: row + 2, compact: false });
    }
  }
  assert.ok(expected.some(f => f.compact), 'complete compact formula must be visible');
  if (expectedCount !== undefined) assert.equal(expected.length, expectedCount);
  const bounds = expected.map(f => ({ ...f, top: Math.floor(view.rectangles[f.start].y),
    bottom: Math.ceil(view.rectangles[f.end].y + view.rectangles[f.end].height) }));
  const current = await until(s => s.overlays.length === bounds.length && bounds.every(b =>
    s.overlays.some(f => f.y === b.top && f.y + f.height === b.bottom)), 'compact slot geometry');
  for (const b of bounds) {
    const image = current.overlays.find(f => f.y === b.top);
    assert.ok(image.imageHeight <= image.height - 8);
    if (b.compact && b.end - b.start === 2) assert.ok(image.imageHeight >= view.rectangles[b.row].height * 1.5,
      'use the real blank rows to enlarge subscripts');
    assert.equal(image.hitTestOwner, current.targetHwnd);
  }
  return { image: current.overlays.find(f => f.y === bounds.find(b => b.compact).top), text: view.text, count: bounds.length };
}
await mkdir(path.join(home, 'sessions'), { recursive: true }); await mkdir(profile, { recursive: true });
if (native) await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ enabled: true, inlineMath: true }));
await mkdir('test-results', { recursive: true });
await writeFile(sourceFile, JSON.stringify({ type: 'session_meta', payload: { id: run, cwd: 'D:/fixture' } }) + '\n' + record('seed', seed));
await writeFile(input, JSON.stringify({ normal: initial, 'redraw-progress': progress, 'redraw-answer': streaming,
  final, selectionNeedle: compactShown, anchor: compactShown, moving: ['\r\nLater scrollback filler\r\n'.repeat(70)],
  tampered: compact ? final.replace('x_{i,4}', 'x_{i,5}') : native ? final.replace('A_{i,t}^{S}', 'A_{i,t}^{E}') : final.replace('\\mathbb E_q[Q]', '\\mathbb E_q[R]') }));
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
  if (compact && !observe) {
    const before = await inspectCompact(1); report.compactImage = before.image;
    passed('collapsed one-row display uses only adjacent real empty rows and has enlarged symbols');
    await act('click-inline', ['-InputPath', input]);
    const clicked = await until(s => s.overlays.length === 1, 'click leaves compact display visible');
    assert.equal(clicked.overlays[0].imageId, before.image.imageId);
    await act('select-inline', ['-InputPath', input]);
    await until(s => s.overlays.length === 0, 'selection reveals compact source');
    await act('clear-selection', ['-InputPath', input]);
    await until(s => s.overlays.length === 1 && s.overlays[0].imageId === before.image.imageId, 'selection restores cached compact image');
    assert.equal((await inspectCompact(1)).text, before.text, 'rendering and selection never change terminal text');
    passed('click passes through; selection reveals unchanged source and clearing reuses the same enlarged image');
    await exec(binary, ['--profile', profile, '--inline-off']);
    await until(s => !s.inlineMath && s.overlays.length === 0, 'preview off removes compact display');
    await exec(binary, ['--profile', profile, '--inline-on']);
    await until(s => s.inlineMath && s.overlays.length === 1, 'preview on restores compact display');
    passed('preview switch still governs character displays');
  }
  await phase('redraw-progress'); passed(observe ? 'baseline progress animation observed' : 'actual Codex solid/hollow Working animation keeps historical formula stable');
  await phase('redraw-answer'); passed(observe ? 'baseline unrecorded answer observed' : 'unrecorded next answer streams without hiding history or borrowing its proof');
  await writeFile(control, 'final'); await appendFile(sourceFile, record('next', fullNext));
  await until(x => x.state === 'rendered' && x.overlays.length === 2, 'new source');
  passed('new formula renders independently once its source is recorded');
  if (compact && !observe) {
    await act('capture', ['-OutputPath', path.resolve('test-results/' + reportName + '-enlarged.png')]);
    await writeFile(control, 'moving');
    await until(s => s.overlays.length === 0, 'history scrolls out of view');
    for (const offset of [0, 1, 2]) {
      await act('scroll-formulas', ['-InputPath', input, '-RowOffset', String(offset)]);
      const checked = await inspectCompact();
      (report.positions ??= []).push({ offset, count: checked.count, ...checked.image });
    }
    passed('actual history scrolling keeps the complete formula rendered when its upper padding enters or leaves view');
    await act('scroll-bottom');
    await writeFile(control, 'final');
    await until(s => s.overlays.length === 2, 'return to active view');
  }
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
