// Actual Windows Terminal geometry/scroll regression. Expectations are literal
// fixture blocks, independent of the production environment parser.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const equation = '\\begin{equation*}\n\\frac{a+b}{c}=x\n\\end{equation*}';
const align = '\\begin{align*}\nf(x)&=x^2\\\\\ng(x)&=x+1\n\\end{align*}';
const quote = '> ' + equation.replaceAll('\n', '\n> ');
const list = '- Independent list context\n\n  ' + align.replaceAll('\n', '\n  ');
const code = '> ```tex\n> \\begin{equation}\n> x=\\mathrm{code}\n> \\end{equation}\n> ```';
const dollar = '$$\np_0(v)^{1/T^2}\\propto q_s(v)\n$$';
const source = 'A verified mathematical derivation with explicit display environments and contextual examples.\n\n' + equation +
  '\n\nThe following quoted equation is also real display math.\n\n' + quote +
  '\n\n' + list + '\n\nThis quoted code example must stay literal.\n\n' + code +
  '\n\nThe final equation keeps its original dollar delimiters.\n\n' + dollar + '\n\nAll examples are now complete.';
const displayedAlign = align.replace('x^2\\\\', 'x^2\\');
const displayed = source.replace('- Independent list context', '• Independent list context')
  .replace(align.replaceAll('\n', '\n  '), displayedAlign.replaceAll('\n', '\n  '));
await mkdir('.cache', { recursive: true });
const fixture = path.resolve('.cache/environments-desktop.json');
await writeFile(fixture, JSON.stringify({ source, displayed,
  literalBlocks: [equation, quote, '  ' + displayedAlign.replaceAll('\n', '\n  '), dollar],
  anchor: 'The following quoted equation', width: 2300, height: 1350,
  requiredSameViewText: 'x=\\mathrm{code}', minimumSameViewFormulas: 2,
  reportName: 'windows-history-environments' }));
const { stdout } = await promisify(execFile)(process.execPath, ['scripts/test-windows-bottom.mjs', '--source-file', fixture],
  { windowsHide: true, maxBuffer: 1024 * 1024 });
process.stdout.write(stdout);
