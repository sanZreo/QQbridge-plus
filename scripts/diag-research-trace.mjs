// 为什么「API 返回 200 但 slang.json 没变」？
// 假设：runSlangResearch 的 for 循环里某处 await 卡住，或者 slangResearchingIds 没释放。
// 直接实测：调 API → 立即轮询 slang.json + 观察 learner 会话事件。
import fs from 'node:fs';
import { NodeApiClient, createTurnCollector } from '../src/dsh-client.js';
import { probeCookie, probeRpc } from './probe-auth.mjs';

const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:19387';
const rpc = probeRpc(probeCookie());
const cookie = probeCookie();

const IDS = ['muzhg4zz-4kbzj5', 'muzge10n-i74ugv', 'mv2c8r10-kmdpqg'];
const saved = JSON.parse(fs.readFileSync('state/slang-session.json', 'utf8'));
const SID = saved.sessionId;
console.log(`learner = ${SID}\n`);

// 先看 learner 会话现在有没有在跑 turn
const client = new NodeApiClient(BASE, 30000, { token: '', cookie });
const seen = [];
(async () => {
  try {
    for await (const envelope of client.events.mux({})) {
      const frame = envelope.payload;
      if (frame?.type === 'session/event' && frame.sessionId === SID) seen.push(frame.event.type);
    }
  } catch { /* 流结束 */ }
})();
client.events.follow(SID);
console.log('已 follow learner 会话，观察 15 秒…');
await new Promise((r) => setTimeout(r, 15000));
console.log(`  这 15 秒收到 ${seen.length} 个事件：${seen.join(' → ') || '(空)'}\n`);

// 再触发一次研究
console.log('=== 触发研究 ===');
const tok = fs.readFileSync('state/console-token', 'utf8').trim();
const res = await fetch('http://127.0.0.1:3100/api/slang/research', {
  method: 'POST',
  headers: { 'x-console-token': tok, 'content-type': 'application/json' },
  body: JSON.stringify({ ids: IDS })
});
console.log('  HTTP', res.status, await res.text());
console.log('');

// 观察 90 秒
const t0 = Date.now();
let lastCount = 0;
while (Date.now() - t0 < 90000) {
  await new Promise((r) => setTimeout(r, 5000));
  const n = seen.length;
  const slang = JSON.parse(fs.readFileSync('state/slang.json', 'utf8'));
  const done = IDS.filter((id) => {
    const e = slang.find((x) => x.id === id);
    return e && e.meaning && e.meaning.trim();
  }).length;
  console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] 事件 ${n}（+${n - lastCount}）  已写回 ${done}/3`);
  lastCount = n;
  if (done >= 3) { console.log('\n✅ 三条全部写回'); break; }
}
console.log(`\n事件序列（最近 60 个）：${seen.slice(-60).join(' → ')}`);
process.exit(0);
