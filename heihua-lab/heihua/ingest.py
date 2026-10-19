"""步骤1: 语料采集.

支持两类输入:
- .txt / .md: 一行一篇文档(社交媒体帖子、聊天记录行等)
- .jsonl: 一行一个 JSON 对象, 取 text/content 字段为正文, source 字段为来源
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List


@dataclass
class Document:
    doc_id: str
    source: str
    text: str


@dataclass
class Corpus:
    documents: List[Document]
    stats: Dict = field(default_factory=dict)


def load_corpus(path: str) -> Corpus:
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"语料文件不存在: {path}")
    docs: List[Document] = []
    if path.suffix.lower() == ".jsonl":
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines()):
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            text = obj.get("text") or obj.get("content") or ""
            if not text:
                continue
            docs.append(Document(f"{path.name}#{i}", obj.get("source", path.name), text))
    else:
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines()):
            if not line.strip():
                continue
            docs.append(Document(f"{path.name}#{i + 1}", path.name, line.strip()))
    total_chars = sum(len(d.text) for d in docs)
    stats = {
        "files": [str(path)],
        "documents": len(docs),
        "total_chars": total_chars,
        "avg_chars": round(total_chars / len(docs), 1) if docs else 0,
    }
    return Corpus(documents=docs, stats=stats)
