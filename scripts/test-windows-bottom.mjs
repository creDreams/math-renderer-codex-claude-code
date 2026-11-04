import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile), run = Date.now().toString(36), pause = ms => new Promise(r => setTimeout(r, ms));
const work = path.resolve('.cache/bottom-' + run), profile = path.join(work, 'profile'), home = path.join(work, 'codex');
const control = path.join(work, 'control.txt'), input = path.join(work, 'input.json'), title = 'AgentMathResearch-Bottom-' + run;
const binaryArgument = process.argv.indexOf('--binary');
const binary = path.resolve(binaryArgument < 0 ? 'dist/windows/AgentMath.exe' : process.argv[binaryArgument + 1]), statusFile = path.join(profile, 'status.json');
const sourceArgument = process.argv.indexOf('--source-file');
const supplied = sourceArgument >= 0 ? JSON.parse(await readFile(path.resolve(process.argv[sourceArgument + 1]), 'utf8')) : undefined;
const literal = '\\[\n\\mathbb E_q[Q]-\\eta\\mathrm{KL}(q\\|p).\n\\]';
const box = '\\[\n\\boxed{\\hat A_t=\\frac{G_t-\\mu}{\\sigma+\\delta}}\n\\]';
const native = '┌─────────┐\n│    Gₜ-μ │\n│ Âₜ=──── │\n│    σ+δ  │\n└─────────┘';
const code = '```python\n# literal example\n' + literal + '\nprint("$x^2$")\n```';
const source = supplied?.source ?? '下面验证批次回报、归一化优势及策略更新之间的完整推导。\n\n' + literal +
  '\n\n归一化：\n\n' + box + '\n\n代码示例：\n\n' + code + '\n\n继续推导：\n\n' + literal + '\n\n以上。';
const displayed = supplied?.displayed ?? source.replace(box, native).replace('```python\n', '').replace('\n```', '');
const body = '• ' + physical(displayed, 180) + '\r\n\r\n  Worked for 26s • 15:14\r\n\r\n› Ask Codex to do anything\r\nGPT model status\r\n';
const blocks = supplied?.literalBlocks ?? [literal, literal];
const reportName = supplied?.reportName?.replace('windows-history-', 'windows-bottom-') ?? 'windows-bottom';
if (!/^windows-bottom(?:-[a-z0-9]+)*$/.test(reportName)) throw new Error('Invalid report name');
const checks = [], positions = [], compact = text => text.normalize('NFC').replace(/\s+/gu, '');
let status, failure, screenshot, lastViewSignature;
const distinctViews = new Set();
const ps = (file, args) => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(file), ...args],
  { windowsHide: true, maxBuffer: 1024 * 1024 });
const act = (action, args = []) => ps('scripts/research/control-windows-terminal-probe.ps1', ['-WindowTitle', title, '-Action', action, ...args]);
const cli = (...args) => exec(binary, ['--profile', profile, ...args], { windowsHide: true });
const record = text => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text }] } }) + '\n';
const passed = label => { checks.push(label); console.log('PASS ' + label); };
async function until(predicate, label, after = Date.now()) {
  const deadline = Date.now() + 15000;
  do {
    try {
      status = JSON.parse(await readFile(statusFile, 'utf8'));
      if (Date.parse(status.updatedAt) >= after && predicate(status)) return status;
    } catch {}
    await pause(50);
  } while (Date.now() < deadline);
  throw new Error(label + ': ' + JSON.stringify(status));
}
// Emulate Codex's continued-line margin rather than raw terminal auto-wrap.
// This deliberately changes physical rows at each size while preserving text.
function physical(text, columns) {
  return text.split('\n').flatMap(line => {
    const rows = []; let row = '', size = 0;
    for (const char of line) {
      const cells = /\p{M}/u.test(char) ? 0 : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char) ? 2 : 1;
      if (size + cells > columns) { rows.push(row); row = ''; size = 0; }
      row += char; size += cells;
    }
    rows.push(row); return rows;
  }).join('\r\n  ');
}
async function inspect(label, after) {
  const probeFile = path.join(work, 'visible.json');
  await ps('scripts/research/probe-windows-terminal-uia.ps1', ['-WindowTitle', title, '-OutputPath', probeFile]);
  const probe = JSON.parse(await readFile(probeFile, 'utf8'));
  assert.equal(probe.foregroundHwnd, probe.hwnd, 'independent research window must remain foreground');
  const visible = probe.elements[0].visible[0], lines = visible.text.split(/\r?\n/);
  const viewSignature = JSON.stringify(visible);
  distinctViews.add(viewSignature);
  const requiredRenderAt = viewSignature === lastViewSignature ? Date.parse(status.renderedAt) : after;
  // Literal code contains the same block as real math. Use the independently
  // identified true occurrences, never the matcher/parser/overlay count.
  const candidates = [];
  // Supplied fixtures enumerate genuine displayed blocks explicitly. Match the
  // complete physical text rather than asking the production parser for bounds;
  // this also covers environments and quote/list prefixes independently.
  if (supplied) for (let row = 0; row < lines.length; row++) {
    if (!lines[row].trim()) continue;
    for (const block of blocks) {
      const target = compact(block); let shown = '';
      for (let end = row; end < lines.length && shown.length < target.length; end++) {
        shown += compact(lines[end]);
        if (shown === target) candidates.push({ start: row, end });
      }
    }
  }
  else
  for (let row = 0; row < lines.length; row++) {
    const open = lines[row].trim();
    if (open !== '\\[' && open !== '$$') continue;
    let end = row + 1;
    while (end < lines.length && lines[end].trim() !== (open === '\\[' ? '\\]' : '$$')) end++;
    if (end >= lines.length) continue;
    const text = lines.slice(row, end + 1).map(line => line.trim()).join('\n');
    if (blocks.some(block => compact(block) === compact(text))) candidates.push({ start: row, end });
    row = end;
  }
  // Synthetic sample's code occurrence follows this comment. It stays literal.
  const reference = body.split(/\r?\n/).map(line => line.trimEnd());
  const referenceStart = reference.findIndex((_, index) => lines.slice(0, Math.min(8, lines.length))
    .every((line, offset) => line.trimEnd() === reference[index + offset]));
  const codeRow = reference.findIndex(line => line.includes('# literal example')) + 1;
  const codeComment = lines.findIndex(line => line.includes('# literal example'));
  const expected = supplied ? candidates : candidates.filter(candidate => referenceStart >= 0
    ? referenceStart + candidate.start !== codeRow : codeComment < 0 || candidate.start !== codeComment + 1);
  const bounds = expected.map(({ start, end }) => ({ top: Math.floor(visible.rectangles[start].y),
    bottom: Math.ceil(visible.rectangles[end].y + visible.rectangles[end].height) }));
  const current = await until(s => s.overlays.length === expected.length &&
    (!expected.length || s.state === 'rendered' && Date.parse(s.renderedAt) >= requiredRenderAt &&
      [...s.overlays].sort((a, b) => a.y - b.y).every((overlay, index) =>
        overlay.y === bounds[index].top && overlay.y + overlay.height === bounds[index].bottom)), label, after);
  const actual = [...current.overlays].sort((a, b) => a.y - b.y);
  for (let i = 0; i < expected.length; i++) {
    const top = visible.rectangles[expected[i].start], bottom = visible.rectangles[expected[i].end];
    assert.equal(actual[i].y, Math.floor(top.y), 'opening delimiter geometry at ' + label);
    assert.equal(actual[i].y + actual[i].height, Math.ceil(bottom.y + bottom.height), 'closing delimiter geometry at ' + label);
    assert.equal(actual[i].hitTestOwner, current.targetHwnd);
  }
  const latency = Date.parse(current.renderedAt) - after;
  positions.push({ label, count: expected.length, viewportChanged: viewSignature !== lastViewSignature,
    requiredTextVisible: supplied?.requiredSameViewText ? visible.text.includes(supplied.requiredSameViewText) : undefined,
    latencyMs: expected.length && latency >= 0 ? latency : undefined });
  if (supplied?.requiredSameViewText && visible.text.includes(supplied.requiredSameViewText) &&
      expected.length >= (supplied.minimumSameViewFormulas ?? 1)) {
    await act('capture', ['-OutputPath', path.resolve('test-results/' + reportName + '-same-view.png')]);
  }
  lastViewSignature = viewSignature;
  return { visible, expected };
}

await mkdir(path.join(home, 'sessions'), { recursive: true }); await mkdir(profile, { recursive: true });
if (process.argv.includes('--preview')) await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ enabled: true, inlineMath: true }));
await mkdir('test-results', { recursive: true });
const sessionFile = path.join(home, 'sessions/rollout-bottom.jsonl');
await writeFile(sessionFile, JSON.stringify({ type: 'session_meta', payload: { id: 'bottom-' + run, cwd: 'D:/fixture' } }) + '\n');
await writeFile(input, JSON.stringify({ waiting: 'Preparing independent math fixture\r\n', normal: 'earlier scrollback\r\n'.repeat(80) + body,
  history: 'later scrollback filler\r\n'.repeat(60), appendPhases: ['history'] }));
await writeFile(control, 'waiting');
try {
  await exec('wt.exe', ['-w', 'AgentMathBottom-' + run, 'new-tab', '--title', title, '--suppressApplicationTitle',
    'powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve('scripts/research/windows-history-fixture.ps1'), '-InputPath', input, '-ControlPath', control]);
  await pause(1400); await act('focus'); await act('move', ['-X', '10', '-Y', '10']);
  await act('resize', ['-Width', String(supplied?.width ?? 3000), '-Height', String(supplied?.height ?? 1100)]);
  await writeFile(control, 'normal');
  const readyDeadline = Date.now() + 10000;
  while (await readFile(control + '.ready', 'utf8').catch(() => '') !== 'normal') {
    if (Date.now() > readyDeadline) throw new Error('Fixture did not finish writing');
    await pause(50);
  }
  spawn(binary, ['--quiet', '--profile', profile, '--codex-home', home, '--window-title', title], { windowsHide: true, stdio: 'ignore' }).unref();
  await until(s => s.workerReady && s.overlays.length === 0, 'unrecorded answer stays source');
  const appendAt = Date.now(); await appendFile(sessionFile, record(source));
  await until(s => s.state === 'rendered' && s.overlays.length > 0, 'newly appended answer renders without scroll', appendAt);
  const bottom = await inspect('default-bottom-after-append', appendAt);
  assert.ok(bottom.visible.text.includes('› Ask Codex to do anything'));
  assert.ok(bottom.expected.length > 0);
  passed('new answer renders at its default bottom without scrolling after source append');
  const hidden = status.hiddenTransitions;
  await pause(1600); await inspect('idle-bottom', appendAt);
  assert.equal(status.hiddenTransitions, hidden);
  passed('default bottom remains rendered during idle source revalidation');
  await writeFile(control, 'history');
  await until(s => s.overlays.length === 0, 'later output moves answer offscreen');
  for (const offset of [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18]) {
    const anchor = path.join(work, 'anchor.json');
    await writeFile(anchor, JSON.stringify({ anchor: supplied ? supplied.anchor ?? blocks.at(-1).split('\n')[1] : '继续推导：' }));
    const action = JSON.parse((await act('scroll-formulas', ['-InputPath', anchor, '-RowOffset', String(offset)])).stdout);
    await inspect('row-offset-' + offset, Date.parse(action.scrolledAt));
  }
  passed('neighboring row positions retain every complete genuine formula with exact UIA geometry');
  if (supplied?.requiredSameViewText) {
    assert.ok(positions.some(position => position.requiredTextVisible && position.count >= (supplied.minimumSameViewFormulas ?? 1)),
      'required neighboring text and complete formulas must share an independently verified viewport');
    passed('required neighboring native text and complete formulas render together');
  }
  const returnInput = path.join(work, 'return.json');
  await writeFile(returnInput, JSON.stringify({ anchor: 'GPT model status' }));
  const returnAt = Date.parse(JSON.parse((await act('scroll-formulas-bottom', ['-InputPath', returnInput])).stdout).scrolledAt);
  const resumed = await inspect('return-to-bottom', returnAt);
  assert.ok(resumed.visible.text.includes('› Ask Codex to do anything'));
  assert.ok(resumed.expected.length > 0);
  passed('returning to answer bottom restores formula images alongside the unchanged prompt');
  screenshot = path.resolve('test-results/' + reportName + '.png');
  await act('capture', ['-OutputPath', screenshot]);
} catch (error) { failure = String(error); throw error; }
finally {
  await cli('--quit').catch(() => {}); await writeFile(control, 'exit');
  await writeFile('test-results/' + reportName + '.json', JSON.stringify({ completed: !failure, failure, checks, positions, distinctViewports: distinctViews.size,
    source: supplied ? 'supplied answer replay' : 'synthetic', screenshot, runAt: new Date().toISOString() }, null, 2));
}
