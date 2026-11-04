// Local replay only: never starts Claude, sends a prompt or reads user sessions.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile), run = Date.now().toString(36), title = 'AgentMathResearch-Claude-' + run;
const work = path.resolve('.cache/claude-desktop-' + run), profile = path.join(work, 'profile'), home = path.join(work, 'claude');
const arg = process.argv.indexOf('--binary');
const binary = path.resolve(arg < 0 ? 'dist/windows/AgentMath.exe' : process.argv[arg + 1]);
const interactionsOnly = process.argv.includes('--interactions-only');
const input = path.join(work, 'input.json'), control = path.join(work, 'control.txt');
const pause = ms => new Promise(r => setTimeout(r, ms)), checks = [];
const formulae = [
    'R_t^(i) = Σ_{k=t}^{T} γ^(k−t) · r_k^(i)',
    'U = { s̃ | s̃ 在 {τ_i} 中出现过 }',
    'A(a_t^(i)) = A^E(τ_i) + ω · A^S(a_t^(i))',
    'J(θ) = E[ min(ρ_θ · A_t,\n  clip(ρ_θ, 1−ε, 1+ε) · A_t) ]\n  − β · D_KL(π_θ || π_ref)',
];
const code = 'const x = y^2 + z^2;';
const source = `Claude mathematical replay ${run}.\n\n` + formulae.map((f, i) => `Formula ${i + 1} definition.\n\n\`\`\`\n${f}\n\`\`\`\n`).join('\n') + `\nProgram example.\n\n\`\`\`javascript\n${code}\n\`\`\`\n\nComplete answer.`;
const commonCases = JSON.parse(await readFile('tests/fixtures/claude-common-math.json', 'utf8'));
const commonSource = commonCases.map(({ name, raw }) => `The ${name} mathematical definition.\n\n\`\`\`\n${raw}\n\`\`\`\n\nEnd of the ${name} definition.`).join('\n\n');
const dpoFixture = JSON.parse(await readFile('tests/fixtures/claude-dpo-math.json', 'utf8'));
const dpoSource = dpoFixture.intro + '\n\n' + dpoFixture.blocks.map(({ name, raw }) => `${name}.\n\n\`\`\`\n${raw}\n\`\`\`\n\nEnd of ${name}.`).join('\n\n');
const dpoFormulae = dpoFixture.blocks.flatMap(({ raw }) => raw.split(/\n\s*\n/));
const gspoFixture = JSON.parse(await readFile('tests/fixtures/claude-gspo-math.json', 'utf8'));
const gspoSource = gspoFixture.intro + '\n\n' + gspoFixture.blocks.map(({ name, raw }) => name + ' formula.\n\n```\n' + raw + '\n```\n\nEnd of ' + name + '.').join('\n\n');
const gspoFormulae = gspoFixture.blocks.flatMap(block => block.expressions === 1 ? [block.raw] : block.raw.split('\n\n'));
const mixedRaw = 'L_θ = E_t[x_t]\n\n其中 x_t 表示逐步损失。\n\nm_t = 1  当 s_t 属于回答 y\nm_t = 0  当 s_t 属于提示 x 或 padding\n\n说明：下面是梯度。\n\n∇_θ L_θ = E_t[∇_θ x_t]';
const mixedSource = 'Annotated mathematical definition.\n\n```\n' + mixedRaw + '\n```\n\nEnd of annotated definition.';
const explicitSource = 'Explicit mathematical quantity.\n\n```\n\\[\nq_{reference}\n\\]\n```\n\nEnd of explicit definition.';
const esc = '\x1b', colour = `${esc}[38;2;177;185;249m`, reset = `${esc}[39m`;
const plain = '● ' + source.replace(/^```[^\n]*\n/gm, '').split('\n').join('\n  ');
const coloured = plain.split('\n').map(l => formulae.some(f => f.split('\n').some(x => l.trim() === x.trim())) || l.includes(code) ? colour + l + reset : l).join('\r\n');
const normal = coloured + '\r\n\r\n✻ Churned for 3s\r\n❯ ';
const ps = (file, args = []) => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(file), ...args], { windowsHide: true, maxBuffer: 1024 * 1024 });
const act = (action, args = []) => ps('scripts/research/control-windows-terminal-probe.ps1', ['-WindowTitle', title, '-Action', action, ...args]);
const cli = (...args) => exec(binary, ['--profile', profile, ...args], { windowsHide: true });
const status = async () => JSON.parse(await readFile(path.join(profile, 'status.json'), 'utf8'));
const pass = label => { checks.push(label); console.log('PASS ' + label); };
async function until(predicate, label, timeout = 16000) {
    const start = Date.now();
    let last;
    do {
        try {
            last = await status();
            if (predicate(last))
                return last;
        }
        catch { }
        await pause(100);
    } while (Date.now() - start < timeout);
    throw Error(label + ': ' + JSON.stringify(last));
}
async function phase(name) { await writeFile(control, name); const start = Date.now(); while (Date.now() - start < 10000) {
    if (await readFile(control + '.ready', 'utf8').catch(() => '') === name)
        return;
    await pause(50);
} throw Error('Replay phase failed: ' + name); }
async function renderedPhase(name, count) {
    const before = await status(), changedAt = Date.now();
    await phase(name);
    const readyAt = Date.now();
    return until(x => x.captureKey !== before.captureKey && x.state === 'rendered' && x.overlays.length === count &&
        Date.parse(x.renderedAt) >= changedAt && Date.parse(x.updatedAt) >= readyAt, name + ' renders a fresh page');
}
await mkdir(path.join(home, 'projects', 'D--fixture'), { recursive: true });
await mkdir(profile, { recursive: true });
await mkdir('test-results', { recursive: true });
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ enabled: true, inlineMath: true }));
await writeFile(path.join(home, 'projects', 'D--fixture', '00000000-0000-4000-8000-000000000001.jsonl'), [source, commonSource, dpoSource, mixedSource, gspoSource, explicitSource].map(text => JSON.stringify({ type: 'assistant', sessionId: 'claude-' + run, cwd: 'D:/fixture', message: { role: 'assistant', content: [{ type: 'text', text }] } })).join('\n') + '\n');
const phases = { normal, selectionNeedle: formulae[0], 'redraw-thinking': Array.from({ length: 32 }, (_, i) => coloured + `\r\n\r\n✻ Thinking for ${i}s\r\n❯ `),
    'redraw-answer': Array.from({ length: 32 }, (_, i) => normal + `next\r\n● A new unrecorded answer ${'.'.repeat(i)}`),
    'source-changed': normal.replace('Σ_{k=t}^{T}', 'Σ_{k=t}^{9}'),
    'scrollback': normal + '\r\n' + Array.from({ length: 100 }, (_, i) => 'historical filler ' + i + '\r\n').join(''),
    'plain-theme': plain.split('\n').join('\r\n') + '\r\n✻ Churned for 3s\r\n❯ ' };
// Claude's own scroll UI repaints the visible page instead of exposing older
// terminal rows. Deliberately omit every assistant marker and all source text
// preceding the current viewport, matching the real reported failure.
const historyRows = plain.split('\n').slice(1), historyCases = [];
const compact = text => text.replace(/\s/gu, '');
const historyFrame = (body, suffix = '') => `❯ Explain the mathematical derivation.\r\n${body.join('\r\n')}\r\n  Jump to bottom (ctrl+End) ↓\r\n${'─'.repeat(80)}\r\n❯ \r\n${'─'.repeat(80)}\r\n  ⏵⏵ bypass permissions on (shift+tab to cycle)${suffix}`;
for (const height of [12, 20])
    for (const offset of [0, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]) {
        const rows = historyRows.slice(offset, offset + height);
        for (const layout of ['pinned-history', 'history', 'pinned-bottom', 'bottom', 'bottom-completed']) {
            const name = `history-${height}-${offset}-${layout}`;
            let frame = historyFrame(rows);
            if (!layout.startsWith('pinned')) frame = frame.replace(/^❯[^\r]*\r\n/u, '');
            if (layout.includes('bottom')) frame = frame.replace('Jump to bottom (ctrl+End) ↓', layout === 'bottom-completed' ? '✻ Churned for 35s · done 17:54' : '');
            phases[name] = frame;
            historyCases.push({ name, offset, height, layout, expected: formulae.filter(raw => compact(rows.join('')).includes(compact(raw))).length });
        }
    }
const steadyHistory = historyRows.slice(3, 23);
phases['history-steady'] = historyFrame(steadyHistory);
phases['redraw-history'] = Array.from({ length: 32 }, (_, i) => historyFrame(steadyHistory, ` · Thinking ${i}s`));
phases['history-bottom'] = historyFrame(steadyHistory).replace('Jump to bottom (ctrl+End) ↓', '');
phases['history-changed'] = historyFrame(steadyHistory).replace('Σ_{k=t}^{T}', 'Σ_{k=t}^{9}');
phases['bottom-steady'] = historyFrame(steadyHistory).replace(/^❯[^\r]*\r\n/u, '').replace('Jump to bottom (ctrl+End) ↓', '✻ Churned for 35s · done 17:54');
phases['redraw-bottom'] = Array.from({ length: 32 }, (_, i) => phases['bottom-steady'].replace('done 17:54', `done 17:54 · ${i}`));
const selectBackground = (text, needle) => text.replace(needle, `${esc}[48;2;38;79;120m${needle}${esc}[49m`);
phases['app-selection-first'] = selectBackground(phases['bottom-steady'], formulae[0]);
phases['app-selection-partial'] = selectBackground(phases['bottom-steady'], 'γ^(k−t)');
phases['app-selection-two'] = selectBackground(phases['app-selection-first'], formulae[1]);
phases['app-selection-prose'] = selectBackground(phases['bottom-steady'], 'Formula 2 definition.');
phases['redraw-app-selection'] = Array.from({ length: 32 }, (_, i) => phases['app-selection-first'].replace('done 17:54', `done 17:54 · ${i}`));
for (const [index, { name, raw }] of commonCases.entries()) {
    phases['common-' + index] = historyFrame([`  The ${name} mathematical definition.`, '', ...raw.split('\n').map(x => '  ' + x), '', `  End of the ${name} definition.`]);
}
phases['redraw-common'] = Array.from({ length: 32 }, (_, i) => phases['common-1'].replace('shift+tab to cycle)', `shift+tab to cycle) · Thinking ${i}s`));
const dpoRows = dpoSource.replace(/^```[^\n]*\n/gm, '').split('\n').map(row => '  ' + row), dpoPositions = [];
for (let offset = 0; offset < dpoRows.length; offset += 3) {
    const rows = dpoRows.slice(offset, offset + 16), name = 'dpo-' + offset;
    phases[name] = historyFrame(rows);
    dpoPositions.push({ name, expected: dpoFormulae.filter(raw => compact(rows.join('')).includes(compact(raw))).length });
}
phases['mixed-math'] = historyFrame(mixedSource.replace(/^```[^\n]*\n/gm, '').split('\n').map(row => '  ' + row));
phases['redraw-mixed'] = Array.from({ length: 32 }, (_, i) => phases['mixed-math'].replace('shift+tab to cycle)', `shift+tab to cycle) · Thinking ${i}s`));
const gspoRows = gspoSource.replace(/^```[^\n]*\n/gm, '').split('\n').map(row => '  ' + row), gspoPositions = [];
for (let offset = 0; offset < gspoRows.length; offset += 3) {
    const rows = gspoRows.slice(offset, offset + 18), name = 'gspo-' + offset;
    phases[name] = historyFrame(rows);
    gspoPositions.push({ name, expected: gspoFormulae.filter(raw => compact(rows.join('')).includes(compact(raw))).length });
}
gspoFixture.blocks.forEach(({ name, raw }, i) => {
    phases['gspo-block-' + i] = historyFrame(['  ' + name + ' formula.', '', ...raw.split('\n').map(row => '  ' + row), '', '  End of ' + name + '.']);
});
phases['redraw-gspo'] = Array.from({ length: 32 }, (_, i) => phases['gspo-block-5'].replace('shift+tab to cycle)', `shift+tab to cycle) · Thinking ${i}s`));
phases['explicit-body'] = historyFrame(explicitSource.replace(/^```[^\n]*\n/gm, '').split('\n').map(row => '  ' + row));
await writeFile(input, JSON.stringify(phases));
await writeFile(control, 'normal');
let result = { runAt: new Date().toISOString(), checks, interactionsOnly };
try {
    await exec('wt.exe', ['-w', 'AgentMathClaude-' + run, 'new-tab', '--title', title, '--suppressApplicationTitle', 'powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/research/windows-stream-fixture.ps1'), '-InputPath', input, '-ControlPath', control]);
    await pause(800);
    await act('focus');
    await act('move', ['-X', '20', '-Y', '20']);
    await act('resize', ['-Width', '1700', '-Height', '1000']);
    spawn(binary, ['--quiet', '--profile', profile, '--window-title', title, '--codex-home', path.join(work, 'codex')], { env: { ...process.env, CLAUDE_CONFIG_DIR: home }, stdio: 'ignore', windowsHide: true }).unref();
    const start = Date.now();
    let s = await until(x => x.state === 'rendered' && x.overlays.length === 4, 'four formula blocks render');
    const normalImages = s.overlays.map(x => x.imageId).sort();
    assert.equal(s.foreground, '#cccccc', 'math uses one neutral colour on the actual dark background');
    result.initialMs = Date.now() - start;
    pass('four Claude math blocks render; same-colour JavaScript stays literal');
    assert.ok(s.overlays.every(o => o.hitTestOwner === s.targetHwnd));
    pass('formula windows pass mouse input to the original terminal');
    await act('capture', ['-OutputPath', path.resolve('test-results/windows-claude.png')]);
    const hides = s.hiddenTransitions;
    for (const name of ['redraw-thinking', 'redraw-answer']) {
        await phase(name);
        s = await until(x => x.state === 'rendered' && x.overlays.length === 4, name + ' stays rendered');
        assert.equal(s.hiddenTransitions, hides, 'unchanged old formulas never disappear during ' + name);
        pass(name + ' preserves previous images');
    }
    await phase('normal');
    await cli('--inline-off');
    await until(x => x.overlays.length === 0, 'preview off withdraws all unmarked formulas');
    pass('preview off withdraws Claude mathematical code blocks');
    await cli('--inline-on');
    await until(x => x.overlays.length === 4, 'preview on restores');
    const beforeColourChange = s.captureKey;
    await phase('plain-theme');
    s = await until(x => x.captureKey !== beforeColourChange && x.overlays.length === 4, 'uncoloured source still matches');
    assert.equal(s.foreground, '#cccccc');
    assert.deepEqual(s.overlays.map(x => x.imageId).sort(), normalImages, 'source syntax colours cannot recolour or regenerate the mathematical images');
    pass('recognition succeeds without the blue-purple colour');
    pass('rendered colour and image identities are independent of source syntax colours');
    await phase('source-changed');
    await until(x => x.overlays.length === 3, 'changed source cannot retain old formula');
    pass('modified summation removes only its unverified image');
    await phase('normal');
    await until(x => x.overlays.length === 4, 'normal restored');
    await act('select-inline', ['-InputPath', input]);
    await until(x => x.overlays.length === 3, 'selection reveals only one formula');
    await act('clear-selection', ['-InputPath', input]);
    await until(x => x.overlays.length === 4, 'clearing selection restores');
    pass('native selection reveals source and restores each formula');
    const historyStart = Date.now(), historyPositions = [];
    result.historyPositions = historyPositions;
    for (const entry of interactionsOnly ? [] : historyCases) {
        const changedAt = Date.now(), oldKey = s.captureKey;
        await phase(entry.name);
        // A page containing no mathematical glyphs intentionally publishes no
        // capture. Consecutive empty pages therefore both have a null key.
        s = await until(x => Date.parse(x.updatedAt) >= changedAt && x.overlays.length === entry.expected &&
            (entry.expected === 0 ? x.state === 'no-formula' || x.captureKey !== oldKey :
                x.captureKey !== oldKey && x.state === 'rendered' && Date.parse(x.renderedAt) >= changedAt), entry.name + ' independently visible expressions render');
        historyPositions.push({ ...entry, count: s.overlays.length });
    }
    result.historyPositions = historyPositions;
    result.historyDurationMs = Date.now() - historyStart;
    if (!interactionsOnly) pass('all complete formulas render across 130 viewport and layout combinations including unpinned bottom');
    const steadyCount = formulae.filter(raw => compact(steadyHistory.join('')).includes(compact(raw))).length;
    s = await renderedPhase('history-steady', steadyCount);
    const historyHides = s.hiddenTransitions;
    s = await renderedPhase('redraw-history', steadyCount);
    assert.equal(s.hiddenTransitions, historyHides, 'history frame animation never withdraws verified formulas');
    pass('history without assistant markers retains images during status animation');
    await renderedPhase('history-bottom', steadyCount);
    pass('reaching the bottom retains formulas when the jump hint disappears');
    s = await renderedPhase('bottom-steady', steadyCount);
    const bottomHides = s.hiddenTransitions;
    s = await renderedPhase('redraw-bottom', steadyCount);
    assert.equal(s.hiddenTransitions, bottomHides);
    pass('bottom without any header, hint or assistant marker retains images during status redraw');
    await act('capture', ['-OutputPath', path.resolve('test-results/windows-claude-bottom.png')]);
    await renderedPhase('history-changed', steadyCount - 1);
    pass('repainted historical source changes remove only the altered formula');
    await renderedPhase('history-steady', steadyCount);
    const clickBaseline = await status();
    for (const action of ['hover-inline', 'click-inline']) {
        await act(action, ['-InputPath', input]);
        s = await until(x => Date.parse(x.updatedAt) > Date.parse(clickBaseline.updatedAt) && x.overlays.length === steadyCount,
            action + ' retains every formula');
        assert.equal(s.hiddenTransitions, clickBaseline.hiddenTransitions, 'ordinary hover and click never withdraw an image');
    }
    pass('hover and single click preserve all Claude images without hidden transitions');
    const dragged = JSON.parse((await act('drag-inline', ['-InputPath', input])).stdout);
    result.dragSelection = dragged;
    assert.ok(dragged.duringDrag.join('').includes('R_t'), 'real mouse drag selects the original mathematical text');
    await until(x => x.overlays.length === steadyCount - 1, 'real drag withdraws the selected formula');
    await act('clear-selection', ['-InputPath', input]);
    await until(x => x.overlays.length === steadyCount, 'clearing real mouse selection restores formula');
    pass('actual mouse dragging exposes Claude source and restores only the affected formula');
    await act('select-inline', ['-InputPath', input]);
    await until(x => x.overlays.length === steadyCount - 1, 'historical selection exposes exactly one source expression');
    await act('clear-selection', ['-InputPath', input]);
    await until(x => x.overlays.length === steadyCount, 'historical selection clearing restores rendering');
    pass('repainted history retains native source selection and restoration');
    await act('capture', ['-OutputPath', path.resolve('test-results/windows-claude-history.png')]);
    s = await renderedPhase('bottom-steady', steadyCount);
    const surfaceKey = s.captureKey, surfaceImages = s.overlays.map(x => x.imageId).sort();
    async function surfacePhase(name, count, styled, sameKey = true) {
        await phase(name);
        const readyAt = Date.now();
        const value = await until(x => Date.parse(x.updatedAt) >= readyAt && x.overlays.length === count &&
            x.displayGeometryPending === 0 && x.styledSourceAreas === styled, name + ' preserves source backgrounds');
        assert.equal(value.foreground, '#cccccc');
        assert.equal(value.background, '#0c0c0c', 'selected first glyph cannot change the terminal background');
        if (sameKey) assert.equal(value.captureKey, surfaceKey, 'background selection does not invalidate source proof');
        assert.ok(value.overlays.every(o => surfaceImages.includes(o.imageId)), 'selection never regenerates differently coloured formula images');
        return value;
    }
    s = await surfacePhase('app-selection-first', steadyCount - 1, 1);
    const selectionHides = s.hiddenTransitions;
    await act('capture', ['-OutputPath', path.resolve('test-results/windows-claude-app-selection.png')]);
    s = await surfacePhase('redraw-app-selection', steadyCount - 1, 1, false);
    assert.equal(s.hiddenTransitions, selectionHides, 'custom selection remains withdrawn throughout status redraw');
    pass('Claude painted selection exposes source without native selection and stays stable during 32 redraws');
    await surfacePhase('app-selection-partial', steadyCount - 1, 1);
    pass('partly selected formula background reveals the entire affected formula');
    await surfacePhase('app-selection-two', steadyCount - 2, 2);
    pass('custom selection can reveal two formulas while all other images remain visible');
    s = await surfacePhase('app-selection-prose', steadyCount, 0);
    assert.deepEqual(s.overlays.map(x => x.imageId).sort(), surfaceImages);
    pass('custom prose selection leaves formula images intact and restores exact cached images');
    await surfacePhase('bottom-steady', steadyCount, 0);
    await phase('scrollback');
    await until(x => x.overlays.length === 0, 'offscreen formulas disappear');
    await act('scroll-top');
    await until(x => x.overlays.length > 0, 'scrolling back restores historical formulas');
    pass('historical formulas restore after actual terminal scrolling');
    for (const delta of [120, 120, 120, 120, 120]) {
        await act('wheel-down', ['-WheelDelta', String(delta)]);
        await pause(150);
    }
    pass('terminal accepts native incremental wheel scrolling');
    // The preceding test deliberately leaves the terminal in scrollback.
    // Return to the live viewport before replacing its contents; otherwise
    // the new page can be written below the independently scrolled view.
    await act('scroll-bottom');
    for (const [index, { name }] of commonCases.entries()) {
        s = await renderedPhase('common-' + index, 1);
        assert.equal(s.foreground, '#cccccc', name);
        assert.ok(s.overlays.every(o => o.hitTestOwner === s.targetHwnd), name);
    }
    pass(commonCases.length + ' common mathematical families produce actual overlays with unchanged source and mouse passthrough');
    await renderedPhase('common-1', 1);
    const commonHides = (await status()).hiddenTransitions;
    await renderedPhase('redraw-common', 1);
    assert.equal((await status()).hiddenTransitions, commonHides, 'new autoregressive formula remains stable during 32 status frames');
    pass('new notation families retain existing images during streaming status redraw');
    await act('capture', ['-OutputPath', path.resolve('test-results/windows-claude-common.png')]);
    result.dpoPositions = [];
    for (const entry of dpoPositions) {
        const before = await status(), changedAt = Date.now();
        await phase(entry.name);
        s = await until(x => Date.parse(x.updatedAt) >= changedAt && x.overlays.length === entry.expected &&
            (entry.expected === 0 ? x.state === 'no-formula' || x.captureKey !== before.captureKey :
                x.state === 'rendered' && x.captureKey !== before.captureKey && Date.parse(x.renderedAt) >= changedAt), entry.name);
        result.dpoPositions.push({ ...entry, actual: s.overlays.length });
    }
    pass('complete ten-expression DPO derivation renders independently at every replay position');
    s = await renderedPhase('mixed-math', 3);
    const mixedHides = s.hiddenTransitions, mixedImages = s.overlays.map(x => x.imageId).sort();
    await renderedPhase('redraw-mixed', 3);
    s = await status();
    assert.equal(s.hiddenTransitions, mixedHides);
    assert.deepEqual(s.overlays.map(x => x.imageId).sort(), mixedImages);
    pass('annotated Chinese formulas and untouched explanatory lines remain stable during 32 redraws');
    await act('capture', ['-OutputPath', path.resolve('test-results/windows-claude-mixed.png')]);
    await cli('--inline-off');
    await until(x => x.overlays.length === 0, 'preview off withdraws annotated formulas');
    await cli('--inline-on');
    await until(x => x.overlays.length === 3, 'preview on restores annotated formulas');
    pass('annotated formula regions obey the existing preview toggle');
    result.gspoPositions = [];
    for (const entry of gspoPositions) {
        const before = await status(), changedAt = Date.now();
        await phase(entry.name);
        s = await until(x => Date.parse(x.updatedAt) >= changedAt && x.overlays.length === entry.expected &&
            (entry.expected === 0 ? x.state === 'no-formula' || x.captureKey !== before.captureKey :
                x.state === 'rendered' && x.captureKey !== before.captureKey && Date.parse(x.renderedAt) >= changedAt), entry.name);
        result.gspoPositions.push({ ...entry, actual: s.overlays.length });
    }
    pass('GSPO custom notation and continued equalities render independently across historical viewport positions');
    for (const [i, block] of gspoFixture.blocks.entries()) await renderedPhase('gspo-block-' + i, block.expressions);
    const gspoStable = await status();
    await renderedPhase('redraw-gspo', 2);
    s = await status();
    assert.equal(s.hiddenTransitions, gspoStable.hiddenTransitions);
    assert.deepEqual(s.overlays.map(o => o.imageId).sort(), gspoStable.overlays.map(o => o.imageId).sort());
    await act('capture', ['-OutputPath', path.resolve('test-results/windows-claude-gspo.png')]);
    pass('all eight GSPO expressions produce actual images and retain them during 32 streaming status frames');
    await renderedPhase('explicit-body', 1);
    await cli('--inline-off');
    await until(x => x.overlays.length === 1 && !x.inlineMath, 'explicit nested delimiters survive preview off');
    await cli('--inline-on');
    await until(x => x.overlays.length === 1 && x.inlineMath, 'explicit nested delimiters survive preview on');
    pass('explicit delimiters inside a plain code block retain base rendering without heuristic math evidence');
    result.passed = checks.length;
}
catch (error) {
    result.error = String(error);
    await act('capture', ['-OutputPath', path.resolve('test-results/windows-claude-failure.png')]).catch(() => {});
    throw error;
}
finally {
    await cli('--quit').catch(() => { });
    await writeFile(control, 'exit').catch(() => { });
    await writeFile('test-results/windows-claude.json', JSON.stringify(result, null, 2) + '\n');
    console.log('Replay results: test-results/windows-claude.json');
}
