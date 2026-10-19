// 复现桥接的 learner 会话全流程，精确定位 turn 事件在哪一步丢失。
// 关键：与桥接**用同一个 NodeApiClient 类**，同一个 follow 调用方式。
import fs from 'node:fs';
import path from 'node:path';
import { NodeApiClient, unwrap, createTurnCollector } from '../src/dsh-client.js';
import { probeCookie, probeRpc } from './probe-auth.mjs';

const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:19387';
const rpc = probeRpc(probeCookie());
const cookie = probeCookie();
const STATE = path.join(process.cwd(), 'state');

// ── 1. 与 ensureSlangLearnerSession 完全同构：建 workspace + session ─────────
const dir = path.join(STATE, 'slang-agent');
fs.mkdirSync(dir, { recursive: true });
const ws = await rpc('workspace/create', { request: { path: dir } });
if (!ws.ok) { console.log('workspace.create 失败:', ws.code, ws.msg); process.exit(1); }
const wsValue = ws.value;
const cr = await rpc('session/create', { request: { workspaceId: wsValue.workspace.workspaceId, agentPreset: 'qq-chat' } });
if (!cr.ok) { console.log('session.create 失败:', cr.code, cr.msg); process.exit(1); }
const sid = cr.value.sessionId;
console.log(`会话已建：${sid}`);

const sel = await rpc('session/selectModel', { request: { sessionId: sid, provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' } });
console.log(`selectModel：${sel.ok ? 'ok' : sel.code + ': ' + sel.msg}`);

// ── 2. 起事件流，先 follow，再 prompt（与桥接时序一致） ──────────────────────
const client = new NodeApiClient(BASE, undefined, { token: '', cookie });
const collector = createTurnCollector();
const types = [];
let turn = null;
(async () => {
  try {
    for await (const envelope of client.events.mux({})) {
      const frame = envelope.payload;
      if (frame?.type === 'session/event' && frame.sessionId === sid) {
        types.push(frame.event.type);
        const ended = collector.push(frame.event);
        if (ended) { turn = ended; break; }
      }
    }
  } catch (e) { console.log('流结束:', e?.message); }
})();

client.events.follow(sid);
console.log('已 follow，等 2.5 秒…');
await new Promise((r) => setTimeout(r, 2500));

console.log('发 prompt…');
const pr = await rpc('session/prompt', {
  request: { sessionId: sid, requestId: 'repro-' + Date.now(), mode: 'queue', content: [{ type: 'text', text: '只回复两个字：收到' }] }
});
console.log(`prompt: ${pr.ok ? 'accepted' : pr.code + ': ' + pr.msg}`);

const t0 = Date.now();
while (Date.now() - t0 < 120000 && !turn) await new Promise((r) => setTimeout(r, 1000));

console.log(`\n=== 结果（${((Date.now() - t0) / 1000).toFixed(1)}s） ===`);
console.log(`事件 ${types.length} 个：${types.join(' → ') || '(空)'}`);
if (turn) {
  console.log(`✅ turn/end reason=${turn.reason?.kind} text="${turn.text.slice(0, 80)}"`);
} else {
  console.log('❌ 无 turn/end');
}
process.exit(0);
