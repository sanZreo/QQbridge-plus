#!/usr/bin/env python3
"""从 qq-bridge 的消息库导出黑话分析语料.

数据源: snowluma 的 messages.db(OneBot v11 事件 JSON 存在 data 列),
以**只读模式**打开, 绝不去碰运行中机器人的库(不触发 WAL checkpoint)。

导出规则:
- 默认只导群聊(is_group=1); --include-private 才含私聊
- 排除机器人自己的消息(user_id == self_id): 那是 LLM 生成的, 不是群友语料
- 只取 text 段拼接, 天然丢掉图片/语音/at/face 等非文本段
- 清掉残留的 [CQ:...] 码; 短于 --min-len(默认 4)字的丢弃
- 输出: 一行一条消息的 txt(heihua-lab 的语料格式) + 一个 sidecar json
  (各群消息量分布, 供群作用域分析参考)

用法:
    python tools/export_corpus.py [--db <messages.db>] [--out <corpus.txt>] [--min-len 4]
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

_CQ_CODE = re.compile(r"\[CQ:[^\]]*\]")
_WS = re.compile(r"\s+")


def extract_event(data_json: str):
    """返回 dict(text, user_id, self_id, time, sender) 或 None(解析失败)."""
    try:
        d = json.loads(data_json)
    except (ValueError, TypeError):
        return None
    if not isinstance(d, dict):
        return None
    segs = d.get("message")
    if isinstance(segs, list):
        parts = [str((s.get("data") or {}).get("text") or "") for s in segs
                 if isinstance(s, dict) and s.get("type") == "text"]
        text = _CQ_CODE.sub(" ", " ".join(parts))
    else:
        text = _CQ_CODE.sub(" ", str(d.get("raw_message") or ""))
    text = _WS.sub(" ", text).strip()
    # 证据要能回溯到具体消息，所以必须带上发送者与**消息时间**（不是导出时间）。
    sender = d.get("sender") if isinstance(d.get("sender"), dict) else {}
    name = sender.get("card") or sender.get("nickname") or ""
    raw_time = d.get("time")
    try:
        # OneBot v11 的 time 是秒级 epoch；统一成 ms 与 qq-bridge evidence 对齐
        ts_ms = int(float(raw_time) * 1000) if raw_time is not None else 0
    except (TypeError, ValueError):
        ts_ms = 0
    return {
        "text": text,
        "user_id": d.get("user_id"),
        "self_id": d.get("self_id"),
        "time": ts_ms,
        "sender": str(name),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="从 messages.db 导出黑话分析语料")
    ap.add_argument("--db", default="E:/workspace/snowluma/data/100000003/messages.db")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "data" / "real_corpus.txt"))
    ap.add_argument("--min-len", type=int, default=4)
    ap.add_argument("--include-private", action="store_true", help="包含私聊(默认只导群聊)")
    ap.add_argument("--meta", dest="meta", action="store_true", default=True,
                    help="同时导出 .meta.jsonl(key/sender/time)，供证据回溯（默认开）")
    ap.add_argument("--no-meta", dest="meta", action="store_false", help="不导出 meta sidecar")
    args = ap.parse_args()

    db = Path(args.db)
    if not db.exists():
        print(f"数据库不存在: {db}", file=sys.stderr)
        return 1
    # mode=ro: 只读打开, 不写 WAL/SHM, 不影响正在运行的桥接
    con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    cur = con.cursor()
    rows = cur.execute(
        "SELECT is_group, session_id, data FROM messages WHERE data IS NOT NULL"
    ).fetchall()
    con.close()

    self_ids = set()
    lines, meta_lines, group_counter, skipped = [], [], Counter(), 0
    for is_group, session_id, data in rows:
        if not args.include_private and not is_group:
            continue
        ev = extract_event(data)
        if ev is None:
            skipped += 1
            continue
        text = ev["text"]
        user_id, self_id = ev["user_id"], ev["self_id"]
        if self_id is not None:
            self_ids.add(self_id)
            if str(user_id) == str(self_id):
                skipped += 1  # 机器人自己的消息: LLM 生成的, 不是群友语料
                continue
        if len(text) < args.min_len:
            skipped += 1
            continue
        lines.append(text)
        # 与 corpus 行**一一对应**的元数据：证据回溯靠它
        meta_lines.append({
            "key": f"group:{session_id}" if is_group else f"private:{session_id}",
            "sender": ev["sender"],
            "time": ev["time"],
            "text": text,
        })
        group_counter[str(session_id)] += 1

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")

    # meta sidecar：行序与 corpus 严格对齐（供 build_qq_candidates 生成可回溯证据）
    meta_path = out.with_suffix(".meta.jsonl")
    if args.meta:
        with meta_path.open("w", encoding="utf-8") as fh:
            for row in meta_lines:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    sidecar = out.with_suffix(".groups.json")
    sidecar.write_text(json.dumps({
        "db": str(db),
        "messages_total": len(rows),
        "exported": len(lines),
        "skipped": skipped,
        "self_ids": sorted(self_ids),
        "per_session": dict(group_counter.most_common()),
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"导出 {len(lines)} 条(库内 {len(rows)} 条, 跳过 {skipped})")
    print(f"语料: {out}")
    if args.meta:
        print(f"元数据(证据回溯用): {meta_path}")
    print(f"分布: {sidecar}")
    for sid, n in group_counter.most_common(10):
        print(f"  {sid}: {n} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
