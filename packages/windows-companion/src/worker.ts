import { createInterface } from 'node:readline';
import { NativeAnalyzer, type AnalyzeRequest } from './analyzer.js';
import path from 'node:path';
import os from 'node:os';
import { HistoryClient } from './history-client.js';

const store = new HistoryClient(path.join(path.dirname(process.argv[1]!), 'history-worker.cjs'),
  process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
  process.env.AGENT_MATH_CACHE_DIR ?? path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'AgentMath', 'cache'),
  process.env.AGENT_MATH_INLINE_MATH === '1',
  process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'));
const analyzer = new NativeAnalyzer();
const send = (value: object) => process.stdout.write(JSON.stringify(value) + '\n');
let busy = false;
let queued: AnalyzeRequest | undefined;
async function analyze(request: AnalyzeRequest) {
  if (busy) { queued = request; return; }
  busy = true;
  try {
    if (request.text.length > 65536 || (request.leadingContext?.length ?? 0) > 65536) throw new Error('Invalid snapshot');
    const history = await store.resolve(request.text, request.leadingContext);
    const result = analyzer.analyze({ ...request, inlineMath: process.env.AGENT_MATH_INLINE_MATH === '1' }, [], history.pending ? undefined : history.match);
    send({ ...result, pendingSource: history.pending, retryAfterMs: history.pending ? 150 : result.pendingRender ? 50 : result.state === 'waiting' ? 500 : 0,
      metrics: { ...history.metrics, ...result.metrics, rssBytes: process.memoryUsage().rss } });
  } catch {
    send({ type: 'result', id: request.id, state: 'error', formulas: [], skipped: 0 });
  } finally {
    busy = false;
    const next = queued; queued = undefined;
    if (next) void analyze(next);
  }
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (line.length > 1024 * 1024) return;
  try {
    const message = JSON.parse(line);
    if (message.type === 'analyze' && typeof message.text === 'string') void analyze(message);
    else if (message.type === 'quit') process.exit(0);
  } catch { /* A malformed private IPC message cannot change terminal state. */ }
});
input.on('close', () => process.exit(0));
send({ type: 'ready', protocol: 1 });
