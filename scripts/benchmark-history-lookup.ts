import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HistoryIndex } from '../packages/adapter-codex/src/history-index.js';

// Formula hashes are unique, but their native scripts deliberately collide.
// Keep this separate from the broad-history benchmark: that dataset did not
// expose script-only candidate fanout or the resulting source-LRU thrashing.
const root = path.resolve('.cache/history-lookup-' + Date.now().toString(36));
const home = path.join(root, 'codex'), directory = path.join(home, 'sessions/2026/11/03');
await mkdir(directory, { recursive: true }); await mkdir('test-results', { recursive: true });
const block = (tex: string) => '\\[\n' + tex + '\n\\]';
const tex = (n: number) => `G_{i,t}=\\sum_{k=t}^{T}\\gamma^{k-t}r_{i,k}+${n}.`;
const native = (n: number) => `          T\nG_{i,t}= ∑ γᵏ⁻ᵗr_{i,k}+${n}.\n         k=t`;
const source = (n: number) => `Independently verified historical derivation number ${n}.\n\n` + block(tex(n)) +
  '\n\nThe objective follows.\n\n' + block(`\\mathbb E_q[Q]-\\eta\\mathrm{KL}(q\\|p)+${n}.`) + '\nFinished.';
const meta = (id: string) => JSON.stringify({ type: 'session_meta', payload: { id, cwd: 'D:/fixture' } }) + '\n';
const record = (text: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text }] } }) + '\n';
for (let file = 0; file < 30; file++) await writeFile(path.join(directory, `rollout-${file}.jsonl`),
  meta('fixture-' + file) + Array.from({ length: 20 }, (_, i) => record(source(file * 20 + i))).join(''));
const target = source(599), shown = target.replace(block(tex(599)), native(599));
const screen = (text: string) => '• ' + text.replaceAll('\n', '\r\n  ') + '\r\n  Worked for 1s\r\n› Input';
const prefix = shown.slice(0, shown.indexOf(native(599)));
const cases = [
  { kind: 'explicit', text: screen(target), count: 2 },
  { kind: 'mixed', text: screen(shown), count: 2 },
  { kind: 'native-only', text: '  ' + native(599).replaceAll('\n', '\r\n  '),
    leading: '• ' + prefix.replaceAll('\n', '\r\n  '), count: 1 },
  { kind: 'separate-answers', text: screen(target) + '\r\n' + screen(source(598).replace(block(tex(598)), native(598))), count: 4 },
];
const results = [];
for (const inline of [false, true]) {
  const index = new HistoryIndex(home, path.join(root, 'cache'), inline);
  try {
    await index.scan();
    for (const item of cases) {
      const times = [];
      let sourceReads = 0;
      for (let run = 0; run < 22; run++) {
        const result = await index.resolve(item.text, item.leading);
        assert.equal(result.match.state, 'matched');
        const expected = inline || item.kind === 'explicit' ? item.count : item.count - 1;
        assert.equal(result.match.regions.length, expected);
        sourceReads = result.metrics.sourceHits + result.metrics.sourceMisses;
        assert.equal(sourceReads, item.kind === 'separate-answers' ? 2 : 1);
        if (run > 1) times.push(result.metrics.lookupMs);
      }
      times.sort((a, b) => a - b);
      const row = { inline, kind: item.kind, warmMedianMs: times[10]!, warmP95Ms: times[18]!, sourceReads };
      results.push(row); console.log(JSON.stringify(row));
    }
  } finally { await index.close(); }
}
await writeFile('test-results/history-lookup.json', JSON.stringify({ root, messages: 600, results,
  scope: 'History lookup and source proof only; excludes UIA, image rendering and desktop drawing.' }, null, 2) + '\n');
