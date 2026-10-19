"""报告渲染: 把全链路产物写成人看的 Markdown 分析报告."""
from __future__ import annotations

from typing import Dict, List

_STATUS_LABEL = {"confirmed": "✅ 黑话", "suspect": "❓ 待判别", "low_priority": "· 低优先级", "fragment": "· 碎片"}


def render_report(corpus_stats: Dict, clean_stats: Dict, ranked: List,
                  classified: Dict, entries: List[dict], metrics: Dict, steps: List) -> str:
    L: List[str] = []
    L.append("# 黑话词库分析报告\n")
    L.append("> 由 heihua-lab 八步流水线自动生成。候选词为机器发现结果，**黑话确认仍需人工或 LLM 语义复核**。\n")
    L.append("## 一、总览\n")
    L.append(f"- 语料: {corpus_stats['documents']} 篇 / {corpus_stats['total_chars']} 字")
    L.append(f"- 清洗后: {clean_stats['kept_documents']} 篇 / {clean_stats['kept_chars']} 字"
             f"(剔除 {clean_stats['dropped_documents']} 篇噪声, 合并复读 {clean_stats.get('duplicate_documents', 0)} 篇)")
    L.append(f"- 候选词: {len(ranked)} 个进入排序; 确认黑话 {len(entries)} 条, 待判别 {metrics['suspect_count']} 个")
    L.append(f"- 种子词库覆盖率: {metrics['coverage'] * 100:.1f}%; Top{metrics['eval_top_n']} 候选召回率: {metrics['topn_recall'] * 100:.1f}%\n")

    L.append("## 二、流水线执行摘要\n")
    L.append("| 步骤 | 输入 | 输出 | 关键数字 |")
    L.append("| --- | --- | --- | --- |")
    for name, inp, outp, key in steps:
        L.append(f"| {name} | {inp} | {outp} | {key} |")

    L.append("\n## 三、Top 候选词(按综合得分)\n")
    L.append("| # | 候选词 | 形态 | 次数 | 篇数 | 左熵 | 右熵 | 得分 | 判别 |")
    L.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for i, c in enumerate(ranked[:30], 1):
        info = classified.get(c.term, {})
        label = _STATUS_LABEL.get(info.get("status"), "?")
        L.append(f"| {i} | {c.term} | {c.kind} | {c.count} | {c.doc_freq} | {c.left_entropy:.2f} | {c.right_entropy:.2f} | {c.score:.3f} | {label} |")

    L.append("\n## 四、已确认黑话词条\n")
    L.append("| 词条 | 词形 | 领域 | 黑话义 | 语料次数 |")
    L.append("| --- | --- | --- | --- | --- |")
    for e in entries:
        L.append(f"| {e['term']} | {e['form']} | {e['domain']} | {e['sense_slang']} | {e['stats']['corpus_count']} |")

    L.append("\n## 五、分布统计\n")
    L.append("**词形分布**: " + (", ".join(f"{k} {v}条" for k, v in metrics["form_distribution"].items()) or "无"))
    L.append("")
    L.append("**领域分布**: " + (", ".join(f"{k} {v}条" for k, v in metrics["domain_distribution"].items()) or "无") + "\n")

    L.append("## 六、评估指标\n")
    L.append("| 指标 | 数值 | 说明 |")
    L.append("| --- | --- | --- |")
    L.append(f"| 种子总数 | {metrics['seeds_total']} | 种子词库词条数 |")
    L.append(f"| 已确认 | {metrics['seeds_confirmed']} | 在语料中命中的种子词 |")
    L.append(f"| 覆盖率 | {metrics['coverage'] * 100:.1f}% | 已确认 / 种子总数 |")
    L.append(f"| Top{metrics['eval_top_n']} 召回率 | {metrics['topn_recall'] * 100:.1f}% | 种子进入 Top 候选的比例 |")
    L.append(f"| 待判别候选 | {metrics['suspect_count']} | 形态可疑但未确认, 需 LLM/人工判定 |")
    L.append(f"| 碎片抑制 | {metrics['fragment_count']} | 被更长词形覆盖的 n-gram 碎片, 不进词库也不占短名单 |")
    L.append(f"| 低优先级候选 | {metrics['low_priority_count']} | 常规词形, 一般不是黑话 |")
    missing = "、".join(metrics["seeds_not_in_corpus"]) if metrics["seeds_not_in_corpus"] else "无(全部命中)"
    L.append(f"| 未命中种子 | {missing} | 提示语料覆盖不足或词形未被捕获 |\n")

    L.append("## 七、人工复核指引\n")
    L.append("1. 看第三节「待判别」候选: 机器只认词形, 黑话与否取决于语义。")
    L.append("2. 看附录上下文: 判断该词在本语境中是本义还是黑话义。")
    L.append("3. 抽查已确认词条的 sense_slang 是否与语料实际用法一致。")
    L.append("4. 复核后的结论写回种子词库(data/seeds.json), 下一轮流水线自动继承。\n")

    L.append("## 八、已知局限性\n")
    L.append("- 无分词词典, 中文候选靠 n-gram, 长词可能被切碎, 需靠子串匹配与人工合并兜底。")
    L.append("- 左右信息熵按单字上下文计算, 对短语级黑话(如「那咋了」)区分度有限。")
    L.append("- 规则判别只能确认「已知词形」, 真正的新词发现依赖步骤5 的 LLM 轨。")
    L.append("- 时效性判断弱: 词是否过时需要外部时间信号(发布平台、时间戳)。\n")

    L.append("## 附录: 样例上下文(供复核)\n")
    for e in entries[:8]:
        L.append(f"- **{e['term']}**: " + " ｜ ".join(e["contexts"][:3]))
    return "\n".join(L) + "\n"
