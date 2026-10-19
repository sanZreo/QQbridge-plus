// 三代关系信号（src/member-signals.js）的纯函数测试。
//
// 阶段 0 的护栏：这段逻辑将来要驱动"该不该主动找某个人"，算错了会直接变成
// 骚扰真实群友，所以计数语义必须被钉死（尤其"双向信号"的定义与窗口边界）。
import assert from 'node:assert/strict';
import {
  deriveMemberSignals,
  compareWithImpressions,
  applyTierHysteresis,
  memberKeyOf,
  SIGNAL_WINDOW_MS,
  REPLY_WINDOW_MS,
  TIER_HOLD_MS,
} from '../src/member-signals.js';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  OK   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
};

const T0 = 1_700_000_000_000;
const mine = (text, time) => ({ sender: '我', plain: text, text, isSelf: true, time });
const theirs = (sender, text, time, extra = {}) => ({ sender, plain: text, text, isSelf: false, time, ...extra });

test('memberKeyOf 优先用 QQ 号，缺号时退回昵称', () => {
  assert.equal(memberKeyOf({ userId: 10001, sender: '甲' }), 'u:10001');
  assert.equal(memberKeyOf({ sender: '甲' }), 'n:甲');
  assert.equal(memberKeyOf({ sender: '  ' }), '');
});

test('空状态不炸，返回空结果', () => {
  const r = deriveMemberSignals({}, { now: T0 });
  assert.deepEqual(r.members, []);
  assert.deepEqual(r.top, []);
  assert.equal(r.considered, 0);
});

test('自己的发言不算群友，但计入 selfMessages', () => {
  const r = deriveMemberSignals({ recentMessages: [mine('大家好', T0), mine('在吗', T0 + 1000)] }, { now: T0 + 2000 });
  assert.equal(r.selfMessages, 2);
  assert.equal(r.members.length, 0);
});

test('三条计数语义：引用我 / 我发言后 3 分钟内接话 / 其它发言', () => {
  const r = deriveMemberSignals({
    recentMessages: [
      mine('我说一句', T0),
      theirs('甲', '接话', T0 + 60_000),                    // 1 分钟后 → repliesToMyMessage
      theirs('乙', '引用我', T0 + 120_000, { quoteTargetIsSelf: true }), // 引用 → quotesMe
      theirs('丙', '自言自语', T0 + 40 * 60_000),            // 40 分钟后 → 都不算
    ],
  }, { now: T0 + 60 * 60_000 });
  const by = Object.fromEntries(r.members.map((m) => [m.name, m]));
  assert.equal(by['甲'].repliesToMyMessage, 1);
  assert.equal(by['甲'].quotesMe, 0);
  assert.equal(by['乙'].quotesMe, 1);
  assert.equal(by['乙'].repliesToMyMessage, 0);
  assert.equal(by['丙'].messages, 1);
  assert.equal(by['丙'].twoWay, 0);
});

test('引用我且紧跟我的发言时，只算引用（不重复计数）', () => {
  const r = deriveMemberSignals({
    recentMessages: [mine('原话', T0), theirs('甲', '引用并接话', T0 + 1000, { quoteTargetIsSelf: true })],
  }, { now: T0 + 10_000 });
  assert.equal(r.members[0].quotesMe, 1);
  assert.equal(r.members[0].repliesToMyMessage, 0);
  assert.equal(r.members[0].twoWay, 1, '一条消息只能贡献 1 次双向信号');
});

test('超过 3 分钟的接话不算回应我（边界：正好 3 分钟算）', () => {
  const at = deriveMemberSignals({ recentMessages: [mine('说', T0), theirs('甲', '踩线', T0 + REPLY_WINDOW_MS)] }, { now: T0 + REPLY_WINDOW_MS + 1 });
  assert.equal(at.members[0].repliesToMyMessage, 1);
  const past = deriveMemberSignals({ recentMessages: [mine('说', T0), theirs('甲', '超时', T0 + REPLY_WINDOW_MS + 1)] }, { now: T0 + REPLY_WINDOW_MS + 2 });
  assert.equal(past.members[0].repliesToMyMessage, 0, '紧邻我的发言但如果超出窗口就不算');
});

test('7 天窗口：更早的消息被排除，且不影响 considered', () => {
  const old = T0 - SIGNAL_WINDOW_MS - 1000;
  const r = deriveMemberSignals({
    recentMessages: [theirs('甲', '很久以前', old), theirs('乙', '最近', T0)],
  }, { now: T0 + 1000 });
  assert.equal(r.considered, 1);
  assert.deepEqual(r.members.map((m) => m.name), ['乙']);
});

test('分档：双向≥3 算熟；发言≥20 且≥1 次双向算一般；其余是新的', () => {
  const msgs = [];
  for (let i = 0; i < 3; i++) msgs.push(theirs('甲', `引用${i}`, T0 + i * 1000, { quoteTargetIsSelf: true }));
  for (let i = 0; i < 20; i++) msgs.push(theirs('乙', `话${i}`, T0 + 100_000 + i * 1000));
  msgs.push(mine('我说话', T0 + 200_000));
  msgs.push(theirs('乙', '接一下', T0 + 200_500));
  msgs.push(theirs('丙', '路过', T0 + 300_000));
  const r = deriveMemberSignals({ recentMessages: msgs }, { now: T0 + 400_000 });
  const by = Object.fromEntries(r.members.map((m) => [m.name, m]));
  assert.equal(by['甲'].tier, 'familiar');
  assert.equal(by['乙'].tier, 'normal');
  assert.equal(by['丙'].tier, 'new');
  assert.deepEqual(r.byTier.familiar, ['甲']);
});

test('排序：先按双向信号，再按发言数', () => {
  const r = deriveMemberSignals({
    recentMessages: [
      theirs('话多但单向', 'x', T0 + 1000), theirs('话多但单向', 'y', T0 + 2000), theirs('话多但单向', 'z', T0 + 3000),
      theirs('引用一次', 'q', T0 + 4000, { quoteTargetIsSelf: true }),
    ],
  }, { now: T0 + 10_000 });
  assert.deepEqual(r.members.map((m) => m.name), ['引用一次', '话多但单向']);
  assert.deepEqual(r.top, ['引用一次', '话多但单向']);
});

test('mentionsMe 只在给了关键词时统计', () => {
  const st = { recentMessages: [theirs('甲', '小鲸鱼在吗', T0 + 1000), theirs('乙', '无关', T0 + 2000)] };
  const off = deriveMemberSignals(st, { now: T0 + 3000 });
  assert.equal(off.members.find((m) => m.name === '甲').mentionsMe, 0);
  const on = deriveMemberSignals(st, { now: T0 + 3000, keywords: ['小鲸鱼', 'deepseek'] });
  assert.equal(on.members.find((m) => m.name === '甲').mentionsMe, 1);
  assert.equal(on.members.find((m) => m.name === '乙').mentionsMe, 0);
});

test('纯函数：不改动传入的 state（不排序、不新增字段）', () => {
  const st = { recentMessages: [mine('我', T0), theirs('甲', 'a', T0 + 1000), theirs('乙', 'b', T0 + 2000)] };
  const snapshot = JSON.stringify(st);
  deriveMemberSignals(st, { now: T0 + 5000 });
  assert.equal(JSON.stringify(st), snapshot);
});

test('同一个人既有 QQ 号又有昵称变化时，按 QQ 号合并', () => {
  const r = deriveMemberSignals({
    recentMessages: [
      theirs('旧昵称', 'a', T0 + 1000, { userId: 777 }),
      theirs('新昵称', 'b', T0 + 2000, { userId: 777 }),
    ],
  }, { now: T0 + 10_000 });
  assert.equal(r.members.length, 1);
  assert.equal(r.members[0].messages, 2);
});

test('对照 AI 自述印象：集合重合 / 顺序 / 漏看与过度关注分开报', () => {
  const st = {
    recentMessages: [
      theirs('甲', 'q', T0 + 1000, { quoteTargetIsSelf: true }),
      theirs('甲', 'q', T0 + 2000, { quoteTargetIsSelf: true }),
      theirs('甲', 'q', T0 + 3000, { quoteTargetIsSelf: true }),
      theirs('乙', 'hi', T0 + 4000),
    ],
    memberImpressions: {
      乙: { traits: ['话多'], interactionCount: 9 },
      甲: { traits: [], interactionCount: 1 },
    },
  };
  const signals = deriveMemberSignals(st, { now: T0 + 10_000 });
  const cmp = compareWithImpressions(signals, st);
  assert.equal(cmp.comparable, true);
  assert.deepEqual(cmp.top3Derived, ['甲', '乙']);
  assert.deepEqual(cmp.top3Self, ['乙', '甲'], 'AI 自述排名与真实排名相反');
  assert.equal(cmp.agree, 2, '榜上是同一批人（集合重合）');
  assert.equal(cmp.sameOrder, 0, '但顺序完全不同 —— 这才是"侧重不一致"');
  assert.deepEqual(cmp.unnoticed, [], '两人都被 AI 记过');
  assert.equal(cmp.rows[0].name, '甲');
  assert.equal(cmp.rows[0].selfRank, 2);
});

test('对照：真正的"表演性关心"证据 —— 真熟人被漏看 + 陌生人被过度关注', () => {
  const st = {
    recentMessages: [
      theirs('真熟人', '引用1', T0 + 1000, { quoteTargetIsSelf: true }),
      theirs('真熟人', '引用2', T0 + 2000, { quoteTargetIsSelf: true }),
      theirs('真熟人', '引用3', T0 + 3000, { quoteTargetIsSelf: true }),
    ],
    // AI 只记了一个几乎不互动的人，还说他很熟；真正一直引用我的人它没记过
    memberImpressions: { 只见过一面: { traits: ['聊得来'], interactionCount: 8 } },
  };
  const signals = deriveMemberSignals(st, { now: T0 + 10_000 });
  const cmp = compareWithImpressions(signals, st);
  assert.deepEqual(cmp.top3Derived, ['真熟人']);
  assert.deepEqual(cmp.unnoticed, ['真熟人'], '桥接算出来的熟人，AI 从没记过');
  assert.deepEqual(cmp.overrated, ['只见过一面'], 'AI 记着的人，真实信号里根本不存在');
  assert.equal(cmp.agree, 0);
  assert.equal(cmp.sameOrder, 0);
});

test('只认「我之后的第一条」：随后 3 分钟内多人说话，不会都算接我话', () => {
  // 这是**真实数据抓到的 bug 回归测试**：2026-10-18 复检发现某个群 familiar 档一天涨到 11 人，
  // 原因是旧实现把"我发言后 3 分钟内所有人"都算成接我话（最猛的一串后面有 5 人 11 条）。
  const r = deriveMemberSignals({
    recentMessages: [
      mine('我说一句', T0),
      theirs('甲', '先接', T0 + 10_000),
      theirs('乙', '跟着聊自己的', T0 + 20_000),
      theirs('丙', '也插一句', T0 + 30_000),
    ],
  }, { now: T0 + 60_000 });
  const by = Object.fromEntries(r.members.map((m) => [m.name, m]));
  assert.equal(by['甲'].repliesToMyMessage, 1, '我之后的第一条算接话');
  assert.equal(by['乙'].repliesToMyMessage, 0, '随后 3 分钟内的其他人不算');
  assert.equal(by['丙'].repliesToMyMessage, 0);
  assert.equal(r.members.filter((m) => m.tier === 'familiar').length, 0, '一次接话不该让人变熟');
});

test('我连续发言成串时，一串只换一次接话', () => {
  const r = deriveMemberSignals({
    recentMessages: [
      mine('第一句', T0),
      mine('第二句', T0 + 2000),
      mine('第三句', T0 + 4000),
      theirs('甲', '接一下', T0 + 6000),
      theirs('甲', '再补一句', T0 + 8000),
    ],
  }, { now: T0 + 60_000 });
  assert.equal(r.members[0].repliesToMyMessage, 1, '一串发言只换一次接话');
});

test('对照的匹配口径：私聊字面量不误报，QQ 号与「管理员」能对上', () => {
  const st = {
    recentMessages: [
      theirs('私聊', 'x', T0 + 1000, { userId: 2765944470 }),
      theirs('私聊', 'y', T0 + 2000, { userId: 2765944470 }),
    ],
    memberImpressions: { 管理员: { traits: ['主人'], interactionCount: 3 } },
  };
  const signals = deriveMemberSignals(st, { now: T0 + 10_000 });
  const cmp = compareWithImpressions(signals, st, { ownerQQ: 2765944470 });
  assert.deepEqual(cmp.unnoticed, [], 'owner 本人不该被报成"漏看"');
  assert.deepEqual(cmp.overrated, [], 'AI 记的「管理员」就是同一个 owner');
  assert.equal(cmp.rows[0].selfRank, 1, '能对上同一个人，就有排名');
  // top3 的口径必须与 ⚠️ 判定一致：不能出现"⚠️ 行为空但榜上重合 0/3"的自相矛盾报告
  assert.equal(cmp.agree, 1, 'owner 在 AI 的 top3 里（别名命中），所以重合数应为 1');
  assert.equal(cmp.sameOrder, 1);
  assert.deepEqual(cmp.overlap, ['私聊']);
  // 不传 ownerQQ 时会退化成"对不上" —— 说明这个参数是必需的，不是可选的装饰
  const loose = compareWithImpressions(signals, st);
  assert.deepEqual(loose.overrated, ['管理员']);
});

test('对照：任一侧没数据时 comparable 为 false，且不得输出偏差结论', () => {
  const signals = deriveMemberSignals({ recentMessages: [theirs('甲', 'x', T0)] }, { now: T0 + 1000 });
  const noImpressions = compareWithImpressions(signals, {});
  assert.equal(noImpressions.comparable, false);
  // 关键：AI 什么都没记时，不能把"所有熟人"都报成漏看（首版快照就是这么误报的）
  assert.deepEqual(noImpressions.unnoticed, [], 'AI 没有印象时不得输出"漏看"');
  assert.deepEqual(noImpressions.overrated, []);
  const empty = deriveMemberSignals({}, { now: T0 });
  const noMembers = compareWithImpressions(empty, { memberImpressions: { 甲: { interactionCount: 1 } } });
  assert.equal(noMembers.comparable, false);
  assert.deepEqual(noMembers.overrated, [], '桥接没看到人时不得输出"过度关注"');
});


// ── 阶段 2：档位粘滞 ─────────────────────────────────────────────────────────
// 目的：窗口滚动（recentLimit=100）不得让同一个人几天内忽熟忽生。
const tierSig = (pairs) => ({
  members: pairs.map(([key, name, tier]) => ({ key, name, tier, twoWay: 0, messages: 0 })),
  byTier: { familiar: [], normal: [], new: [] },
});

test('粘滞：升档立即生效（真互动变多要马上反映）', () => {
  const r = applyTierHysteresis(tierSig([['u:1', '甲', 'familiar']]), { 'u:1': { tier: 'new', at: T0 } }, { now: T0 + 1000 });
  assert.equal(r.members[0].tier, 'familiar');
  assert.equal(r.tiers['u:1'].tier, 'familiar');
  assert.deepEqual(r.hysteresis.held, []);
});

test('粘滞：降档在保持期内不生效，但 rawTier 如实保留', () => {
  const now = T0 + 24 * 3600 * 1000;
  const r = applyTierHysteresis(tierSig([['u:1', '甲', 'new']]), { 'u:1': { tier: 'familiar', at: T0 } }, { now });
  assert.equal(r.members[0].tier, 'familiar', '72h 内不得降档');
  assert.equal(r.members[0].rawTier, 'new', '真实档位必须如实保留（否则报告会看不到偏差）');
  assert.deepEqual(r.byTier.familiar, ['甲']);
  assert.equal(r.hysteresis.held.length, 1);
  assert.equal(r.hysteresis.held[0].name, '甲');
});

test('粘滞：超过保持期必须降档，且保持期不因每轮重算而续期', () => {
  const sig = tierSig([['u:1', '甲', 'new']]);
  const expired = applyTierHysteresis(sig, { 'u:1': { tier: 'familiar', at: T0 } }, { now: T0 + TIER_HOLD_MS + 1000 });
  assert.equal(expired.members[0].tier, 'new', '超过 72h 必须按真实信号降档');
  // 关键：保持期内 `at` 用的是旧时间戳。若每轮刷新，熟人就永远降不下来。
  const holding = applyTierHysteresis(sig, { 'u:1': { tier: 'familiar', at: T0 } }, { now: T0 + TIER_HOLD_MS - 1000 });
  assert.equal(holding.tiers['u:1'].at, T0, '保持期内不得刷新 at');
});

test('粘滞：没有历史 / 空状态都不炸，且不引入未知档位', () => {
  const empty = applyTierHysteresis({ members: [] }, {}, { now: T0 });
  assert.deepEqual(empty.tiers, {});
  assert.deepEqual(empty.byTier, { familiar: [], normal: [], new: [] });
  const noPrev = applyTierHysteresis(tierSig([['u:2', '乙', 'normal']]), null, { now: T0 });
  assert.equal(noPrev.members[0].tier, 'normal');
  assert.equal(noPrev.tiers['u:2'].tier, 'normal');
});

console.log(`\nmember-signals: ${passed} passed${process.exitCode ? '（有失败）' : ''}`);
