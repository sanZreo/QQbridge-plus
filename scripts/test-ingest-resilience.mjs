// 入站消息韧性回归：覆盖三个已修复缺陷
//   1) 重复投递（SnowLuma 重连重放 / OneBot 重发）不得重复入库
//   2) 投递互斥卡死（DSH 侧某一环永不返回）必须被看门狗强制释放
//   3) 唤醒频率超限不得直接丢消息，必须暂存并可重试
// 全程使用隔离的临时目录与桩服务，不读真实配置、不发真实 QQ 消息。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
let tests = 0;

async function test(name, run, config = {}) {
  tests++;
  const h = await bridgeHarness({ config });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  try {
    await run({ h, st });
    console.log('PASS', name);
  } catch (error) {
    failures++;
    console.error('FAIL', name, error.stack);
  } finally {
    await h.close();
  }
}

const incomingEvent = (messageId, text = '重复投递的消息') => ({
  user_id: 789,
  group_id: 456,
  self_id: 111,
  message_id: messageId,
  message: [{ type: 'text', data: { text } }]
});

// ── 1. 重复入库 ────────────────────────────────────────────────────────
await test('重复投递的同一 message_id 只入库一次，且不推进 seq', async ({ h, st }) => {
  await h.handleIncoming('group', 456, incomingEvent('dup-1'), h.cfg);
  assert.equal(st.unread.length, 1, '首次投递应入库');
  assert.equal(st.recentMessages.length, 1);
  const seqAfterFirst = st.lastUnreadSeq;

  await h.handleIncoming('group', 456, incomingEvent('dup-1'), h.cfg);
  assert.equal(st.unread.length, 1, '重复投递不得再次入库');
  assert.equal(st.recentMessages.length, 1, '重复投递不得进入最近消息流');
  assert.equal(st.lastUnreadSeq, seqAfterFirst, '重复投递不得推进 unread seq');

  // 同一人连发相同文本的真实消息 message_id 不同，必须照常入库（不能误杀）。
  await h.handleIncoming('group', 456, incomingEvent('dup-2'), h.cfg);
  assert.equal(st.unread.length, 2, '不同 message_id 的相同文本必须正常入库');
  assert.equal(st.lastUnreadSeq, seqAfterFirst + 1);
});

await test('没有 message_id 的事件不参与去重（宁可重复也不丢）', async ({ h, st }) => {
  const bare = { user_id: 789, group_id: 456, self_id: 111, message: [{ type: 'text', data: { text: '无 id 消息' } }] };
  await h.handleIncoming('group', 456, bare, h.cfg);
  await h.handleIncoming('group', 456, bare, h.cfg);
  assert.equal(st.unread.length, 2, '无 id 事件必须两条都入库，避免误杀');
});

// ── 2. 投递互斥卡死 ────────────────────────────────────────────────────
await test('投递看门狗超时后强制释放会话投递锁', async ({ h }) => {
  h.cfg.socialV2.deliverTimeoutMs = 1000;
  // 模拟 DSH 侧某一环永不返回（例如 sessions/prompt 挂住）。
  h.api.sessions.prompt = () => new Promise(() => {});

  await assert.rejects(h.deliverPrompt(KEY, 'hang', {}), /看门狗/, '超时必须抛带「看门狗」标记的错误');
  assert.equal(h.promptQueues.has(KEY), false, '超时后必须释放互斥并排空队列');

  // 锁确实释放了：后续投递能正常完成，不被卡住的会话永久拖住。
  h.api.sessions.prompt = async () => ({ result: { ok: true, value: {} } });
  const after = await h.deliverPrompt(KEY, 'after-hang', {});
  assert.equal(after.ok, true, '看门狗释放后应能正常投递');
  assert.equal(h.promptQueues.has(KEY), false);
});

// ── 3. 丢消息 ──────────────────────────────────────────────────────────
await test('唤醒频率超限时暂存唤醒原因并安排重试，而不是直接丢弃', async ({ h, st }) => {
  h.cfg.socialV2.wake.maxWakePerMinute = 1;
  h.cfg.socialV2.wake.maxWakePerHour = 0;
  st.wakeTimes = [Date.now()];
  st.pendingWakeReasons = [];

  await h.sendWakePromptV2(KEY, 'question');

  assert.equal(h.calls.prompts.length, 0, '限流窗口内不得真的发起投递');
  assert.equal(st.pendingWakeReasons.length, 1, '限流唤醒必须被暂存而不是丢掉');
  assert.equal(st.pendingWakeReasons[0].reason, 'question');
  assert.equal(st.pendingWakeReasons[0].source, 'rateLimited');
  assert.ok(st.wakeRetryTimer, '应安排限流重试定时器');
});

await test('暂存队列满时丢的是优先级最低的一条，而不是无脑砍队首', async ({ h, st }) => {
  h.cfg.socialV2.wake.maxWakePerMinute = 1;
  h.cfg.socialV2.wake.maxWakePerHour = 0;
  st.wakeTimes = [Date.now()];
  // 先塞满低优先级，再塞一个高优先级；溢出时必须淘汰 anyMessage 而不是 atMention。
  st.pendingWakeReasons = Array.from({ length: 20 }, (_, i) => ({
    reason: 'anyMessage', seq: i + 1, source: 'busy', at: 1000 + i
  }));

  await h.sendWakePromptV2(KEY, 'atMention');

  assert.equal(st.pendingWakeReasons.length, 20, '暂存队列应保持有界');
  assert.ok(
    st.pendingWakeReasons.some((r) => r && r.reason === 'atMention'),
    '高优先级唤醒必须被保留'
  );
  assert.equal(
    st.pendingWakeReasons.filter((r) => r.reason === 'anyMessage').length,
    19,
    '应淘汰一条优先级最低的 anyMessage'
  );
});

// ── 4. 断连补拉（SnowLuma 掉线 / 桥接停摆期间的消息）────────────────────
const histMsg = ({ id, userId, text, timeSec, groupId = 456 }) => ({
  message_id: id,
  message_seq: timeSec,
  user_id: userId,
  group_id: groupId,
  time: timeSec,
  sender: { nickname: `u${userId}` },
  message: [{ type: 'text', data: { text } }]
});

// 注意：st.unread 来自 VM context，是**另一个 realm** 的数组。
// 直接 st.unread.map(...) 产出的仍是那边 realm 的 Array，deepEqual 会因原型不同而判不等，
// 所以一律用测试侧的 Array.from 收成本 realm 的数组。
const unreadTexts = (st) => Array.from(st.unread, (m) => String(m?.text ?? ''));

const setupBackfill = (h, st, { gapMs = 90000, selfId = '111', extra = {} } = {}) => {
  h.cfg.snowluma = { ...(h.cfg.snowluma ?? {}), backfillOnConnect: true, backfillMinGapMs: gapMs, backfillCount: 30, ...extra };
  h.state.sessions[KEY] = 'session-fixture';
  h.setSelfAccountId(selfId);
  h.resetBackfillGuard();
  // 「上次见过」的光标：默认落在 2 分钟前，超过空窗阈值
  st.lastIncomingAt = Date.now() - Math.max(gapMs + 30000, 120000);
  const calls = [];
  h.bot.request = async (action, params) => {
    calls.push({ action, params });
    // 夹具数据挂在数组本身上（serveHistory 写入），别读 calls.at(-1) —— 那是 {action,params}
    return { status: 'ok', retcode: 0, data: { messages: calls.messages ?? [] } };
  };
  return calls;
};

const serveHistory = (calls, messages) => { calls.messages = messages; };

await test('断连补拉：只补「上次见过之后」的消息，并剔除自己发的', async ({ h, st }) => {
  const calls = setupBackfill(h, st);
  const nowSec = Math.floor(Date.now() / 1000);
  serveHistory(calls, [
    histMsg({ id: 'old-1', userId: 789, text: '很早就说过的', timeSec: nowSec - 600 }),
    histMsg({ id: 'new-1', userId: 789, text: '断连期间的新消息', timeSec: nowSec - 10 }),
    histMsg({ id: 'self-1', userId: 111, text: '我自己发的话', timeSec: nowSec - 5 })
  ]);

  await h.backfillMissedMessages('测试');

  assert.equal(calls.length, 1, '应只查一次历史');
  assert.equal(calls[0].action, 'get_group_msg_history');
  assert.equal(calls[0].params.group_id, 456);
  assert.deepEqual(
    unreadTexts(st),
    ['断连期间的新消息'],
    '只补光标之后、且不是自己发的消息'
  );
});

await test('断连补拉：重复补拉幂等（同一条 message_id 只入库一次）', async ({ h, st }) => {
  const calls = setupBackfill(h, st);
  const nowSec = Math.floor(Date.now() / 1000);
  serveHistory(calls, [histMsg({ id: 'dup-backfill', userId: 789, text: '同一条历史消息', timeSec: nowSec - 10 })]);

  await h.backfillMissedMessages('第一次');
  const afterFirst = st.unread.length;
  h.resetBackfillGuard();
  st.lastIncomingAt = Date.now() - 120000; // 光标再次置旧，模拟又断了一次
  await h.backfillMissedMessages('第二次');

  assert.equal(afterFirst, 1);
  assert.equal(st.unread.length, 1, '同一 message_id 第二次补拉必须被去重');
});

await test('断连补拉：历史里的管理命令不得被重放', async ({ h, st }) => {
  const calls = setupBackfill(h, st);
  const nowSec = Math.floor(Date.now() / 1000);
  serveHistory(calls, [
    histMsg({ id: 'cmd-1', userId: 2765944470, text: '/reset', timeSec: nowSec - 20 }),
    histMsg({ id: 'cmd-2', userId: 2765944470, text: '进入角色扮演：鲸鱼娘', timeSec: nowSec - 15 }),
    histMsg({ id: 'ok-1', userId: 789, text: '正常的一句话', timeSec: nowSec - 10 })
  ]);

  await h.backfillMissedMessages('测试');

  assert.deepEqual(unreadTexts(st), ['正常的一句话'], '历史管理命令必须被跳过');
  assert.ok(!h.state.sessions[KEY] || h.state.sessions[KEY] === 'session-fixture', '/reset 不得被执行');
});

await test('断连补拉：开关关闭或空窗不足时不查历史', async ({ h, st }) => {
  // ① 开关关闭
  const calls = setupBackfill(h, st, { extra: { backfillOnConnect: false } });
  await h.backfillMissedMessages('关闭');
  assert.equal(calls.length, 0, 'backfillOnConnect=false 时不得查历史');

  // ② 空窗不足（刚聊过）
  const calls2 = setupBackfill(h, st);
  st.lastIncomingAt = Date.now(); // 光标是新的 -> 不可能有缺口
  await h.backfillMissedMessages('空窗不足');
  assert.equal(calls2.length, 0, '最近还有消息的会话不应触发补拉');
});

// ── 5. 等待通道（qq_wait_for_messages）异常时必须释放占用 ───────────────
await test('等待通道：主体抛异常也必须释放占用，而不是锁死 15 分钟', async ({ h, st }) => {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const callWait = (body = {}) => new Promise((resolve) => {
    const data = JSON.stringify({ key: KEY, timeoutMs: 200, ...body });
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/socialV2/wait',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        'x-console-token': 'fixture-console-token',
        'x-agent-token': st.agentToken
      }
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    // 不设超时的话，一旦 handler 抛异常且没人接住，这个请求会永远挂着、测试跟着挂住
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.end(data);
  });

  // 在「占用已经拿到之后」的路径上抛异常：unread 一被取值就抛。
  // 这是等待主体里确实会访问、且没有被内层 try 兜住的字段。
  const realUnread = st.unread;
  Object.defineProperty(st, 'unread', { configurable: true, get() { throw new Error('fixture-boom'); } });
  const first = await callWait();
  delete st.unread;
  st.unread = realUnread;

  assert.equal(first.status, 500, '等待主体异常必须被捕获并回 500（不能既不响应也不释放）');

  // 关键断言：占用已经还回去了，下一次等待不会被 429 挡在门外。
  const second = await callWait();
  assert.notEqual(second.status, 429, '异常路径必须释放等待占用，不能锁到租约过期');
  await new Promise((resolve) => server.close(resolve));
});

// ── 6. QQ空间工具（reserved2）────────────────────────────────────────────
const startServer = async (h) => {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  return { server, port: server.address().port };
};

const httpPost = (port, path, body, headers) => new Promise((resolve) => {
  const data = JSON.stringify(body ?? {});
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(data),
      'x-console-token': 'fixture-console-token',
      ...headers
    }
  }, (res) => {
    let b = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { b += c; });
    res.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(b); } catch { /* 非 JSON 响应 */ }
      resolve({ status: res.statusCode, data: parsed, raw: b });
    });
  });
  req.on('error', () => resolve({ status: 0, data: null, raw: '' }));
  req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, data: null, raw: '' }); });
  req.end(data);
});

await test('QQ空间：只返回时间窗内的说说，且 days 被夹到 3~8', async ({ h, st }) => {
  const { server, port } = await startServer(h);
  const nowSec = Math.floor(Date.now() / 1000);
  const calls = [];
  h.bot.request = async (action, params) => {
    calls.push({ action, params });
    return {
      status: 'ok',
      retcode: 0,
      data: {
        total: 3,
        msglist: [
          { tid: 't-new', time: nowSec - 3600, content: '两小时前', comment_num: 1, pic: [] },
          { tid: 't-mid', time: nowSec - 6 * 86400, content: '六天前', comment_num: 0, pic: [] },
          { tid: 't-old', time: nowSec - 20 * 86400, content: '二十天前', comment_num: 0, pic: [] }
        ]
      }
    };
  };

  const r = await httpPost(port, '/api/socialV2/qzone-posts', { key: KEY, targetUin: 12345, days: 99 }, { 'x-agent-token': st.agentToken });
  assert.equal(r.status, 200);
  assert.equal(r.data.days, 8, 'days 必须被夹到上限 8 天');
  assert.deepEqual(Array.from(r.data.posts, (p) => p.tid), ['t-new', 't-mid'], '20 天前那条必须被窗口滤掉');
  assert.equal(calls[0].action, 'get_qzone_msg_list');
  assert.equal(calls[0].params.target_uin, 12345);

  // 下限也要夹：days=1 -> 3
  const r2 = await httpPost(port, '/api/socialV2/qzone-posts', { key: KEY, targetUin: 12345, days: 1 }, { 'x-agent-token': st.agentToken });
  assert.equal(r2.data.days, 3, 'days 必须被抬到下限 3 天');
  await new Promise((resolve) => server.close(resolve));
});

await test('QQ空间：点赞/评论默认关闭，显式开启后才可用', async ({ h, st }) => {
  const { server, port } = await startServer(h);
  const seen = [];
  h.bot.request = async (action) => { seen.push(action); return { status: 'ok', retcode: 0, data: {} }; };
  // 默认：tools 里没有 qzoneInteract —— 必须按「关闭」处理（这是本次的关键安全默认）
  delete h.cfg.socialV2.tools?.qzoneInteract;

  const off = await httpPost(port, '/api/socialV2/qzone-like', { key: KEY, targetUin: 1, tid: 'x' }, { 'x-agent-token': st.agentToken });
  assert.equal(off.status, 403, '缺键必须视为关闭，不能默认放开对外可见的点赞');
  assert.equal(seen.length, 0, '关闭时绝不能真的调用上游');

  const offComment = await httpPost(port, '/api/socialV2/qzone-comment', { key: KEY, targetUin: 1, tid: 'x', content: '你好' }, { 'x-agent-token': st.agentToken });
  assert.equal(offComment.status, 403);

  // 显式打开后才放行
  h.cfg.socialV2.tools = { ...(h.cfg.socialV2.tools ?? {}), qzoneInteract: true };
  const on = await httpPost(port, '/api/socialV2/qzone-like', { key: KEY, targetUin: 1, tid: 'x', abstime: 1700000000 }, { 'x-agent-token': st.agentToken });
  assert.equal(on.status, 200);
  assert.deepEqual(seen, ['like_qzone']);
  await new Promise((resolve) => server.close(resolve));
});

await test('QQ空间：聚合动态剥掉 HTML 只留短摘要，且不带 tid', async ({ h, st }) => {
  const { server, port } = await startServer(h);
  const nowSec = Math.floor(Date.now() / 1000);
  h.bot.request = async () => ({
    status: 'ok',
    retcode: 0,
    data: {
      has_more: true,
      feeds: [
        { uin: 111, nickname: '阿甲', time: nowSec - 3600, html: '<div class="f"><script>evil()</script><b>今天</b>去爬山了&nbsp;好累</div>' },
        { uin: 222, nickname: '阿乙', time: nowSec - 30 * 86400, html: '<p>很久以前</p>' }
      ]
    }
  });

  const r = await httpPost(port, '/api/socialV2/qzone-feeds', { key: KEY, days: 7 }, { 'x-agent-token': st.agentToken });
  assert.equal(r.status, 200);
  assert.equal(r.data.count, 1, '30 天前那条必须被滤掉');
  assert.equal(r.data.feeds[0].uin, 111);
  assert.equal(r.data.feeds[0].summary, '今天 去爬山了 好累');
  assert.ok(!r.data.feeds[0].summary.includes('evil'), 'script 内容不得漏进摘要');
  assert.ok(!('html' in r.data.feeds[0]), '原始 HTML 不得回传给模型');
  assert.equal(r.data.firstPageOnly, true, '必须如实说明只取了首页');
  await new Promise((resolve) => server.close(resolve));
});

await test('QQ空间：点赞/评论占用发送预算（不能绕开发言限流刷屏）', async ({ h, st }) => {
  const { server, port } = await startServer(h);
  h.cfg.socialV2.tools = { ...(h.cfg.socialV2.tools ?? {}), qzoneInteract: true };
  h.cfg.socialV2.send = { maxSendPerMinute: 1, maxSendPerHour: 0 };
  h.bot.request = async () => ({ status: 'ok', retcode: 0, data: {} });

  const first = await httpPost(port, '/api/socialV2/qzone-like', { key: KEY, targetUin: 1, tid: 'a' }, { 'x-agent-token': st.agentToken });
  assert.equal(first.status, 200);
  const second = await httpPost(port, '/api/socialV2/qzone-comment', { key: KEY, targetUin: 1, tid: 'b', content: '你好' }, { 'x-agent-token': st.agentToken });
  assert.equal(second.status, 429, '第二次必须被发送预算挡住');
  await new Promise((resolve) => server.close(resolve));
});

await test('QQ空间：好友时间线按窗口聚合、跳过保密好友并分类统计', async ({ h, st }) => {
  const { server, port } = await startServer(h);
  h.cfg.socialV2.qzone = { minIntervalMs: 0, cacheTtlMs: 0 };
  const nowSec = Math.floor(Date.now() / 1000);
  h.bot.request = async (action, params) => {
    if (action === 'get_friend_list') {
      return { status: 'ok', retcode: 0, data: [
        { user_id: 111, nickname: '阿甲', remark: '' },
        { user_id: 222, nickname: '阿乙', remark: '' },
        { user_id: 333, nickname: '阿丙', remark: '' }
      ] };
    }
    if (action === 'get_qzone_msg_list') {
      if (Number(params.target_uin) === 222) {
        // 真实场景：对方设置了保密，SnowLuma 抛出带 code 的错误
        return { status: 'failed', retcode: 100, wording: 'qzone msglist failed: code=-10031 对不起,主人设置了保密' };
      }
      if (Number(params.target_uin) === 333) {
        return { status: 'ok', retcode: 0, data: { total: 1, msglist: [
          { tid: 'old', time: nowSec - 30 * 86400, content: '一个月前', pic: [] }
        ] } };
      }
      return { status: 'ok', retcode: 0, data: { total: 2, msglist: [
        { tid: 'n1', time: nowSec - 7200, content: '两小时前', cmtnum: 2, pic: [] },
        { tid: 'n2', time: nowSec - 5 * 86400, content: '五天前', pic: [] }
      ] } };
    }
    return { status: 'ok', retcode: 0, data: {} };
  };

  const r = await httpPost(port, '/api/socialV2/qzone-timeline', { key: KEY, days: 7, maxFriends: 10, perFriend: 5 }, { 'x-agent-token': st.agentToken });
  assert.equal(r.status, 200);
  assert.deepEqual(Array.from(r.data.items, (i) => i.tid), ['n1', 'n2'], '必须按时间降序、且滤掉窗口外的');
  assert.equal(r.data.items[0].uin, '111');
  assert.equal(r.data.stats.friendsScanned, 2, '阿甲与阿丙应被扫到，阿乙因保密跳过');
  assert.equal(r.data.stats.friendsSkipped, 1);
  assert.equal(r.data.stats.skipReasons['无权限（对方设置了保密）'], 1, '跳过原因必须分类统计');
  assert.ok(r.data.stats.requests >= 4, '请求次数应被统计（1 次好友列表 + 3 次说说）');
  await new Promise((resolve) => server.close(resolve));
});

await test('QQ空间：上游限流（-10000）时自动退避重试', async ({ h, st }) => {
  const { server, port } = await startServer(h);
  h.cfg.socialV2.qzone = { minIntervalMs: 0, cacheTtlMs: 0 };
  const nowSec = Math.floor(Date.now() / 1000);
  let attempts = 0;
  h.bot.request = async () => {
    attempts += 1;
    if (attempts === 1) {
      return { status: 'failed', retcode: 100, wording: 'qzone msglist failed: code=-10000 使用人数过多，请稍后再试' };
    }
    return { status: 'ok', retcode: 0, data: { total: 1, msglist: [
      { tid: 'ok1', time: nowSec - 3600, content: '来了', pic: [] }
    ] } };
  };

  const r = await httpPost(port, '/api/socialV2/qzone-posts', { key: KEY, targetUin: 111, days: 7 }, { 'x-agent-token': st.agentToken });
  assert.equal(r.status, 200, '限流后重试应当最终成功');
  assert.ok(attempts >= 2, `必须真的重试过（实际 ${attempts} 次）`);
  assert.equal(r.data.posts[0].tid, 'ok1');
  await new Promise((resolve) => server.close(resolve));
});

await test('QQ空间：取消赞只允许取消本地记录过的赞（账本护栏）', async ({ h, st }) => {
  const { server, port } = await startServer(h);
  h.cfg.socialV2.tools = { ...(h.cfg.socialV2.tools ?? {}), qzoneInteract: true };
  h.cfg.socialV2.qzone = { minIntervalMs: 0, cacheTtlMs: 0 };
  const seen = [];
  h.bot.request = async (action) => { seen.push(action); return { status: 'ok', retcode: 0, data: {} }; };

  // ① 从没点过就要取消 —— 必须拒绝，且绝不能打上游
  const bad = await httpPost(port, '/api/socialV2/qzone-like', { key: KEY, targetUin: 1, tid: 'zzz', like: false }, { 'x-agent-token': st.agentToken });
  assert.equal(bad.status, 409, '未记录过的取消赞必须被拒');
  assert.deepEqual(seen, [], '被拒时不得调用上游');

  // ② 点赞 -> 记账
  const liked = await httpPost(port, '/api/socialV2/qzone-like', { key: KEY, targetUin: 1, tid: 'zzz', abstime: 1700000000 }, { 'x-agent-token': st.agentToken });
  assert.equal(liked.status, 200);
  assert.equal(liked.data.verified, false, '必须如实告知效果无法读回校验');

  // ③ 现在允许取消
  const un = await httpPost(port, '/api/socialV2/qzone-like', { key: KEY, targetUin: 1, tid: 'zzz', like: false }, { 'x-agent-token': st.agentToken });
  assert.equal(un.status, 200);
  assert.deepEqual(seen, ['like_qzone', 'unlike_qzone']);

  // ④ 取消后再取消：账本已清空，回到"没记录"
  const again = await httpPost(port, '/api/socialV2/qzone-like', { key: KEY, targetUin: 1, tid: 'zzz', like: false }, { 'x-agent-token': st.agentToken });
  assert.equal(again.status, 409);

  // ⑤ force 可显式绕过
  const forced = await httpPost(port, '/api/socialV2/qzone-like', { key: KEY, targetUin: 1, tid: 'zzz', like: false, force: true }, { 'x-agent-token': st.agentToken });
  assert.equal(forced.status, 200);
  await new Promise((resolve) => server.close(resolve));
});

await test('QQ空间：时间线结果有 TTL 缓存，noCache 可绕过', async ({ h, st }) => {
  const { server, port } = await startServer(h);
  h.cfg.socialV2.qzone = { minIntervalMs: 0, cacheTtlMs: 60000 };
  let calls = 0;
  h.bot.request = async (action) => {
    calls += 1;
    if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: 111, nickname: '甲' }] };
    return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
  };

  const a = await httpPost(port, '/api/socialV2/qzone-timeline', { key: KEY, days: 7 }, { 'x-agent-token': st.agentToken });
  assert.equal(a.data.cached, false);
  const afterFirst = calls;
  const b = await httpPost(port, '/api/socialV2/qzone-timeline', { key: KEY, days: 7 }, { 'x-agent-token': st.agentToken });
  assert.equal(b.data.cached, true, '同参数第二次应命中缓存');
  assert.equal(calls, afterFirst, '命中缓存时不得再打上游');
  const c = await httpPost(port, '/api/socialV2/qzone-timeline', { key: KEY, days: 7, noCache: true }, { 'x-agent-token': st.agentToken });
  assert.equal(c.data.cached, false, 'noCache 应绕过缓存');
  assert.ok(calls > afterFirst, 'noCache 时必须重新打上游');
  await new Promise((resolve) => server.close(resolve));
});

console.log(`\nIngest resilience regressions: ${tests - failures}/${tests} passed.`);
process.exit(failures ? 1 : 0);
