import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile, cp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeMarkdownLicenses } from './markdown-licenses.mjs';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows x64');
const exec = promisify(execFile), require = createRequire(import.meta.url);
const output = path.resolve(process.env.AGENT_MATH_BUILD_DIR ?? 'dist/windows');
await mkdir(path.join(output, 'runtime'), { recursive: true });
const runtimeHash = '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237';
const hash = data => createHash('sha256').update(data).digest('hex');
const runtime = path.join(output, 'runtime/node.exe');
async function download(url, destination) {
  await exec('curl.exe', ['--fail', '--silent', '--show-error', '--location', '--max-time', '60',
    '--output', destination, url], { windowsHide: true, maxBuffer: 65536 });
}
if (!existsSync(runtime) || hash(await readFile(runtime)) !== runtimeHash) {
  let binary = await readFile(process.execPath);
  if (hash(binary) !== runtimeHash) {
    const downloaded = path.resolve('.cache/node-24.19.0.exe');
    await mkdir('.cache', { recursive: true });
    await download('https://nodejs.org/dist/v24.19.0/win-x64/node.exe', downloaded);
    binary = await readFile(downloaded);
  }
  if (hash(binary) !== runtimeHash) throw new Error('Node runtime SHA-256 mismatch');
  await writeFile(runtime, binary);
}
await build({ entryPoints: ['packages/windows-companion/src/worker.ts'], outfile: path.join(output, 'worker.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['@resvg/resvg-js'],
  legalComments: 'eof', metafile: true }).then(async result => {
  const unwanted = Object.keys(result.metafile.inputs).filter(x => /node_modules\/(?:mj-context-menu|speech-rule-engine|rimraf|glob|minimatch)\//.test(x));
  if (unwanted.length) throw new Error('Unexpected runtime dependencies: ' + unwanted.join(', '));
});
await build({ entryPoints: ['packages/windows-companion/src/history-worker.ts'], outfile: path.join(output, 'history-worker.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', legalComments: 'eof' });
for (const name of ['@resvg/resvg-js', '@resvg/resvg-js-win32-x64-msvc']) {
  const packageFile = require.resolve(name + '/package.json');
  await cp(path.dirname(packageFile), path.join(output, 'node_modules', name), { recursive: true });
}
const windows = process.env.WINDIR ?? 'C:\\Windows';
const compiler = path.join(windows, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const gac = path.join(windows, 'Microsoft.NET/assembly/GAC_MSIL');
async function reference(name) {
  const versions = await readdir(path.join(gac, name));
  return '/reference:' + path.join(gac, name, versions.sort().at(-1), name + '.dll');
}
const references = await Promise.all(['UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'].map(reference));
const sources = (await readdir('packages/windows-companion/native')).filter(x => x.endsWith('.cs'))
  .map(x => path.resolve('packages/windows-companion/native', x));
const result = await exec(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001',
  '/out:' + path.join(output, 'AgentMath.exe'), '/win32manifest:' + path.resolve('packages/windows-companion/native/app.manifest'),
  '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll',
  '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll', ...references, ...sources],
{ windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
if (result.stdout.trim()) console.log(result.stdout.trim());
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(file, path.join(output, file));
await mkdir(path.join(output, 'licenses'), { recursive: true });
await copyFile('node_modules/@mathjax/src/LICENSE', path.join(output, 'licenses/Apache-2.0.txt'));
await copyFile('licenses/Codex-NOTICE.txt', path.join(output, 'licenses/Codex-NOTICE.txt'));
await copyFile('node_modules/get-east-asian-width/license', path.join(output, 'licenses/Unicode-Width-MIT.txt'));
await copyFile('node_modules/@resvg/resvg-js/LICENSE', path.join(output, 'licenses/MPL-2.0.txt'));
await writeMarkdownLicenses(path.join(output, 'licenses/Markdown-MIT.txt'));
const nodeLicense = path.resolve('.cache/node-24.19.0-LICENSE');
await mkdir('.cache', { recursive: true });
if (!existsSync(nodeLicense))
  await download('https://raw.githubusercontent.com/nodejs/node/v24.19.0/LICENSE', nodeLicense);
await copyFile(nodeLicense, path.join(output, 'NODE_LICENSE.txt'));
await writeFile(path.join(output, 'product.json'), JSON.stringify({ name: 'Agent Math', version: '0.2.0-preview.30',
  platform: 'win32-x64', node: '24.19.0', nodeSha256: runtimeHash, resvg: '2.6.2' }, null, 2) + '\n');
console.log('Built ' + path.relative(process.cwd(), path.join(output, 'AgentMath.exe')) + ' with bundled offline renderer and runtime.');
