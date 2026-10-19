# 文档索引（docs/README.md）

> 根目录只留 `README.md` / `README.en.md` / `RULES.md` 三个文档，其余全部在本目录下。
> 仓库目录结构与 `scripts/` 命名约定见 **[FOLDER_MAP.md](FOLDER_MAP.md)**。
>
> **状态标记**：✅ 仍然有效（按它做就对） · ⚠️ 部分过时（见备注） · 🗄️ 已被取代（保留作背景） ·
> ⛔ **本工作树里没有这个文件**（只在上游作者本机或早已删除；点开会是死链）

---

## ⚠️ 先看这条：本工作树里真正存在的文档

```
docs/README.md            ← 本文件
docs/FOLDER_MAP.md
docs/guides/              CONSOLE-UI-TESTING.md · DSH_020_ADAPTATION.md · DSH_SETUP.md
                          PRIVACY.md · SECURITY_BASELINE.md · TOKEN_USAGE_CONSOLE.md
docs/audits/              AUDIT_ASAR_TOOLNAMES_2026-10-16.md · AUDIT_TEST_HARNESS_2026-10-16.md
```

下面索引里带 ⛔ 的条目（`design/` `research/` `legacy/` 三个目录、`guides/PROJECT_GUIDE.md`、
`guides/VOICE.md`、以及多篇 `audits/`）**在本机磁盘上并不存在**。原因见
[FOLDER_MAP.md](FOLDER_MAP.md) 第三节：`.gitignore` 第 52–64 行把这几处整体排除，
作者本机曾有、本工作树没有保留。**要核对，直接数目录**：

```powershell
Get-ChildItem docs -Recurse -File | Select-Object -ExpandProperty FullName
```

---

## guides/ —— 面向使用者 / 运维

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [guides/PROJECT_GUIDE.md](guides/PROJECT_GUIDE.md) | **权威项目说明书**（113 KB / 1450+ 行）：架构、内外核划分、数据流、配置全解、安全机制、调试与改进指南 | ⛔ 本工作树没有。想看整体架构，改用根目录 `README.md` + `docs/guides/DSH_020_ADAPTATION.md` |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | DSH 端安装说明：`qq-chat` / `qq-chat-v2` preset 与三个 MCP server 怎么挂到目标设备的 DSH 上 | ✅ |
| [guides/VOICE.md](guides/VOICE.md) | 语音发送全解：独立工具（`voice-tool/`）、桥接 CLI、AI 工具、控制台面板，以及工具拆出后的配置解析顺序 | ⛔ 本工作树没有（`docs/guides/VOICE.md` 已被 `.gitignore` 排除）。语音实现看 `src/voice-core.js` 与根 `README.md` 的「已知限制」 |
| [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) | 控制台「令牌与花费」看板：数据来源、计价口径（峰谷分时）、API、配置 | ✅ |
| [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台离线预览（`npm run preview:console`）与离线浏览器回归（`npm run test:console-ui`）怎么用 | ✅ 2026 整理时自 `scripts/` 移入 |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | **安全基线与威胁模型**：威胁主体、已实现的边界（准入/工具面/出站/控制台/落盘/网络）、已知残余风险、发布前回归清单、改动检查单 | ✅ **改动安全相关代码前必读** |
| [guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) | **DSH 0.2.0 适配改动记录**（v0.1.7 → v0.2.0）：逐条列出为适配 0.2.0-rc.2 做的改动（现象/为什么必须改/证据/怎么验证），并单列「复核后判定兼容、因此没改」的部分 | ✅ **升级 DSH 前先读 §10 的操作清单**（放在 `guides/` 是因为 `audits/`、`design/`、`legacy/`、`research/` 都在 `.gitignore` 里，放进那几处的文档不会进公开仓库） |
| [guides/PRIVACY.md](guides/PRIVACY.md) | 发布前隐私检查：`privacy-scan.mjs` 的跑法、内置规则、判读命中的三种处理、CI 用法 | ✅ |

## design/ —— 设计与规划（读设计意图用）⛔ 整个目录本工作树不存在

> 下面四条只保留**索引信息**（上游曾收录这几个文件的说明），点开都是死链；`docs/design/` 在本机不存在。

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| `design/GEN2_SIMULATION_PLAN.md` | 二代仿真（`reserved2`）「一切皆工具」实施计划：WakeConfig 唤醒调度、MCP 工具集、控制台参数、`qq-chat-v2` preset | ⛔ 现状以代码与 `qq-chat-v2/agent.cordis.yml` 为准 |
| `design/SOCIAL_MODE_PLAN.md` | 一代仿真（`reserved`）的头脑风暴定案：规则引擎管「何时说」、LLM 管「说什么」 | ⛔ |
| `design/DSH_QQ_TOOLS_PLAN.md` | 「一切皆工具」总路线与交接文档：能力盘点、安全性设计、分阶段计划 | ⛔ |
| `design/真人语感策略.md` | 拟人化策略：短句碎片、接梗、错别字、话题漂移、选择性沉默 | ⛔ 现行策略写在 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 的行为章节里 |

## research/ —— 调研记录 ⛔ 整个目录本工作树不存在

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| `research/SnowLuma功能调研.md` | SnowLuma 除「OneBot WS + 基础收发」之外还有哪些 QQ 相关功能与机制 | ⛔ 现查 `snowluma/config-ClrCrmAk.js` 的 `defineAction`（135 个）最准 |
| `research/RESEARCH_QQ_MESSAGE_DND.md` | QQ 群「消息免打扰」影响不影响 SnowLuma 收发 —— 结论：不影响，只是不提醒 | ⛔ |
| `research/RESEARCH_SNOWLUMA_EMOJI_STICKER.md` | SnowLuma 的表情包/收藏表情能力（`fetch_custom_face*` 等） | ⛔ |
| `research/LOCAL_MODEL_SIZING.md` | 若要本地复刻：对模型的真实负载、显存门槛 | ⛔ |

## audits/ —— 审查 / 体检 / 优化报告（按时间读，越新越权威）

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [audits/AUDIT_ASAR_TOOLNAMES_2026-10-16.md](audits/AUDIT_ASAR_TOOLNAMES_2026-10-16.md) | **让「防假名」安全断言在打包版 DSH 上真跑**：新增纯 Node 的 `app.asar` 读取（上界校验 / unpacked 磁盘回退 / 身份探针）、抽取器接入 asar 数据源并保持唯一实现、测试三级降级 + `NOT_INSTALLED_SOURCES` 自清理登记、离线合成 asar 回归。含 3 个模型的实现前评审与逐条采纳/不采纳 | ✅ **最新**（33/33，工具名对账真跑 220ms）⚠️ 不在公开仓库里（`docs/audits/` 被 `.gitignore` 排除） |
| [audits/AUDIT_TEST_HARNESS_2026-10-16.md](audits/AUDIT_TEST_HARNESS_2026-10-16.md) | **测试基座体检**：把「跳过」从「通过」里拆出来（套件汇总点名 + `QQ_BRIDGE_AUDIT_STRICT_SKIPS=1`→exit 3）、修掉假绿/崩溃/死跳过分支，并顺带修了 `setup-dsh` 幂等判据过严的产品 bug；含 3 个 WorkBuddy 模型的独立审查结论与未采纳项 | ✅（本机 28/32 → 32/32）⚠️ 同上，不在公开仓库里 |

其它在上游索引里出现过、**本工作树已不存在**的审计文档（点开是死链）：
`AUDIT_FIXES_2026-09-20.md`（那一轮三路并行审计与修复记录，结论已并入下文两份）、
`CODE_AUDIT_2026-09-20.md`（同日代码体检，多数已修）、
`AUDIT_REPORT_2026-09-20.md`（全项目体检，四条独立审计线）、
`CONSOLE_FEATURES_REPORT.md`（控制台功能增强：人格管理、两层提示词、思考强度）、
`CONSOLE_UI_REDESIGN_REPORT.md`（控制台改版：九页导航 + 全局搜索 + 双主题；现已 10 页）、
`TOKEN_OPTIMIZATION.md`（`reserved2` 的 token 开销优化与消息水位协议）、
`TOKEN_COST_ANALYSIS.md`（token 成本实测档案）。

## legacy/ —— 历史归档（**不要照着做**）⛔ 整个目录本工作树不存在

| 文档 | 一句话说明 | 为什么归档 |
| --- | --- | --- |
| `legacy/PROJECT_GUIDE.public-condensed.md` | 面向公开仓库的精简版项目说明书 | 🗄️ 被 `guides/PROJECT_GUIDE.md` 取代（而后者本工作树也没有） |
| `legacy/AUDIT_REPORT_2026-09-18.md` | 2026-09-18 的架构审查与修复报告 | 🗄️ 被 `audits/AUDIT_REPORT_2026-09-20.md` 取代 |
| `legacy/ARCH_REVIEW.md` | 2026-08-18 的架构审查：严重 #1~#6、中等 #7~#15、轻微 #16~#20、新增 #21~#30 | 🗄️ 问题已全部修复，属已结案的历史记录 |

---

## 想找什么 → 去哪看（链接已按「本工作树实际存在」修正）

| 我想…… | 看这个 |
| --- | --- |
| 搞懂整体架构 / 全部配置项 | 根目录 [README.md](../README.md)（架构、配置表、启动流程）+ [guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) |
| 在新设备上把 qq-bridge 接进 DSH | [guides/DSH_SETUP.md](guides/DSH_SETUP.md) |
| 看 AI 烧了多少钱 / 计价口径 | [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) |
| 改控制台界面并做离线回归 | [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) |
| 改代码前先知道有哪些坑 | [guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md)、[audits/AUDIT_TEST_HARNESS_2026-10-16.md](audits/AUDIT_TEST_HARNESS_2026-10-16.md)、[audits/AUDIT_ASAR_TOOLNAMES_2026-10-16.md](audits/AUDIT_ASAR_TOOLNAMES_2026-10-16.md) |
| 动安全相关代码 / 做发布前检查 | [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md)、[guides/PRIVACY.md](guides/PRIVACY.md) |
| 知道某个目录/脚本是干什么的 | [FOLDER_MAP.md](FOLDER_MAP.md) |
| 权限边界与安全承诺 | [../RULES.md](../RULES.md) |
| 发语音 / 换 QQ 账号后语音工具 401 | 根目录 [README.md](../README.md) 的「已知限制」+ `src/voice-core.js`、`src/snowluma-conn.js`（`guides/VOICE.md` 本工作树没有） |
| 这个项目要往哪走（QSH） | ⛔ 上游提到的上位目录 `../../QSH-plan/` 在本机也不存在（`E:\QSH-plan` 无此目录） |
