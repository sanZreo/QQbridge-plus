// 诊断 learner 会话为什么收不到 turn。
// 关键假设：桥接重启后，sessionId 是从 slang-session.json 复用的（旧会话）。
// 这个会话在 DSH 里活着，但桥接对它 follow 之后可能收不到事件，
// 或者 ensureChatModel 失败/agent 已退役。
import fs from 'node:fs';
import { NodeApiClient, unwrap, createTurnCollector } from '../src/dsh-client.js';
import { probeCookie, probeRpc } from './probe-auth.mjs';

const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:19387';
const rpc = probeRpc(probeCookie());
const cookie = probeCookie();

const saved = JSON.parse(fs.readFileSync('state/slang-session.json', 'utf8'));
const sid = saved.sessionId;
console.log(`learner sessionId = ${sid}`);
console.log(`preset            = ${saved.preset}\n`);

// 1. 这个会话还活着吗？
console.log('=== 1. 会话是否还在 DSH ===');
const list = await rpc('session/list', { _request: {} });
const items = list.value?.items ?? [];
const hit = items.find((s) => s.sessionId === sid);
console.log(hit ? `  ✅ 在列表里（第 ${items.indexOf(hit) + 1} 位）` : '  ❌ 不在列表里');

// 2. 直接给它发 prompt，看 turn 事件
console.log('\n=== 2. 直接给 learner 会话发 prompt，等 turn ===');
const client = new NodeApiClient(BASE, 30000, { token: '', cookie });
const collector = createTurnCollector();
let turnResult = null;
const types = [];
(async () => {
  try {
    for await (const envelope of client.events.mux({})) {
      const frame = envelope.payload;
      if (frame?.type === 'session/event' && frame.sessionId === sid) {
        types.push(frame.event.type);
        const ended = collector.push(frame.event);
        if (ended) { turnResult = ended; break; }
      }
    }
  } catch (e) { console.log('  流结束:', e?.message); }
})();
client.events.follow(sid);
await new Promise((r) => setTimeout(r, 2500));

const pr = await rpc('session/prompt', {
  request: { sessionId: sid, requestId: 'diag-' + Date.now(), mode: 'queue', content: [{ type: 'text', text: '只回复两个字：收到' }] }
});
console.log(`  prompt: ${pr.ok ? 'accepted' : `${pr.code}: ${pr.msg}`}`);

const deadline = Date.now() + 100000;
while (Date.now() < deadline && !turnResult) await new Promise((r) => setTimeout(r, 1000));

console.log(`\n=== 3. 结果 ===`);
console.log(`  事件数: ${types.length}`);
console.log(`  序列: ${types.join(' → ') || '(空)'}`);
if (turnResult) {
  console.log(`  ✅ turn/end reason=${turnResult.reason?.kind}  text="${turnResult.text.slice(0, 60)}"`);
} else {
  console.log('  ❌ 100 秒无 turn/end —— 这就是桥接等不到结果的原因');
}
process.exit(0);
