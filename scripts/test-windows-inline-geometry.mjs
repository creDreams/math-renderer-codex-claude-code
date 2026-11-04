import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile), run = Date.now().toString(36);
const work = path.resolve('.cache/inline-geometry-' + run), title = 'AgentMathResearch-InlineGeometry-' + run;
const input = path.join(work, 'input.json'), control = path.join(work, 'control.txt'), output = path.join(work, 'probe.json');
const needles = ['x² + y² = r²', 'θ_{t+1} = θ_t − α∇J(θ_t)', 'Âₜ = Qₜ − Vₜ', '𝑥² + 𝑦² = 𝑟²'];
const lines = ['中文前文 ' + needles[0] + '，中文后文。', '重复 ' + needles[0] + ' 和 ' + needles[0] + '。',
  '中文 😀 前文 ' + needles[1] + '，后文。', '组合字符 ' + needles[2] + '，后文。', '数学字母 ' + needles[3] + '，后文。',
  '相同物理行 ' + needles[0] + '，后文。', '相同物理行 ' + needles[0] + '，后文。', '行尾公式 ' + needles[0]];
await mkdir(work, { recursive: true });
await writeFile(input, JSON.stringify({ normal: '• 行内坐标独立验证。\r\n  ' + lines.join('\r\n  ') +
  '\r\n  Worked for 1s\r\n› Input', needles }));
await writeFile(control, 'normal');
let completed = false, report;
try {
  await exec('wt.exe', ['-w', 'AgentMathInlineGeometry-' + run, 'new-tab', '--title', title, '--suppressApplicationTitle',
    'powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve('scripts/research/windows-history-fixture.ps1'), '-InputPath', input, '-ControlPath', control]);
  for (let i = 0; i < 100; i++) {
    if (await readFile(control + '.ready', 'utf8').catch(() => '') === 'normal') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve('scripts/research/probe-inline-ranges.ps1'), '-WindowTitle', title, '-InputPath', input, '-OutputPath', output],
  { windowsHide: true });
  report = JSON.parse(await readFile(output, 'utf8'));
  for (const span of report.spans) {
    assert.equal(span.matches.length, span.needle === needles[0] ? 6 : 1, 'all exact occurrences must be locatable');
    for (const found of span.matches) {
      assert.equal(found.text, span.needle); assert.equal(found.rectangles.length, 1);
      const rect = found.rectangles[0], row = report.rows.find(row => Math.abs(row.y - rect.y) < 1);
      assert.ok(row); assert.ok(rect.width > 0 && rect.width <= row.width);
      assert.ok(rect.x > row.x && rect.x + rect.width <= row.x + row.width);
    }
  }
  const repeated = report.spans[0].matches;
  assert.equal(repeated[1].rectangles[0].y, repeated[2].rectangles[0].y);
  assert.ok(repeated[1].rectangles[0].x + repeated[1].rectangles[0].width < repeated[2].rectangles[0].x);
  const gac = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/assembly/GAC_MSIL');
  const references = await Promise.all(['UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'].map(async name =>
    '/r:' + path.join(gac, name, (await readdir(path.join(gac, name))).sort().at(-1), name + '.dll')));
  const nativeTest = path.join(work, 'InlineGeometryTests.exe');
  await exec(path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/target:exe', '/codepage:65001', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', ...references,
      '/out:' + nativeTest, path.resolve('packages/windows-companion/native/InlineLocator.cs'), path.resolve('tests/native/InlineGeometryTests.cs')], { windowsHide: true });
  console.log((await exec(nativeTest, [title, output], { windowsHide: true })).stdout.trim());
  completed = true;
  console.log('PASS exact inline UIA ranges: CJK, emoji prefix, combining accents, supplementary math letters, duplicate spans');
  console.log(JSON.stringify(report.spans.map(span => ({ needle: span.needle, matches: span.matches })), null, 2));
} finally {
  await writeFile(control, 'exit'); await mkdir('test-results', { recursive: true });
  await writeFile('test-results/windows-inline-geometry.json', JSON.stringify({ completed, ...report, runAt: new Date().toISOString() }, null, 2) + '\n');
}
