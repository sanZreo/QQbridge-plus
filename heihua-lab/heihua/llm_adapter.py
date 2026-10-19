"""步骤7: LLM 适配.

把结构化词库转成 LLM 可直接消费的提示词包:
- 系统提示词(角色与任务)
- 词库使用规则
- 消歧规则表(本义 != 黑话义的词条)
- few-shot 示例
- 输出格式要求
- QQ 机器人用的精简注入片段(build_qq_injection)

核心思想: LLM 不需要「学习」整个词库, 它需要的是
词条 + 义项 + 例句 + 消歧规则 + 反例 组成的「最小上下文包」。
"""
from __future__ import annotations

from typing import Dict, List

SYSTEM_PROMPT = """你是一名熟悉中文互联网与各行业黑话的语言分析助手。当文本中出现黑话时:
1. 先结合上下文判断该词是按本义还是黑话义使用, 不要见到词就套黑话义;
2. 输出时保留原文, 并用括号给出黑话义的直白解释;
3. 若无法判断, 明确标注「存疑」并给出两种可能, 不要编造词义;
4. 涉及违法、敏感场景的黑话, 只做语言学说明, 不提供任何操作细节;
5. 黑话有时效性, 对已过时的词义要注明「旧义」。"""

RULES = [
    "先判语境再套词义: 同一个词在本义语境中按本义理解(如「对齐」在机械语境不是黑话)。",
    "输出保留原文 + 括号注释, 不要替换用户原话。",
    "词义以词库 sense_slang 为准, 词库没有的词标注「未收录」而不是猜测。",
    "注意时效: timeliness 字段标记了词义的活跃期, 旧义需注明。",
    "拿不准就「存疑」, 置信度低于 0.6 时不输出确定解释。",
]


def build_prompt_pack(entries: List[dict]) -> Dict:
    md: List[str] = []
    md.append("# 黑话词库 · LLM 提示词包\n")
    md.append("> 由 heihua-lab 自动生成, 可直接作为系统提示或知识库片段投喂给 LLM。\n")
    md.append("## 1. 系统提示词(System Prompt)\n")
    md.append("```text")
    md.append(SYSTEM_PROMPT)
    md.append("```\n")
    md.append("## 2. 词库使用规则\n")
    for i, r in enumerate(RULES, 1):
        md.append(f"{i}. {r}")
    md.append("\n## 3. 消歧规则(本义 ≠ 黑话义)\n")
    md.append("| 词条 | 本义 | 黑话义 |")
    md.append("| --- | --- | --- |")
    for e in entries:
        if e["sense_literal"] and e["sense_slang"]:
            md.append(f"| {e['term']} | {e['sense_literal']} | {e['sense_slang']} |")
    md.append("\n## 4. Few-shot 示例\n")
    md.append("```text")
    for e in entries[:2]:
        md.append(f"输入: {e['example']}")
        md.append(f"输出: {e['example']}（{e['term']}：{e['sense_slang']}）")
        md.append("")
    md.append("```\n")
    md.append("## 5. 输出格式要求\n")
    md.append("```json")
    md.append('[{"term": "黑话词", "sense": "黑话义", "literal_used": false, "confidence": 0.0}]')
    md.append("```\n")
    json_view = [
        {"term": e["term"], "sense_slang": e["sense_slang"], "domain": e["domain"], "form": e["form"]}
        for e in entries
    ]
    return {"markdown": "\n".join(md), "json_view": json_view}


def build_qq_injection(entries: List[dict], max: int = 8) -> str:
    """QQ 机器人用的精简注入片段.

    与 qq-bridge src/slang-learner.js 的 buildSlangContext() 输出同风格,
    方便两种来源的黑话表混排; 群聊场景对 token 敏感, 默认只取前 max 条。
    """
    top = entries[:max]
    lines = ["【群聊黑话表】群里已确认/常用的网络用语和梗（按出现次数排序，知道即可，不要刻意堆砌）："]
    for e in top:
        line = f"- {e['term']}：{e['sense_slang']}"
        if e.get("register"):
            line += f"（语域：{e['register']}）"
        if e.get("example"):
            line += f"（例：{e['example']}）"
        lines.append(line)
    lines.append("规则: 拿不准标注「存疑」, 不要编造; 本义语境按本义。")
    return "\n".join(lines)


def _evidence_from_corpus(terms: List[str], corpus_meta: List[dict], limit: int = 5) -> List[dict]:
    """从**真实语料**里取证据行，字段对齐 qq-bridge 现有 evidence 约定。

    为什么必须这么写（2026-10-19 评审结论）：
    - 真实词库里 evidence 的键是 `{key, sender, text, time}`，`time` 是**消息时间**（epoch ms）；
    - 上一版输出的是 `{text, at}`，`at` 还是**跑批时间** —— 等于把"什么时候分析的"冒充成
      "这句话什么时候说的"，证据因此无法回溯到具体消息，也就无法复核。
    - 所以：有 meta 就用真实 key/sender/time；没有 meta 就只给 text，**不编造时间**。
    """
    if not corpus_meta:
        return []
    wanted = [t for t in (str(x).strip() for x in terms) if len(t) >= 2]
    if not wanted:
        return []
    lowered = [(w.lower(), w) for w in wanted]
    out: List[dict] = []
    for row in corpus_meta:
        text = str(row.get("text") or "")
        if not text:
            continue
        low = text.lower()
        if not any(t in low for t, _ in lowered):
            continue
        item = {"text": text[:80]}
        if row.get("key"):
            item["key"] = str(row["key"])
        if row.get("sender"):
            item["sender"] = str(row["sender"])
        if row.get("time"):
            item["time"] = int(row["time"])
        out.append(item)
        if len(out) >= limit:
            break
    return out


def build_qq_candidates(entries: List[dict], max_entries: int = 2000,
                        corpus_meta: Optional[List[dict]] = None) -> List[dict]:
    """把词库转成 qq-bridge state/slang.json 兼容的**候选**条目.

    设计红线(来自架构评审结论): 离线流水线绝不直接写 confirmed ——
    词条必须以 candidate 身份进候选池, 经控制台人工/DSH 研究确认后才进注入表,
    「不要让程序每跑一次就自动修改正式词库」.
    字段对齐 qq-bridge src/slang-learner.js 的 normalizeSlangEntry():
    content/meaning/usage/example/risk/sources/aliases/scope/status/source/count/evidence.

    `source` 必须是 **ai**：这是机器统计+模型判别的产物，标成 manual 等于冒充人工输入
    （上一版就是这么错的，评审红线 A1）。
    evidence 优先取真实语料行（带 key/sender/time）；没有 meta 时只给 text。
    scope 默认 general; 种子词库可按需标 group:<id> 收窄到单群.
    """
    from datetime import datetime, timezone
    ts = datetime.now(timezone.utc).isoformat()
    out: List[dict] = []
    for e in entries[:max_entries]:
        # 只导出**精确命中**的词条: 子串命中的是 n-gram 碎片冒充(实测 ds→yyds,
        # s1→u1s1, 6→996 —— 真实语料里这些词一次都没出现过), 其 count/证据
        # 都是碎片的, 不能进 QQ 候选池。别名匹配证据仍然有效(别名是真实用法)。
        if e["stats"].get("match") != "exact":
            continue
        terms = [e["term"], *e.get("aliases", [])]
        evidence = _evidence_from_corpus(terms, corpus_meta or [])
        if not evidence:
            # 没有真实语料行可用时，只保留流水线留样的片段文本，不附带任何时间戳
            evidence = [{"text": str(ctx)[:80]} for ctx in e.get("contexts", [])[:5]]
        out.append({
            "id": f"heihua-{e['term']}",
            "content": e["term"],
            "meaning": e["sense_slang"],
            "usage": f"{e['form']}｜{e['domain']}｜{e['register']}｜时效:{e['timeliness']}",
            "example": e.get("example", ""),
            "risk": e.get("note", ""),
            "sources": ["heihua-lab"],
            "aliases": e.get("aliases", []),
            "scope": e.get("scope", "general"),
            "status": "candidate",
            "source": "ai",
            "count": e["stats"]["corpus_count"],
            "evidence": evidence,
            "lastInferenceCount": 0,
            "createdAt": ts,
            "updatedAt": ts,
        })
    return out
