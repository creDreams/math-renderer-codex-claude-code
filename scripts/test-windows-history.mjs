import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile), run = Date.now().toString(36), pause = ms => new Promise(r => setTimeout(r, ms));
const work = path.resolve('.cache/history-test-' + run), profile = path.join(work, 'profile'), home = path.join(work, 'codex');
const control = path.join(work, 'control.txt'), input = path.join(work, 'input.json'), title = 'AgentMathResearch-History-' + run;
const binary = path.resolve('dist/windows/AgentMath.exe'), checks = [];
let failure;
const sourceArgument = process.argv.indexOf('--source-file');
const supplied = sourceArgument >= 0 ? JSON.parse(await readFile(path.resolve(process.argv[sourceArgument + 1]), 'utf8')) : undefined;
const suppliedSource = supplied?.source;
let expectedFormulas = supplied?.expectedFormulas ?? 2;
const reportName = supplied?.reportName ?? (suppliedSource ? 'windows-history-ssd' : 'windows-history');
if (typeof reportName !== 'string' || !/^windows-history(?:-[a-z0-9]+)*$/.test(reportName)) throw new Error('Invalid history report name');
const ps = (file, args) => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(file), ...args],
  { windowsHide: true, maxBuffer: 1024 * 1024 });
const act = (action, args = []) => ps('scripts/research/control-windows-terminal-probe.ps1', ['-WindowTitle', title, '-Action', action, ...args]);
const cli = (...args) => exec(binary, ['--profile', profile, ...args], { windowsHide: true });
function passed(check) { checks.push(check); console.log('PASS ' + check); }
async function waitFor(predicate, label) {
  const start = Date.now(); let status;
  do {
    await pause(100);
    try { status = JSON.parse(await readFile(path.join(profile, 'status.json'), 'utf8'));
      if (Date.parse(status.updatedAt) >= start && predicate(status)) return status; } catch {}
  } while (Date.now() - start < 15000);
  throw new Error(label + ': ' + JSON.stringify(status));
}
async function probe() {
  const file = path.resolve('test-results/history-visible.json');
  await ps('scripts/research/probe-windows-terminal-uia.ps1', ['-WindowTitle', title, '-OutputPath', file]);
  return JSON.parse(await readFile(file, 'utf8'));
}
async function expectedVisible(fallback) {
  if (!supplied?.literalBlocks) return fallback;
  const visible = (await probe()).elements[0].visible[0].text.normalize('NFC').replace(/\s+/gu, '');
  // Reference the full, independently supplied display blocks. Do not run the
  // clipped parser under test to decide how many images should exist.
  return supplied.literalBlocks.filter(block => visible.includes(block.normalize('NFC').replace(/\s+/gu, ''))).length;
}
async function settledViewport(count) {
  const start = Date.now(); let signature, stableSince = start, status;
  do {
    status = await waitFor(s => s.overlays.length === count, 'historical viewport renders while settling');
    const current = JSON.stringify([status.targetHwnd, status.leadingContextChars, status.hiddenTransitions, status.overlays]);
    if (current !== signature) { signature = current; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= 1200) return status;
  } while (Date.now() - start < 15000);
  throw new Error('Historical viewport never settled: ' + JSON.stringify(status));
}
await mkdir(path.join(home, 'sessions'), { recursive: true }); await mkdir(profile, { recursive: true });
const fixture = JSON.parse(await readFile('tests/fixtures/ssd-answer.json', 'utf8'));
const source = suppliedSource ?? fixture.heading + '\n\n' + (fixture.paragraph + '\n').repeat(174) +
  fixture.tableSource + fixture.listSource + fixture.excerpt + '\n\n' + fixture.ending;
const displayed = supplied?.displayed ?? source.replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*\n]+)\*\*/g, '$1')
  .replace(fixture.tableSource, fixture.tableDisplay).replace(fixture.listSource, fixture.listDisplay);
const body = displayed.replaceAll('\n', '\r\n  ') + '\r\n\r\n  Worked for 1s\r\n\r\n› Ask Codex\r\n' +
  Array.from({ length: 60 }, (_, i) => 'later scrollback filler ' + i + '\r\n').join('');
await writeFile(input, JSON.stringify({ anchor: supplied?.anchor ?? fixture.listDisplay.split('\n')[0], normal: '• ' + body, user: '› ' + body,
  tool: '• Ran a command\r\n  ' + body }));
await writeFile(path.join(home, 'sessions/rollout-history.jsonl'), [
  { type: 'session_meta', payload: { id: 'history-' + run, cwd: 'D:/fixture' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: source }] } },
  ...Array.from({ length: 100 }, (_, i) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: 'A later non-mathematical answer ' + i }] } })),
  { type: 'tool', payload: 'x'.repeat(5 * 1024 * 1024) },
].map(r => JSON.stringify(r)).join('\n') + '\n');
for (let index = 0; index < 170; index++) await writeFile(path.join(home, 'sessions/rollout-new-' + index + '.jsonl'),
  JSON.stringify({ type: 'session_meta', payload: { id: 'later-' + index, cwd: 'D:/fixture' } }) + '\n');
await writeFile(control, 'normal');
try {
  await exec('wt.exe', ['-w', 'AgentMathHistory-' + run, 'new-tab', '--title', title, '--suppressApplicationTitle',
    'powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve('scripts/research/windows-history-fixture.ps1'), '-InputPath', input, '-ControlPath', control]);
  await pause(1400); await act('focus'); await act('resize', ['-Width', String(supplied?.width ?? 3000), '-Height', String(supplied?.height ?? 1100)]);
  spawn(binary, ['--quiet', '--profile', profile, '--codex-home', home, '--window-title', title,
    '--diagnostics', path.join(work, 'diagnostics.log')], { windowsHide: true, stdio: 'ignore' }).unref();
  await waitFor(s => s.overlays.length === 0 && s.workerReady, 'initial viewport has no formula');
  const readyDeadline = Date.now() + 10000;
  while (await readFile(control + '.ready', 'utf8').catch(() => '') !== 'normal') {
    if (Date.now() > readyDeadline) throw new Error('Historical fixture has not finished writing its transcript');
    await pause(100);
  }
  await pause(500);
  passed('formulas outside the historical viewport stay hidden');
  await act('focus');
  await act('scroll-formulas', ['-InputPath', input]);
  expectedFormulas = await expectedVisible(expectedFormulas);
  assert.ok(expectedFormulas > 0, 'the target viewport must contain a complete literal formula');
  let status = await waitFor(s => s.overlays.length === expectedFormulas, 'historical formulas render');
  assert.equal(status.metrics.indexedFiles, 171);
  const minimumContext = supplied?.minimumLeadingContextChars ?? 32768;
  assert.ok(status.leadingContextChars > minimumContext && status.leadingContextChars <= 65536);
  passed(expectedFormulas + ' historical formulas render beyond all former history limits with bounded preceding role context');
  const visible = await probe();
  assert.ok(!visible.elements[0].visible[0].text.includes(displayed.split('\n')[0]));
  assert.ok(visible.elements[0].visible[0].text.includes(supplied?.requiredText ?? 'q_{\\mathrm{prior}}'));
  assert.ok(status.overlays.every(x => x.hitTestOwner === status.targetHwnd));
  passed('only complete visible blocks receive mouse-transparent overlays');
  // UIA probes and screenshots can outlast the initial status snapshot. Measure
  // stability from a fresh baseline, including an idle interval before clicking.
  status = await settledViewport(expectedFormulas);
  const oldHidden = status.hiddenTransitions;
  await pause(1200);
  status = await waitFor(s => s.overlays.length === expectedFormulas, 'historical viewport stays visible');
  assert.equal(status.hiddenTransitions, oldHidden, 'idle historical formulas must stay visible');
  await act('click-formula');
  status = await waitFor(s => s.overlays.length === expectedFormulas, 'historical click stays visible');
  assert.equal(status.hiddenTransitions, oldHidden);
  const order = JSON.parse((await act('overlay-order')).stdout);
  assert.equal(order.overlays.length, expectedFormulas);
  assert.ok(order.ownerOrder >= 0 && order.overlays.every(index => index < order.ownerOrder), 'every formula must remain above its terminal after clicking');
  passed('single click preserves historical formula rendering');
  await writeFile('test-results/' + reportName + '-rendered.json', JSON.stringify(status, null, 2));
  await act('capture', ['-OutputPath', path.resolve('test-results/' + reportName + '.png')]);
  await act('select'); await waitFor(s => s.overlays.length === expectedFormulas - 1, 'only selected historical formula hides');
  passed('selection hides only the overlapping historical formula');
  await act('clear-selection'); await waitFor(s => s.overlays.length === expectedFormulas, 'selection clear restores history');
  passed('clearing selection restores historical formulas');
  await cli('--pause'); await waitFor(s => s.overlays.length === 0, 'pause');
  const original = await probe();
  await cli('--resume'); await waitFor(s => s.overlays.length === expectedFormulas, 'resume');
  const resumed = await probe();
  assert.equal(original.elements[0].visible[0].text, resumed.elements[0].visible[0].text);
  assert.equal(original.foregroundHwnd, resumed.foregroundHwnd);
  passed('pause and resume preserve historical terminal text and foreground');
  await act('wheel-up', ['-WheelDelta', '120']);
  expectedFormulas = await expectedVisible(expectedFormulas);
  await waitFor(s => s.overlays.length === expectedFormulas, 'wheel realigns history');
  passed('real mouse wheel repositions historical formulas');
  for (const [index, viewport] of (supplied?.viewports ?? []).entries()) {
    const anchorInput = path.join(work, 'viewport-' + index + '.json');
    await writeFile(anchorInput, JSON.stringify({ anchor: viewport.anchor }));
    await act('scroll-formulas', ['-InputPath', anchorInput]);
    const count = await expectedVisible(viewport.expectedFormulas);
    if (viewport.expectedFormulas > 0) assert.ok(count > 0, 'additional viewport must expose a complete formula');
    await waitFor(s => s.overlays.length === count, 'additional historical viewport renders');
    const current = await probe();
    assert.ok(current.elements[0].visible[0].text.includes(viewport.requiredText));
    await act('wheel-up', ['-WheelDelta', '120']);
    const wheelCount = await expectedVisible(viewport.wheelExpectedFormulas ?? count);
    await waitFor(s => s.overlays.length === wheelCount, 'additional viewport survives mouse wheel');
    passed('historical viewport ' + (index + 1) + ' and its neighboring scroll position render ' + count + '/' + wheelCount + ' formulas');
  }
  await act('scroll-bottom'); await waitFor(s => s.overlays.length === 0, 'scroll away hides formulas');
  passed('leaving the historical region removes overlays');
  for (const phase of ['user', 'tool']) {
    await writeFile(control, phase); await pause(400); await act('scroll-formulas', ['-InputPath', input]);
    await waitFor(s => s.overlays.length === 0 && s.state !== 'observing', phase + ' fragment remains source');
    passed('matching math inside a clipped ' + phase + ' region stays source');
  }
} catch (error) {
  failure = String(error);
  await probe().catch(() => {});
  throw error;
} finally {
  await cli('--quit').catch(() => {}); await writeFile(control, 'exit');
  await writeFile('test-results/' + reportName + '.json', JSON.stringify({ checks, passed: checks.length, completed: !failure, failure,
    source: suppliedSource ? 'supplied historical assistant answer' : 'synthetic fixture', runAt: new Date().toISOString() }, null, 2));
}
