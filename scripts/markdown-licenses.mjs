import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Preserve the original MIT notices for the bundled Markdown dependency tree. */
export async function writeMarkdownLicenses(destination) {
  const seen = new Set(), notices = [];
  async function visit(name, importer) {
    const require = createRequire(importer);
    let entry;
    try { entry = require.resolve(name + '/package.json'); }
    catch { entry = require.resolve(name); }
    let directory = path.dirname(entry), manifest, file;
    for (;;) {
      file = path.join(directory, 'package.json');
      manifest = await readFile(file, 'utf8').then(JSON.parse).catch(() => undefined);
      if (manifest?.name === name) break;
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error('Cannot resolve license for ' + name);
      directory = parent;
    }
    if (seen.has(directory)) return;
    seen.add(directory);
    const licenses = (await readdir(directory)).filter(name => /^licen[sc]e(?:\..*)?$/i.test(name)).sort();
    if (!licenses.length) throw new Error('Missing bundled Markdown license: ' + name);
    notices.push(name + '@' + manifest.version + '\n\n' +
      (await Promise.all(licenses.map(name => readFile(path.join(directory, name), 'utf8')))).join('\n'));
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) await visit(dependency, file);
  }
  await visit('mdast-util-from-markdown', new URL('../package.json', import.meta.url));
  await writeFile(destination, notices.join('\n\n' + '='.repeat(72) + '\n\n') + '\n');
}
