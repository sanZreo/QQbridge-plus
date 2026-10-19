# heihua-lab — 黑话词库分析研究流水线

把「一堆群聊/网络语料」变成「LLM 能直接消费的黑话知识包」的八步流水线。**纯 Python 标准库，零依赖**，一条命令跑全程。

主战场：为 `qq-bridge`（QQ 机器人「鲸鱼娘」）供给黑话候选——集成架构见 [`docs/qq-bridge-integration.md`](docs/qq-bridge-integration.md)，方法论见 [`docs/llm_heihua_steps.md`](docs/llm_heihua_steps.md)。

## 快速开始

```bash
# 演示语料(QQ 群聊风格 65 篇) + 种子词库(39 条先验黑话)
"C:/Users/mechrevo/.workbuddy/binaries/python/versions/3.13.12/python.exe" run.py \
  --corpus data/demo_corpus.txt --out out

# 自己的语料: .txt/.md 一行一篇, 或 .jsonl(取 text/content 字段)
python run.py --corpus chat_log.jsonl --seeds data/seeds.json --out out --min-count 3
```

## 八步流水线

| 步骤 | 模块 | 干什么 |
| --- | --- | --- |
| 1 语料采集 | `heihua/ingest.py` | txt/md/jsonl → Document 列表 |
| 2 清洗预处理 | `heihua/clean.py` | NFKC 归一化、去 URL/@、剔短文档 |
| 3 候选词发现 | `heihua/extract.py` | 中文 2-5gram + 缩写 + 中西混合 + 数字；频次/文档频率/左右信息熵/PMI |
| 4 打分排序 | `heihua/rank.py` | 0.35·log频次 + 0.2·文档频率 + 0.2·左右熵 + 0.25·词形加分 |
| 5 黑话判别 | `heihua/classify.py` | 种子词库匹配（规则轨）+ LLM 轨扩展点 |
| 6 词库构建 | `heihua/lexicon.py` | 词条 schema + 词形归并 |
| 7 LLM 适配 | `heihua/llm_adapter.py` | 提示词包 + QQ 候选导出 + 注入片段 |
| 8 评估质检 | `heihua/evaluate.py` `heihua/report.py` | 覆盖率/召回/分布/复核指引 |

## 产物（out/）

| 文件 | 内容 |
| --- | --- |
| `lexicon.json` | 结构化词库（主产物，含本义/黑话义/例句/统计） |
| `llm_prompt_pack.md` | 可直接投喂 LLM 的提示词包（系统提示+规则+消歧表+few-shot） |
| `llm_lexicon_view.json` | 词库精简 JSON 视图 |
| `qq_candidates.json` | **qq-bridge 候选导入文件**（status=candidate + evidence + scope，绝不直接 confirmed） |
| `qq_prompt_injection.md` | 注入块预览（与 buildSlangContext 同格式，调试用） |
| `eval.json` | 评估指标 |
| `analysis_report.md` | 人读分析报告（Top 候选/已确认/分布/复核指引/已知局限） |

## 工具（tools/）

| 脚本 | 用途 |
| --- | --- |
| `export_corpus.py` | 从 qq-bridge 的 `messages.db`（snowluma）导出群聊语料：只读打开、排除机器人自己的消息、只取文本段、一行一条；**同时导出 `.meta.jsonl`**（key/sender/time，供证据回溯） |
| `llm_judge.py` | **LLM 语义判别轨**：把「待判别」候选连上下文送 LLM 判定，默认接本机反向代理 `127.0.0.1:8790`（模型 `fast-model`，需手动启动），产出 `llm_judged.json` |
| `judged_to_candidates.py` | **把 LLM 判定结果闭环成候选**：`is_slang=true` → `qq_candidates.json` 条目（candidate/ai/evidence/scope/count），默认 dry-run，`--apply` 落盘 |
| `merge_qq_candidates.mjs` | 把 `qq_candidates.json` 合并进 qq-bridge `state/slang.json`：默认 dry-run，不降级 confirmed，2000 上限保护，备份+原子写；**默认读 `out-real/`，并对 demo 产物（`out/`）的 `--apply` 加硬闸**（需 `--allow-demo`） |
| `prune_candidates.mjs` | 清理低价值候选腾出 2000 上限：超长>8 字 / 含标点 / 陈旧 N 天（**规范执法，不碰 confirmed/rejected**），dry-run 默认，备份+原子写 |
| `rebuild_real.bat` | 真实语料全链一键复现（参数已固化，修复评审限制「复现参数没固化」） |
| `test_e2e.mjs` | **端到端集成测试**（6 项）：在临时副本上载入真实词库 → 候选不进注入 → 模拟确认 → 本群注入/相关排序 → 他群隔离 → 空窗回退 → 2000 上限裁剪。不写真实词库、不启动桥接、零外部副作用 |

> ⚠️ **只导出精确命中**：`qq_candidates.json` 只含 `match == "exact"` 的词条。子串命中的是 n-gram 碎片冒充长种子（实测 `s1`→u1s1、`ds`→yyds、`6`→996，真实语料里这些词一次都没出现过，db 字节级 grep 为 0），其 count/证据都是碎片的——详见验证报告第七节。

> ⚠️ **`out/` ≠ `out-real/`**：`out/` 是 65 篇**合成 demo 语料**的产物（里面是「闭环/颗粒度/抓手/赋能」这类**职场黑话**），
> `out-real/` 才是真实群聊导出。把 demo 产物合进群词库 = 用通用职场词污染群内黑话，评审明令禁止。

## 完整闭环（真实语料）

```bash
# 一键复现(参数已固化):
rebuild_real.bat

# 或分步:
python tools/export_corpus.py                      # → data/real_corpus.txt + .meta.jsonl
python run.py --corpus data/real_corpus.txt --seeds data/seeds.json --out out-real --min-count 2 --top-n 500
python tools/llm_judge.py --corpus data/real_corpus.txt --out out-real --top 40 --batch 10
python tools/judged_to_candidates.py --apply        # LLM 判定 → 候选
node tools/prune_candidates.mjs                     # 先看清理计划(2000 上限已满时)
node tools/prune_candidates.mjs --apply             # 清出容量(规范执法批次)
node tools/merge_qq_candidates.mjs                  # dry-run 看计划
node tools/merge_qq_candidates.mjs --apply          # 真正合并
```

## 接入 LLM（可选，步骤 5 的 LLM 轨）

规则轨（默认）只能确认「已知词形」。要让它发现新词，把「待判别」候选连同上下文交给 LLM：

```bash
# 一键: 统计候选 + LLM 判定 + 输出 llm_judged.json
python tools/llm_judge.py --corpus data/real_corpus.txt --out out-real --top 40

# 或在自己的代码里调:
python -c "
from heihua.classify import llm_classification_prompt, call_llm_backend
print(call_llm_backend(llm_classification_prompt(suspects)))  # 默认 127.0.0.1:8790/v1
"
```

真实语料上的端到端验证见 [`docs/real-corpus-findings.md`](docs/real-corpus-findings.md)。

## 设计纪律

1. **离线流水线只产候选**：确认权在人工闸门（qq-bridge 控制台），程序不自动改正式词库。
2. **机器认词形，语义归语义**：步骤 3/4 再准也只是粗排，步骤 5 的语义判别才是质量关键。
3. **最小上下文包**：给 LLM 的是「词条+义项+例句+消歧规则+反例+时效」，不是一张大词表。
4. **可度量**：每轮跑完都有覆盖率/召回/未命中清单，复核结论写回 `data/seeds.json` 迭代。

## 已知局限

- 无分词词典，中文候选靠 n-gram：长词可能被切碎，靠「最长匹配优先 + 子串归并」兜底。
- 左右信息熵按单字上下文计算，对短语级黑话（「那咋了」）区分度有限。
- 时效性判断弱：词是否过时需要外部时间信号。
- 演示语料规模小（65 篇），指标是演示口径；真实语料（数千篇）下候选质量会好得多。
