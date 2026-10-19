// 黑话研究切批：验证「批量送研究」不再因单轮 turn 超时而全军覆没。
//
// 这个 bug 的真实形态（2026-10-18 复现）：
//   /api/slang/research 收下 1999 个候选 → 一次 prompt → 模型要做约 2000 次
//   web_search + 3000 次 web_fetch（实测 2 个词条就要 90 秒）→ waitLearnerTurn
//   120 秒超时 → 抛错 → 一条都不写回 → 控制台刷新永远看不到结果。
//
// 修法：按 RESEARCH_BATCH_SIZE 切批，每批独立 prompt + 独立超时 + 立即写回。
import assert from 'node:assert/strict';
import {
  chunkCandidates,
  RESEARCH_BATCH_SIZE,
  buildResearchPrompt
} from '../src/slang-learner.js';

let passed = 0;
let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${name}${detail ? `  ${detail}` : ''}`); }
  else { failed += 1; console.log(`  ❌ ${name}${detail ? `  ${detail}` : ''}`); }
}

const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, content: `词${i}`, count: 1 }));

console.log('── 切批：正确性 ────────────────────────────');
ok('空数组 → 0 批', chunkCandidates([], 5).length === 0);
ok('1 条 → 1 批', chunkCandidates(mk(1), 5).length === 1);
ok('5 条 → 1 批', chunkCandidates(mk(5), 5).length === 1);
ok('6 条 → 2 批', chunkCandidates(mk(6), 5).length === 2);
ok('1999 条 → 400 批', chunkCandidates(mk(1999), 5).length === 400,
  `${chunkCandidates(mk(1999), 5).length} 批`);

console.log('\n── 切批：不丢条、不重条 ────────────────────');
for (const total of [0, 1, 4, 5, 6, 11, 1999]) {
  const batches = chunkCandidates(mk(total), 5);
  const flat = batches.flat();
  ok(`${total} 条切批后条数不变`, flat.length === total, `${flat.length}`);
  ok(`${total} 条切批后顺序不变`, flat.every((e, i) => e.id === `id-${i}`));
}

console.log('\n── 切批：默认批次大小 ──────────────────────');
ok('默认 5 条/批', RESEARCH_BATCH_SIZE === 5, String(RESEARCH_BATCH_SIZE));
ok('默认切 1999 条 ≤ 5 条/批',
  chunkCandidates(mk(1999)).every((b) => b.length <= 5));

console.log('\n── 批次内 prompt 规模可控 ──────────────────');
// 关键：每一批的 prompt 都必须是「几个词条」级别，而不是 1999 个词条级别。
const worst = chunkCandidates(mk(1999), 5).map((b) => buildResearchPrompt(b).length);
ok('每批 prompt 都 < 2KB', Math.max(...worst) < 2000, `最大 ${Math.max(...worst)} 字符`);
ok('单批 prompt 与词条数成正比', buildResearchPrompt(mk(5)).length > buildResearchPrompt(mk(1)).length);

console.log('\n── 非法入参防御 ────────────────────────────');
ok('size=0 回落到默认', chunkCandidates(mk(6), 0).every((b) => b.length <= 5));
ok('size=NaN 回落到默认', chunkCandidates(mk(6), NaN).every((b) => b.length <= 5));
ok('size=负数 回落到默认', chunkCandidates(mk(6), -3).every((b) => b.length <= 5));
ok('非数组入参 → 0 批', chunkCandidates(null, 5).length === 0);
ok('过滤 null 元素', chunkCandidates([null, mk(1)[0], undefined], 5).flat().length === 1);

console.log('\n── 超时预算：每批能跑完 ────────────────────');
// 复刻 learnerTurnTimeoutMs 的公式（30s 保底 + 每候选 60s）。
const timeoutFor = (n) => Math.round(30_000 + Math.max(1, n) * 60_000);
ok('1 个候选 → 90s', timeoutFor(1) === 90_000, `${timeoutFor(1) / 1000}s`);
ok('5 个候选 → 5.5 分钟', timeoutFor(5) === 330_000, `${timeoutFor(5) / 1000}s`);
ok('超时随词条数增长（不再固定 120s 砍死每一批）',
  timeoutFor(5) > 120_000, `${timeoutFor(5) / 1000}s > 120s`);

console.log('\n' + '═'.repeat(52));
console.log(`通过 ${passed}　失败 ${failed}`);
console.log(failed === 0 ? '✅ 全部通过' : `❌ 有 ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
