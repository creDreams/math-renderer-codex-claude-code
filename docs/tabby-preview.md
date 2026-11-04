# Tabby 技术原型（0.1 归档）

当前默认使用 Windows Terminal 原生组件，见[项目首页](../README.md)。以下保留原型的使用与验证说明。

**0.1.0-preview.1**：在 Tabby 中，将 Codex 回答里保留为 LaTeX 源码的完整块公式自动显示为 SVG。插件观察终端缓冲区，校验本地助手消息，在原公式区域绘制覆盖层；终端输入输出、字符缓冲区和光标由宿主照常处理。

**后续产品方向**：面向社区使用，优先降低安装和日常使用成本，尽量保留使用者现有的终端与 Codex 操作方式。当前 Tabby 版本作为已验证的技术原型保留；它需要更换终端，尚未满足这一产品目标。下一阶段先验证现有终端的接入方式，具体约束见[产品方向](product-direction.md)。

**当前 Windows Terminal 版本**已实现自动观察、公式覆盖与独立安装包，见[使用说明](../README.md)和[验收记录](windows-validation.md)。下方安装步骤仅对应保留的 Tabby 原型。

Tabby 原型的历史截图保留本地；当前 Windows Terminal 版本的使用前后对比见[项目首页](../README.md#before-and-after)。

## 在本项目中启动

已在 Windows x64、Tabby 1.0.238、启动显示版本为 0.166.0 的本机 Codex 上验证。需要 Node.js 22+，以及已经能正常运行的 Codex。首次准备：

```powershell
npm ci
npm run build
npm run setup:tabby
npm run start:tabby
```

`setup:tabby` 下载官方 portable 版本并校验固定 SHA-256。宿主和数据目录位于忽略的 `.cache/tabby/`；新便携版配置关闭自动升级以保持验收版本，并关闭欢迎页及统计，已有配置予以保留。

**当前工作区已完成准备，可以直接双击 `Start Math Terminal.cmd`。** 打开终端后照常输入 `codex`。也可以指定起始目录：

```powershell
npm run start:tabby -- "D:\your-project"
```

在终端内右键，可查看匹配状态和切换“公式：启用渲染”。选中文字时暂时显示原文，复制仍取得原始终端文本。

## 安装到已有 Tabby

在 Tabby 的 **Settings → Plugins → Open Plugins Directory** 打开插件目录。关闭 Tabby，然后在项目根目录执行：

```powershell
npm run pack:plugin
npm run install:tabby -- --plugins-dir "C:\path\to\tabby\plugins"
```

重启 Tabby，在本地终端运行 Codex。插件安装于所选目录的 `node_modules/tabby-agent-math/`，更新保留旧版本备份。

卸载后重启宿主：

```powershell
npm run uninstall:tabby -- --plugins-dir "C:\path\to\tabby\plugins"
```

卸载会将插件移至所选目录中的隐藏备份目录，方便恢复。可分发的本地安装包位于 `dist/tabby-agent-math-0.1.0-preview.1.tgz`，也可以手动解压到上述插件位置。安装包已包含排版引擎与字体，无需在宿主上安装这些依赖。

## 当前支持范围

| 条件 | 行为 |
| --- | --- |
| 完整的 `\[...\]`、原始 `$$...$$` 块 | 助手全文和会话唯一匹配后原位渲染 |
| 本机 Codex 已将 `$$...$$` 转为字符公式 | 保留 Codex 生成的字符排版 |
| 普通/备用缓冲区、滚动、重绘、窗口变化 | 重新定位；旧区域立即撤掉覆盖 |
| 围栏/缩进代码、用户输入、工具输出 | 不作为公式正文依据 |
| 未完成块、多会话有歧义、消息被截断、空间不足 | 保留原文 |
| 行内公式、复杂 Markdown、其他 agent | 暂不承诺支持 |

自动匹配使用终端当前目录，以及 `$CODEX_HOME/sessions`（默认 `~/.codex/sessions`）中的只读 rollout 记录。完整助手消息必须与屏幕文本一致，且只能对应一个会话；不会仅挑选时间最新的文件。通常在完整回答写入会话记录后约两秒内显示。旧会话超出发现范围或工作目录变化时可能保留源码。

插件在本地生成 SVG，无网络请求；只启用 base/AMS TeX，禁止宏定义和外部资源。源区域无法容纳可读公式时不覆盖，不增加行数或推动正文。透明背景、Linux/macOS、其他宿主版本、Claude Code 尚未验收。此版本增强的是 **Tabby**，Windows Terminal 的 Sixel 能力不等于可加载此绘制插件。

## 开发与验证

```powershell
npm run verify
npm run dev:tabby
# 在该宿主运行 Codex，获得一条完整且含公式的回答，然后：
npm run test:tabby
```

`verify` 包含类型检查、8 项核心测试、14 项浏览器对照/性能检查，以及安装/更新/卸载验证。浏览器检查默认使用本机 Chrome/Edge，可设置 `CHROME_PATH`。真实宿主检查单独运行，不自动发送模型请求。开发启动器的调试端口和诊断接口仅用于测试；普通启动器不启用它们。

- [架构决定](adr/0001-presentation-only.md)和[会话匹配策略](adr/0002-conservative-provenance.md)
- [真实验证结果与性能基线](validation.md)
- [开发、打包和依赖说明](development.md)
- [已批准的原始计划](implementation-plan.md)
- [变更记录](../CHANGELOG.md)

项目采用本地 Git，依赖和 lockfile 固定版本。真实会话记录、凭据、宿主数据和构建输出不进入 Git。

MIT；MathJax 与 NewCM 字形数据使用 Apache-2.0，见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
