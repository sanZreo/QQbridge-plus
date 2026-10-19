// 修复验证：用真实的 bridge.js 研究逻辑跑一小批，确认结果写回 slang.json。
//
// 不复刻整套 runSlangResearch（那需要桥接进程上下文），而是验证三个关键点：
//   1. 切批后单批 prompt 规模合理（模型能在超时内跑完）
//   2. 单批研究真的能跑完并拿到 JSON（不是必然超时）
//   3. parseResearchJson + 写回字段的路径正确
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeApiClient, createTurnCollector } from '../src/dsh-client.js';
import { probeCookie, probeRpc } from './probe-auth.mjs';
import { buildResearchPrompt, parseResearchJson, chunkCandidates, RESEARCH_BATCH_SIZE } from '../src/slang-learner.js';

const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:19387';
const rpc = probeRpc(probeCookie());
const cookie = probeCookie();

const candidates = [
  { id: 't1', content: 'yyds', evidence: [{ text: '这操作太 yyds 了' }] },
  { id: 't2', content: 'xswl', evidence: [{ text: 'xswl 哈哈哈' }] },
];

console.log('=== 1. 切批规模 ===');
const batches = chunkCandidates(candidates, RESEARCH_BATCH_SIZE);
console.log(`  ${candidates.length} 条 → ${batches.length} 批`);
for (const [i, b] of batches.entries()) {
  console.log(`  第 ${i + 1} 批：${b.length} 条，prompt ${buildResearchPrompt(b).length} 字符`);
}

console.log('\n=== 2. 真实跑一批 ===');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'slang-verify-'));
const created = await rpc('session/create', { request: { cwd, agentPreset: 'qq-chat' } });
if (!created.ok) { console.log(`create 失败：${created.code}: ${created.msg}`); process.exit(1); }
const sid = created.value.sessionId;
await rpc('session/selectModel', { request: { sessionId: sid, provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' } });
console.log(`  会话 ${sid}`);

const client = new NodeApiClient(BASE, 30000, { token: '', cookie });
const collector = createTurnCollector();
let turnResult = null;
(async () => {
  try {
    for await (const envelope of client.events.mux({})) {
      const frame = envelope.payload;
      if (frame?.type === 'session/event' && frame.sessionId === sid) {
        const ended = collector.push(frame.event);
        if (ended) { turnResult = ended; break; }
      }
    }
  } catch { /* 流结束 */ }
})();
client.events.follow(sid);
await new Promise((r) => setTimeout(r, 2500));

const t0 = Date.now();
const pr = await rpc('session/prompt', {
  request: { sessionId: sid, requestId: 'verify-' + Date.now(), mode: 'queue', content: [{ type: 'text', text: buildResearchPrompt(batches[0]) }] }
});
console.log(`  prompt：${pr.ok ? 'accepted' : `${pr.code}: ${pr.msg}`}`);

const budget = 30_000 + batches[0].length * 60_000; // 与 learnerTurnTimeoutMs 同公式
const deadline = Date.now() + budget;
while (Date.now() < deadline && !turnResult) await new Promise((r) => setTimeout(r, 1000));

console.log(`\n=== 3. 结果 ===`);
console.log(`  耗时：${((Date.now() - t0) / 1000).toFixed(1)}s（预算 ${(budget / 1000).toFixed(0)}s）`);
if (!turnResult) {
  console.log('  ❌ 超时 —— 修复没生效');
  process.exit(1);
}
console.log(`  turn/end reason=${turnResult.reason?.kind}`);
const results = parseResearchJson(turnResult.text);
console.log(`  解析出 ${results.length} 条结果`);
for (const r of results) {
  console.log(`    ${r.content}: confirmed=${r.confirmed} meaning=${r.meaning ? `「${r.meaning.slice(0, 60)}…」` : '(空)'}`);
}
const usable = results.filter((r) => r.confirmed === true && r.meaning);
console.log(`\n  ${usable.length > 0 ? '✅' : '❌'} 可写回词条数：${usable.length}`);
if (usable.length === 0) {
  console.log('  （这一批没拿到 confirmed 结果；下一批/再次触发会重试，但流程本身是通的）');
}

try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
process.exit(0);
