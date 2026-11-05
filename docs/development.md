# 开发说明

## Windows 原生组件（当前主线）

`packages/windows-companion/native` 使用系统 .NET Framework 编译为 Windows x64 WinForms 程序，负责 UIA 工作线程、窗口生命周期、托盘和 UTF-8 私有管道。`src/analyzer.ts` 复用 `core` 与 `adapter-codex`，MathJax SVG 通过 resvg 转为 PNG。没有浏览器或网络服务；不链接终端 PTY，不接管键盘和剪贴板。

.9 的 `src/history-worker.ts` 在独立 Node 线程运行 `adapter-codex/history-index.ts`，使用捆绑 Node 的内建 SQLite 建立派生偏移索引。`history-client.ts` 只传入当前视口并接收核验后的公式/行范围；不把全部会话正文传给排版线程。原文、SVG、PNG 缓存各自限制条目和估计字节，命中提升 LRU 顺序；详见[历史按需渲染](history-rendering.md)。保留的 Tabby 原型继续使用旧 SessionStore，不依赖新的 SQLite 线程。

`npm run test:windows-lazy` 不需要前台桌面，直接测试捆绑的真实 worker、索引持久化、旧记录、缓存淘汰、并发请求和性能门槛，已纳入 Windows CI。`npm run test:windows-scroll` 需要解锁桌面，在独立终端核对随机回看、快速连续滚动和原生显示调用时间；它不发送模型请求。

`npm run test:windows-positions` 在独立终端逐行改变密集公式的位置，覆盖两种窗口尺寸。预期块从完整测试原文独立求得，几何直接对照 UIA 分隔符所在行；等待条件同时要求本次滚动后的新绘制时间，防止把数量相同的上一帧当成新视口结果。`adapter-codex/native-display.ts` 仅预测有界的已知字符布局用于核验，沿用上游 Codex Apache-2.0 约定并随包携带说明。

`npm run build:windows` 生成 `dist/windows`，包括原生宿主、捆绑 worker、resvg 原生库和固定官方 Node.js 24.19.0；Node 二进制必须匹配脚本内固定 SHA-256。下载使用 HTTPS，不匹配即失败。`npm run pack:windows` 进一步生成便携 zip、带内嵌资源的单文件安装程序、卸载程序和校验清单。

安装器只接受空目录或具有正确产品标记的安装目录；先解压到专用临时目录再替换，失败时恢复原目录。用户设置与应用文件分离。默认只注册当前用户的开始菜单和应用卸载信息，登录启动需在安装界面选择。更新和卸载仅请求 Agent Math 自行退出，不终止终端或 Codex。

`npm run test:windows` 在有交互桌面的 Windows Terminal 中运行合成样本，验证真实键鼠、可见区域和窗口状态。测试只向具有固定研究名称的自建终端发送键鼠动作，不得对所有 WindowsTerminal 进程执行终止操作。`npm run test:windows-live` 会发送两次真实模型请求；它不在常规 `verify` 或 CI 中自动执行。

`npm run test:windows-package` 在操作系统临时目录安装，清空 PATH 并设置无效外部 Node 参数，验证应用仍能启动离线 worker，再验证实际 PNG 排版、更新和自卸载。不修改真实用户的安装目录或全局快捷方式。它不能代替独立机器验收。

普通启动命令为 `npm start` 或根目录 `Start Agent Math.cmd`。支持 `--quiet`、`--profile <目录>`、`--codex-home <目录>`、`--pause`、`--resume` 和 `--quit`。`--window-title` 与 `--diagnostics` 用于受控测试；诊断状态只包含进程、窗口及覆盖位置，不包含终端正文。自定义 `--profile` 实例需使用同一参数发送退出命令。

UIA 的逐行物理矩形决定绘图位置；TS 快照列号仅用于语义校验，不能作为像素位置。捕获超时、未知焦点或匹配歧义时隐藏；实际选区只隐藏重叠公式。鼠标按下、插入光标与选区事件仅触发刷新。窗口几何、焦点和菜单事件使旧捕获失效，避免沿用错误位置。

.19 的 `UiaRows` 处理 `GetText` 合并软换行、矩形仍按物理行返回的情况：用 `TextUnit.Line` 逐行读取，串接须逐字等于原始快照，矩形也逐行对应；末尾未写入的空白行必须通过剩余文字与数量校验。物理映射仅缓存相同窗格/字体/文字/矩形的一项。行内子串几何按整行文字、字体、窗格、行宽高、横坐标和公式偏移保留，纵坐标从当前物理行取得；这些缓存不提供来源证明。

Form.Visible 不代表覆盖实际位于终端上方。显示已验证的公式时，检查其前方窗口链；若发现所属前台终端在其上方，使用不激活、不移动所属窗口的 SetWindowPos 恢复覆盖顺序。不使用系统置顶。原生回归在点击后枚举真实窗口顺序，截图包含分层窗口，避免仅凭覆盖数量判断显示成功。

worker 返回所有助手候选的来源行区间，包括未匹配的候选。输入导致整屏哈希变化时，宿主逐行核验全部候选、结束边界、候选起始行集合、窗格、颜色和物理矩形。全部一致才可在新结果到达前复用；只比较公式本身不足以复用。仍每两秒刷新会话验证，worker 退出或 UIA 超时即撤下覆盖。`npm run test:windows-core` 编译并运行实际 C# 核验和 worker 生命周期测试，可在无交互桌面的 Windows CI 执行。

宿主最多保留一个未完成的渲染请求，后续快照在当前结果返回后发送，始终核验结果对应的捕获。启动和未完成请求的截止时间为 12 秒，超时标记失败并只重启自己的 worker；匹配证明超过 6 秒先撤下。私有响应核验协议、状态、范围、图片尺寸和数量；退出时避开已阻塞的异步输入。测试通过真实子进程模拟延迟、错误 ID、损坏响应、进程退出和管道阻塞；桌面回归还主动挂起隔离实例的 worker。

公式 em 默认目标为终端行高的 1.3 倍，宽敞区域可提高到 1.7 倍；按宽高约束等比例适配，低于原有可读门槛时保留源码。Codex 压成单行字符的独立公式可在已核验回答内借用紧邻的空白行，上下各最多一行；不跨过正文、其他图片或回答边界，不借用证明末尾的空行。空白行移出视口时使用剩余可见高度重新排版，图片身份按槽位高度缓存。真正的正文行内公式仍限定在原始子串内；不更改终端布局。

保留的 Tabby 原型通过 SessionStore 发现最近路径排序的 160 个候选，每个最多 80 条助手消息；Windows 主线使用完整磁盘偏移索引，不受这两项或旧尾部字节限制。读取不依赖“最新会话就是当前终端”的假设。UIA 不能提供可靠工作目录，因此 Windows 版在候选会话间唯一匹配；完整回答核验全文，长回答的可见片段按下述规则核验，遇到重复内容就保留源码。

0.2.0-preview.4 支持可见段落位于长回答中部：UIA 只在首个非空可见行为两列缩进时，读取前方最多 65536 字符。worker 向前寻找尚未结束的助手标记，核验该标记后的消息开头，再用完整块公式定位来源，分别校验可见片段在来源前缀/后缀中的精确位置。公式外需有至少 24 个文字字符；只有公式、缺少角色标记、用户/工具区域、任意正文或公式差异均不能通过。重复会话仍保留源码。

上下文进入快照身份和 C# 复用校验，变化即撤下旧图。Windows 适配器显式启用局部匹配，保留的 Tabby 路径维持原有完整消息规则。`npm run test:windows-history` 使用自建长回答和实际滚动，验证标记在屏幕外且距离超过 32K 字符时的绘图、局部选择、暂停与恢复、文字/焦点不变，以及用户/工具片段拒绝。可显式传入 `--source-file` 指定本地 JSON 的 `source` 字段以回放历史回答；该数据与截图应保留在忽略目录。

0.2.0-preview.5 将缩进的表格规则线视为助手内容，实际结束标记和列零外层横线仍终止候选。来源文本允许顶层无序列表由 `-` 变为 `•` 的确定性显示形式，块公式、围栏和缩进代码不进行列表转换。UIA 向前移动的是字符单位，可能与 UTF-16 长度不同；读取上限为 128K，超限即退回源码，再仅保留最后 64K，避免漏掉最近角色边界。回放 JSON 可另外提供 `displayed`、`anchor`、`expectedFormulas`、`width` 和 `height`，以验证真实终端排版，而非仅用简化源码生成屏幕。

0.2.0-preview.6 增加简单矩形表格的显示形式：核对全部单元格及顺序，比较时去除装饰性横线，保留原始视口文字及公式位置映射；围栏、缩进代码和块公式不应用表格转换。已知的单行块公式可以匹配 Codex 字符显示，仍显示为 LaTeX 的块按来源顺序单独映射，不再要求原文与视口的块分隔符数量相等。字符形式仍须逐字匹配，不能任意跳过源公式。独立 SVG 使用 adaptor.serializeXML，确保元数据中的 `<` 等字符符合 XML 规则。回放 JSON 还接受 `requiredText` 与 `viewports: [{ anchor, expectedFormulas, requiredText }]`，验证同一真实回答的多个滚动位置。

当前 CI 配置包含类型/核心/浏览器回归、Windows 编译及安装生命周期；桌面键鼠与真实 Codex 用例另行本地运行。工作区结果见 [Windows 验证](windows-validation.md)。

`tests/robustness.test.ts` 对同一回答逐行移动视口、逐字符截断输出，并检查每个完整公式的内容与原始行范围；同时覆盖代码保护、来源篡改、坏公式恢复和大日志。原始用户回答只放在忽略目录中做本地回放。资源上限和支持边界见[鲁棒性说明](robustness.md)。

.8 修复 .7 对完成标记的收紧遗漏时间后缀：`Worked for 6s • 02:31` 是 TUI 边界，不能计入助手正文。TS 候选切分与 C# 复用边界规则必须同步修改并验证。`workerReady` 不能作为某个用户窗口渲染成功的证据；观察仅针对当前前台窗格，需要结合实际覆盖、图像及来源检查。历史回放 JSON 可传 `reportName`（只接受 `windows-history` 加小写字母/数字后缀）保存独立证据。

.10 的 Markdown 呈现推导使用 CommonMark AST，数学临时掩码保留 UTF-16 偏移，再仅清除已解析的标题/强调分隔符；代码与数学原文保持不变，跨行内公式的强调不会被拆断。派生文本缓存限制为 64 项/4 MiB，计入原文键和结果；不缓存来源证明。`scripts/markdown-licenses.mjs` 在两个构建中收集依赖树原始 MIT 许可。

`$$` 的裁切状态必须从同一助手区域的前方上下文恢复，`findCodexVisibleMath` 查询摘要和最终 matcher 共用该状态；不能先对整个裁切视口做无状态 `$$` 配对。简单字符块的 TeX 换行按空白处理，日期完成标记同时修改 TS 和 C#。原生 UIA FindText 需核对返回文本，缺失针不能仅按返回对象非空判断，否则纯 `$$` 视口可能在颜色获取前就失败。

历史回放可提供 `literalBlocks`（从完整显示文本取出的原始完整块）以独立核算各视口的覆盖数量，并用 `minimumLeadingContextChars` 指定该样本的上下文断言。默认长历史测试仍强制超过 32K。fixture 写完正文后落盘 `.ready` 标记，测试待写入和终端处理稳定后才滚动。滚动计时从完成 UIA 文本查找后开始，搜索整个滚动历史的时间另计；研究窗口前台与鼠标事件保持串行，测试期间不对用户标签输入。

## Tabby 原型模块（保留）

- `packages/core`：display math 解析、受限 MathJax SVG 排版、128 项公式缓存。
- `packages/xterm-addon`：只读快照、Unicode/软换行坐标、覆盖层生命周期。
- `packages/adapter-codex`：JSONL 助手消息、有限会话发现、工作目录比较、全文来源验证。
- `packages/tabby-plugin`：Angular 入口、TerminalDecorator、右键菜单、状态轮询。

Tabby 的 `frontend.xterm` 和 `.xterm-screen` DOM 是隔离在适配层中的兼容边界。正式支持固定在已验证版本，升级宿主后先运行回归。没有 fork Codex 或修改 Tabby 安装文件。

## 构建

`npm ci` 使用 lockfile。`npm run build` 输出 CommonJS 插件、浏览器覆盖层、Apache 许可和 `dist/build-report.json`。插件保留 Tabby/Angular 及 Node 内建模块为 external，其余运行依赖随包提供。NewCM 动态字形表通过静态导入在本地预加载；更新字体版本后运行 `node scripts/update-fonts.mjs`，提交生成的导入清单，再验证离线排版。

`.cache/` 保存下载与研究测试缓存，`dist/` 保存可重新生成的构建及发布包，`node_modules/` 保存由 lockfile 安装的依赖；三者均不进入源码仓库。普通用户使用 Releases 中的安装包或完整便携包，依赖已随包提供；开发者克隆后运行 `npm ci`，再按上文构建即可。安装器统一现有父目录的 Windows 长短路径，正确识别目标目录中的运行实例和卸载器自身；遇到目录短暂占用时重试最多 5 秒，持续占用时停止并保留旧应用。`test:windows-package` 使用真实 Windows 目录句柄检查占用路径，并在卷支持时验证 8.3 别名更新及自卸载。

`npm run pack:plugin` 生成本地 tgz，包含 README、许可、引擎和 SVG 字形表，不发布 npm 或远程仓库。安装脚本先复制到非插件名称的临时目录，再移动替换；旧版本保留备份。卸载仅将已验证包名的目录移出发现路径。用户显式传入 Tabby 插件目录，脚本不猜测系统配置位置。

## 调试与测试

`npm run dev:tabby` 使用本项目 portable 宿主，提供本机 CDP 9223 和 `__agentMath` 诊断接口。实际会话测试前，在宿主内照常运行 Codex，得到一个完整的 `\[...\]` 回答。`npm run test:tabby` 检查注册的插件、detach/attach、缓冲区不变、真实自动匹配、宿主右键菜单开关，然后生成忽略的报告/截图。它不向终端写入测试内容，也不自动发起模型请求。

`npm run test:browser` 使用独立双终端接收完全相同的数据，比较全部单元格字符、宽度、颜色模式与样式、光标、缓冲区和滚动位置。输出截图与性能数据在 `test-results/`。当前 P95 扫描/匹配预算为 25 ms，冷 SVG 排版预算为 100 ms；慢速 CI 可显式设置 `AMT_PERF_BUDGET_MS`，所附 Windows CI 配置为 50 ms。远程执行结果见 [GitHub Actions](https://github.com/creDreams/terminal-math-renderer/actions/workflows/verify.yml)。这些是固定样本下的回归门槛，不是全部硬件的交互延迟承诺。

普通启动器 `npm run start:tabby` 不开放调试端口。关闭终端标签页时，插件清理定时器、ResizeObserver、事件订阅与 DOM；PTY 和 Codex 进程的退出仍由 Tabby 管理。

## 数据与依赖

本地会话仅读取 `sessions/` 中符合 rollout 命名的 JSONL，内容不写入 Git，不传出本机。测试 fixture 为合成内容。运行时不需要读取 Codex 认证、配置或数据库。

安装时曾收到 MathJax 开发依赖链的 5 项 moderate audit 报告；最后一次 registry audit 因 TLS 连接中断未能完成，不能声明全量依赖无告警。构建的 esbuild 输入清单确认 `mj-context-menu`、`rimraf`、`glob`、`minimatch`、`speech-rule-engine` 与 `mhchemparser` 均未进入运行包，并对此设置构建断言。后续联网时可重新运行 `npm audit`，不使用破坏性升级来隐藏报告。

公开仓库为 [creDreams/terminal-math-renderer](https://github.com/creDreams/terminal-math-renderer)。发布文件放在 GitHub Releases，源码仓库排除构建、缓存和私人数据；文档图片仅允许经过核对的两张使用前后对比图。
