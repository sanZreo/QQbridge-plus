// 端到端集成测试: heihua-lab 产物 ↔ qq-bridge 注入链路.
//
// 全程在**临时副本**上操作, 不写真实词库、不启动桥接、不产生任何外部副作用。
// 覆盖: 载入 → 候选不进注入 → 模拟确认 → 本群注入/相关排序 → 他群隔离 → 空窗回退 → 2000 上限裁剪
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSlang, saveSlang, buildSlangContextFor, SLANG_STATUS,
} from '../../qq-bridge/src/slang-learner.js';

const BANK = 'E:/workspace/qq-bridge/state/slang.json';
const SIX = ['终末地', '鲸鲸', '哦鲸鲸', '哦鲸', '大肥鱼', '肥鱼'];
const GROUP = 'group:100000001';
const OTHER = 'group:100000002';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heihua-e2e-'));
const copy = path.join(tmp, 'slang.json');
fs.copyFileSync(BANK, copy);

let passed = 0;
const ok = (name) => { passed += 1; console.log(`✅ ${name}`); };
const linesOf = (block) => block.split('\n').slice(1).map((l) => l.replace(/^- /, '').split('：')[0]);

try {
  // 1. 载入真实词库(副本)
  const entries = loadSlang(copy);
  const confirmedBefore = entries.filter((e) => e.status === SLANG_STATUS.CONFIRMED).length;
  assert.ok(entries.length > 0, '词库不应为空');
  assert.equal(confirmedBefore, 99, '基线 confirmed 应为 99');
  ok(`载入真实词库: ${entries.length} 条 / ${confirmedBefore} confirmed`);

  // 2. 六条候选字段完整, 且未确认 → 不进注入
  const six = SIX.map((t) => {
    const e = entries.find((x) => x.content === t);
    assert.ok(e, `${t} 不在词库`);
    assert.equal(e.status, SLANG_STATUS.CANDIDATE, `${t} 应是 candidate`);
    assert.equal(e.scope, GROUP, `${t} scope 应为 ${GROUP}`);
    assert.ok(Array.isArray(e.evidence), `${t} evidence 应是数组`);
    return e;
  });
  assert.ok(six.find((e) => e.content === '终末地').aliases.includes('zmd'), '终末地别名 zmd 应保留');
  const before = buildSlangContextFor(GROUP, entries, 30, ['鲸鲸在吗']);
  assert.ok(!linesOf(before).includes('鲸鲸'), '候选未确认时不应进注入');
  ok('六条候选: 字段完整 + 别名保留 + 未确认不进注入');

  // 3. 模拟控制台确认(只在内存里改, 不落盘) → 本群注入且相关词排前
  for (const e of six) e.status = SLANG_STATUS.CONFIRMED;
  const block = buildSlangContextFor(GROUP, entries, 8, ['大肥鱼睡觉去']);
  const lines = linesOf(block);
  assert.ok(lines.includes('大肥鱼'), '确认后本群应注入');
  // "大肥鱼睡觉去" 同时命中「大肥鱼」和子串「肥鱼」; 同命中数按 count 排序,
  // 所以两条都应该出现在最前面(它们都是相关词), 不强制谁第一。
  const top2 = new Set(lines.slice(0, 2));
  assert.ok(top2.has('大肥鱼') && top2.has('肥鱼'), '窗口命中的相关词应排在最前');
  assert.ok(!['鲸鲸', '哦鲸鲸', '终末地'].includes(lines[0]), '未命中的词不应抢到第一');
  ok('确认后注入 + 相关性排序生效');

  // 4. 他群隔离
  const other = linesOf(buildSlangContextFor(OTHER, entries, 30, ['大肥鱼睡觉去']));
  assert.ok(!SIX.some((t) => other.includes(t)), '群作用域词不应出现在他群');
  ok('他群隔离: 群作用域词 0 泄漏');

  // 5. 空窗口回退(不退化)
  const fb = linesOf(buildSlangContextFor(GROUP, entries, 8, []));
  assert.ok(fb.length > 0, '空窗口不应返回空块');
  assert.ok(fb.includes('鲸鲸'), '空窗口应回退给出本群词');
  ok('空窗口回退: 仍有本群词(不退化)');

  // 6. 2000 上限裁剪: 真实条目一条不丢, confirmed 全保留, 裁掉的都是垫底候选
  const realIds = new Set(entries.map((e) => e.id));
  const fakes = Array.from({ length: 120 }, (_, i) => ({
    ...entries[0], id: `fake-${i}`, content: `fakeword${i}`,
    status: SLANG_STATUS.CANDIDATE, count: 0, updatedAt: new Date(0).toISOString(),
  }));
  const capFile = path.join(tmp, 'cap.json');
  saveSlang(capFile, [...entries, ...fakes]);
  const capped = JSON.parse(fs.readFileSync(capFile, 'utf8'));
  assert.equal(capped.length, 2000, '应裁到 2000');
  assert.equal(capped.filter((e) => e.status === 'confirmed').length, confirmedBefore + SIX.length, 'confirmed 不应被裁');
  assert.equal(capped.filter((e) => realIds.has(e.id)).length, entries.length, '真实条目一条不丢');
  assert.equal(capped.filter((e) => e.id.startsWith('fake-')).length, 2000 - entries.length,
    '被裁掉的应全部是垫底的伪造候选');
  ok('2000 上限裁剪: 真实条目与 confirmed 全保留, 只裁垫底候选');

  console.log(`\n${passed} 项端到端断言通过（临时目录: ${tmp}）`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
