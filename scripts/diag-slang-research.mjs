// 黑话研究链路诊断：为什么「批量送研究」后刷新看不到结果。
//
// 直接查 DSH 侧 learner 会话的真实状态，而不是猜：
//   · session/list 里那个 learner 会话还在不在、挂没挂 agent
//   · 它的 inbox 有没有堆积的 prompt
//   · follow 该会话能否收到 turn 事件
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeCookie, probeRpc } from './probe-auth.mjs';

const STATE = path.join(process.cwd(), 'state');
const SESSION_FILE = path.join(STATE, 'slang-session.json');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

const saved = readJson(SESSION_FILE);
console.log('=== learner 会话记录 ===');
if (!saved) {
  console.log('  state/slang-session.json 不存在 → 从没创建过学习会话');
} else {
  console.log(`  sessionId = ${saved.sessionId}`);
  console.log(`  preset    = ${saved.preset}`);
}

const rpc = probeRpc(probeCookie());

console.log('\n=== session/list ===');
const list = await rpc('session/list', { _request: {} });
if (!list.ok) {
  console.log(`  ❌ ${list.code}: ${list.msg}`);
  process.exit(1);
}
const sessions = list.value?.sessions ?? list.value ?? [];
const arr = Array.isArray(sessions) ? sessions : [];
console.log(`  共 ${arr.length} 个会话`);
const learner = arr.find((s) => s?.sessionId === saved?.sessionId);
if (saved?.sessionId && !learner) {
  console.log(`  ⚠️ learner 会话 ${saved.sessionId} 已不在列表里（DSH 重启后失效）`);
}
if (learner) {
  console.log(`  learner 会话现状：`);
  console.log(`    ${JSON.stringify(learner).slice(0, 600)}`);
}

console.log('\n=== 黑话库统计 ===');
const slang = readJson(path.join(STATE, 'slang.json'));
if (Array.isArray(slang)) {
  const byStatus = {};
  for (const e of slang) byStatus[e.status] = (byStatus[e.status] || 0) + 1;
  console.log(`  共 ${slang.length} 条  ${JSON.stringify(byStatus)}`);
  const withMeaning = slang.filter((e) => e.meaning).length;
  console.log(`  有 meaning 的：${withMeaning} 条`);
  const cands = slang.filter((e) => e.status === 'candidate');
  console.log(`  候选待研究：${cands.length} 条`);
  const reachable = cands.filter((e) => e.count >= 2).length;
  console.log(`  其中 count>=2（达到自动研究阈值）的：${reachable} 条`);
  console.log(`  count 分布：${JSON.stringify(cands.reduce((a, e) => { const k = e.count; a[k] = (a[k] || 0) + 1; return a; }, {}))}`);
  console.log(`  lastInferenceCount>0 的：${slang.filter((e) => e.lastInferenceCount > 0).length} 条`);
} else {
  console.log('  slang.json 读不到');
}

console.log('\n=== 新建一个测试会话，验证 follow + turn 事件链路 ===');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'slang-diag-'));
const created = await rpc('session/create', { request: { cwd, agentPreset: 'qq-chat' } });
if (!created.ok) {
  console.log(`  ❌ session/create 失败：${created.code}: ${created.msg}`);
  process.exit(1);
}
const sid = created.value.sessionId;
console.log(`  已创建 ${sid}`);

const sel = await rpc('session/selectModel', {
  request: { sessionId: sid, provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' }
});
console.log(`  selectModel：${sel.ok ? '✅' : `❌ ${sel.code}: ${sel.msg}`}`);

console.log('\n=== 等 25 秒看是否有 turn 事件（不发 prompt，只验证 follow） ===');
console.log('  （如果连 follow 都收不到事件，说明问题在事件流不在 prompt）');
