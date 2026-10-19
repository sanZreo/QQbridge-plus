# 仓库目录地图（FOLDER_MAP）

> 一句话说明每个顶层目录干什么、`scripts/` 里的命名约定是什么、哪些脚本像是过期的一次性产物。
> 本文**只描述现状**，不构成改动指令。文档索引见 [README.md](README.md)。
>
> 最后核对：2026-10-16（复核脚本计数、四个空前缀、`docs/` 实际内容——这三处此前都与磁盘不符）。新增目录/脚本时请顺手补一行。

---

## 一、顶层布局

```
DSH/                         ← 工作区根（不是仓库根）
├── qq-bridge/               ← 本仓库（QQ ↔ DSH 桥接）
├── voice-tool/              ← 独立「发语音」工具（从 qq-bridge 拆出；不依赖桥接运行）
├── 发语音-图形界面.cmd      ← 工作区根的双击启动器 → 进 voice-tool/ 起图形界面
└── 重启DSH-加载语音工具.cmd  ← 工作区根的运维启动器（重启 DSH 让 MCP 工具重新挂载）
```

`qq-bridge/` 内部：

| 目录 | 作用 | 能不能删/动 |
| --- | --- | --- |
| `src/` | **桥接内核**：主程序、DSH 客户端、三个 MCP server、黑话/表情/语音共享库 | 不能动。`bridge.js` 是主程序（约 10,400 行，QSH 计划拆分）；`voice-core.js` 与 `snowluma-conn.js` 是**独立工具也在用的单一实现**。**目录里只应有 `.js`**：曾经的 `bridge.js.bak-*` 会污染全局搜索并看起来像 module，2026-09-20 已移出（见下） |
| `scripts/` | 调试 / 测试 / 一次性运维脚本（见第二节命名约定） | 测试脚本不能删；`cleanup-*` / `fix-*` / `patch-*` / `diag-*` 多为历史遗留 |
| `dsh/` | 要装进 DSH 的东西：`agent-presets/qq-chat`、`agent-presets/qq-chat-v2`（preset 的**权威源**，含工具白名单 `qq-tool-restrict.mjs` 的 re-export 壳）。DSH 0.1.7 起 preset 以 bundle patch 形式安装，patch 由 `scripts/build-agent-preset-patches.mjs` 从这里的源生成到 `plugins/qq-agent-presets/presets/` | 改 preset 会影响所有人设行为；改完必须重新生成 patch |
| `plugins/` | DSH 插件：`qq-mode-console`（暴露 `qq-mode` 设置命名空间；**只有 host 半**，浏览器 UI 卡片未实现）、`qq-agent-presets`（生成两个 preset 行 + 携带唯一的 `qq-tool-restrict` 权威实现） | 改了要重装/重启 DSH |
| `public/` | 浏览器静态资源：`console.html`（桥接自带控制台，127.0.0.1:3100） | 目录里只应有这一个文件；历史备份 `console.html.bak` 已移出仓库 |
| `roles/` | 人格卡（`小鲸鱼.md` / `傲娇助手.md` / `README.md`）：控制台「人格与角色」页可编辑，保存即生效 | 用户内容，别乱动 |
| `assets/` | 仓库用图片等资源（`deepseek娘.png`；`project-intro.mp4` 已改为 Release 附件、不入库） | 别加体积大的二进制 |
| `audio/` | **语音库**（用户的真实音频）。桥接的 AI 语音工具只能发这里的文件；独立 `voice-tool` 默认也指向这里 | **用户文件，绝不删除/移动** |
| `state/` | **运行时数据**（会话映射、模式、角色、黑话库、日志、锁、令牌）。`.gitignore` 排除 | **用户数据，绝不删除/移动** |
| `docs/` | 全部文档，按用途分子目录（见第三节） | 见第三节 |
| `node_modules/` `.npm-cache/` | 依赖与 npm 缓存 | 忽略 |
| `config.json` | 运行配置（真实配置**不入库**）；模板是 `config.example.json` | 值属于用户，别改 |

---

## 二、`scripts/` 命名约定

脚本共 **86 个文件**（**83 个 `.mjs`** + **3 个 JSON 基线**：`console-ui-contracts.json`、`console-ui-legacy-ids.json`、`privacy-rules.example.json`；另有 `fixtures/` 目录 1 个文件）。按前缀区分用途：

| 前缀 / 形态 | 含义 | 归宿 |
| --- | --- | --- |
| `test-*.mjs` | **自动化测试**。其中被 `scripts/test-audit.mjs` 列进 `tests[]` 的那些会跑在 `npm run test:audit` 里（离线、不发真 QQ 消息、不用生产凭据） | 保留，改动需同步 test-audit 清单 |
| `test-dsh-*.mjs` | **需要活的 DSH**（不在 `test:audit` 里）：`test-dsh-auth.mjs`（鉴权链路）、`test-dsh-inbox-projection.mjs`（会话队列投影解析，离线）、`test-dsh-session-retire.mjs`（退役会话的端到端回归）、`test-dsh-v2-wait.mjs`（preset 工具面） | 保留（改 DSH 契约时必须跑） |
| `test-audit-*.mjs` | test-audit 的子模块（`test-audit-bridge` / `-protocol` / `-security` / `-setup` 及其 `-helpers`/`-guards`），被上一个直接运行 | 保留 |
| `test-console-ui.mjs` + `console-ui-*.json` / `console-ui-fixture.mjs` / `fixtures/` | 控制台**离线浏览器回归**与基线（`npm run test:console-ui` / `npm run preview:console`），说明见 [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 保留（基线只在后端契约真变时才重录） |
| `send-*.mjs` | 面向 SnowLuma/QQ 的**真发送**小工具（`send-voice.mjs` 走桥接；`send-test-group.mjs` 发测试群） | 保留，但注意会真的发消息 |
| `setup-*.mjs` | **安装/初始化**：把 preset、MCP 挂载写进目标设备的 DSH（`setup-dsh.mjs`，幂等） | 保留 |
| `verify-*.mjs` | **一致性校验**：`verify-dsh-020-adaptation.mjs`（DSH 适配；`npm run verify:adaptation`）、`verify-persona-config.mjs`（人格配置） | 保留 |
| `probe-*.mjs` | **探针**：用来问 DSH/SnowLuma「实际支持什么」（RPC 形状、工具清单、事件流、工作区、模型、协议帧、settings 命名空间）。鉴权统一走 `probe-auth.mjs` | 保留，按需重跑 |
| `probe-020-protocol.mjs` / `probe-020-settings.mjs` | 0.2.0 版探针：前者采样 `session/control` baseline、`session/projections`、`session/follow`、`$events`、`session/cancel` 的**原始帧结构**；后者列 settings 命名空间并**幂等写回**验证 `qq-mode` 可写。控制台「改模式不生效」时的第一手诊断 | 保留（`npm run probe:protocol` / `probe:settings`） |
| `scan-dsh-tool-names.mjs` + `dsh-tool-names.mjs` | **工具名对账**：从已安装的 DSH 包里抽真实工具名，与 QQ 守卫的 restrict 名单双向求差（防拼错假名静默失效 / 防新版本新增能力漏隐藏）。抽取实现只有 `dsh-tool-names.mjs` 一份，`test-preset-local-tools.mjs` 与 `scan-dsh-tool-names.mjs` 共用 | 保留（每次升级 DSH 后跑一次） |
| `probe-snowluma-heartbeat.mjs` | 只读探针：连 SnowLuma 的 OneBot WS，等一个 `meta_event/heartbeat`，打印载荷里的 `status.online` / **`status.good`**。桥接的上游健康主信号就是这个字段——它存不存在、拼写对不对只能拿**真实运行时**验证（SDK 不校验 data 载荷，取错字段不会报错）。不发消息、不建会话 | 保留（`npm run probe:heartbeat`） |
| `voice-tool-locator.mjs` | 「发语音」独立工具（在仓库上一级 `../voice-tool/`）的位置解析 + 「它不在本仓库」时的统一跳过口径；支持 `QQ_BRIDGE_VOICE_TOOL_DIR` 覆盖 | 保留（被 6 个测试引用） |
| `audit-bridge-harness.mjs` | 虚拟网关 + 沙箱化的桥接行为审计脚手架（被 `test-audit-bridge.mjs` 使用） | 保留 |
| `harden-state-acl.mjs` | 收紧 `state/` 目录权限（Windows 上 `mode 0o600` 是空操作，必须动 ACL）。直接试 → 失败提权重试 → 仍失败则打印可复制命令；**任何路径都以 0 退出，绝不阻断启动**。被 `start.bat` 调用 | 保留（`start.bat` 依赖） |
| `diagnose-acl.mjs` | 只读盘点：列出仓库里所有被**切断 ACL 继承**的路径，分「有意收紧（`state/`、`config.json`）」与「非预期收紧」两类，并对后者打印恢复继承的命令。背景见 [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) §2.6：DSH 沙箱的写权限只靠继承下发能力 SID，切断继承 ⇒ 沙箱里写不进去。**必须在无沙箱终端跑**（沙箱禁止以管道 stdio 拉起 icacls） | 保留（`npm run diagnose:acl`） |
| `dsh-modules.mjs` | 小工具：按路径加载 DSH 安装内的模块；并负责**发现**可用的 DSH 工具包数据源（目录 → 打包版 `app.asar` → 都没有才跳过） | 保留 |
| `asar-read.mjs` | 纯 Node 读 Electron 打包版 `app.asar`（不落盘、不依赖 Electron）：头解析 + 按条目读字节（越界即抛）+ `unpacked` 条目走磁盘副本 + **身份探针**（要求 `dsh-persona` 与 ≥50 个 `dsh-*` 包，防误命中别的 Electron 应用）。让「工具名对账」这条安全断言在打包版 DSH 上也能真跑 | 保留（被 `dsh-tool-names.mjs` 与 `test-asar-read.mjs` 引用） |
| `member-signals-report.mjs` | 三代阶段 0 的**离线取证**：直接读 `state/social-v2.json`，用 `src/member-signals.js` 算出每个会话里"桥接派生的真实互动排名"，并与 AI 自述的 `memberImpressions` 对照（榜上重合 / 同位 / **漏看** / **过度关注**）。**为什么要有它**：桥接内那个只读端点要重启 bridge 才能用，而验收证据不该等重启；两边复用同一模块，结果必然一致。`--json` 给机器读，传 `key` 只看单个会话。注意它**如实标注** `recentMessages` 被 `recentLimit=100` 截断时的真实覆盖时长 | 保留（三代关系信号的验收工具） |
| `test-member-signals.mjs` | 三代关系信号（`src/member-signals.js`）的 16 条纯函数断言：**双向信号**的定义（引用我 / 我发言后 3 分钟内接话）、互斥计数、7 天窗口边界、分档门槛、纯函数不改 state、以及对照指标的口径（含私聊 `私聊` 字面量与 `管理员` 别名的匹配）。已注册进 `test-audit.mjs` | 保留 |
| `src/member-signals.js`（模块） | 三代第一根支柱的**唯一实现**：`deriveMemberSignals()` 从 `recentMessages` **派生**关系信号。刻意**零持久化**（`loadSocialV2State` 是逐字段白名单，新字段漏加会静默丢数据）；`compareWithImpressions()` 负责与 AI 自述印象对照 | 保留 |
| `embed-console-brand.mjs` | 把品牌图内嵌进 `public/console.html`，**一次管三个位置**：控制台图标（运行时插 `<link rel="icon">`/`apple-touch-icon`）、**顶栏品牌标**（运行时把原来的文字标 `q↗` 换成 Q 版形象 `<img>`，所以不用改静态 HTML；图片 `error` 时**退回文字标**而不是裂图）、**背景图**（`--brand-bg` + `body::before`）。幂等（靠 `brand-assets:start/end` 定位替换）、写入前自动备份、写完自检、`--remove` 可整体还原。**为什么内嵌而不是放静态文件**：`bridge.js` 没有通用静态路由、`/favicon.ico` 被有意 204 掉（避免 401 噪音）、离线预览夹具只喂 HTML 字符串。⚠️ **依赖服务端 CSP 放行 `img-src 'self' data:`**（`src/bridge.js` 的 `SECURITY_HEADERS` 已补上；漏了会被浏览器直接拒绝，表现为裂图/背景不显示，而"文件写对、HTTP 内容一致、sha 对得上"这些验证**都发现不了**），且**改完 CSP 必须重启桥接**。⚠️ 背景要用**抠掉白底**的透明图 + `contain`/右下站位 —— 白底立绘用 `cover` 会只露出最上面的空白，浅色主题下等于看不见。成品默认放 `assets/brand/`（可用 `--icon`/`--bg` 覆盖） | 保留（要换控制台图标/品牌标/背景就跑它） |
| `check-onebot-status.mjs` | 手工排查：查 OneBot 连通性 | 保留（运维常用） |
| `patch-*.mjs` | **补丁**（含 `postinstall` 的 `patch-snowluma-sdk.mjs`：修 `@snowluma/sdk` 的 ESM 打包 bug） | `patch-snowluma-sdk.mjs` **必须保留**（postinstall 依赖）；其余见第四节 |
| `cleanup-*.mjs` | **清理一次性残留**（probe 会话/工作区、测试会话） | ⚠️ **2026-10-16 核对：当前一个文件都没有**（第四节列的那几个已不在磁盘上） |
| `fix-*.mjs` | **一次性修复**（针对某次运行产生的脏数据） | ⚠️ **当前为空**（同上） |
| `diag-*.mjs` | **诊断**（如归档并清理日志） | ⚠️ **当前为空**（诊断类现由 `diagnose-acl.mjs` 承担，见上表） |
| `debug-*.mjs` | **调试**（如白名单逻辑对照） | ⚠️ **当前为空**（与 `test-audit-*` 的白名单用例重复，已清掉） |
| `CONSOLE-UI-TESTING.md` | 已移到 [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | — |

---

## 三、`docs/` 结构（**2026-10-16 按磁盘实测重写**）

```
docs/
├── README.md     # 文档索引（每篇一句话 + 是否仍然有效 + 哪些文件其实不存在）  ← 先看这个
├── FOLDER_MAP.md # 本文件
├── guides/       # 面向使用者/运维，本机 6 篇：
│                 #   DSH_SETUP / DSH_020_ADAPTATION / SECURITY_BASELINE
│                 #   TOKEN_USAGE_CONSOLE / CONSOLE-UI-TESTING / PRIVACY
└── audits/       # 本地审查报告，本机 2 篇（2026-10-16 新增）：
                  #   AUDIT_TEST_HARNESS_2026-10-16（测试基座）
                  #   AUDIT_ASAR_TOOLNAMES_2026-10-16（打包版 asar 读取）
```

> ⚠️ **`design/`、`research/`、`legacy/` 三个目录在本工作树里并不存在**，
> `guides/PROJECT_GUIDE.md` 与 `guides/VOICE.md` 也没有。
> 机制在 `.gitignore` 第 52–64 行：这批文档里扫出过多份含本机真实路径的内容，被**整体排除**；
> 上游作者本机曾有，本工作树没有保留。
> 也就是说 `docs/README.md` 索引里指向它们的链接**在这台机器上也是死链**（不只是"对公开读者"）。
> 因此：**要公开的新文档请放 `docs/guides/`**；放 `docs/audits/` = 只在本机可见（`git add` 会被 .gitignore 挡下）。
>
> 核对办法（别靠索引，直接数）：
>
> ```powershell
> Get-ChildItem docs -Recurse -File | Select-Object -ExpandProperty FullName
> ```

规则：**根目录只留 `README.md` / `README.en.md` / `RULES.md` 三个文档**，其余一律进 `docs/` 对应子目录，
并在 [README.md](README.md) 索引里登记一行（含「仍然有效 / 被谁取代」）。

---

## 四、一次性脚本：**已在 2026-10-16 核对，磁盘上都没有了**

> 本节原先列了一批「疑似过期的一次性脚本（未删除，待确认）」。**2026-10-16 逐个核对：它们一个都不在
> `scripts/` 里了** —— 也就是说当年那个「待人工确认」的悬案已经了结，`cleanup-*` / `fix-*` / `diag-*` /
> `debug-*` 四个前缀现在**都是空的**（见第二节）。为免有人照旧索引去 `scripts/legacy/` 找，把当年点过名的
> 清单留在这里作追溯（**都不要再去找**）：
>
> `cleanup-probe-sessions.mjs`、`cleanup-probe-workspaces.mjs`、`cleanup-test-sessions.mjs`、
> `fix-probe-workspace-title.mjs`、`diag-archive.mjs`、`debug-whitelist.mjs`、
> `patch-qq-chat-v2-presleep.mjs`、`patch-qq-chat-v2-stickers.mjs`、
> `patch-qq-chat-v2-collect-memory.mjs`、`patch-web-mcp-timeout.mjs`、`probe-015.mjs`。
> （判定依据仍然是 `.gitignore` 里那条「Local one-off dev/debug/patch scripts（machine-specific
> paths/IDs, or bound to artifacts of a single probe run under `state/`）」。）
>
> 当时另外点过名的两批**保留至今，属正常成员**：
> - `probe-rpc-compat.mjs` / `probe-models.mjs` / `probe-workspace.mjs` / `probe-events.mjs` / `probe-tools.mjs`
>   —— 协议/能力探针，鉴权统一走 `probe-auth.mjs` 的离线铸造 Cookie（旧的「从 guard 日志抓 launch token」
>   在 DSH 0.1.7 起一律 401），挂在 `npm run probe:*` 上按需重跑；
> - `test-onebot-connection.mjs` / `test-mcp-*.mjs` —— **不在** `test-audit.mjs` 清单里，属手工排查脚本，
>   功能上被 `check-onebot-status.mjs` / `test-audit-security-mcp.mjs` 覆盖。

**下面这些千万别当"过期脚本"清掉**：

- `scripts/patch-snowluma-sdk.mjs`（`postinstall` 依赖，删了 `npm install` 就坏）
- `scripts/test-audit.mjs` 清单里的每一个（**当前 33 个**，完整清单见该文件 `tests[]` 数组）
- `scripts/console-ui-contracts.json` / `console-ui-legacy-ids.json` / `console-ui-fixture.mjs` / `fixtures/`（控制台回归基线）
- `scripts/audit-bridge-harness.mjs`、`scripts/dsh-modules.mjs`、`scripts/dsh-tool-names.mjs`、`scripts/voice-tool-locator.mjs`
- `scripts/asar-read.mjs`（打包版工具包读取器，被抽取器与 `test-asar-read.mjs` 引用）

---

## 五、独立工具 `voice-tool/`（不在本仓库内）

| 路径 | 作用 |
| --- | --- |
| `voice-tool/voice-cli.mjs` | 命令行：交互菜单 / `send` / `list` / `check` / `remove` / `status` |
| `voice-tool/voice-gui.mjs` | 图形界面：只监听 127.0.0.1 的本地小服务 + 一次性令牌 + 浏览器 UI |
| `voice-tool/public/voice.html` | 图形界面前端（拖拽上传、试听、音量、发送、历史） |
| `voice-tool/发语音.cmd` | 命令行启动器（纯 ASCII，双击即用） |
| `voice-tool/config.json` | 工具自己的配置（**可选**）。本机显式把 `voice.voiceDir` 指向 `../qq-bridge/audio`，让已有音频继续可见 |
| `voice-tool/config.example.json` | 配置模板 |
| `voice-tool/state/` | 运行时：`voice-gui-url.txt`（当前界面地址 + 一次性令牌） |

共享内核**不复制**：工具经 `../qq-bridge/src/voice-core.js` 与 `../qq-bridge/src/snowluma-conn.js`
引同一份实现（qq-bridge 里的 `src/send-voice-lib.js` 也是转发这同一份）。
