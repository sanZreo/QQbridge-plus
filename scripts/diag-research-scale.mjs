// 量化「批量送研究」到底会造出多大的 prompt、模型要调多少次工具。
// 这是复现「刷新看不到结果」的直接手段：把 /api/slang/research 的真实入参
// （1999 条候选）喂给 buildResearchPrompt，看 prompt 规模。
import fs from 'node:fs';
import path from 'node:path';
import { buildResearchPrompt } from '../src/slang-learner.js';

const slang = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'state', 'slang.json'), 'utf8'));
const cands = slang.filter((e) => e.status === 'candidate');
console.log(`候选总数：${cands.length}`);

for (const n of [1, 5, 10, 20, 50, 100, cands.length]) {
  const batch = cands.slice(0, n);
  const p = buildResearchPrompt(batch);
  console.log(`  送 ${String(n).padStart(4)} 条 → prompt ${String(p.length).padStart(8)} 字符`);
}

console.log('\n=== 关键推算 ===');
const full = buildResearchPrompt(cands);
console.log(`全部候选一次送：prompt ${full.length} 字符`);
console.log('');
console.log('研究 prompt 要求模型对**每个**候选都：');
console.log('  1 次 web_search + 1~2 次 web_fetch');
console.log(`  → ${cands.length} 个候选 ≈ ${cands.length} 次 search + ~${Math.ceil(cands.length * 1.5)} 次 fetch`);
console.log('');
console.log('而 waitLearnerTurn 的超时是 120000ms（120 秒）。');
console.log('');
console.log('实测（本次会话）：研究 2 个词条走了 12 个 step、约 90+ 秒。');
console.log(`→ 按这个节奏，${cands.length} 条需要约 ${(cands.length / 2 * 90 / 60).toFixed(0)} 分钟以上。`);
console.log('');
console.log('结论：turn 必然在 120 秒超时 → 抛错 → 结果不写回 slang.json → 刷新看不到任何东西。');
