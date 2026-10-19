// 纯 Node 读 Electron 打包版（app.asar）里的文件字节 —— 不落盘、不依赖 Electron。
//
// 为什么需要它：DSH 的 Electron 打包版把 `@deepseek-ai/*` 放在 `resources/app.asar` 里，
// 普通 Node 的 fs 打不开（只有 native 相关的那几个包被解包到 `app.asar.unpacked/`）。
// 于是 `scripts/dsh-modules.mjs` 定位不到「安装目录下的 node_modules」，
// 而 `scripts/test-preset-local-tools.mjs` 那条**安全断言**
// （restrict 名单里每个名字都必须是 DSH 真实注册的工具名，防拼错假名静默失效）
// 在打包版上长期「跳过 ⇒ 绿而零覆盖」。本模块让那条断言在打包版上也能真跑。
//
// asar 容器格式（与 @electron/asar 的 readArchiveHeaderSync 一致）：
//   [0..3]   uint32  外层 pickle 载荷长度（固定 4）
//   [4..7]   uint32  头 pickle 总长 S（含它自己的 4 字节长度前缀与对齐填充）
//   [8..11]  uint32  头 pickle 载荷长度
//   [12..15] uint32  头 JSON 的字节长度 H
//   [16..16+H)       头 JSON
//   内容区起点 = 8 + S；文件条目 { size, offset: "<十进制字符串，相对内容区>", unpacked? }
//
// 三条硬约束（评审结论，改动时别破坏）：
//   1. **绝不落盘、绝不把条目的 path 交给 path.resolve/join 去碰真实文件系统** ——
//      path 只当**字符串过滤键**用。这样才能保证畸形的 `..\..\` 条目伤不到任何东西。
//      （唯一的例外是 `unpacked: true` 的条目：它的字节*按定义*在 asar 之外，
//       见下。）
//   2. **所有长度/偏移都要对文件真实大小做上界校验**。这不是"对抗恶意输入"
//      （能改本机安装文件的人早就 RCE 了），而是"本机 asar 损坏/格式变了 ⇒
//      不 OOM、不读到错位字节、显式抛错降级"。
//   3. **读失败必须抛错，不许静默跳过**。`dsh-tool-names.mjs` 里那几处
//      `catch { continue }` 会把"读不到"吞成"这个名字不存在"，
//      而工具名少一个的方向是**把真名判成假名**（历史上就逼人删掉过真名字），
//      比漏隐藏更危险。asar 模式下"应读哪些文件"是**先验可知**的（头里就有），
//      所以这里没有任何"读不到就算了"的理由。
import fs from 'node:fs';
import path from 'node:path';

/** 头 JSON 的字节上限：真身 ~3.4MB，给足余量但不接受任意大的分配。 */
const MAX_HEADER_BYTES = 64 * 1024 * 1024;

/** 打包版 asar 的默认相对位置（安装目录 → asar）。 */
export function asarPathFromInstallDir(installDir) {
  return path.join(installDir, 'resources', 'app.asar');
}

/**
 * 打开一个 asar 容器（只读头，不读内容）。
 *
 * @param {string} asarPath
 * @returns {{ path: string, size: number, header: object, contentStart: number, unpackedDir: string }}
 * @throws 头不完整/长度越界/JSON 不合法时抛错（错误消息带 asar 路径，便于诊断）
 */
export function openAsar(asarPath) {
  const size = fs.statSync(asarPath).size;
  if (size < 16) throw new Error(`不是 asar：文件太小（${size} 字节）: ${asarPath}`);

  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) !== 16) throw new Error(`不是 asar：读不到 16 字节头: ${asarPath}`);

    const headerPickleSize = head.readUInt32LE(4);
    const headerJsonSize = head.readUInt32LE(12);
    // 上界校验：任何一项越过文件尾都说明这不是我们认识的 asar（或文件被截断）。
    if (headerPickleSize <= 0 || 8 + headerPickleSize > size) {
      throw new Error(`不是 asar：头长度越界（headerPickleSize=${headerPickleSize}, fileSize=${size}）: ${asarPath}`);
    }
    if (headerJsonSize <= 0 || headerJsonSize > MAX_HEADER_BYTES || 16 + headerJsonSize > size) {
      throw new Error(`不是 asar：头 JSON 长度越界（headerJsonSize=${headerJsonSize}, fileSize=${size}）: ${asarPath}`);
    }

    const json = Buffer.alloc(headerJsonSize);
    if (fs.readSync(fd, json, 0, headerJsonSize, 16) !== headerJsonSize) {
      throw new Error(`不是 asar：头 JSON 读不满: ${asarPath}`);
    }
    let header;
    try {
      header = JSON.parse(json.toString('utf8'));
    } catch (error) {
      throw new Error(`不是 asar：头 JSON 无法解析（${error.message}）: ${asarPath}`);
    }
    if (!header || typeof header !== 'object' || typeof header.files !== 'object' || header.files === null) {
      throw new Error(`不是 asar：头里没有 files 表: ${asarPath}`);
    }

    return {
      path: asarPath,
      size,
      header,
      contentStart: 8 + headerPickleSize,
      unpackedDir: `${asarPath}.unpacked`,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** 遍历 asar 头，产出全部文件条目：`{ path, entry }`（path 用 '/' 分隔）。 */
export function walkAsarFiles(asar, root = asar.header) {
  const out = [];
  const visit = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (entry && typeof entry === 'object' && entry.files) visit(entry, p);
      else out.push({ path: p, entry });
    }
  };
  visit(root, '');
  return out;
}

/** 按 asar 内的相对路径找**节点**（目录或文件都返回）；找不到返回 null。 */
export function findAsarNode(asar, relativePath) {
  const segments = String(relativePath).split('/').filter(Boolean);
  let node = asar.header;
  for (const segment of segments) {
    const next = node?.files?.[segment];
    if (!next) return null;
    node = next;
  }
  return node;
}

/** 找**文件**条目（目录不算）；找不到返回 null。 */
export function findAsarEntry(asar, relativePath) {
  const node = findAsarNode(asar, relativePath);
  if (!node || node.files) return null;
  return node;
}

/**
 * 读一个 asar 内文件的字节。
 *
 * `unpacked: true` 的条目**没有有效 offset**：它的字节按定义在旁边的
 * `<asar>.unpacked/<路径>` 里（实测本机 753 个这样的条目在磁盘上全部可读，
 * 且其中 33 个正属于我们关心的文件类型 —— 所以不能像"反正工具名都在压缩区"那样
 * 直接跳过：那会漏掉真文件，而漏读的方向正是把真工具名判成假名）。
 *
 * @throws 条目不存在、越界、或 unpacked 副本缺失时抛错（绝不返回空内容当成功）
 */
export function readAsarFile(asar, relativePath) {
  const entry = findAsarEntry(asar, relativePath);
  if (!entry) throw new Error(`asar 里没有这个条目: ${relativePath}`);
  if (entry.unpacked === true) {
    const onDisk = path.join(asar.unpackedDir, ...relativePath.split('/'));
    try {
      return fs.readFileSync(onDisk);
    } catch (error) {
      throw new Error(`unpacked 条目在读不到的磁盘副本上: ${onDisk}（${error.code ?? error.message}）`);
    }
  }
  const offset = Number(entry.offset);
  const size = Number(entry.size);
  if (!Number.isFinite(offset) || !Number.isFinite(size) || offset < 0 || size < 0) {
    throw new Error(`asar 条目缺少可用的 offset/size: ${relativePath}`);
  }
  if (asar.contentStart + offset + size > asar.size) {
    throw new Error(`asar 条目越界（offset=${offset} size=${size}）: ${relativePath}`);
  }
  const fd = fs.openSync(asar.path, 'r');
  try {
    const buf = Buffer.alloc(size);
    if (size > 0 && fs.readSync(fd, buf, 0, size, asar.contentStart + offset) !== size) {
      throw new Error(`asar 条目读不满: ${relativePath}`);
    }
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 这个 asar 像不像一份 **DSH 安装**？
 *
 * 为什么必须有这道"身份探针"：候选路径可能存在**多个** app.asar（任何 Electron 应用都有），
 * 而抽错文件会产出一份"看着像工具名集合、其实来自别的应用"的数据 ⇒ 假红或假绿。
 * 路径只是线索，身份只能靠内容确认（与 `dsh-modules.mjs` 用
 * `createRequire().resolve()` 反查真实模块是同一个思路）。
 *
 * 判据：存在可解析的 `dsh/node_modules/@deepseek-ai/dsh-persona/package.json`，
 * 且 `dsh/node_modules/@deepseek-ai/` 下的包数不小于 `minPackages`
 * （真身 289；asar 根下那个只有 8 个包的 `node_modules/@deepseek-ai` 是干扰项，必须落选）。
 *
 * @returns {{ ok: true, packagesDir: string, packages: string[] } | { ok: false, reason: string }}
 */
export function inspectDshAsar(asarPath, { minPackages = 50 } = {}) {
  let asar;
  try {
    asar = openAsar(asarPath);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  const packagesDir = 'dsh/node_modules/@deepseek-ai';
  const dir = findAsarNode(asar, packagesDir);
  if (!dir || !dir.files) return { ok: false, reason: `asar 里没有 ${packagesDir}（不是 DSH 打包版？）` };
  const packages = Object.keys(dir.files ?? {}).filter((name) => name.startsWith('dsh-'));
  const persona = findAsarEntry(asar, `${packagesDir}/dsh-persona/package.json`);
  if (!persona) return { ok: false, reason: `asar 里没有 ${packagesDir}/dsh-persona/package.json` };
  try {
    JSON.parse(readAsarFile(asar, `${packagesDir}/dsh-persona/package.json`).toString('utf8'));
  } catch (error) {
    return { ok: false, reason: `dsh-persona/package.json 读不出或无法解析：${error.message}` };
  }
  if (packages.length < minPackages) {
    return { ok: false, reason: `${packagesDir} 下只找到 ${packages.length} 个 dsh-* 包（< ${minPackages}），疑似扫到了干扰目录` };
  }
  return { ok: true, packagesDir, packages };
}
