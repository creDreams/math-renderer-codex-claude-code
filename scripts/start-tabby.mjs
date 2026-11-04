import { spawn } from 'node:child_process';
import { mkdir, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.resolve(process.argv[2] ?? root);
if (!(await stat(directory)).isDirectory()) throw new Error('The terminal working directory must be a directory.');
const executable = path.join(root, '.cache/tabby/Tabby.exe');
if (!(await stat(executable).catch(() => undefined))) throw new Error('Run npm run setup:tabby first.');
if (!(await stat(path.join(root, 'packages/tabby-plugin/dist/index.cjs')).catch(() => undefined))) {
  throw new Error('Run npm run build first.');
}
const data = path.join(root, '.cache/tabby/data');
await mkdir(data, { recursive: true });
const plugin = path.join(root, 'packages/tabby-plugin').replaceAll('\\', '/');
const env = { ...process.env, TABBY_CONFIG_DIRECTORY: data,
  TABBY_PLUGINS: plugin.replace(/^([A-Za-z]):\//, (_, drive) => `/cygdrive/${drive.toLowerCase()}/`) };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CODEX_THREAD_ID;
delete env.CODEX_SESSION_ID;
delete env.AGENT_MATH_DIAGNOSTICS;
const log = await open(path.join(root, '.cache/tabby-launch.log'), 'a');
const child = spawn(executable, ['open', directory], {
  env, cwd: directory, windowsHide: true, detached: true, stdio: ['ignore', log.fd, log.fd],
});
await new Promise((resolve, reject) => {child.once('spawn', resolve);child.once('error', reject);});
child.unref();
await log.close();
console.log('Math Terminal opened. Run codex in its terminal tab; right-click to toggle formula rendering.');
