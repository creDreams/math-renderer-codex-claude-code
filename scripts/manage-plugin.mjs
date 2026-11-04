import { copyFile, cp, lstat, mkdir, readFile, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [action, ...args] = process.argv.slice(2);
const option = args.indexOf('--plugins-dir');
if (!['install', 'uninstall'].includes(action) || option < 0 || !args[option + 1]) {
  throw new Error('Usage: npm run install:tabby -- --plugins-dir "<Tabby Plugins directory>" (or uninstall:tabby)');
}
// Resolve the directory the user explicitly named; never guess a global profile path.
const plugins = await realpath(path.resolve(args[option + 1]));
if (!(await lstat(plugins)).isDirectory()) throw new Error('Plugins directory does not exist.');
const modules = path.join(plugins, 'node_modules');
await mkdir(modules, { recursive: true });
if ((await lstat(modules)).isSymbolicLink()) throw new Error('A symlinked node_modules directory is unsupported.');
const target = path.join(modules, 'tabby-agent-math');
const verifyChild = value => {
  const relative = path.relative(plugins, value);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !relative) throw new Error('Target is outside the selected plugins directory.');
};
verifyChild(target);
const existing = await lstat(target).catch(() => undefined);
if (existing) {
  if (existing.isSymbolicLink()) throw new Error('A symlinked plugin target is unsupported.');
  const manifest = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'));
  if (manifest.name !== 'tabby-agent-math') throw new Error('The target belongs to another package.');
}
const backup = path.join(plugins, `.agent-math-${action === 'uninstall' ? 'uninstalled' : 'backup'}-${Date.now()}`);
verifyChild(backup);
if (action === 'uninstall') {
  if (existing) {await rename(target, backup);console.log(`Plugin removed from discovery; retained at ${backup}`);}
  else console.log('Plugin is not installed in this directory.');
} else {
  const staging = path.join(plugins, `.agent-math-staging-${Date.now()}`);
  verifyChild(staging);
  await mkdir(staging);
  await cp(path.join(root, 'packages/tabby-plugin/dist'), path.join(staging, 'dist'), { recursive: true });
  await copyFile(path.join(root, 'packages/tabby-plugin/package.json'), path.join(staging, 'package.json'));
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(path.join(root, name), path.join(staging, name));
  await copyFile(path.join(root, 'packages/tabby-plugin/README.md'), path.join(staging, 'README.md'));
  if (existing) await rename(target, backup);
  try { await rename(staging, target); }
  catch (error) { if (existing) await rename(backup, target); throw error; }
  console.log(`Plugin installed at ${target}`);
  if (existing) console.log(`Previous version retained at ${backup}`);
}
console.log('Restart Tabby to apply the change.');
