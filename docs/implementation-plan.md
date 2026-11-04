# Agent Math Terminal：已批准实施计划

日期：2026-11-02  
状态：**用户已批准；0.1.0-preview.1 已构建并完成本机验收，具体支持边界见 README 与 validation.md**
项目目录：本仓库根目录。

后续方向更新（2026-11-02）：用户明确要求面向社区发布时尽量保留现有终端与操作习惯，降低上手成本。本文保留已经完成的 Tabby 预览版计划与验收记录；后续宿主选择按[产品方向](product-direction.md)重新评估，Tabby 不作为社区版的默认宿主前提。

## 1. 已确认的目标

在终端呈现层增加一个可插拔的公式显示环节，让原版 Codex 的公式源码在原位置显示为排版后的数学公式。

- 保留 Codex 的原始终端输出和控制序列。
- 保留终端的逻辑缓冲区、光标和字符网格。
- 保留宿主已有的输入处理和 PTY 通道；公式插件不代理、改写或重新生成这条通道。
- 插件只观察终端状态并维护视觉覆盖层，可以启停和卸载。
- 首个适配目标是 Codex。Claude Code 等后续通过适配接口扩展，不列为首版已支持产品。

## 2. 调研结论

### 2.1 现有 Windows Terminal 不能直接作为已确定的插件宿主

本机版本为 Windows Terminal 1.24.12741.0，已经验证能够显示 Sixel 图片。但图片协议与绘制插件接口是两种不同能力。

Windows Terminal 的 JSON Fragment Extensions 文档公开的是配置、终端配置文件与配色扩展。其第三方代码扩展议题 #4000 仍为 open，包含自定义绘制和缓冲区读取等尚待设计的扩展能力。

**调研没有找到足以实现本项目的、已验证可用的 Windows Terminal 绘制插件 API。** 因此不把“安装一个插件便能增强现有 Windows Terminal”写成首版承诺。这不是对任何未来版本或其他非公开接入方式的不可行性证明。

### 2.2 推荐首个宿主：Tabby

核对了 Tabby 稳定版 v1.0.238（发布于 2026-10-07）的源码：

- 提供 `TerminalDecorator.attach/detach` 插件生命周期。
- 终端组件有 `frontend` 和 `frontendReady`。
- `XTermFrontend` 持有 xterm.js 实例，相关类由 `tabby-terminal` 导出。
- 稳定版源码的 xterm.js 依赖范围为 `^5`；master 已使用 `^6.0.0`，不能将两者混用为一个已验证版本。
- 开发插件可以通过 `TABBY_PLUGINS` 从指定目录加载。

这条路线让终端宿主继续负责创建 Codex 进程、ConPTY、输入、窗口尺寸和关闭过程；我们的插件只增加显示能力。

**使用代价：需要在 Tabby 中运行原版 Codex。现有 Windows Terminal 会继续保留，但不会因为安装此插件获得公式增强。**

接口风险：`XTermFrontend` 在源码中标记为 `@hidden`，部分 xterm.js API 是 proposed；访问实例并非长期兼容承诺。正式工程应固定已实测宿主版本、封装访问、做运行时能力检查。真实 Tabby 插件加载尚未验证，列为首个停止关卡。

### 2.3 视觉层可行性已经进行临时验证

验证环境：Node.js 24.19.0、Chrome 156.0.8078.74、xterm.js 5.5.0 和 6.0.0。

两个 xterm.js 版本各完成一轮独立验证。将同一组终端数据写入“带公式视觉覆盖”的终端与不带覆盖的对照终端，比较缓冲区字符、字符宽度、颜色、光标、滚动基点和视口状态。

结果：

1. SVG 公式可以覆盖原有 LaTeX 区域，缓冲区和光标不变。
2. 选择与复制仍可取得原始 LaTeX。
3. 普通字符、方向键和 Ctrl+C 的输入事件可以继续传递。
4. 测试中的窗口行列变化与对照终端状态一致。
5. 普通缓冲区和备用屏幕均能使用宿主拥有的视觉覆盖层。
6. 监听解析完成事件后，可以在底层区域被改写时移除旧覆盖。
7. 测试中的滚动状态与对照终端一致。

重要限制：xterm 自带 decoration 在备用屏幕中被隐藏；测试中 API 可以返回对象，但该对象不代表可以在备用屏幕正常显示。不能只使用 decoration API 来实现整个插件。

以上验证使用**已知公式位置**。尚未验证自动定位真实 Codex 回复、持续滚动中的公式锚定、真实 Tabby 插件加载或完整 Codex 交互。临时 SVG 来自旧原型的 MathJax 3 排版，只用于验证绘制层；正式渲染依赖在第一阶段锁定。

### 2.4 ConPTY 独立探测的结果与限制

临时使用 node-pty 1.1.0 启动了受控子进程，验证了中文、方向键、Ctrl+C、Enter、窗口尺寸和子进程退出事件。

系统 ConPTY 与包附带的 ConPTY DLL 均通过了上述基本 I/O 检查，但探测宿主在子进程退出后仍保持运行，已停止临时进程。**不能将这些结果表述为宿主资源清理已通过。**

推荐的 Tabby 插件路线复用宿主的进程管理，因此不引入自己的 node-pty 实例；真实 Tabby 的关闭、退出、插件卸载与进程残留仍必须实测。

### 2.5 Codex 信息来源

本机版本为 codex-cli 0.166.0。此前已核对本机帮助：交互式 CLI 是 TUI；`--no-alt-screen` 仍是 inline TUI；`exec --json` 属于非交互模式。方案不以重写 Codex 前端或修改其启动模式为前提。

本次 OpenAI 官方文档请求返回 HTTP 403，未据此声称最新接口行为已经核实。协议接入不是本方案的主通道。

## 3. 推荐架构

```text
原版 Codex ⇄ Tabby 现有 PTY / 输入输出通道 ⇄ xterm.js 解析与逻辑缓冲区
                                                     │ 只读观察
                                                     ▼
                                              终端区域快照与坐标映射
                                                     ▼
                                             Codex 适配与公式识别
                                                     ▼
                                               MathJax → SVG
                                                     ▼
                                           视觉覆盖层 → 用户看到的画面
```

覆盖层的尺寸限定在原字符区域之内。首版不压缩原有空白、不推动后续文本、不改变终端向应用报告的行列数。这使用户定义的“原始流与逻辑状态保持完整”可以直接验收。

当可用区域不足以清晰显示公式时保留原文，不以极度缩小或遮挡相邻内容来冒充成功。展开查看和改变正文高度的视觉重排放入后续范围。

覆盖层在源区域变更、缓冲区切换、重绘、缩放、视口变化时重新校验；异步排版结果必须校验区域版本后才能显示。开关、菜单等通过宿主扩展机制提供，默认不截获普通输入。

## 4. 公式与 Codex 适配边界

首版优先处理完整的 `\[...\]`、`$$...$$` 块公式。行内公式、尚未闭合的流式公式、任意 TeX 文档编译、额外 agent 与跨终端发行不作为 v0.1 的承诺。

终端缓冲区没有通用的“助手正文”“代码块”“用户输入”语义。即使正确识别了数学分隔符，也不能直接证明该区域应该被覆盖。

Codex 适配器应负责结合文本上下文和会话信息提高识别可靠性。若必要，可只读读取与当前标签页明确关联的会话内容，辅助判断角色和 Markdown 代码区域；其用途是语义校验，最终位置仍以终端缓冲区为准，不另开公式查看器。

约束：

- 多会话不能简单使用“最近一个会话”作为可靠关联。
- 无法可靠区分助手正文、用户输入、代码或工具输出时保留原文。
- 同一公式出现在不同位置时分别处理，不能按公式全文全局去重。
- 软换行、中文宽字符、组合字符和 ANSI 样式必须正确映射到字符格。
- Codex 会话文件可能变化或不可用；适配失败应停用相应增强并给出可理解的状态。

**能否可靠定位真实 Codex 块公式，是必须先通过的工程关卡。** 若只能显示已知坐标的模拟公式，不进入“已支持 Codex”的验收。

## 5. 工程组织

推荐 TypeScript 工作区，第一宿主为 Tabby，核心与宿主分离：

```text
agent-math-terminal/
  packages/
    core/                 公式候选、区域模型、排版调度与缓存
    xterm-addon/          只读缓冲区观察、坐标映射、视觉覆盖
    adapter-codex/        Codex 正文语义、会话关联与识别策略
    tabby-plugin/         宿主生命周期、设置、启停与能力检查
  tests/
    fixtures/             合成或脱敏的终端输出样本
    integration/          双终端对照与宿主集成测试
  docs/
    adr/                  关键架构决定及其依据
    research/             本轮调研及可复现的验证记录
  README.md
  package.json
  package-lock.json
  .gitignore
```

SVG 在本地生成并在宿主中绘制，无需 Sixel 转码。旧原型保留作为参考，正式工程重新组织模块和测试，不整体搬入旧工具目录及其依赖。

正式阶段核对并锁定 MathJax 当前版本及本地字体资源；本轮 npm 查询的 `@mathjax/src` 最新版本为 4.1.3。选择以实际打包、离线渲染与测试结果为依据。

## 6. 审核通过后的实施顺序与停止关卡

| 阶段 | 交付物 | 通过条件 |
| --- | --- | --- |
| M0 工程与宿主验证 | 本地 Git 仓库、工程约定、锁定版 Tabby 的最小插件 | 在真实 Tabby 加载、卸载，访问缓冲区并进行 SVG 原位覆盖；原始流和状态不变 |
| M1 终端显示核心 | 区域模型、MathJax 排版、覆盖层、开关、失效处理 | 普通/备用屏幕、重绘和缩放下可恢复原文；与未增强终端的逻辑状态一致 |
| M2 Codex 自动适配 | 标签页关联、候选与正文校验、真实 Codex 演示 | 原版 Codex 的真实完整块公式自动出现在原位置；排除用户输入和代码样本 |
| M3 兼容与回归 | 终端回放样本、交互矩阵、性能记录 | 流分片、重复公式、软换行、中文、滚动、主题/DPI、Ctrl+C、退出及资源回收通过 |
| M4 v0.1 交付 | 本地可安装插件、安装/卸载说明、兼容矩阵、版本标签 | 在锁定的 Windows/Tabby/Codex 版本组合中可重复安装、使用、停用和卸载 |

M0/M2 已通过真实宿主与本地 Codex 回答验证，M1/M3 通过核心、浏览器回放和性能检查，M4 已完成打包及真实安装/卸载。预览版范围内的记录见 [validation.md](validation.md)。本文件保留批准时的路线与验收要求；扩展到其他宿主、agent、复杂 Markdown 或原生字符公式仍需后续验收。

## 7. 验收标准

1. **流不变**：同一宿主、同样输入和终端尺寸下，插件不向应用输出链路插入、删除或替换字符和控制序列；不接管普通输入事件。
2. **逻辑状态不变**：对照测试中字符、字符宽度、光标、缓冲区类型和滚动状态一致。视觉层不调用终端写入方法来替换内容。
3. **实际自动定位**：真实 Codex 回复中的完整块公式可自动识别并原位显示；有歧义时显示原文。
4. **交互连续**：输入、方向键、中断、继续对话、现有审批界面、选择复制及窗口变化正常。审批流程以真实配置允许的场景及回放样本验证。
5. **覆盖生命周期正确**：无残留图片、错盖输入区、跨标签页串联或旧排版结果覆盖新内容。
6. **开关与卸载有效**：关闭增强立即显示原文；插件异常不阻塞宿主正常输入和输出；关闭标签页后无插件自建的残留进程、定时器和监听器。
7. **性能有记录**：记录基准与启用后的解析/排版/绘制耗时和输入表现；采用增量扫描、缓存与排版任务预算，避免同步阻塞输入。正式性能阈值在 M0 固定测试样本和机器环境后写入基线，不在本轮虚构数值。

## 8. Git 与交付方式

- 审核通过后在指定项目目录执行 `git init -b main`。
- 第一条提交保存已批准的设计、调研依据、工程配置和验证方式。
- 按独立功能或里程碑提交，完成相应检查后再提交；必要时使用短期功能分支。
- 依赖版本与 lockfile 纳入 Git，兼容版本和架构决定有文档记录。
- 忽略 `node_modules`、构建输出、临时文件、真实会话日志、机器配置和凭据。
- 合成/脱敏终端样本纳入测试；真实 Codex 完整输出不默认入库。
- v0.1 验收通过后创建本地版本标签；远程托管地址由后续需要确定。

## 9. 已获批准的范围

用户已批准以上整条实施路线，尤其是：

1. 首版使用 **Tabby 作为终端宿主，在其中运行原版 Codex**，不承诺直接增强已安装的 Windows Terminal。
2. 首版保持原区域占位，优先完整块公式；不足以清晰显示时保留源码。
3. 通过 M0/M2 的真实环境关卡后继续迭代；无法满足时带证据重新讨论。
4. 项目在指定日期目录下独立建仓，以本地 Git 维护。

## 10. 来源与验证材料

- Windows Terminal 配置片段文档源码：<https://github.com/MicrosoftDocs/terminal/blob/main/TerminalDocs/json-fragment-extensions.md>
- Windows Terminal 第三方扩展追踪：<https://github.com/microsoft/terminal/issues/4000>
- Windows Terminal 内部渲染接口：<https://github.com/microsoft/terminal/blob/main/src/renderer/inc/IRenderEngine.hpp>
- Tabby 稳定版：<https://github.com/Eugeny/tabby/releases/tag/v1.0.238>
- Tabby 插件开发与加载：<https://github.com/Eugeny/tabby/blob/v1.0.238/HACKING.md>
- Tabby TerminalDecorator：<https://github.com/Eugeny/tabby/blob/v1.0.238/tabby-terminal/src/api/decorator.ts>
- Tabby 终端组件：<https://github.com/Eugeny/tabby/blob/v1.0.238/tabby-terminal/src/api/baseTerminalTab.component.ts>
- Tabby XTermFrontend：<https://github.com/Eugeny/tabby/blob/v1.0.238/tabby-terminal/src/frontends/xtermFrontend.ts>
- Tabby 导出的接口：<https://github.com/Eugeny/tabby/blob/v1.0.238/tabby-terminal/src/index.ts>
- xterm.js 6.0 类型声明：<https://github.com/xtermjs/xterm.js/blob/6.0.0/typings/xterm.d.ts>
- xterm.js decoration 绘制实现：<https://github.com/xtermjs/xterm.js/blob/6.0.0/src/browser/decorations/BufferDecorationRenderer.ts>
- node-pty：<https://github.com/microsoft/node-pty>

批准前的原型实验在系统临时目录中完成，摘要归档在 `docs/research/initial-research.json`，历史实验截图保留本地。正式实现、可复现测试及当前结果分别位于 `packages/`、`tests/`、`scripts/` 和 `docs/validation.md`。当前公开展示图见[截图说明](showcase.md)。
