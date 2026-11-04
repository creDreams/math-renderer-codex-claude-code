import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const executable = process.env.TABBY_EXE ?? path.join(root, '.cache/tabby/Tabby.exe');
await mkdir(path.join(root, '.cache/tabby/data'), { recursive: true });
const plugin = path.join(root, 'packages/tabby-plugin').replaceAll('\\', '/');
const env = { ...process.env, TABBY_PLUGINS: process.env.AGENT_MATH_USE_INSTALLED === '1' ? '' :
  plugin.replace(/^([A-Za-z]):\//, (_, drive) => `/cygdrive/${drive.toLowerCase()}/`),
  TABBY_CONFIG_DIRECTORY: path.join(root, '.cache/tabby/data'), AGENT_MATH_DIAGNOSTICS: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CODEX_THREAD_ID;
delete env.CODEX_SESSION_ID;
const child = spawn(executable, ['--remote-debugging-port=9223', ...process.argv.slice(2)], {
  env, cwd: root, stdio: 'inherit', windowsHide: true,
});
console.log(`Tabby development PID: ${child.pid}`);
child.on('exit', code => process.exit(code ?? 1));
