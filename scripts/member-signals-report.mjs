// 三代阶段 0 的**离线取证脚本**：直接读 state/social-v2.json，算出每个会话里
// 「桥接派生的真实互动排名」并与「AI 自述的印象排名」对照，回答三个问题：
//   1. AI 漏看了谁（桥接算他很熟，AI 一次都没记过）→ unnoticed
//   2. AI 过度关注谁（AI 记着还很熟，真实信号里他几乎不存在）→ overrated
//   3. 分档分布如何（familiar/normal/new 各多少人）
//
// 为什么要有它：桥接里那个只读端点需要**重启 bridge** 才能用，而验收证据不该等重启。
// 本脚本只读状态文件、不碰网络、不改任何数据；与桥接内端点复用**同一个模块**
// （src/member-signals.js），所以两边算出来的东西必然一致。
//
// 用法：
//   node scripts/member-signals-report.mjs                 # 全部会话摘要
//   node scripts/member-signals-report.mjs group:123456     # 只看某个会话的明细
//   node scripts/member-signals-report.mjs --json          # 输出原始 JSON（给机器读）
//   node scripts/member-signals-report.mjs --snapshot      # 追加一条快照，供"隔天对比"
//     （默认写到仓库**上一级**——即会话工作区根的 gen3-signal-snapshots.jsonl；
//      刻意不写进 qq-bridge/：沙箱里的 shell 对仓库子目录没有写权限，而工作区根可以。
//      要用别的路径：--snapshot=<文件>）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveMemberSignals, compareWithImpressions, applyTierHysteresis } from '../src/member-signals.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STATE_FILE = path.join(ROOT, 'state', 'social-v2.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const snapshotArg = argv.find((a) => a === '--snapshot' || a.startsWith('--snapshot='));
const snapshotFile = snapshotArg
  ? (snapshotArg.includes('=') ? snapshotArg.slice('--snapshot='.length) : path.join(ROOT, '..', 'gen3-signal-snapshots.jsonl'))
  : null;
const onlyKey = argv.find((a) => !a.startsWith('--')) ?? null;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const raw = readJson(STATE_FILE, null);
if (!raw) {
  console.error(`读不到状态文件：${STATE_FILE}`);
  process.exit(1);
}
// 状态文件的形状：{ paused, conversations: { 'group:xxx': {...} } }（兼容 states 或直接就是会话表）
const states = (raw.conversations && typeof raw.conversations === 'object' && raw.conversations)
  || (raw.states && typeof raw.states === 'object' && raw.states)
  || raw;
const cfg = readJson(CONFIG_FILE, {});
const keywords = Array.isArray(cfg?.social?.mustReplyKeywords) ? cfg.social.mustReplyKeywords : [];

const now = Date.now();
const keys = Object.keys(states).filter((k) => !onlyKey || k === onlyKey);
if (!keys.length) {
  console.error(onlyKey ? `状态里没有这个会话：${onlyKey}` : '状态里没有任何会话');
  process.exit(1);
}

const rows = [];
for (const key of keys) {
  const st = states[key];
  if (!st || typeof st !== 'object') continue;
  const baseSignals = deriveMemberSignals(st, { now, keywords });
  // 阶段 2：报告/快照与控制台、prompt 用同一套粘滞口径（否则三方数字对不上）
  const signals = applyTierHysteresis(baseSignals, st.memberTiers, { now });
  // ownerQQ 传进去，才能把 AI 写的「管理员」与 owner 本人对上（否则私聊会误报偏差）
  const cmp = compareWithImpressions(signals, st, { ownerQQ: cfg?.ownerQQ });
  rows.push({ key, signals, cmp, st });
}

// 快照：追加一条，供"隔天对比"。刻意只存**可比字段**（排名/计数/偏差名单/覆盖时长），
// 不存原始消息，避免这里变成第二个状态库。
if (snapshotFile) {
  const snapshot = {
    at: new Date(now).toISOString(),
    windowDays: 7,
    conversations: rows.map(({ key, signals, cmp }) => {
      // 覆盖时长/是否截断统一取模块的 coverage，避免报告里出现第二套口径
      return {
        key,
        considered: signals.considered,
        selfMessages: signals.selfMessages,
        coverageHours: signals.coverage?.coverageHours ?? 0,
        coverageDays: signals.coverage?.coverageDays ?? 0,
        truncated: !!signals.coverage?.truncated,
        familiar: signals.byTier.familiar,
        top: signals.members.slice(0, 5).map((m) => ({ name: m.name, twoWay: m.twoWay, messages: m.messages, tier: m.tier })),
        agree: cmp.agree,
        sameOrder: cmp.sameOrder,
        unnoticed: cmp.unnoticed,
        overrated: cmp.overrated,
        comparable: cmp.comparable,
      };
    }),
  };
  try {
    fs.appendFileSync(snapshotFile, `${JSON.stringify(snapshot)}\n`);
    console.log(`快照已追加 → ${snapshotFile}`);
  } catch (error) {
    console.error(`快照写入失败（${snapshotFile}）：${error.message}`);
    process.exitCode = 1;
  }
}

if (asJson) {
  console.log(JSON.stringify(rows.map(({ key, signals, cmp }) => ({
    key,
    windowStart: signals.windowStart,
    considered: signals.considered,
    selfMessages: signals.selfMessages,
    coverage: signals.coverage,
    byTier: signals.byTier,
    top: signals.top,
    agree: cmp.agree,
    sameOrder: cmp.sameOrder,
    unnoticed: cmp.unnoticed,
    overrated: cmp.overrated,
    comparable: cmp.comparable,
    members: signals.members,
  })), null, 2));
  process.exit(0);
}

/** 私聊里 sender 存的是字面量「私聊」，显示时补上 QQ 号，否则报告看不出是谁。 */
const displayName = (m) => {
  const n = String(m?.name ?? '').trim();
  if ((!n || n === '私聊') && m?.userId) return `私聊(${m.userId})`;
  return n || (m?.userId ? `(${m.userId})` : '(未知)');
};

console.log(`关系信号报告 · 窗口起点 ${new Date(now - 7 * 24 * 3600 * 1000).toISOString().slice(0, 16)} · 关键词 ${keywords.length} 个`);
console.log('（数据源：recentMessages，由桥接按消息流派生；不读 AI 自述的 interactionCount 作为排名依据）\n');

let totalMembers = 0;
let totalConsidered = 0;
for (const { key, signals, cmp, st } of rows) {
  totalMembers += signals.members.length;
  totalConsidered += signals.considered;
  const tierText = `熟 ${signals.byTier.familiar.length} / 一般 ${signals.byTier.normal.length} / 新 ${signals.byTier.new.length}`;
  console.log(`── ${key}`);
  console.log(`   窗口内消息 ${signals.considered} 条（我的 ${signals.selfMessages} 条），识别到 ${signals.members.length} 人：${tierText}`);
  // 诚实标注覆盖时长：recentMessages 有 recentLimit（默认 100）条上限，
  // 所以"7 天窗口"实际可能只覆盖几小时 —— 此时信号是**截断样本**，别当全量读。
  // 口径统一由模块的 coverage 给（报告里不再自己算一套）。
  const cov = signals.coverage;
  if (cov && cov.messages) {
    const span = cov.coverageDays < 2 ? `${cov.coverageHours} 小时` : `${cov.coverageDays} 天`;
    console.log(`   数据覆盖 ${span}（${cov.messages} 条）${cov.truncated ? `\n   ⚠️ 已被 recentLimit 截断（7 天窗口只覆盖 ${cov.coverageDays} 天）：分档是「最近这些消息」，不是长期印象` : '（7 天窗口基本可用）'}`);
  }
  if (!signals.members.length) {
    console.log('   （这条会话在窗口内没有群友发言）\n');
    continue;
  }
  console.log('   桥接派生的排名       双向  发言  引用我  接我话  叫我');
  for (const m of signals.members.slice(0, 6)) {
    // `tier←rawTier` = 本档位是粘滞保住的（真实信号已经掉档）。不标出来，
    // 运维会以为"数据支持这个档位"，实际是 72h 保持期在起作用。
    const sticky = m.rawTier && m.rawTier !== m.tier ? `${m.tier}←${m.rawTier}` : m.tier;
    console.log(`   ${displayName(m).slice(0, 16).padEnd(17)}${String(m.twoWay).padStart(4)}${String(m.messages).padStart(6)}${String(m.quotesMe).padStart(8)}${String(m.repliesToMyMessage).padStart(8)}${String(m.mentionsMe).padStart(6)}   [${sticky}]`);
  }
  if (cmp.comparable) {
    console.log(`   对照 AI 自述印象：榜上重合 ${cmp.agree}/3，同位 ${cmp.sameOrder}/3`);
    console.log(`     AI 自述 top3：${cmp.top3Self.join('、') || '（无）'}`);
    if (cmp.unnoticed.length) console.log(`     ⚠️ 漏看（桥接算熟、AI 没记过）：${cmp.unnoticed.join('、')}`);
    if (cmp.overrated.length) console.log(`     ⚠️ 过度关注（AI 记着、真实信号里几乎不存在）：${cmp.overrated.join('、')}`);
    if (!cmp.unnoticed.length && !cmp.overrated.length && cmp.agree === 3) console.log('     （两边一致，没有明显偏差）');
  } else {
    console.log('   对照 AI 自述印象：数据不足（一侧为空），暂不可比');
  }
  console.log('');
}

// ── 阶段 2 验收：话题的"出处"还能不能在 recentMessages 里找到 ────────────────
// 基线要求"捡起的话题 100% 能在历史里找到出处（零张冠李戴）"。判据：
// sourceRef.excerpt 的前 12 个字是否仍在窗口内 —— 找不到就说明那段历史
// 已经被 recentLimit=100 裁掉，这条话题**已经无法核实**，必须标出来而不是假装通过。
const VERIFY_HEAD = 12;
let topicTotal = 0;
let topicNoRef = 0;
let topicLost = 0;
const topicLines = [];
for (const { key, st } of rows) {
  const topics = Array.isArray(st?.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
  if (!topics.length) continue;
  topicLines.push(`── ${key}（${topics.length} 条）`);
  for (const t of topics) {
    topicTotal += 1;
    const ref = t.sourceRef;
    const label = String(t.text).slice(0, 24);
    if (!ref || !ref.excerpt) {
      topicNoRef += 1;
      topicLines.push(`   ? 无出处锚点：${label}`);
      continue;
    }
    const head = String(ref.excerpt).slice(0, VERIFY_HEAD);
    const found = (st.recentMessages || []).some((m) => String(m?.plain ?? m?.text ?? '').replace(/\s+/g, ' ').includes(head));
    if (found) {
      topicLines.push(`   OK ${label} ← ${ref.from}：${String(ref.excerpt).slice(0, 30)}`);
    } else {
      topicLost += 1;
      topicLines.push(`   LOST 出处已滚出窗口（无法核实）：${label} ← ${ref.from}：${String(ref.excerpt).slice(0, 30)}`);
    }
  }
}
if (topicTotal) {
  console.log('\n【话题出处校验】');
  for (const line of topicLines) console.log(' ' + line);
  console.log(` 合计 ${topicTotal} 条：可核实 ${topicTotal - topicNoRef - topicLost} / 无锚点 ${topicNoRef} / 出处已丢 ${topicLost}`);
  console.log(' 验收口径：捡起的话题必须能在这里找到出处；LOST = recentLimit 已经把它裁掉了。\n');
} else {
  console.log('\n【话题出处校验】窗口内没有任何 activeTopic（AI 还没写过，或都过期了）。\n');
}

console.log(`合计：${rows.length} 个会话、窗口内 ${totalConsidered} 条消息、${totalMembers} 人次成员信号。`);
console.log('提示：阶段 1 的【关系分寸】已注入 prompt（只给档位，不给数字）；阶段 2 的话题跨天保留（只留待追问）与档位粘滞已上线。本报告只读。');
