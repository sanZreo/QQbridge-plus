"""步骤3: 候选词发现.

在干净语料上扫描四类候选形态:
- 中文 2-5 gram(黑话多为 2-4 字)
- 拉丁缩写词(yyds / xswl / nsdd)
- 中西文混合形态(i人 / e人 / city不city / 栓Q)
- 数字形态(996)

每个候选统计: 出现次数、文档频率、左右上下文信息熵(搭配丰富度),
双字中文候选另算 PMI(结合紧密程度)。上下文片段留样供人工/LLM 复核。
"""
from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Set

CJK_RUN = re.compile(r"[\u4e00-\u9fff]{2,}")
LATIN_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9]*")
MIXED_TOKEN = re.compile(r"(?:[A-Za-z0-9]{1,5}[\u4e00-\u9fff]|[\u4e00-\u9fff][A-Za-z0-9]{1,5})")
NUM_TOKEN = re.compile(r"[A-Za-z0-9]*\d[A-Za-z0-9]*")
NGRAM_RANGE = range(2, 6)

# 高频通用词/字, 用于压低通用搭配产生的噪声候选
STOPWORDS = {
    "的", "了", "是", "在", "我", "你", "他", "她", "它", "们", "个", "之", "和", "与",
    "及", "也", "都", "很", "就", "还", "又", "并", "但", "而", "却", "把", "被", "让",
    "使", "从", "到", "向", "于", "对", "为", "以", "其", "此", "该", "各", "每", "这",
    "那", "有", "没", "不", "会", "能", "要", "想", "说", "看", "去", "来", "做", "用",
    "我们", "你们", "他们", "她们", "它们", "咱们", "自己", "别人", "大家", "什么",
    "怎么", "怎样", "如何", "所以", "但是", "虽然", "如果", "那么", "然后", "现在",
    "已经", "曾经", "正在", "可以", "应该", "需要", "可能", "或者", "还是", "而且",
    "并且", "以及", "时候", "今天", "昨天", "明天", "今年", "去年", "早上", "晚上",
    "一下", "一天", "一些", "一种", "一样", "这样", "那样", "这么", "觉得", "认为",
    "知道", "希望", "真是", "真的", "有点", "非常", "特别", "比较", "超级", "没有",
    "不是", "不能", "不要", "这个", "那个", "这些", "那些", "的话", "什么是", "为什么",
    # 群聊高频功能词(真实语料实测补充)
    "一个", "还有", "感觉", "就是", "我的", "给我", "直接", "是我", "我要", "我说",
    "都是", "好吗", "出来", "来了", "你的", "这是", "是不", "你是", "有个", "好的",
    "好吧", "是吧", "对啊", "去了", "一会", "的时候", "是不是", "我们的", "你们的",
    "他们的", "了一个", "有没有", "怎么样", "什么的",
    # 群聊高频功能三字词(真实语料实测补充)
    "我还", "我也", "还没", "我是", "我一", "不知", "我不", "我去", "是一", "为什",
    "的时", "因为", "其实", "不过", "不知道", "起来的", "的时候",
}


@dataclass
class Candidate:
    term: str
    kind: str
    count: int = 0
    doc_freq: int = 0
    left_entropy: float = 0.0
    right_entropy: float = 0.0
    pmi: float = 0.0
    score: float = 0.0
    contexts: List[str] = field(default_factory=list)
    reasons: List[str] = field(default_factory=list)


def _prev(text: str, i: int) -> str:
    return text[i - 1] if i - 1 >= 0 else "^"


def _next(text: str, i: int) -> str:
    return text[i] if i < len(text) else "$"


def _entropy(counter: Counter) -> float:
    total = sum(counter.values())
    if total <= 1:
        return 0.0
    h = 0.0
    for c in counter.values():
        p = c / total
        h -= p * math.log2(p)
    return round(h, 3)


def kind_of(term: str) -> str:
    if LATIN_TOKEN.fullmatch(term):
        return "latin"
    if MIXED_TOKEN.fullmatch(term):
        return "mixed"
    if NUM_TOKEN.fullmatch(term):
        return "num"
    return "cjk"


def _iter_flat_matches(text: str):
    """扁平整词 + 中西/数字混合形态.

    同一区间只保留一个形态(优先级 latin > mixed > num), 避免重复计数。
    混合形态用程序化前后拼接实现, 不用一条正则: 正则方案里 "为i" 会抢先
    吃掉 "i", 导致 "i人" 这类 字母+汉字 词形整个匹配不到(实测坑)。
    """
    cjk = re.compile(r"[\u4e00-\u9fff]")
    spans: Dict[tuple, str] = {}
    for m in LATIN_TOKEN.finditer(text):
        s, e = m.start(), m.end()
        term = m.group()
        if len(term) >= 2:
            spans[(s, e)] = term
        # 后接单汉字 -> i人 / e人 / city不
        if e < len(text) and cjk.match(text[e]):
            spans.setdefault((s, e + 1), term + text[e])
        # 前接单汉字 -> 不city / 为i(后者是噪声, 交步骤4/5 过滤)
        if s - 1 >= 0 and cjk.match(text[s - 1]):
            spans.setdefault((s - 1, e), text[s - 1] + term)
    for m in NUM_TOKEN.finditer(text):
        spans.setdefault((m.start(), m.end()), m.group())
    for (start, end), term in sorted(spans.items()):
        yield term, _prev(text, start), _next(text, end)


def extract_candidates(
    documents: Iterable,
    min_count: int = 2,
    min_df: int = 1,
    max_contexts: int = 5,
    stopwords: Set[str] = None,
) -> List[Candidate]:
    stopwords = stopwords if stopwords is not None else STOPWORDS
    counts: Counter = Counter()
    dfs: Dict[str, Set[str]] = defaultdict(set)
    left_ctx: Dict[str, Counter] = defaultdict(Counter)
    right_ctx: Dict[str, Counter] = defaultdict(Counter)
    contexts: Dict[str, List[str]] = defaultdict(list)
    unigram: Counter = Counter()
    bigram_total = 0

    def record(term: str, doc_id: str, left: str, right: str) -> None:
        counts[term] += 1
        dfs[term].add(doc_id)
        left_ctx[term][left] += 1
        right_ctx[term][right] += 1
        if len(contexts[term]) < max_contexts:
            contexts[term].append(f"{left}〖{term}〗{right}")

    for doc in documents:
        text = doc.text
        for run in CJK_RUN.finditer(text):
            s = run.group()
            base = run.start()
            unigram.update(s)
            bigram_total += max(len(s) - 1, 0)
            for n in NGRAM_RANGE:
                for i in range(len(s) - n + 1):
                    g = s[i:i + n]
                    record(g, doc.doc_id, _prev(text, base + i), _next(text, base + i + n))
        for term, left, right in _iter_flat_matches(text):
            record(term, doc.doc_id, left, right)

    unigram_total = sum(unigram.values()) or 1
    candidates: List[Candidate] = []
    for term, c in counts.items():
        if term in stopwords or c < min_count or len(dfs[term]) < min_df:
            continue
        k = kind_of(term)
        pmi = 0.0
        if k == "cjk" and len(term) == 2 and bigram_total:
            pab = c / bigram_total
            pa = unigram[term[0]] / unigram_total
            pb = unigram[term[1]] / unigram_total
            pmi = math.log2(pab / (pa * pb)) if pa > 0 and pb > 0 else 0.0
        candidates.append(Candidate(
            term=term, kind=k, count=c, doc_freq=len(dfs[term]),
            left_entropy=_entropy(left_ctx[term]), right_entropy=_entropy(right_ctx[term]),
            pmi=round(pmi, 2), contexts=list(contexts[term]),
        ))
    candidates.sort(key=lambda x: (-x.count, x.term))
    return candidates
