// Makes two real Codex requests. The second streams while the first formula stays visible.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile), run = Date.now().toString(36), observe = process.argv.includes('--observe');
const environments = process.argv.includes('--environments');
const inline = process.argv.includes('--inline');
const open = environments ? '\\begin{equation*}' : '\\[', close = environments ? '\\end{equation*}' : '\\]';
const reportName = 'windows-live-stream' + (environments ? '-environments' : '') + (inline ? '-inline' : '') + (observe ? '-baseline' : '');
const work = path.resolve('.cache/live-stream-' + run), profile = path.join(work, 'profile');
const arg = process.argv.indexOf('--binary');
const binary = path.resolve(arg < 0 ? 'dist/windows/AgentMath.exe' : process.argv[arg + 1]);
const title = 'AgentMathResearch-LiveCodex', pause = ms => new Promise(r => setTimeout(r, ms));
const ps = (file, args) => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(file), ...args],
  { windowsHide: true, maxBuffer: 1024 * 1024 });
const act = (action, args = []) => ps('scripts/research/control-windows-terminal-probe.ps1', ['-WindowTitle', title, '-Action', action, ...args]);
const report = { checks: [], observe, runAt: new Date().toISOString() };
await mkdir(profile, { recursive: true }); await mkdir('test-results', { recursive: true });
if (inline) await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ enabled: true, inlineMath: true }));
const first = path.join(work, 'first.txt'), second = path.join(work, 'second.txt');
const inlineText = inline ? '\n圆的公式 x^2 + y^2 = r^2，后文。\n优势公式 Â_t = Q_t − V_t，后文。\n显式公式 \\(a_{i,j}^2+b_{i,j}^2=c_{i,j}^2\\)，后文。\n代码 `x² + y² = r²` 保留原样。\n' : '\n';
const seedCount = inline ? 4 : 1;
await writeFile(first, `Do not use any tools. Output exactly this short answer without a code fence. Keep the inline code backticks only on the code example; preserve the other literal math markers: AMT seed ${run}${inlineText}${open}\n\\max_q\\left\\{\\mathbb E_{a\\sim q}[Q(s,a)]-\\eta\\,\\mathrm{KL}(q\\|p)\\right\\}\n${close}\nAMT seed done.`);
await writeFile(second, `Do not use any tools. Answer in English, no code fences. Start with the sentence "AMT stream ${run}" and then immediately display the PPO clipped surrogate objective in literal LaTeX delimited by ${open} and ${close} on separate lines. Preserve those exact markers. The formula source must occupy exactly three physical lines including the two marker lines. Then write a continuous paragraph of about ${inline ? 150 : 250} words explaining the objective carefully. End with "AMT stream done ${run}". Do not use a list or section headings. Keep the explanation in one paragraph after the formula.`);
async function status() {
  for (let i = 0; ; i++) {
    try { return JSON.parse(await readFile(path.join(profile, 'status.json'), 'utf8')); }
    catch (error) { if (i > 20 || !['ENOENT', 'EBUSY', 'EPERM'].includes(error.code)) throw error; await pause(10); }
  }
}
async function until(predicate, label, timeout = 90000) {
  let value; const start = Date.now();
  do { try { value = await status(); if (predicate(value)) return value; } catch {} await pause(50); }
  while (Date.now() - start < timeout);
  throw new Error(label + ': ' + JSON.stringify(value));
}
function passed(text) { report.checks.push(text); console.log('PASS ' + text); }
await exec(path.resolve('dist/windows/AgentMath.exe'), ['--pause']);
try {
  await exec('wt.exe', ['-w', 'AgentMathLiveStream-' + run, 'new-tab', '--title', title, '--suppressApplicationTitle',
    'powershell.exe', '-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve('scripts/research/launch-codex-fixture.ps1'), '-PromptPath', first]);
  await pause(1500); await act('focus'); await act('move', ['-X', '10', '-Y', '10']);
  await act('resize', ['-Width', '2300', '-Height', '1350']);
  spawn(binary, ['--quiet', '--profile', profile, '--window-title', title,
    '--diagnostics', path.join(work, 'diagnostics.json')], { windowsHide: true, stdio: 'ignore' }).unref();
  const before = await until(x => x.state === 'rendered' && x.overlays.length === seedCount, 'seed not rendered');
  if (inline) assert.equal(before.overlays.filter(x => x.kind === 'inline').length, 3);
  passed('first real Codex answer independently renders');
  const samples = [], started = Date.now();
  await act('prompt', ['-InputPath', second]);
  let after;
  do {
    const current = await status(); samples.push(current);
    if (current.overlays.length === seedCount + 1) { after = current; break; }
    await pause(50);
  } while (Date.now() - started < 90000);
  assert.ok(after, 'second real answer must finish and render alongside the first');
  await pause(1000); after = await status(); samples.push(after);
  report.streaming = { elapsedMs: Date.now() - started,
    captures: new Set(samples.map(x => x.captureKey).filter(Boolean)).size,
    hiddenTransitions: after.hiddenTransitions - before.hiddenTransitions,
    emptySamples: samples.filter(x => before.overlays.some(old => !x.overlays.some(o => o.imageId === old.imageId))).length,
    hiddenReasons: after.hiddenReasons, versions: [before.version, after.version] };
  console.log(JSON.stringify(report.streaming));
  assert.ok(report.streaming.captures >= 8, 'must exercise actual streaming snapshots');
  assert.ok(after.overlays.some(x => x.imageId === before.overlays[0].imageId), 'test must keep the historical formula on screen');
  if (!observe) {
    assert.equal(report.streaming.hiddenTransitions, 0, 'historical formula must remain continuously visible during real Codex output');
    assert.equal(report.streaming.emptySamples, 0, 'all samples retain the historical image');
  }
  passed(observe ? 'baseline actual Codex streaming observed' : 'actual Codex thinking and next-answer streaming preserve the historical image without hiding');
  const probeFile = path.join(work, 'final-view.json');
  await ps('scripts/research/probe-windows-terminal-uia.ps1', ['-WindowTitle', title, '-OutputPath', probeFile]);
  const view = JSON.parse(await readFile(probeFile, 'utf8'));
  assert.equal(view.foregroundHwnd, view.hwnd, 'research window must remain foreground');
  const visible = view.elements[0].visible[0], lines = visible.text.split(/\r?\n/);
  assert.ok(visible.text.includes(`AMT stream done ${run}`));
  for (const overlay of after.overlays) {
    const row = visible.rectangles.findIndex(rect => Math.floor(rect.y) === overlay.y);
    if (overlay.kind === 'inline') {
      assert.ok(/x\^2|[AÂ]̂?_t|a_\{i,j\}/u.test(lines[row]), 'inline image belongs to its own formula row');
      assert.ok(!lines[row].includes('代码'), 'protected code must not receive an image');
      assert.equal(overlay.height, visible.rectangles[row].height);
    } else {
      assert.equal(lines[row].trim(), open);
      const end = row + overlay.height / visible.rectangles[row].height - 1;
      assert.equal(lines[end].trim(), close);
    }
    assert.equal(overlay.hitTestOwner, view.hwnd);
  }
  passed('completed real formulas have correct rows and native mouse passthrough; code stays literal');
  await act('capture', ['-OutputPath', path.resolve('test-results/' + reportName + '.png')]);
  report.completed = true;
} catch (error) {
  report.failure = String(error); throw error;
} finally {
  await act('finish-codex').catch(() => {});
  await exec(binary, ['--profile', profile, '--quit']).catch(() => {});
  await exec(path.resolve('dist/windows/AgentMath.exe'), ['--resume']);
  await writeFile('test-results/' + reportName + '.json', JSON.stringify(report, null, 2));
}
