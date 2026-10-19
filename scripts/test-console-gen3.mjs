// 控制台 · 三代阶段 2 的渲染契约。
//
// 为什么不用无头浏览器：本机 Edge 的 --headless=new 实测会静默失效（退出码 0、
// stdout 与截图都是 0 字节），拿它做断言等于零覆盖。这里改为**直接执行
// console.html 里的真实函数源码** + 最小 DOM 桩 —— 断言的是真代码，不是复制品。
//
// 钉住三件事（都是"看起来没问题但很容易悄悄坏掉"的）：
//   ① 话题出处必须显示（谁 / 原文 / 时间），出处被 recentLimit 裁掉时必须告警；
//   ② 老话题没有锚点要如实标注，不能假装有出处；
//   ③ 关系分档只给档位不给数字，粘滞与窗口截断都要显式说明。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public/console.html'), 'utf8');

/** 从源码里按大括号配对取出一个函数定义（比正则可靠，函数体里有嵌套块）。 */
function extract(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `console.html 里找不到函数 ${name}（改名了就要同步改这个测试）`);
  let depth = 0;
  for (let j = html.indexOf('{', start); j < html.length; j += 1) {
    const ch = html[j];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, j + 1);
    }
  }
  throw new Error(`大括号不配对: ${name}`);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {};
const documentStub = {
  getElementById: (id) => {
    if (!store[id]) store[id] = { innerHTML: '', textContent: '', className: '' };
    return store[id];
  },
};

const source = [extract('renderTopicProvenance'), extract('renderV2Tiers'), extract('normalizeV2KeyInput')].join('\n\n');
const api = new Function('esc', 'document', `${source}\nreturn { renderTopicProvenance, renderV2Tiers, normalizeV2KeyInput };`)(esc, documentStub);

let failures = 0;
const test = async (name, run) => {
  try {
    await run();
    console.log(`  OK   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}: ${error.message}`);
  }
};

await test('出处行显示来源与原文，且不误报警告', () => {
  const row = api.renderTopicProvenance({
    text: '周末爬山',
    sourceRef: { from: '阿强', excerpt: '周末去爬山吗', at: 1792390000000, seq: 12 },
    sourceOk: true,
  });
  assert.match(row, /阿强/, `必须显示是谁说的：${row}`);
  assert.match(row, /周末去爬山吗/, `必须显示原文片段：${row}`);
  assert.doesNotMatch(row, /无法核实/, '能核实时不得告警');
});

await test('出处被 recentLimit 裁掉时必须明确告警（不能假装能核实）', () => {
  const row = api.renderTopicProvenance({
    text: '周末爬山',
    sourceRef: { from: '阿强', excerpt: '周末去爬山吗', at: 1792390000000 },
    sourceOk: false,
  });
  assert.match(row, /出处已滚出窗口/, `sourceOk=false 必须告警：${row}`);
});

await test('锚点功能上线前的老话题：如实标注，不编造出处', () => {
  const row = api.renderTopicProvenance({ text: '旧话题' });
  assert.match(row, /没有出处记录/, `老话题要标注无锚点：${row}`);
  assert.doesNotMatch(row, /出处：/, '没有锚点就不得渲染"出处："行');
});

await test('关系分档：三档都渲染，且给出粘滞与窗口口径', () => {
  api.renderV2Tiers({
    ok: true,
    signals: {
      byTier: { familiar: ['阿强'], normal: ['小美'], new: ['路人'] },
      hysteresis: { holdMs: 259200000, held: [{ key: 'u:1001', name: '阿强', rawTier: 'new', tier: 'familiar' }] },
      coverage: { messages: 100, coverageDays: 0.03, coverageHours: 0.76, truncated: true },
    },
  });
  const out = store.v2TierOutput.innerHTML;
  assert.match(out, /阿强/);
  assert.match(out, /小美/);
  assert.match(out, /路人/);
  assert.match(out, /familiar←new/, `粘滞必须标出真实档位：${out}`);
  assert.match(out, /不是长期印象/, '被截断时必须提示窗口口径');
  assert.match(out, /不给数字/, '必须说明只给档位');
});

await test('关系分档：没有成员信号时不得编造名单', () => {
  store.v2TierOutput.innerHTML = '';
  api.renderV2Tiers({ ok: true, signals: null });
  assert.doesNotMatch(store.v2TierOutput.innerHTML, /阿强|小美|路人/, '无信号时不得输出任何名字');
});


// ── 会话 key 归一化（用户实际踩过的坑：粘群号直接报"无效的会话 key"）──────
// 设计取向：**裸数字不猜**。群号和 QQ 号都是纯数字，桥接分不出来；
// 猜错会在 state 里凭空造一个空会话。所以要求用户在控制台里显式选类型。
await test('裸数字 + 选择「群聊」 ⇒ group:', () => {
  const r = api.normalizeV2KeyInput('979441391', 'group');
  assert.equal(r.ok, true);
  assert.equal(r.key, 'group:979441391');
  assert.equal(r.kind, 'group');
  assert.match(r.note, /群聊/, `要说明按哪种类型解释：${r.note}`);
});

await test('裸数字 + 选择「私聊」 ⇒ private:', () => {
  const r = api.normalizeV2KeyInput('10001', 'private');
  assert.equal(r.key, 'private:10001');
  assert.equal(r.kind, 'private');
  assert.match(r.note, /私聊/);
});

await test('已带前缀的 key 以输入为准（前缀比下拉更明确），并回传 kind', () => {
  const r = api.normalizeV2KeyInput('private:10001', 'group');
  assert.equal(r.ok, true);
  assert.equal(r.key, 'private:10001', '不得被下拉覆盖');
  assert.equal(r.kind, 'private', '要把下拉同步成 private');
  assert.equal(r.note, '', '已带前缀时不该有多余提示');
});

await test('中文前缀也接受（群/私聊），归一成英文前缀', () => {
  assert.equal(api.normalizeV2KeyInput('群 979441391', 'private').key, 'group:979441391');
  assert.equal(api.normalizeV2KeyInput('群：979441391', 'private').key, 'group:979441391');
  assert.equal(api.normalizeV2KeyInput('私聊:10001', 'group').key, 'private:10001');
});

await test('空值与乱写给可操作报错，不静默失败', () => {
  assert.equal(api.normalizeV2KeyInput('', 'group').ok, false);
  const bad = api.normalizeV2KeyInput('room:1', 'group');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /group:群号/, `报错要给出正确格式：${bad.error}`);
});

await test('四个 key 输入面板都必须有「群聊/私聊」选择器（不靠猜的前提）', () => {
  for (const id of ['v2MemoryKeyKind', 'v2TierKeyKind', 'v2WakeKeyKind', 'v2StateKeyKind']) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > 0, `console.html 必须提供类型选择器 ${id}`);
    const block = html.slice(at, at + 400);
    assert.match(block, /value="group"/, `${id} 要有「群聊」选项`);
    assert.match(block, /value="private"/, `${id} 要有「私聊」选项`);
  }
  assert.ok(html.split('readV2Key(').length - 1 >= 3,
    '轻量记忆/唤醒状态/会话状态都要走 readV2Key（否则裸数字还是会被直接发出去）');
});


// ── 作用域回归（2026-10-19 真踩过）──────────────────────────────────────────
// 这些辅助函数曾被我误嵌进 `renderV2Memory` 的函数体（缩进 2 空格），
// 顶层按钮一 click 就 ReferenceError：**界面完全没反应**，也没有任何报错。
// `node --check` 查不出这种错（语法合法），抽取单函数跑也查不出（脱离作用域），
// 所以这里同时钉「必须在列 0」和「点击链路真的能跑」。
await test('五个辅助函数必须在顶层（列 0），不能嵌在别的函数体里', () => {
  for (const fn of ['normalizeV2KeyInput', 'readV2Key', 'readV2MemoryKey', 'renderTopicProvenance', 'renderV2Tiers']) {
    assert.ok(new RegExp(`^function ${fn}\\(`, 'm').test(html),
      `${fn} 不是顶层函数（列 0）—— 顶层的按钮/事件看不见它，点了会静默失败`);
  }
  assert.match(html, /readV2Key\('v2WakeKey'/, '唤醒状态面板要走 readV2Key');
  assert.match(html, /readV2Key\('v2StateKey'/, '会话状态面板要走 readV2Key');
});

/** 造一套最小 DOM 桩，返回可查询的元素表与事件表。 */
function domStub() {
  const els = {};
  const handlers = [];
  const el = (id) => (els[id] || (els[id] = {
    id, value: '', textContent: '', className: '', innerHTML: '',
    addEventListener: (ev, fn) => handlers.push({ id, ev, fn }),
  }));
  return { els, handlers, document: { getElementById: el } };
}

await test('点击「查看关系分档」真的会渲染（跑真实的事件绑定代码）', async () => {
  const { els, handlers, document } = domStub();
  const apiStub = () => Promise.resolve({
    ok: true,
    signals: {
      byTier: { familiar: ['阿强'], normal: [], new: ['路人'] },
      hysteresis: { holdMs: 259200000, held: [] },
      coverage: { messages: 100, coverageDays: 0.76, coverageHours: 18.24, truncated: false },
    },
  });
  // 取顶层绑定语句本体（该语句体内没有模板字面量，括号配对安全）
  const start = html.indexOf("document.getElementById('v2TierLoad')");
  assert.ok(start > 0, '找不到 v2TierLoad 的绑定');
  let depth = 0;
  let end = -1;
  for (let p = html.indexOf('{', start); p < html.length; p += 1) {
    if (html[p] === '{') depth += 1;
    else if (html[p] === '}') {
      depth -= 1;
      if (depth === 0) { end = html.indexOf(';', p) + 1; break; }
    }
  }
  assert.ok(end > start, '取不到完整绑定语句');
  const stmt = html.slice(start, end);
  new Function('document', 'api', 'esc', `${extract('normalizeV2KeyInput')}\n${extract('renderV2Tiers')}\n${stmt}`)(document, apiStub, esc);

  const bound = handlers.find((h) => h.id === 'v2TierLoad');
  assert.ok(bound && bound.ev === 'click', '必须把 click 绑到 v2TierLoad 上');
  // 先让 DOM 桩"存在"这两个元素，再赋值（桩是懒创建的）
  document.getElementById('v2TierKey');
  document.getElementById('v2TierKeyKind');
  els.v2TierKey.value = '979441391';
  els.v2TierKeyKind.value = 'group';
  await bound.fn();
  await new Promise((r) => setTimeout(r, 0));
  assert.match(els.v2TierOutput.innerHTML, /阿强/, '点击后必须渲染出名单');
  assert.match(els.v2TierOutput.innerHTML, /熟/, '要带档位标签');
  assert.match(els.v2TierMsg.textContent, /按你选择的/, '要说明按哪种类型解释了 key');
  assert.equal(els.v2TierKey.value, 'group:979441391', '输入框要回写成完整 key');
});

await test('点击「加载记忆」会跑通归一化 + 出处渲染', async () => {
  const { els, handlers, document } = domStub();
  const apiStub = () => Promise.resolve({
    ok: true,
    raw: {
      activeTopics: [{
        text: '周末爬山',
        lastMentionAt: Date.now(),
        pendingQuestion: '他到底去不去',
        sourceRef: { seq: 3, at: Date.now(), from: '阿强', excerpt: '周末去爬山吗' },
        sourceOk: true,
      }],
      pendingThoughts: [],
      memberImpressions: {},
    },
  });
  const source = ['normalizeV2KeyInput', 'readV2Key', 'readV2MemoryKey', 'renderTopicProvenance', 'renderV2Tiers', 'renderV2Memory', 'loadV2Memory']
    .map((n) => extract(n))
    .join('\n\n');
  // 先让元素存在，再填值（桩是懒创建的）
  document.getElementById('v2MemoryKey');
  document.getElementById('v2MemoryKeyKind');
  els.v2MemoryKey.value = '979441391';
  els.v2MemoryKeyKind.value = 'group';
  new Function('document', 'api', 'esc', `${source}\nreturn loadV2Memory;`)(document, apiStub, esc)();
  await new Promise((r) => setTimeout(r, 0));
  assert.match(els.v2MemoryOutput.innerHTML, /周末爬山/);
  assert.match(els.v2MemoryOutput.innerHTML, /出处：阿强/, '话题要带出来源行');
  assert.match(els.v2MemoryMsg.textContent, /已加载 group:979441391/, `成功提示要带规范 key：${els.v2MemoryMsg.textContent}`);
});

console.log(failures ? `\n${failures} failed` : '\nconsole gen3-phase2 render assertions passed');
if (failures) process.exitCode = 1;
