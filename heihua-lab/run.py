#!/usr/bin/env python3
"""heihua-lab CLI 入口.

用法:
    python run.py --corpus data/demo_corpus.txt --out out
    python run.py --corpus chat_log.jsonl --seeds data/seeds.json --out out --min-count 3
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from heihua.pipeline import run_pipeline  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="黑话词库分析研究流水线(八步)")
    ap.add_argument("--corpus", required=True, help="语料文件: .txt/.md(一行一篇) 或 .jsonl")
    ap.add_argument("--seeds", default=None, help="种子词库 JSON(默认 data/seeds.json)")
    ap.add_argument("--out", default="out", help="输出目录(默认 out/)")
    ap.add_argument("--min-count", type=int, default=2, help="候选词最低出现次数(默认 2)")
    ap.add_argument("--min-df", type=int, default=1, help="候选词最低跨文档数(默认 1)")
    ap.add_argument("--top-n", type=int, default=300, help="进入排序的候选数上限(默认 300)")
    args = ap.parse_args()

    if args.seeds is None:
        args.seeds = str(Path(__file__).resolve().parent / "data" / "seeds.json")

    summary = run_pipeline(
        corpus_path=args.corpus,
        seeds_path=args.seeds,
        out_dir=args.out,
        min_count=args.min_count,
        min_df=args.min_df,
        top_n=args.top_n,
    )

    print("=" * 58)
    print("heihua-lab 八步流水线执行完毕")
    print(f"  输出目录 : {summary['out_dir']}")
    print(f"  语料文档 : {summary['documents']} 篇(清洗后)")
    print(f"  候选词   : {summary['ranked']} 个进入排序")
    print(f"  确认黑话 : {summary['entries']} 条(待判别 {summary['suspect']} 个, 碎片抑制 {summary['fragment']} 个)")
    print(f"  种子覆盖 : {summary['coverage'] * 100:.1f}%")
    print("  产物     : lexicon.json / llm_prompt_pack.md / llm_lexicon_view.json")
    print("             qq_candidates.json / qq_prompt_injection.md / eval.json / analysis_report.md")
    print("=" * 58)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
