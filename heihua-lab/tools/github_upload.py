#!/usr/bin/env python3
"""通过 GitHub REST API 把本地 git 快照提交上传为目标仓库的一个提交.

为什么走 API 而不是 git push:
    本机到 github.com 的 git 端点不通(CONNECT 502 / 连接重置), 但 api.github.com 可达.
    API 只需要 blob -> tree -> commit -> ref 四个端点, 不依赖 git smart HTTP.

安全纪律:
    - token 从**本地文件**读取(不写进命令行/不打印)
    - 上传内容取自本地 git 对象(git cat-file blob), 与已核验的快照逐字节一致
    - 默认 dry-run: 只检查仓库状态与文件清单, 不发任何写请求

用法:
    python tools/github_upload.py --repo sanZreo/QQbridge-snowluma --token-file E:/workspace/.gh_token_local --dry-run
    python tools/github_upload.py --repo sanZreo/QQbridge-snowluma --token-file E:/workspace/.gh_token_local
"""
from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.github.com"


def api(method: str, path: str, token: str = "", body: dict | None = None, timeout: int = 60):
    url = API + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "heihua-lab-uploader")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw.strip() else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")[:400]
            if exc.code in (500, 502, 503, 504) and attempt < 2:
                time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError(f"{method} {path} -> HTTP {exc.code}: {detail}") from None
        except urllib.error.URLError as exc:
            if attempt < 2:
                time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError(f"{method} {path} -> 网络错误: {exc.reason}") from None
    raise RuntimeError("unreachable")


def git(repo: Path, *args: str) -> bytes:
    res = subprocess.run(["git", "-C", str(repo), *args], capture_output=True)
    if res.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败: {res.stderr.decode('utf-8', 'ignore')[:300]}")
    return res.stdout


def list_tree(repo: Path, commit: str):
    """返回 [(mode, sha, path)]; 用 -z + core.quotepath=false 正确处理中文路径."""
    out = git(repo, "-c", "core.quotepath=false", "ls-tree", "-r", "-z", commit)
    entries = []
    for rec in out.split(b"\x00"):
        if not rec:
            continue
        meta, path = rec.split(b"\t", 1)
        mode, typ, sha = meta.decode().split()
        if typ != "blob":
            continue
        entries.append((mode, sha, path.decode("utf-8")))
    return entries


def main() -> int:
    ap = argparse.ArgumentParser(description="GitHub API 上传器")
    ap.add_argument("--repo", default="sanZreo/QQbridge-snowluma", help="owner/name")
    ap.add_argument("--repo-dir", default="E:/workspace/qq-bridge", help="本地 git 仓库")
    ap.add_argument("--commit-file", default="", help="含 commit sha 的文件(默认 .git/snapshot_commit.txt)")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--token-file", default="E:/workspace/.gh_token_local")
    ap.add_argument("--message", default="snapshot: qq-bridge 工作树快照 (2026-10-19)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    repo = Path(args.repo_dir)
    commit_file = Path(args.commit_file) if args.commit_file else repo / ".git" / "snapshot_commit.txt"
    if not commit_file.exists():
        print(f"找不到快照提交记录: {commit_file}", file=sys.stderr)
        return 1
    commit = commit_file.read_text(encoding="utf-8").strip()
    entries = list_tree(repo, commit)
    total = sum(len(git(repo, "cat-file", "blob", sha)) for _, sha, _ in entries)
    print(f"快照提交: {commit[:12]} | 文件 {len(entries)} 个 | 合计 {total / 1048576:.1f} MB")

    token = ""
    token_path = Path(args.token_file)
    if token_path.exists():
        token = token_path.read_text(encoding="utf-8").strip()
        print(f"token: 已从 {token_path} 读取({len(token)} 字符)")
    else:
        print(f"token: 未找到 {token_path}（dry-run 不需要; 真正上传必须提供)")

    repo_info = api("GET", f"/repos/{args.repo}", token)
    print(f"目标仓库: {repo_info.get('full_name')} | private={repo_info.get('private')} "
          f"| 默认分支={repo_info.get('default_branch')} | size={repo_info.get('size')}KB")
    # 用仓库数字 ID 作基路径: 按 owner/name 拼的写请求会被 307 重定向到 /repositories/<id>/...,
    # 而 urllib 不会带着 POST body 跟随 307 —— 直接用 ID 路径, 一步到位。
    api_base = f"/repositories/{repo_info['id']}"
    print(f"仓库 ID: {repo_info['id']}")
    if token:
        me = api("GET", "/user", token)
        print(f"token 身份: {me.get('login')}")

    if args.dry_run:
        print(f"\nDRY-RUN: 将上传 {len(entries)} 个 blob -> 1 个 tree -> 1 个 commit -> refs/heads/{args.branch}")
        for mode, sha, path in entries[:8]:
            print(f"  {mode} {sha[:8]} {path}")
        print(f"  … 共 {len(entries)} 个")
        return 0

    if not token:
        print("\n缺少 token, 无法上传。把 PAT 写到 --token-file 指向的文件后重试。", file=sys.stderr)
        return 2

    # 1) blob
    tree_items = []
    for i, (mode, sha, path) in enumerate(entries, 1):
        content = git(repo, "cat-file", "blob", sha)
        blob = api("POST", f"{api_base}/git/blobs", token,
                   {"content": base64.b64encode(content).decode("ascii"), "encoding": "base64"})
        tree_items.append({"path": path, "mode": mode, "type": "blob", "sha": blob["sha"]})
        if i % 20 == 0 or i == len(entries):
            print(f"  blob {i}/{len(entries)}")

    # 2) tree
    tree = api("POST", f"{api_base}/git/trees", token, {"tree": tree_items})
    print(f"  tree {tree['sha'][:12]}")

    # 3) commit —— 若远端分支已有提交, 以它为父(快进, 不破坏既有历史)
    parent = None
    try:
        ref = api("GET", f"{api_base}/git/ref/heads/{args.branch}", token)
        parent = ref["object"]["sha"]
        print(f"  远端 {args.branch} 现有 {parent[:12]}, 新提交以它为父(快进)")
    except RuntimeError as exc:
        if "404" not in str(exc):
            raise
        print(f"  远端 {args.branch} 为空, 新提交为根提交")
    author = {"name": "sanZreo", "email": "sanZreo@users.noreply.github.com"}
    commit_body = {"message": args.message, "tree": tree["sha"], "author": author, "committer": author}
    if parent:
        commit_body["parents"] = [parent]
    new_commit = api("POST", f"{api_base}/git/commits", token, commit_body)
    print(f"  commit {new_commit['sha'][:12]}")

    # 4) ref(空仓库时创建; 已有同名分支则快进)
    try:
        api("POST", f"{api_base}/git/refs", token,
            {"ref": f"refs/heads/{args.branch}", "sha": new_commit["sha"]})
        print(f"  ref refs/heads/{args.branch} 已创建")
    except RuntimeError as exc:
        if "422" not in str(exc):
            raise
        api("PATCH", f"{api_base}/git/refs/heads/{args.branch}", token,
            {"sha": new_commit["sha"], "force": False})
        print(f"  ref refs/heads/{args.branch} 已更新")

    # 5) 校验
    check = api("GET", f"{api_base}/git/trees/{args.branch}?recursive=1", token)
    n = len([x for x in check.get("tree", []) if x.get("type") == "blob"])
    print(f"\n校验: 远端 {args.branch} 上 blob 数 = {n}（本地 {len(entries)}）{'✅' if n == len(entries) else '❌'}")
    print(f"提交地址: https://github.com/{args.repo}/commit/{new_commit['sha']}")
    return 0 if n == len(entries) else 3


if __name__ == "__main__":
    raise SystemExit(main())
