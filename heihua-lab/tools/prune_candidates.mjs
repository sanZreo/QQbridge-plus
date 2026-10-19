#!/usr/bin/env node
// 从 qq-bridge 的 state/slang.json 里清理**低价值候选**, 给新候选腾出 2000 上限容量。
//
// 纪律：
//   - 默认 dry-run，只打印清理计划，不写任何文件；--apply 才落盘
//   - 只动 status=candidate；confirmed/rejected 一律不碰（确认是人工闸门产物）
//   - 落盘前自动备份；写入用 临时文件 + rename 原子替换
//   - 清理标准是「规范执法」不是语义判断：超长/含标点/陈旧 都是可机器判定的
//
// 用法：
//   node tools/prune_candidates.mjs [--slang <path>] [--over-len 8] [--has-punct]
//                                   [--stale-days 7] [--bottom K] [--apply]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

function argValue(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
function argNum(name, dflt) {
  const v = argValue(name, null);
  if (v === null) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

const SLANG_FILE = argValue('--slang', 'E:/workspace/qq-bridge/state/slang.json');
const OVER_LEN = argNum('--over-len', 8);       // 内容长度 > 8 字: 违反项目 2~8 字提取规范
const HAS_PUNCT = args.includes('--has-punct'); // 含标点/空格: 是短语不是词
const STALE_DAYS = argNum('--stale-days', 7);   // 超过 N 天没更新仍是 candidate
const BOTTOM_K = argNum('--bottom', 0);         // 额外清 triage(证据数×次数) 最低的 K 条
const MAX_ENTRIES = 2000;

const PUNCT_RE = /[ ,.?!,。？！、;；:：~…—"'""''()（）]/;

function readJsonArray(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`读取失败 ${file}: ${error.message}`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return fallback;
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${file} 顶层不是数组`);
  return parsed;
}

function ageDays(iso) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 86400000;
}

const triage = (e) => (Array.isArray(e.evidence) ? e.evidence.length : 0) * (Number(e.count) || 0);

const bank = readJsonArray(SLANG_FILE, []);
const candidates = bank.filter((e) => e.status === 'candidate');
const others = bank.filter((e) => e.status !== 'candidate');

const proposed = [];
for (const e of candidates) {
  const reasons = [];
  if (OVER_LEN > 0 && String(e.content ?? '').length > OVER_LEN) {
    reasons.push(`超长${String(e.content).length}字(规范上限${OVER_LEN})`);
  }
  if (HAS_PUNCT && PUNCT_RE.test(String(e.content ?? ''))) {
    reasons.push('含标点/空格(短语非词)');
  }
  if (STALE_DAYS > 0 && ageDays(e.updatedAt) >= STALE_DAYS) {
    reasons.push(`陈旧${Math.floor(ageDays(e.updatedAt))}天未审核`);
  }
  if (reasons.length) proposed.push({ e, reasons });
}

// --bottom K: 在剩余候选里再挑 triage 最低的 K 条(默认 0 = 不启用)
let extra = [];
if (BOTTOM_K > 0) {
  const chosen = new Set(proposed.map((p) => p.e.id));
  extra = candidates
    .filter((e) => !chosen.has(e.id))
    .sort((a, b) => triage(a) - triage(b) || ageDays(b.updatedAt) - ageDays(a.updatedAt))
    .slice(0, BOTTOM_K)
    .map((e) => ({ e, reasons: [`triage=${triage(e)}(证据×次数垫底)`] }));
}

const all = [...proposed, ...extra];
const dropIds = new Set(all.map((p) => p.e.id));
const kept = bank.filter((e) => !dropIds.has(e.id));

console.log('='.repeat(64));
console.log(`词库: ${SLANG_FILE}`);
console.log(`候选 ${candidates.length} 条(confirmed/rejected ${others.length} 条不碰)`);
console.log(`标准: 超长>${OVER_LEN}字${HAS_PUNCT ? ' + 含标点' : ''}${STALE_DAYS > 0 ? ` + 陈旧>=${STALE_DAYS}天` : ''}${BOTTOM_K > 0 ? ` + triage垫底${BOTTOM_K}条` : ''}`);
console.log(`计划清理 ${all.length} 条, 保留 ${kept.length} 条(上限 ${MAX_ENTRIES}${kept.length <= MAX_ENTRIES ? ' ✓' : ' ✗'})`);
console.log(`模式: ${APPLY ? 'APPLY（落盘）' : 'DRY-RUN（不写文件，加 --apply 落盘）'}`);
console.log('='.repeat(64));
const showLimit = all.length <= 100 ? all.length : 60; // 批量确认要看全清单, 超过 100 条才截断
for (const { e, reasons } of all.slice(0, showLimit)) {
  console.log(`  - ${String(e.content).slice(0, 30)} [${reasons.join('; ')}]`);
}
if (all.length > showLimit) console.log(`  …另有 ${all.length - showLimit} 条`);
if (!all.length) console.log('  没有符合条件的候选');

if (!APPLY) process.exit(0);

let backup = null;
if (fs.existsSync(SLANG_FILE)) {
  backup = `${SLANG_FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(SLANG_FILE, backup);
}
const tmp = `${SLANG_FILE}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(kept, null, 2), { encoding: 'utf8' });
fs.renameSync(tmp, SLANG_FILE);
console.log(`\n已清理 ${all.length} 条, 写入 ${SLANG_FILE}（余 ${kept.length} 条）`);
if (backup) console.log(`备份: ${backup}`);
