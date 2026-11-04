import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeMarkdownLicenses } from './markdown-licenses.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const common = { bundle: true, sourcemap: true, target: 'es2022', logLevel: 'info' };
const plugin = await build({ ...common, entryPoints: ['packages/tabby-plugin/src/index.ts'], metafile: true,
  outfile: 'packages/tabby-plugin/dist/index.cjs', format: 'cjs', platform: 'node',
  external: ['@angular/*', 'tabby-*', 'rxjs', 'rxjs/*'] });
await build({ ...common, entryPoints: ['packages/xterm-addon/src/overlay.ts'],
  outfile: 'dist/overlay.js', format: 'iife', globalName: 'AgentMath', platform: 'browser' });
await mkdir('packages/tabby-plugin/dist/licenses', { recursive: true });
await copyFile('node_modules/@mathjax/src/LICENSE', 'packages/tabby-plugin/dist/licenses/Apache-2.0.txt');
await copyFile('licenses/Codex-NOTICE.txt', 'packages/tabby-plugin/dist/licenses/Codex-NOTICE.txt');
await copyFile('node_modules/get-east-asian-width/license', 'packages/tabby-plugin/dist/licenses/Unicode-Width-MIT.txt');
await writeMarkdownLicenses('packages/tabby-plugin/dist/licenses/Markdown-MIT.txt');
const inputs = Object.keys(plugin.metafile.inputs);
const excluded = ['mj-context-menu', 'rimraf', 'glob', 'minimatch', 'speech-rule-engine', 'mhchemparser'];
const unexpectedlyBundled = excluded.filter(name => inputs.some(file => file.includes(`node_modules/${name}/`)));
if (unexpectedlyBundled.length) throw new Error(`Unexpected runtime dependency: ${unexpectedlyBundled.join(', ')}`);
await writeFile('dist/build-report.json', JSON.stringify({
  sha256: createHash('sha256').update(await readFile('packages/tabby-plugin/dist/index.cjs')).digest('hex'),
  bundledInputs: inputs.length, excludedFromRuntimeBundle: excluded,
  imports: Object.values(plugin.metafile.outputs).flatMap(output => output.imports),
}, null, 2) + '\n');
