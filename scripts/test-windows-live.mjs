// Explicitly invokes a real interactive Codex and sends two no-tools formula prompts.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile), title = 'AgentMathResearch-LiveCodex';
const attached = process.argv[2] === '--attach' ? path.resolve(process.argv[3]) : undefined;
const secondOnly = Boolean(attached && process.argv.includes('--second-only'));
const run = attached ? path.basename(attached).replace('live-test-', '') : Date.now().toString(36);
const work = attached ?? path.resolve('.cache/live-test-' + run), profile = path.join(work, 'profile');
await mkdir(work, { recursive: true }); await mkdir('test-results', { recursive: true });
const binary = path.resolve('dist/windows/AgentMath.exe'), pause = ms => new Promise(r => setTimeout(r, ms));
const ps = (script, args) => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(script), ...args], { windowsHide: true, maxBuffer: 1024 * 1024 });
const act = (action, args = []) => ps('scripts/research/control-windows-terminal-probe.ps1', ['-WindowTitle', title, '-Action', action, ...args]);
const probePath = path.resolve('test-results/native-live-capture.json');
async function probe() {
  await ps('scripts/research/probe-windows-terminal-uia.ps1', ['-WindowTitle', title, '-OutputPath', probePath]);
  return JSON.parse(await readFile(probePath, 'utf8'));
}
const prompt = (number, tex) => `Do not use tools. Reply with exactly five lines and no code fences: first line AMT live ${run} equation ${number}; second line \\[; third line ${tex}; fourth line \\]; fifth line AMT complete ${number}. Treat the delimiters literally and do not replace them with dollar signs.`;
const firstPrompt = path.join(work, 'first.txt'), secondPrompt = path.join(work, 'second.txt');
await writeFile(firstPrompt, prompt(1, '\\max_q \\left\\{\\mathbb E_{a\\sim q}[Q(s,a)]-\\eta\\,\\mathrm{KL}(q\\|p)\\right\\}'));
await writeFile(secondPrompt, prompt(2, '\\max_q \\left\\{2\\mathbb E_{a\\sim q}[\\widehat Q(s,a)]-\\eta\\,\\mathrm{KL}(q\\|q_{\\mathrm{prior}})\\right\\}'));
let host, result = { checks: [], runAt: new Date().toISOString() };
if (secondOnly) result = JSON.parse(await readFile('test-results/windows-live.json', 'utf8'));
function passed(check) { result.checks.push(check); console.log('PASS ' + check); }
async function waitEquation(number) {
  const start = Date.now(); let text = '', status;
  do {
    await pause(900);
    const p = await probe(); text = p.elements.map(x => x.visible.map(y => y.text).join('\n')).join('\n');
    try { status = JSON.parse(await readFile(path.join(profile, 'status.json'), 'utf8')); } catch { continue; }
    if (text.includes(`AMT complete ${number}`) && status.state === 'rendered' && status.overlays.length > 0) {
      // The newly answered equation, rather than a previous one, must have an overlay at its actual row.
      const pane = p.elements.find(x => x.visible.some(y => y.text.includes(`AMT complete ${number}`)));
      const visible = pane.visible[0], lines = visible.text.split(/\r?\n/);
      const end = lines.findLastIndex(x => x.trim().replace(/\.$/, '') === `AMT complete ${number}`);
      let begin = end - 1; while (begin >= 0 && lines[begin].trim() !== '\\[') begin--;
      if (begin < 0 || !visible.rectangles[begin]) continue;
      const y = visible.rectangles[begin].y;
      if (!status.overlays.some(x => Math.abs(x.y - y) <= 2 && x.hitTestOwner === p.hwnd)) continue;
      return { p, status, elapsedMs: Date.now() - start };
    }
  } while (Date.now() - start < 120000);
  await writeFile('test-results/native-live-failure.txt', text);
  throw new Error('Real Codex equation ' + number + ' did not render: ' + JSON.stringify(status));
}
try {
  if (!attached) await exec('wt.exe', ['-w', 'AgentMathLive-' + run, 'new-tab', '--title', title, '--suppressApplicationTitle',
    'powershell.exe', '-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve('scripts/research/launch-codex-fixture.ps1'), '-PromptPath', firstPrompt]);
  await pause(2000); await act('focus'); await act('resize', ['-Width', '1500', '-Height', '950']);
  host = spawn(binary, ['--quiet', '--profile', profile, '--window-title', title], { windowsHide: true, stdio: 'ignore' });
  if (!secondOnly) {
  const first = await waitEquation(1); passed('real interactive Codex new answer automatically renders at its UIA row');
  await act('click-formula'); await pause(700);
  assert.equal(JSON.parse(await readFile(path.join(profile, 'status.json'), 'utf8')).hiddenTransitions,
    first.status.hiddenTransitions, 'ordinary formula click must not flicker');
  passed('real Codex formula single click stays rendered');
  const beforeInput = JSON.parse(await readFile(path.join(profile, 'status.json'), 'utf8'));
  const input = JSON.parse((await act('input')).stdout);
  assert.equal(input.typedTextVisible, true); assert.equal(input.originalTextRestored, true);
  await pause(700);
  assert.equal(JSON.parse(await readFile(path.join(profile, 'status.json'), 'utf8')).hiddenTransitions,
    beforeInput.hiddenTransitions, 'typing and caret movement must not flicker');
  passed('real Codex incremental typing, arrows and deletion remain native and keep formulas stable');
  const selected = JSON.parse((await act('drag-formula')).stdout);
  assert.ok(selected.selectedSource.join('').includes('\\max_q'));
  await pause(600);
  assert.equal(JSON.parse(await readFile(path.join(profile, 'status.json'), 'utf8')).overlays.length, 0);
  passed('real Codex mouse selection reveals original source');
  await act('clear-selection');
  }
  await act('prompt', ['-InputPath', secondPrompt]);
  await waitEquation(2); passed('second continuous answer is independently recognized and rendered');
  await act('capture', ['-OutputPath', path.resolve('test-results/native-live-rendered.png')]);
  for (const action of ['wheel-up', 'wheel-down']) { await act(action); await pause(500); }
  passed('real Codex accepts native mouse wheel events');
  const finish = JSON.parse((await act('finish-codex')).stdout);
  assert.equal(finish.codexExitedWithCtrlC, true); assert.equal(finish.researchWindowClosed, true);
  passed('Ctrl+C exits Codex normally and closes only the disposable test terminal');
  result.passed = result.checks.length;
} finally {
  await exec(binary, ['--profile', profile, '--quit']).catch(() => {});
  await writeFile('test-results/windows-live.json', JSON.stringify(result, null, 2) + '\n');
}
