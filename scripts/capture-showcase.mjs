// Real Windows Terminal screenshots of synthetic replays. No model requests.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile), run = Date.now().toString(36);
const work = path.resolve('.cache/showcase-' + run), profile = path.join(work, 'profile');
const codexHome = path.join(work, 'codex'), claudeHome = path.join(work, 'claude');
const title = 'AgentMathResearch-Showcase-' + run;
const input = path.join(work, 'input.json'), control = path.join(work, 'control.txt');
const binary = path.resolve('dist/windows/AgentMath.exe');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ps = (file, args = []) => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(file), ...args],
    { windowsHide: true, maxBuffer: 1024 * 1024 });
const act = (action, args = []) => ps('scripts/research/control-windows-terminal-probe.ps1', ['-WindowTitle', title, '-Action', action, ...args]);
const capture = (action, args = []) => ps('scripts/research/capture-showcase.ps1', ['-Action', action, '-WindowTitle', title, '-WorkDirectory', work, ...args]);
const cli = (...args) => exec(binary, ['--profile', profile, ...args], { windowsHide: true });
const end = 'End of example. Source remains copyable.';
const codex = String.raw`PPO uses a clipped objective to limit policy updates.

\[
\begin{aligned}
L^{\mathrm{CLIP}}(\theta) &= \mathbb{E}_t[\min(r_t(\theta)\hat A_t,
\operatorname{clip}(r_t(\theta),1-\epsilon,1+\epsilon)\hat A_t)],\\
r_t(\theta) &= \frac{\pi_\theta(a_t\mid s_t)}
{\pi_{\theta_{\mathrm{old}}}(a_t\mid s_t)}.
\end{aligned}
\]

` + end;
const formulas = [
    'L(θ) = E_t[min(r_t(θ) · A_t, clip(r_t(θ), 1−ε, 1+ε) · A_t)]',
    'r_t(θ) = π_θ(a_t | s_t) / π_old(a_t | s_t)',
    'g_t(θ) = sg[A_t] · ∇_θ log π_θ(a_t | s_t)',
];
const claude = 'PPO objective, probability ratio, and stop-gradient notation.\n\n' +
    formulas.map(raw => '```\n' + raw + '\n```').join('\n\n') + '\n\n' + end;
const esc = '\x1b', colour = `${esc}[38;2;177;185;249m`, reset = `${esc}[39m`;
const frame = (source, marker) => marker + ' ' + source.replace(/^```[^\n]*\n/gm, '').split('\n').map(row =>
    formulas.includes(row) ? colour + row + reset : row).join('\r\n  ') +
    '\r\n\r\n' + (marker === '●' ? '✻ Complete\r\n❯ ' : '  Worked for 2s\r\n\r\n› Ask Codex');
const report = { capturedAt: new Date().toISOString(), source: 'synthetic', pairs: [] };
const settingsFile = path.join(process.env.LOCALAPPDATA, 'AgentMath/settings.json');
let originalSettings, defaultPaused = false, launched = false;
async function until(predicate, label) {
    const deadline = Date.now() + 18000; let status;
    do {
        try { status = JSON.parse(await readFile(path.join(profile, 'status.json'), 'utf8')); if (predicate(status)) return status; }
        catch { }
        await pause(100);
    } while (Date.now() < deadline);
    throw Error(label + ': ' + JSON.stringify(status));
}
async function phase(name) {
    await writeFile(control, name);
    const deadline = Date.now() + 10000;
    while (await readFile(control + '.ready', 'utf8').catch(() => '') !== name) {
        if (Date.now() > deadline) throw Error('Replay did not finish: ' + name);
        await pause(100);
    }
}
await mkdir(profile, { recursive: true });
await mkdir(path.join(codexHome, 'sessions'), { recursive: true });
await mkdir(path.join(claudeHome, 'projects', 'D--demo'), { recursive: true });
await mkdir('docs/images', { recursive: true });
await mkdir('test-results', { recursive: true });
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ enabled: true, inlineMath: true }));
await writeFile(path.join(codexHome, 'sessions', 'rollout-demo.jsonl'), [
    { type: 'session_meta', payload: { id: 'public-demo', cwd: 'D:/demo' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: codex }] } },
].map(record => JSON.stringify(record)).join('\n') + '\n');
await writeFile(path.join(claudeHome, 'projects', 'D--demo', '00000000-0000-4000-8000-000000000001.jsonl'),
    JSON.stringify({ type: 'assistant', sessionId: 'public-demo', cwd: 'D:/demo', message: { role: 'assistant', content: [{ type: 'text', text: claude }] } }) + '\n');
await writeFile(input, JSON.stringify({ codex: frame(codex, '•'), claude: frame(claude, '●') }));
await writeFile(control, 'codex');
await capture('remember');
try {
    originalSettings = await readFile(settingsFile).catch(() => undefined);
    if (originalSettings) {
        await exec(binary, ['--pause'], { windowsHide: true }); defaultPaused = true;
    }
    await exec('wt.exe', ['-w', 'AgentMathShowcase-' + run, 'new-tab', '--title', title, '--suppressApplicationTitle',
        'powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.resolve('scripts/research/windows-stream-fixture.ps1'), '-InputPath', input, '-ControlPath', control]);
    await pause(1200);
    await act('focus');
    await act('move', ['-X', '30', '-Y', '30']);
    await act('resize', ['-Width', '1280', '-Height', '850']);
    spawn(binary, ['--quiet', '--profile', profile, '--window-title', title, '--codex-home', codexHome],
        { env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome }, stdio: 'ignore', windowsHide: true }).unref();
    launched = true;
    await until(status => status.workerReady, 'renderer ready');
    for (const [name, expected, label] of [['codex', 1, 'Codex CLI / LaTeX block'], ['claude', 3, 'Claude Code / unmarked math blocks']]) {
        await cli('--pause');
        await phase(name);
        await until(status => !status.enabled && status.overlays.length === 0, 'source-only view');
        await pause(400);
        const before = path.join(work, name + '-before.png'), after = path.join(work, name + '-after.png');
        await capture('crop', ['-OutputPath', before, '-PairName', name, '-EndNeedle', end]);
        await cli('--resume');
        const status = await until(status => status.state === 'rendered' && status.overlays.length === expected, name + ' overlays');
        assert.ok(status.overlays.every(overlay => overlay.hitTestOwner === status.targetHwnd), 'mouse input passes through');
        await pause(500);
        await capture('crop', ['-OutputPath', after, '-PairName', name, '-EndNeedle', end]);
        const output = path.resolve('docs/images/' + name + '-comparison.png');
        await capture('compose', ['-BeforePath', before, '-AfterPath', after, '-OutputPath', output, '-Label', label]);
        report.pairs.push({ agent: name, expected, rendered: status.overlays.length, sourceTextUnchanged: true,
            version: status.version, output: 'docs/images/' + name + '-comparison.png' });
        console.log('Captured ' + name + ': ' + expected + ' actual overlays; source and viewport unchanged');
    }
    await writeFile('test-results/showcase-capture.json', JSON.stringify(report, null, 2) + '\n');
} finally {
    if (launched) await cli('--quit').catch(() => {});
    await writeFile(control, 'exit').catch(() => {});
    if (defaultPaused && originalSettings) {
        const enabled = JSON.parse(originalSettings.toString('utf8')).enabled;
        await exec(binary, [enabled ? '--resume' : '--pause'], { windowsHide: true });
        await writeFile(settingsFile, originalSettings);
    }
    await capture('restore').catch(() => {});
}
