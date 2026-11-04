import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile), run = Date.now().toString(36), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const argument = process.argv.indexOf('--binary');
const binary = path.resolve(argument < 0 ? 'dist/windows/AgentMath.exe' : process.argv[argument + 1]);
const work = path.resolve('.cache/inline-desktop-' + run), profile = path.join(work, 'profile'), home = path.join(work, 'codex');
const title = 'AgentMathResearch-Inline-' + run, input = path.join(work, 'input.json'), control = path.join(work, 'control.txt');
const statusPath = path.join(profile, 'status.json'), probePath = path.join(work, 'probe.json');
const first = 'x^2 + y^2 = r^2', second = 'θ_{t+1} = θ_t − α∇J(θ_t)';
const ppo = 'L_total(θ) = E_t[L_CLIP(θ) - c₁L_VF(θ) + c₂S[π_θ](s_t)]';
const nativeBlock = '\\[\n\\boxed{\\hat A_{i,t}=A_i^{E}+\\omega A_{i,t}^{S}}\n\\]';
const nativeShown = '┌──────────────────────────────┐\n│ Â_{i,t}=Aᵢ^{E}+ω A_{i,t}^{S} │\n└──────────────────────────────┘';
const source = `本独立样例验证行内公式，同时保持 regular text 和相邻文字。\n圆的公式 ${first}，中文标点。\n更新公式 ${second}，后文。\n重复 ${first} 和 ${first}。\n组合字符 Â_t = Q_t − V_t，后文。\n总损失 ${ppo}，后文。\n代码 \`${first}\` 保留原样。\n配置 timeout=30，日期 2026-11-03，金额 $20,000 and $30,000。\n原本易读 x² + y² = r² 和 Âₜ = Qₜ − Vₜ，保留终端字体。\n\n${nativeBlock}\n\n\\[\nx^2+y^2=r^2\n\\]\n以上结束。`;
const text = '• ' + source.replace('`' + first + '`', first).replace(nativeBlock, nativeShown).replaceAll('\n', '\r\n  ') + '\r\n  Worked for 1s\r\n› Input';
const ps = (script, args) => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(script), ...args], { windowsHide: true, maxBuffer: 1024 * 1024 });
const act = (action, args = []) => ps('scripts/research/control-windows-terminal-probe.ps1', ['-WindowTitle', title, '-Action', action, ...args]);
const cli = (...args) => exec(binary, ['--profile', profile, ...args], { windowsHide: true });
const checks = [], latencies = []; let status, failure;
async function until(predicate, label, after = 0) {
  const start = Date.now();
  do {
    try { status = JSON.parse(await readFile(statusPath, 'utf8')); if (Date.parse(status.updatedAt) >= after && predicate(status)) return status; } catch {}
    await pause(50);
  } while (Date.now() - start < 12000);
  throw Error(label + ': ' + JSON.stringify(status));
}
function pass(message) { checks.push(message); console.log('PASS ' + message); }
async function phaseReady(phase) {
  const start = Date.now();
  while (Date.now() - start < 12000) {
    if (await readFile(control + '.ready', 'utf8').catch(() => '') === phase) return;
    await pause(50);
  }
  throw Error('Fixture did not finish phase ' + phase);
}
await mkdir(path.join(home, 'sessions'), { recursive: true }); await mkdir(profile, { recursive: true });
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ enabled: true, inlineMath: true }));
await writeFile(path.join(home, 'sessions/rollout-inline.jsonl'), [
  { type: 'session_meta', payload: { id: 'inline-' + run, cwd: 'D:/fixture' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: source }] } },
].map(record => JSON.stringify(record)).join('\n') + '\n');
const needles = [first, second, 'Â_t = Q_t − V_t', ppo];
await writeFile(input, JSON.stringify({ normal: text, anchor: second, needles, selectionNeedle: second,
  'wrapped-once-before': '› ' + '前文'.repeat(45) + '\r\n' + text,
  'moving-initial': '\r\n'.repeat(8) + text,
  moving: Array.from({ length: 12 }, (_, i) => '\r\n  Continuing below the input ' + i),
  'wrapped-before': '› ' + '前面的长输入包含中文和 emoji 🙂，自动折行后应保持后方公式的位置准确。'.repeat(5) + '\r\n' + text,
  'redraw-working': Array.from({ length: 45 }, (_, i) => text + '\r\n' + (i % 2 ? '◦' : '•') + ` Working (${i}s • esc to interrupt)`),
  fixed: Array.from('下一条回答逐字追加，同时检查上面的历史行内公式不闪烁。'.repeat(4), char => char),
}));
await writeFile(control, 'normal');
try {
  await exec('wt.exe', ['-w', 'AgentMathInline-' + run, 'new-tab', '--title', title, '--suppressApplicationTitle',
    'powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/research/windows-stream-fixture.ps1'),
    '-InputPath', input, '-ControlPath', control]);
  await pause(700); await act('focus'); await act('resize', ['-Width', '1750', '-Height', '950']);
  spawn(binary, ['--quiet', '--profile', profile, '--codex-home', home, '--window-title', title], { windowsHide: true, stdio: 'ignore' }).unref();
  const initial = Date.now();
  await until(s => s.state === 'rendered' && s.overlays.filter(x => x.kind === 'inline').length === 6 && s.overlays.length === 8, 'six inline spans and a character block and a display block render');
  latencies.push(Date.now() - initial); pass('six inline spans and a character block and a display block render together; hidden code and configuration stay literal');
  await ps('scripts/research/probe-inline-ranges.ps1', ['-WindowTitle', title, '-InputPath', input, '-OutputPath', probePath]);
  const probe = JSON.parse(await readFile(probePath, 'utf8'));
  for (const needle of probe.spans) for (const found of needle.matches) {
    // The first formula also occurs in protected code; that fourth occurrence
    // is independently expected to have no overlay.
    const index = probe.spans[0].matches.indexOf(found);
    if (needle.needle === first && index === 3) continue;
    const r = found.rectangles[0], overlay = status.overlays.find(x => x.kind === 'inline' && x.x === r.x && x.y === r.y);
    assert.ok(overlay, 'inline starts at its own exact substring');
    assert.equal(overlay.width, r.width); assert.equal(overlay.height, r.height);
    assert.ok(overlay.imageWidth <= overlay.width && overlay.imageHeight <= overlay.height);
    if (needle.needle === first) assert.ok(overlay.imageHeight >= overlay.height - 3,
      'ordinary inline superscripts use available row height instead of the old small font cap');
    assert.equal(overlay.hitTestOwner, status.targetHwnd);
  }
  pass('actual substring bounds preserve adjacent Chinese punctuation, duplicate occurrences and mouse passthrough');
  await act('capture', ['-OutputPath', path.resolve('test-results/windows-inline.png')]);
  const originalHides = status.hiddenTransitions;
  if (!process.argv.includes('--quick')) {
    await writeFile(control, 'redraw-working');
    for (let i = 0; i < 75; i++) { await pause(100); await until(s => s.state === 'rendered' && s.overlays.length === 8, 'redraw remains rendered'); }
    assert.equal(status.hiddenTransitions, originalHides); pass('Working redraw leaves all previous inline and block images continuously visible');
    await writeFile(control, 'fixed');
    await phaseReady('fixed');
    await until(s => s.state === 'rendered' && s.overlays.length === 8, 'streamed prose preserves formulas');
    assert.equal(status.hiddenTransitions, originalHides); pass('character streaming below the verified answer does not hide historical formulas');
  }
  await act('select-inline', ['-InputPath', input]);
  await until(s => s.overlays.filter(x => x.kind === 'inline').length === 5 && s.overlays.length === 7, 'only selected inline span reveals source');
  pass('selection reveals only its own inline source and leaves neighboring formulas visible');
  await act('clear-selection'); await until(s => s.overlays.length === 8, 'clear selection restores formula');
  for (const [width, height] of [[1450, 800], [1750, 950]]) {
    const started = Date.now(); await act('resize', ['-Width', String(width), '-Height', String(height)]);
    await until(s => s.overlays.length === 8 && Date.parse(s.renderedAt) >= started, 'resize updates inline geometry', started);
    latencies.push(Date.now() - started);
  }
  pass('window resizing revalidates exact inline positions without losing any complete formula');
  for (const phase of ['wrapped-once-before', 'wrapped-before']) {
    const previousKey = status.captureKey, started = Date.now();
    await writeFile(control, phase);
    await until(s => s.overlays.length === 8 && s.captureKey !== previousKey && Date.parse(s.renderedAt) >= started,
      'wrapped input before formulas preserves physical row mapping');
    const probe = path.join(work, phase + '-uia.json');
    await ps('scripts/research/probe-windows-terminal-uia.ps1', ['-WindowTitle', title, '-OutputPath', probe]);
    const wrapped = JSON.parse(await readFile(probe, 'utf8')).elements[0];
    const block = status.overlays.filter(x => x.kind !== 'inline').at(-1);
    assert.equal(block.y, wrapped.formula.rectangles[0].y);
    assert.equal(block.height, 3 * wrapped.formula.rectangles[0].height);
    if (phase === 'wrapped-once-before') assert.equal(wrapped.visible[0].text.split(/\r?\n/).length,
      wrapped.visible[0].rectangles.length, 'a trailing empty split masks exactly one soft wrap');
  }
  pass('soft-wrapped CJK and emoji input before the answer preserves formulas and independently verified block rows');
  const movingStart = Date.now();
  await writeFile(control, 'moving-initial');
  await until(s => s.overlays.length === 8 && Date.parse(s.renderedAt) >= movingStart, 'prepare scrolling history');
  const movingHides = status.hiddenTransitions;
  const beforeY = status.overlays.filter(x => x.kind === 'inline').map(x => x.y).sort((a, b) => a - b);
  await writeFile(control, 'moving'); await phaseReady('moving');
  await until(s => s.overlays.length === 8 && s.overlays.some(x => x.kind === 'inline' && x.y < beforeY[0]), 'all inline formulas move with automatic scrolling');
  assert.equal(status.hiddenTransitions, movingHides, 'verified substring geometry survives changing physical row indices');
  pass('automatic scrolling repositions all inline images continuously without a geometry lookup gap');
  for (let cycle = 0; cycle < 2; cycle++) {
    await cli('--inline-off'); await until(s => !s.inlineMath && s.overlays.length === 1, 'preview can be disabled independently');
    const count = status.hiddenTransitions;
    await pause(2300); await until(s => !s.inlineMath && s.overlays.length === 1, 'revalidation cannot restore disabled preview images');
    assert.equal(status.hiddenTransitions, count);
    const saved = JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8'));
    assert.equal(saved.enabled, true); assert.equal(saved.inlineMath, false);
    await cli('--inline-on'); await until(s => s.inlineMath && s.overlays.length === 8, 'preview can be enabled again');
  }
  pass('preview switch removes inline and unmarked character images while preserving explicit display formulas');
} catch (error) {
  failure = String(error);
  await ps('scripts/research/probe-windows-terminal-uia.ps1', ['-WindowTitle', title, '-OutputPath', path.join(work, 'failure-uia.json')]).catch(() => {});
  throw error;
}
finally {
  await cli('--quit').catch(() => {}); await writeFile(control, 'exit'); await mkdir('test-results', { recursive: true });
  await writeFile('test-results/windows-inline.json', JSON.stringify({ completed: !failure, failure, checks, latencies, status, runAt: new Date().toISOString() }, null, 2) + '\n');
}
