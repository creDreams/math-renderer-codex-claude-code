import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { Terminal as XtermTerminal } from '@xterm/xterm';
import { readScreen } from '../packages/xterm-addon/src/snapshot.js';
import { matchCodex, type CodexSession } from '../packages/adapter-codex/src/matcher.js';
import { parseSession, sameDirectory, SessionStore } from '../packages/adapter-codex/src/sessions.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const { Terminal } = createRequire(import.meta.url)('@xterm/headless');
const message = '目标函数包含中文和 e\u0301：\n\\[\n\\mathbb E[x^2]-\\eta\\,\\mathrm{KL}(q\\|p)\n\\]\nThe coefficient controls regularization.';
const session: CodexSession = { id: 'one', cwd: 'D:/test', file: '/one.jsonl', assistant: [message] };
const tui = (text: string) => '• ' + text.replaceAll('\n', '\r\n  ') + '\r\n\r\n  Worked for 2s\r\n\r\n› Ask Codex\r\n';
async function snapshot(text: string, cols = 90) {
  const terminal = new Terminal({ cols, rows: 30, allowProposedApi: true });
  await new Promise<void>(resolve => terminal.write(text, resolve));
  return { terminal, screen: readScreen(terminal as XtermTerminal) };
}

test('assistant source maps to cells through Unicode and soft wrapping', async () => {
  const { terminal, screen } = await snapshot(tui(message), 38);
  try {
    const result = matchCodex(screen, [session]);
    assert.equal(result.state, 'matched');
    assert.equal(result.regions.length, 1);
    const region = result.regions[0]!;
    assert.equal(region.startColumn, 0); // A soft-wrapped formula continues at column zero.
    assert.ok(terminal.buffer.active.getLine(region.startRow).translateToString(true).includes('\\['));
    assert.ok(terminal.buffer.active.getLine(region.endRow).translateToString(true).includes('\\]'));
    const first = screen.lines[0]!;
    const e = first.text.indexOf('e\u0301');
    assert.deepEqual(first.locations[e], first.locations[e + 1]);
  } finally { terminal.dispose(); }
});

test('same formula in separate assistant locations renders independently', async () => {
  const { terminal, screen } = await snapshot(tui(message) + tui(message));
  try {
    const result = matchCodex(screen, [session]);
    assert.equal(result.regions.length, 2);
    assert.notEqual(result.regions[0]!.startRow, result.regions[1]!.startRow);
  } finally { terminal.dispose(); }
});

test('user input, unverified tools, fences, clipping and session ambiguity stay source', async () => {
  for (const text of ['› ' + message.replaceAll('\n', '\r\n  '),
    tui('Ran a command\n\\[\nx^2\n\\]\ncommand complete'),
    tui('```tex\n\\[\nx^2\n\\]\n```'),
    tui(message).slice(2)]) {
    const { terminal, screen } = await snapshot(text);
    try { assert.equal(matchCodex(screen, [session]).regions.length, 0); }
    finally { terminal.dispose(); }
  }
  const { terminal, screen } = await snapshot(tui(message));
  try {
    assert.equal(matchCodex(screen, []).state, 'waiting');
    const result = matchCodex(screen, [session, { ...session, id: 'two' }]);
    assert.equal(result.state, 'ambiguous');
    assert.equal(result.regions.length, 0);
  } finally { terminal.dispose(); }
});

test('session parser excludes tools, user, reasoning and incomplete records', () => {
  const record = (role: string, text: string) => JSON.stringify({ type: 'response_item', payload:
    { type: 'message', role, content: [{ type: 'output_text', text }] } });
  const contents = [JSON.stringify({ type: 'session_meta', payload: { id: 'id', cwd: 'D:\\test' } }),
    record('user', 'user'), record('tool', 'tool'), record('assistant', message), '{unfinished'].join('\n');
  assert.deepEqual(parseSession(contents, '/test.jsonl')?.assistant, [message]);
  assert.ok(sameDirectory('D:\\Test\\', 'd:/test'));
  assert.ok(!sameDirectory('/Test', '/test'));
});

test('read-only discovery keeps distinct sessions instead of choosing latest', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'amt-sessions-'));
  try {
    const dir = path.join(home, 'sessions/2026/11/02');
    await mkdir(dir, { recursive: true });
    for (const id of ['a', 'b']) await writeFile(path.join(dir, `rollout-${id}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { id, cwd: 'D:/test' } }) + '\n');
    const store = new SessionStore(home);
    assert.deepEqual((await store.refresh()).map(x => x.id).sort(), ['a', 'b']);
  } finally { await rm(home, { recursive: true, force: true }); }
});
