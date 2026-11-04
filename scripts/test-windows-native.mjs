import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
if (process.platform !== 'win32') throw new Error('Requires an interactive Windows desktop');
const exec = promisify(execFile);
const root = process.cwd(), run = Date.now().toString(36);
const work = path.resolve('.cache/native-test-' + run), profile = path.join(work, 'profile');
const home = path.join(work, 'codex'), statusPath = path.join(profile, 'status.json');
const control = path.join(work, 'control.txt'), controlB = path.join(work, 'control-b.txt');
const title = 'AgentMathResearch-NativeA-' + run, titleB = 'AgentMathResearch-NativeB-' + run;
const window = 'AgentMathNative-' + run, windowB = window + '-B';
const binaryArgument = process.argv.indexOf('--binary');
const binary = path.resolve(binaryArgument < 0 ? 'dist/windows/AgentMath.exe' : process.argv[binaryArgument + 1]);
const fixture = path.resolve('scripts/research/windows-terminal-fixture.ps1');
const checks = [], pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function setControl(file, value) {
  for (let attempt = 0; ; attempt++) {
    try { await writeFile(file, value); break; }
    catch (error) { if (attempt >= 20 || error.code !== 'EBUSY') throw error; await pause(30); }
  }
  await pause(350);
}
await mkdir(path.join(home, 'sessions/2026/11/03'), { recursive: true });
await mkdir(profile, { recursive: true }); await mkdir('test-results', { recursive: true });
const messages = ['normal', 'alternate', 'scrolled', 'multiple'].map(phase =>
  `Formula display research (${phase}) [${run}], 中文 and regular text.\n\\[\n\\max_q \\left\\{ \\mathbb E_{a\\sim q}[\\widehat Q(s,a)]\n- \\eta\\,\\mathrm{KL}(q\\|q_{\\mathrm{prior}}) \\right\\}.\n\\]\n` +
  (phase === 'multiple' ? '\\[\nx^2+y^2=z^2\n\\]\n' : '') + 'This is a complete synthetic assistant message.');
await writeFile(path.join(home, 'sessions/2026/11/03/rollout-fixture.jsonl'), [
  { type: 'session_meta', payload: { id: 'isolated-native-' + run, cwd: 'D:/fixture' } },
  ...messages.map(text => ({ type: 'response_item', payload: { type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text }] } })),
].map(x => JSON.stringify(x)).join('\n') + '\n');
const ps = (script, args = []) => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  path.resolve(script), ...args], { windowsHide: true, maxBuffer: 1024 * 1024 });
const act = (action, t = title, args = []) => ps('scripts/research/control-windows-terminal-probe.ps1',
  ['-WindowTitle', t, '-Action', action, ...args]);
const cli = (...args) => exec(binary, ['--profile', profile, ...args], { windowsHide: true });
async function waitFor(predicate, label, timeout = 12000) {
  const start = Date.now(); let value;
  do {
    try { value = JSON.parse(await readFile(statusPath, 'utf8'));
      if (Date.parse(value.updatedAt) >= start && predicate(value)) return value; } catch {}
    await pause(100);
  } while (Date.now() - start < timeout);
  throw new Error(label + ': ' + JSON.stringify(value));
}
async function rendered(label, count) {
  const s = await waitFor(x => x.state === 'rendered' && x.overlays.length > 0 &&
    (count === undefined || x.overlays.length === count), label);
  assert.ok(s.overlays.every(x => x.hitTestOwner === s.targetHwnd), 'overlay must pass mouse hits to terminal');
  checks.push({ check: label, passed: true }); console.log('PASS ' + label); return s;
}
async function hidden(label) {
  const s = await waitFor(x => x.overlays.length === 0 && x.state !== 'rendered', label);
  checks.push({ check: label, passed: true }); console.log('PASS ' + label); return s;
}
async function probe(t, suffix) {
  const output = path.resolve('test-results/native-' + suffix + '.json');
  await ps('scripts/research/probe-windows-terminal-uia.ps1', ['-WindowTitle', t, '-OutputPath', output]);
  return JSON.parse(await readFile(output, 'utf8'));
}
async function terminal(name, t, ctrl, command = 'new-tab', extra = []) {
  await exec('wt.exe', ['-w', name, command, ...extra, '--title', t, '--suppressApplicationTitle',
    'powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-ControlPath', ctrl, '-RunId', run]);
  await pause(1200);
}
let host;
try {
  await setControl(control, 'normal'); await setControl(controlB, 'normal');
  await terminal(window, title, control);
  await act('focus');
  const before = await probe(title, 'before');
  host = spawn(binary, ['--quiet', '--profile', profile, '--codex-home', home], { windowsHide: true, stdio: 'ignore' });
  let s = await rendered('automatic initial rendering');
  const firstHwnd = s.targetHwnd;
  const after = await probe(title, 'after');
  assert.equal(after.foregroundHwnd, before.foregroundHwnd);
  assert.equal(after.elements[0].text, before.elements[0].text);
  assert.equal(after.elements[0].visible[0].text, before.elements[0].visible[0].text);
  checks.push({ check: 'terminal text and foreground unchanged', passed: true });
  await act('capture', title, ['-OutputPath', path.resolve('test-results/native-rendered.png')]);
  async function stable(action, label) {
    const before = await rendered(label + ' baseline');
    const value = await act(action);
    const after = await rendered(label);
    assert.equal(after.hiddenTransitions, before.hiddenTransitions, label + ' must never hide an image');
    return value;
  }
  await stable('click-formula', 'holding a single formula click keeps image stable');
  const order = JSON.parse((await act('overlay-order')).stdout);
  await writeFile('test-results/native-overlay-order.json', JSON.stringify(order, null, 2));
  assert.equal(order.overlays.length, 1);
  assert.ok(order.ownerOrder >= 0 && order.overlays[0] < order.ownerOrder, 'clicked formula stays above terminal');
  await stable('click-outside', 'ordinary text click keeps image stable');
  await stable('select-outside', 'selection outside formula keeps image stable');
  await act('clear-selection');
  const input = JSON.parse((await stable('input', 'typing deletion and caret movement keep image stable')).stdout);
  assert.equal(input.typedTextVisible, true); assert.equal(input.originalTextRestored, true);
  const selection = JSON.parse((await act('drag-formula')).stdout);
  assert.ok(selection.selectedSource.join('').includes('\\max_q')); assert.equal(selection.buttonDown, true);
  await hidden('actual mouse selection reveals original LaTeX');
  await act('clear-selection'); await rendered('selection clear restores image');
  await setControl(control, 'multiple');
  s = await rendered('multiple formulas render independently', 2);
  const other = s.overlays[1];
  await act('drag-formula');
  s = await waitFor(x => x.overlays.length === 1, 'only selected formula is hidden');
  assert.equal(s.overlays[0].y, other.y);
  checks.push({ check: 'selection reveals only the overlapping formula', passed: true });
  await act('clear-selection');
  s = await rendered('clearing selection restores both formulas', 2);
  await setControl(control, 'tampered'); await hidden('unverified prose and formula context remove overlays');
  await setControl(control, 'normal'); await rendered('verified context restores overlays');
  for (const action of ['palette', 'search']) {
    await act(action); await hidden(action + ' hides image');
    if (action === 'search') await probe(title, 'search');
    await act('escape'); await rendered(action + ' close restores image');
  }
  await act('move', title, ['-X', '160', '-Y', '160']); await rendered('move realigns image');
  await act('resize', title, ['-Width', '1350', '-Height', '820']); await rendered('resize realigns image');
  await act('minimize'); await hidden('minimize hides image');
  await act('focus'); await rendered('restore restores image');
  await setControl(control, 'approval'); await hidden('approval repaint removes image');
  await setControl(control, 'alternate'); await rendered('alternate screen renders verified message');
  await setControl(control, 'normal'); await rendered('normal screen restores image');
  await setControl(control, 'scrolled'); await hidden('scrollback outside viewport hides image');
  await act('wheel-up'); await rendered('actual mouse wheel reveals historical formula');
  await act('wheel-down'); await hidden('actual mouse wheel hides historical formula');
  await setControl(control, 'normal'); await rendered('new repaint restores image');
  // A second tab contains only an approval prompt; the first tab must not leak through.
  await setControl(controlB, 'approval');
  await terminal(window, titleB, controlB); await act('focus', titleB); await hidden('new tab hides previous image');
  await act('close-pane', titleB); await pause(800); await act('focus'); await rendered('returning to original tab restores image');
  await terminal(window, title, controlB, 'split-pane', ['-H']);
  await act('focus'); await hidden('focused split pane does not inherit another pane image');
  await act('focus-up'); s = await rendered('focusing original split pane restores its image');
  const panes = await probe(title, 'split');
  assert.equal(panes.elements.length, 2);
  const maxPaneHeight = Math.max(...panes.elements.map(x => x.bounds.height));
  assert.ok(s.overlays.every(x => x.height <= maxPaneHeight));
  await act('focus-up'); // Original is already the top pane: remain there.
  // Test another independently named window, then switch back.
  await setControl(controlB, 'normal');
  await terminal(windowB, titleB, controlB); await act('focus', titleB);
  s = await rendered('second window renders independently'); assert.notEqual(s.targetHwnd, firstHwnd);
  await act('focus'); s = await rendered('window switch removes previous owner'); assert.equal(s.targetHwnd, firstHwnd);
  await cli('--pause'); await hidden('pause hides image');
  await cli('--resume'); await rendered('resume restores image');
  s = JSON.parse(await readFile(statusPath, 'utf8'));
  const oldWorker = s.workerPid, oldHidden = s.hiddenTransitions;
  process.kill(oldWorker);
  await waitFor(x => x.hiddenTransitions > oldHidden, 'worker failure hides stale image even during fast restart');
  checks.push({ check: 'worker failure removes image', passed: true });
  s = await rendered('worker failure recovers automatically');
  assert.notEqual(s.workerPid, oldWorker);
  const stalledWorker = s.workerPid;
  // Suspend only the child PID of this isolated profile. This exercises the
  // host watchdog against a live but unresponsive renderer, without a model.
  assert.ok(Number.isSafeInteger(stalledWorker) && stalledWorker > 0);
  await exec('powershell.exe', ['-NoProfile', '-Command', `
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AgentMathTestSuspend { [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr process); }'
    $researchWorker = [Diagnostics.Process]::GetProcessById(${stalledWorker})
    if ($researchWorker.ProcessName -ne 'node') { throw 'Expected isolated Node worker' }
    if ([AgentMathTestSuspend]::NtSuspendProcess($researchWorker.Handle) -ne 0) { throw 'Could not suspend test worker' }
  `], { windowsHide: true });
  await waitFor(x => x.workerPid === stalledWorker && x.overlays.length === 0,
    'unresponsive worker expires old proof', 10000);
  checks.push({ check: 'unresponsive worker removes expired formula proof', passed: true });
  s = await rendered('unresponsive worker restarts and renders automatically');
  assert.notEqual(s.workerPid, stalledWorker);
  const worker = s.workerPid;
  await cli('--quit'); await pause(1800);
  let alive = true; try { process.kill(worker, 0); } catch { alive = false; }
  assert.equal(alive, false); checks.push({ check: 'exit cleans up worker', passed: true });
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} catch (error) {
  await act('capture', title, ['-OutputPath', path.resolve('test-results/native-failure.png')]).catch(() => {});
  await probe(title, 'failure').catch(() => {});
  throw error;
} finally {
  await cli('--quit').catch(() => {});
  await setControl(control, 'exit'); await setControl(controlB, 'exit');
  await writeFile('test-results/windows-native.json', JSON.stringify({ checks, passed: checks.length,
    runAt: new Date().toISOString() }, null, 2) + '\n');
}
