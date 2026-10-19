"""八步流水线编排.

输入: 语料文件 + 种子词库
输出(out 目录):
- lexicon.json            结构化词库
- llm_prompt_pack.md      可直接投喂 LLM 的提示词包
- llm_lexicon_view.json   词库的精简 JSON 视图
- qq_candidates.json       qq-bridge state/slang.json 兼容的候选条目(candidate+evidence+scope, 绝不直接 confirmed)
- qq_prompt_injection.md  QQ 群聊注入片段(与 buildSlangContext 同格式)
- eval.json               评估指标
- analysis_report.md      人读分析报告
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, List

from . import __version__
from .ingest import load_corpus
from .clean import clean_corpus
from .extract import extract_candidates
from .rank import score_candidates
from .classify import load_seeds, classify
from .lexicon import build_lexicon, save_json
from .llm_adapter import build_prompt_pack, build_qq_injection, build_qq_candidates
from .evaluate import evaluate
from .report import render_report


def _load_corpus_meta(corpus_path: str) -> List[dict]:
    """读取 <corpus>.meta.jsonl（可选）。缺失或损坏时返回空表，流水线照常跑。"""
    import json
    meta_path = Path(corpus_path).with_suffix(".meta.jsonl")
    if not meta_path.exists():
        return []
    rows: List[dict] = []
    try:
        with meta_path.open("r", encoding="utf-8") as fh:
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
    except OSError:
        return []
    return rows


def run_pipeline(
    corpus_path: str,
    seeds_path: str,
    out_dir: str,
    min_count: int = 2,
    min_df: int = 1,
    top_n: int = 300,
    eval_top_n: int = 50,
) -> Dict:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    # 步骤 1-2: 采集与清洗
    corpus = load_corpus(corpus_path)
    cleaned = clean_corpus(corpus)
    # 证据元数据（可选）：export_corpus.py 产出的 <corpus>.meta.jsonl，与语料行一一对应。
    # 有它，候选条目就能带上可回溯的 {key, sender, time}；没有就只给文本片段。
    corpus_meta = _load_corpus_meta(corpus_path)

    # 步骤 3-4: 候选发现与打分
    candidates = extract_candidates(cleaned.documents, min_count=min_count, min_df=min_df)
    ranked = score_candidates(candidates, top_n=top_n)

    # 步骤 5: 黑话判别
    seeds = load_seeds(seeds_path)
    classified = classify(ranked, seeds)
    confirmed_n = sum(1 for v in classified.values() if v["status"] == "confirmed")
    suspect_n = sum(1 for v in classified.values() if v["status"] == "suspect")
    fragment_n = sum(1 for v in classified.values() if v["status"] == "fragment")

    # 步骤 6-7: 词库构建与 LLM 适配
    entries = build_lexicon(classified)
    pack = build_prompt_pack(entries)
    # 步骤 8: 评估
    metrics = evaluate(seeds, ranked, classified, entries, top_n=eval_top_n)

    # 落盘
    save_json({"version": __version__, "generated_by": "heihua-lab", "count": len(entries), "entries": entries},
              out / "lexicon.json")
    save_json(pack["json_view"], out / "llm_lexicon_view.json")
    (out / "llm_prompt_pack.md").write_text(pack["markdown"], encoding="utf-8")
    save_json(build_qq_candidates(entries, corpus_meta=corpus_meta), out / "qq_candidates.json")
    (out / "qq_prompt_injection.md").write_text(build_qq_injection(entries), encoding="utf-8")
    save_json(metrics, out / "eval.json")

    steps = [
        ("1 语料采集", "原始文件(txt/md/jsonl)", "Document 列表",
         f"{corpus.stats['documents']} 篇 / {corpus.stats['total_chars']} 字"),
        ("2 清洗预处理", "Document 列表", "干净语料",
         f"保留 {cleaned.stats['kept_documents']} 篇, 剔除 {cleaned.stats['dropped_documents']} 篇噪声, "
         f"合并复读 {cleaned.stats.get('duplicate_documents', 0)} 篇"),
        ("3 候选词发现", "干净语料", f"{len(candidates)} 个候选",
         f"n-gram(2-5)+缩写+混合+数字, 频次>={min_count}, 跨>={min_df}篇"),
        ("4 打分排序", "候选集", f"Top {len(ranked)}",
         "log频次 + 文档频率 + 左右信息熵 + 词形加分"),
        ("5 黑话判别", "Top 候选", f"{confirmed_n} 确认 / {suspect_n} 待判别 / {fragment_n} 碎片抑制",
         "种子词库匹配; LLM 轨可选(见 README)"),
        ("6 词库构建", "判别结果", f"{len(entries)} 条词条",
         "lexicon.json(词形归并 + 义项结构化)"),
        ("7 LLM 适配", "词库", "提示词包 + QQ 候选",
         "llm_prompt_pack.md / qq_candidates.json / qq_prompt_injection.md"),
        ("8 评估质检", "全链路产物", f"覆盖率 {metrics['coverage'] * 100:.1f}%",
         f"Top{metrics['eval_top_n']} 召回 {metrics['topn_recall'] * 100:.1f}%; eval.json + 本报告"),
    ]
    report = render_report(corpus.stats, cleaned.stats, ranked, classified, entries, metrics, steps)
    (out / "analysis_report.md").write_text(report, encoding="utf-8")

    return {
        "out_dir": str(out),
        "documents": cleaned.stats["kept_documents"],
        "candidates": len(candidates),
        "ranked": len(ranked),
        "confirmed": confirmed_n,
        "suspect": suspect_n,
        "fragment": fragment_n,
        "entries": len(entries),
        "coverage": metrics["coverage"],
    }
