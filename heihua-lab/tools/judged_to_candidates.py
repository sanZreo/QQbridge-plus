#!/usr/bin/env python3
"""把 LLM 语义判别的结果**转成可合并的候选条目**，补进 qq_candidates.json。

为什么需要这个东西（2026-10-19 评审结论）：
    tools/llm_judge.py 会把 Top-N 候选交给本地 LLM 判「是不是黑话」，产出 llm_judged.json；
    但那个文件**从来没有进入候选池** —— 也就是说"鲸鲸/老师"这类真新增只存在于判定记录里，
    既不能合并、也不能在控制台审核。判定跑得再好，产物不可交付等于零。

本工具做三件事：
    1. 取 is_slang=true 的条目，转成 qq-bridge schema（status=candidate, source=ai）
    2. 用真实语料补 evidence（{key, sender, text, time}）+ 统计 count
    3. 与已有 qq_candidates.json 按 content 去重后合并（默认 dry-run，--apply 才写）

用法：
    python tools/judged_to_candidates.py [--judged out-real/llm_judged.json]
        [--corpus data/real_corpus.txt] [--out out-real/qq_candidates.json] [--apply]
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def read_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    if not path.exists():
        return rows
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict) and row.get("text"):
                rows.append(row)
    return rows


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def main() -> int:
    ap = argparse.ArgumentParser(description="LLM 判别结果 → 可合并候选")
    ap.add_argument("--judged", default=str(ROOT / "out-real" / "llm_judged.json"))
    ap.add_argument("--corpus", default=str(ROOT / "data" / "real_corpus.txt"))
    ap.add_argument("--out", default=str(ROOT / "out-real" / "qq_candidates.json"))
    ap.add_argument("--scope", default="", help="强制作用域，如 group:100000001；默认按语料多数群推断")
    ap.add_argument("--apply", action="store_true", help="写入候选文件（默认 dry-run）")
    args = ap.parse_args()

    judged_path = Path(args.judged)
    judged = read_json(judged_path, [])
    if not isinstance(judged, list) or not judged:
        print(f"没有可用的判别结果: {judged_path}", file=sys.stderr)
        return 1

    slang = [j for j in judged if isinstance(j, dict) and j.get("is_slang")]
    if not slang:
        print("判别结果里没有 is_slang=true 的条目")
        return 0

    corpus_path = Path(args.corpus)
    meta_path = corpus_path.with_suffix(".meta.jsonl")
    meta = read_jsonl(meta_path)

    # 作用域：优先命令行指定，其次按语料里出现最多的群推断（群内昵称类必须收窄到单群）
    scope = args.scope
    if not scope:
        keys = Counter(str(m.get("key") or "") for m in meta if str(m.get("key") or "").startswith("group:"))
        scope = keys.most_common(1)[0][0] if keys else "general"

    ts = datetime.now(timezone.utc).isoformat()
    out_path = Path(args.out)
    existing = read_json(out_path, [])
    if not isinstance(existing, list):
        existing = []
    have = {str(e.get("content") or "").strip() for e in existing}

    added: list[dict] = []
    for item in slang:
        term = str(item.get("term") or "").strip()
        if not term or term in have:
            continue
        # 证据 + 计数都取自真实语料，没有对应行就不编造
        evidence, hits = [], 0
        for row in meta:
            text = str(row.get("text") or "")
            if term and term in text:
                hits += 1
                if len(evidence) < 5:
                    ev = {"text": text[:80]}
                    if row.get("key"):
                        ev["key"] = str(row["key"])
                    if row.get("sender"):
                        ev["sender"] = str(row["sender"])
                    if row.get("time"):
                        ev["time"] = int(row["time"])
                    evidence.append(ev)
        entry = {
            "id": f"heihua-llm-{term}",
            "content": term,
            "meaning": str(item.get("sense") or "").strip() or "（LLM 判别为黑话，语义待人工补充）",
            "usage": f"LLM判别｜{item.get('domain') or '未归类'}｜置信{float(item.get('confidence') or 0):.2f}",
            "example": "",
            "risk": f"LLM 语义判别（置信度 {float(item.get('confidence') or 0):.2f}，非精确概率）",
            "sources": [str(judged_path.name)],
            "aliases": [],
            "scope": scope,
            "status": "candidate",
            "source": "ai",
            "count": hits,
            "evidence": evidence,
            "lastInferenceCount": 0,
            "createdAt": ts,
            "updatedAt": ts,
        }
        added.append(entry)
        have.add(term)

    if not added:
        print("没有新增（都已在候选文件里）")
        return 0

    merged = existing + added
    print(f"判别得到黑话 {len(slang)} 条 → 新增候选 {len(added)} 条（scope={scope}）")
    for e in added:
        print(f"  + {e['content']} — {e['meaning'][:40]} | count {e['count']} | evidence {len(e['evidence'])}")
    if not args.apply:
        print("\nDRY-RUN：未写入。加 --apply 落盘到", out_path)
        return 0

    out_path.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n已写入 {out_path}（共 {len(merged)} 条候选）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
