#!/usr/bin/env node
// 把 heihua-lab 的 qq_candidates.json 合并进 qq-bridge 的 state/slang.json。
//
// 纪律（与架构评审结论一致）：
//   - 默认 dry-run，只打印合并计划，不写任何文件；--apply 才落盘
//   - 绝不把已 confirmed 的词降级回 candidate（确认是人工闸门的产物，
//     离线流水线每跑一次就改正式词库 = 评审明令禁止的行为）
//   - 合并前备份原文件；写入用 临时文件 + rename 原子替换
//   - 尊重 qq-bridge 的 SLANG_MAX_ENTRIES（2000）上限，超限拒绝 apply 并提示
//
// 用法：
//   node tools/merge_qq_candidates.mjs [--slang <path>] [--import <path>] [--apply] [--allow-demo]
//
// ⚠️ 为什么默认指向 out-real/ 并且给 demo 产物加闸（2026-10-19 评审发现）：
// 上一版的默认 --import 是 `out/qq_candidates.json`，那是 **demo 语料**（65 篇合成语料）的产物，
// 里面是「闭环/颗粒度/对齐/抓手/赋能」这类**职场黑话**。真实群语料里根本没有这些词
// （eval.json 的 seeds_not_in_corpus 就写着 赋能/抓手）。任何人顺手跑一次 --apply，
// 就会把 37 条职场词灌进这个动漫游戏群的词库 —— 这正是"通用词污染群内词库"的活体案例。
// 所以：默认指向真实语料产物；且 `--apply` 遇到 out/（demo）路径必须显式加 --allow-demo。
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALLOW_DEMO = args.includes('--allow-demo');

function argValue(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

const SLANG_FILE = argValue('--slang', 'E:/workspace/qq-bridge/state/slang.json');
const IMPORT_FILE = argValue('--import', 'E:/workspace/heihua-lab/out-real/qq_candidates.json');
const MAX_ENTRIES = 2000;

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

const existing = readJsonArray(SLANG_FILE, []);
const incoming = readJsonArray(IMPORT_FILE, []);
if (!incoming.length) {
  console.log('导入文件为空或不存在，无需合并:', IMPORT_FILE);
  process.exit(0);
}

// demo 产物护栏：out/ 是合成语料（职场黑话），out-real/ 才是真实群语料。
// 真落盘前必须显式确认，避免"顺手 apply 把通用词灌进群词库"。
// 注意：路径可能是相对的（`out/qq_candidates.json`），所以前缀要允许"开头即 out/"。
const DEMO_DIR_RE = /(^|[\\/])out([\\/]|$)/i;
const IS_DEMO_SOURCE = DEMO_DIR_RE.test(path.dirname(IMPORT_FILE))
  || DEMO_DIR_RE.test(IMPORT_FILE.replace(/[\\/][^\\/]*$/, ''));
if (APPLY && IS_DEMO_SOURCE && !ALLOW_DEMO) {
  console.error('⛔ 拒绝 apply：导入文件来自 demo 产物（' + IMPORT_FILE + '）');
  console.error('   demo 语料是合成的职场/网络词库，与真实群语料无关，合并会污染群内词库。');
  console.error('   要导真实语料产物：python run.py --corpus data/real_corpus.txt ... --out out-real');
  console.error('   确实要合并 demo 产物，请显式加 --allow-demo。');
  process.exit(2);
}

const byContent = new Map(existing.map((e) => [String(e.content ?? ''), e]));
const plan = { add: [], update: [], skip: [] };
for (const item of incoming) {
  const content = String(item.content ?? '').trim();
  if (!content) continue;
  const cur = byContent.get(content);
  if (!cur) {
    plan.add.push(item);
  } else if (cur.status === 'confirmed' || cur.status === 'rejected') {
    plan.skip.push(`${content}(${cur.status === 'confirmed' ? '已确认，不降级' : '已拒绝，不复活'})`);
  } else {
    plan.update.push({ content, patch: item });
  }
}

console.log('='.repeat(62));
console.log(`词库: ${SLANG_FILE} (${existing.length} 条)`);
console.log(`导入: ${IMPORT_FILE} (${incoming.length} 条)`);
console.log(`计划: 新增 ${plan.add.length} / 更新 ${plan.update.length} / 跳过 ${plan.skip.length}`);
if (plan.skip.length) console.log(`  跳过: ${plan.skip.join('、')}`);
if (existing.length + plan.add.length > MAX_ENTRIES) {
  console.log(`⚠ 合并后将超过 ${MAX_ENTRIES} 条上限（现有 ${existing.length} + 新增 ${plan.add.length}）——--apply 会被拒绝，请先在控制台清理候选。`);
}
console.log(`模式: ${APPLY ? 'APPLY（落盘）' : 'DRY-RUN（不写文件，加 --apply 落盘）'}`);
console.log('='.repeat(62));

if (!APPLY) {
  for (const e of plan.add.slice(0, 20)) console.log(`  + ${e.content} — ${e.meaning}`);
  if (plan.add.length > 20) console.log(`  …另有 ${plan.add.length - 20} 条`);
  process.exit(0);
}

if (existing.length + plan.add.length > MAX_ENTRIES) {
  console.error(`拒绝写入: 合并后将超过 ${MAX_ENTRIES} 条上限（现有 ${existing.length} + 新增 ${plan.add.length}）。请先在控制台清理候选。`);
  process.exit(1);
}

for (const e of plan.add) {
  existing.push({ ...e, id: e.id || `heihua-${e.content}-${Date.now().toString(36)}` });
}
for (const { content, patch } of plan.update) {
  const idx = existing.findIndex((e) => String(e.content ?? '') === content);
  if (idx < 0) continue;
  // 只补字段，不动 id/status/createdAt——更新不等于重新审核。
  existing[idx] = {
    ...existing[idx],
    meaning: patch.meaning ?? existing[idx].meaning,
    usage: patch.usage ?? existing[idx].usage,
    example: patch.example ?? existing[idx].example,
    risk: patch.risk ?? existing[idx].risk,
    aliases: Array.isArray(patch.aliases) ? patch.aliases : existing[idx].aliases,
    scope: patch.scope ?? existing[idx].scope,
    evidence: Array.isArray(patch.evidence) && patch.evidence.length ? patch.evidence : existing[idx].evidence,
    count: Math.max(Number(existing[idx].count) || 0, Number(patch.count) || 0),
    updatedAt: new Date().toISOString(),
  };
}

let backup = null;
if (fs.existsSync(SLANG_FILE)) {
  backup = `${SLANG_FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(SLANG_FILE, backup);
}
fs.mkdirSync(path.dirname(SLANG_FILE), { recursive: true });
const tmp = `${SLANG_FILE}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(existing, null, 2), { encoding: 'utf8' });
fs.renameSync(tmp, SLANG_FILE);
console.log(`已写入 ${SLANG_FILE}（现有 ${existing.length} 条）`);
if (backup) console.log(`备份: ${backup}`);
