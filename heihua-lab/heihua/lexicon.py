"""步骤6: 词库构建.

把判别结果结构化为 LLM 可直接消费的词条 schema:
term / aliases / form(词形) / domain(领域) / register(语域) / timeliness(时效)
/ sense_literal(本义) / sense_slang(黑话义) / example(例句) / stats(语料统计) / contexts(上下文)

同一个种子词可能对应多个候选词形(如 city不city -> city不/不city), 在此归并。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List


def build_lexicon(classified: Dict[str, dict]) -> List[dict]:
    merged: Dict[str, dict] = {}
    for term, info in classified.items():
        if info["status"] != "confirmed":
            continue
        seed = info["seed"]
        cand = info["candidate"]
        key = seed["term"]
        if key not in merged:
            merged[key] = {
                "term": seed["term"],
                "aliases": seed.get("aliases", []),
                "form": seed.get("form", "待标注"),
                "domain": seed.get("domain", "未分区"),
                "register": seed.get("register", "口语/网络"),
                "timeliness": seed.get("timeliness", "未知"),
                "scope": seed.get("scope", "general"),
                "sense_literal": seed.get("sense_literal", ""),
                "sense_slang": seed.get("sense_slang", ""),
                "note": seed.get("note", ""),
                "example": seed.get("example", ""),
                "stats": {"corpus_count": cand.count, "doc_freq": cand.doc_freq, "match": info["match"]},
                "contexts": list(cand.contexts),
            }
        else:
            m = merged[key]
            m["stats"]["corpus_count"] = max(m["stats"]["corpus_count"], cand.count)
            m["stats"]["doc_freq"] = max(m["stats"]["doc_freq"], cand.doc_freq)
            for ctx in cand.contexts:
                if ctx not in m["contexts"] and len(m["contexts"]) < 8:
                    m["contexts"].append(ctx)
    return sorted(merged.values(), key=lambda e: -e["stats"]["corpus_count"])


def save_json(obj, path: str) -> None:
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
