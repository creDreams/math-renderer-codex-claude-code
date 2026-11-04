// Attach only to our diagnostic host. No terminal writes and no model/tool requests.
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/');
process.chdir(root);
const browser = await chromium.connectOverCDP(process.env.TABBY_CDP ?? 'http://127.0.0.1:9223');
try {
  const page = browser.contexts()[0].pages().find(p => p.url().includes('index.html'));
  assert.ok(page, 'Tabby renderer not found');
  await page.waitForFunction(() => [...(globalThis.__agentMath?.attachments.values()??[])].some(e=>e.match.regions.length),
    undefined,{timeout:10000});
  await page.evaluate(()=> {
    const [tab,entry]=[...globalThis.__agentMath.attachments].find(([,entry])=>entry.match.regions.length);
    let root=tab;while(root.parent)root=root.parent;
    tab.zone.run(()=>tab.app.selectTab(root));
  });
  await page.waitForTimeout(350);
  await page.evaluate(()=> {
    const entry=[...globalThis.__agentMath.attachments.values()].find(entry=>entry.match.regions.length);
    entry.terminal.scrollToLine(Math.max(0,entry.match.regions.at(-1).startRow-5));
  });
  await page.waitForTimeout(150);
  const lifecycle = await page.evaluate(() => {
    const previous = globalThis.__agentMath;
    if (!previous?.attachments.size) throw new Error('Run the diagnostic Tabby launcher first');
    const [tab, entry] = [...previous.attachments].find(([,entry])=>entry.match.regions.length);
    const terminal = entry.terminal;
    const snapshot = () => JSON.stringify({ cursor:[terminal.buffer.active.cursorX,terminal.buffer.active.cursorY],
      base:terminal.buffer.active.baseY,view:terminal.buffer.active.viewportY,
      lines:Array.from({length:terminal.buffer.active.length},(_,y)=> {
        const line=terminal.buffer.active.getLine(y);
        return [line.isWrapped, Array.from({length:terminal.cols},(_,x)=> {const c=line.getCell(x);return[c.getChars(),c.getWidth(),c.getFgColor(),c.getBgColor(),c.isBold(),c.isItalic(),c.isUnderline(),c.isInverse()];})];
      }) });
    const before=snapshot();
    previous.decorator.detach(tab);
    const removed=!terminal.element.querySelector('.agent-math-plane');
    previous.decorator.attach(tab);
    const current=globalThis.__agentMath.attachments.get(tab);
    globalThis.__amtTest={tab,entry:current,snapshot};
    return { removed, unchanged:before===snapshot(), frontend:tab.frontend.constructor.name,
      oldDisposed:entry.disposed, attached:globalThis.__agentMath.attachments.size };
  });
  assert.ok(lifecycle.removed && lifecycle.unchanged && lifecycle.oldDisposed);
  await page.waitForFunction(() => globalThis.__amtTest.entry.match.state === 'matched', undefined,{timeout:10000});
  await page.waitForFunction(() => document.querySelector('.agent-math-formula svg'));
  const formula = await page.evaluate(async () => {
    const {tab,entry,snapshot}=globalThis.__amtTest;
    const menu=await tab.buildContextMenu();
    const toggle=menu.find(item=>item.label==='公式：启用渲染');
    if (!toggle) throw new Error('The host context menu does not contain the formula toggle');
    const before=snapshot();toggle.click();
    return { sourceUnchanged:before===snapshot(), sourceMatched:entry.match.regions.length,
      knownCoordinatesUsed:entry.diagnosticRegions.length>0, hostMenuToggle:true };
  });
  assert.ok(formula.sourceUnchanged && !formula.knownCoordinatesUsed && formula.sourceMatched>0);
  await page.waitForTimeout(130);
  assert.equal(await page.locator('.agent-math-formula').count(),0);
  await page.evaluate(()=>{const e=globalThis.__amtTest.entry;e.overlay.enabled=true;e.overlay.invalidate();});
  await page.waitForFunction(()=>document.querySelector('.agent-math-formula svg'));
  await mkdir('test-results',{recursive:true});
  await page.screenshot({path:'test-results/tabby-codex.png'});
  const report={host:'Tabby 1.0.238',...lifecycle,...formula};
  await writeFile('test-results/tabby.json',JSON.stringify(report,null,2)+'\n');
  console.log(report);
} finally { await browser.close(); }
