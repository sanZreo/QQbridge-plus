#!/usr/bin/env python3
"""LLM 语义判别轨: 把流水线的「待判别」候选交给 LLM 判定并补全含义.

机器(步骤 1-4)只能认词形; 「是不是黑话、是什么意思」必须语义判断 ——
这就是步骤 5 的 LLM 轨, 也是整个方法的质量关键。

默认接本机反向代理(127.0.0.1:8790, OpenAI 兼容, 需手动启动),
可用 --base-url / --model 换成任意兼容端点。

用法:
    python tools/llm_judge.py --corpus data/real_corpus.txt --out out-real --top 40
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from heihua.ingest import load_corpus  # noqa: E402
from heihua.clean import clean_corpus  # noqa: E402
from heihua.extract import extract_candidates  # noqa: E402
from heihua.rank import score_candidates  # noqa: E402
from heihua.classify import (  # noqa: E402
    load_seeds, classify, llm_classification_prompt, call_llm_backend,
)
from heihua.lexicon import save_json  # noqa: E402


def parse_judged(raw: str):
    """从模型输出里抠 JSON 数组: 先整体 parse, 失败再取第一个 [ 到最后一个 ]。"""
    text = str(raw or "").strip()
    if not text:
        return []
    try:
        data = json.loads(text)
        if isinstance(data, list):
            return data
    except ValueError:
        pass
    m = re.search(r"\[[\s\S]*\]", text)
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
        return data if isinstance(data, list) else []
    except ValueError:
        return []


def main() -> int:
    ap = argparse.ArgumentParser(description="LLM 语义判别轨")
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--seeds", default=str(Path(__file__).resolve().parent.parent / "data" / "seeds.json"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-count", type=int, default=2)
    ap.add_argument("--top", type=int, default=40, help="送 LLM 判别的候选数(按得分降序)")
    ap.add_argument("--batch", type=int, default=10)
    ap.add_argument("--base-url", default="http://127.0.0.1:8790/v1")
    ap.add_argument("--model", default="fast-model")
    ap.add_argument("--api-key", default="")
    args = ap.parse_args()

    corpus = clean_corpus(load_corpus(args.corpus))
    cands = extract_candidates(corpus.documents, min_count=args.min_count, min_df=1)
    ranked = score_candidates(cands, top_n=500)
    cls = classify(ranked, load_seeds(args.seeds))
    suspects = [v["candidate"] for v in cls.values() if v["status"] == "suspect"][: args.top]
    if not suspects:
        print("没有待判别候选")
        return 0
    print(f"送 LLM 轨 {len(suspects)} 个候选(base={args.base_url}, model={args.model})")

    judged = []
    for i in range(0, len(suspects), args.batch):
        batch = suspects[i:i + args.batch]
        try:
            raw = call_llm_backend(
                llm_classification_prompt(batch),
                base_url=args.base_url, model=args.model, api_key=args.api_key,
            )
        except Exception as exc:  # 网络/超时/解析失败都不阻断, 跳过该批
            print(f"  批次 {i // args.batch + 1} 失败: {exc}")
            continue
        items = [j for j in parse_judged(raw) if isinstance(j, dict) and j.get("term")]
        print(f"  批次 {i // args.batch + 1}: {len(items)} 条判定")
        judged.extend(items)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    save_json(judged, out / "llm_judged.json")

    slang = [j for j in judged if j.get("is_slang")]
    print(f"\n判定完成: {len(judged)} 条中 {len(slang)} 条判为黑话")
    for j in slang:
        print(f"  + {j['term']} — {j.get('sense', '')} (置信 {j.get('confidence')})")
    rejected = [j["term"] for j in judged if not j.get("is_slang")]
    if rejected:
        print(f"非黑话 {len(rejected)} 条: {'、'.join(rejected)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
