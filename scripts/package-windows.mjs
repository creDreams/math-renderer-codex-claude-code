import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile), version = '0.2.0-preview.30';
const compiler = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const source = path.resolve('packages/windows-companion/installer/Setup.cs');
const output = path.resolve(process.env.AGENT_MATH_BUILD_DIR ?? 'dist/windows'), release = path.resolve('dist/releases');
await mkdir(release, { recursive: true });
const common = ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001',
  '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll',
  '/reference:System.Windows.Forms.dll', '/reference:System.IO.Compression.dll',
  '/win32manifest:' + path.resolve('packages/windows-companion/native/app.manifest')];
await exec(compiler, [...common, '/define:UNINSTALLER', '/out:' + path.join(output, 'Uninstall.exe'), source], { windowsHide: true });
await writeFile(path.join(output, '使用说明.txt'), '\ufeff' + [
  'Agent Math ' + version,
  '',
  '双击 AgentMath.exe，然后照常在 Windows Terminal 中运行 codex 或 claude。',
  'Claude Code 数学代码块：勾选托盘中的“行内与无标记公式（预览）”。',
  '完整的助手块公式显示后会自动排版；选中时显示源码，复制保留原文。',
  '托盘图标可暂停、恢复或退出。关闭状态窗口后仍在后台运行。',
  '可选：托盘勾选“行内与无标记公式（预览）”，增强行内公式及无可见标签的字符公式。',
  '关闭预览后仅覆盖带明确块标签的公式；Codex 自身输出的字符数学保留原样。',
  '行内公式仅在完整位于同一终端物理行、通过来源核验且原位空间足够时显示。',
  '代码、配置、命令和含糊表达保留原文；不改动终端文字或输入输出。',
  '',
  '无需安装 Node.js、Chrome 或 Tabby。面向本地 Windows x64 Codex / Claude Code 预览。',
  '支持独立行的 \\[ ... \\] 和 $$ ... $$；Codex 已转换的简单公式保留字符排版。',
  '支持 equation、align、gather、multline、alignat、flalign、eqnarray 及其星号环境、displaymath。',
  '公式本身被裁切、来源不足、匹配有歧义或空间不足时保留源码。',
  '透明终端、WSL/SSH、其他 agent、多显示器不同 DPI 尚未验收。',
  '',
  '便携使用：退出后可删除解压目录；用户设置位于 %LOCALAPPDATA%\\AgentMath。',
  '安装使用：运行安装包，默认安装到当前用户，无需管理员权限。',
  '更新：运行新版安装包。卸载：Windows 设置 → 应用 → Agent Math。',
].join('\r\n') + '\r\n');
const zip = path.join(release, `AgentMath-${version}-windows-x64.zip`);
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
// ZipFile streams the large runtime instead of buffering it in PowerShell.
const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath ${psQuote(zip)}) { Remove-Item -LiteralPath ${psQuote(zip)} }
[IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(output)}, ${psQuote(zip)}, [IO.Compression.CompressionLevel]::Optimal, $false)`;
await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
const setup = path.join(release, `AgentMath-${version}-Setup.exe`);
await exec(compiler, [...common, '/resource:' + zip + ',payload.zip', '/out:' + setup, source], { windowsHide: true });
const artifacts = [];
for (const file of [setup, zip]) {
  const bytes = await readFile(file);
  artifacts.push({ file: path.basename(file), bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(path.join(release, 'SHA256SUMS.txt'), artifacts.map(x => `${x.sha256}  ${x.file}`).join('\n') + '\n');
async function directoryBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    bytes += entry.isDirectory() ? await directoryBytes(file) : (await stat(file)).size;
  }
  return bytes;
}
await writeFile(path.join(release, 'release.json'), JSON.stringify({ version, artifacts,
  unpackedBytes: await directoryBytes(output) }, null, 2) + '\n');
console.log(JSON.stringify(artifacts, null, 2));
