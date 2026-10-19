# QQbridge-plus

**QQ 群聊 AI 桥接 + 黑话知识库分析流水线**

让 AI 以「群友」身份参与 QQ 群聊——自己判断要不要说话、说什么、说多少；配套一条离线的黑话词库分析流水线，把群聊语料变成 LLM 可直接消费的术语知识包。

> 本仓库 = **qq-bridge**（仓库根目录，桥接主体）+ **heihua-lab**（`heihua-lab/`，离线黑话分析）。
> 上游项目说明见 [README.qq-bridge.md](README.qq-bridge.md)；权限边界见 [RULES.md](RULES.md)；文档索引见 [docs/README.md](docs/README.md)。

```
QQ ──OneBot v11──► qq-bridge ──► DSH / LLM ──► 回复
                      │                  ▲
                      │                  │  【群聊黑话表】相关性命中 + 群作用域，≤8 条
                      ├── state/slang.json
                      │        ▲
                      │        │ 人工确认（控制台，唯一闸门）
                      │   heihua-lab 产出的候选（带证据，永不直接 confirmed）
                      └── 本地控制台 :3100
```

---

# 一、qq-bridge 完整功能

适配基线：**DSH 0.2.0-rc.2**（`npm run verify:adaptation` 逐项实测）、Node ≥ 22.13、SnowLuma OneBot v11。

## 1. 消息通道与协议适配

| 能力 | 说明 |
| --- | --- |
| OneBot v11 WebSocket | 基于 `@snowluma/sdk` 的 `SnowLumaWebSocketClient`，断线自动重连 |
| Token 自愈 | HTTP token 与 WS token 是**两个不同值**；首次 WS 连接常 1006 失败，桥接自动重新发现 WS token 并重连（这是正常序列，不是故障） |
| 端点自发现 | 换 QQ 账号后端口/token 会变，桥接重新发现并写回 `config.json`；`snowluma.followDiscoveredEndpoint=false` 时只自愈 token、不动 URL（多账号/第二实例场景） |
| DSH Cookie 鉴权 | 用 `~/.dsh/.credentials.yaml` 的持久化签名密钥**离线铸造**会话 Cookie，不依赖进程期 launch token |
| 斜杠 RPC + 事件流 | `/api/<namespace>/<method>` 与 `/api/remote.mux` + `session/follow`；队列读取以一元 `session/projections` 为主路径、`projections[<id>].values.inbox` 为回退形状 |
| 会话映射 | 每个 QQ 会话（私聊/群）↔ 一个独立 DSH 会话，统一归组到「QQ 聊天」工作区，映射持久化于 `state/sessions.json`；模式或 preset 变化会自动重建会话，避免沿用旧权限 |
| 断线排队 | 每 5 秒探活 DSH；不可用期间收到的消息在进程内排队（50 条/会话，满后丢最旧），恢复后补投 |
| 单实例锁 | 同一时间只允许一个桥接实例，重复启动被拒绝 |

## 2. 四种运行模式（权限边界即模式）

| 模式 | 谁能触发 | 能力边界 |
| --- | --- | --- |
| `chat` | 白名单群 + 白名单私聊 | 使用 `qq-chat` 安全聊天 preset，**无** bash/文件工具 |
| `closed-agent` | **仅 owner 私聊**（`config.json` 的 `ownerQQ`） | 完整工具，可在 QQ 上操控 DSH；preset 可在控制台改为任意 DSH preset（默认 `standard`） |
| `reserved`（一代仿真） | 白名单群 | 仿真群友：观望/活跃/试探/退场状态机，选择性参与、空格分句、`[SILENT]` 潜水、主动收尾 |
| `reserved2`（二代仿真，`setup-dsh.mjs` 后默认） | 白名单群 | 文本不自动转发；AI 通过 `qq_get_unread_messages` / `qq_send_message` 等工具**自主**看消息、发言、等待、设置唤醒/潜水，使用 `qq-chat-v2` preset |

- 白名单/黑名单（黑名单优先）；示例配置**默认空白名单 + fail-closed**——不填就谁都不回。
- 模式切换在控制台一键完成，同时写入 DSH 设置与本地 `state/mode.json` 兜底，即时生效。
- 会话拿不到 `qq-chat` preset 时桥接**拒绝建会话**（绝不回退到带 bash/文件工具的默认 preset）。

## 3. 群聊参与能力

**一代仿真（`reserved`）**
- 状态机式参与：观望 → 活跃 → 试探 → 退场，避免一直刷屏或一直沉默。
- 空格分句：AI 用空格表示拆成多条消息；`[SILENT]` 表示潜水不发送。
- 主动收尾：话题结束时会收束，而不是无限续聊。

**二代仿真（`reserved2`）**
- 工具化：AI 自己查未读、自己发、自己等（`qq_wait_for_messages`）、自己调唤醒策略（`qq_set_wake_config`）、自己标记已读（`qq_mark_read`）。
- 唤醒快照：被唤醒时附带「本轮消息快照 + readThroughSeq 水位」，避免重复查询与重复回复。
- 主动轮：按活跃度与关系档位决定是否主动开口；有**过时闸门**，迟到的回复不会硬发。
- 引用语义：群聊引用解析成「被引用人 + 原文」注入（如 `[引用 某某：原文]我的回复`），AI 能判断这句话对谁说；**引用机器人自己时视为必回**。AI 也可用 `qq_reply` / `replyToMessageId` 主动引用具体消息。
- 分段发送：超过 `socialV2.send.maxMessageChars`（默认 500 字，可用 `social.maxReplyChars` 调整）按句读/URL 边界自动分段；`qq_send_message` 支持数组一次发多条。

## 4. 社交记忆与关系（二代）

| 能力 | 说明 |
| --- | --- |
| 关系档案 | 由真实互动派生（双向消息数、天数、最近互动），只给**档位**不给数字，不暴露量化评分 |
| 档位粘滞 | 降档有 72h 保护（`applyTierHysteresis`），避免同一个人三天内从「熟」掉到「新」导致忽冷忽热；升档立即生效 |
| 轻量话题记忆 | `activeTopics`：24h 内全留、24h~7d 只留带 `pendingQuestion` 的、>7d 清理；上限 50；每条带 **`sourceRef` 出处锚点**（谁、原文片段、时间），控制台可校验「出处还能不能在窗口里找到」 |
| 待办思绪 / 群友印象 | `pendingThoughts`（带过期时间）、`memberImpressions`（按群友名的短印象） |
| 记忆工具 | `qq_memory_append` / `qq_memory_query` / `qq_memory_remove` / `qq_memory_clear`，AI 自己读写自己的记忆 |
| 数据隔离 | 所有状态按会话 key 隔离（`group:<id>` / `private:<id>`），A 群的记忆不会出现在 B 群 |

## 5. 黑话学习（本项目重点扩展）

**运行时（桥接侧）**
- **提取**：DSH learner 会话从近期群聊里提取疑似黑话候选（排除人名/@/表情/功能词，带上下文证据）。
- **研究**：候选交给 DSH agent 做深度联网考究（`web_search` + `web_fetch` 正文），产出含义/用法/例句/来源/风险与 `confirmed` 判定；按 `RESEARCH_BATCH_SIZE=5` 切批，避免长批次超时导致「一条都没写回」。
- **注入**：`buildSlangContextFor(key, entries, max, recentMessages)`
  - ① **相关性**：被当前消息窗口命中的词排前（content 与 aliases 都参与匹配）；
  - ② **群作用域**：`scope=general` 的通用词 + `scope=group:<id>` 的本群词；他群词汇**永不**注入；
  - ③ **截断**：`slang.injectMax`（默认 8 条）；
  - ④ **回退**：无任何命中时退回「本群 + 通用按次数排序」，与改造前行为一致（不退化）。
- **别名**：`aliases` 字段让「yyds」与「永远的神」、「zmd」与「终末地」互认，注入与 `qq_slang_query` 都支持。
- **闸门**：离线/学习器只写 `status=candidate`；控制台「黑话词库」页三 tab（候选/已确认/已拒绝）+ 批量确认/拒绝/删除 + 候选分诊（按「证据数 × 出现次数」降序）+ 单条编辑。
- **容量**：词库上限 2000 条（`capSlangEntries`：已确认 > 出现次数 > 最近更新），避免无限膨胀。

**离线（heihua-lab）**
- 八步流水线：采集 → 清洗（含**复读去重**）→ 候选发现（中文 2-5gram / 缩写 / 中西混合 / 数字，统计频次·文档频率·左右信息熵·PMI）→ 打分（0.35·log频次 + 0.2·文档频率 + 0.2·左右熵 + 0.25·词形加分）→ 语义判别（种子规则轨 + LLM 轨）→ 词库结构化 → LLM 适配（提示词包）→ 评估质检。
- 硬纪律：**只导出精确命中**（子串命中是 n-gram 碎片冒充长种子，实测 `ds`→yyds、`s1`→u1s1、`6`→996）；候选带真实证据（群 / 发言人 / 消息时间）。
- 工具链：`export_corpus.py`（只读导出消息库）、`llm_judge.py`（OpenAI 兼容端点语义判别）、`judged_to_candidates.py`（判定→候选）、`merge_qq_candidates.mjs`（dry-run 优先、不降级 confirmed、2000 上限保护、备份+原子写）、`prune_candidates.mjs`（规范执法式清理）、`test_e2e.mjs`（端到端 6 项断言）。

## 6. AI 工具与 MCP

桥接通过 DSH 的 MCP 客户端接入三个 server：

| MCP server | 能力 | 边界 |
| --- | --- | --- |
| `snowluma`（`src/mcp-snowluma-safe.js`） | QQ 动作**安全子集**：查状态/群/历史/图片/合并转发、发消息/回复/戳一戳/表情包/语音，可选 `replyToMessageId` | 发送强制白名单；群聊场景只允许安全动作 |
| `snowluma-host`（`src/mcp-host-server.js`） | 只有 `snowluma_status`（只读探活） | **不启动、不停止、不部署** SnowLuma（EULA §5.4） |
| `web-search-safe`（`src/mcp-web-search-safe.js`） | 只读 `web_search` / `web_fetch`，带 SSRF 防护 | 关键词会发给 Bing、会抓取公开 URL（数据出机清单见 LICENSE） |

内置 `qq_*` 工具族（按 `socialV2.tools.*` 逐项开关，未启用直接 403）：

- **收发**：`qq_send_message`、`qq_reply`、`qq_send_poke`、`qq_send_voice`、`qq_list_voices`
- **读取**：`qq_get_unread_messages`、`qq_get_recent_messages`、`qq_get_group_history`、`qq_get_message_detail`、`qq_get_message_images`、`qq_get_forward_msg`、`qq_get_active_members`
- **节奏**：`qq_wait_for_messages`、`qq_set_wake_config`、`qq_mark_read`（`readThroughSeq` 水位）
- **记忆**：`qq_memory_append` / `query` / `remove` / `clear`
- **黑话**：`qq_slang_query`（content/meaning/usage/example/**aliases** 子串匹配）、`qq_slang_submit`（限频：2 次/分钟、10 次/小时）
- **表情包**：`qq_list_stickers`、`qq_get_sticker_image`、`qq_send_sticker`、`qq_collect_sticker`、`qq_set_sticker_remark`、`qq_sticker_note`

## 7. 本地控制台（`http://127.0.0.1:3100`）

十个页面：**运行总览 / 会话与审批 / 人格与角色 / 二代仿真 / 一代仿真 / 黑话词库 / 令牌与花费 / 访问与安全 / 调试与运维 / 工具参考**；右上角搜索框可跨页定位任意功能项；支持**浅色 / 深色**双主题（默认跟随系统）。

| 板块 | 能力 |
| --- | --- |
| 运行总览 | 在线状态、SnowLuma 上游健康卡片、模式、静默开关、活动日志 |
| 会话与审批 | 会话列表、审批队列；agent 的 `ask_user_question` 与工具审批都会转发到 QQ，回复即决策 |
| 人格与角色 | 角色列表点选载入/编辑/新建/改名/另存/删除；两层提示词分别管理（见 §8） |
| 二代仿真 | 会话状态、关系分档、进行中话题（含出处校验）、唤醒策略、主动权限 |
| 黑话词库 | 候选/已确认/已拒绝三 tab、分诊排序、批量确认/拒绝、单条编辑、DSH 深度研究 |
| 令牌与花费 | token 消耗与折算金额（元），可下钻到每个群/每个好友/每一轮（轮次、步数、缓存命中/未命中、输出、命中率、花费、峰谷时段）+ 24h/3d/7d/30d 走势图；金额按官方价目表区分**高峰/空闲**（高峰为空闲 2 倍，内置法定节假日） |
| 访问与安全 | 白名单/黑名单、管理员 QQ、控制台令牌、上游告警 |
| 调试与运维 | 自测、日志、状态导出、ACL 修复 |
| 工具参考 | 当前模式下可用工具清单与说明 |

控制台访问需要令牌（`config.json` 的 `consoleToken`，留空时启动自动生成到 `state/console-token`），可手动修改或重新生成。

## 8. 人格与角色

- **两层提示词，分开管理**：
  - **仿真提示词**（preset 内置，管行为与协议）：保存前做安全不变量校验（缺了会拒绝保存，避免削弱权限边界）+ 自动备份 + 一键还原；写入 DSH 后需**重启 DSH** 生效。
  - **人格提示词**（`roles/*.md`，管人设与语气）：保存即生效，由桥接每条消息注入。
- **角色扮演**：`state/current-role.json` 注入，控制台/管理端可设，**群友无法更改**。
- **思考强度**：默认 `max`，可选 `high` / `low`，档位从 DSH 公布能力读取；保存后下一条消息生效（同时写入 DSH 全局默认，控制台有明示）。
- **Preset 机制**：`plugins/qq-agent-presets/` bundle 生成并插入 profile 的 `@deepseek-ai/dsh-agent-preset` 行（DSH 0.1.7+）；改 `dsh/agent-presets/` 后需 `node scripts/build-agent-preset-patches.mjs` 重新生成。

## 9. 消息呈现与多媒体

- **Markdown → QQ 纯文本**，链接保留 `文字 (url)` 形式。
- **长回复自动分段**（句读/URL 边界），避免超长单条被吞。
- **图片**：安全下载后接入多模态模型；拿不到字节的消息用占位文本。
- **语音**：发语音支持（独立 `voice-tool` 的 CLI/GUI + AI 工具 `qq_send_voice`，默认关闭，`audio/` 放素材）；**收**到的语音目前只显示占位文本。
- **表情包库**：列出/取图/发送/收藏/改备注/写说明。
- **合并转发**：解析 `forwardId` 拉取聊天记录。
- **限频防抖**：`ackMessage` 立即回执、`sendDelayMs` 发送间隔、`messageId` 去重。

## 10. 运维、安全与可观测

- **守护启动**：`start.bat` 崩溃 5 秒后自动拉起（关窗即停）；`restart.bat` 杀旧实例 → 清锁 → 重启；单实例锁防双开。
- **令牌体系**：控制台令牌（`x-console-token` / `?token=`）、AI 工具令牌（`x-agent-token`，与 sessions 绑定）、模式闸门（AI 通道受当前模式限制）。
- **权限边界**：`RULES.md` 明确「仿真会话不得拥有本地执行能力」；注册期断言钉死（缺工具黑名单/安全文案即测试失败）。
- **上游健康**：解析 SnowLuma 心跳 `status.good`（静默约 105s 翻 `false`）+ `get_status` 兜底 + `bot_status`（1.14.20+）；退化时日志直指 SnowLuma `[Hook]`，控制台与 `/api/status` 同步告警。
- **隐私**：`config.json` 与 `state/` 不入库；仓库只提供脱敏 `config.example.json`；`privacy-scan` / `harden-acl` 脚本可扫隐私串、收紧 state 权限。

## 11. 测试与审计

| 命令 | 覆盖 |
| --- | --- |
| `npm run test:audit` | 汇总审计（38 个脚本）：协议、安全、控制台静态契约、编码、语音、黑话、注入、记忆、预设、令牌… |
| `npm run test:slang-inject` | 注入链路 8 项：别名归一化 / scope 归一化 / 相关性排序 / 群作用域 / 回退 / 兼容 / 别名渲染 / 截断 |
| `npm run test-slang` | 黑话学习逻辑（sources / 研究 prompt / 解析） |
| `npm run test:token` / `test:tokens` | 消息水位与 token 开销；令牌账本与价目表（峰谷、幂等、基线合并） |
| `npm run test:console-ui` | 离线浏览器回归（看板渲染与逐轮下钻） |
| `npm run self-test` | DSH 链路端到端（建独立测试会话，不影响现有会话） |
| `node heihua-lab/tools/test_e2e.mjs` | heihua-lab ↔ 桥接端到端 6 项（临时副本，零副作用） |

---

# 二、核心设计原则

1. **理解一条消息 ≠ 必须回复这条消息**：AI 自己决定是否发言，真信号只用来「少说、说得更准」。
2. **两层提示词、一个闸门**：行为（preset）与人设（roles）分离；词库确认必须过人工闸门，程序不自动改正式词库。
3. **单进程 + JSON 状态**：不引数据库/向量库；词库上限 2000、注入 8 条，线性扫描 <1ms，检索基建在这里是纯负担。
4. **fail-closed**：空白名单不响应、拿不到安全 preset 不建会话、未启用的工具直接 403、缺安全不变量拒绝保存。
5. **隐私优先**：配置与运行时数据不入库；语料导出只读、排除机器人自身消息；公开示例一律占位符。

# 三、快速开始

完整 6 步（含 SnowLuma 安装、首次引导、白名单配置）见 [README.qq-bridge.md](README.qq-bridge.md)；最短路径：

```bash
npm install                                   # postinstall 自动修补 @snowluma/sdk 的 ESM bug
copy config.example.json config.json          # 填 OneBot/DSH/白名单/管理员 QQ
node scripts/setup-dsh.mjs                    # 装 preset + 挂 MCP（装完必须重启 DSH）
start.bat                                     # 守护模式启动
```

控制台：`http://127.0.0.1:3100`（令牌见 `state/console-token`）。

黑话分析（零依赖）：

```bash
cd heihua-lab
python run.py --corpus data/demo_corpus.txt --out out      # 演示语料
python tools/export_corpus.py --db <messages.db>           # 或从消息库导出真实语料
rebuild_real.bat                                           # 全链一键复现
```

# 四、目录结构

```
├── src/                 桥接核心（bridge.js / slang-learner.js / preset-prompt.js / mcp-*.js …）
├── public/              控制台前端（console.html）
├── scripts/             测试与诊断（test-audit.mjs 汇总；setup-dsh.mjs 安装）
├── plugins/ dsh/        预设 bundle 与 DSH 集成
├── roles/               人格提示词（*.md）
├── audio/               语音库
├── docs/                文档索引、指南、设计、调研、审计
├── state/               运行时数据（不入库）
├── heihua-lab/          离线黑话分析
│   ├── heihua/          八步流水线模块
│   ├── data/            演示语料 + 种子词库
│   ├── docs/            方法论 / 集成架构
│   └── tools/           导出、判别、合并、清理、端到端测试
├── config.example.json  配置模板（真实 config.json 不入库）
├── RULES.md             权限边界与安全承诺
└── README.qq-bridge.md  上游 qq-bridge 说明（完整安装步骤）
```

# 五、已知限制

- 回复在回合结束时一次性发送，不做流式逐字转发。
- 收到的语音只显示占位文本，不做语音转写。
- AI 发语音默认关闭（先把素材放进 `audio/`，控制台开开关）；自己发语音不受该开关影响。
- 图片之外的媒体（视频等）使用占位文本。
- `@snowluma/sdk` 的 npm 发布版有 ESM 扩展名 bug，仓库用 postinstall 补丁修复。
- 黑话语义判别依赖 LLM 轨；同一批候选多次判定可能不一致（判定是辅助，人工闸门是终点）。

# 六、占位符说明

公开版本中以下内容已替换为占位符，本地使用时改回真实值：

- `E:/workspace/` → 你的工作目录
- `100000001` / `100000002` … → 真实群号 / 机器人 QQ（出现在示例与测试夹具中）

# 七、致谢与许可

- 上游项目：[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（原始说明见 [README.qq-bridge.md](README.qq-bridge.md)）。
- 本仓库在其基础上扩展了：群聊仿真（一代/二代）、社交记忆、黑话相关性/群作用域注入、离线词库流水线（heihua-lab）。
- SnowLuma 是独立第三方项目，与腾讯/QQ 无隶属关系；使用前请阅读其 EULA 与《QQ 用户协议》。
- 许可证见 [LICENSE](LICENSE)。
