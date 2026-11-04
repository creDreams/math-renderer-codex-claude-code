// Research only: render the single, explicitly captured formula for a native overlay.
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const input = process.argv[2] ?? 'test-results/wt-uia-normal.json';
const output = process.argv[3] ?? 'test-results/wt-overlay-formula';
await mkdir('.cache/research', { recursive: true });
await build({ entryPoints: ['packages/core/src/renderer.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: '.cache/research/renderer.mjs' });
const { MathRenderer } = await import(pathToFileURL(path.resolve('.cache/research/renderer.mjs')));
const report = JSON.parse(await readFile(input, 'utf8'));
const element = report.elements.find(x => x.className === 'TermControl' && x.formula?.rectangles?.length);
if (!element) throw new Error('No visible formula in the targeted UIA capture');
const block = element.formula.text.split(/\r?\n/).map(x => x.trim()).join('\n');
if (!block.startsWith('\\[') || !block.endsWith('\\]')) throw new Error('Incomplete display formula');
const tex = block.slice(2, -2).trim();
const formula = new MathRenderer().render(tex);
const rects = element.formula.rectangles;
const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
const width = Math.ceil(Math.max(...rects.map(r => r.x + r.width)) - x);
const height = Math.ceil(Math.max(...rects.map(r => r.y + r.height)) - y);
const color = value => '#' + [value & 255, value >> 8 & 255, value >> 16 & 255]
  .map(x => x.toString(16).padStart(2, '0')).join('');
const background = color(element.formula.background);
const foreground = color(element.formula.foreground);
const scale = Math.min((width - 32) / formula.width, (height - 16) / formula.height, 2);
const executablePath = process.env.CHROME_PATH ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(`<style>body{margin:0;background:${background};color:${foreground};display:flex;align-items:center;justify-content:center;width:100vw;height:100vh}svg{width:${formula.width * scale}px;height:${formula.height * scale}px}</style>${formula.svg}`);
  await page.screenshot({ path: output + '.png' });
} finally { await browser.close(); }
const manifest = { input, block, tex, bounds: { x, y, width, height }, background, foreground,
  image: path.resolve(output + '.png'), originalText: element.text,
  note: 'Known captured formula only; not yet a general Codex adapter or installer.' };
await writeFile(output + '.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ output, bounds: manifest.bounds, tex }));
