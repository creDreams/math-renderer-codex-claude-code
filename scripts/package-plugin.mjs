import { copyFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
async function preparePackage() {
  await mkdir('packages/tabby-plugin/dist/licenses', { recursive: true });
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    await copyFile(name, `packages/tabby-plugin/${name}`);
  }
  await copyFile('node_modules/@mathjax/src/LICENSE', 'packages/tabby-plugin/dist/licenses/Apache-2.0.txt');
}
await preparePackage();
await mkdir('dist', { recursive: true });
const npmCLI = process.env.npm_execpath;
if (!npmCLI) throw new Error('Run via npm run pack:plugin.');
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [npmCLI, 'pack', './packages/tabby-plugin',
    '--pack-destination', path.join(root, 'dist')], { stdio: 'inherit', windowsHide: true });
  child.on('error', reject);child.on('exit', code => code === 0 ? resolve() : reject(new Error(`npm pack exited ${code}`)));
});
