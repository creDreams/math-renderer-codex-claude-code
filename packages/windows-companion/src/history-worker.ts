import { watch, type FSWatcher } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { HistoryIndex, type HistoryResolution } from '../../adapter-codex/src/history-index.js';
import { claudeHistoryAdapter } from '../../adapter-claude/src/history.js';
import { isClaudeScreen } from '../../adapter-claude/src/matcher.js';

if (!parentPort) throw new Error('History index requires a worker thread');
const port = parentPort;
const codex = new HistoryIndex(workerData.codexHome, workerData.cacheDirectory, workerData.inlineMath === true);
let claude: HistoryIndex | undefined;
let watcher: FSWatcher | undefined, claudeWatcher: FSWatcher | undefined, scheduled: ReturnType<typeof setTimeout> | undefined;
let active: { key: string; revision: number; controller: AbortController; result: Promise<HistoryResolution | undefined> } | undefined;

async function scan() {
  try { await codex.scan(); if (claude) await claude.scan(); }
  catch { /* A temporarily inaccessible source remains unproved; retry later. */ }
  if (!watcher) {
    try {
      watcher = watch(codex.directory, { recursive: true }, () => {
        if (!scheduled) scheduled = setTimeout(() => { scheduled = undefined; void scan(); }, 100);
      });
      watcher.on('error', () => { watcher?.close(); watcher = undefined; });
    } catch { /* Periodic discovery also handles a sessions directory created later. */ }
  }
  if (claude && !claudeWatcher) {
    try {
      claudeWatcher=watch(claude.directory,{recursive:true},()=>{
        if(!scheduled) scheduled=setTimeout(()=>{scheduled=undefined;void scan();},100);
      });
      claudeWatcher.on('error',()=>{claudeWatcher?.close();claudeWatcher=undefined;});
    } catch { /* Discovery retries if Claude creates projects later. */ }
  }
}
void scan();
const poll = setInterval(() => void scan(), 1500);

port.on('message', async message => {
  if (message.type === 'close') {
    clearInterval(poll); if (scheduled) clearTimeout(scheduled);
    watcher?.close(); claudeWatcher?.close(); active?.controller.abort();
    await codex.close(); await claude?.close(); port.close(); return;
  }
  if (message.type !== 'resolve') return;
  const useClaude=workerData.claudeHome && isClaudeScreen(message.text, message.leadingContext);
  if (useClaude) {
    if (!claude) { claude = new HistoryIndex(workerData.claudeHome, workerData.cacheDirectory,
      workerData.inlineMath === true, claudeHistoryAdapter); void scan(); }
  }
  const index=useClaude ? claude! : codex;
  const key = createHash('sha256').update(index.directory).update('\0').update(message.text).update('\0').update(message.leadingContext ?? '').digest('hex');
  if (!active || active.key !== key || active.revision !== index.revision) {
    active?.controller.abort();
    const controller = new AbortController();
    active = { key, revision: index.revision, controller,
      result: index.resolve(message.text, message.leadingContext, controller.signal).catch(error => {
        if (controller.signal.aborted) return undefined;
        throw error;
      }) };
  }
  const current = active;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Return control to the native host during a cold scan or unusually broad
    // source search. Work continues off-thread, and the latest viewport wins.
    const result = await Promise.race([current.result, new Promise<undefined>(resolve => {
      timeout = setTimeout(() => resolve(undefined), 120);
    })]);
    if (result && !result.pending && current === active && result.revision === index.revision) {
      port.postMessage({ type: 'resolved', id: message.id, ...result });
      // Never cache a source proof indefinitely: every query rechecks source
      // file revisions. Original text and rendered images have separate LRUs.
      active = undefined;
    } else {
      port.postMessage({ type: 'resolved', id: message.id, pending: true,
        revision: index.revision, metrics: index.metrics });
      if (result?.pending && current === active) { active = undefined; void scan(); }
    }
  } catch {
    port.postMessage({ type: 'resolved', id: message.id, pending: true,
      revision: index.revision, metrics: index.metrics });
    if (current === active) active = undefined;
    void scan();
  } finally { if (timeout) clearTimeout(timeout); }
});
