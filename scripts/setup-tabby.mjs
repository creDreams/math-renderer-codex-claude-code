import { createHash } from 'node:crypto';
import { mkdir, open, stat, rename, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Portable setup currently supports Windows x64.');
const version = '1.0.238';
const checksum = '56de045fbb5a74d586903367d3f7227276d538281b0068d8132de3318cdd5019';
const archive = path.join(root, `.cache/tabby-${version}-portable-x64.zip`);
const destination = path.join(root, '.cache/tabby');
const url = `https://github.com/Eugeny/tabby/releases/download/v${version}/tabby-${version}-portable-x64.zip`;
await mkdir(path.dirname(archive), { recursive: true });
if (!(await stat(archive).catch(() => undefined))) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Tabby download: HTTP ${response.status}`);
  const part = archive + '.partial';
  const output = await open(part, 'w');
  let downloaded = 0, lastReport = 0;
  try {
    for await (const chunk of response.body) {
      await output.write(chunk); downloaded += chunk.length;
      if (Date.now() - lastReport > 5000) {
        console.log(`Tabby: ${(downloaded / 1024 / 1024).toFixed(1)} MiB downloaded`);
        lastReport = Date.now();
      }
    }
  } finally { await output.close(); }
  await rename(part, archive);
}
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
if (hash.digest('hex') !== checksum) throw new Error('Tabby checksum mismatch. Archive was not extracted.');
if (!(await stat(path.join(destination, 'Tabby.exe')).catch(() => undefined))) {
  // Paths are passed via environment variables, not interpolated into PowerShell code.
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:AMT_SETUP_ARCHIVE -DestinationPath $env:AMT_SETUP_DESTINATION'], {
      windowsHide: true, stdio: 'inherit', env: { ...process.env,
        AMT_SETUP_ARCHIVE: archive, AMT_SETUP_DESTINATION: destination },
    });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Extraction exited ${code}`)));
  });
}
await mkdir(path.join(destination, 'data'), { recursive: true });
// Only seed our new portable profile; retain any configuration the user has saved.
await writeFile(path.join(destination, 'data/config.yaml'),
  'version: 1\nenableAutomaticUpdates: false\nenableWelcomeTab: false\nenableAnalytics: false\n', {flag:'wx'})
  .catch(error => {if(error.code !== 'EEXIST')throw error;});
console.log(`Tabby ${version} ready; upstream SHA-256 verified. Run npm run start.`);
