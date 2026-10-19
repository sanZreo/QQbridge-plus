// Safe audit suite: fixtures and mocks only, never production QQ/DSH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  'test-audit-bridge.mjs', 'test-audit-protocol.mjs', 'test-audit-protocol-helpers.mjs',
  'test-audit-security.mjs', 'test-audit-security-mcp.mjs',
  'test-audit-setup.mjs', 'test-audit-setup-guards.mjs',
  // DSH 会话队列（inbox 投影）解析：0.2.0 把队列从 control baseline 的
  // `value.queues[<id>]` 挪进了 `value.projections[<id>].values.inbox`。
  // 认错形状的后果不是"少清几条"，而是**每一次退役会话都抛错**、旧任务继续跑，
  // 且只留下一行日志 —— 必须有登记期断言钉住（活 DSH 侧的实测见
  // scripts/test-dsh-session-retire.mjs）。
  'test-dsh-inbox-projection.mjs',
  'test-md-to-plain.mjs', 'test-slang-learn.mjs', 'test-slang-inject.mjs', 'test-mux-reconnect.mjs',
  'test-token-economy.mjs', 'test-qq-model-view.mjs', 'test-qq-preset-contract.mjs',
  // 入站韧性：重复投递去重（同一条 QQ 消息只入库一次）、投递看门狗（DSH 某环
  // 永不返回时强制释放会话互斥，避免「等待锁卡死」）、限流唤醒改为暂存而非丢弃。
  'test-ingest-resilience.mjs',
  'test-reply-wait.mjs', 'test-preset-prompt.mjs', 'test-role-card.mjs',
  // 令牌账本 / 价目表 与 体检修复回归（纯函数，无外部依赖）
  'test-token-usage.mjs', 'test-hardening.mjs',
  // 语音发送（纯函数 + 端点存在性；真发语音只在 --live 或 CLI 里做）
  'test-voice.mjs',
  // 音量：参数校验 + 真的调用 ffmpeg 调音量 + 自算 RMS 验证增益
  'test-voice-volume.mjs',
  // 边界：并发/异常输入/上传限额/越权（纯函数段 + 可选的 live 段）
  'test-voice-edge.mjs',
  // 语音图形界面（参数解析/鉴权/路径穿越/文件名净化；live 段需普通终端）
  'test-voice-gui.mjs',
  // 控制台静态契约（跑不了 Playwright 的环境下的替代回归）
  'test-console-static.mjs',
  // 语音系统整体结构检查（入口/依赖/端点/开关/文档一致性）
  'test-voice-system.mjs',
  // SnowLuma 账号/token 自发现（换 QQ 账号后 token 会变，写死的工具会 401）
  'test-snowluma-conn.mjs',
  // 启动器与编码（乱码根因：.cmd 里的非 ASCII 会被 cmd 按 ANSI 解码）
  'test-encoding.mjs',
  // 控制台乱码机制（UTF-8 字节被按 GBK 解码）+ chcp 修复
  'test-console-encoding.mjs',
  // 🔴 铁律 L7（仿真会话不得拥有本地执行能力）：注册期断言——
  //    preset 挂了守卫、守卫的 restrict 名单覆盖全部已知本地工具、且执行期一律拒绝。
  //    这是唯一挡住"绕过桥接直连 OneBot HTTP"的东西（见 QSH_PLAN.md §0.1/§5.2），
  //    所以必须在每次回归里跑，而不是一次性验收。
  'test-preset-local-tools.mjs',
  // 打包版（Electron app.asar）读取器：合成 asar 夹具覆盖头解析/按条目读字节/unpacked
  // 磁盘回退/越界与截断显式失败/身份探针。**为什么必须有它**：DSH 桌面版就是打包版，
  // 上面那条「工具名对账」安全断言要靠它才能在真实安装形态上跑起来；没有离线夹具，
  // 就只能靠"本机今天能读"来证明，那既覆盖不到边界，也挡不住格式变更后的静默失效。
  'test-asar-read.mjs',
  // 三代阶段 0：关系信号（src/member-signals.js）的纯函数语义。**为什么必须有它**：
  // 这段逻辑将来要驱动"该不该主动找某个真实群友"，算错就等于骚扰真人。这里把
  // 「双向信号」的定义（引用我 / 我发言后 3 分钟内接话）、互斥计数、7 天窗口边界、
  // 分档门槛、以及"不改动传入 state"的纯函数性质全部钉死；并覆盖与 AI 自述印象的
  // 对照指标（集合重合 / 顺序 / 漏看 / 过度关注）——那正是阶段 0 的验收证据。
  'test-member-signals.mjs',
  // 三代阶段 1：关系分寸注入 + 主动机会硬闸门。**为什么必须有它**：阶段 1 是
  // 三代第一次真正改变机器人行为，而它的全部设计意图是**让 AI 少说、说得更准**。
  // 这组断言专门防"阶段 1 悄悄退化成更主动"：
  //   · 分档只给档位、**绝不给原始数字**（否则会说"你回我好快"这种监控感的话）；
  //   · 无成员信号时**不注入**（宁可少说也不编造"谁和你很熟"）；
  //   · 硬闸门落在桥接（提示词可被绕过）：单群每周 ≤3 次、24h 内找过的人不再主动；
  //   · 记账字段必须在 save/load 白名单两侧（漏一侧就重启静默失效）。
  'test-gen3-phase1.mjs',
  // 群聊上下文时间限制（过时消息）：超过 1 小时的消息不再回复，但仍可当上下文记忆。
  // 为什么必须有它：这条功能**删掉了消息**（从待回复队列里摘），一旦算错就是"群友说话
  // 它装没看见"。所以不只验"该摘的摘了"，还必须验"不该摘的没摘"（私聊/新消息/自己的消息）、
  // 以及"摘除不会卡住已读水位"——后者若成立会变成比过时更严重的静默丢消息。
  'test-stale-context.mjs',
  // 控制台侧的三代阶段 2 渲染契约（直接跑 console.html 里的真实函数源码 +
  // DOM 桩，不用无头浏览器——本机 Edge 的 --headless 会静默失效，等于零覆盖）：
  //   · 话题出处必须显示谁/原文/时间，出处被 recentLimit 裁掉时必须告警；
  //   · 老话题无锚点要如实标注，不得编造；
  //   · 关系分档只给档位不给数字，粘滞与窗口截断都要显式说明。
  'test-console-gen3.mjs',
  // qq-mode-console 的 settings 契约：0.2.0 删除了 ctx.settings.register()，
  // 命名空间改为由 loader entry id + 导出的 Config 推导。断言三点前提都在，
  // 并且那条已删除的 API 不会被照旧注释加回来。
  'test-qq-mode-plugin.mjs',
  // SnowLuma 上游健康（被误诊成「qq-bridge 注入失败」的那个失败形态）：
  //   · good 必须取自心跳 status.good / get_status —— 取自 get_login_info 会**静默失效**
  //     （SDK 不校验 data 载荷，good 会永远停在 null，整条权威信号变成死分支）；
  //   · 静默检测不得冒充 hook 检测（心跳是 SnowLuma 本地定时器无条件发的）；
  //   · 客户端库版本不得低于 bot_status 出现的版本。
  'test-snowluma-upstream-health.mjs',
];
let failed = 0;
// 子进程输出改走**文件 fd**，不用管道。
//
// 为什么不能继续用 stdio:'inherit'：那样套件只能看到子进程的**退出码**，于是
// 「脚本因环境限制把自己整段跳过、exit 0」和「脚本真的全绿」在下游无法区分 ——
// 而 test-preset-local-tools.mjs 里那条「守卫名单 vs DSH 真实工具名」的对账是
// **安全断言**（防拼错假名 ⇒ restrict 抛错被吞 ⇒ 限制静默失效）。在 Electron
// 打包版 DSH 上它必然跳过，于是「绿」会被当成「验过了」，实际零覆盖。
//
// 为什么不用 stdio:'pipe' 抓：DSH 沙箱（workspace-write / 只读）禁止带管道的
// spawn（EPERM），那会让整个套件在沙箱里跑不起来。文件 fd 两端都不受限（实测）。
const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-audit-'));
const skipped = [];
try {
  for (const test of tests) {
    console.log(`\nRunning ${test}`);
    const outPath = path.join(captureDir, `${test}.out`);
    const errPath = path.join(captureDir, `${test}.err`);
    const outFd = fs.openSync(outPath, 'w');
    const errFd = fs.openSync(errPath, 'w');
    let result;
    try {
      result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
        cwd: root, stdio: ['ignore', outFd, errFd], timeout: 60000,
        env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
      });
    } finally {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
    }
    // 原样透传子进程输出：打印顺序、stdout/stderr 归属都与过去的 'inherit' 一致。
    const stdout = fs.readFileSync(outPath, 'utf8');
    const stderr = fs.readFileSync(errPath, 'utf8');
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    const skipCount = (stdout + stderr).split('\n').filter((line) => line.includes('⏭')).length;
    if (skipCount > 0) skipped.push(`${test}(${skipCount})`);
    if (result.status !== 0 || result.error) {
      failed++;
      console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
    }
  }
} finally {
  fs.rmSync(captureDir, { recursive: true, force: true });
}
console.log(`\nAudit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
if (skipped.length > 0) {
  // 「跳过，不是通过」——套件保持绿色（这些断言在本机确实无法成立），
  // 但绝不让人把绿当成"都验过了"：把有未覆盖项的脚本点名列出。
  console.log(`⚠ ${skipped.length} 个脚本含跳过项（跳过 ≠ 通过）：${skipped.join('、')}`);
  console.log('   要让「有跳过」也导致非零退出码（例如放进 CI 门禁）：设 QQ_BRIDGE_AUDIT_STRICT_SKIPS=1（退出码 3）。');
}
const strictSkips = process.env.QQ_BRIDGE_AUDIT_STRICT_SKIPS === '1';
process.exitCode = failed ? 1 : (skipped.length > 0 && strictSkips ? 3 : 0);
