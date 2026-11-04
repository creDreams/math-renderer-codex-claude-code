import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const binary = fileURLToPath(new URL('../dist/windows/AgentMath.exe', import.meta.url));
if (!existsSync(binary)) throw new Error('Run npm run build:windows first');
const child = spawn(binary, process.argv.slice(2), { detached: true, stdio: 'ignore', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.unref();
