"""步骤5: 黑话语义判别.

双轨制:
- 规则轨(默认): 与种子词库做精确/子串匹配, 直接确认; 其余按形态与得分标为「待判别」或「低优先级」
- LLM 轨(可选): 把「待判别」候选连同上下文交给 LLM 做语义判定,
  可接任意 OpenAI 兼容端点(例如本地反向代理 http://127.0.0.1:8790/v1)

机器只能发现「可疑词形」, 「是不是黑话、是什么意思」必须由语义判断完成,
这就是为什么 LLM 轨是质量关键。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List

from .extract import Candidate


def load_seeds(path: str) -> List[dict]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return data.get("entries", [])


def build_alias_index(seeds: List[dict]) -> Dict[str, dict]:
    idx: Dict[str, dict] = {}
    for e in seeds:
        for name in [e["term"], *e.get("aliases", [])]:
            idx[name] = e
    return idx


def classify(ranked: List[Candidate], seeds: List[dict], score_threshold: float = 0.45) -> Dict[str, dict]:
    idx = build_alias_index(seeds)
    seed_terms = [e["term"] for e in seeds]
    results: Dict[str, dict] = {}
    for c in ranked:
        entry, match = None, None
        if c.term in idx:
            entry, match = idx[c.term], "exact"
        else:
            for st in seed_terms:
                if len(st) >= 2 and (st in c.term or c.term in st):
                    entry, match = idx[st], "substring"
                    break
        if c.kind == "num" and c.term.isdigit() and match != "exact":
            # 裸数字(30/10/666)是聊天计数不是词形; 更不能靠子串冒充多位数字种子 ——
            # 实测坑: 候选「6」子串命中种子「996」, 证据退化成碎片「黍〖6〗月」还带了假确认。
            # 文化数字黑话(996)只有以完整词形出现才确认。
            results[c.term] = {"status": "low_priority", "candidate": c, "reasons": ["裸数字, 非词形"]}
        elif c.kind == "latin" and match != "exact":
            # 拉丁缩写是原子词形(yyds/xswl/u1s1), 子串对它没有意义 ——
            # 实测坑: 碎片「ds」×3 冒充 yyds, 「s1」×42 冒充 u1s1(真实语料里
            # 这两个词一次都没出现过, db 字节级 grep 为 0)。拉丁候选只配精确匹配。
            results[c.term] = {"status": "low_priority", "candidate": c, "reasons": ["拉丁碎片, 非完整词形"]}
        elif entry is not None:
            results[c.term] = {"status": "confirmed", "match": match, "seed": entry, "candidate": c}
        elif c.kind in ("latin", "mixed", "num") or c.score >= score_threshold:
            reason = "缩写/混合/数字形态, 需语义确认" if c.kind in ("latin", "mixed", "num") else "高分新词形, 需语义确认"
            results[c.term] = {"status": "suspect", "candidate": c, "reasons": [reason]}
        else:
            results[c.term] = {"status": "low_priority", "candidate": c, "reasons": ["低分或常规词形"]}
    # 碎片抑制: n-gram 会把长词切出子串(粒度/电子榨/嘟假嘟), 若某已确认候选
    # 是另一个更长的已确认候选的子串, 降级为 fragment —— 不进词库, 也不占
    # Top-N 短名单(否则会把真词挤出去, 稀释召回率)。
    confirmed_terms = [t for t, v in results.items() if v["status"] == "confirmed"]
    for t in confirmed_terms:
        for longer in confirmed_terms:
            if len(longer) > len(t) and t in longer:
                results[t] = {
                    "status": "fragment",
                    "candidate": results[t]["candidate"],
                    "reasons": [f"被更长候选「{longer}」覆盖"],
                }
                break
    return results


def llm_classification_prompt(suspects: List[Candidate]) -> str:
    """生成交给 LLM 做语义判别的提示词(LLM 轨入口)."""
    lines = [
        "你是中文黑话分析专家。判断下列候选词是否为网络/行业黑话, 只输出 JSON 数组:",
        '[{"term":"...","is_slang":true/false,"sense":"黑话义, 非黑话填null","domain":"领域","confidence":0-1}]',
        "",
        "候选词(附上下文):",
    ]
    lines += [f"- {c.term} (出现{c.count}次, 上下文: {' | '.join(c.contexts[:2])})" for c in suspects]
    return "\n".join(lines)


def call_llm_backend(prompt: str, base_url: str = "http://127.0.0.1:8790/v1",
                     model: str = "fast-model",
                     api_key: str = "", timeout: int = 180) -> str:
    """LLM 轨后端: 任意 OpenAI 兼容 /chat/completions 端点.

    默认指向本机反向代理(127.0.0.1:8790, 需手动启动);
    回环请求显式绕过系统代理(本机 HTTP 代理会打歪 127.0.0.1 请求)。
    返回模型输出文本; 失败抛异常, 由调用方决定降级为重试或跳过。
    """
    import json as _json
    import urllib.request
    url = base_url.rstrip("/") + "/chat/completions"
    body = _json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": "你是中文黑话分析专家, 严格按用户要求的 JSON 格式输出, 不要任何解释。"},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
    }).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=timeout) as resp:
        data = _json.loads(resp.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"]
