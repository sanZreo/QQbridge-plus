// 黑话注入升级自检：别名字段、群作用域、相关性注入与无命中回退。
// 对应架构评审的步骤 1（别名 + 相关性注入）与步骤 2（群作用域）。
import assert from 'node:assert/strict';
import {
  normalizeSlangEntry,
  normalizeSlangScope,
  buildSlangContext,
  buildSlangContextFor,
  SLANG_STATUS,
} from '../src/slang-learner.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`✅ ${name}`);
}

const entry = (over) => normalizeSlangEntry({
  content: 'x', meaning: 'm', status: SLANG_STATUS.CONFIRMED, ...over,
});

// 1. aliases 归一化：去重、去空、去掉与 content 相同的、限长
{
  const e = normalizeSlangEntry({ content: 'yyds', aliases: ['永远的神', '永远的神', '', 'yyds', ' 永远的神 '] });
  assert.deepEqual(e.aliases, ['永远的神']);
  const many = normalizeSlangEntry({ content: 'z', aliases: Array.from({ length: 20 }, (_, i) => `a${i}`) });
  assert.equal(many.aliases.length, 10, '别名上限 10');
  ok('aliases 归一化（去重/去空/限长）');
}

// 2. scope 归一化：非法值回落 general，group:<key> 保留
{
  assert.equal(normalizeSlangScope(undefined), 'general');
  assert.equal(normalizeSlangScope(''), 'general');
  assert.equal(normalizeSlangScope('group:123'), 'group:123');
  assert.equal(normalizeSlangScope('group:  123 '), 'group:123');
  assert.equal(normalizeSlangScope('group:'), 'general');
  assert.equal(normalizeSlangScope('group:  '), 'general');
  assert.equal(normalizeSlangScope('evil'), 'general');
  const e = normalizeSlangEntry({ content: 'a', meaning: 'b', scope: 'group:777' });
  assert.equal(e.scope, 'group:777');
  ok('scope 归一化（general 默认 / group: 保留 / 非法回落）');
}

// 3. 相关性注入：被当前窗口提到的词，排在只按次数更高的词前面
{
  const entries = [
    entry({ content: 'zmd', meaning: '终末地', count: 99 }),
    entry({ content: 'yyds', meaning: '永远的神', count: 5 }),
  ];
  const block = buildSlangContextFor('group:1', entries, 8, [
    '今天肝终末地 zmd 了吗',
    'yyds 这画质',
    'yyds 永远的神',
  ]);
  assert.ok(block.includes('yyds') && block.includes('zmd'));
  assert.ok(block.indexOf('yyds') < block.indexOf('zmd'), '窗口提到 2 次的 yyds 应排在只提到 1 次的 zmd 之前');
  ok('相关性注入排序');
}

// 4. 群作用域：他群词不进本群注入；本群词即使零命中也在池里
{
  const entries = [
    entry({ content: 'onp', meaning: '他群梗', count: 99, scope: 'group:2' }),
    entry({ content: 'byd', meaning: '本群梗', count: 1, scope: 'group:1' }),
  ];
  const block = buildSlangContextFor('group:1', entries, 8, ['在吗']);
  assert.ok(block.includes('byd'), '本群作用域词应注入');
  assert.ok(!block.includes('onp'), '他群作用域词不应注入');
  ok('群作用域过滤');
}

// 5. 无命中回退：不退化——本群 + 通用按出现次数排序（改造前行为）
{
  const entries = [
    entry({ content: 'aaa', meaning: '高频', count: 99 }),
    entry({ content: 'bbb', meaning: '低频', count: 1 }),
  ];
  const block = buildSlangContextFor('group:1', entries, 8, ['完全无关的话题']);
  assert.ok(block.indexOf('aaa') < block.indexOf('bbb'), '无命中时按 count 排序');
  assert.ok(block.includes('aaa') && block.includes('bbb'), '无命中仍给出词表（不空白）');
  ok('无命中回退不退化');
}

// 6. 旧函数兼容：buildSlangContext 仍是通用词 top-N（group: 词不出现）
{
  const entries = [
    entry({ content: 'aaa', meaning: '高频', count: 99 }),
    entry({ content: 'bbb', meaning: '他群词', count: 1, scope: 'group:2' }),
  ];
  const block = buildSlangContext(entries, 8);
  assert.ok(block.includes('aaa'));
  assert.ok(!block.includes('bbb'), '旧入口不带 key，不含 group: 词');
  ok('buildSlangContext 兼容旧调用');
}

// 7. 别名渲染 + 别名参与相关性匹配
{
  const e = normalizeSlangEntry({
    content: 'yyds', meaning: '永远的神', aliases: ['永远的神'], status: SLANG_STATUS.CONFIRMED, count: 3,
  });
  const block = buildSlangContextFor('group:1', [e], 8, ['永远的神！']);
  assert.ok(block.includes('（又称：永远的神）'), '注入块应渲染别名');
  const block2 = buildSlangContextFor('group:1', [e], 8, ['无关内容']);
  assert.ok(block2.includes('yyds'), '无命中也应回退给出该词');
  ok('别名渲染与相关性');
}

// 8. 截断到 max；没有已确认词时返回空串
{
  const entries = Array.from({ length: 12 }, (_, i) => entry({ content: `w${i}`, meaning: `含义${i}`, count: 12 - i }));
  const block = buildSlangContextFor('group:1', entries, 3, []);
  assert.equal(block.split('\n').length, 4, '标题 + 3 条');
  const empty = buildSlangContextFor('group:1', [entry({ content: 'c', meaning: 'm', status: SLANG_STATUS.CANDIDATE })], 8, ['c']);
  assert.equal(empty, '', '没有已确认词条时返回空串');
  ok('截断与空池');
}

console.log(`\n${passed} 项通过`);
