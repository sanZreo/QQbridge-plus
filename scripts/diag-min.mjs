// 最小复现：只发 prompt 给一个已知会话，看桥接 learner 通道能否收到 turn。
// 如果桥接的 pumpMux 对 learner 会话正常，那么问题在 runSlangResearch 的前置守卫。
// 如果连"我手动 prompt learner 会话"桥接都没反应，说明 learner 通道整体坏了。
import fs from 'node:fs';
import path from 'node:path';
import { NodeApiClient, createTurnCollector } from '../src/dsh-client.js';
import { probeCookie, probeRpc } from './probe-auth.mjs';

const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:19387';
const rpc = probeRpc(probeCookie());
const cookie = probeCookie();
const STATE = path.join(process.cwd(), 'state');

// 1) 建一个全新会话（模拟 ensureSlangLearnerSession 的新建路径）
const dir = path.join(STATE, 'slang-agent');
fs.mkdirSync(dir, { recursive: true });
const ws = await rpc('workspace/create', { request: { path: dir } });
const wid = ws.value.workspace.workspaceId;
const cr = await rpc('session/create', { request: { workspaceId: wid, agentPreset: 'qq-chat' } });
const sid = cr.value.sessionId;
console.log('新会话 =', sid);

// 2) 触发研究（slang-session.json 不存在 → 桥接会走"新建会话"分支）
const tok = fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim();
const res = await fetch('http://127.0.0.1:3100/api/slang/research', {
  method: 'POST',
  headers: { 'x-console-token': tok, 'content-type': 'application/json' },
  body: JSON.stringify({ ids: ['muzhg4zz-4kbzj5'] })
});
console.log('HTTP', res.status, await res.text());

// 3) follow 所有会话，看桥接到底给哪个会话发了 prompt
const client = new NodeApiClient(BASE, 30000, { token: '', cookie });
const collector = createTurnCollector();
const bySession = new Map(); // sid -> {types:[], turn}
let totalEvents = 0;
(async () => {
  try {
    for await (const envelope of client.events.mux({})) {
      const frame = envelope.payload;
      if (frame?.type !== 'session/event') continue;
      totalEvents += 1;
      const sid2 = frame.sessionId;
      if (!bySession.has(sid2)) bySession.set(sid2, { types: [], turn: null, collector: createTurnCollector() });
      const rec = bySession.get(sid2);
      rec.types.push(frame.event.type);
      const e = rec.collector.push(frame.event);
      if (e) rec.turn = e;
    }
  } catch { /* 流结束 */ }
})();
client.events.follow(sid);

const t0 = Date.now();
while (Date.now() - t0 < 150000) {
  await new Promise((r) => setTimeout(r, 3000));
  // 只要有任何会话完成了 turn 就停
  const anyTurn = [...bySession.values()].some((r) => r.turn);
  if (anyTurn) break;
}

console.log(`\n总事件=${totalEvents}  有事件的会话数=${bySession.size}`);
for (const [sid2, rec] of bySession) {
  console.log(`\n会话 ${sid2.slice(-8)}: ${rec.types.length} 个事件`);
  console.log('  ' + (rec.types.join(' → ').slice(0, 400) || '(空)'));
  if (rec.turn) console.log(`  ✅ turn/end reason=${rec.turn.reason?.kind} text="${rec.turn.text.slice(0, 200)}"`);
}
if (bySession.size === 0) console.log('\n❌ 150 秒内**任何**会话都没有事件 —— 桥接没发 prompt');

// 5) 检查 slang.json
const slang = JSON.parse(fs.readFileSync(path.join(STATE, 'slang.json'), 'utf8'));
const e = slang.find((x) => x.id === 'muzhg4zz-4kbzj5');
console.log(`\n大肥鱼: meaning=${(e?.meaning || '').trim() ? '✅' : '❌ 空'}  updatedAt=${e?.updatedAt}`);
process.exit(0);
