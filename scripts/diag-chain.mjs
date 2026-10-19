// 验证 slangTaskChain 是否被永久卡死。
// 做法：同时触发「提取」和「研究」。如果链没堵，两个都该有反应；
// 如果链堵在第一个任务上，第二个永远不执行。
import fs from 'node:fs';
import path from 'node:path';

const STATE = path.join(process.cwd(), 'state');
const tok = fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim();
const H = { 'x-console-token': tok, 'content-type': 'application/json' };

async function call(ep, body) {
  const r = await fetch(`http://127.0.0.1:3100${ep}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
}

const slangMtime = () => fs.statSync(path.join(STATE, 'slang.json')).mtime.toISOString();
const sessExists = () => fs.existsSync(path.join(STATE, 'slang-session.json'));

console.log('触发前：slang-session.json =', sessExists(), ' slang.json mtime =', slangMtime());

console.log('\n--- 先触发研究（3 条）---');
console.log(JSON.stringify(await call('/api/slang/research', { ids: ['muzhg4zz-4kbzj5'] })));

console.log('\n--- 立即再触发研究（另外 3 条）---');
console.log(JSON.stringify(await call('/api/slang/research', { ids: ['muzge10n-i74ugv', 'mv2c8r10-kmdpqg'] })));

console.log('\n--- 再触发提取 ---');
console.log(JSON.stringify(await call('/api/slang/extract', {})));

console.log('\n--- 观察 60 秒 ---');
const t0 = Date.now();
while (Date.now() - t0 < 60000) {
  await new Promise((r) => setTimeout(r, 10000));
  console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] session文件=${sessExists()} slang mtime=${slangMtime()}`);
}

console.log('\n--- 结果 ---');
const slang = JSON.parse(fs.readFileSync(path.join(STATE, 'slang.json'), 'utf8'));
for (const id of ['muzhg4zz-4kbzj5', 'muzge10n-i74ugv', 'mv2c8r10-kmdpqg']) {
  const e = slang.find((x) => x.id === id);
  console.log(`  ${e?.content}: meaning=${(e?.meaning || '').trim() ? '✅ 有' : '❌ 空'}`);
}
console.log('slang-session.json:', sessExists());
