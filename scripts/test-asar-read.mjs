// `scripts/asar-read.mjs` 的离线回归：全部用**自己造的合成 asar**，不碰本机那个 121MB 真文件。
//
// 为什么必须造夹具而不是只跑真机：真文件只能证明"今天这台机器上能读"，证明不了
//   · 头长度越界/文件截断时**显式抛错**（而不是 OOM 或读到错位字节）；
//   · 条目 offset/size 越界时抛错（越界读到别的包的内容 ⇒ 抽出假名字）；
//   · `unpacked: true` 的条目走磁盘副本、副本缺失时抛错（工具名文件里实测有 33 个是
//     unpacked —— 忽略它就会静默漏读，而漏读的方向是把真工具名判成假名）；
//   · 身份探针能**拒绝**不是 DSH 的 asar（任何 Electron 应用都有 app.asar，扫错会产出
//     一份来自别的应用的名字集合 ⇒ 假红 + 假绿）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectDshAsar, openAsar, readAsarFile, walkAsarFiles } from './asar-read.mjs';
import { collectDshToolNames } from './dsh-tool-names.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-asar-test-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 退出时尽力而为 */ } });

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };

/**
 * 造一个合成 asar。
 * @param files `{ 相对路径: Buffer | { content, unpacked } }`（路径用 '/'）
 */
function writeAsar(asarPath, files) {
  const contents = [];
  const tree = { files: {} };
  let offset = 0;
  for (const [rel, spec] of Object.entries(files)) {
    const content = Buffer.isBuffer(spec)
      ? spec
      : Buffer.from(typeof spec === 'string' ? spec : spec.content);
    const unpacked = !Buffer.isBuffer(spec) && typeof spec === 'object' && spec.unpacked === true;
    const entry = unpacked ? { size: content.length, unpacked: true } : { size: content.length, offset: String(offset) };
    let node = tree;
    const segments = rel.split('/');
    for (let i = 0; i < segments.length - 1; i += 1) {
      node.files[segments[i]] ??= { files: {} };
      node = node.files[segments[i]];
    }
    node.files[segments.at(-1)] = entry;
    if (!unpacked) { contents.push(content); offset += content.length; }
    if (unpacked) {
      const onDisk = path.join(`${asarPath}.unpacked`, ...segments);
      fs.mkdirSync(path.dirname(onDisk), { recursive: true });
      fs.writeFileSync(onDisk, content);
    }
  }

  const jsonBuf = Buffer.from(JSON.stringify(tree), 'utf8');
  // 头 pickle 载荷 = [JSON 长度][JSON][补齐到 4 字节对齐]——与 chromium pickle 一致
  let payload = Buffer.concat([u32(jsonBuf.length), jsonBuf]);
  if (payload.length % 4 !== 0) payload = Buffer.concat([payload, Buffer.alloc(4 - (payload.length % 4))]);
  const headerPickle = Buffer.concat([u32(payload.length), payload]);
  fs.mkdirSync(path.dirname(asarPath), { recursive: true });
  fs.writeFileSync(asarPath, Buffer.concat([u32(4), u32(headerPickle.length), headerPickle, ...contents]));
  return asarPath;
}

/** 造一份"像 DSH"的文件表：>= minPackages 个 dsh-* 包 + dsh-persona。 */
function dshLikeFiles({ extra = {} } = {}) {
  const files = {
    'dsh/node_modules/@deepseek-ai/dsh-persona/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-persona', version: '0.0.0-test' }),
  };
  for (let i = 0; i < 60; i += 1) {
    files[`dsh/node_modules/@deepseek-ai/dsh-fake-${i}/package.json`] = '{}';
  }
  // 一个真的会被抽到工具名的包（证明"读到了 ≠ 抽到了"这条链是通的）
  files['dsh/node_modules/@deepseek-ai/dsh-fake-0/index.js'] =
    "export const x = 1;\napp.tools.register(defineTool({ name: 'fake_pwsh', description: 'x' }));\n";
  // patch.yml 形态（抽取规则③）
  files['dsh/node_modules/@deepseek-ai/dsh-fake-1/presets/a.patch.yml'] = 'toolName: fake_patch_tool\n';
  return { ...files, ...extra };
}

test('合成 asar：头能解析、字节能按条目取回', () => {
  const asarPath = writeAsar(path.join(TMP, 'basic.asar'), dshLikeFiles());
  const asar = openAsar(asarPath);
  assert.ok(asar.contentStart > 16 && asar.contentStart < asar.size, `contentStart 应在文件内：${asar.contentStart}/${asar.size}`);
  // 头里应能看到全部条目
  const nodes = walkAsarFiles(asar).map((f) => f.path);
  assert.ok(nodes.includes('dsh/node_modules/@deepseek-ai/dsh-persona/package.json'));
  assert.equal(nodes.filter((p) => p.endsWith('/package.json')).length, 61);
  const pkg = JSON.parse(readAsarFile(asar, 'dsh/node_modules/@deepseek-ai/dsh-persona/package.json').toString('utf8'));
  assert.equal(pkg.name, '@deepseek-ai/dsh-persona');
  assert.equal(pkg.version, '0.0.0-test');
  // 最后一个内容条目（尾部贴 EOF）也要正确
  const last = readAsarFile(asar, 'dsh/node_modules/@deepseek-ai/dsh-fake-1/presets/a.patch.yml').toString('utf8');
  assert.equal(last, 'toolName: fake_patch_tool\n');
});

test('合成 asar：抽取端到端能抽到工具名（证明不是"读了但什么都没抽到"）', () => {
  const asarPath = writeAsar(path.join(TMP, 'extract.asar'), dshLikeFiles());
  const { names, packages } = collectDshToolNames({ asarPath, pluginDirs: [] });
  assert.ok(packages.includes('dsh-fake-0'), `包清单应含 dsh-fake-0：${packages.length} 个`);
  assert.ok(names.has('fake_pwsh'), `defineTool 形态应抽到 fake_pwsh：${[...names.keys()].join(', ')}`);
  assert.ok(names.has('fake_patch_tool'), 'patch.yml 的 toolName 形态应抽到 fake_patch_tool');
});

test('unpacked 条目必须走磁盘副本；副本缺失要显式抛错（不许静默漏读）', () => {
  const asarPath = writeAsar(path.join(TMP, 'unpacked.asar'), dshLikeFiles({
    // 注意：漏读的方向是把真工具名判成假名，所以副本缺失时必须抛错
    extra: { 'dsh/node_modules/@deepseek-ai/dsh-fake-2/native.js': { content: 'unpacked-content', unpacked: true } },
  }));
  const asar = openAsar(asarPath);
  assert.equal(readAsarFile(asar, 'dsh/node_modules/@deepseek-ai/dsh-fake-2/native.js').toString('utf8'), 'unpacked-content');
  fs.rmSync(path.join(`${asarPath}.unpacked`), { recursive: true, force: true });
  assert.throws(() => readAsarFile(asar, 'dsh/node_modules/@deepseek-ai/dsh-fake-2/native.js'), /unpacked/);
});

test('越界与截断必须显式失败（防 OOM 与"读到别的包的字节"）', () => {
  const files = dshLikeFiles();
  const asarPath = writeAsar(path.join(TMP, 'bounds.asar'), files);
  const asar = openAsar(asarPath);

  // 条目 offset 越界 ⇒ 抛错（否则会读到内容区之外/别人家的字节，抽出错名字）
  const broken = { ...asar, header: JSON.parse(JSON.stringify(asar.header)) };
  broken.header.files.dsh.files.node_modules.files['@deepseek-ai'].files['dsh-persona'].files['package.json'] =
    { size: 10, offset: String(asar.size * 2) };
  assert.throws(() => readAsarFile(broken, 'dsh/node_modules/@deepseek-ai/dsh-persona/package.json'), /越界/);

  // 文件被截断 ⇒ 头长度越界，openAsar 直接抛错（不预分配超大 Buffer）
  const truncated = path.join(TMP, 'truncated.asar');
  fs.writeFileSync(truncated, fs.readFileSync(asarPath).subarray(0, 20));
  assert.throws(() => openAsar(truncated), /不是 asar/);

  // 头 JSON 长度字段被改成天文数字 ⇒ 抛错
  const evil = path.join(TMP, 'evil-header.asar');
  const raw = Buffer.from(fs.readFileSync(asarPath));
  raw.writeUInt32LE(0xffffff00, 12);
  fs.writeFileSync(evil, raw);
  assert.throws(() => openAsar(evil), /不是 asar/);
});

test('身份探针只接受像 DSH 的 asar（别的 Electron 应用必须被拒）', () => {
  const okPath = writeAsar(path.join(TMP, 'identity-ok.asar'), dshLikeFiles());
  const ok = inspectDshAsar(okPath);
  assert.equal(ok.ok, true);
  assert.ok(ok.packages.length >= 50);

  // 普通 Electron 应用的 asar：有 node_modules 但不是 DSH
  const otherPath = writeAsar(path.join(TMP, 'identity-other.asar'), {
    'node_modules/left-pad/index.js': 'module.exports = 1;',
    'package.json': '{"name":"some-electron-app"}',
  });
  const other = inspectDshAsar(otherPath);
  assert.equal(other.ok, false);
  assert.match(other.reason, /dsh\/node_modules/);
  // 探针不过 ⇒ 抽取必须抛错，而不是返回一份空名字集被当成"没有工具"
  assert.throws(() => collectDshToolNames({ asarPath: otherPath, pluginDirs: [] }), /不是一份可用的 DSH 安装/);

  // 包数不够（指到干扰目录那种半对错状态）也要拒
  const fewPath = writeAsar(path.join(TMP, 'identity-few.asar'), {
    'dsh/node_modules/@deepseek-ai/dsh-persona/package.json': '{"name":"@deepseek-ai/dsh-persona"}',
    'dsh/node_modules/@deepseek-ai/dsh-a/package.json': '{}',
  });
  assert.equal(inspectDshAsar(fewPath).ok, false);
});
