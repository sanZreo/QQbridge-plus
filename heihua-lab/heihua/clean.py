"""步骤2: 清洗与预处理.

- Unicode NFKC 归一化(全角转半角、兼容字符折叠)
- 去除 URL / @提及
- 去掉首尾标点, 压缩空白
- 剔除清洗后过短的文档(默认 < 4 字)
"""
from __future__ import annotations

import re
import unicodedata
from typing import List

from .ingest import Corpus, Document

_URL = re.compile(r"https?://\S+")
_MENTION = re.compile(r"[@＠]\w+")
_WS = re.compile(r"\s+")
_EDGE_PUNCT = ' \t\r\n!-/:-@[-`{-~，。！？、；：""''（）…—～·'


def normalize_text(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = _WS.sub(" ", text)
    return text.strip()


def clean_document(doc: Document) -> Document:
    text = normalize_text(doc.text)
    text = _URL.sub(" ", text)
    text = _MENTION.sub(" ", text)
    text = normalize_text(text).strip(_EDGE_PUNCT).strip()
    return Document(doc.doc_id, doc.source, text)


def clean_corpus(corpus: Corpus, min_len: int = 4) -> Corpus:
    """清洗 + 复读去重.

    群聊有大量复读(同一条文本被多人复制刷屏), 不去重会让 n-gram 把重复串
    切出一堆重叠碎片(实测: 一条 144 次复读产出 9 个候选变体), 把真词挤出
    短名单。相同文本只保留一条, 次数让位给"多少条不同消息在用它"。
    """
    kept: List[Document] = []
    dropped = 0
    duplicates = 0
    seen = set()
    for doc in corpus.documents:
        cleaned = clean_document(doc)
        if len(cleaned.text) < min_len:
            dropped += 1
            continue
        if cleaned.text in seen:
            duplicates += 1
            continue
        seen.add(cleaned.text)
        kept.append(cleaned)
    stats = dict(corpus.stats)
    stats.update({
        "kept_documents": len(kept),
        "dropped_documents": dropped,
        "duplicate_documents": duplicates,
        "kept_chars": sum(len(d.text) for d in kept),
    })
    return Corpus(documents=kept, stats=stats)
