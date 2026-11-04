import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile);
const output = path.resolve('.cache/native-proof/CaptureTests.exe');
await mkdir(path.dirname(output), { recursive: true });
await exec(path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  ['/nologo', '/target:exe', '/codepage:65001', '/r:System.Drawing.dll', '/out:' + output,
    path.resolve('packages/windows-companion/native/Models.cs'), path.resolve('packages/windows-companion/native/ClaudeViewport.cs'), path.resolve('tests/native/CaptureTests.cs')], { windowsHide: true });
console.log((await exec(output, [], { windowsHide: true })).stdout.trim());
const streaming = path.resolve('.cache/native-proof/StreamingProofTests.exe');
await exec(path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  ['/nologo', '/target:exe', '/codepage:65001', '/r:System.Drawing.dll', '/out:' + streaming,
    path.resolve('packages/windows-companion/native/Models.cs'), path.resolve('packages/windows-companion/native/ClaudeViewport.cs'), path.resolve('tests/native/StreamingProofTests.cs')], { windowsHide: true });
console.log((await exec(streaming, [], { windowsHide: true })).stdout.trim());
const viewport = path.resolve('.cache/native-proof/ClaudeViewportTests.exe');
await exec(path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  ['/nologo', '/target:exe', '/codepage:65001', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', '/out:' + viewport,
    path.resolve('packages/windows-companion/native/Models.cs'), path.resolve('packages/windows-companion/native/ClaudeViewport.cs'),
    path.resolve('packages/windows-companion/native/MathPalette.cs'), path.resolve('tests/native/ClaudeViewportTests.cs')], { windowsHide: true });
console.log((await exec(viewport, [path.resolve('tests/fixtures/claude-viewports.json')], { windowsHide: true })).stdout.trim());
