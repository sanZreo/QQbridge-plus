// 把品牌图内嵌进 `public/console.html`：控制台**图标（favicon）**、**背景图**、**顶栏品牌标**。
//
// 为什么不放成静态文件、让浏览器按 URL 取：
//   1. `src/bridge.js` **没有通用静态路由**——它每次请求现读 `public/console.html`，
//      别的路径都走鉴权/业务分支；加一个静态路由等于改服务端并**重启桥接**（会打断正在跑的 QQ 机器人）。
//   2. `/favicon.ico` 与 `/apple-touch-icon.png` 被 `src/bridge.js` **有意 204 掉**
//      （理由写在那一行：浏览器会自动请求且不带控制台令牌，落到鉴权分支会在 DevTools 里留 401 噪音）。
//   3. 控制台有**离线浏览器回归**（`scripts/test-console-ui.mjs` 的 fixture 只喂 HTML 字符串），
//      引外部资源在那里会 404；data URI 在离线夹具里同样能正常显示。
//   所以：内嵌 = 不动服务端、不用重启、离线预览也一致。
//
// 注入三件事（全部集中在文件末尾一个块里，靠 `brand-assets:start/end` 定位，可 `--remove` 还原）：
//   · `--brand-bg` + `body::before`：全屏背景图（压暗、分主题微调，垫在 .bg-decor 渐变之下）；
//   · 运行时插 `<link rel="icon">` / `<link rel="apple-touch-icon">`：控制台图标；
//   · 运行时把顶栏那个**文字**品牌标（`<span class="brand-mark">q<span>↗</span></span>`）
//     就地换成 Q 版形象 `<img>`——所以**不需要改静态 HTML**，`--remove` 也能原样退回文字标。
//     （图片 `error` 时会退回原来的文字标，不会留下裂图方框。）
//
// ⚠️ 前提：服务端 CSP 必须放行 `img-src 'self' data:`（`src/bridge.js` 的 SECURITY_HEADERS 已补上）。
//    缺了它，浏览器会**直接拒绝** data: 图片 —— 表现为顶栏品牌标裂图、背景完全不显示、favicon 无效；
//    而"文件写对了 / HTTP 返回内容一致 / sha 对得上"这些验证**全都发现不了**（CSP 是运行时约束）。
//    改完 CSP 要**重启桥接**才生效（它是进程内已解析的字面量，不热更新）。
//
// 本脚本**只负责内嵌**（Node 标准库不能编解码图片）。请先把图预优化好，例如用仓库自带 Python：
//   python -c "from PIL import Image;im=Image.open('原图.png').convert('RGB');w,h=im.size;s=min(w,h);im.crop(((w-s)//2,(h-s)//2,(w-s)//2+s,(h-s)//2+s)).resize((192,192),Image.LANCZOS).quantize(256).save('console-icon.png',optimize=True)"
//   python -c "from PIL import Image;Image.open('原图.jpg').convert('RGB').save('console-bg.jpg',quality=78,optimize=True,progressive=True)"
//
// 用法：
//   node scripts/embed-console-brand.mjs                    # 用 assets/brand/console-icon.png + console-bg.jpg
//   node scripts/embed-console-brand.mjs --icon a.png --bg b.jpg
//   node scripts/embed-console-brand.mjs --remove           # 只删掉注入块（还原）
//
// 幂等：重复运行是替换而不是累加；每次写入前都会备份 console.html。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONSOLE = path.join(ROOT, 'public', 'console.html');
const START = '<!-- brand-assets:start（由 scripts/embed-console-brand.mjs 生成，改图请重跑脚本） -->';
const END = '<!-- brand-assets:end -->';

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const iconPath = argOf('--icon') ?? path.join(ROOT, 'assets', 'brand', 'console-icon.png');
// 背景默认用**透明底 WebP**（白底立绘直接铺会变成一块白，深色主题下尤其难看；
// 而且纯白底叠在浅色 UI 上等于看不见 —— 这就是第一版"看着没变化"的原因）。
const bgPath = argOf('--bg') ?? path.join(ROOT, 'assets', 'brand', 'console-bg.webp');

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
};

function dataUri(file) {
  const ext = path.extname(file).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`不支持的图片扩展名 ${ext}（${file}）`);
  const bytes = fs.readFileSync(file);
  if (bytes.length === 0) throw new Error(`图片是空文件：${file}`);
  return { uri: `data:${mime};base64,${bytes.toString('base64')}`, bytes: bytes.length, mime };
}

const html = fs.readFileSync(CONSOLE, 'utf8');
const sectionsBefore = (html.match(/<section(?=[\s>])/g) ?? []).length;

// 先剥掉上一次注入的块（幂等）
const stripped = html.replace(new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`, 'g'), '\n');

if (argv.includes('--remove')) {
  fs.writeFileSync(CONSOLE, stripped);
  console.log(`[brand] 已移除注入块（顶栏品牌标会退回原来的文字标 q↗）：${path.relative(ROOT, CONSOLE)}`);
  process.exit(0);
}

for (const f of [iconPath, bgPath]) {
  if (!fs.existsSync(f)) throw new Error(`找不到图片：${f}`);
}
const icon = dataUri(iconPath);
const bg = dataUri(bgPath);

const block = `${START}
<style id="brand-assets">
/* ── 背景图 ─────────────────────────────────────────────────────────────────
   立绘是**竖版**的，所以用 contain + 右下站位完整显示，而不是 cover：
   cover 会把 809×1450 放大到 1920×3442，center top 只露出最上面那段**纯白背景** ——
   第一版就是这么"看着完全没变化"的（白叠浅灰 + 18% 不透明度）。
   图片已抠掉与边缘连通的白底（带 alpha），因此可以放心把不透明度提到 .55 左右；
   深色主题再高一点，免得深蓝礼服在暗背景里糊掉。
   z-index:-1 在 .bg-decor（z-index:0 的渐变装饰）**之下**：body 的 background 会传播到画布，
   所以负 z-index 的伪元素是可见的（.bg-decor 现在就是这么露出来的）。 */
:root { --brand-bg: url("${bg.uri}") }
body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  background-image: var(--brand-bg);
  background-size: contain;
  background-position: right 2% bottom;
  background-repeat: no-repeat;
  opacity: .55;
  filter: drop-shadow(0 8px 28px rgba(0, 0, 0, .18));
  pointer-events: none;
}
html[data-theme="dark"] body::before { opacity: .60 }

/* ── 顶栏品牌标 ─────────────────────────────────────────────────────────────
   原来是文字标（q + ↗，靠 .brand-mark 的 font-size:35px 与绝对定位的内层 span 排版）。
   下面那段脚本会把 .brand-mark 的内容换成 <img>，这里只负责把方框改成图标尺寸并裁圆角；
   font-size:0 顺手压掉继承的文字尺寸（含窄屏下 @media 里的 .brand-mark{font-size:30px}——
   本块在文档流里更靠后，同特异性下后写者胜）。 */
.brand-mark {
  width: 34px;
  height: 34px;
  font-size: 0;
  letter-spacing: 0;
  border-radius: 9px;
  overflow: hidden;
  background: var(--accent-soft-bg);
  box-shadow: 0 0 0 1px var(--surface-chip-strong)
}
.brand-mark img { width: 100%; height: 100%; object-fit: cover; display: block }
</style>
<script id="brand-favicon">
/* 控制台图标 + 顶栏品牌标：都在运行时插/换，免得一大段 base64 躺在 <head> 或静态结构里。
   脚本在 </body> 之前执行，DOM 已就绪，所以不会出现"先闪一下旧标"或裂图。 */
(function () {
  var ICON = "${icon.uri}";
  ['icon', 'apple-touch-icon'].forEach(function (rel) {
    var link = document.createElement('link');
    link.rel = rel;
    link.href = ICON;
    document.head.appendChild(link);
  });
  var mark = document.querySelector('.brand-mark');
  if (mark) {
    /* 先留着原来的文字标 q↗，等图片**真的加载成功**再换掉它。
       理由：本页面的 CSP 由服务端下发，img-src 没写全时 data: 图片会被直接拦掉 ——
       那时若已经清空文字标，顶栏就只剩一个裂图方框（2026-10-16 实测踩过）。
       有这层兜底，最坏情况也只是回到原来的 q↗。 */
    var fallback = mark.innerHTML;
    var img = document.createElement('img');
    img.alt = '';
    img.addEventListener('load', function () { mark.textContent = ''; mark.appendChild(img); });
    img.addEventListener('error', function () { mark.innerHTML = fallback; });
    img.src = ICON;
  }
})();
</script>
${END}
`;

const out = stripped.replace(/<\/body>/, `${block}</body>`);
if (out === stripped) throw new Error('没找到 </body>，注入失败（文件结构变了？）');

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = `${CONSOLE}.bak-brand-${stamp}`;
fs.copyFileSync(CONSOLE, backup);
fs.writeFileSync(CONSOLE, out);

// 自己验一遍：注入块在位、两个 data URI 都在、顶栏那三条规则都在、<section> 数量没变。
const written = fs.readFileSync(CONSOLE, 'utf8');
const sectionsAfter = (written.match(/<section(?=[\s>])/g) ?? []).length;
const checks = [
  ['注入块在位', written.includes(START) && written.includes(END)],
  ['图标 data URI 在位', written.includes(icon.uri)],
  ['背景 data URI 在位', written.includes(bg.uri)],
  ['顶栏品牌标规则在位', written.includes('.brand-mark {') && written.includes("querySelector('.brand-mark')")],
  ['<section> 数量未变', sectionsBefore === sectionsAfter],
];
for (const [label, ok] of checks) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
}
if (checks.some(([, ok]) => !ok)) throw new Error('注入后自检失败，已保留备份，请检查');

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`[brand] 图标 ${path.basename(iconPath)} ${kb(icon.bytes)}（${icon.mime}）→ favicon + 顶栏品牌标`);
console.log(`[brand] 背景 ${path.basename(bgPath)} ${kb(bg.bytes)}（${bg.mime}）`);
console.log(`[brand] console.html ${kb(html.length)} → ${kb(written.length)}；备份 ${path.basename(backup)}`);
console.log('[brand] 刷新控制台页面即可看到（bridge 是每次请求现读这个文件，不用重启）。');
