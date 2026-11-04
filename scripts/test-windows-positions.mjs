import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile), run = Date.now().toString(36), pause = ms => new Promise(r => setTimeout(r, ms));
const work = path.resolve('.cache/positions-' + run), profile = path.join(work, 'profile'), home = path.join(work, 'codex');
const title = 'AgentMathResearch-Positions-' + run, control = path.join(work, 'control.txt'), input = path.join(work, 'input.json');
const statusPath = path.join(profile, 'status.json'), binary = path.resolve('dist/windows/AgentMath.exe');
const ps = (script, args) => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(script), ...args],
  { windowsHide: true, maxBuffer: 1024 * 1024 });
const act = (action, args = []) => ps('scripts/research/control-windows-terminal-probe.ps1', ['-WindowTitle', title, '-Action', action, ...args]);
const cli = (...args) => exec(binary, ['--profile', profile, ...args], { windowsHide: true });
const blocks = Array.from({ length: 18 }, (_, i) => {
  const tex = `\\frac{p_{${i}}(a)}{Z_{${i}}(s)}\n= q_{${i}}(a\\mid s).`;
  return (i % 2 ? '$$\n' + tex + '\n$$' : '\\[\n' + tex + '\n\\]');
});
const source = '这个独立桌面样例用于检查密集公式随视口位置变化时的显示，包含两种分隔符及很短的说明。\n\n' +
  blocks.map((block, i) => `序号${i}：\n\n${block}\n\n其中：`).join('\n\n') + '\n\n以上。';
const compact = value => value.normalize('NFC').replace(/\s+/gu, '');
const checks = [], positions = [], latencies = [];
let failure, status;
async function until(predicate, label, after = Date.now()) {
  const deadline = Date.now() + 12000;
  do {
    try {
      status = JSON.parse(await readFile(statusPath, 'utf8'));
      if (Date.parse(status.updatedAt) >= after && predicate(status)) return status;
    } catch {}
    await pause(50);
  } while (Date.now() < deadline);
  throw new Error(label + ': ' + JSON.stringify(status));
}
async function inspect(offset, size) {
  const action = JSON.parse((await act('scroll-formulas', ['-InputPath', input, '-RowOffset', String(offset)])).stdout);
  const started = Date.parse(action.scrolledAt), probeFile = path.join(work, 'visible.json');
  await ps('scripts/research/probe-windows-terminal-uia.ps1', ['-WindowTitle', title, '-OutputPath', probeFile]);
  const probe = JSON.parse(await readFile(probeFile, 'utf8')), element = probe.elements[0];
  assert.equal(probe.foregroundHwnd, probe.hwnd, 'the independent test window must stay foreground');
  const text = element.visible[0].text, lines = text.split(/\r?\n/);
  // These complete source blocks are the independent expectation. Do not use
  // the clipped parser, source matcher or overlay count to decide visibility.
  const expected = blocks.filter(block => compact(text).includes(compact(block)));
  assert.ok(expected.length > 0);
  const current = await until(s => s.state === 'rendered' && s.overlays.length === expected.length && Date.parse(s.renderedAt) >= started,
    `offset ${offset}, size ${size}, expected ${expected.length}`, started);
  assert.ok(current.overlays.every(overlay => overlay.hitTestOwner === current.targetHwnd));
  const expectedRows = expected.map(block => {
    const middle = block.split('\n')[1];
    const row = lines.findIndex(line => line.trim() === middle) - 1;
    assert.ok(row >= 0);
    return { start: row, end: row + block.split('\n').length - 1 };
  });
  const rectangles = element.visible[0].rectangles;
  const bounds = expectedRows.map(({ start, end }) => ({
    top: Math.floor(rectangles[start].y), bottom: Math.ceil(rectangles[end].y + rectangles[end].height),
  }));
  const actual = [...current.overlays].sort((a, b) => a.y - b.y);
  for (let i = 0; i < bounds.length; i++) {
    assert.equal(actual[i].y, bounds[i].top, 'overlay begins at its own opening delimiter');
    assert.equal(actual[i].y + actual[i].height, bounds[i].bottom, 'overlay ends at its own closing delimiter');
  }
  const elapsed = Date.parse(current.renderedAt) - started;
  if (elapsed >= 0) latencies.push(elapsed);
  positions.push({ size, offset, count: expected.length, latencyMs: elapsed });
}
await mkdir(path.join(home, 'sessions'), { recursive: true }); await mkdir(profile, { recursive: true });
await mkdir('test-results', { recursive: true });
await writeFile(path.join(home, 'sessions/rollout-positions.jsonl'), [
  { type: 'session_meta', payload: { id: 'positions-' + run, cwd: 'D:/fixture' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: source }] } },
].map(record => JSON.stringify(record)).join('\n') + '\n');
await writeFile(input, JSON.stringify({ anchor: blocks[8].split('\n')[1], normal: '• ' + source.replaceAll('\n', '\r\n  ') +
  '\r\n  Worked for 1s\r\n› Input\r\n' + 'later scrollback filler\r\n'.repeat(60) }));
await writeFile(control, 'normal');
try {
  await exec('wt.exe', ['-w', 'AgentMathPositions-' + run, 'new-tab', '--title', title, '--suppressApplicationTitle',
    'powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve('scripts/research/windows-history-fixture.ps1'), '-InputPath', input, '-ControlPath', control]);
  await pause(1400); await act('focus');
  spawn(binary, ['--quiet', '--profile', profile, '--codex-home', home, '--window-title', title],
    { windowsHide: true, stdio: 'ignore' }).unref();
  await until(s => s.workerReady, 'isolated worker starts');
  const readyDeadline = Date.now() + 10000;
  while (await readFile(control + '.ready', 'utf8').catch(() => '') !== 'normal') {
    if (Date.now() > readyDeadline) throw new Error('Fixture has not finished writing');
    await pause(100);
  }
  await pause(500);
  for (const [width, height, offsets] of [[1550, 900, [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 21]],
    [1000, 540, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]]) {
    await act('resize', ['-Width', String(width), '-Height', String(height)]);
    for (const offset of offsets) await inspect(offset, `${width}x${height}`);
    checks.push('all complete blocks keep exact geometry across ' + offsets.length + ' row positions at ' + width + 'x' + height);
    console.log('PASS ' + checks.at(-1));
  }
  const hidden = status.hiddenTransitions;
  await pause(2400);
  await until(s => s.state === 'rendered' && s.overlays.length === positions.at(-1).count, 'settled formulas remain visible');
  assert.equal(status.hiddenTransitions, hidden);
  checks.push('settled dense formulas survive periodic source revalidation without hiding');
  console.log('PASS ' + checks.at(-1));
  await act('capture', ['-OutputPath', path.resolve('test-results/windows-positions.png')]);
} catch (error) { failure = String(error); throw error; }
finally {
  await cli('--quit').catch(() => {}); await writeFile(control, 'exit');
  await writeFile('test-results/windows-positions.json', JSON.stringify({ completed: !failure, failure, checks, positions,
    revisitP50Ms: [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)],
    maximumMs: latencies.length ? Math.max(...latencies) : undefined, runAt: new Date().toISOString() }, null, 2) + '\n');
}
