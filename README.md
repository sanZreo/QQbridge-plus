# QQbridge-plus

**QQ 群聊 AI 桥接 + 黑话知识库分析流水线**

一个跑在 Windows 上的单进程 QQ ↔ LLM 桥接项目：让 AI 以「群友」身份参与群聊——自己判断要不要说话、说什么、说多少；配套一条离线的黑话词库分析流水线，把群聊语料变成 LLM 可直接消费的术语知识包。

## 组成

| 模块 | 位置 | 作用 |
| --- | --- | --- |
| **qq-bridge** | 仓库根目录 | 桥接主体：OneBot v11 ↔ DSH/LLM，群聊会话、社交记忆、黑话学习、Web 控制台 |
| **heihua-lab** | `heihua-lab/` | 离线黑话分析：八步流水线，把语料变成候选词库 + LLM 提示词包 |

```
QQ ──OneBot v11──► qq-bridge ──► DSH / LLM ──► 回复
                      │                  ▲
                      │                  │  【群聊黑话表】
                      │                  │  相关性命中 + 群作用域，最多 8 条
                      ├── state/slang.json
                      │        ▲
                      │        │ 人工确认（控制台，唯一闸门）
                      │   heihua-lab 产出的候选（带证据，永不直接 confirmed）
                      └── 控制台 :3100
```

## 核心设计

- **理解一条消息 ≠ 必须回复这条消息**：AI 通过主动/过时闸门自己决定是否发言，真信号只用来「少说、说得更准」。
- **黑话注入按相关性 + 群作用域**：`buildSlangContextFor(key, entries, max, recentMessages)`——本群词恒进池、通用词需被当前消息提到、无命中回退为按次数排序（不退化）。A 群的梗不会漏进 B 群。
- **候选闸门**：离线流水线只写 `status=candidate`，必须人工在控制台确认才会进注入池；程序不会自动改正式词库。
- **单进程 + JSON 状态**：不引数据库/向量库。词库上限 2000 条、注入 8 条，线性扫描 <1ms，任何检索基建在这里都是纯负担。
- **隐私优先**：`config.json`、`state/` 不进版本库；语料导出以只读方式打开消息库、排除机器人自己的消息；脱敏后再做公开示例。

## 快速开始

### 1. 桥接

```bash
npm install
copy config.example.json config.json     # 填 OneBot/DSH/白名单/管理员 QQ
start.bat                                 # 或 npm start
```

控制台：`http://127.0.0.1:3100`，令牌见 `state/console-token`（首次运行自动生成）。

### 2. 黑话分析

```bash
cd heihua-lab
python run.py --corpus data/demo_corpus.txt --out out          # 演示语料，零依赖
python tools/export_corpus.py --db <messages.db>               # 从消息库导出真实语料
python run.py --corpus data/real_corpus.txt --out out-real --min-count 2 --top-n 500
python tools/llm_judge.py --corpus data/real_corpus.txt --out out-real --top 40
python tools/judged_to_candidates.py --apply                   # 判别结果 → 候选
node tools/merge_qq_candidates.mjs                             # dry-run，--apply 才落盘
```

`heihua-lab/rebuild_real.bat` 把上述全链参数固化成一键复现。

## 目录结构

```
├── src/                 桥接核心（bridge.js / slang-learner.js / preset-prompt.js …）
├── public/              控制台前端
├── scripts/             测试与诊断脚本（npm run test:audit 汇总）
├── plugins/ dsh/        预设与 DSH 集成
├── roles/               人格提示词
├── docs/                设计基线与审计文档
├── heihua-lab/          黑话分析流水线
│   ├── heihua/          八步：ingest → clean → extract → rank → classify → lexicon → llm_adapter → evaluate
│   ├── data/            演示语料 + 种子词库
│   ├── docs/            方法论 / 集成架构
│   └── tools/           语料导出、LLM 判别、候选合并、清理、端到端测试
├── config.example.json  配置模板（真实 config.json 不入库）
└── README.qq-bridge.md  上游 qq-bridge 的原始说明
```

## 黑话链路（重点）

1. **离线**（heihua-lab）：语料 → n-gram/缩写/混合/数字候选 → 频次·文档频率·左右熵·词形打分 → 种子匹配 + LLM 语义判别 → 词条化 → 只导出 `match == "exact"` 的候选，带真实证据（群/发言人/消息时间）。
2. **审核**（控制台「黑话词库」页）：候选按「证据数 × 出现次数」分诊排序 → 人工确认 / 拒绝，可送 DSH 深度联网研究。
3. **运行时**（bridge.js）：已确认词按相关性与群作用域注入，最多 8 条。

> 为什么只收精确命中：n-gram 碎片会靠子串规则冒充长种子（实测 `ds`→yyds、`s1`→u1s1、`6`→996），其计数与证据都是碎片的。详见 `heihua-lab/docs/llm_heihua_steps.md`。

## 测试

```bash
npm run test:audit                 # 汇总审计（含 38 个脚本）
node scripts/test-slang-inject.mjs # 注入：别名/作用域/相关性/回退（8 项）
node heihua-lab/tools/test_e2e.mjs # 端到端：临时副本上模拟确认→注入（6 项）
```

## 替换占位符

公开版本里的以下内容已替换为占位符，本地使用时改回真实值：

- `E:/workspace/` → 你的工作目录
- `100000001` / `100000002` … → 真实群号 / 机器人 QQ（出现在示例与测试夹具中）

## 致谢与许可

- 上游项目：[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（原始说明见 `README.qq-bridge.md`）。
- 本项目在其基础上做了群聊仿真、社交记忆、黑话注入与离线词库流水线的扩展。
- 许可证见 `LICENSE`。
