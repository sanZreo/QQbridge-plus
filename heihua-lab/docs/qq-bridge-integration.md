# heihua-lab × qq-bridge 集成架构

> 结论先行：**三层 + 一条离线管线 + 一个闸门**，全部落在现有代码里，不引 Python 服务、SQLite、向量库。
> 词库规模上限 2000 条、注入 8 条，线性扫描 <1ms，任何检索基建在这里都是纯负担。

## 一、总览

```
┌─ 离线层（Python，heihua-lab，本项目）────────────────────────┐
│  语料 → 八步流水线 → qq_candidates.json                      │
│  纪律：只写 status=candidate，带 evidence，scope=general，     │
│        绝不直接输出 confirmed（程序不自动改正式词库）          │
└──────────────────────────────┬───────────────────────────────┘
                               ▼  merge（默认 dry-run，--apply 才落盘）
┌─ 审核层（控制台「黑话词库」页，qq-bridge 已有）──────────────┐
│  候选分诊：按「证据数 × 出现次数」降序，先审证据足出现多的      │
│  → 人工确认 / 拒绝；DSH 深度联网研究（buildResearchPrompt）    │
└──────────────────────────────┬───────────────────────────────┘
                               ▼  确认后才进注入池
┌─ 运行时（bridge.js，本次只改注入一个函数）───────────────────┐
│  buildSlangContextFor(key, entries, max, recentMessages)：    │
│    ① 相关性检索：当前消息窗口命中 content/aliases 的词排前     │
│    ② 作用域过滤：general∩相关 + group:<key> 全部              │
│    ③ 截断到 injectMax=8（已有配置）                          │
│    ④ 无命中回退：本群+通用按 count 排序（= 改造前，不退化）    │
└──────────────────────────────┬───────────────────────────────┘
                               ▼
                    LLM（已有）：理解 → 自己决定是否回复
```

## 二、本次改了 qq-bridge 什么（可整体回退）

| 文件 | 改动 | 回退 |
| --- | --- | --- |
| `src/slang-learner.js` | ① `normalizeSlangEntry` 新增 `aliases`/`scope` 字段（旧数据自动补默认值，行为不变）② 新增 `buildSlangContextFor`（相关性+作用域+回退）③ `buildSlangContext` 保留为兼容包装 | `git checkout src/slang-learner.js` |
| `src/bridge.js` | ① `withSlangContext(promptText, key)` 接入相关注入，4 个投递点传 key ② 上下文快照端点与 `qq_slang_query` 的 block 改用 `buildSlangContextFor` ③ `qq_slang_query` 匹配增加 aliases ④ `/api/slang` 候选按「证据数×出现次数」分诊排序 ⑤ `publicSlangEntry` 暴露 aliases | `git checkout src/bridge.js` |
| `public/console.html` | 候选 tab 显示分诊排序说明（一行 meta） | `git checkout public/console.html` |
| `scripts/test-slang-inject.mjs` | 新增 8 项断言（别名/作用域/相关性/回退/截断/空池），已注册进 `test-audit` 与 `npm run test:slang-inject` | 删文件 + 改回两处注册 |

## 三、heihua-lab 侧的纪律（评审结论落地）

1. **只产候选**：`out/qq_candidates.json` 里所有条目 `status=candidate`。程序跑得再准，也不能跳过人工闸门直接进注入表。
2. **带证据**：每条候选带最多 5 条语料上下文（`〖词〗` 标记命中位置，text 限长 80 字，与 qq-bridge 的 evidence 限长一致）——审核者不看语料就无法判词。
3. **作用域**：`scope` 默认 `general`；种子词库可按需标 `group:<id>` 收窄到单群（见 `data/seeds.json` 的 scope 字段说明）。
4. **分诊优先级**：合并后端上「证据数 × 出现次数」与 `/api/slang` 的排序口径一致，控制台先审最值得审的。

## 四、合并流程（dry-run 优先）

```bash
# 1. heihua-lab 产出候选（语料换成真实群聊导出即可）
"C:/Users/mechrevo/.workbuddy/binaries/python/versions/3.13.12/python.exe" \
  "E:/workspace/heihua-lab/run.py" --corpus <语料.txt> --out out

# 2. dry-run 看合并计划（不写任何文件）
node "E:/workspace/heihua-lab/tools/merge_qq_candidates.mjs"

# 3. 确认计划无误后落盘（自动备份 + 原子写 + 不降级 confirmed + 2000 上限保护）
node "E:/workspace/heihua-lab/tools/merge_qq_candidates.mjs" --apply
```

合并脚本的安全性质检：
- **不降级**：已 `confirmed` 的词只补字段不改状态；已 `rejected` 的不复活。
- **不覆盖身份**：更新不动 `id/status/createdAt`，`count` 取新旧较大值。
- **可回溯**：落盘前自动 `.bak-<时间戳>` 备份；写坏可回滚。

## 五、验收对照（评审四步）

| 评审步骤 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 别名字段 + 相关性注入 | ✅ `test-slang-inject.mjs` 断言 1/3/7/8 |
| 2 | scope 字段 + 注入过滤 | ✅ 断言 2/4/6 |
| 3 | 候选分诊（排序 + 批量确认） | ✅ `/api/slang` 服务端排序 + 控制台提示；批量确认端点早已存在 |
| 4 | heihua-lab 输出 candidate + evidence + scope，dry-run 合并 | ✅ `qq_candidates.json` + `tools/merge_qq_candidates.mjs` |

## 六、明确不做（评审结论，防止后续迭代退化）

- ❌ 独立 Python 服务 / SQLite / FTS5 / RapidFuzz：单进程 Node + JSON，2000 条线性扫描够用。
- ❌ 向量检索 / FAISS：注入 8 条，词库上限 2000，向量库是纯负担。
- ❌ 「语境与使用规则库」做成数据库表：提示词 + git 可审可回滚，做成表反而不可读。
- ❌ 「常规语义理解 / 反讽识别」独立成层：LLM 本来就会，做成模块是虚构工作量。
- ❌ 多 Agent：评审自身也不建议。
- ⚠️ 两条已实现的能力**别在后续迭代里退化**：「理解一条消息 ≠ 必须回复」（主动/过时闸门已做）；「群聊数据按会话隔离」（词库此前不隔离，本次补上 scope 维度）。
