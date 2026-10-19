// 群聊上下文时间限制（过时消息）：超过阈值不再回复，但仍可当上下文记忆。
// 这一组断言钉住四件事：
//   ① 只对**群聊**生效（私聊隔一小时回一句是正常社交，不该被判过时）；
//   ② 标记是**读过即带**的（快照 / unread / recent / 等待通道四条读路径）；
//   ③ 「不再回复」靠**把过时消息摘出 unread 队列**实现，而 recentMessages 原样保留
//      —— 这就是"仍可作为上下文记忆"；
//   ④ 摘除**不能卡住已读水位**（否则新的消息永远无法确认，会变成更严重的 bug）。
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
const test = async (name, run) => {
  const h = await bridgeHarness();
  try { await run(h); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
  finally { await h.close(); }
};

const GROUP = 'group:456';
const PRIVATE = 'private:123';
const MIN = 60 * 1000;

/** 灌一条消息并把它的时间改成 N 分钟前（append 内部写的是 Date.now()）。 */
function seedAged(h, key, sender, text, ageMs, userId, seqBase = 9000, quoteTargetIsSelf = false) {
  h.appendSocialV2Message(key, sender, text, text, quoteTargetIsSelf, false, seqBase, [], userId);
  const st = h.getSocialV2State(key);
  const target = st.recentMessages[st.recentMessages.length - 1];
  const unread = [...st.unread].reverse().find((m) => m.messageId === String(seqBase));
  const when = Date.now() - ageMs;
  if (target) target.time = when;
  if (unread) unread.time = when;
  return { st, msg: target };
}

await test('阈值默认 30 分钟，且可配置关闭', async (h) => {
  assert.equal(h.staleAfterMsV2(), 30 * MIN, '默认应为 30 分钟');
  h.cfg.socialV2.context.staleAfterMs = 2 * 60 * MIN;
  assert.equal(h.staleAfterMsV2(), 2 * 60 * MIN, '应读取配置值');
  h.cfg.socialV2.context.staleAfterMs = 0;
  assert.equal(h.staleAfterMsV2(), 0, '0 = 关闭');
  h.cfg.socialV2.context.staleAfterMs = -1;
  assert.equal(h.staleAfterMsV2(), 0, '负数也视为关闭');
});

await test('群聊：超过 30 分钟标记 stale，未超过不标记', async (h) => {
  const now = Date.now();
  const old = h.markStaleV2(GROUP, { seq: 1, sender: '甲', time: now - 31 * MIN, isSelf: false }, now);
  assert.equal(old.stale, true, '31 分钟前应标记过时');
  assert.equal(old.staleMinutes, 31, 'staleMinutes 应是真实分钟数');
  const fresh = h.markStaleV2(GROUP, { seq: 2, sender: '乙', time: now - 29 * MIN, isSelf: false }, now);
  assert.equal(fresh.stale, undefined, '29 分钟前不该标记');
  // 边界：正好等于阈值 ⇒ 算过时（>=）
  const edge = h.markStaleV2(GROUP, { seq: 3, sender: '丙', time: now - 30 * MIN, isSelf: false }, now);
  assert.equal(edge.stale, true, '正好 30 分钟算过时（边界取 >=）');
  // 不改原对象
  const source = { seq: 4, sender: '丁', time: now - 90 * MIN, isSelf: false };
  h.markStaleV2(GROUP, source, now);
  assert.equal(source.stale, undefined, 'markStaleV2 不得修改传入对象');
});

await test('私聊不受影响：隔小时的消息不判过时', async (h) => {
  const now = Date.now();
  const r = h.markStaleV2(PRIVATE, { seq: 1, sender: '私聊', time: now - 5 * 60 * MIN, isSelf: false }, now);
  assert.equal(r.stale, undefined, '私聊不做过时判定');
  // 自己发的消息也不判
  const own = h.markStaleV2(GROUP, { seq: 2, sender: '我', time: now - 5 * 60 * MIN, isSelf: true }, now);
  assert.equal(own.stale, undefined, '自己的消息不判过时');
});

await test('过时消息被摘出待回复队列，但仍在 recentMessages（上下文记忆）', async (h) => {
  seedAged(h, GROUP, '甲', '半小时前的旧话', 31 * MIN, 1001, 9001);
  seedAged(h, GROUP, '乙', '刚说的新话', 5 * MIN, 1002, 9002);
  const st = h.getSocialV2State(GROUP);
  assert.equal(st.unread.length, 2, '前置：两条都在未读里');
  const dropped = h.sweepStaleUnreadV2(st, GROUP);
  assert.equal(dropped, 1, '应只摘掉 1 条过时消息');
  assert.equal(st.unread.length, 1, '未读只剩新的那条');
  assert.equal(st.unread[0].text, '刚说的新话', '留下的是新消息');
  // 关键：过时消息仍在 recentMessages 里 ⇒ 上下文记忆没丢
  assert.ok(st.recentMessages.some((m) => m.text === '半小时前的旧话'),
    '过时消息必须保留在 recentMessages 里当上下文');
});

await test('摘除不会卡住已读水位（不能变成更严重的 bug）', async (h) => {
  seedAged(h, GROUP, '甲', '很久以前', 120 * MIN, 1001, 9101);
  seedAged(h, GROUP, '乙', '也是旧的', 90 * MIN, 1002, 9102);
  const st = h.getSocialV2State(GROUP);
  const beforeSeq = st.lastUnreadSeq;
  h.sweepStaleUnreadV2(st, GROUP);
  assert.equal(st.unread.length, 0, '两条都应被摘掉');
  // 水位必须能前进到最新 seq，否则之后的新消息永远无法被确认
  const packet = h.buildWakeSnapshotV2(GROUP);
  const through = packet ? packet.readThroughSeq : null;
  assert.equal(through, beforeSeq, `摘除后已读水位应能到 ${beforeSeq}，实际 ${through}`);
});

await test('快照里过时消息带 stale 标记（软模式：staleAutoAck=false 时）', async (h) => {
  h.cfg.socialV2.context.staleAutoAck = false; // 软模式：不摘除，只标记
  seedAged(h, GROUP, '甲', '两小时前', 120 * MIN, 1001, 9201);
  const packet = h.buildWakeSnapshotV2(GROUP);
  assert.ok(packet, '应生成快照');
  assert.equal(packet.messages.length, 1, '未读应仍在快照里（软模式不摘除）');
  assert.equal(packet.messages[0].stale, true, '快照里的过时消息必须带 stale=true');
  assert.ok(packet.messages[0].staleMinutes >= 119, 'staleMinutes 应反映真实时长');
});

await test('硬模式（默认）：快照里不再出现过时未读', async (h) => {
  seedAged(h, GROUP, '甲', '两小时前', 120 * MIN, 1001, 9301);
  const packet = h.buildWakeSnapshotV2(GROUP);
  assert.ok(packet, '应生成快照');
  assert.equal(packet.messages.length, 0, '过时消息应已被摘出，不出现在待处理消息里');
  assert.equal(packet.unreadCount, 0, 'unreadCount 也应随之归零（不再催它回旧消息）');
  assert.equal(packet.partial, false, '没有待处理消息时 partial 应为 false');
});

await test('prompt 注入【过时消息】说明：群聊有、私聊没有', async (h) => {
  const g = h.buildWakePromptV2(GROUP, 'newMessage');
  assert.match(g, /【过时消息】/, '群聊必须说明过时消息语义');
  assert.match(g, /30 分钟/, '应写明阈值分钟数');
  assert.match(g, /不要回复/, '必须明确"不要回复"');
  assert.match(g, /背景记忆/, '必须说明仍可当背景记忆');
  const p = h.buildWakePromptV2(PRIVATE, 'newMessage');
  assert.doesNotMatch(p, /【过时消息】/, '私聊不该注入这段（省 token）');
  // 关闭功能后也不该注入
  h.cfg.socialV2.context.staleAfterMs = 0;
  assert.doesNotMatch(h.buildWakePromptV2(GROUP, 'newMessage'), /【过时消息】/, '功能关闭后不应注入');
});

await test('读取路径：markStaleListV2 对列表逐条标记且顺序不变', async (h) => {
  const now = Date.now();
  const list = [
    { seq: 1, sender: '甲', time: now - 90 * MIN },
    { seq: 2, sender: '乙', time: now - 1 * MIN },
  ];
  const marked = h.markStaleListV2(GROUP, list, now);
  assert.equal(marked.length, 2, '条数不变');
  assert.equal(marked[0].stale, true, '第一条过时');
  assert.equal(marked[1].stale, undefined, '第二条不过时');
  assert.deepEqual(marked.map((m) => m.seq), [1, 2], '顺序必须保持（从最早到最新）');
});

await test('控制台改阈值：0=关闭、越界被夹住、内存立即生效', async (h) => {
  // 这条是**安全关键**：管理员在控制台按分钟填，一旦填错（1 毫秒 / 空 / 负数）
  // 就可能把整群历史判成过时 —— 表现是"群友说话它装死"，且很难查出是配置问题。
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const post = (context) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/socialV2/config', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('request hung')));
    req.end(JSON.stringify({ context }));
  });
  try {
    // 正常值原样保存
    const ok = await post({ staleAfterMs: 30 * MIN, staleAutoAck: true });
    assert.equal(ok.status, 200, `保存应成功，实际 ${ok.status}`);
    assert.equal(h.cfg.socialV2.context.staleAfterMs, 30 * MIN, '内存态应同步（改完立即生效，不必重启）');
    assert.equal(h.staleAfterMsV2(), 30 * MIN, '读到的阈值应生效');

    // 0 = 关闭
    await post({ staleAfterMs: 0 });
    assert.equal(h.staleAfterMsV2(), 0, '0 应为关闭');

    // 太小 → 夹到 1 分钟下限（否则整群历史全判过时）
    await post({ staleAfterMs: 5 });
    assert.equal(h.cfg.socialV2.context.staleAfterMs, 60 * 1000, '低于 1 分钟应被夹到 60000');

    // 太大 → 夹到 24 小时上限（否则等于功能失效）
    await post({ staleAfterMs: 999999999 });
    assert.equal(h.cfg.socialV2.context.staleAfterMs, 24 * 3600 * 1000, '超过 24 小时应被夹到 86400000');

    // 负数同样视为关闭
    await post({ staleAfterMs: -5 });
    assert.equal(h.staleAfterMsV2(), 0, '负数应视为关闭');

    // 落盘确认
    await post({ staleAfterMs: 45 * MIN, staleAutoAck: false });
    const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'));
    assert.equal(saved.socialV2.context.staleAfterMs, 45 * MIN, '必须写进 config.json（重启后仍生效）');
    assert.equal(saved.socialV2.context.staleAutoAck, false, 'staleAutoAck 也要落盘');
    // 软模式：过时消息不再被摘除
    seedAged(h, GROUP, '甲', '很旧', 120 * MIN, 1001, 9401);
    const st = h.getSocialV2State(GROUP);
    assert.equal(h.sweepStaleUnreadV2(st, GROUP), 0, 'staleAutoAck=false 时不得摘除');
    assert.equal(st.unread.length, 1, '软模式下消息仍在待回复队列');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

console.log(failures ? `\n${failures} failed` : '\nall stale-context assertions passed');
if (failures) process.exitCode = 1;
