import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'amt-package-'));
const plugins = path.join(temporary, 'plugins');
await mkdir(plugins);
const run = action => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(root, 'scripts/manage-plugin.mjs'), action,
    '--plugins-dir', plugins], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => {output += data;});child.stderr.on('data', data => {output += data;});
  child.on('error', reject);child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(output)));
});
try {
  await run('install');
  const target = path.join(plugins, 'node_modules/tabby-agent-math');
  assert.deepEqual(await readFile(path.join(target, 'dist/index.cjs')),
    await readFile(path.join(root, 'packages/tabby-plugin/dist/index.cjs')));
  const manifest = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'tabby-agent-math');
  assert.ok(manifest.keywords.includes('tabby-plugin'));
  assert.ok((await stat(path.join(target, 'dist/licenses/Apache-2.0.txt'))).size > 1000);
  assert.ok((await stat(path.join(target, 'dist/licenses/Markdown-MIT.txt'))).size > 1000);
  assert.deepEqual(await readFile(path.join(target, 'dist/licenses/Unicode-Width-MIT.txt')),
    await readFile(path.join(root, 'node_modules/get-east-asian-width/license')));
  assert.deepEqual(await readFile(path.join(target, 'dist/licenses/Codex-NOTICE.txt')),
    await readFile(path.join(root, 'licenses/Codex-NOTICE.txt')));
  await run('install');
  assert.ok((await readdir(plugins)).some(name => name.startsWith('.agent-math-backup-')));
  await run('uninstall');
  assert.equal(await stat(target).catch(() => undefined), undefined);
  assert.ok((await readdir(plugins)).some(name => name.startsWith('.agent-math-uninstalled-')));
  assert.match(await run('uninstall'), /not installed/);
  console.log('Packaging checks passed: install, update backup, uninstall, idempotence, bundled entry and license.');
} finally {
  // The only recursive deletion is the verified OS temporary directory made above.
  const resolved = path.resolve(temporary);
  const relative = path.relative(path.resolve(os.tmpdir()), resolved);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(resolved).startsWith('amt-package-')) {
    await rm(resolved, { recursive: true, force: true });
  }
}
