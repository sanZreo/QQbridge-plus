// 三代「关系信号」的唯一实现 —— 阶段 0：**只派生、不注入、不改决策**。
//
// ── 为什么要有它（三代第一根支柱的设计依据）─────────────────────────────────
// 二代的「对群友的印象」是 AI **自己写、自己读**的：`bridge.js` 的 `memberImpressions`
// 里 `interactionCount` 统计的其实是"AI 调用了几次 qq_memory_append"，不是真实互动。
// 用它驱动"对谁更上心"必然退化成**表演性关心**（三轮对抗评审的一致结论）。
// 所以这里改为：**桥接按消息流自己算**。AI 只能解读与表达，无法伪造排名。
//
// ── 三条设计约束（评审提出，改这个文件前先读）────────────────────────────────
// 1. **只派生、不持久化**：数据源就是已经落盘的 `recentMessages` ⇒ 零新字段、零迁移、
//    bridge 重启不存在"旧文件缺字段"问题、回滚 = 不调用它。
//    ⚠️ 若将来要落盘，**必须同步改 `bridge.js` 的 `loadSocialV2State`**（它是逐字段手工白名单
//    重建 state 的），否则重启即静默丢数据，且要好几天才发现。
// 2. **只算可信的"双向信号"**：引用我 / 在我发言后 3 分钟内接话 / @ 或叫我。
//    单向高频（那个人只是话多）**不算熟** —— 发言量只能当"敢不敢接话"的门槛。
// 3. **数值永不直接进 prompt**：对外只给 tier 分档（familiar / normal / new），
//    原始计数仅供运维查看（`scripts/member-signals-report.mjs` 与控制台只读端点）。
//    信号的正确用途是让 AI **少说**（不熟的人别硬凑），不是让它多说话。
//
// 刻意**不**实现（评审明确砍掉，别再加回来）：`replyLatencyMs` 分布（监控感）、
// `streak`（打卡感）、`topicsJoined`（监视感）、"聊僵回避"（无法可靠桥接化）。

/** 统计窗口：只看最近 7 天的消息。 */
export const SIGNAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 在这段时间内接我的话，算一次"回应我"。 */
export const REPLY_WINDOW_MS = 3 * 60 * 1000;

/** 双向信号达到这个数才算「熟」。 */
export const FAMILIAR_TWO_WAY = 3;

/** 发言达到这个数、且至少 1 次双向信号，算「一般」。 */
export const NORMAL_MESSAGES = 20;

export const SIGNAL_TIERS = Object.freeze(['familiar', 'normal', 'new']);

/** 同一个人可能只有昵称、没有 QQ 号（历史数据），所以键要兼容两种。 */
export function memberKeyOf(msg) {
  const uid = msg?.userId != null ? String(msg.userId).trim() : '';
  if (uid) return `u:${uid}`;
  const name = msg?.sender != null ? String(msg.sender).trim() : '';
  return name ? `n:${name}` : '';
}

/**
 * 从会话状态**派生**每个群友的真实互动信号。纯函数：不改状态、不写盘、不读配置。
 *
 * @param {object} st 会话状态（只用 `recentMessages`）
 * @param {{now?: number, windowMs?: number, keywords?: string[]}} [options]
 *   `keywords` = 叫到 AI 的名字/关键词（由调用方从 config 传入，本模块不读配置）
 * @returns {{
 *   generatedAt: number, windowMs: number, windowStart: string, windowDays: number,
 *   considered: number, selfMessages: number,
 *   coverage: {messages: number, coverageMs: number, coverageDays: number, coverageHours: number,
 *     firstSeenAt: string|null, lastSeenAt: string|null, truncated: boolean, note: string},
 *   members: Array<object>, byTier: {familiar: string[], normal: string[], new: string[]},
 *   top: string[]
 * }}
 */
export function deriveMemberSignals(st, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0 ? Number(options.windowMs) : SIGNAL_WINDOW_MS;
  const keywords = (Array.isArray(options.keywords) ? options.keywords : [])
    .filter((k) => typeof k === 'string' && k.trim())
    .map((k) => k.trim());
  const messages = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
  const since = now - windowMs;

  const members = new Map();
  let considered = 0;
  let selfMessages = 0;
  let lastSelfAt = 0;
  // 「接我话」只认**我发言之后的第一条**（详见下方注释）。
  let awaitingFirstReply = false;

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const time = Number(msg.time) || 0;
    if (time < since) continue;
    considered += 1;
    // 我自己的发言（recordSentMessagesV2 写入的：sender='我', isSelf=true，无 seq/userId）
    if (msg.isSelf) {
      selfMessages += 1;
      if (time > lastSelfAt) lastSelfAt = time;
      awaitingFirstReply = true;
      continue;
    }
    const key = memberKeyOf(msg);
    if (!key) continue;
    let m = members.get(key);
    if (!m) {
      m = {
        key,
        name: String(msg.sender ?? '').trim() || '(未知)',
        userId: msg.userId != null ? String(msg.userId) : null,
        messages: 0,
        quotesMe: 0,
        repliesToMyMessage: 0,
        mentionsMe: 0,
        firstSeen: time,
        lastSeen: time,
      };
      members.set(key, m);
    }
    m.messages += 1;
    if (time < m.firstSeen) m.firstSeen = time;
    if (time > m.lastSeen) m.lastSeen = time;
    if (msg.quoteTargetIsSelf) {
      // 引用我：最强的双向信号，且与"接话"互斥计数，避免同一条消息算两次
      m.quotesMe += 1;
      awaitingFirstReply = false;
    } else if (awaitingFirstReply && lastSelfAt && time - lastSelfAt <= REPLY_WINDOW_MS) {
      // ⚠️ 只认"我发言之后的第一条"。初版是"我发言后 3 分钟内**任何人**都算"，
      // 2026-10-18 复检发现这会让一个群的 familiar 档一天涨到 11 人
      // （最猛的一串发言后面 3 分钟内有 5 个人 11 条，全被记成接我话）。
      m.repliesToMyMessage += 1;
      awaitingFirstReply = false;
    } else if (lastSelfAt && time - lastSelfAt > REPLY_WINDOW_MS) {
      awaitingFirstReply = false;
    }
    if (keywords.length) {
      const body = `${msg.plain ?? ''}\u0000${msg.text ?? ''}`;
      if (keywords.some((k) => body.includes(k))) m.mentionsMe += 1;
    }
  }

  const list = [...members.values()]
    .map((m) => {
      const twoWay = m.quotesMe + m.repliesToMyMessage;
      const tier = twoWay >= FAMILIAR_TWO_WAY
        ? 'familiar'
        : (m.messages >= NORMAL_MESSAGES && twoWay >= 1 ? 'normal' : 'new');
      return { ...m, twoWay, tier };
    })
    .sort((a, b) => b.twoWay - a.twoWay || b.messages - a.messages || String(a.name).localeCompare(String(b.name), 'zh'));

  const byTier = { familiar: [], normal: [], new: [] };
  for (const m of list) byTier[m.tier].push(m.name);

  // 窗口口径：这 7 天窗口实际被多少消息覆盖到。`recentMessages` 有 recentLimit=100 截断，
  // 活跃群里窗口名义 7 天、实际可能只有 1.4 小时 —— 不写清楚就会拿"滚动窗口"当"长期印象"用。
  const seenTimes = [];
  for (const msg of messages) {
    const t = Number(msg?.time) || 0;
    if (t >= since) seenTimes.push(t);
  }
  const firstSeenAt = seenTimes.length ? Math.min(...seenTimes) : 0;
  const lastSeenAt = seenTimes.length ? Math.max(...seenTimes) : 0;
  const coverageMs = seenTimes.length ? lastSeenAt - firstSeenAt : 0;
  const coverageDays = Number((coverageMs / (24 * 3600 * 1000)).toFixed(2));
  // 被截断的判据：消息数达到 recentLimit 且覆盖时长远小于窗口 ⇒ 说明更早的消息已经被裁掉。
  const truncated = seenTimes.length >= 100 && coverageDays < 6.5;

  return {
    generatedAt: now,
    windowMs,
    windowStart: new Date(since).toISOString(),
    windowDays: Number((windowMs / (24 * 3600 * 1000)).toFixed(1)),
    considered,
    selfMessages,
    // 窗口口径（给分档与报告用）：覆盖多长、是否被 recentLimit 截断
    coverage: {
      messages: seenTimes.length,
      coverageMs,
      coverageDays,
      coverageHours: Number((coverageMs / 3_600_000).toFixed(2)),
      firstSeenAt: firstSeenAt ? new Date(firstSeenAt).toISOString() : null,
      lastSeenAt: lastSeenAt ? new Date(lastSeenAt).toISOString() : null,
      truncated,
      note: truncated
        ? `⚠️ 只覆盖 ${coverageDays} 天（消息数已达 100 上限，更早的已被裁掉）：分档反映的是「最近这些消息」，不是长期印象`
        : `覆盖 ${coverageDays} 天（未触到 100 条上限，7 天窗口基本可用）`,
    },
    members: list,
    byTier,
    top: list.slice(0, 3).map((m) => m.name),
  };
}

/**
 * 把「桥接算出来的真实排名」与「AI 自己写的印象排名」对照。
 * 这是阶段 0 最有说服力的验收指标：两者若明显不一致，就证明当前的关系印象是表演。
 *
 * ⚠️ 匹配口径（踩过坑）：私聊里 `recentMessages` 的 `sender` 存的是**字面量 `私聊`**，
 * 而 AI 的 `memberImpressions` 是按 QQ 号或 `管理员` 记的 —— 只按昵称比对会把私聊
 * 全部误报成"漏看 + 过度关注"。所以这里按 `昵称 | QQ 号 | owner 别名` 三者任一命中算同一人。
 *
 * @param {object} signals `deriveMemberSignals()` 的结果
 * @param {object} st 会话状态（读 `memberImpressions`）
 * @param {{ownerQQ?: number|string, ownerAliases?: string[]}} [options]
 */
export function compareWithImpressions(signals, st, options = {}) {
  const impressions = st?.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
  const selfRanked = Object.entries(impressions)
    .map(([name, im]) => ({
      name,
      traits: Array.isArray(im?.traits) ? im.traits : [],
      interactionCount: Number(im?.interactionCount) || 0,
    }))
    .sort((a, b) => b.interactionCount - a.interactionCount || String(a.name).localeCompare(String(b.name), 'zh'));

  const derivedRanked = (signals?.members ?? []).map((m) => ({
    name: m.name,
    userId: m.userId ?? null,
    twoWay: m.twoWay,
    messages: m.messages,
    tier: m.tier,
  }));

  const ownerQQ = options.ownerQQ != null ? String(options.ownerQQ) : '';
  const ownerAliases = Array.isArray(options.ownerAliases) && options.ownerAliases.length
    ? options.ownerAliases.map(String)
    : ['管理员', '管理', 'owner', '我'];

  /** 印象里的这个名字，是否就是这个成员？ */
  const aliasHit = (member, key) => {
    const k = String(key ?? '').trim();
    if (!k) return false;
    const name = String(member.name ?? '').trim();
    if (name && name === k) return true;
    if (member.userId && String(member.userId) === k) return true;
    if (ownerQQ && member.userId && String(member.userId) === ownerQQ && ownerAliases.includes(k)) return true;
    // 昵称可能被 AI 写成「A/B」合并形式，或带后缀；只在长度足够时做包含匹配，避免误命中
    if (name && k.length >= 2 && name.length >= 2 && (name.includes(k) || k.includes(name))) return true;
    return false;
  };

  const findRank = (member, arr) => {
    const i = arr.findIndex((x) => aliasHit(member, x.name));
    return i >= 0 ? i + 1 : null;
  };

  const rows = derivedRanked.slice(0, 5).map((d, i) => ({
    name: d.name,
    userId: d.userId,
    derivedRank: i + 1,
    derivedTwoWay: d.twoWay,
    derivedMessages: d.messages,
    selfRank: findRank(d, selfRanked),
  }));

  // top3 的口径必须与上面的 ⚠️ 判定一致（都用别名匹配），否则会出现
  // "⚠️ 行为空、但榜上重合 0/3" 这种自相矛盾的报告（踩过）。
  const derivedTop3 = derivedRanked.slice(0, 3);
  const selfTop3 = selfRanked.slice(0, 3);
  const top3Derived = derivedTop3.map((m) => m.name);
  const top3Self = selfTop3.map((m) => m.name);
  //   agree     —— 桥接 top3 里有几个人在 AI 的 top3 中（同一批人 = 谁重要这件事上没分歧）
  //   sameOrder —— 同名同位的个数（顺序全反 = 双方侧重不同，但不一定是假的）
  const overlap = derivedTop3.filter((d) => selfTop3.some((s) => aliasHit(d, s.name))).map((d) => d.name);
  const agree = overlap.length;
  const sameOrder = derivedTop3.filter((d, i) => selfTop3[i] && aliasHit(d, selfTop3[i].name)).length;
  // ⚠️ **两侧都有数据才判定偏差**。若 AI 一条印象都没记（或桥接没看到任何成员），
  // 照样输出 unnoticed 会得到"所有熟人都是漏看"的假结论 —— 首版快照就踩到了这个，
  // 差一点当成阶段 0 的证据（`private:2747277822` 报出 `漏看[私聊]`，实际 AI 什么都没记）。
  const comparable = derivedRanked.length > 0 && selfRanked.length > 0;
  /** 桥接算出他很熟，但 AI **一次都没记过**他 —— 最典型的漏看。 */
  const unnoticed = comparable ? derivedTop3.filter((d) => findRank(d, selfRanked) === null).map((d) => d.name) : [];
  /** AI 记着他（还很熟），但桥接的真实信号里他几乎不存在 —— 最典型的过度关注。 */
  const overrated = comparable ? selfTop3.filter((s) => !derivedRanked.some((d) => aliasHit(d, s.name))).map((s) => s.name) : [];

  return {
    selfRanked,
    derivedRanked,
    rows,
    top3Derived,
    top3Self,
    overlap,
    agree: overlap.length,
    sameOrder,
    unnoticed,
    overrated,
    comparable,
  };
}

// ── 阶段 2：档位粘滞（防"窗口滚动"驱动行为反复）──────────────────────────────
// 背景（2026-10-19 实测）：`recentMessages` 有 recentLimit=100 上限，活跃群里这个
// 窗口只能覆盖 1~2 小时。于是同一个人可能在三天内从 familiar 掉到 new（糖心曾先生
// 实际发生过：双向 4 → 1），prompt 就会今天说"和你聊得来"、明天说"别硬凑"——
// 这不是关系变了，是采样窗口在滚动。评审取向是"宁可偏严"，所以这里**只粘滞降档**：
// 升档立即生效（真互动变多要立刻反映），降档在 holdMs 内不生效。
export const TIER_HOLD_MS = 72 * 60 * 60 * 1000;

export const TIER_RANK = Object.freeze({ new: 0, normal: 1, familiar: 2 });

/**
 * 用上一次的档位给本次派生结果加粘滞。纯函数：不改入参、不读配置、不写盘。
 *
 * @param {object} signals deriveMemberSignals() 的返回值
 * @param {object} prevTiers 上次落盘的 `{ [memberKey]: {tier, at} }`
 * @param {{now?: number, holdMs?: number}} [options]
 * @returns signals 的浅拷贝（members/byTier 按粘滞后的档位重建），另附：
 *   `tiers`（本次应落盘的档位表，只含当前成员）与 `hysteresis.held`（被粘住的成员）。
 */
export function applyTierHysteresis(signals, prevTiers, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const holdMs = Number.isFinite(options.holdMs) && options.holdMs > 0 ? Number(options.holdMs) : TIER_HOLD_MS;
  const prev = prevTiers && typeof prevTiers === 'object' ? prevTiers : {};
  const members = [];
  const byTier = { familiar: [], normal: [], new: [] };
  const tiers = {};
  const held = [];
  for (const m of signals?.members ?? []) {
    const raw = m.tier;
    const before = prev[m.key];
    let tier = raw;
    let at = now;
    if (before && TIER_RANK[before.tier] !== undefined) {
      const beforeAt = Number(before.at) || 0;
      // 降档 + 仍在保持期内 ⇒ 沿用旧档位。注意 `at` **不刷新**：
      // 一刷新就变成"每轮续期"，某个人一旦是熟人，就再也降不下来。
      if (TIER_RANK[before.tier] > TIER_RANK[raw] && beforeAt > 0 && now - beforeAt < holdMs) {
        tier = before.tier;
        at = beforeAt;
        held.push({ key: m.key, name: m.name, rawTier: raw, tier });
      } else if (before.tier === raw) {
        at = beforeAt || now;
      }
    }
    members.push({ ...m, tier, rawTier: raw });
    byTier[tier].push(m.name);
    tiers[m.key] = { tier, at };
  }
  return { ...signals, members, byTier, tiers, hysteresis: { holdMs, held } };
}
