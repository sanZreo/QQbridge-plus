// 三代阶段 1：关系分寸注入 + 主动机会硬闸门。
// 这一组断言的共同目的是：**防止阶段 1 悄悄退化成"更主动"**。
// 判据来自 docs/audits/GEN3_DESIGN_BASELINE_2026-10-16.md 的 5 条硬约束：
//   ① 主动只允许接话/追问，禁止无锚点问候 —— 靠 prompt 文案 + 桥接闸门共同保证；
//   ② 单群每周 ≤3 次、同一人不连续两天 —— 必须落在桥接（proactiveGateV2）；
//   ③ 熟人必须双向信号 —— 分档来自 deriveMemberSignals 的 twoWay；
//   ④ 信号不生成"上心程度" —— 只给档位标签；
//   ⑤ **原始数值永不进 prompt** —— 这条最容易在后续改动里被破坏，专门有断言钉住。
import assert from 'node:assert/strict';
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

const KEY = 'group:456';

/** 造一个"熟 / 一般 / 新"三档都有的会话。 */
async function seed(h, key = KEY) {
  const now = Date.now();
  // 熟：3 次引用我（twoWay=3，达 familiar 门槛）
  for (let i = 0; i < 3; i++) {
    h.appendSocialV2Message(key, '阿强', `追问${i}`, `追问${i}`, true, false, 9000 + i, [], 1001);
  }
  // 一般：20 条发言 + 1 次引用（messages>=20 且 twoWay>=1 ⇒ normal）
  for (let i = 0; i < 20; i++) {
    h.appendSocialV2Message(key, '小美', `闲聊${i}`, `闲聊${i}`, false, false, 9100 + i, [], 1002);
  }
  h.appendSocialV2Message(key, '小美', '问一句', '问一句', true, false, 9150, [], 1002);
  // 新：2 条单向发言
  for (let i = 0; i < 2; i++) {
    h.appendSocialV2Message(key, '路人', `路过${i}`, `路过${i}`, false, false, 9200 + i, [], 1003);
  }
  // 制造一次主动轮 @：让 proactiveTargets 有内容
  const st = h.getSocialV2State(key);
  st.lastWakeReason = 'proactiveCheck';
  st.wakeConfig = { ...(st.wakeConfig ?? {}), lastWakeAt: now };
  h.recordSentMessagesV2(key, ['@阿强 出来聊']);
  return h.getSocialV2State(key);
}

await test('关系分寸块：只给档位、绝不给数字', async (h) => {
  await seed(h);
  const prompt = h.buildWakePromptV2(KEY, 'newMessage');
  assert.ok(prompt.includes('【关系分寸】'), '必须注入关系分寸块');
  const block = prompt.split('【关系分寸】')[1].split('\n\n')[0];
  // ⑤ 原始数值永不进 prompt：双向数、发言数、互动次数都不能出现
  // （否则它会说出"你回我好快"这种监控感的话）
  assert.doesNotMatch(block, /双向|发言\s*\d|互动\s*\d|引用我\s*\d|\b\d+\s*次\b/,
    `分档块不得出现任何原始计数：${block}`);
  // 三档都要出现，且阿强在"熟"、小美在"一般"、路人在"没什么来回"
  assert.match(block, /聊得来[^\n]*阿强/, `阿强应在"熟"档：${block}`);
  assert.match(block, /不算熟[^\n]*小美/, `小美应在"一般"档：${block}`);
  assert.match(block, /没什么来回[^\n]*路人/, `路人应在"新"档：${block}`);
  // 主动找过的人要被告知，且语气是"别再找"
  assert.match(block, /最近主动找过[^\n]*阿强/, `应告知最近主动找过阿强：${block}`);
  assert.match(block, /别连着两天/, '必须带"别连着两天"的约束语气');
  // 文案必须是收敛语气（"少说"），不能出现鼓励主动的措辞
  assert.match(block, /少说/, '分档块的用途是让它少说');
  assert.doesNotMatch(block, /更热情|多关心|主动套近乎/, '不得出现鼓励更主动的措辞');
});

await test('关系分寸块：没有成员信号时**不注入**（宁可少说也不编造）', async (h) => {
  const prompt = h.buildWakePromptV2('group:789', 'newMessage');
  assert.ok(!prompt.includes('【关系分寸】'), '无信号的会话不得注入关系分寸');
});

await test('proactiveGateV2：单群每周 ≤3 次', async (h) => {
  const st = h.getSocialV2State(KEY);
  const now = Date.now();
  st.proactiveTargets = {};
  // 语义：本周已发生 2 次 ⇒ 第 3 次放行；已发生 3 次 ⇒ 第 4 次拦下（"每周 ≤3 次"）。
  // 8 天前的旧账在 7 天窗口外，不得计入。
  // （踩坑：6*24h 仍在 7 天窗口内，别用它当"旧账"。）
  st.proactiveWakeTimes = [now - 8 * 24 * 3600 * 1000, now - 3600_000, now - 1800_000];
  // 注意：不能对 VM 闭包返回的对象用 deepEqual —— 原型可能不同（同 test-audit-bridge 的坑）。
  // 按字段断言即可。
  const first = h.proactiveGateV2(st, now);
  assert.equal(first.allowed, true, `本周 2 次时应放行第 3 次（实际 ${JSON.stringify(first)}）`);
  st.proactiveWakeTimes.push(now - 600_000);
  const gate = h.proactiveGateV2(st, now);
  assert.equal(gate.allowed, false, '本周已 3 次，第 4 次要被拦下');
  assert.match(gate.reason, /上限/, '拦截原因要说明是周上限');
  // 超窗口的旧账不得计入
  const stale = h.getSocialV2State('group:789');
  stale.proactiveWakeTimes = Array.from({ length: 10 }, (_, i) => now - (8 + i) * 24 * 3600 * 1000);
  stale.proactiveTargets = {};
  assert.equal(h.proactiveGateV2(stale, now).allowed, true, '8 天前的旧账不得占用本周额度');
});

await test('proactiveGateV2：24h 内主动找过的人 ⇒ 本轮主动作废', async (h) => {
  const st = h.getSocialV2State(KEY);
  const now = Date.now();
  st.proactiveWakeTimes = [];
  st.proactiveTargets = { 'u:1001': now - 2 * 3600 * 1000 };
  const gate = h.proactiveGateV2(st, now);
  assert.equal(gate.allowed, false, '最近 2 小时找过的人，不得再主动');
  assert.match(gate.reason, /24h|连着两天/, '原因要体现"同一人不连续两天"');
  // 超过 24h 就解禁
  st.proactiveTargets = { 'u:1001': now - 25 * 3600 * 1000 };
  assert.equal(h.proactiveGateV2(st, now).allowed, true, '超过 24h 应解禁');
});

await test('proactiveGateV2：可配置覆盖默认值（config 可关/可调）', async (h) => {
  const st = h.getSocialV2State(KEY);
  const now = Date.now();
  st.proactiveWakeTimes = [now - 1000, now - 2000, now - 3000, now - 4000];
  st.proactiveTargets = {};
  h.cfg.socialV2 = { ...(h.cfg.socialV2 ?? {}), proactive: { ...(h.cfg.socialV2?.proactive ?? {}), maxPerWeek: 5 } };
  assert.equal(h.proactiveGateV2(st, now).allowed, true, 'maxPerWeek=5 时应放行 4 次');
  h.cfg.socialV2.proactive.maxPerWeek = 1;
  assert.equal(h.proactiveGateV2(st, now).allowed, false, 'maxPerWeek=1 时第 2 次要被拦');
});

await test('主动记账落盘：proactiveWakeTimes 与 proactiveTargets 都在 save 白名单里', async (h) => {
  const st = h.getSocialV2State(KEY);
  const now = Date.now();
  st.proactiveWakeTimes = [now - 1000];
  st.proactiveTargets = { 'u:1001': now - 1000 };
  h.saveSocialV2State();
  const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'));
  const row = saved.conversations[KEY];
  assert.deepEqual(row.proactiveWakeTimes, [now - 1000], 'proactiveWakeTimes 必须落盘');
  assert.deepEqual(row.proactiveTargets, { 'u:1001': now - 1000 }, 'proactiveTargets 必须落盘');
  // 旧文件缺这两个字段：加载后不得丢其它数据
  const legacy = { paused: false, conversations: { [KEY]: { wakeConfig: { mode: 'diving', triggers: {} }, recentMessages: [] } } };
  fs.writeFileSync(path.join(h.temp, 'state/social-v2.json'), JSON.stringify(legacy));
  h.socialV2.conversations.delete(KEY);
  h.loadSocialV2State();
  const reloaded = h.socialV2.conversations.get(KEY);
  assert.ok(reloaded, '旧文件必须能加载');
  assert.equal(typeof reloaded.proactiveWakeTimes, 'object', '缺字段时 proactiveWakeTimes 要有默认值');
  assert.equal(Array.isArray(reloaded.proactiveWakeTimes), true, '缺字段时 proactiveWakeTimes 应为空数组');
  assert.equal(typeof reloaded.proactiveTargets, 'object', '缺字段时 proactiveTargets 要有默认值');
});


await test('阶段 2 · 话题出处锚点：写入时记下最后一条别人的消息，且能落盘回读', async (h) => {
  h.appendSocialV2Message(KEY, '阿强', '周末去爬山吗', '周末去爬山吗', false, false, 9001, [], 1001);
  const st = h.getSocialV2State(KEY);
  h.appendMemoryV2(st, 'activeTopic', '周末爬山的事', { pendingQuestion: '他到底去不去' });
  const topic = (st.activeTopics || []).find((t) => t.text === '周末爬山的事');
  assert.ok(topic, '话题必须写入');
  assert.ok(topic.sourceRef, '必须带出处锚点');
  assert.equal(topic.sourceRef.from, '阿强', '出处应是最后一条别人的消息');
  assert.match(topic.sourceRef.excerpt, /爬山/, `出处要留原文片段：${JSON.stringify(topic.sourceRef)}`);
  assert.ok(topic.sourceRef.seq > 0, '出处要带 seq，才能机器校验"能不能在历史里找到"');
  // 落盘 → 重新加载：save/load 白名单两侧都加了字段，不许丢
  h.saveSocialV2State();
  h.socialV2.conversations.clear();
  h.loadSocialV2State();
  const back = h.socialV2.conversations.get(KEY);
  const t2 = (back.activeTopics || []).find((t) => t.text === '周末爬山的事');
  assert.ok(t2 && t2.sourceRef && t2.sourceRef.from === '阿强', 'sourceRef 必须能持久化回读');
});

await test('阶段 2 · 话题 TTL：24h 内全留，24h~7d 只留待追问，超 7d 一律清', async (h) => {
  h.appendSocialV2Message(KEY, '小美', '随便聊聊', '随便聊聊', false, false, 9100, [], 1002);
  const st = h.getSocialV2State(KEY);
  const now = Date.now();
  const H = 3600 * 1000;
  st.activeTopics = [
    { text: '刚聊的', lastMentionAt: now - 1 * H, pendingQuestion: '' },
    { text: '昨天的闲聊', lastMentionAt: now - 30 * H, pendingQuestion: '' },
    { text: '昨天的追问', lastMentionAt: now - 30 * H, pendingQuestion: '他后来答应了吗' },
    { text: '八天前的追问', lastMentionAt: now - 8 * 24 * H, pendingQuestion: '早该忘了' },
  ];
  h.appendMemoryV2(st, 'activeTopic', '触发一次清理');
  const texts = (st.activeTopics || []).map((t) => t.text);
  assert.ok(texts.includes('刚聊的'), '24h 内必须保留');
  assert.ok(texts.includes('昨天的追问'), '24h~7d 的"真·未完"必须保留');
  assert.equal(texts.includes('昨天的闲聊'), false, '24h 之后的闲聊必须清掉（不然攒一堆凉话题）');
  assert.equal(texts.includes('八天前的追问'), false, '超过 7 天一律清（硬上限）');
});

await test('阶段 2 · 档位粘滞：窗口把熟人滚出去后，72h 内不立刻改口', async (h) => {
  await seed(h);
  let prompt = h.buildWakePromptV2(KEY, 'newMessage');
  assert.match(prompt, /聊得来[^\n]*阿强/, '初始应为熟');
  const st = h.getSocialV2State(KEY);
  // 模拟 recentLimit 截断：阿强的 3 次引用被滚出窗口，只剩 1 条普通发言
  st.recentMessages = (st.recentMessages || []).filter((m) => !(m.sender === '阿强' && m.quoteTargetIsSelf));
  h.appendSocialV2Message(KEY, '阿强', '嗯', '嗯', false, false, 9300, [], 1001);
  prompt = h.buildWakePromptV2(KEY, 'newMessage');
  assert.match(prompt, /聊得来[^\n]*阿强/, '72h 内不得因窗口滚动就改口');
  assert.equal(st.memberTiers['u:1001'].tier, 'familiar', '粘滞后档位要留在 state 里');
  // 超过保持期后必须降档（否则粘滞就等于永久固化）
  st.memberTiers['u:1001'].at = Date.now() - 80 * 3600 * 1000;
  prompt = h.buildWakePromptV2(KEY, 'newMessage');
  assert.match(prompt, /没什么来回[^\n]*阿强/, '超过 72h 必须按真实信号降档');
});

console.log(failures ? `\n${failures} failed` : '\nall phase-1 assertions passed');
if (failures) process.exitCode = 1;
