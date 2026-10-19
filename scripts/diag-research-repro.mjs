// 复刻 runSlangResearch 的完整调用序列，看它到底卡在哪一步。
// 重点：learner 会话的 preset 是 qq-chat（一代），而一代预设**不挂 MCP 工具**——
// 研究 prompt 要求模型「用 web_search 搜索、用 web_fetch 抓正文」，
// 如果这个会话根本没有这两个工具，模型只能干编，甚至可能触发 question/requested
// 被自动跳过 → 回合永远不结束 → waitLearnerTurn 超时。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeApiClient, unwrap, createTurnCollector } from '../src/dsh-client.js';
import { probeCookie, probeRpc } from './probe-auth.mjs';

const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:19387';
const rpc = probeRpc(probeCookie());
const cookie = probeCookie();

const PRESET = process.argv[2] || 'qq-chat';
console.log(`=== 用 preset=${PRESET} 复刻研究流程 ===\n`);

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'slang-diag3-'));
const created = await rpc('session/create', { request: { cwd, agentPreset: PRESET } });
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

// ── 事件收集（与桥接 pumpMux 同构） ────────────────────────────────────────
const client = new NodeApiClient(BASE, 30000, { token: '', cookie });
const collector = createTurnCollector();
const allTypes = [];
const questionFrames = [];
let turnResult = null;
(async () => {
  try {
    for await (const envelope of client.events.mux({})) {
      const frame = envelope.payload;
      if (frame?.type === 'session/event' && frame.sessionId === sid) {
        allTypes.push(frame.event.type);
        const ended = collector.push(frame.event);
        if (ended) { turnResult = ended; break; }
      } else if (frame?.type === 'question/requested' && frame.sessionId === sid) {
        questionFrames.push(frame);
        console.log(`  ⚠️ 收到 question/requested：${JSON.stringify(frame.questions).slice(0, 200)}`);
        try {
          await client.respond({
            clientId: frame.clientId,
            eventId: frame.eventId,
            outcome: { kind: 'result', value: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } }
          });
          console.log('  （已按桥接策略自动跳过该提问）');
        } catch (e) { console.log(`  回应失败：${e?.message}`); }
      }
    }
  } catch (e) { /* 流结束 */ }
})();
client.events.follow(sid);
await new Promise((r) => setTimeout(r, 2500));

// ── 用真实的 buildResearchPrompt 造 prompt ────────────────────────────────
const { buildResearchPrompt } = await import('../src/slang-learner.js');
const promptText = buildResearchPrompt([
  { content: 'yyds', evidence: [{ text: '这操作太 yyds 了' }] },
  { content: 'xswl', evidence: [] },
]);
console.log(`\n研究 prompt 长度：${promptText.length} 字符`);
console.log('发送 prompt…');

const pr = await rpc('session/prompt', {
  request: { sessionId: sid, requestId: 'diag3-' + Date.now(), mode: 'queue', content: [{ type: 'text', text: promptText }] }
});
console.log(`prompt：${pr.ok ? 'accepted' : `${pr.code}: ${pr.msg}`}`);

const deadline = Date.now() + 150000;
while (Date.now() < deadline && !turnResult) {
  await new Promise((r) => setTimeout(r, 1000));
}

console.log(`\n=== 结果 ===`);
console.log(`事件数：${allTypes.length}`);
console.log(`事件序列：${allTypes.join(' → ')}`);
console.log(`提问帧：${questionFrames.length}`);
if (turnResult) {
  console.log(`turn/end reason=${turnResult.reason?.kind ?? JSON.stringify(turnResult.reason)}`);
  console.log(`assistant 文本（前 400 字）：\n${turnResult.text.slice(0, 400)}`);
} else {
  console.log('❌ 150 秒内没有 turn/end —— 与桥接日志里的超时一致');
}

try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
process.exit(0);
