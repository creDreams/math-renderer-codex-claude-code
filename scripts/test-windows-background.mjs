// Actual Windows Terminal attribute reads; does not activate a window or send input.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile), run = Date.now().toString(36), title = 'AgentMathResearch-Background-' + run;
const arg = process.argv.indexOf('--binary');
const binary = path.resolve(arg < 0 ? 'dist/windows/AgentMath.exe' : process.argv[arg + 1]);
const work = path.resolve('.cache/background-uia-' + run), control = path.join(work, 'control.txt'), input = path.join(work, 'input.json');
const pause = ms => new Promise(r => setTimeout(r, ms)), esc = '\x1b';
const selected = `${esc}[48;2;38;79;120m`, reset = `${esc}[49m`;
const first = 'x_t^2+y_t^2=r^2', second = 'a_t^2+b_t^2=c^2';
const multiline = 'J(θ) = E[ min(ρ_θ A_t,\r\n  clip(ρ_θ, 1−ε, 1+ε) A_t) ]';
const wrapped = 'L_total = ' + Array.from({ length: 45 }, (_, i) => `a_${i}^2`).join(' + ');
const normal = `❯ ${esc}[48;2;40;40;40mPinned mathematical question.${reset}\r\n` +
    `  A mathematical answer.\r\n\r\n  ${first}\r\n\r\n  Another definition.\r\n\r\n  ${second}\r\n\r\n  ${multiline}\r\n\r\n  ${wrapped}\r\n\r\n` +
    `${'─'.repeat(60)}\r\n❯\r\n${'─'.repeat(60)}\r\n  ? for shortcuts`;
const highlight = (raw, needle) => raw.replace(needle, selected + needle + reset);
const cases = [
    ['normal', normal, [true, true, true, true, true]],
    ['first', highlight(normal, first), [false, true, true, true, false]],
    ['partial', highlight(normal, 'y_t^2'), [false, true, true, true, false]],
    ['two', highlight(highlight(normal, first), second), [false, false, true, true, false]],
    ['prose', highlight(normal, 'Another definition.'), [true, true, true, true, true]],
    ['multiline', highlight(normal, 'clip(ρ_θ'), [true, true, false, true, true]],
    ['wrapped', highlight(normal, 'a_25^2'), [true, true, true, false, true]],
    ['padding', normal.replace(first + '\r\n\r\n', first + '\r\n' + selected + '  ' + reset + '\r\n'), [true, true, true, true, false]],
    ['restored', normal, [true, true, true, true, true]],
];
await mkdir(work, { recursive: true });
await writeFile(input, JSON.stringify({ ...Object.fromEntries(cases.map(([name, text]) => [name, text])),
    formulae: [{ start: first, end: first }, { start: second, end: second },
        { start: 'J(θ) =', end: '1+ε) A_t) ]' }, { start: 'L_total =', end: 'a_44^2' },
        { start: first, end: first, padBefore: 1, padAfter: 1 }], background: '#0c0c0c' }));
await writeFile(control, 'normal');
const report = { runAt: new Date().toISOString(), checks: [] };
try {
    await exec('wt.exe', ['-w', 'AgentMathBackground-' + run, 'new-tab', '--title', title, '--suppressApplicationTitle',
        'powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.resolve('scripts/research/windows-stream-fixture.ps1'), '-InputPath', input, '-ControlPath', control]);
    for (const [name, , expected] of cases) {
        await writeFile(control, name);
        let ready = false;
        for (let i = 0; i < 100; i++) {
            if (await readFile(control + '.ready', 'utf8').catch(() => '') === name) { ready = true; break; }
            await pause(100);
        }
        assert.ok(ready, name + ' fixture must be ready');
        const output = path.join(work, name + '.json');
        await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            path.resolve('scripts/research/read-windows-background.ps1'), '-WindowTitle', title, '-Binary', binary,
            '-InputPath', input, '-OutputPath', output], { windowsHide: true });
        const got = JSON.parse(await readFile(output, 'utf8'));
        assert.ok(got.checks.every(c => c.available), name + ' physical row geometry must resolve');
        assert.deepEqual(got.checks.map(c => c.clear), expected, name);
        assert.equal(got.nativeSelectionChars, 0, 'custom background must be tested without native selection');
        assert.ok(got.checks[3].physicalRows > 1, 'long formula must actually soft wrap');
        report.checks.push({ name, ...got });
        console.log('PASS actual UIA background attributes: ' + name + ' ' + JSON.stringify(expected));
    }
} catch (error) { report.error = String(error); throw error; }
finally {
    await writeFile(control, 'exit');
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/windows-background.json', JSON.stringify(report, null, 2) + '\n');
}
