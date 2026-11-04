import { execFile } from 'node:child_process';
import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile), directory = path.resolve('.cache/worker-proof');
await mkdir(path.join(directory, 'runtime'), { recursive: true });
for (const name of ['seen-1', 'seen-2', 'release-1', 'release-2']) await rm(path.join(directory, name), { force: true });
await copyFile(process.execPath, path.join(directory, 'runtime/node.exe'));
await writeFile(path.join(directory, 'worker.cjs'), `
const mode = process.env.CODEX_HOME;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (mode !== 'startup-stall') send({type:'ready', protocol: mode === 'protocol' ? 99 : 1});
setInterval(() => {}, 1000);
if (mode !== 'blocked-input' && mode !== 'startup-stall') {
  require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const value = JSON.parse(line);
    if (value.type === 'quit') process.exit(0);
    if (mode === 'stall') return;
    if (mode === 'exit') process.exit(1);
    if (mode === 'malformed') { process.stdout.write('{bad json\\n'); return; }
    const result = {type:'result', id:value.id, state:'matched', sourceRanges:[{startRow:0,endRow:0}], formulas:[]};
    if (mode === 'null-formula') result.formulas = [null];
    if (mode === 'outside-proof') result.sourceRanges = [{startRow:0,endRow:999}];
    if (mode === 'unverified-range') result.verifiedRanges = [{startRow:0,endRow:1}];
    if (mode === 'unverified-formula') {
      result.verifiedRanges = [];
      result.formulas = [{startRow:0,endRow:0,width:1,height:1,imageId:'a'.repeat(64),png:'AA=='}];
    }
    if (mode.startsWith('inline-')) {
      const f = {startRow:0,endRow:0,startColumn:2,endColumn:14,visibleText:'x² + y² = r²',kind:'inline',offsetY:2,
        width:100,height:20,imageId:'a'.repeat(64),png:'AA=='};
      result.formulas = [f];
      if (mode === 'inline-wrong-text') f.visibleText = 'other';
      if (mode === 'inline-negative-column') f.startColumn = -1;
      if (mode === 'inline-outside-column') f.endColumn = 999;
      if (mode === 'inline-empty-span') f.endColumn = f.startColumn;
      if (mode === 'inline-kind') f.kind = 'block';
      if (mode === 'inline-height') f.offsetY = 20;
      if (mode === 'inline-offset') f.offsetY = -1;
      if (mode === 'inline-multiline') f.endRow = 1;
      if (mode === 'inline-unproved') result.verifiedRanges = [];
      if (mode === 'inline-normal' && process.env.AGENT_MATH_INLINE_MATH !== '1') process.exit(1);
      if (mode === 'inline-disabled' && process.env.AGENT_MATH_INLINE_MATH !== '0') process.exit(1);
    }
    if (mode === 'indexing-stream') {
      result.sourceRanges = [{startRow:0,endRow:4}];
      result.formulas = [{startRow:1,endRow:3,width:1,height:1,imageId:'a'.repeat(64),png:'AA=='}];
    }
    if ((mode === 'indexing' || mode === 'indexing-stream') && value.id > 1) {
      result.state = 'waiting'; result.formulas = []; result.retryAfterMs = 150; result.pendingSource = true;
    }
    if (mode === 'rejected' && value.id > 1) { result.state = 'ambiguous'; result.formulas = []; }
    if (mode !== 'normal') { send(result); return; }
    send({...result, id:value.id + 100});
    require('node:fs').writeFileSync('seen-' + value.id, 'seen');
    const release = setInterval(() => {
      if (!require('node:fs').existsSync('release-' + value.id)) return;
      clearInterval(release); send(result);
    }, 10);
  });
}
`);
const output = path.join(directory, 'WorkerBridgeTests.exe');
await exec(path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  ['/nologo', '/target:exe', '/codepage:65001', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', '/out:' + output,
    path.resolve('packages/windows-companion/native/Models.cs'), path.resolve('packages/windows-companion/native/ClaudeViewport.cs'), path.resolve('packages/windows-companion/native/WorkerBridge.cs'),
    path.resolve('tests/native/WorkerBridgeTests.cs')], { windowsHide: true });
console.log((await exec(output, [directory], { windowsHide: true, timeout: 30000 })).stdout.trim());
