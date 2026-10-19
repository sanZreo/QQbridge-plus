// Offline integration tests. Every setup invocation receives its own repository and DSH_HOME.
// QQ_BRIDGE_TEST_YAML_ROOT is only useful when auditing with an intentionally read-only
// node_modules tree; normal installs resolve the declared js-yaml dependency directly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parserRoot = process.env.QQ_BRIDGE_TEST_YAML_ROOT || path.dirname(require.resolve('js-yaml/package.json'));
const yaml = (await import(pathToFileURL(path.join(parserRoot, 'dist/js-yaml.mjs')).href)).default;
// 本文件的每个用例都要 spawnSync 拉起 scripts/setup-dsh.mjs。这里刻意**不用**
// `encoding:'utf8'`（等价于 stdio:'pipe'）：DSH 沙箱（workspace-write / 只读）禁止
// 带管道的 spawn（EPERM）。而一旦 spawn 被拒，6 条断言会一起报 `null !== 0` ——
// 其中 malformed / traversal / plugin-conflict 三条断的是 `status !== 0`，失败时
// status 恰是 **null**，`null !== 0` 恒真 ⇒ 它们会**以错误的原因变绿**（紧随其后的
// "文件没被改 / 目录没被建"在子进程根本没跑时也天然成立），看着像验证过了，实际零覆盖。
//
// 改用**文件 fd** 收子进程输出：沙箱不禁文件 fd（scripts/test-audit.mjs 用的是同一招），
// 于是这 6 条断言在本机真的跑起来，而不是被跳过。
const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-setup-capture-'));
let captureSeq = 0;

/** 跑子进程并把 stdout / stderr 收到文件里再读回来（全程不经过管道）。 */
function spawnCaptured(command, args, options = {}) {
  const outPath = path.join(captureDir, `out-${captureSeq}.log`);
  const errPath = path.join(captureDir, `err-${captureSeq}.log`);
  captureSeq += 1;
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  let result;
  try {
    result = spawnSync(command, args, { ...options, stdio: ['ignore', outFd, errFd] });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return { ...result, stdout: fs.readFileSync(outPath, 'utf8'), stderr: fs.readFileSync(errPath, 'utf8') };
}

{
  // 探针用**与用例完全相同**的机制：只有这套机制本身不可用时才跳过。
  const probe = spawnCaptured(process.execPath, ['-e', 'process.exit(0)']);
  if (probe.error?.code === 'EPERM' || probe.error?.code === 'EACCES') {
    fs.rmSync(captureDir, { recursive: true, force: true });
    console.log(`  ⏭  跳过：本文件全部 6 条 setup 断言（连文件 fd 方式的 spawn 都被拒：${probe.error.code}）—— 跳过，不是通过`);
    console.log('     请在普通终端（非 DSH 沙箱）里重跑本文件。');
    process.exit(0);
  }
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-audit-setup-'));
let failures = 0;

function fixture(name, patch = '') {
  const base = path.join(sandbox, name);
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/setup-dsh.mjs'), path.join(repo, 'scripts/setup-dsh.mjs'));
  // setup-dsh.mjs 直接从仓库源生成 bundle patch，生成器必须一起进夹具。
  fs.copyFileSync(path.join(root, 'scripts/build-agent-preset-patches.mjs'), path.join(repo, 'scripts/build-agent-preset-patches.mjs'));
  fs.cpSync(path.join(root, 'dsh'), path.join(repo, 'dsh'), { recursive: true });
  fs.cpSync(path.join(root, 'plugins'), path.join(repo, 'plugins'), { recursive: true });
  fs.cpSync(parserRoot, path.join(repo, 'node_modules/js-yaml'), { recursive: true });
  fs.mkdirSync(path.join(home, 'profiles/web'), { recursive: true });
  const patchFile = path.join(home, 'profiles/web/cordis.patch.yml');
  fs.writeFileSync(patchFile, patch);
  fs.writeFileSync(path.join(home, 'profiles/web/package.json'), JSON.stringify({
    name: 'fixture-profile', dependencies: { existing: '1.0.0' },
    dsh: { profile: { bundles: ['existing'] } },
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, { PATH: path.dirname(process.execPath), DSH_HOME: home, HOME: home, USERPROFILE: home, QQ_BRIDGE_SKIP_DSH_INSTALL: '1' });
  const run = (profile = 'web', extraEnv = {}) => spawnCaptured(process.execPath, [path.join(repo, 'scripts/setup-dsh.mjs'), profile], {
    env: { ...env, ...extraEnv }, cwd: repo, timeout: 15000,
  });
  return { repo, home, patchFile, run };
}

function test(name, fn) {
  // 极简测试壳：给用例一个 t.skip()，让「本环境不成立的断言」显示成 SKIP 而不是 PASS。
  // 不能在这里假装通过 —— 这些 PASS/FAIL 行就是被人读的结果面。
  const skipped = [];
  const t = { skip: (why) => { skipped.push(String(why ?? '')); } };
  try {
    fn(t);
    if (skipped.length > 0) console.log(`SKIP ${name}: ${skipped[0]}`);
    else console.log(`PASS ${name}`);
  } catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
}

// 否定式断言（`status !== 0`）必须先证明「子进程真的跑起来了」。
//
// 历史缺陷：malformed / traversal / plugin-conflict 三条用例断的是 `status !== 0`，
// 而 spawnSync 失败时 status 是 **null** ⇒ `null !== 0` 恒真，用例空转变绿，
// 而且它们后面那些「文件没被改 / 目录没被建」的断言在子进程根本没跑时**天然成立**，
// 于是整条用例零覆盖却显示通过。
// 触发通道有两个，**第二个与 DSH 沙箱无关、在普通终端也会发生**：
//   ① stdio:pipe 的 spawn 被沙箱拒（EPERM）—— 文件开头已用探针整体拦截；
//   ② 子进程被 `timeout: 15000` 杀掉（SIGTERM）—— setup-dsh 挂死（真 bug）时就是这样。
// 所以：先断 error 为空、status 非 null，再断退出码语义。
function assertSpawned(result, label = '子进程') {
  assert.equal(result.error, undefined,
    `${label}: 子进程未能启动（${result.error?.code ?? result.error?.message ?? '未知'}）`);
  assert.notEqual(result.status, null, `${label}: 没有退出码（很可能被 timeout 杀掉）`);
}

try {
  test('shared inserts, quoted IDs, flow YAML and unrelated nested arrays survive repeat setup', () => {
    const source = `# user patch\n- insert:\n    - id: mcp-snowluma\n      name: old\n    - id: custom\n      name: custom-plugin\n      config:\n        empty:\n          []\n        nested:\n          - id: mcp-snowluma-host\n            value: keep\n- insert:\n    - id: 'mcp-snowluma-host' # previous setup\n      name: old\n- {insert: [{id: mcp-web-search-safe, name: old}]}\n`;
    const f = fixture('structured', source);
    const originalCustom = yaml.load(source)[0].insert[1];
    for (let i = 0; i < 2; i++) {
      const result = f.run();
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const doc = yaml.load(fs.readFileSync(f.patchFile, 'utf8'));
      const entries = doc.flatMap((op) => op.insert || []);
      assert.deepEqual(entries.find((entry) => entry.id === 'custom'), originalCustom);
      for (const id of ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe']) {
        assert.equal(entries.filter((entry) => entry.id === id).length, 1, `${id} duplicate`);
      }
      assert.equal(entries.find((entry) => entry.id === 'mcp-snowluma').config.toolCallTimeoutMs, 725000);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(f.home, 'profiles/web/package.json')));
    assert.equal(pkg.dependencies.existing, '1.0.0');
    assert.deepEqual(pkg.dsh.profile.bundles, ['existing', 'qq-mode-console', 'qq-agent-presets']);
  });

  test('legacy root [] is repaired without altering literal strings', () => {
    const f = fixture('legacy', `[]\n- insert:\n    - id: custom\n      name: custom\n      config:\n        text: |\n          []\n          keep me\n`);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(yaml.load(fs.readFileSync(f.patchFile, 'utf8'))[0].insert[0].config.text, '[]\nkeep me\n');
  });

  test('malformed patch fails before replacing user configuration or presets', () => {
    const source = '- insert: [broken\n';
    const f = fixture('malformed', source);
    const result = f.run();
    assertSpawned(result, 'setup-dsh 子进程');
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(f.patchFile, 'utf8'), source);
    assert.equal(fs.existsSync(path.join(f.home, '.agent-presets')), false);
  });

  test('profile traversal is rejected before filesystem changes', () => {
    const f = fixture('traversal');
    const result = f.run('../../escape');
    assertSpawned(result, 'setup-dsh 子进程');
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(f.home, 'escape')), false);
    assert.equal(fs.existsSync(path.join(f.home, '.agent-presets')), false);
  });

  test('existing mode, DSH settings and non-link plugin directory remain untouched', () => {
    const f = fixture('preserve', '[]\n');
    fs.mkdirSync(path.join(f.repo, 'state'), { recursive: true });
    const mode = '{"mode":"closed-agent","closedAgentPreset":"custom"}\n';
    fs.writeFileSync(path.join(f.repo, 'state/mode.json'), mode);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(f.repo, 'state/mode.json'), 'utf8'), mode);
    const blocker = fixture('plugin-conflict', '[]\n');
    fs.mkdirSync(path.join(blocker.home, 'plugins/qq-mode-console'), { recursive: true });
    fs.writeFileSync(path.join(blocker.home, 'plugins/qq-mode-console/keep.txt'), 'keep');
    const blocked = blocker.run();
    assertSpawned(blocked, 'plugin-conflict 的 setup-dsh 子进程');
    assert.notEqual(blocked.status, 0);
    assert.equal(fs.readFileSync(path.join(blocker.home, 'plugins/qq-mode-console/keep.txt'), 'utf8'), 'keep');
  });

  if (process.platform === 'win32') test('Windows runs the npm .cmd shim with literal profile arguments', (t) => {
    const f = fixture('windows-cli');
    const bin = path.join(f.repo, 'bin');
    fs.mkdirSync(bin);
    const captureFile = path.join(bin, 'called.json');
    const cli = path.join(bin, 'fake-dsh.mjs');
    fs.writeFileSync(cli, `import fs from 'node:fs'; fs.writeFileSync(process.env.QQ_TEST_CAPTURE, JSON.stringify({args: process.argv.slice(2), home: process.env.DSH_HOME}));\n`);
    fs.writeFileSync(path.join(bin, 'dsh.cmd'), `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
    const profile = 'test&name%CD%!';
    const result = f.run(profile, {
      PATH: [bin, path.dirname(process.execPath)].join(path.delimiter),
      QQ_BRIDGE_SKIP_DSH_INSTALL: '0', QQ_TEST_CAPTURE: captureFile,
    });
    assertSpawned(result, 'windows-cli 的 setup-dsh 子进程');
    assert.equal(result.status, 0, result.stderr);
    // 本用例验的是「setup-dsh 怎么调用 dsh.cmd」。而 setup-dsh.mjs:335 自己要用
    // **带管道**的 spawnSync 去拉那个 shim（为了收 stdout）—— 沙箱禁止管道 spawn，
    // 于是 CLI 根本不会被调用（日志里是 setup-dsh.mjs:343 的那行 EPERM 提示；
    // 它走 setup-dsh 的 log() ⇒ **stdout**，所以两个流都要看）。
    // 这是环境限制，精确跳过这一条，而不是判失败（跳过，不是通过）。
    if (/auto-install failed to start\/complete（EPERM）/.test(result.stdout + result.stderr)) {
      console.log('  ⏭  跳过：Windows .cmd shim 的调用断言（沙箱禁止带管道的 spawn，setup-dsh 拉不起 dsh.cmd）—— 跳过，不是通过');
      t.skip('本环境不允许带管道的 spawn（EPERM）');
      return;
    }
    assert.ok(fs.existsSync(captureFile), `CLI was not invoked: ${result.stdout}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(captureFile)), { args: ['plugin', '--profile', profile, 'install'], home: f.home });
  });
} finally {
  // Resolve the exact fixture root before removing this test's temporary files.
  assert.equal(path.dirname(path.resolve(sandbox)), path.resolve(os.tmpdir()));
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(captureDir, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
