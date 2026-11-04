# Windows Terminal 外部呈现研究

日期：2026-11-02。范围：验证无需更换终端或代理终端数据流的接入方式，尚未构建可分发产品。

## 结果

Windows Terminal 的 `TermControl` 通过系统 UI Automation 提供 `TextPattern`。实际版本 1.24.12741.0 可读取可见文字、查找源码范围、返回物理屏幕矩形及前景/背景颜色。安装在终端外的程序因此可以取得公式位置，并绘制独立的原生覆盖窗口。

研究使用 Windows PowerShell 5.1 内置的 .NET Framework、UIAutomationClient 与 WinForms；未安装额外 UIA 工具、修改终端配置或加载终端内部模块。排版复用当前 MathJax 核心，由开发机的 Node.js 与 headless Chrome 生成 PNG。这些开发依赖的产品封装尚未实现。

实际查看了覆盖后的受控窗口截图。随后在 Windows Terminal 中恢复已有的纯公式 Codex 测试会话，进行了已存回答的覆盖、源码对比、键盘输入与历史滚动验证，没有发送新的模型请求。测试窗口及后台探测进程已经退出。

原始 UIA 捕获、截图和日志存放在忽略的 `test-results/`。已提交的截图只裁取合成样本；[结果文件](windows-terminal-uia-results.json)仅保留脱敏的能力、状态及性能摘要。

## 尚未解决的事项

- 研究覆盖程序只绘制启动前捕获并渲染的单个公式，不是可持续自动使用的插件。
- 原生命中测试确认覆盖位置能命中原终端；自动鼠标拖选在覆盖前后均返回空选择，因此不能声称实际拖选验收通过。UIA 程序化选择导致覆盖隐藏已通过。
- 首次受控“输出大量行”实验没有产生可确认的视口变化，不计为滚动通过。另在真实 Codex 历史中用 UIA `ScrollIntoView` 确认了离开与返回后的隐藏和恢复。实际滚轮仍需独立验证。
- 100 ms 轮询期间可能存在短暂旧图。事件失效、菜单遮挡、多个面板、不同 DPI、透明主题与独立安装仍是下一阶段关口。
- UIA 字号属性在本机未返回数字，坐标应使用范围矩形，不能依赖该属性计算位置。标题栏的 TextBlock 也提供 TextPattern，但不支持所需的 FindText，因此必须筛选 TermControl。
- 受控变化期间发生一次 COM 异常，探测程序隐藏后恢复；生产实现需要超时和失效管理。
- 当前比较验证源码和可见文字一致；没有读取终端内部所有字符属性、光标和状态，不能用它替代原 Tabby 的完整缓冲区对照测试。

## 开发者复现

以下命令在项目根目录运行，只用于研究。终端名称以 `AgentMathResearch` 开头，控制脚本拒绝操作其他名称的窗口；键盘和鼠标实验还要求该窗口位于前台。

创建独立的受控终端：

```powershell
New-Item -ItemType Directory -Force .cache/research,test-results | Out-Null
$control = Join-Path (Get-Location) '.cache/research/wt-control.txt'
$fixture = Join-Path (Get-Location) 'scripts/research/windows-terminal-fixture.ps1'
Set-Content -Encoding ASCII $control normal
wt.exe -w new --size 110,32 new-tab --title AgentMathResearch --suppressApplicationTitle powershell.exe -NoLogo -NoProfile -File $fixture -ControlPath $control
```

窗口显示后，捕获公式并离线排版：

```powershell
./scripts/research/probe-windows-terminal-uia.ps1 -WindowTitle AgentMathResearch -OutputPath test-results/wt-uia-normal.json
node scripts/research/render-uia-formula.mjs
Set-Content -Encoding ASCII .cache/research/wt-overlay-stop.txt run
./scripts/research/run-windows-terminal-overlay.ps1 -WindowTitle AgentMathResearch
```

最后一条命令运行原生消息循环，默认最多 240 秒。另一 PowerShell 窗口可修改受控样本状态、观察覆盖失效，再停止探测程序：

```powershell
Set-Content -Encoding ASCII .cache/research/wt-control.txt alternate
Set-Content -Encoding ASCII .cache/research/wt-control.txt approval
Set-Content -Encoding ASCII .cache/research/wt-control.txt normal
./scripts/research/control-windows-terminal-probe.ps1 -WindowTitle AgentMathResearch -Action select
./scripts/research/control-windows-terminal-probe.ps1 -WindowTitle AgentMathResearch -Action clear-selection
./scripts/research/control-windows-terminal-probe.ps1 -WindowTitle AgentMathResearch -Action move -X 300 -Y 250
./scripts/research/control-windows-terminal-probe.ps1 -WindowTitle AgentMathResearch -Action resize -Width 1200 -Height 800
Set-Content -Encoding ASCII .cache/research/wt-overlay-stop.txt stop
Set-Content -Encoding ASCII .cache/research/wt-control.txt exit
```

每次改变状态后，应等窗口完成刷新再观察；不能把上面相邻写入连续执行的最终画面当成各阶段都已验证。

真实 Codex 验证在另一个以 `AgentMathResearch` 开头的独立窗口中，手动恢复一个明确用于公式实验的会话。捕获命令仍为 `probe-windows-terminal-uia.ps1`。可用如下脚本检查完整助手正文与本地会话是否唯一匹配；输出不含会话 ID 和正文：

```powershell
node node_modules/tsx/dist/cli.mjs scripts/research/verify-uia-codex.ts test-results/wt-uia-codex-before.json
```

该脚本使用占位字符列来复用语义匹配器，仅验证完整正文及公式来源，不用这些列绘图；实际物理坐标全部来自 UIA。当前公式捕获与覆盖脚本只寻找首个可见分隔符，生产识别需要完整块校验、排除提示词和代码、处理重复出现的公式及异步版本校验。

## 源码依据

核对了与本机版本一致的官方标签 `v1.24.12741.0`，提交 `7ff11ee107c984e236960ec948b450ccbc10187b`：

- [GetVisibleRanges](https://github.com/microsoft/terminal/blob/v1.24.12741.0/src/types/ScreenInfoUiaProviderBase.cpp)：以视口产生可见文字范围。
- [FindText、GetBoundingRectangles 与颜色属性](https://github.com/microsoft/terminal/blob/v1.24.12741.0/src/types/UiaTextRangeBase.cpp)：范围定位并裁切到可见视口。
- [TermControlUiaProvider](https://github.com/microsoft/terminal/blob/v1.24.12741.0/src/types/TermControlUiaProvider.cpp)：TermControl 类名、位置与文字网格信息。
- [UiaRenderer](https://github.com/microsoft/terminal/blob/v1.24.12741.0/src/renderer/uia/UiaRenderer.cpp)：文字、选择与光标相关通知。

这些公开辅助功能接口提供只读观察的依据，并不等于 Windows Terminal 提供了绘制扩展接口。绘制由外部原生窗口完成。
