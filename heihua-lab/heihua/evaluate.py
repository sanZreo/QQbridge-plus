"""步骤8: 评估与质检.

指标:
- 种子词库覆盖率(确认黑话 / 种子总数)
- Top-N 候选召回率(种子词进入 Top-N 排序的比例)
- 词形分布 / 领域分布
- 未命中种子列表(提示语料覆盖不足或词形未捕获)
"""
from __future__ import annotations

from collections import Counter
from typing import Dict, List


def evaluate(seeds: List[dict], ranked: List, classified: Dict, entries: List[dict], top_n: int = 50) -> Dict:
    seed_terms = [e["term"] for e in seeds]
    # 召回率按「碎片抑制后的短名单」算: n-gram 碎片不占位, 指标才反映真实排序质量
    shortlist = [c for c in ranked if classified.get(c.term, {}).get("status") != "fragment"][:top_n]
    in_top = set()
    for st in seed_terms:
        for c in shortlist:
            if len(st) >= 2 and (st == c.term or st in c.term or c.term in st):
                in_top.add(st)
                break
    confirmed = {e["term"] for e in entries}
    covered = [t for t in seed_terms if t in confirmed]
    missing = [t for t in seed_terms if t not in confirmed]
    forms = Counter(e["form"] for e in entries)
    domains = Counter(e["domain"] for e in entries)
    return {
        "eval_top_n": top_n,
        "seeds_total": len(seed_terms),
        "seeds_confirmed": len(covered),
        "coverage": round(len(covered) / max(len(seed_terms), 1), 3),
        "topn_recall": round(len(in_top) / max(len(seed_terms), 1), 3),
        "confirmed_entries": len(entries),
        "fragment_count": sum(1 for v in classified.values() if v["status"] == "fragment"),
        "suspect_count": sum(1 for v in classified.values() if v["status"] == "suspect"),
        "low_priority_count": sum(1 for v in classified.values() if v["status"] == "low_priority"),
        "form_distribution": dict(forms.most_common()),
        "domain_distribution": dict(domains.most_common()),
        "seeds_not_in_corpus": missing,
    }
