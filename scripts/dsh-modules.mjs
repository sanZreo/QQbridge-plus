// 定位「DSH 安装目录下的 node_modules」—— 供仓库脚本加载 DSH 自身的模块做校验。
//
// 解析顺序：
//   1. 环境变量 DSH_INSTALL_MODULES / DSH_MODULES（应指向 <DSH>/node_modules）
//   2. 从 $DSH_HOME/profiles/<profile>/package.json 用 Node 模块解析反查真实安装位置
//      （profile 依次尝试 DSH_PROFILE、web、default，再兜底扫 profiles 下的其它目录）
// 全部失败时抛出带指引的错误，不做任何写死路径的回退 —— 宁可显式报错，也不要静默用错版本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { asarPathFromInstallDir, inspectDshAsar } from './asar-read.mjs';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

// 这些脚本需要加载的包，任意一个能解析成功即可反推出 node_modules 位置。
const PROBE_SPECIFIERS = ['@deepseek-ai/dsh-persona', 'js-yaml'];

function findNodeModules(resolvedFile) {
  let dir = path.dirname(resolvedFile);
  for (;;) {
    if (path.basename(dir) === 'node_modules') return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function candidateProfiles(home) {
  const names = [];
  const add = (n) => { if (n && !names.includes(n)) names.push(n); };
  add(process.env.DSH_PROFILE);
  add('web');
  add('default');
  try {
    for (const e of fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
      if (e.isDirectory()) add(e.name);
    }
  } catch { /* profiles 目录不存在时忽略 */ }
  return names;
}

export function dshModulesDir() {
  const override = process.env.DSH_INSTALL_MODULES || process.env.DSH_MODULES;
  if (override) return override;

  const home = dshHome();
  for (const profile of candidateProfiles(home)) {
    const anchor = path.join(home, 'profiles', profile, 'package.json');
    if (!fs.existsSync(anchor)) continue;
    const req = createRequire(anchor);
    for (const spec of PROBE_SPECIFIERS) {
      try {
        const dir = findNodeModules(req.resolve(spec));
        if (dir) return dir;
      } catch { /* 换下一个 specifier，再换下一个 profile */ }
    }
  }

  throw new Error(
    '无法定位 DSH 安装目录下的 node_modules。\n'
    + '  请设置 DSH_INSTALL_MODULES=<DSH 安装目录>/node_modules 后重试；\n'
    + `  或设置 DSH_HOME 指向 DSH 根目录（当前解析为 ${home}）。`
  );
}

/**
 * 打包版（Electron）`resources/app.asar` 的候选路径。
 *
 * 为什么需要"候选 + 内容探针"而不是一条确定路径：DSH 桌面版的安装目录
 * 没有登记在 `~/.dsh` 里（`runtime.json` 只有版本号），本机实测装在
 * `D:\deepseek harmess\`（既不在 `%LOCALAPPDATA%\Programs` 也不在 Program Files）。
 * 所以路径只能是**线索**，身份一律交给 {@link inspectDshAsar} 的内容探针裁决 ——
 * 任何 Electron 应用都有 app.asar，扫错了会产出一份"来自别的应用的工具名集合"，
 * 那会同时造成假红与假绿。
 *
 * 扫描面是**刻意收窄的**：只列固定应用目录的下一层，以及每个盘符根的下一层
 * （不做递归扫盘）。真身按 ①环境变量 → ②这些候选 的顺序找到；探针不过的一律丢弃。
 */
export function candidateAsarPaths() {
  const out = [];
  const add = (candidate) => {
    if (!candidate) return;
    const normalized = path.resolve(candidate);
    if (!out.includes(normalized)) out.push(normalized);
  };

  // ① 显式指定（一等公民：本机那种非标准安装位置就得靠它，或靠下面的盘符扫描）
  add(process.env.DSH_ASAR);
  for (const dir of String(process.env.DSH_INSTALL_DIR ?? '').split(path.delimiter).filter(Boolean)) {
    add(asarPathFromInstallDir(dir));
  }

  // ② 固定应用目录的下一层：<root>/<App>/resources/app.asar（macOS 另有 .app 内部路径）
  const appRoots = process.platform === 'win32'
    ? [path.join(process.env.LOCALAPPDATA ?? '', 'Programs'), 'C:\\Program Files', 'C:\\Program Files (x86)']
    : process.platform === 'darwin' ? ['/Applications'] : ['/opt', '/usr/lib', '/usr/local/lib'];
  const listDirs = (dir) => {
    if (!dir || !fs.existsSync(dir)) return [];
    try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
    catch { return []; }
  };
  for (const root of appRoots) {
    for (const name of listDirs(root)) {
      const base = path.join(root, name);
      add(asarPathFromInstallDir(base));
      if (process.platform === 'darwin') add(path.join(base, 'Contents', 'Resources', 'app.asar'));
    }
  }

  // ③ 盘符根（Windows）的下一层：DSH 可能被解压到任意盘符下的任意目录（本机就是）
  if (process.platform === 'win32') {
    for (const drive of 'CDEFGH'.split('')) {
      const root = `${drive}:\\`;
      for (const name of listDirs(root)) add(asarPathFromInstallDir(path.join(root, name)));
    }
  }

  return out;
}

/**
 * 可用的「DSH 自带工具包」数据源，按优先级排列。
 *
 * - `{ kind: 'dir', dir }`：普通安装（`@deepseek-ai` 目录直接可读），零额外开销。
 * - `{ kind: 'asar', asarPath }`：Electron 打包版，由 `scripts/asar-read.mjs` 读字节。
 *
 * 一个都找不到时返回空数组 —— **不抛错**：调用方（测试）要的是"三级降级"
 * （目录 → asar → 显式跳过），抛错会把它逼成"要么红要么吞"。
 * 需要"定位不到就报错"的旧行为时仍用 {@link dshModulesDir}。
 */
export function dshToolPackageSources() {
  const sources = [];
  const seen = new Set();
  const push = (source) => {
    const key = `${source.kind}:${source.kind === 'asar' ? source.asarPath : source.dir}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(source);
  };

  const packagesOverride = process.env.DSH_TOOL_PACKAGES;
  if (packagesOverride) push({ kind: 'dir', dir: packagesOverride, describe: `DSH_TOOL_PACKAGES=${packagesOverride}` });

  const modulesOverride = process.env.DSH_INSTALL_MODULES || process.env.DSH_MODULES;
  if (modulesOverride) {
    push({ kind: 'dir', dir: path.join(modulesOverride, '@deepseek-ai'), describe: `DSH_INSTALL_MODULES=${modulesOverride}` });
  }

  const home = dshHome();
  for (const profile of candidateProfiles(home)) {
    const anchor = path.join(home, 'profiles', profile, 'package.json');
    if (!fs.existsSync(anchor)) continue;
    const req = createRequire(anchor);
    for (const spec of PROBE_SPECIFIERS) {
      try {
        const modulesDir = findNodeModules(req.resolve(spec));
        if (modulesDir) push({ kind: 'dir', dir: path.join(modulesDir, '@deepseek-ai'), describe: `profile "${profile}" 反查` });
      } catch { /* 下一个 */ }
    }
  }

  for (const asarPath of candidateAsarPaths()) {
    const info = inspectDshAsar(asarPath);
    if (info.ok) push({ kind: 'asar', asarPath, describe: `打包版 asar（${info.packages.length} 个 dsh-* 包）: ${asarPath}` });
  }

  return sources;
}
