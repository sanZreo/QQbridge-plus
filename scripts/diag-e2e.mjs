// 端到端复现：调 /api/slang/research → 观察 learner 会话事件 + slang.json 变化。
// 修复了路径（相对 → 绝对）以避免 cwd 问题。
import fs from 'node:fs';
import path from 'node:path';
import { NodeApiClient, createTurnCollector } from '../src/dsh-client.js';
import { probeCookie, probeRpc } from './probe-auth.mjs';

const ROOT = path.resolve(process.cwd());
const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:19387';
const STATE = path.join(ROOT, 'state');
const rpc = probeRpc(probeCookie());
const cookie = probeCookie();

const IDS = ['muzhg4zz-4kbzj5', 'muzge10n-i74ugv', 'mv2c8r10-kmdpqg'];

console.log('=== 触发前 ===');
const readSlang = () => JSON.parse(fs.readFileSync(path.join(STATE, 'slang.json'), 'utf8'));
const before = IDS.map((id) => {
  const e = readSlang().find((x) => x.id === id);
  return `${e?.content}(${(e?.meaning || '').trim() ? '有' : '空'})`;
}).join(' ');
console.log('  ' + before);

// follow learner 会话
const sessFile = path.join(STATE, 'slang-session.json');
console.log(`\n=== slang-session.json 存在？ ${fs.existsSync(sessFile)} ===`);
if (!fs.existsSync(sessFile)) {
  console.log('  → 说明上次研究/提取失败后 invalidateSlangLearnerSession() 删了它，');
  console.log('    下次 ensureSlangLearnerSession 会**新建**会话（走 workspace.create）。');
}

const client = new NodeApiClient(BASE, 30000, { token: '', cookie });
const seen = [];
(async () => {
  try {
    for await (const envelope of client.events.mux({})) {
      const frame = envelope.payload;
      if (frame?.type === 'session/event') seen.push(frame.sessionId.slice(-8) + ':' + frame.event.type);
    }
  } catch { /* 流结束 */ }
})();

// 触发研究
const tok = fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim();
console.log('\n=== 触发研究 ===');
const res = await fetch('http://127.0.0.1:3100/api/slang/research', {
  method: 'POST',
  headers: { 'x-console-token': tok, 'content-type': 'application/json' },
  body: JSON.stringify({ ids: IDS })
});
console.log(`  HTTP ${res.status}: ${await res.text()}`);

// 观察 100 秒
console.log('\n=== 观察 100 秒 ===');
const t0 = Date.now();
let lastSeen = 0;
let lastFile = '';
while (Date.now() - t0 < 100000) {
  await new Promise((r) => setTimeout(r, 8000));
  const st = fs.statSync(path.join(STATE, 'slang.json'));
  const mtime = st.mtime.toISOString();
  const slang = readSlang();
  const done = IDS.filter((id) => {
    const e = slang.find((x) => x.id === id);
    return e && e.meaning && e.meaning.trim();
  }).length;
  const newSeen = seen.length - lastSeen;
  console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] 事件+${newSeen}  slang.json mtime=${mtime === lastFile ? '未变' : mtime}  写回 ${done}/3`);
  lastSeen = seen.length;
  lastFile = mtime;
  if (done >= 3) { console.log('  ✅ 全部写回'); break; }
}

console.log(`\n=== 收到的事件（全部） ===`);
console.log(seen.join('\n') || '(无)');
process.exit(0);
