import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, writeFile, mkdir, access, rm, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile), version = '0.2.0-preview.31';
const buildDirectory = path.resolve(process.env.AGENT_MATH_BUILD_DIR ?? 'dist/windows');
const setup = path.resolve(`dist/releases/AgentMath-${version}-Setup.exe`);
const temp = await mkdtemp(path.join(tmpdir(), 'AgentMath-package-'));
const target = path.join(temp, '独立试用'), profile = path.join(temp, 'profile');
const binary = path.join(target, 'AgentMath.exe');
const checks = [], skipped = [], pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = label => { checks.push(label); console.log('PASS ' + label); };
const install = (destination = target) => exec(setup, ['--silent', '--no-launch', '--no-shortcuts', '--target', destination], { windowsHide: true, timeout: 60000 });
async function until(fn, timeout = 10000) {
  const start = Date.now();
  do { try { if (await fn()) return; } catch {} await pause(100); } while (Date.now() - start < timeout);
  throw new Error('Timed out waiting for package lifecycle');
}
let host;
try {
  await install();
  for (const file of ['AgentMath.exe', 'worker.cjs', 'history-worker.cjs', 'runtime/node.exe', 'Uninstall.exe',
    'licenses/Apache-2.0.txt', 'licenses/MPL-2.0.txt', 'licenses/Markdown-MIT.txt', 'licenses/Codex-NOTICE.txt',
    'licenses/Unicode-Width-MIT.txt', 'NODE_LICENSE.txt']) {
    assert.deepEqual(await readFile(path.join(target, file)), await readFile(path.join(buildDirectory, file)));
  }
  check('standalone installer extracts exact binaries and licenses to Unicode path outside repository');
  await mkdir(profile); await writeFile(path.join(profile, 'settings.json'), '{"enabled":true}');
  let originalSettings = await readFile(path.join(profile, 'settings.json'), 'utf8');
  // An empty PATH and deliberately invalid NODE_OPTIONS prove the host supplies its runtime
  // and clears external Node configuration before starting it.
  host = spawn(binary, ['--quiet', '--profile', profile, '--codex-home', path.join(temp, 'empty-codex')],
    { env: { ...process.env, PATH: '', NODE_OPTIONS: '--this-option-does-not-exist' }, windowsHide: true, stdio: 'ignore' });
  let status;
  await until(async () => { status = JSON.parse(await readFile(path.join(profile, 'status.json'), 'utf8')); return status.workerReady; });
  check('installed app and offline renderer start without PATH, global Node, Chrome or source tree');
  await exec(binary, ['--profile', profile, '--inline-on']);
  await until(async () => { status = JSON.parse(await readFile(path.join(profile, 'status.json'), 'utf8')); return status.inlineMath && status.workerReady; });
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8')), { enabled: true, inlineMath: true });
  await exec(binary, ['--profile', profile, '--pause']);
  await until(async () => { status = JSON.parse(await readFile(path.join(profile, 'status.json'), 'utf8')); return !status.enabled; });
  assert.equal(JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8')).inlineMath, true);
  await exec(binary, ['--profile', profile, '--inline-off']);
  await exec(binary, ['--profile', profile, '--resume']);
  await until(async () => { status = JSON.parse(await readFile(path.join(profile, 'status.json'), 'utf8')); return !status.inlineMath && status.enabled && status.workerReady; });
  originalSettings = await readFile(path.join(profile, 'settings.json'), 'utf8');
  check('installed preview switch and pause persist independently and restart a working renderer');
  const workerPid = status.workerPid;
  await exec(binary, ['--profile', profile, '--quit']);
  await until(() => { try { process.kill(workerPid, 0); return false; } catch { return host.exitCode !== null; } });
  check('installed app exits and cleans its worker');
  // Exercise the bundled renderer itself using synthetic session data.
  const home = path.join(temp, 'codex'); await mkdir(path.join(home, 'sessions'), { recursive: true });
  const nativeSource = '\\[\n\\boxed{\\hat A_{i,t}=A_i^{E}+\\omega A_{i,t}^{S}}\n\\]';
  const nativeDisplay = '┌──────────────────────────────┐\n│ Â_{i,t}=Aᵢ^{E}+ω A_{i,t}^{S} │\n└──────────────────────────────┘';
  const message = 'Standalone equation.\n\\begin{align*}\nx&=y\\\\\nz&=w\n\\end{align*}\n圆的公式 x^2 + y^2 = r^2，保留说明。\n' +
    nativeSource + '\nEnd of standalone message.';
  const displayed = message.replace('y\\\\', 'y\\').replace(nativeSource, nativeDisplay); // observed Codex presentation
  await writeFile(path.join(home, 'sessions/rollout-package.jsonl'), [
    { type: 'session_meta', payload: { id: 'package-test', cwd: 'D:/fixture' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message }] } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  for (const preview of [true, false, true]) {
    const worker = spawn(path.join(target, 'runtime/node.exe'), [path.join(target, 'worker.cjs')],
      { cwd: temp, env: { ...process.env, CODEX_HOME: home, AGENT_MATH_CACHE_DIR: path.join(temp, 'index'),
        AGENT_MATH_INLINE_MATH: preview ? '1' : '0', PATH: '', NODE_OPTIONS: '' }, windowsHide: true });
    const exited = new Promise(resolve => worker.once('exit', resolve));
    let timeout, retry;
    try {
      const result = await new Promise((resolve, reject) => {
        let buffer = '';
        const send = () => worker.stdin.write(JSON.stringify({ type: 'analyze', id: 1,
          text: '• ' + displayed.replaceAll('\n', '\r\n  ') + '\r\n\r\n› Ask Codex',
          width: 1200, rowHeight: 28, foreground: '#cccccc', background: '#0c0c0c' }) + '\n');
        timeout = setTimeout(() => reject(new Error('Offline package render timed out')), 15000);
        worker.on('error', reject);
        worker.stdin.on('error', reject);
        worker.stdout.on('data', chunk => {
          buffer += chunk.toString('utf8');
          while (buffer.includes('\n')) {
            const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
            const response = JSON.parse(line);
            if (response.type === 'ready') send();
            if (response.type === 'result' && response.retryAfterMs) retry = setTimeout(send, response.retryAfterMs);
            else if (response.type === 'result') resolve(response);
          }
        });
      });
      assert.equal(result.formulas.length, preview ? 3 : 1);
      const inline = result.formulas.filter(f => f.kind === 'inline');
      assert.equal(inline.length, preview ? 1 : 0);
      if (preview) assert.ok(inline[0].height >= 25 && inline[0].height <= 26, 'readable image fits the 28px row');
      for (const formula of result.formulas)
        assert.equal(Buffer.from(formula.png, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    } finally {
      clearTimeout(timeout); clearTimeout(retry);
      if (worker.exitCode === null) worker.stdin.end('{"type":"quit"}\n');
      const cleanup = setTimeout(() => worker.kill(), 3000);
      await exited;
      clearTimeout(cleanup);
    }
  }
  check('installed offline worker preserves marked blocks while on/off/on toggles larger inline and unmarked character images');
  const lockHelper = path.join(temp, 'hold-directory.exe');
  const compiler = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  await exec(compiler, ['/nologo', '/target:exe', '/out:' + lockHelper, path.resolve('tests/native/InstallerLockFixture.cs')], { windowsHide: true });
  const payload = await Promise.all((await readdir(buildDirectory, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile()).map(async entry => {
      const file = path.join(entry.parentPath, entry.name);
      return { name: path.relative(buildDirectory, file), size: (await stat(file)).size };
    }));
  let lockIndex = 0;
  async function lockedUpdate(releaseEarly) {
    const ready = path.join(temp, 'lock-' + (++lockIndex) + '.ready'), release = ready + '.release';
    const holder = spawn(lockHelper, [target, ready, release], { windowsHide: true, stdio: 'ignore' });
    const closed = new Promise(resolve => holder.once('exit', resolve));
    try {
      await until(async () => { await access(ready); return true; });
      // Start the real installer while a real Windows directory lock is held.
      const pending = install().then(() => ({ ok: true }), error => ({ ok: false, error }));
      // Wait until extraction is complete before releasing the lock: releasing
      // during extraction would pass without exercising the move retry at all.
      if (releaseEarly) {
        await until(async () => {
          const stages = (await readdir(temp)).filter(name => name.startsWith('.AgentMath-stage-'));
          for (const stage of stages) {
            const sizes = await Promise.all(payload.map(async file =>
              (await stat(path.join(temp, stage, file.name))).size === file.size));
            if (sizes.every(Boolean)) return true;
          }
          return false;
        }, 45000);
        assert.equal(holder.exitCode, null, 'directory lock remains held after extraction');
        await pause(1500); await writeFile(release, 'release');
      }
      const result = await pending;
      if (releaseEarly && !result.ok) throw result.error;
      if (!releaseEarly) {
        assert.equal(result.ok, false, 'persistent lock fails within the installer deadline');
        assert.match(result.error.stderr, /Unable to move installation directory/, 'failure identifies the contended operation');
        assert.equal(holder.exitCode, null, 'failure occurs while the directory remains locked');
      }
    } finally {
      await writeFile(release, 'release');
      const cleanup = setTimeout(() => holder.kill(), 3000);
      await closed; clearTimeout(cleanup);
    }
  }
  await writeFile(path.join(target, 'update-sentinel.txt'), 'previous version');
  await lockedUpdate(false);
  assert.equal(await readFile(path.join(target, 'update-sentinel.txt'), 'utf8'), 'previous version');
  assert.equal(await readFile(path.join(profile, 'settings.json'), 'utf8'), originalSettings);
  assert.deepEqual(await readFile(path.join(target, 'AgentMath.exe')), await readFile(path.join(buildDirectory, 'AgentMath.exe')));
  check('persistent installation lock fails within a deadline and preserves the previous app and settings');
  await lockedUpdate(true);
  await assert.rejects(access(path.join(target, 'update-sentinel.txt')));
  assert.equal(await readFile(path.join(profile, 'settings.json'), 'utf8'), originalSettings);
  check('update tolerates a transient Windows directory lock and retains external settings');
  const unrelated = path.join(temp, 'unrelated'); await mkdir(unrelated);
  await writeFile(path.join(unrelated, 'keep.txt'), 'keep');
  await assert.rejects(exec(setup, ['--silent', '--no-launch', '--no-shortcuts', '--target', unrelated]));
  assert.equal(await readFile(path.join(unrelated, 'keep.txt'), 'utf8'), 'keep');
  check('installer refuses to overwrite unrelated files');
  const alias = (await exec(lockHelper, ['--short-path', target], { windowsHide: true })).stdout.trim();
  assert.ok(alias, 'Windows returns an existing installation path');
  if (alias.toLowerCase() !== target.toLowerCase()) {
    await install(alias);
    assert.equal(await readFile(path.join(profile, 'settings.json'), 'utf8'), originalSettings);
    check('update accepts a Windows 8.3 directory alias and retains settings');
  } else {
    skipped.push('8.3 alias update: volume does not expose a different short path');
    console.log('SKIP ' + skipped.at(-1));
  }
  // Assembly.Location may be a long path even when invoked through an 8.3
  // alias. The uninstaller must still relocate before deleting its own file.
  await exec(path.join(alias, 'Uninstall.exe'), ['--silent', '--target', alias], { windowsHide: true });
  await until(async () => { try { await access(target); return false; } catch { return true; } });
  assert.equal(await readFile(path.join(profile, 'settings.json'), 'utf8'), originalSettings);
  check('installed uninstaller removes its own directory through the returned alias and retains settings');
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/windows-package.json', JSON.stringify({ checks, skipped, passed: checks.length, runAt: new Date().toISOString() }, null, 2) + '\n');
} finally {
  if (host && host.exitCode === null) await exec(binary, ['--profile', profile, '--quit']).catch(() => {});
  // This exact, newly allocated temporary directory is the only recursive cleanup target.
  assert.ok(path.resolve(temp).startsWith(path.resolve(tmpdir()) + path.sep + 'AgentMath-package-'));
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
