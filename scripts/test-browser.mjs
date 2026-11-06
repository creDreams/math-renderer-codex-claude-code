import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
await mkdir('test-results', { recursive: true });
await build({ entryPoints: ['tests/integration/browser-entry.ts'], bundle: true, platform: 'browser',
  outfile: 'test-results/browser.js', globalName: 'Harness', format: 'iife', target: 'es2022' });
const executablePath = process.env.CHROME_PATH ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
const browser = await chromium.launch({ executablePath, headless: true });
const checks = [];
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await page.setContent('<style>body{background:#161616;display:flex;gap:20px}.terminal{width:700px;height:900px}</style><div class="terminal" id="base"></div><div class="terminal" id="enhanced"></div>');
  await page.addStyleTag({ path: 'node_modules/@xterm/xterm/css/xterm.css' });
  await page.addScriptTag({ path: 'test-results/browser.js' });
  await page.evaluate(() => {
    const { Terminal, FormulaOverlay, readScreen, matchCodex } = Harness;
    const options = { cols: 76, rows: 30, fontSize: 16, allowProposedApi: true,
      theme: { background: '#161616', foreground: '#dedede' } };
    const base = new Terminal(options), enhanced = new Terminal(options);
    base.open(document.getElementById('base')); enhanced.open(document.getElementById('enhanced'));
    const message = '中文目标函数 e\u0301 and regularization:\n\\[\n\\max_q\\{\\mathbb E[Q(s,a)]-\\eta\\,\\mathrm{KL}(q\\|p)\\}\n\\]\nEta controls the penalty.';
    const tui = text => '• ' + text.replaceAll('\n', '\r\n  ') + '\r\n\r\n  Worked for 1s\r\n\r\n› Ask Codex\r\n';
    const sessions = [{ id: 'fixture', file: 'fixture', cwd: 'D:/fixture', assistant: [message] }];
    const overlay = new FormulaOverlay(enhanced, () => matchCodex(readScreen(enhanced), sessions).regions);
    const keys = { base: [], enhanced: [] };
    base.onData(data => keys.base.push(data)); enhanced.onData(data => keys.enhanced.push(data));
    const write = async data => {
      await Promise.all([base, enhanced].map(t => new Promise(resolve => t.write(data, resolve))));
    };
    const state = t => JSON.stringify({ cols:t.cols, rows:t.rows, type:t.buffer.active.type,
      cursor:[t.buffer.active.cursorX,t.buffer.active.cursorY],base:t.buffer.active.baseY,view:t.buffer.active.viewportY,
      lines:Array.from({length:t.buffer.active.length},(_,y)=> {
        const line=t.buffer.active.getLine(y);
        return [line.isWrapped, Array.from({length:t.cols},(_,x)=> {const c=line.getCell(x);return [c.getChars(),c.getWidth(),c.getFgColorMode(),c.getFgColor(),c.getBgColorMode(),c.getBgColor(),c.isBold(),c.isItalic(),c.isUnderline(),c.isInverse()];})];
      }) });
    globalThis.test = { base, enhanced, overlay, write, state, keys, tui, message };
  });
  const settle = async expectedCount => {
    await page.waitForTimeout(130);
    // Rendering waits for terminal/browser frames. A fixed 130 ms delay can
    // expire before those frames on a busy CI runner; retain the same exact
    // count assertion, but wait for the observable result with a deadline.
    if (expectedCount !== undefined) await page.waitForFunction(expected =>
      document.querySelectorAll('.agent-math-formula').length === expected, expectedCount, { timeout: 10000 });
  };
  const equal = async name => {
    assert.ok(await page.evaluate(() => test.state(test.base) === test.state(test.enhanced)), name);
    checks.push(name);
  };
  const count = () => page.locator('.agent-math-formula').count();
  await page.evaluate(() => {
    const output=test.tui(test.message), split=output.indexOf('  Eta controls');
    test.remaining=output.slice(split);
    return test.write(output.slice(0,split));
  });
  await settle(0); assert.equal(await count(),0);
  checks.push('partial assistant message retains source during streaming');
  await page.evaluate(() => test.write(test.remaining));
  await settle(1);
  assert.equal(await count(), 1);
  await equal('normal buffer, cells, styles, cursor and scroll state');
  await page.screenshot({ path: 'test-results/normal.png', clip: {x:0,y:0,width:1450,height:230} });
  await page.evaluate(() => {
    for (const t of [test.base,test.enhanced]) t.options.theme={background:'#fafafa',foreground:'#111111'};
  });
  await settle(1);
  await page.waitForFunction(() => {
    const element = document.querySelector('.agent-math-formula');
    return element && getComputedStyle(element).backgroundColor === 'rgb(250, 250, 250)';
  }, undefined, { timeout: 10000 });
  assert.equal(await page.locator('.agent-math-formula').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(250, 250, 250)');
  await equal('theme changes repaint formula and preserve terminal state');
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1500,height:1000,deviceScaleFactor:1.5,mobile:false});
  await settle(1); assert.equal(await count(),1);
  await equal('DPI 1.5 keeps overlay visible and buffer identical');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.evaluate(() => { test.base.select(2, 1, 100); test.enhanced.select(2, 1, 100); });
  await settle(0);
  assert.equal(await count(), 0);
  const selections = await page.evaluate(() => [test.base.getSelection(), test.enhanced.getSelection()]);
  assert.equal(selections[0], selections[1]);
  assert.match(selections[0], /\\\[/);
  checks.push('selection exposes identical LaTeX source and hides overlay');
  await page.evaluate(() => { test.base.clearSelection(); test.enhanced.clearSelection(); });
  for (const name of ['base', 'enhanced']) {
    await page.evaluate(name => test[name].focus(), name);
    for (const key of ['a', 'ArrowLeft', 'Control+c']) await page.keyboard.press(key);
  }
  assert.deepEqual(await page.evaluate(() => test.keys.base), await page.evaluate(() => test.keys.enhanced));
  checks.push('ordinary input, arrow and Ctrl+C are identical');
  await page.evaluate(() => {test.base.resize(45, 24);test.enhanced.resize(45, 24);});
  await settle(); await equal('resize and Unicode reflow match baseline');
  await page.evaluate(() => test.write('\x1b[?1049h' + test.tui(test.message)));
  await settle(1); assert.equal(await count(), 1);
  await equal('alternate buffer overlay is visible without state changes');
  await page.screenshot({ path: 'test-results/alternate.png' });
  await page.evaluate(() => test.write('\x1b[2J\x1b[HAllow this command?\r\n  echo \\[ x^2 \\]\r\n› 1. Allow once\r\n  2. Deny\r\n'));
  await settle(0); assert.equal(await count(), 0);
  await equal('redraw and approval prompt replay remove stale formula');
  await page.evaluate(() => test.write('\x1b[?1049l'));
  await settle(); await equal('normal buffer restored after alternate screen');
  await page.evaluate(() => test.write('\r\n' + 'filler\r\n'.repeat(45)));
  await settle(0); assert.equal(await count(), 0);
  await page.evaluate(() => {test.base.scrollToTop();test.enhanced.scrollToTop();});
  await settle(1); assert.equal(await count(), 1);
  await equal('scrollback positions match and visible formula follows viewport');
  await page.evaluate(() => {test.overlay.enabled=false;test.overlay.invalidate();});
  await settle(0); assert.equal(await count(), 0);
  await equal('disable reveals original source');
  await page.evaluate(() => test.overlay.dispose());
  assert.equal(await page.locator('.agent-math-plane').count(), 0);
  await equal('dispose removes plane and subscriptions without terminal mutation');
  const performanceReport=await page.evaluate(async()=> {
    const t=new Harness.Terminal({cols:140,rows:40,allowProposedApi:true,scrollback:1000});
    await new Promise(resolve=>t.write(('ordinary shell log '.repeat(7)+'\r\n').repeat(650)+test.tui(test.message),resolve));
    const sessions=[{id:'benchmark',file:'benchmark',cwd:'benchmark',assistant:[test.message]}];
    const timings=[];
    for(let i=0;i<65;i++) {
      const start=performance.now();Harness.matchCodex(Harness.readScreen(t),sessions);
      if(i>=5)timings.push(performance.now()-start);
    }
    timings.sort((a,b)=>a-b);
    const start=performance.now(), renderer=new Harness.MathRenderer();
    const initializationMs=performance.now()-start;
    const coldStart=performance.now();renderer.render('\\frac{a+b}{c}');const coldRenderMs=performance.now()-coldStart;
    const cachedStart=performance.now();for(let i=0;i<1000;i++)renderer.render('\\frac{a+b}{c}');
    const cachedRenderMs=(performance.now()-cachedStart)/1000;
    t.dispose();
    return {rows:600,cols:140,samples:timings.length,scanMatchP50Ms:timings[30],scanMatchP95Ms:timings[57],
      initializationMs,coldRenderMs,cachedRenderMs};
  });
  assert.ok(performanceReport.scanMatchP95Ms<Number(process.env.AMT_PERF_BUDGET_MS??25),'scan/match P95 exceeds local 25 ms budget');
  assert.ok(performanceReport.coldRenderMs<100,'cold SVG typesetting exceeds 100 ms budget');
  checks.push('bounded scan/match and cold SVG meet local performance budgets');
  await page.evaluate(() => {test.base.dispose();test.enhanced.dispose();});
  await writeFile('test-results/browser.json', JSON.stringify({ checks, performance:performanceReport }, null, 2) + '\n');
  console.log('Performance:',performanceReport);
  console.log(`Browser checks passed (${checks.length}):\n${checks.map(x => '- ' + x).join('\n')}`);
} finally { await browser.close(); }
