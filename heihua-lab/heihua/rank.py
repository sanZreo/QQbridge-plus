"""步骤4: 候选过滤与打分排序.

综合得分 = 0.35*log频次 + 0.20*文档频率 + 0.20*左右信息熵 + 0.25*词形加分

词形加分逻辑: 黑话偏爱「缩写/混合/叠字/数字」等非常规词形, 纯常规双字词得分低。
打分只是粗排, 最终判定在步骤5。
"""
from __future__ import annotations

import math
import re
from typing import List

from .extract import Candidate

_ACRONYM = re.compile(r"[A-Za-z0-9]{2,6}")
_REDUP = re.compile(r"(.)\1(.)\2|(..)\2")


def form_features(term: str) -> dict:
    return {
        "is_latin": bool(re.fullmatch(r"[A-Za-z0-9]+", term)),
        "has_digit": any(ch.isdigit() for ch in term),
        "is_acronym": bool(_ACRONYM.fullmatch(term)),
        "is_reduplication": bool(_REDUP.fullmatch(term)),
        "length": len(term),
    }


def _form_bonus(ff: dict) -> float:
    if ff["is_acronym"]:
        return 1.0
    if ff["is_latin"] and ff["has_digit"]:
        return 0.8
    if ff["is_reduplication"]:
        return 0.8
    if ff["length"] >= 3:
        return 0.5
    return 0.3


def score_candidates(candidates: List[Candidate], top_n: int = 300) -> List[Candidate]:
    if not candidates:
        return []
    max_count = max(c.count for c in candidates)
    max_df = max(c.doc_freq for c in candidates) or 1
    max_ent = max(max(c.left_entropy, c.right_entropy) for c in candidates) or 1.0
    for c in candidates:
        ff = form_features(c.term)
        c.score = round(
            0.35 * math.log1p(c.count) / math.log1p(max_count)
            + 0.20 * c.doc_freq / max_df
            + 0.20 * max(c.left_entropy, c.right_entropy) / max_ent
            + 0.25 * _form_bonus(ff),
            4,
        )
        reasons = [f"出现{c.count}次/{c.doc_freq}篇"]
        if c.right_entropy >= 1.0:
            reasons.append("右搭配丰富")
        if ff["is_acronym"]:
            reasons.append("缩写形态")
        elif c.kind == "mixed":
            reasons.append("中西混合形态")
        elif ff["has_digit"]:
            reasons.append("数字形态")
        elif ff["is_reduplication"]:
            reasons.append("叠字形态")
        if c.pmi >= 3:
            reasons.append(f"PMI={c.pmi}结合紧密")
        c.reasons = reasons
    ranked = sorted(candidates, key=lambda x: (-x.score, -x.count, x.term))
    return ranked[:top_n]
