// DSH 工具名抽取：**唯一实现**，供
//   · `scripts/scan-dsh-tool-names.mjs`（人工/升级时对账，打印清单）
//   · `scripts/test-preset-local-tools.mjs`（登记期断言，防拼错假名）
// 共同使用。
//
// 为什么要抽成模块：这两处过去各有一份实现，而测试那份是**模糊**的
// （`\bname:\s*['"]x['"]` 全文件乱扫 + 只认少数包名前缀 + 只读包根目录的
// cordis.patch.yml）。结果 0.2.0 对账时把 10 个**真实存在**的工具名误判成
// 「假名」——`dsh-mcp-resources` 与 `dsh-experimental-tool-agent-team` 不匹配它
// 的包名白名单，`subagent_codex` 写在 `dsh-web-app/presets/*.patch.yml` 而不是
// 包根。误判方向是危险的：它会逼人把真名字从守卫名单里删掉。
//
// 抽取规则（都要求**就近锚定**，不把 `systemPrompt.section({ name: 'tool:read' })`
// 这类非工具名当工具）：
//   ① `.register(defineTool({ … name: "X" … }))` —— DSH 所有工具包的注册形状
//   ② `toolName: "X"` / `toolName: z.string().default("X")` —— 配置化工具名
//      （dsh-tool-subagent 的 subagent / subagent_fork 就是这样声明的）
//   ③ YAML patch 里的 `toolName: X` 行（任意层级 *.patch.yml，含 presets/ 子目录）
import fs from 'node:fs';
import path from 'node:path';
import { dshModulesDir } from './dsh-modules.mjs';
import { inspectDshAsar, openAsar, readAsarFile, walkAsarFiles } from './asar-read.mjs';

/** 名字形态：小写字母开头，允许下划线与连字符，长度合理。 */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_-]{1,40}$/;

/** DSH 自带包所在目录（`<node_modules>/@deepseek-ai`）。 */
export function dshPackagesDir() {
  return process.env.DSH_TOOL_PACKAGES || path.join(dshModulesDir(), '@deepseek-ai');
}

/** 用户安装的第三方插件目录（也会注册工具：plugin-guard / 超级注入器等）。 */
export function dshPluginDirs() {
  const home = process.env.DSH_HOME
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.dsh') : null);
  return [home ? path.join(home, 'plugins') : null].filter((p) => p && fs.existsSync(p));
}

function walkFiles(dir, out = [], depth = 0, maxDepth = 5) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < maxDepth) walkFiles(full, out, depth + 1, maxDepth); }
    else out.push(full);
  }
  return out;
}

/** 从一个 JS/TS 源文件里抽取工具名。 */
function extractFromSource(text, source, add) {
  for (const m of text.matchAll(/\.register\(\s*defineTool\(\{[\s\S]{0,400}?\bname:\s*["']([^"']+)["']/g)) {
    add(m[1], source);
  }
  for (const m of text.matchAll(/\btoolName:\s*["']([^"']+)["']/g)) add(m[1], source);
  for (const m of text.matchAll(/\btoolName:\s*[^;\n]*?\.default\(\s*["']([^"']+)["']/g)) add(m[1], source);
  // 独立的一次性工具文件（defineTool 不挂在 .register( 上时的兜底）
  for (const m of text.matchAll(/defineTool\(\{[\s\S]{0,200}?\bname:\s*["']([^"']+)["']/g)) {
    add(m[1], source);
  }
}

/** 从 YAML patch 里抽取配置化的工具名。 */
function extractFromPatch(text, source, add) {
  for (const m of text.matchAll(/^\s*(?:-\s*)?toolName:\s*([^\s#]+)\s*$/gm)) {
    add(m[1].replace(/^['"]|['"]$/g, ''), source);
  }
}

/** 目录模式与 asar 模式共用的「这个文件值不值得读」判据（两边必须一致，否则名字集会漂移）。 */
const WANTED_FILE_RE = /\.(js|mjs|cjs)$/;

function isWantedToolFile(relPath) {
  return WANTED_FILE_RE.test(relPath) || relPath.endsWith('.d.ts') || /\.patch\.ya?ml$/.test(relPath);
}

/** 与 `walkFiles` 的 `maxDepth = 5` 对齐：包根下最多 5 层目录。 */
const MAX_INNER_DIRS = 5;

/**
 * 从**打包版**（app.asar）里抽工具名。
 *
 * 为什么值得单独做：打包版是真实用户的主力安装形态，而它恰恰是「普通 Node 读不到
 * `@deepseek-ai/*`」的那种安装 —— 不覆盖它，`restrict` 名单对账就等于没做。
 *
 * 与目录模式的两点**刻意差异**：
 *  1. **读失败必须抛错**（目录模式那几处 `catch { continue }` 会把"读不到"吞成
 *     "这个名字不存在"，而少一个名字的方向是把真工具名误判成假名）。
 *  2. **完备性可证明**：asar 头里先验就能枚举出"应读哪些文件"，所以这里断言
 *     `实读 === 计划数`。目录树做不到这件事，这是 asar 模式更强的地方。
 */
function collectFromAsar(asarPath, add, packages) {
  const info = inspectDshAsar(asarPath);
  if (!info.ok) throw new Error(`asar 不是一份可用的 DSH 安装（${info.reason}）: ${asarPath}`);
  const asar = openAsar(asarPath);
  const prefix = `${info.packagesDir}/`;

  const planned = [];
  for (const { path: rel } of walkAsarFiles(asar)) {
    if (!rel.startsWith(prefix)) continue;
    const segments = rel.slice(prefix.length).split('/');
    if (segments.length < 2) continue;                 // 包目录本身
    const pkg = segments[0];
    if (!pkg.startsWith('dsh-')) continue;             // 与目录模式的 filter=/^dsh-/ 一致
    const inner = segments.slice(1);
    // 与 walkFiles 一致：内层 node_modules / .git 不进去，深度不超过 5 层。
    if (inner.some((s) => s === 'node_modules' || s === '.git')) continue;
    if (inner.length - 1 > MAX_INNER_DIRS) continue;
    if (!isWantedToolFile(rel)) continue;
    planned.push({ rel, pkg });
  }

  for (const name of info.packages) packages.push(name);

  let read = 0;
  for (const { rel, pkg } of planned) {
    const text = readAsarFile(asar, rel).toString('utf8');
    read += 1;
    if (/\.patch\.ya?ml$/.test(rel)) extractFromPatch(text, pkg, add);
    else extractFromSource(text, pkg, add);
  }
  if (read !== planned.length) {
    throw new Error(`asar 抽取只读了 ${read}/${planned.length} 个文件 —— 完备性不成立，不能拿这份名字集出结论`);
  }
  return read;
}

/** 目录模式：扫一个目录下的包（DSH 自带包用 filter=/^dsh-/，插件目录用 null）。 */
function collectFromDir(dir, filter, add, packages) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (filter && !filter.test(e.name)) continue;
    const pkgDir = path.join(dir, e.name);
    packages.push(e.name);
    for (const f of walkFiles(pkgDir)) {
      let text = '';
      try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      if (/\.(js|mjs|cjs)$/.test(f) || f.endsWith('.d.ts')) extractFromSource(text, e.name, add);
      else if (/\.patch\.ya?ml$/.test(f)) extractFromPatch(text, e.name, add);
    }
  }
}

/**
 * 抽取已安装 DSH（及其插件）里出现的全部工具名。
 *
 * @param options.packagesDir - `@deepseek-ai` 目录；缺省按 {@link dshPackagesDir} 解析。
 * @param options.pluginDirs - 第三方插件目录列表；缺省按 {@link dshPluginDirs} 解析。
 * @param options.asarPath - 打包版（Electron）的 `resources/app.asar`。给了它就**不再**
 *        走目录定位（打包版上 `@deepseek-ai/*` 本来就读不到），改用 asar 读取。
 * @returns `{ names: Map<name, Set<source>>, packages: string[] }`。
 *          `packages` 是实际扫过的包/插件名，便于诊断「一个都没扫到」。
 */
export function collectDshToolNames({ packagesDir, pluginDirs, asarPath } = {}) {
  const names = new Map();
  const packages = [];
  const add = (name, source) => {
    if (!TOOL_NAME_RE.test(name)) return;
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(source);
  };

  // DSH 自带包：目录优先（普通安装，零额外开销）；只有调用方明确给了 asarPath 才走打包版。
  const pkgRoot = packagesDir ?? (asarPath ? null : dshPackagesDir());
  if (pkgRoot) {
    if (fs.existsSync(pkgRoot)) collectFromDir(pkgRoot, /^dsh-/, add, packages);
  } else if (asarPath) {
    collectFromAsar(asarPath, add, packages);
  }

  for (const dir of pluginDirs ?? dshPluginDirs()) {
    // 用户的插件目录里全是插件包（含 .bak-* 备份，也一起扫：备份里的旧名字
    // 仍然说明这个名字曾经真实存在）。
    collectFromDir(dir, null, add, packages);
  }

  return { names, packages };
}

/** 便利包装：只要名字集合。 */
export function dshToolNameSet(options) {
  return new Set(collectDshToolNames(options).names.keys());
}

/**
 * 「危险语义」判定：与本地执行 / 文件 / 进程 / 派生 agent / 宿主运行期相关的名字。
 * 守卫**必须**覆盖它们。纯模型侧无害工具由 {@link SAFE_MODEL_TOOLS} 显式排除。
 *
 * 这是**发现用**的启发式（宁可多报，人工再判），不是安全边界本身；
 * 边界是守卫的 restrict 名单 + 执行期白名单。
 */
export const DANGER_TOOL_RE = /(pwsh|bash|shell|exec|spawn|process|terminal|pty|read|write|edit|file|fs_|glob|grep|patch|str_replace|subagent|agent_|teammate|workflow|ralph|job|skill|present|goal|plan|todo|memory|snapshot|rollback|incident|plugin|cordis|dsh_|dev_|import|install|reload|inject|stage|config|workspace|session|export|office|slash|command|schedule|voice|speech|team|mcp_resource)/;

/** 明确无害、允许出现在仿真会话 schema 里的模型侧工具。 */
export const SAFE_MODEL_TOOLS = new Set(['ask_user_question', 'todo_write']);
