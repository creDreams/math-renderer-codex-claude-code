// A real, tool-free Codex answer validates its actual Markdown presentation.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const reuseArg = process.argv.indexOf('--reuse-work');
const reused = reuseArg < 0 ? undefined : path.resolve(process.argv[reuseArg + 1]);
const exec = promisify(execFile), run = reused ? path.basename(reused).replace('live-environments-', '') : Date.now().toString(36);
const pause = ms => new Promise(r => setTimeout(r, ms));
const work = reused ?? path.resolve('.cache/live-environments-' + run), profile = path.join(work, 'profile');
const binary = path.resolve('dist/windows/AgentMath.exe'), title = 'AgentMathResearch-LiveCodex';
const ps = (file, args) => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(file), ...args],
  { windowsHide: true, maxBuffer: 1024 * 1024 });
const act = (action, args = []) => ps('scripts/research/control-windows-terminal-probe.ps1', ['-WindowTitle', title, '-Action', action, ...args]);
const report = { checks: [], runAt: new Date().toISOString() };
await mkdir(profile, { recursive: true }); await mkdir('test-results', { recursive: true });
const prompt = path.join(work, 'prompt.txt');
const expected = `AMT environments ${run}: independently verified mathematical derivations.

\\begin{equation*}
\\frac{a+b}{c}=x
\\end{equation*}

- Listed derivation preserves all variables and operators.

  \\begin{align*}
  f(x)&=x^2\\\\
  g(x)&=x+1
  \\end{align*}

> Quoted derivation preserves its mathematical context.
>
> \\begin{gather*}
> a+b=c
> \\end{gather*}

AMT environments done ${run}.`;
await writeFile(prompt, 'Do not use any tools. Output exactly the following answer, keeping all LaTeX environments, Markdown list/quote markers, blank lines and indentation. Do not use code fences or replace the environments with dollar or bracket delimiters.\n\n' + expected);
await exec(binary, ['--pause']);
let failure;
try {
  if (!reused) await exec('wt.exe', ['-w', 'AgentMathLiveEnvironments-' + run, 'new-tab', '--title', title, '--suppressApplicationTitle',
    'powershell.exe', '-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve('scripts/research/launch-codex-fixture.ps1'), '-PromptPath', prompt]);
  await pause(1500); await act('focus'); await act('move', ['-X', '10', '-Y', '10']);
  await act('resize', ['-Width', '2300', '-Height', '1350']);
  const startedAt = Date.now();
  spawn(binary, ['--quiet', '--profile', profile, '--window-title', title,
    '--diagnostics', path.join(work, 'diagnostics.json')], { windowsHide: true, stdio: 'ignore' }).unref();
  const probeFile = path.join(work, 'view.json'); let view, status;
  const deadline = Date.now() + 90000;
  do {
    await ps('scripts/research/probe-windows-terminal-uia.ps1', ['-WindowTitle', title, '-OutputPath', probeFile]);
    view = JSON.parse(await readFile(probeFile, 'utf8'));
    status = await readFile(path.join(profile, 'status.json'), 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return { overlays: [] };
      throw error;
    });
    if (Date.parse(status.updatedAt) >= startedAt && status.workerReady &&
        view.elements[0].visible[0].text.includes(`AMT environments done ${run}`) && status.overlays.length === 3) break;
    await pause(300);
  } while (Date.now() < deadline);
  assert.equal(view.foregroundHwnd, view.hwnd, 'disposable research window must stay foreground');
  assert.ok(Date.parse(status.updatedAt) >= startedAt, 'a previous run status cannot satisfy this test');
  const visible = view.elements[0].visible[0];
  assert.ok(visible.text.includes(`AMT environments done ${run}`), 'real answer must finish');
  for (const name of ['equation*', 'align*', 'gather*']) {
    assert.ok(visible.text.includes('\\begin{' + name + '}'), 'real answer preserves ' + name);
    assert.ok(visible.text.includes('\\end{' + name + '}'));
  }
  report.checks.push('actual Codex preserves all three requested environments in root/list/quote contexts');
  for (let i = 0; i < 100 && status.overlays.length !== 3; i++) {
    await pause(50); status = JSON.parse(await readFile(path.join(profile, 'status.json'), 'utf8'));
  }
  assert.equal(status.overlays.length, 3, 'all real root/list/quote formulas render: ' + JSON.stringify(status));
  const lines = visible.text.split(/\r?\n/);
  for (const overlay of status.overlays) {
    const row = visible.rectangles.findIndex(rect => Math.floor(rect.y) === overlay.y);
    assert.ok(lines[row].includes('\\begin{'));
    const end = row + overlay.height / visible.rectangles[row].height - 1;
    assert.ok(lines[end].includes('\\end{'));
    assert.equal(overlay.hitTestOwner, view.hwnd);
  }
  report.checks.push('three actual environment images have exact UIA geometry and native mouse passthrough');
  await act('capture', ['-OutputPath', path.resolve('test-results/windows-live-environments.png')]);
  await act('finish-codex');
  for (const check of report.checks) console.log('PASS ' + check);
} catch (error) { failure = String(error); throw error; }
finally {
  await exec(binary, ['--profile', profile, '--quit']).catch(() => {});
  await exec(binary, ['--resume']);
  await writeFile('test-results/windows-live-environments.json', JSON.stringify({ ...report, completed: !failure, failure }, null, 2));
}
