// 关键实验：建一个会话 → follow 它 → 发一个必然有回复的 prompt → 看 turn 事件到不到。
// 这条链路正是黑话研究用的链路（runSlangResearch → ensureSlangLearnerSession → prompt → waitLearnerTurn）。
//
// 如果这里也收不到事件，问题就不在黑话代码，而在事件流本身。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeApiClient, unwrap } from '../src/dsh-client.js';
import { probeCookie, probeRpc } from './probe-auth.mjs';

const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:19387';
const rpc = probeRpc(probeCookie());
const cookie = probeCookie();

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'slang-diag2-'));
const created = await rpc('session/create', { request: { cwd, agentPreset: 'qq-chat' } });
if (!created.ok) {
  console.log(`session/create 失败：${created.code}: ${created.msg}`);
  process.exit(1);
}
const sid = created.value.sessionId;
console.log(`会话：${sid}`);

const sel = await rpc('session/selectModel', {
  request: { sessionId: sid, provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' }
});
console.log(`selectModel：${sel.ok ? 'ok' : `${sel.code}: ${sel.msg}`}`);

// ── 复用生产代码的事件流客户端（它就是桥接用的那个） ──────────────────────
const client = new NodeApiClient(BASE, 30000, { token: '', cookie });
const events = [];
(async () => {
  try {
    for await (const envelope of client.events.mux({})) {
      const frame = envelope.payload;
      if (frame?.type !== 'session/event') continue;
      if (frame.sessionId !== sid) continue;
      const et = frame.event?.type;
      events.push(frame.event);
      if (et) console.log(`  [event] ${et}`);
      if (et === 'turn/end') break;
    }
  } catch (e) {
    console.log(`  事件流结束：${e?.message ?? e}`);
  }
})();

client.events.follow(sid);
console.log('已 follow，等 3 秒…');
await new Promise((r) => setTimeout(r, 3000));

console.log('发送 prompt…');
const pr = await rpc('session/prompt', {
  request: { sessionId: sid, requestId: 'diag-' + Date.now(), mode: 'queue', content: [{ type: 'text', text: '只回复两个字：收到' }] }
});
console.log(`prompt：${pr.ok ? 'accepted' : `${pr.code}: ${pr.msg}`}`);

const deadline = Date.now() + 90000;
while (Date.now() < deadline && !events.some((e) => e.type === 'turn/end')) {
  await new Promise((r) => setTimeout(r, 1000));
}

console.log(`\n结果：收到 ${events.length} 个事件`);
console.log(`类型序列：${events.map((e) => e.type).join(' → ') || '（空）'}`);
const hasEnd = events.some((e) => e.type === 'turn/end');
if (hasEnd) {
  const text = events
    .filter((e) => e.type === 'assistant/message')
    .map((e) => (e.data?.message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join(''))
    .join('');
  console.log(`✅ turn/end 到达，assistant 文本：「${text.slice(0, 120)}」`);
} else {
  console.log('❌ 90 秒内没收到 turn/end');
}

try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
process.exit(0);
