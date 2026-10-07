/**
 * 自检脚本：密码强度 / 每日活动解析 / 领取节流
 *
 * 用法: node scripts/selfcheck.js
 * 退出码 0 = 全部通过，1 = 有失败项
 *
 * passwordStrength.ts 是 TS，这里用 TypeScript 编译器 API（ts.transpileModule）
 * 现转 CJS 后 require，避免为了跑测试引入额外测试框架或打包器。
 * ⚠️ 不要改回 esbuild：vite 8 起不再传递依赖 esbuild，它不是本项目的直接依赖，
 *    靠 hoisting 拿到就会在某次 npm 升级后突然 MODULE_NOT_FOUND（0.13.16 踩过）。
 *    typescript 本来就在 devDependencies 里，是稳定的直接依赖。
 */
const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const { execFileSync } = require("child_process");

/** 把一个 TS 文件就地转成 CJS 并 require（只做类型擦除，不做类型检查） */
function requireTs(relPath) {
  const abs = path.join(ROOT, ...relPath.split("/"));
  const js = ts.transpileModule(fs.readFileSync(abs, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: abs,
  }).outputText;
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("exports", "require", "module", "__filename", "__dirname", js)(
    mod.exports,
    require,
    mod,
    abs,
    path.dirname(abs)
  );
  return mod.exports;
}

const ROOT = path.join(__dirname, "..");
const os = require("os");
let pass = 0;
let fail = 0;

/** 完整转义正则元字符（只转义点号是不够的，CodeQL js/incomplete-sanitization / js/regex-injection） */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 加载一个 TSX 渲染器并返回其导出。
 *
 * 与 requireTs 的区别有两处（缺一都跑不起来）：
 *   ① compilerOptions 必须开 `jsx: ReactJSX` —— 否则转译出来的代码里
 *      还留着 `_jsx(...)` 调用但没有 jsx-runtime 的引入信息；
 *   ② require 要能解析 `react` 与相对路径 —— 直接透传 require 会让
 *      模块顶层的 `import type` 之类在沙盒里找不到 react 而抛错。
 *
 * 用于「渲染器不能被畸形输入搞崩」这类需要真跑一遍的断言：
 * 光看源码判断不出 `renderNotes(null)` 会不会抛。
 */
function requireTsxSafe(root, relPath) {
  const abs = path.join(root, ...relPath.split("/"));
  const js = ts.transpileModule(fs.readFileSync(abs, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: abs,
  }).outputText;
  const mod = { exports: {} };
  const nodeModules = path.join(root, "node_modules");
  const req = (id) => {
    if (id.startsWith(".")) return require(id);
    return require(path.join(nodeModules, id));
  };
  // eslint-disable-next-line no-new-func
  new Function("exports", "require", "module", "__filename", "__dirname", js)(
    mod.exports,
    req,
    mod,
    abs,
    path.dirname(abs)
  );
  return mod.exports;
}

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${ok ? "" : ` — 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`);
}

function checkTrue(name, cond, extra = "") {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "  ✅" : "  ❌"} ${name}${cond ? "" : ` — ${extra}`}`);
}

/* ============ 1. 密码强度 ============ */
console.log("\n【1】密码强度 evaluatePassword");
const { evaluatePassword } = requireTs("src-renderer/src/utils/passwordStrength.ts");

// [密码, 期望 pass, 说明]
const pwCases = [
  ["", false, "空密码"],
  ["abc", false, "太短"],
  ["abcdefgh", false, "8位但缺大写/数字/特殊"],
  ["Abcdefgh", false, "缺数字与特殊字符"],
  ["Abcdefg1", false, "缺特殊字符"],
  ["Abcdef1!", true, "四类齐全（8位）→ 通过"],
  ["Zfnb5758@", true, "含大小写+数字+符号 → 通过"],
  ["12345678", false, "纯连续数字 → 不通过"],
  ["password", false, "常见弱密码 → 不通过"],
];
for (const [pw, expect, desc] of pwCases) {
  check(`${desc} "${pw}"`, evaluatePassword(pw).pass, expect);
}

// 复杂度不达标时强度必须被压到第 3 段以下
checkTrue("复杂度不足时强度 < 3 段", evaluatePassword("Abcdefgh1").level < 3, `实际 level=${evaluatePassword("Abcdefgh1").level}`);
checkTrue("长度 <8 时强度 < 3 段", evaluatePassword("Aa1!").level < 3, `实际 level=${evaluatePassword("Aa1!").level}`);

// 弱模式必须触发提醒，但不能阻止提交
checkTrue("生日会触发提醒", evaluatePassword("19990101Abc!").weakHints.length > 0);
check("生日密码仍可通过（只提醒不禁止）", evaluatePassword("19990101Abc!").pass, true);
checkTrue("连续字符会触发提醒", evaluatePassword("Abcd1234!").weakHints.length > 0);
checkTrue("重复字符会触发提醒", evaluatePassword("Aa1!1111x").weakHints.length > 0);

/* ============ 2. 每日活动解析 ============ */
console.log("\n【2】每日活动 dailySetItems 解析");
// 数据源：selfcheck-fixtures/home.json（净化样本，结构来自真实抓取，无凭据）
// 由 scripts/make-fixtures.js 生成；抓取原始 HTML 已因含登录态删除。
const fixture = path.join(ROOT, "selfcheck-fixtures", "home.json");
if (fs.existsSync(fixture)) {
  const items = JSON.parse(fs.readFileSync(fixture, "utf8")).dailySetItems;
  checkTrue("能解析出 dailySetItems", Array.isArray(items) && items.length > 0);
  if (Array.isArray(items) && items.length) {
    checkTrue("每条都带 hash（交卷必需）", items.every((i) => !!i.hash));
    checkTrue("每条都带 destination（访问链接必需）", items.every((i) => !!i.destination));
    checkTrue("destination 是 bing 搜索奖励链接", items[0].destination.includes("bing.com/search"));
    checkTrue("destination 带追踪参数（BTEPOKey/BTDSUOID/rnoreward）", /BTEPOKey|BTDSUOID|rnoreward=1/.test(items[0].destination) || /BTEPOKey|BTDSUOID|rnoreward=1/.test(items[1].destination));
    console.log(`     样本: ${items.length} 条, 首条 offerId=${items[0].offerId}, date=${items[0].date}, points=${items[0].points}`);
  }
} else {
  console.log("  ⚠️ 未找到 selfcheck-fixtures/home.json，跳过（先跑 node scripts/make-fixtures.js）");
}

/* ============ 3. 每周领取节流 ============ */
console.log("\n【3】每周领取节流逻辑");
const daysBetween = (from, to) => {
  const p = (n) => {
    const s = String(n);
    return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
  };
  return Math.floor((p(to) - p(from)) / 86400000);
};
check("同一天应跳过", daysBetween(20260915, 20260915) < 7, true);
check("隔 3 天应跳过", daysBetween(20260912, 20260915) < 7, true);
check("隔 7 天应执行", daysBetween(20260908, 20260915) >= 7, true);
check("跨月 7 天应执行", daysBetween(20260831, 20260907) >= 7, true);

/* ============ 4. 日志净化与按天历史 ============ */
console.log("\n【4】日志净化与按天历史");
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ms-rewards-log-selfcheck-"));
process.env.MS_REWARDS_STORAGE_DIR = path.join(testRoot, "storage");
const logger = require(path.join(ROOT, "src", "logger.js"));
check("ANSI SGR 控制码被清除", logger.sanitizeText("\x1b[2m等待\x1b[22m"), "等待");
check("不可见控制字符被清除且保留换行", logger.sanitizeText("甲\x07乙\n丙"), "甲乙\n丙");
logger.setContext("test-account", "测试账户");
logger.info("\x1b[2m历史日志\x1b[22m");
logger.clearContext();
const logDays = logger.listAccountLogDays("test-account", 7);
checkTrue("按账号生成当天历史日志", logDays.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(logDays[0]));
const history = logger.getAccountHistory("test-account", logDays[0], 7);
checkTrue("历史日志可按日期读取", history.length === 1 && history[0].msg === "历史日志");
logger.clearAccountHistory("test-account");
check("清除账号历史日志后日期列表为空", logger.listAccountLogDays("test-account", 7), []);
const oldDir = path.join(testRoot, "logs", "accounts", "test-account");
fs.mkdirSync(oldDir, { recursive: true });
fs.writeFileSync(path.join(oldDir, "2020-01-01.jsonl"), "{}\n", "utf8");
logger.cleanupHistory(7);
checkTrue("超过保留天数的历史日志会自动删除", !fs.existsSync(path.join(oldDir, "2020-01-01.jsonl")));

/* ============ 5. 单账号清除数据 ============ */
console.log("\n【5】单账号清除数据");
const accounts = require(path.join(ROOT, "src", "account.js"));
const meta = accounts.create("清除测试账号");
const ctx = accounts.context(meta.id);
ctx.config.set({ useGlobal: false, search: { span: 99 } });
ctx.state.setCookies([{ name: "TEST", value: "secret", domain: ".bing.com" }]);
ctx.state.get().lastBalance = 999;
ctx.state.save();
logger.setContext(meta.id, meta.name);
logger.info("待清除历史");
logger.clearContext();
logger.clearAccountHistory(meta.id);
check("清除数据操作成功", accounts.clearData(meta.id), true);
const after = accounts.describe(meta.id);
checkTrue("清除后账号元信息仍保留", !!after && after.id === meta.id && after.name === meta.name);
checkTrue("清除后 Cookie/令牌与积分状态归零", !!after && !after.state.loggedIn && after.state.cookiesCount === 0 && after.state.lastBalance === 0);
checkTrue("清除后恢复遵循全局设置", !!after && after.useGlobal === true);
accounts.remove(meta.id);
fs.rmSync(testRoot, { recursive: true, force: true });

/* ============ 6. 领取弹窗确认逻辑静态守卫 ============ */
console.log("\n【6】领取弹窗确认逻辑");
const tasksSource = fs.readFileSync(path.join(ROOT, "src", "tasks.js"), "utf8");
checkTrue("领取入口改用 DOM click 避免遮罩拦截", tasksSource.includes("await el.evaluate((n) => n.click())"));
checkTrue("领取后会处理可见确认对话框", tasksSource.includes("[role='dialog']") && tasksSource.includes("已确认领取对话框"));

/* ============ 7. 向导升级兼容静态守卫 ============ */
console.log("\n【7】向导升级兼容（覆盖安装老用户）");
const setupSource = fs.readFileSync(path.join(ROOT, "src", "setup.js"), "utf8");
checkTrue("setup:get 检测到 vault.json 自动补写向导完成状态", setupSource.includes("migrateUpgradedVaultUser") && setupSource.includes('sp.resolve("vault.json")'));
const wizardSource = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "views", "SetupWizard.tsx"), "utf8");
checkTrue("向导加密页对已配置保险库渲染「已就绪」分支而非创建表单", wizardSource.includes("if (vaultCfg)") && wizardSource.includes("加密保险库已就绪"));

/* ============ 8. 忘记密码自救：重置密码 + 清空账号数据 ============ */
console.log("\n【8】忘记密码自救（重置密码 / 清空账号数据）");
const wipeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ms-rewards-wipe-selfcheck-"));
// 本段会把存储目录整体改到临时根上（避免清空真实数据）。改之前先备份原值，
// 结束后必须还原 —— 详见段末的说明。
const prevStorageDir = process.env.MS_REWARDS_STORAGE_DIR;
process.env.MS_REWARDS_STORAGE_DIR = path.join(wipeRoot, "storage");

const appearance = require(path.join(ROOT, "src", "appearance.js"));
const launch = require(path.join(ROOT, "src", "launch.js"));
const setupMod = require(path.join(ROOT, "src", "setup.js"));
const vault = require(path.join(ROOT, "src", "vault"));
const wipe = require(path.join(ROOT, "src", "wipe.js"));

// 造两个账号（含登录态与配置），并留下个性化 / 启动 / 向导设置
const w1 = accounts.create("待清空甲");
const w2 = accounts.create("待清空乙");
const c1 = accounts.context(w1.id);
c1.state.setCookies([{ name: "SID", value: "secret", domain: ".bing.com" }]);
c1.state.get().lastBalance = 1234;
c1.state.save();
appearance.set({ bgBlur: 22, bgUnsplashKey: "test-unsplash-key" });
launch.set({ autoLaunch: true });
setupMod.set({ done: true, agreed: true });
const vaultReset = vault.setup("TestPass1!@", "测试提示");

check("清空前账号数为 2", accounts.list().length, 2);
checkTrue("清空前保险库已配置", vault.isConfigured());

// 先用真实恢复密钥验证「重置密码」这条路径（主密钥不变，旧密钥仍有效）
const vsRk = vaultReset.recoveryKey;
vault.lock();
checkTrue(
  "错误的恢复密钥无法重置密码",
  vault.resetPasswordWithRecovery("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "NewPass2!@").ok === false
);
checkTrue("用恢复密钥重置密码成功", vault.resetPasswordWithRecovery(vsRk, "NewPass2!@", "新提示").ok === true);
vault.lock();
checkTrue("重置后可用新密码解锁", vault.unlock("NewPass2!@").ok === true);
checkTrue("重置后旧密码已失效", vault.unlock("TestPass1!@").ok === false);

const wr = wipe.wipeAccountData();
checkTrue("清空操作返回成功", wr.ok === true && wr.accounts === 2);
check("清空后账号列表为空", accounts.list().length, 0);
checkTrue("清空后加密保险库已移除", !vault.isConfigured() && !fs.existsSync(vault.VAULT_FILE));
checkTrue("账号目录已整体删除", !fs.existsSync(path.join(wipeRoot, "storage", "accounts")));
check("清空后个性化设置保留（模糊值）", appearance.get().bgBlur, 22);
check("清空后壁纸 API 密钥被清除", appearance.get().bgUnsplashKey, "");
check("清空后启动设置保留", launch.get().autoLaunch, true);
// 账号与保险库都被删除 → 向导状态必须重置，下次启动重新引导（含重新建库）
checkTrue("清空返回标记向导已重置", wr.wizardReset === true);
check("清空后向导状态被重置（重新引导）", setupMod.get().done, false);
// 先还原存储目录，再删临时根。
// 踩过的坑：本段把 MS_REWARDS_STORAGE_DIR 改到了 wipeRoot，而 appearance/launch/
// setup 等模块在 require 时就把文件路径绑死在它上面（storage-path 每次读 env，
// 但这些模块自己缓存了拼接结果）。若不还原就删目录，后续任何一次存储写入都会
// 指向一个已删除的路径 —— 曾让【15】写 appearance.json 时直接 ENOENT 崩掉整个自检。
process.env.MS_REWARDS_STORAGE_DIR = prevStorageDir;
fs.rmSync(wipeRoot, { recursive: true, force: true });

/* ============ 9. 自救面板静态守卫 ============ */
console.log("\n【9】自救面板静态守卫");
const rescueSource = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "components", "VaultRescue.tsx"),
  "utf8"
);
checkTrue("支持上传密钥文件并解析出密钥", rescueSource.includes("extractRecoveryKey") && rescueSource.includes("type=\"file\""));
checkTrue("重置密码调用专用接口（无需原密码）", rescueSource.includes("vaultResetPasswordWithRecovery"));
checkTrue("清空数据需经红色确认弹窗", rescueSource.includes("确定清空!!!(不可恢复)") && rescueSource.includes("wz-modal-mask"));
const lockSource = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "views", "VaultLock.tsx"),
  "utf8"
);
checkTrue("锁屏页也提供自救入口", lockSource.includes("<VaultRescue"));
checkTrue(
  "锁屏页用恢复密钥解锁时也能上传密钥文件",
  lockSource.includes("extractRecoveryKey") && lockSource.includes("type=\"file\"") && lockSource.includes("上传密钥文件")
);
const wipeSource = fs.readFileSync(path.join(ROOT, "src", "wipe.js"), "utf8");
checkTrue(
  "清空数据会重置向导状态以重新引导",
  wipeSource.includes("setup.set(") && wipeSource.includes("wizardReset")
);
const mainSource = fs.readFileSync(path.join(ROOT, "src", "electron-main.js"), "utf8");
checkTrue("主进程暴露重置密码与清空数据两个通道", mainSource.includes("\"vault:resetPasswordWithRecovery\"") && mainSource.includes("\"app:wipeAccountData\""));

/* ============ 10. 设置页布局守卫（窗口缩放） ============ */
console.log("\n【10】设置页布局守卫（窗口缩放）");
const cssSource = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "styles", "global.css"),
  "utf8"
);
checkTrue(
  "积分目标行改为可折行布局（不再固定 4 列却塞 5 个元素）",
  /\.goal-row\s*\{[^}]*flex-wrap:\s*wrap/.test(cssSource)
);
checkTrue(
  "网格内的开关紧跟标签（不随列宽飘到列右缘）",
  /\.form-grid\s*>\s*\.field-row\s*\{[^}]*justify-content:\s*flex-start/.test(cssSource)
);
checkTrue(
  "网格项允许收缩，1fr 列真正等分",
  /\.form-grid\s*>\s*\*\s*\{[^}]*min-width:\s*0/.test(cssSource)
);

/* ============ 11. 登录守卫（未登录账户不自动运行、不空跑） ============ */
console.log("\n【11】登录守卫（未登录账户不空跑）");
const runnerSource = fs.readFileSync(path.join(ROOT, "src", "runner.js"), "utf8");
checkTrue(
  "Cookie 同步后明确未登录即收工，不再硬跑全部任务",
  /if \(loggedIn === false\)/.test(runnerSource) && /跳过本轮全部任务/.test(runnerSource)
);
checkTrue(
  "未登录账户不纳入自动调度（刚添加的账号不会立刻空跑一轮）",
  /尚未登录，跳过自动运行/.test(runnerSource)
);
checkTrue(
  "未登录时不写回误导性的运行结果",
  /lastResult = "未登录：请先在账户里点「授权登录」"/.test(runnerSource)
);

// 运行时断言：临时 storage 里建一个从未登录的账户
const guardDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-rewards-guard-"));
process.env.MS_REWARDS_STORAGE_DIR = guardDir;
const guardAccounts = require(path.join(ROOT, "src", "account.js"));
const guardRunner = require(path.join(ROOT, "src", "runner.js"));
const gAcc = guardAccounts.create("守卫自检账户");
const gCtx = guardAccounts.context(gAcc.id);
const g1 = guardRunner.shouldRunNow(gCtx);
checkTrue("刚创建的未登录账户：自动调度跳过", g1.run === false, `实际 ${JSON.stringify(g1)}`);
checkTrue("未登录账户没有下次运行时间", guardRunner.nextRunTime(gCtx) === null);
gCtx.state.get().refreshToken = "selfcheck-fake-token";
gCtx.state.save();
// ⚠️ 必须传固定时刻：0.13.15 起有「每天开始时间」（默认 09:00）门禁，
// 凌晨 00:00–09:00 跑自检时 shouldRunNow 会正确地返回「未到每天开始时刻」，
// 用真实 now 断言会让这条守卫在夜里假红。取 12:00 落在默认窗口内，任何时刻跑都成立。
const gNoon = (() => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d;
})();
const g2 = guardRunner.shouldRunNow(gCtx, gNoon);
checkTrue("授权后（有 refreshToken）恢复自动调度（固定 12:00 断言，不受运行时刻影响）", g2.run === true, `实际 ${JSON.stringify(g2)}`);

/* ============ 12. 版本号一致性守卫 ============ */
console.log("\n【12】版本号一致性（package.json / 关于页 / README / CHANGELOG）");
// 发版时最容易漏改的就是这几处；任一处漂移都会被这里拦下。
const pkgVersion = require(path.join(ROOT, "package.json")).version;
const aboutSrc = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "views", "About.tsx"),
  "utf8"
);
const aboutVersion = (aboutSrc.match(/APP_VERSION\s*=\s*"([^"]+)"/) || [])[1];
checkTrue(
  "关于页 APP_VERSION 与 package.json 一致",
  aboutVersion === pkgVersion,
  `关于页 ${aboutVersion}，package.json ${pkgVersion}`
);

const readmeSrc = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
checkTrue(
  "README 顶部版本横幅与 package.json 一致",
  readmeSrc.includes(`当前版本：V${pkgVersion}`),
  `README 中未找到「当前版本：V${pkgVersion}」`
);

const changelogSrc = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
checkTrue(
  "CHANGELOG 含当前版本章节",
  new RegExp(`^## ${escapeRegExp(pkgVersion)}\\s*$`, "m").test(changelogSrc),
  `CHANGELOG 中未找到「## ${pkgVersion}」`
);

/* ============ 13. 单次执行数量规划 + 随机启动延迟 ============ */
console.log("\n【13】单次执行数量（limits）与随机启动延迟");
const { resolveTaskCount, normalizeLimits } = require(path.join(ROOT, "src", "task-limit.js"));
const runnerModule = require(path.join(ROOT, "src", "runner.js"));

// 固定随机源：实现里先抽幅度（2–4），再抽方向（rng<0.5 为加，否则为减）
const magR = (m) => (m === 2 ? 0 : m === 3 ? 0.5 : 0.99);
const seqRng = (...vals) => {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)];
};
const plus = (m) => seqRng(magR(m), 0.1);
const minus = (m) => seqRng(magR(m), 0.9);
const plan = (o) => resolveTaskCount(o);

// —— 需求原例 ——
const lim1 = plan({ base: 6, total: 10, random: true, rng: plus(4) });
// 0.13.11 起：随机允许等于/超过任务总数（多出的次数在任务侧被满额短路），不再取消随机
check("例①总10/设6/随机+4：允许上探到 10（不再取消随机）", lim1.count, 10);
check("例①：随机生效", lim1.applied, true);
const lim2 = plan({ base: 4, total: 10, random: true, rng: minus(4) });
check("例②总10/设4/随机-4：会变成 0 个 → 取消随机，仍执行 4", lim2.count, 4);
check("例②：随机未生效", lim2.applied, false);
check("例③总10/设3/随机-4：减不动 → 取消随机，仍执行 3", plan({ base: 3, total: 10, random: true, rng: minus(4) }).count, 3);

// —— 正常波动 ——
check("总10/设6/随机-4 → 2", plan({ base: 6, total: 10, random: true, rng: minus(4) }).count, 2);
check("总10/设6/随机+2 → 8", plan({ base: 6, total: 10, random: true, rng: plus(2) }).count, 8);
check("总10/设6/随机-2 → 4", plan({ base: 6, total: 10, random: true, rng: minus(2) }).count, 4);
check("总10/设4/随机+3 → 7", plan({ base: 4, total: 10, random: true, rng: plus(3) }).count, 7);
check(
  "随机生效时 applied=true 且 delta 带符号",
  [plan({ base: 6, total: 10, random: true, rng: plus(2) }).applied, plan({ base: 6, total: 10, random: true, rng: plus(2) }).delta],
  [true, 2]
);

// —— 开关关闭 / 不限制 ——
check("随机关闭时保持设定值", plan({ base: 6, total: 10, random: false }).count, 6);
check("随机关闭时 applied=false", plan({ base: 6, total: 10, random: false }).applied, false);
const cUn = plan({ base: 0, total: 10, random: true, rng: plus(4) });
check("设定 0 = 不限制，本轮全做", [cUn.count, cUn.unlimited], [10, true]);

// —— 保护边界 ——
check("设定值大于任务总数 → 截到总数", plan({ base: 99, total: 10, random: false }).count, 10);
check("没有可执行任务 → 0", plan({ base: 6, total: 0, random: true, rng: plus(4) }).count, 0);
check("只有 1 个任务且设定 1 → 随机制造不出 0 个", plan({ base: 1, total: 1, random: true, rng: minus(2) }).count, 1);
check(
  "缺字段 / 负数 / NaN 等脏数据不炸",
  [plan({}).count, plan({ base: -5, total: 3 }).count, plan({ base: NaN, total: 3 }).count],
  [0, 3, 3]
);

// —— 穷举：任意组合下数量恒在 [0,total+4]；随机生效时 >=1 且 <= total+4 ——
// 0.13.11 起随机允许上探到 total + MAX_DELTA（多出的在任务侧被满额短路），
// 所以上限从 total 放宽到 total + MAX_DELTA。
let bad = 0;
let appliedCount = 0;
for (let total = 0; total <= 12; total++) {
  for (let base = 0; base <= 14; base++) {
    for (const r1 of [0, 0.1, 0.49, 0.5, 0.51, 0.99]) {
      for (const r2 of [0, 0.1, 0.49, 0.5, 0.51, 0.99]) {
        const p = resolveTaskCount({ base, total, random: true, rng: seqRng(r1, r2) });
        if (!Number.isInteger(p.count) || p.count < 0 || p.count > total + 4) bad++;
        if (p.applied) {
          appliedCount++;
          if (p.count < 1 || p.count > total + 4) bad++;
        }
      }
    }
  }
}
check("穷举组合：数量恒在 [0,total+4]，随机生效时恒在 1..total+4", bad, 0);
checkTrue("穷举中确有随机生效的样本（断言非空转）", appliedCount > 200, `applied 样本仅 ${appliedCount} 个`);

// —— 归一化 ——
check(
  "limits 归一化：随机只认 true，篇数取整、负数回 0",
  normalizeLimits({ random: "yes", read: 6.9, promos: -3 }),
  { random: false, read: 6, promos: 0, search: 0, allowExceed: false }
);
check("limits 归一化：空值 → 全部不限制", normalizeLimits(null), { random: false, read: 0, promos: 0, search: 0, allowExceed: false });
// allowExceed 只认严格 true：老配置里飘成 "true" / 1 也不许放行（否则等于默认开启超量执行）
check("limits 归一化：allowExceed 只认 true", [
  normalizeLimits({ allowExceed: true }).allowExceed,
  normalizeLimits({ allowExceed: "true" }).allowExceed,
  normalizeLimits({ allowExceed: 1 }).allowExceed,
], [true, false, false]);

// —— 静态守卫：任务侧接入 ——
const tasksSrc2 = fs.readFileSync(path.join(ROOT, "src", "tasks.js"), "utf8");
checkTrue("阅读任务接入单次数量限制", /base:\s*(ctx\.force \? 0 : limits\.read)/.test(tasksSrc2));
checkTrue("活动任务接入单次数量限制", /base:\s*(ctx\.force \? 0 : limits\.promos)/.test(tasksSrc2));
checkTrue("阅读未读完不标记完成", /if \(toRead >= readsNeeded\)/.test(tasksSrc2));
checkTrue("活动未做完不标记完成", /if \(runCount >= totalNewTasks\)/.test(tasksSrc2));

// 曾经踩过的坑：加了 limits 引用却漏了 `const cfg = ctx.config.get()`，
// 类型检查看不出来，只有真跑到阅读任务时才 ReferenceError。这里静态拦住。
const fnBody = (src, name) => {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) return "";
  const next = src.indexOf("\nasync function ", start + 10);
  return src.slice(start, next < 0 ? undefined : next);
};
for (const fn of ["taskRead", "taskPromos"]) {
  const body = fnBody(tasksSrc2, fn);
  checkTrue(
    `${fn} 先取有效配置再读 limits（防止 cfg 未定义）`,
    body.includes("const cfg = ctx.config.get()") && body.indexOf("const cfg") < body.indexOf("cfg.limits"),
    "函数体内缺少 cfg 定义或顺序不对"
  );
}

// —— 静态守卫 + 行为断言：随机启动延迟 ——
checkTrue("定时运行为每个账户抽取随机启动延迟", /pickStartDelay\(ctx\.config\.get\(\)\)/.test(runnerSource));
checkTrue("延迟期间可被「停止任务」打断", /await cancel\.sleep\(delay\.ms\)/.test(runnerSource));
const dOn = runnerModule.pickStartDelay({ schedule: { randomDelay: true } });
checkTrue("默认随机延迟落在 20 秒 ~ 5 分钟", dOn.seconds >= 20 && dOn.seconds <= 300, `实际 ${dOn.seconds} 秒`);
check("延迟毫秒与秒一致", dOn.ms, dOn.seconds * 1000);
const dOff = runnerModule.pickStartDelay({ schedule: { randomDelay: false } });
check("关闭随机延迟后为 0", [dOff.seconds, dOff.ms], [0, 0]);
check("自定义区间生效（固定 60 秒）", runnerModule.pickStartDelay({ schedule: { randomDelay: true, randomDelayMin: 60, randomDelayMax: 60 } }).seconds, 60);
const dSwapped = runnerModule.pickStartDelay({ schedule: { randomDelay: true, randomDelayMin: 500, randomDelayMax: 10 } });
checkTrue("区间写反时仍取到合法值", dSwapped.seconds >= 10 && dSwapped.seconds <= 500, `实际 ${dSwapped.seconds}`);
const scOld = runnerModule.normalizeSchedule({});
check("老配置归一化补上 20/300 且默认开启", [scOld.randomDelay, scOld.randomDelayMin, scOld.randomDelayMax], [true, 20, 300]);

// —— 默认值三处同步（config / global-config / 渲染层 mock） ——
const cfgDefaults = require(path.join(ROOT, "src", "config.js")).DEFAULTS;
const globalDefaults = require(path.join(ROOT, "src", "global-config.js")).GLOBAL_DEFAULTS;
const mockSrc = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "api", "mock.ts"), "utf8");
check("config.DEFAULTS 含 limits", cfgDefaults.limits, { random: false, read: 6, promos: 0, search: 6, allowExceed: false });
check("global-config 默认值同步含 limits", globalDefaults.limits, { random: false, read: 6, promos: 0, search: 6, allowExceed: false });
checkTrue("渲染层 mock 默认值同步含 limits（含 search / allowExceed）", /limits: \{ random: false, read: 6, promos: 0, search: 6, allowExceed: false \}/.test(mockSrc));
// 类型层也要跟上：老配置反序列化后缺字段，渲染层会按 undefined 渲染成「关闭」，
// 主进程却按 false 截断 —— 类型定义漏写会让两边理解不一致。
checkTrue(
  "类型定义 limits 含 allowExceed（渲染层与主进程对同一字段的理解必须一致）",
  /allowExceed: boolean;/.test(fs.readFileSync(path.join(ROOT, "src-renderer", "src", "types", "index.ts"), "utf8"))
);
// 0.9.4 白屏根因：global-config 的 GLOBAL_DEFAULTS 缺 goals，旧配置文件只有
// { enable: true } 无 items，全局设置页 value.goals.items 抛 TypeError。必须与
// config.DEFAULTS.goals 对齐，带 items: [] 兜底。
check("global-config 默认值含 goals.items 兜底", globalDefaults.goals, { enable: true, items: [] });
for (const [name, d] of [["config", cfgDefaults], ["global-config", globalDefaults]]) {
  check(`${name} 随机延迟默认 开启/20/300`, [d.schedule.randomDelay, d.schedule.randomDelayMin, d.schedule.randomDelayMax], [true, 20, 300]);
}
checkTrue("渲染层 mock 随机延迟默认同步", /randomDelay: true,\s*\n\s*randomDelayMin: 20,\s*\n\s*randomDelayMax: 300,/.test(mockSrc));

// —— 静态守卫：设置页 ——
const formSrc = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "components", "SettingsForm.tsx"), "utf8");
checkTrue("设置页有阅读/积分活动单次数量输入", /阅读文章每次篇数/.test(formSrc) && /积分活动每次个数/.test(formSrc));
checkTrue("设置页有随机波动开关", /limits: \{ random: v \}/.test(formSrc));
checkTrue("设置页有随机延迟开关与区间", /randomDelay: v/.test(formSrc) && /randomDelayMin/.test(formSrc) && /randomDelayMax/.test(formSrc));
// 0.9.4 白屏根因（渲染层防御）：goals 只用 ?? 兜底，遇到 { enable: true } 缺 items 时
// goals.items.length 抛错。必须逐字段兜底，用 Array.isArray 判 items。
checkTrue("设置页 goals.items 用 Array.isArray 兜底", /Array\.isArray\(value\.goals\?\.items\)/.test(formSrc));

console.log("\n【14】每日活动 / 定期收取积分开关 与 IP 多服务商");
const ipLookup = require(path.join(ROOT, "src", "ip-lookup.js"));
const { createState } = require(path.join(ROOT, "src", "state.js"));
const rewardsSrc = fs.readFileSync(path.join(ROOT, "src", "rewards.js"), "utf8");
const stateSrc = fs.readFileSync(path.join(ROOT, "src", "state.js"), "utf8");
const typesSrc = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "types", "index.ts"), "utf8");

// —— 新开关默认值：config / global-config / mock 三处同步 ——
check("config：每日活动默认启用", cfgDefaults.tasks.daily, true);
check("config：定期收取积分默认关闭", cfgDefaults.tasks.claim, false);
check("config：IP 服务默认 bing", cfgDefaults.region.ipProvider, "bing");
check("global-config：每日活动默认启用", globalDefaults.tasks.daily, true);
check("global-config：定期收取积分默认关闭", globalDefaults.tasks.claim, false);
check("global-config：IP 服务默认 bing", globalDefaults.region.ipProvider, "bing");
checkTrue(
  "渲染层 mock 新开关默认同步（daily:true / claim:false / ipProvider:bing）",
  /tasks: \{ sign: true, read: true, daily: true, promos: true, claim: false, search: true \}/.test(mockSrc) &&
    /region: \{ lock: true, ipProvider: "bing" \}/.test(mockSrc)
);

// —— IP 服务纯解析：境内 / 境外 / 无法判定 ——
const pcCn = ipLookup.parsePconline('{"ip":"49.81.64.227","proCode":"320000","city":"徐州市","addr":"江苏徐州 电信","err":""}');
check("太平洋境内 → mainland=true", [pcCn.mainland, pcCn.countryCode], [true, "CN"]);
const pcUs = ipLookup.parsePconline('{"ip":"8.8.8.8","proCode":"999999","addr":" 美国","err":"noprovince"}');
check("太平洋境外(proCode 999999) → mainland=false", pcUs.mainland, false);
const sbCn = ipLookup.parseIpsb('{"ip":"1.2.3.4","country_code":"CN","organization":"China Telecom"}');
check("ip.sb 境内(CN)", [sbCn.mainland, sbCn.countryCode, sbCn.source], [true, "CN", "ipsb"]);
const sbUs = ipLookup.parseIpsb('{"ip":"1.2.3.4","country_code":"US"}');
check("ip.sb 境外(US) → mainland=false", [sbUs.mainland, sbUs.countryCode], [false, "US"]);
const ifUs = ipLookup.parseIpinfo('{"ip":"1.2.3.4","country":"US","org":"x"}');
check("ipinfo 境外(US)", ifUs.mainland, false);
const iaCn = ipLookup.parseIpapi('{"status":"success","countryCode":"CN","query":"1.2.3.4"}');
check("ip-api 境内(CN)", [iaCn.mainland, iaCn.ip], [true, "1.2.3.4"]);
let iaThrew = false;
try {
  ipLookup.parseIpapi('{"status":"fail","message":"private range"}');
} catch {
  iaThrew = true;
}
checkTrue("ip-api fail 状态抛错（交由上层降级）", iaThrew);
const sbUnknown = ipLookup.parseIpsb('{"ip":"1.2.3.4","country_code":""}');
check("国家码缺失 → mainland=null（不武断判定）", sbUnknown.mainland, null);

// —— auto 降级顺序：ip.sb 优先 ——
check("auto 顺序为 ipsb→pconline→ipinfo→ipapi", ipLookup.AUTO_ORDER, ["ipsb", "pconline", "ipinfo", "ipapi"]);
checkTrue("服务商列表包含 4 家第三方 + Bing", ipLookup.PROVIDERS.map((p) => p.id).join(","), "");
for (const id of ["ipsb", "pconline", "ipinfo", "ipapi", "bing"]) {
  checkTrue(`IP 服务商列表含 ${id}`, ipLookup.PROVIDERS.some((p) => p.id === id));
}

// —— evaluateDayDone：纳入 daily，但绝不纳入 claim（每周一次，否则永远无法收工） ——
const stateTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "msr-daydone-"));
const st = createState(stateTmpDir);
const allTasks = { sign: true, read: true, daily: true, promos: true, claim: true, search: true };
let ev0 = st.evaluateDayDone({ tasks: allTasks });
check("全新状态：5 个每日任务都未完成", ev0.pending.length, 5);
checkTrue("pending 含「每日活动」", ev0.pending.includes("每日活动"), ev0.pending.join(","));
checkTrue("claim 开启也不在 pending（不计入今日完成）", !ev0.pending.some((p) => p.includes("收取") || p.includes("领取")));
const dn = st.getDateNum();
for (const k of ["sign", "read", "daily", "promos", "search"]) st.setTaskDone(k, dn);
const ev1 = st.evaluateDayDone({ tasks: allTasks });
check("5 个每日任务全标完成（claim 不影响）→ done", ev1.done, true);
// 只关 daily：不启用的任务不参与判定
const ev2 = st.evaluateDayDone({ tasks: { sign: true, read: true, daily: false, promos: true, claim: false, search: true } });
check("关闭每日活动后不参与今日完成判定", ev2.done, true);

// —— 静态守卫：主进程接线 ——
// ⚠️ tasks.js 的 module.exports 是多行格式（0.9.4.16 起导出 reportActivityFallback 等，
// 单行正则会误判），这里按「同一行还是有 next-line export」两种写法兼容。
checkTrue(
  "tasks.js 导出 taskDaily",
  /taskSign, taskRead, taskDaily, taskPromos/.test(tasksSource) ||
    (/^\s*taskDaily,$/m.test(tasksSource) && /module\.exports = \{[\s\S]*?taskDaily/.test(tasksSource))
);
checkTrue("taskDaily 受 tasks.daily 开关守卫", /if \(!cfg\.tasks\.daily/.test(tasksSource));
checkTrue("taskDaily 用独立 daily 完成标记", /setTaskDone\("daily"/.test(tasksSource));
checkTrue("taskPromos 只处理 earn 页（不再抓 dashboard dailySet）",
  /async function taskPromos[\s\S]*?rewards\.bing\.com\/earn/.test(tasksSource) &&
  !/async function taskPromos[\s\S]*?dailySetItems/.test(tasksSource));
checkTrue("taskPromos 仍受 tasks.promos 守卫", /if \(!cfg\.tasks\.promos/.test(tasksSource));
checkTrue("定期收取积分受 tasks.claim 开关守卫", /if \(!ctx\.config\.get\(\)\.tasks\.claim\)/.test(tasksSource));
checkTrue("runner 按开关调用 taskDaily", /cfg\.tasks\.daily \? await tasks\.taskDaily\(ctx\)/.test(runnerSource));
checkTrue("runner 按开关调用 taskClaimRewards", /cfg\.tasks\.claim \? await tasks\.taskClaimRewards\(ctx\)/.test(runnerSource));
checkTrue("runner 本地合计纳入 dailyPoint", /readPoint \+ dailyPoint \+ promosPoint/.test(runnerSource));
checkTrue("rewards 区域检查接入 ip-lookup", /require\("\.\/ip-lookup"\)/.test(rewardsSrc) && /ipLookup\.lookupCountry\(ctx, provider\)/.test(rewardsSrc));
checkTrue("rewards 第三方不可用时回落 Bing", /async function bingRegionCheck/.test(rewardsSrc));
checkTrue("state 默认 tasksDone 含 daily", /tasksDone: \{ sign: 0, read: 0, daily: 0, promos: 0, search: 0 \}/.test(stateSrc));
checkTrue("state 每日累计含 dailyPoint 且跨天清零", /dailyPoint: 0,/.test(stateSrc));

// —— 静态守卫：渲染层 ——
checkTrue("设置页有「每日活动」开关", /key: "daily", label: "每日活动"/.test(formSrc));

// —— 0.14.6 新增守卫所需的源码（提前读取：下面同名变量在 1200+/4300+ 行才声明，
//    在此处直接用会 TDZ —— ReferenceError: Cannot access before initialization）——
const fpSrc2 = fs.readFileSync(path.join(ROOT, "src", "fingerprint-browser.js"), "utf8");
const mainSrcFp2 = fs.readFileSync(path.join(ROOT, "src", "electron-main.js"), "utf8");
const browserSrcFp2 = fs.readFileSync(path.join(ROOT, "src", "browser.js"), "utf8");
const fpPanelSrc2 = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "components", "FingerprintBrowserPanel.tsx"),
  "utf8"
);
const tasksSrcFp2 = fs.readFileSync(path.join(ROOT, "src", "tasks.js"), "utf8");
const stateSrcFp2 = fs.readFileSync(path.join(ROOT, "src", "state.js"), "utf8");
const gcSrcFp2 = fs.readFileSync(path.join(ROOT, "src", "global-config.js"), "utf8");
const cfgSrcFp2 = fs.readFileSync(path.join(ROOT, "src", "config.js"), "utf8");
const mockSrcFp2 = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "api", "mock.ts"),
  "utf8"
);
const typesSrcFp2 = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "types", "index.ts"),
  "utf8"
);
const formSrcFp2 = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "components", "SettingsForm.tsx"),
  "utf8"
);

checkTrue(
  "【多内核】uninstall 删默认内核前先搬走其它内核子目录（父目录递归删会连带删掉子内核）",
  // 目录结构是「默认内核在根、其它内核在根的子目录里」，所以 rmSync(默认, recursive)
  // 会把 fp150 一起删掉。守卫钉住「搬出 → 删 → 放回」这三步都在。
  /keptChildren/.test(fpSrc2) &&
    /fs\.renameSync\(child, parked\)/.test(fpSrc2) &&
    /卸载默认内核时保留了/.test(fpSrc2) &&
    /已取消删除以免连带删除该内核/.test(fpSrc2),
  "少了搬出这一步 → 「卸载 154」会把 150 一起删掉，而 150 正是本次要保留的目标"
);
checkTrue(
  "【多内核】搬不出去时放弃删除（不静默删掉另一个内核）",
  /return \{\s*ok:\s*false,[\s\S]{0,220}?无法保留[\s\S]{0,120}?已取消删除/.test(fpSrc2) ||
    /无法保留[\s\S]{0,200}?已取消删除/.test(fpSrc2),
  "搬不动还继续删 → 用户另一个内核的目录被静默删除，且无任何提示"
);
checkTrue(
  "【多内核】后台下载目录不是手动下载目录（fp-download-staged ≠ fp-download）",
  /function stagedDownloadDirFor/.test(fpSrc2) &&
    /sp\.resolve\("fp-download-staged"\)/.test(fpSrc2) &&
    // 关键：默认内核的后台目录不能是手动那个
    !/sp\.resolve\("fp-download"\);\s*\n\s*:\s*sp\.resolve\(`fp-download-/.test(fpSrc2),
  "两者同名 → downloadAsset 的失败清场会删掉对方分片（202MB 反复下三遍的老问题）"
);
checkTrue(
  "启动路径上先做旧内核迁移清理，再触发后台下载判定",
  (() => {
    // ⚠️ 必须按**行号**比较，不能用 indexOf("...\n}") —— 这个文件混用 LF/CRLF，
    //    换行符不一致会让锚点匹配不到，守卫恒红。
    const src = mainSrcFp2.replace(/\r/g, "");
    const lines = src.split("\n");
    const iMigrate = lines.findIndex((l) => l.includes("migrateAwayLegacyEngine();"));
    // ⚠️ 要取**最后一个** maybeStart —— 文件里它出现两次（另一次在别的函数体内），
    // findIndex 会命中第一个，那不是启动路径。
    let iMaybe = -1;
    lines.forEach((l, i) => {
      if (l.replace(/\r$/, "").trim() === "maybeStartBackgroundFingerprint();") iMaybe = i;
    });
    return iMigrate !== -1 && iMaybe !== -1 && iMigrate < iMaybe;
  })(),
  "顺序反了 → 根目录里的旧内核被当成「已装但版本不符」，既触发重下又白占磁盘"
);
checkTrue(
  "单内核模式开关各处一致（配置默认 true / 类型是 boolean / 读取用 !== false）",
  // ⚠️ 分工要分清：
  //   · config / global-config / mock 是**默认值载体** → 必须是 true
  //   · types/index.ts 是**类型声明** → 只要求有 singleEngineOnly: boolean
  //     （让它也带默认值是错的 —— 类型里写 "= true" 会被误读成有默认值）
  //   · browser.js 是**读取方** → 必须用 !== false（否则旧配置 undefined 会误判成「关」）
  /singleEngineOnly:\s*true/.test(cfgSrcFp2) &&
    /singleEngineOnly:\s*true/.test(gcSrcFp2) &&
    /singleEngineOnly:\s*true/.test(mockSrcFp2) &&
    /singleEngineOnly:\s*boolean/.test(typesSrcFp2) &&
    /singleEngineOnly:\s*fp\.singleEngineOnly !== false/.test(browserSrcFp2) &&
    /label="只保留单个内核"/.test(fpPanelSrc2),
  "默认值/类型/读取任一处不一致 → 旧配置读到 undefined 会误判成「关」，切换后两个内核都留着"
);
checkTrue(
  "单内核模式读配置用 `!== false`（旧配置缺字段时算「开」）",
  /singleEngineOnly:\s*fp\.singleEngineOnly !== false/.test(browserSrcFp2) &&
    /singleOnly = fpCfg\.singleEngineOnly !== false/.test(mainSrcFp2),
  "写成 === true → 旧配置读到 undefined 会误判成「关」，切换后两个内核都留着"
);
checkTrue(
  "UI 切换内核走 setFingerprintEngine IPC（主进程才能卸载旧内核 + 触发下载）",
  // ⚠️ 钉的是**内核卡片组的点击回调**，不是 onSwitchEngine 函数体内有没有那个调用 ——
  //    函数在但卡片没接上，一样是坏的（旧内核会留在磁盘上且新内核不会自动下载）。
  // 0.14.7 内核选择从 SelectField 改成卡片组（role=radio），锚点随之改成 onClick。
  /onClick=\{\(\) => \{[\s\S]{0,100}?void onSwitchEngine\(e\.key\)/.test(fpPanelSrc2) &&
    /api\.setFingerprintEngine\(key\)/.test(fpPanelSrc2) &&
    // 不能只 patch 配置
    !/void patch\(\{ engine: e\.key \}\)/.test(fpPanelSrc2),
  "只改配置 → 旧内核目录留在磁盘上（500MB），且新内核不会自动下载"
);
checkTrue(
  "app:setFingerprintEngine 拒绝不可用内核与 Docker 预装（不假装成功）",
  /app:setFingerprintEngine/.test(mainSrcFp2) &&
    /if \(!e\.available\)[\s\S]{0,200}?return \{\s*ok:\s*false/.test(mainSrcFp2) &&
    /if \(fpBrowser\.preinstalledDir\(\)\)[\s\S]{0,220}?ok:\s*false/.test(mainSrcFp2),
  "不拒绝 → 用户切到会崩的 fp150，或在容器里切了却什么都没发生"
);
checkTrue(
  "切换失败时不落盘配置（保持配置与实际一致）",
  /const r = fpBrowser\.switchEngine[\s\S]{0,300}?if \(!r\.ok\)[\s\S]{0,200}?return \{ ok: false/.test(
    mainSrcFp2
  ),
  "失败也落盘 → 配置说已切换而实际没切，两者不一致且再没人纠正"
);
checkTrue(
  "设置页有「只保留单个内核」开关",
  /label="只保留单个内核"/.test(fpPanelSrc2) && /patch\(\{ singleEngineOnly: v \}\)/.test(fpPanelSrc2),
  "没有开关 → 用户想两个都留着（随时切换）做不到"
);

// —— 定期收取积分：支持「每隔 N 天」与「每天定时」两种节奏（2026-10-06）——
// ⚠️ 所需源码（fpSrc2 / fpPanelSrc2 / tasksSrcFp2 / stateSrcFp2 / gcSrcFp2 /
//    cfgSrcFp2 / mockSrcFp2 / typesSrcFp2 / formSrcFp2）已在文件上方统一提前读取。

checkTrue(
  "claimSchedule 段四处字段一致（config / global-config / types / mock）",
    /claimSchedule: \{/.test(gcSrcFp2) &&
    /claimSchedule: \{/.test(typesSrcFp2) &&
    /claimSchedule: \{/.test(mockSrcFp2) &&
    // 三个字段一个都不能少（少一个 → 旧配置加载后 undefined → NaN 传进节流判定）
    ["mode", "everyDays", "dailyAt"].every(
      (f) =>
        new RegExp(f + ':\\s*').test(cfgSrcFp2) &&
        new RegExp(f + ':\\s*').test(gcSrcFp2) &&
        new RegExp(f + '\\??:\\s*').test(typesSrcFp2) &&
        new RegExp(f + ':\\s*').test(mockSrcFp2)
    ),
  "任一处缺字段 → 旧配置文件读到 undefined，节流判定恒为真 → 每次运行都去领"
);
checkTrue(
  "claimSchedule 默认值一致（mode=interval / everyDays=7 / dailyAt=09:00）",
  /mode:\s*"interval"/.test(cfgSrcFp2) &&
    /everyDays:\s*7/.test(cfgSrcFp2) &&
    /dailyAt:\s*"09:00"/.test(cfgSrcFp2) &&
    /mode:\s*"interval"/.test(gcSrcFp2) &&
    /everyDays:\s*7/.test(gcSrcFp2) &&
    /dailyAt:\s*"09:00"/.test(gcSrcFp2) &&
    /everyDays:\s*7/.test(mockSrcFp2) &&
    /dailyAt:\s*"09:00"/.test(mockSrcFp2),
  "默认值漂移 → 「全球配置」与「账户设置」初始状态不同，用户改一个另一个不变"
);
checkTrue(
  "节流判定是**纯函数**且 now 由调用方注入（不读 new Date()）",
  /function shouldRunClaim\(\{[\s\S]{0,200}?now\s*\}\)/.test(tasksSrcFp2) &&
    /shouldRunClaim\([\s\S]{0,400}?now:\s*Date\.now\(\)/.test(tasksSrcFp2) &&
    // 函数体内除了形参 now 之外不得再取真实时刻
    (() => {
      const fn = /function shouldRunClaim\([\s\S]*?\n\}/.exec(tasksSrcFp2);
      if (!fn) return false;
      const body = fn[0];
      return !/Date\.now\(\)/.test(body) && !/new Date\(\)/.test(body);
    })(),
  "函数体里读 new Date()/Date.now() → 任何时刻跑门禁都会假红（项目铁律：依赖当前时刻的断言必须传固定 now）"
);
checkTrue(
  "daily 模式用本地时区构造当天时间点（不用 new Date(ISO 串)——那会按 UTC 解释偏 8 小时）",
  /new Date\(d\.getFullYear\(\), d\.getMonth\(\), d\.getDate\(\), hh, mm, 0, 0\)/.test(
    tasksSrcFp2
  ),
  "用 new Date('...T09:00') → ES2015+ 按 UTC 解释，东八区整体偏 8 小时，daily 模式永远判「未到点」"
);
checkTrue(
  "daily 模式同时校验 lastClaimDate 与 lastClaimAt（只比日期会被改时钟绕过）",
  /st\.lastDate === Number\(todayNum\)/.test(tasksSrcFp2) &&
    /st\.lastAt && st\.lastAt > at/.test(tasksSrcFp2),
  "只比日期 → 用户把系统时钟往回拨一天，同一天会重复领取"
);
checkTrue(
  "everyDays 收口到 1~30（配置被写成 0/-1/999 时不至于让任务永不执行）",
  /Math\.min\(30, Math\.max\(1, Math\.floor\(Number\(everyDays\)\)/.test(tasksSrcFp2),
  "不收口 → everyDays=0 时 days<0 恒不成立，任务会**每次运行都领**"
);
checkTrue(
  "领取成功后同时写 lastClaimDate 与 lastClaimAt（两处写入点都要）",
  (tasksSrcFp2.match(/lastClaimAt = claimNow/g) || []).length >= 2 &&
    /const claimNow = Date\.now\(\)/.test(tasksSrcFp2),
  "只写日期 → daily 模式改系统时钟就能重复领"
);
checkTrue(
  "旧的 7 天硬编码节流已移除（否则 everyDays 改了也不生效）",
  !/daysBetween\(last, todayNum\) < 7/.test(tasksSrcFp2) &&
    !/7 天一次\)/.test(tasksSrcFp2),
  "留着旧判定 → 无论 everyDays 配成几天都还是 7 天一次"
);
checkTrue(
  "日志/提示里的节奏描述跟随模式（不再写死「每周一次」）",
  /const claimCadence =/.test(tasksSrcFp2) && /\$\{claimCadence\}/.test(tasksSrcFp2),
  "写死「每周一次」→ 用户配成每天 09:00，日志却说每周，排查时被误导"
);
checkTrue(
  "设置页有节奏下拉 + 条件输入，且只在开关打开时显示",
  /CLAIM_MODE_OPTIONS/.test(formSrcFp2) &&
    /value\.tasks\?\.claim && \(/.test(formSrcFp2) &&
    /claimMode === "interval"/.test(formSrcFp2) &&
    /label="收取节奏"/.test(formSrcFp2),
  "关着开关时也摆出来 → 用户以为改频率有用（任务压根不会跑）"
);
checkTrue(
  "dailyAt 在渲染层就收口成 HH:MM（不把非法值存进配置）",
  /function normalizeHHMM/.test(formSrcFp2) && /normalizeHHMM\(v\)/.test(formSrcFp2),
  "不收口 → 存进 '9:00am' / '25:00'，主进程正则拒掉后退回 interval，用户以为设了没效果"
);
checkTrue(
  "state 默认结构含 lastClaimAt（缺字段时 lastAt 是 undefined → 判为「从未领过」）",
  /lastClaimAt:\s*0/.test(stateSrcFp2),
  "缺字段 → daily 模式第一次运行时 lastAt=undefined，Number(undefined)=NaN，比较恒 false"
);

checkTrue(
  "设置页有「定期收取积分」开关",
  // ⚠️ 2026-10-06 起这一项写成了多行对象（加了 hint 说明频率在下方设置），
  // 单行正则会漏 —— 断言只钉「key 与 label 都在同一项里」，不钉排版
  /key: "claim"/.test(formSrc) && /label: "定期收取积分"/.test(formSrc)
);
checkTrue("设置页 promos 文案改为「积分活动」", /key: "promos", label: "积分活动"/.test(formSrc));
checkTrue("设置页有 IP 服务下拉", /IP_PROVIDER_OPTIONS/.test(formSrc) && /IP 归属地查询服务/.test(formSrc));
checkTrue("设置页可选 ip.sb / 太平洋 / ipinfo / ip-api / Bing",
  /value: "ipsb"/.test(formSrc) && /value: "pconline"/.test(formSrc) && /value: "ipinfo"/.test(formSrc) &&
  /value: "ipapi"/.test(formSrc) && /value: "bing"/.test(formSrc));
checkTrue("类型定义含 IpProvider 联合类型", /type IpProvider = "auto" \| "ipsb" \| "pconline" \| "ipinfo" \| "ipapi" \| "bing"/.test(typesSrc));
const detailSrc = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "views", "AccountDetail.tsx"), "utf8");
checkTrue("账户详情页有条件渲染的「每日活动」卡片", /dailyEnabled/.test(detailSrc) && /label="每日活动"/.test(detailSrc));

/* ============ 15. 版本号口径 与 面板不透明度下限 ============ */
console.log("\n【15】版本号（三段 semver + 小版本号）与面板不透明度下限");
// 版本号分两层：version 必须是三段合法 semver —— npm / CI / Docker 都不认四段；
// 「小版本号」放 build.buildNumber，由 electron-builder 自动派生成 0.9.4.1，
// 用于安装包文件名（artifactName 的 ${buildVersion} 宏）与 exe 的 Windows 版本资源。
// 守卫目的：防止有人直接把四段写进 version，那会连带打断 npm ci / 打包。
const pkgRaw = require(path.join(ROOT, "package.json"));
checkTrue(
  "package.json version 保持三段合法 semver（四段会打断 npm/CI）",
  /^\d+\.\d+\.\d+$/.test(pkgRaw.version),
  `实际 ${pkgRaw.version}`
);
checkTrue(
  "顶层 buildNumber 为纯数字（小版本号来源）",
  /^\d+$/.test(String(pkgRaw.buildNumber || "")),
  `实际 ${JSON.stringify(pkgRaw.buildNumber)}`
);
// ⚠️ 防回退：小版本号绝不能写在 build 段里。electron-builder 会把 build 段从打进
// asar 的那份 package.json 里剔除（fileTransformer 黑名单），运行时读不到 ——
// 曾因此让安装包名是 0.9.4.1、窗口标题却退回 0.9.4。
checkTrue(
  "小版本号不在 build 段（build 段会被剔除，运行时读不到）",
  pkgRaw.build.buildNumber === undefined,
  `build.buildNumber = ${JSON.stringify(pkgRaw.build.buildNumber)}`
);
checkTrue(
  "打包时通过 beforePack 钩子把顶层 buildNumber 同步给 electron-builder",
  pkgRaw.build.beforePack === "scripts/beforePack.js"
);
checkTrue(
  "artifactName 用 ${buildVersion} 宏（否则安装包名丢第四段）",
  pkgRaw.build.win.artifactName.includes("${buildVersion}"),
  pkgRaw.build.win.artifactName
);
const versionMod = require(path.join(ROOT, "src", "version.js"));
// buildNumber 为 "0" 表示正式版：展示/文件名都用干净三段（0.10.0），
// 递增到 1、2… 才回到四位（0.10.0.1）。version.js / beforePack / version.ts 三处同规则。
const expectDisplay =
  String(pkgRaw.buildNumber) === "0"
    ? String(pkgRaw.version)
    : `${pkgRaw.version}.${pkgRaw.buildNumber}`;
check("展示版本（正式版三段 / 热修四位）", versionMod.displayVersion(), expectDisplay);
checkTrue(
  "beforePack 对 buildNumber=0 输出三段 buildVersion（正式版文件名不带 .0）",
  /buildNumber === "0" \? appInfo\.version :/.test(
    fs.readFileSync(path.join(ROOT, "scripts", "beforePack.js"), "utf8")
  )
);
checkTrue(
  "正式版安装包名不带 -test 后缀",
  !/-test/.test(pkgRaw.build.win.artifactName),
  pkgRaw.build.win.artifactName
);
const mainSrcVer = fs.readFileSync(path.join(ROOT, "src", "electron-main.js"), "utf8");
checkTrue(
  "窗口标题走 displayVersion()（标题栏能看出小版本号）",
  /title: `MS Rewards 自动任务 v\$\{displayVersion\(\)\}`/.test(mainSrcVer)
);
const serverSrcVer = fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8");
checkTrue(
  "健康检查两个端点都走 displayVersion()",
  (serverSrcVer.match(/require\("\.\/version"\)\.displayVersion\(\)/g) || []).length === 2
);
// 侧边栏左下角的版本号来自 src-renderer/src/version.ts（纯前端模块读不到 package.json），
// 漂移了就等于给用户看错版本 —— 这里锁死同步。
const rVerSrc = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "version.ts"), "utf8");
const rVerM = rVerSrc.match(/APP_VERSION\s*=\s*"([^"]+)"/) || [];
const rBuildM = rVerSrc.match(/BUILD_NUMBER\s*=\s*(\d+)/) || [];
checkTrue(
  "渲染层 version.ts 与 package.json 版本同步（APP_VERSION + BUILD_NUMBER）",
  rVerM[1] === pkgRaw.version && Number(rBuildM[1]) === Number(pkgRaw.buildNumber),
  `version.ts=${rVerM[1]}.${rBuildM[1]} vs package.json=${pkgRaw.version}.${pkgRaw.buildNumber}`
);

// 不透明度：滑块 min 与主进程 clamp 必须同口径 —— 否则要么拖不到 20%，
// 要么拖到了又被主进程悄悄夹回去（表现为「滑块动了、值却弹回」）。
// 用一份独立的模块实例 + 自建临时存储根来跑下限断言。
// 不复用前面那份：模块在 require 时就绑定了文件路径，而【8】已把它的目录删了。
const opRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ms-rewards-opacity-selfcheck-"));
const opEnvBackup = process.env.MS_REWARDS_STORAGE_DIR;
process.env.MS_REWARDS_STORAGE_DIR = path.join(opRoot, "storage");
const appearancePath = require.resolve(path.join(ROOT, "src", "appearance.js"));
delete require.cache[appearancePath];
const appearanceIso = require(appearancePath);
appearanceIso.set({ opacity: 0.2 });
check("0.20 可保存（滑块下限能落到）", appearanceIso.get().opacity, 0.2);
appearanceIso.set({ opacity: 0.01 });
check("低于 0.20 被夹到 0.20（面板不会全透明）", appearanceIso.get().opacity, 0.2);
appearanceIso.set({ opacity: 0.19 });
check("0.19 同样夹到 0.20", appearanceIso.get().opacity, 0.2);
appearanceIso.set({ opacity: 1 });
check("上限仍为 1.00", appearanceIso.get().opacity, 1);
delete require.cache[appearancePath];
process.env.MS_REWARDS_STORAGE_DIR = opEnvBackup;
fs.rmSync(opRoot, { recursive: true, force: true });
const personalizeSrc = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "views", "Personalize.tsx"),
  "utf8"
);
checkTrue("个性化页滑块下限为 min={20}", /min=\{20\}/.test(personalizeSrc));
checkTrue("类型注释已同步 0.20 – 1.00", /0\.20 – 1\.00/.test(typesSrc));

// 第三方声明 / 开源许可文件：安装包必须随包分发 LICENSE 与 THIRD_PARTY_NOTICES.md。
// 背景：上游 @ttqtt/liquid-glass-react 自带 THIRD_PARTY_NOTICES（声明它参考了
// shuding/liquid-glass、Apple 等），本项目此前既无 LICENSE 也无第三方声明 ——
// package.json 只有 license:"MIT" 字段、build.files 白名单不含任何许可文件。
const licensePath = path.join(ROOT, "LICENSE");
const noticesPath = path.join(ROOT, "THIRD_PARTY_NOTICES.md");
checkTrue("根目录存在 LICENSE 文件", fs.existsSync(licensePath));
checkTrue("根目录存在 THIRD_PARTY_NOTICES.md（第三方声明）", fs.existsSync(noticesPath));
checkTrue(
  "LICENSE 为 MIT 许可正文",
  fs.existsSync(licensePath) &&
    /MIT License/.test(fs.readFileSync(licensePath, "utf8")) &&
    /Permission is hereby granted/.test(fs.readFileSync(licensePath, "utf8"))
);
checkTrue(
  "build.files 白名单包含 LICENSE 与 THIRD_PARTY_NOTICES.md（否则打不进包）",
  Array.isArray(pkgRaw.build.files) &&
    pkgRaw.build.files.includes("LICENSE") &&
    pkgRaw.build.files.includes("THIRD_PARTY_NOTICES.md"),
  JSON.stringify(pkgRaw.build.files)
);

// EULA：安装器必须带「禁止商用」的最终用户许可协议页。
// 私有仓库 + 只发 exe 的现状下，「禁止他人商用」靠两层：源码层靠闭源（已天然实现）、
// 二进制层靠 EULA。electron-builder 的 nsis.license 指向 build/license.txt，
// 安装时 MUI2 弹协议页、需勾选「同意」才能继续。
const eulaPath = path.join(ROOT, "build", "license.txt");
checkTrue("安装器 EULA 文件 build/license.txt 存在", fs.existsSync(eulaPath));
checkTrue(
  "EULA 含非商业使用限制（非商业 / 商业目的 / 转售）",
  fs.existsSync(eulaPath) &&
    /非商业/.test(fs.readFileSync(eulaPath, "utf8")) &&
    /商业目的/.test(fs.readFileSync(eulaPath, "utf8")) &&
    /转售/.test(fs.readFileSync(eulaPath, "utf8"))
);
checkTrue(
  "nsis.license 指向 EULA（否则安装器不弹协议页）",
  pkgRaw.build.nsis && pkgRaw.build.nsis.license === "license.txt",
  JSON.stringify(pkgRaw.build.nsis && pkgRaw.build.nsis.license)
);
// 第三方作者的油猴脚本已移出版本库（版权考虑），也不能再打进安装包。
// electron-builder 按文件系统收集、不看 git，所以 .gitignore 拦不住它 —— 必须从白名单移除。
// 判据：build.files 里不能出现该目录；storage/ 同理（打包白名单本就不含它）。
checkTrue(
  "安装包不含第三方作者脚本（build.files 不含 参考js脚本/）",
  !Array.isArray(pkgRaw.build.files) || !pkgRaw.build.files.some((f) => String(f).includes("参考js脚本")),
  JSON.stringify(pkgRaw.build.files)
);

/* ============ 16. 账户表控件同档 + 关于页 WorkBuddy 徽章 ============ */
console.log("\n【16】账户表行内控件同档（32px）与 WorkBuddy 官方徽章");
// 背景：上游把玻璃档 --lg-control-height 内联成 44px，会盖过库自己的 small=32px；
// 曾靠把操作列压到 26px「凑」视觉，结果一行里 26/32/44 三种高度混排（用户截图）。
// 现在统一：表格内 small 按钮 min-height:32px，头像回到 .nav-logo 默认 32px。
const globalCss = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "styles", "global.css"),
  "utf8"
);
checkTrue(
  "表格内 small 按钮统一 32px（压过上游内联 44px）",
  /\.compat-table \.lg-button\[data-control-size="small"\]\s*\{\s*min-height:\s*32px/.test(globalCss)
);
checkTrue(
  "旧的 26px 压扁方案已废弃（不得回流）",
  !/--lg-control-height:\s*26px/.test(globalCss)
);
const dashSrc = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "views", "Dashboard.tsx"),
  "utf8"
);
checkTrue(
  "账户头像走 .nav-logo 默认 32px（无内联 26px 覆写）",
  !/nav-logo[^>]*width:\s*26/.test(dashSrc) && /className="nav-logo"/.test(dashSrc)
);
// WorkBuddy 友链标识：保持官方 title SVG「圆角方块」底（rx=120.842/560≈22%）。
// 0.9.4.10 曾误换成 favicon 版（viewBox 0 0 40 40 / rx=20 = 正圆底），用户反馈
// 「我最开始的版本是方的啊，你怎么给我改圆了」→ 0.9.4.11 回退，由下方
// 【18】末尾的「官方圆角方块」守卫把关（此处不再断言 40 viewBox）。

/* ============ 17. 光晕覆盖卡片/开关 + 默认深色必应 + 浅色关反射 + 氛围光可见 ============ */
console.log("\n【17】指针光晕覆盖卡片与开关、默认外观、浅色反射与氛围光层级");
// 默认外观：深色 + 主界面必应每日一图。流场只属于登录页/向导背景（authBg，
// 见【20】守卫），0.13.1 曾误把 flow 当主界面默认，0.13.2 依用户纠正改回。
checkTrue("默认深浅模式为 dark", appearance.DEFAULTS.mode === "dark");
checkTrue("默认背景为必应每日一图 bing", appearance.DEFAULTS.bgType === "bing");
checkTrue("默认登录页/向导背景为流场 flow", appearance.DEFAULTS.authBg === "flow");

// 光晕此前只绑 .lg-surface，内容卡片是 .lg-material-view、开关是 .lg-switch，
// 导致「大部分卡片」「开关」都没有跟随光斑（用户反馈）。现在统一三类。
// 断言必须核对 HALO_SELECTOR 常量的完整值（而非零散字符串——否则命中注释里
// 的同名 class，selector 回退到 .lg-surface 也照样假绿）。
const haloSrc = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "hooks", "useLiquidGlassHalo.ts"),
  "utf8"
);
checkTrue(
  "光晕选择器 HALO_SELECTOR 同时覆盖 .lg-material-view 与 .lg-switch-track",
  /HALO_SELECTOR\s*=\s*"[\s\S]*?\.lg-material-view[\s\S]*?\.lg-switch-track[\s\S]*?"/.test(haloSrc)
);

// 浅色下关闭玻璃反射高光（.lg-glow / .lg-decoration::after）：
// 否则白底上的白光会把蓝主按钮洗白，hover 时白字消失。
checkTrue(
  "浅色主题关闭反射高光层",
  /:root\[data-theme="light"\]\s*\.lg-glow/.test(globalCss) &&
    /:root\[data-theme="light"\]\s*\.lg-decoration::after/.test(globalCss)
);

// 氛围光 body::before 必须高于壁纸层（.bg-layer z-index:0），否则被壁纸盖住看不见。
checkTrue("氛围光层提到壁纸之上（z-index 1）", /body::before\s*\{[^}]*z-index:\s*1/m.test(globalCss));

/* ============ 18. 0.9.4.5：Chromium 安装走 npmmirror + 进度条 + 开关主题色 + 友链 logo 不被光晕糊 ============ */
console.log("\n【18】Chromium 镜像下载 / 进度条 / 开关主题色 / 友链 logo");

// ensure-deps.js 必须暴露 npmmirror host + probe 函数
const ensureDepsSrc = fs.readFileSync(path.join(ROOT, "src", "ensure-deps.js"), "utf8");
checkTrue(
  "Chromium 默认走 npmmirror 镜像（PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST）",
  /PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST[\s\S]*NPMMIRROR_HOST/.test(ensureDepsSrc)
);
checkTrue(
  "镜像失败回落官方源",
  /OFFICIAL_HOST_DEFAULT/.test(ensureDepsSrc) && /tryInstallWithMirror\(OFFICIAL_HOST_DEFAULT/.test(ensureDepsSrc)
);
checkTrue(
  "进度条节流输出（≥2s 或 ≥5%）",
  /lastEmitMs[\s\S]{0,100}>= 2000[\s\S]{0,100}Math\.abs\(pct - lastEmitPct\) >= 5/.test(ensureDepsSrc)
);
checkTrue(
  "进度 poll 直接读 os.tmpdir/playwright-download-*.zip",
  /playwright-download-\\*[\s\S]*?\.zip\$/.test(ensureDepsSrc.replace(/\n/g,""))
);

// Sidebar 必须订阅 install-progress + 按钮样式类
const sidebarSrc = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "components", "Sidebar.tsx"),
  "utf8"
);
checkTrue("Sidebar 订阅 install-progress 事件", /onInstallProgress/.test(sidebarSrc));
checkTrue("Sidebar 按钮有 is-progress / is-done 状态类", /is-progress/.test(sidebarSrc) && /is-done/.test(sidebarSrc));
checkTrue("Sidebar 渲染 nav-install-fill 进度条", /nav-install-fill/.test(sidebarSrc));

// global.css 开关 on 色映射到 accent
checkTrue(
  "开关 on 色跟随 accent（lg-switch-track[data-checked=true]）",
  /\.lg-switch-track\[data-checked="?true"?\][^{]*\{[^}]*background:\s*var\(--accent/.test(globalCss)
);

// 0.9.4.6：--accent 此前只在 :root 写死，用户改主题色后开关等 var(--accent) 消费方不跟随。
// App.tsx 必须把 appearance.accent 实时写到 <html> 的 --accent（用户反馈「主题色变更后开关没变化」）。
// 反例验证：这是真正生效的运行时接线，不是纯 CSS 覆盖。
checkTrue(
  "App.tsx 把主题色写入 --accent（setProperty）",
  /setProperty\(\s*"--accent"\s*,\s*appearance\.accent\s*\)/.test(
    fs.readFileSync(path.join(ROOT, "src-renderer", "src", "App.tsx"), "utf8")
  )
);
// 0.9.4.7：「鼠标指针光晕」开关此前只关项目自绘 halo，库自带 .lg-glow 跟手光斑不受控，
// 深色下关掉开关后侧边栏等玻璃组件仍有光（用户反馈「关了光晕侧边栏还能触发」）。
// App.tsx 必须在 pointerHalo===false 时挂 data-halo="off"，global.css 用它灭 .lg-glow。
checkTrue(
  "App.tsx pointerHalo=false 时挂 data-halo=off",
  /pointerHalo === false[\s\S]{0,120}setAttribute\(\s*"data-halo"\s*,\s*"off"\)/.test(
    fs.readFileSync(path.join(ROOT, "src-renderer", "src", "App.tsx"), "utf8")
  )
);
checkTrue(
  "global.css 用 data-halo=off 关掉库 .lg-glow",
  /:root\[data-halo="off"\]\s*\.lg-glow\s*\{\s*opacity:\s*0\s*!important/.test(globalCss)
);

// .lg-switch 不再绑光晕（避免方框）
const haloSrc2 = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "hooks", "useLiquidGlassHalo.ts"),
  "utf8"
);
checkTrue(
  "光晕 HALO_SELECTOR 不再绑 .lg-switch（只绑 .lg-switch-track）",
  /\.lg-switch-track/.test(haloSrc2) && !/HALO_SELECTOR[\s\S]*?\.lg-switch\s*[,"]/.test(haloSrc2)
);
checkTrue(
  "光晕 HALO_SELECTOR 排除 .friend-logo",
  /\.friend-logo/.test(haloSrc2)
);

// 0.9.4.10：库给 .lg-surface 一律 18px 内边距，46px 的友链 logo 盒（border-box）
// 内容区只剩 10×10，svg 溢出 auto 行从内容盒顶部起排 → 图标下坠 8/16px（用户反馈
// 「友情链接里面的两个图标还是歪的」）。.friend-logo 必须清零 padding（双类选择器
// .friend-logo.lg-surface 不必——这里只要求 padding: 0 出现在该规则内）。
checkTrue(
  "友链 logo 容器清零库 padding（防 46px 盒内容被 18px 压到 10×10 → 图标下坠）",
  /\.friend-logo\s*\{[^}]*padding:\s*0/.test(globalCss)
);

// 0.9.4.11：WorkBuddy 友链标识必须保持官方「圆角方块」底（rx=120.842/560≈22%）。
// 曾被误换成 favicon 版（viewBox 0 0 40 40 / rx=20 = 正圆底），用户反馈
// 「我最开始的版本是方的啊，你怎么给我改圆了」→ 回退。此守卫防再次改成圆形。
const aboutSrcWb = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "views", "About.tsx"), "utf8");
checkTrue(
  "WorkBuddy 友链标识保持官方圆角方块（rx=120.842，非 favicon 正圆）",
  /rx="120\.842"/.test(aboutSrcWb) && !aboutSrcWb.includes("friend-mark-badge")
);

// 0.9.4.12：登录完成页跳转 /login-done 仅在 Web/Docker server 起来时才执行。
// 桌面版不 require ./server，25560 没人接，会 ECONNREFUSED 噪声 warn。
// 修法：src/server.js listen 成功后写 process.env.MS_REWARDS_HTTP_LISTENING；
// browser.js 用此 sentinel 判别后跳过 goto。两个文件必须同时满足条件。
const serverSrc = fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8");
const browserSrc = fs.readFileSync(path.join(ROOT, "src", "browser.js"), "utf8");
// 后面的「活动上报兜底」「浏览器去自动化补丁」两节复用这两个源文本（同一文件不重复读）
const tasksSrc = fs.readFileSync(path.join(ROOT, "src", "tasks.js"), "utf8");
const stealthSrc = fs.readFileSync(path.join(ROOT, "src", "stealth.js"), "utf8");
checkTrue(
  "登录完成页跳转仅在 Web/Docker 模式生效（MS_REWARDS_HTTP_LISTENING sentinel）",
  /process\.env\.MS_REWARDS_HTTP_LISTENING\s*=\s*String\(PORT\)/.test(serverSrc) &&
    /MS_REWARDS_HTTP_LISTENING/.test(browserSrc) &&
    /if\s*\(\s*loggedIn\s*&&\s*process\.env\.MS_REWARDS_HTTP_LISTENING/.test(browserSrc)
);

// 0.9.4.7：补位组件（Input/Select/Modal/Toast）此前只有半透明实色背景、无 backdrop-filter，
// 浅色下是白板不是玻璃（用户反馈「浅色下不是全局所有组件都是液态玻璃」）。
// 现在补 blur 磨砂；opaque 预设必须关掉这些 blur（实心预设不残留模糊）。
const compatCss = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "components", "liquidGlassCompat.css"),
  "utf8"
);
checkTrue(
  "补位 Input/Select 有磨砂 blur",
  /\.compat-input-wrap,[\s\S]*?backdrop-filter:\s*blur\(12px\)/.test(compatCss)
);
checkTrue(
  "补位 Modal 面板有磨砂 blur",
  /\.compat-modal-panel\s*\{[\s\S]*?backdrop-filter:\s*blur\(26px\)/.test(compatCss)
);
checkTrue(
  "补位 Toast 有磨砂 blur",
  /\.compat-toast\s*\{[\s\S]*?backdrop-filter:\s*blur\(20px\)/.test(compatCss)
);
checkTrue(
  "opaque 预设关掉补位组件的 blur",
  /html\[data-preset="opaque"\]\s*\.compat-modal-panel/.test(globalCss) &&
    /html\[data-preset="opaque"\]\s*\.compat-toast/.test(globalCss)
);

/* ============ 19. 0.9.4.13：签入负分哨兵泄漏 + 卡片瞬时值兜底 ============ */
console.log("\n【19】签入负分兜底 / 展示层自愈 / 聚焦刷新");

// 0.9.4.13：签入接口对「已签过/无效」返回 p=-1 这类负数标记，旧代码
// `point || 0` 拦不住真值 -1，哨兵值直接落盘 → 仪表盘「已完成 · -1 分」。
const tasksSrcSign = fs.readFileSync(path.join(ROOT, "src", "tasks.js"), "utf8");
checkTrue(
  "signPoint 写入必须 Math.max(0,...) 兜负数",
  /signPoint\s*=\s*Math\.max\(0,\s*point \|\| 0\)/.test(tasksSrcSign)
);

// describe() 展示层兜底：今天已签入却残留负数（存量脏数据）统一按 0 分显示
const accountSrcSign = fs.readFileSync(path.join(ROOT, "src", "account.js"), "utf8");
checkTrue(
  "describe 的 signPoint 负数按 0 显示（存量自愈）",
  /signDone && !\(st\.signPoint >= 0\)\s*\?\s*0\s*:\s*st\.signPoint/.test(accountSrcSign)
);
checkTrue(
  "signDone 常量已定义（防展示层引用悬空）",
  /const signDone = ranToday && st\.tasksDone\?\.sign === dateNum/.test(accountSrcSign) &&
    (accountSrcSign.match(/signDone,/g) || []).length >= 1
);

// 渲染层：窗口聚焦 / 页面可见时主动 refreshAccounts，兜住任务执行中
// 「中间值 → 最终值」窗口推送没跟上的瞬时残留
const detailSrcSign = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "views", "AccountDetail.tsx"),
  "utf8"
);
checkTrue(
  "AccountDetail 聚焦/可见时主动刷新账户数据",
  /addEventListener\("focus", onVisible\)/.test(detailSrcSign) &&
    /addEventListener\("visibilitychange", onVisible\)/.test(detailSrcSign) &&
    /visibilityState === "visible"/.test(detailSrcSign)
);

// 【20】0.9.4.14：搜索进度以服务器为准（用户可能在浏览器 Bing / 手机 App 手动赚分），
// taskSearch 必须每轮开始先 getRewardsInfo 同步进度，而不是只在当日首轮（lastSearchProgress === -1）拉一次
const tasksSrcSearch = fs.readFileSync(path.join(ROOT, "src", "tasks.js"), "utf8");
checkTrue(
  "taskSearch 每轮先拉服务器进度（无条件 getRewardsInfo）",
  /const dashboard = await rewards\.getRewardsInfo\(ctx\);\s*\n\s*if \(!dashboard \|\| !dashboard\.ok\) \{\s*\n\s*if \(search\.lastSearchProgress === -1 \|\| !search\.pc\) \{/.test(
    tasksSrcSearch
  )
);
checkTrue(
  "taskSearch 拉取失败时续轮沿用本地计数（不许冲 0）",
  /搜索进度拉取失败，本轮沿用本地计数继续/.test(tasksSrcSearch)
);
// 需求变更：搜索允许随机「多于当日剩余任务数」，计划次数不再与 remaining 取小。
// limit 来源优先级：limit.search >0（用户固定值）> force（一次性完成）> 默认随机。
checkTrue(
  "taskSearch 优先用 setBase = normalizeLimits(cfg.limits).search",
  /const setBase = normalizeLimits\(cfg\.limits\)\.search;/.test(tasksSrcSearch)
);
checkTrue(
  "taskSearch force 模式放大到 randInt(6, 9)",
  /else if \(ctx\.force\) \{[\s\S]*?randInt\(6, 9\)/.test(tasksSrcSearch)
);
checkTrue(
  "taskSearch 默认随机 randInt(4, 7)",
  /else \{[\s\S]*?randInt\(4, 7\)/.test(tasksSrcSearch)
);
checkTrue(
  "taskSearch 本轮计划次数不再被服务器剩余额度截断",
  !/const limit = Math\.max\(1, Math\.min\(randInt\(4, 7\), remaining\)\)/.test(tasksSrcSearch)
);
// 类型层也含 search（防止 renderer 类型与后端脱节）
checkTrue(
  "渲染层 AppConfig.limits 含 search 字段",
  /search: number;/.test(fs.readFileSync(path.join(ROOT, "src-renderer", "src", "types", "index.ts"), "utf8"))
);
// 设置页里出现搜索次数字段
checkTrue(
  "设置页出现搜索次数字段",
  /label=\"搜索每次次数\"/.test(formSrc)
);
checkTrue(
  "taskSearch 旧「仅首轮拉取」分支已移除",
  !/\/\/ 获取初始进度\s*\n\s*if \(search\.lastSearchProgress === -1\) \{/.test(tasksSrcSearch)
);

// 侧边栏：截图风滑动高亮胶囊（指示器 translateY 动画，首帧不播）
const sidebarSrcNav = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "components", "Sidebar.tsx"),
  "utf8"
);
checkTrue(
  "Sidebar 使用滑动指示器（nav-indicator + translateY）",
  /"nav-indicator" \+ \(ind\.ready \? " is-ready"/.test(sidebarSrcNav) &&
    /transform: `translateY\(\$\{ind\.y\}px\)`, height: ind\.h/.test(sidebarSrcNav) &&
    /indHidden \? " is-hidden"/.test(sidebarSrcNav)
);
// 侧栏整列切换（主导航 ⇄ 软件设置分类）必须有进出场动画，不能瞬间替换。
// CSS 部分在下面 globalCssNav 定义之后再查（这里还读不到）。
checkTrue(
  "Sidebar 列表切换分两阶段（is-out 离场 → 挂载新列表）",
  /className=\{"nav-switch" \+ \(switching \? " is-out" : ""\)\} key=\{navMode\}/.test(sidebarSrcNav) &&
    /setNavMode\(targetMode\)/.test(sidebarSrcNav) &&
    /indHidden \? " is-hidden"/.test(sidebarSrcNav)
);
checkTrue(
  "Sidebar 指示器按当前项实际 DOM 位置量取（offsetTop；软件设置页跟随分类选项卡 activeKey）",
  /itemRefs\.current\.get\(activeKey\)/.test(sidebarSrcNav) && /btn\.offsetTop/.test(sidebarSrcNav)
);
const globalCssNav = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "styles", "global.css"), "utf8");
checkTrue(
  "nav-indicator 滑动动画（is-ready 才启用 transition）",
  /\.nav-indicator\.is-ready \{[\s\S]*?transition: transform 320ms cubic-bezier/.test(globalCssNav)
);
// 侧栏列表切换动画的样式侧：整列滑入 / 离场关键帧 + 胶囊切换期淡出
checkTrue(
  "nav-switch 进出场关键帧与胶囊 is-hidden 淡出",
  /\.nav-switch \{[\s\S]*?animation: navSwitchIn/.test(globalCssNav) &&
    /\.nav-switch\.is-out \{[\s\S]*?animation: navSwitchOut/.test(globalCssNav) &&
    /\.nav-indicator\.is-hidden \{[\s\S]*?opacity: 0;/.test(globalCssNav)
);
const appSrcViewEnter = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "App.tsx"), "utf8");
// 切页内容区淡入（key=当前视图重挂载才播）
checkTrue(
  "内容区切换有入场动画（.view-enter 关键帧）",
  /\.view-enter \{[\s\S]*?animation: viewIn/.test(globalCssNav) &&
    /@keyframes viewIn/.test(globalCssNav) &&
    /className="view-enter" key=\{view\}/.test(appSrcViewEnter)
);
checkTrue(
  "旧 compat SideNav 已从 Sidebar 移除",
  !/SideNav/.test(sidebarSrcNav)
);

/* ============ 活动上报兜底（quiz / BingTrivia） ============ */
checkTrue(
  "tasks.js 提供 quiz 专报（msrewards/api/v1/ReportActivity）",
  /\/msrewards\/api\/v1\/ReportActivity\?ajaxreq=1/.test(tasksSrc) &&
    /PartnerId:\s*"BingTrivia"/.test(tasksSrc) &&
    /ActivitySubType:\s*"quiz"/.test(tasksSrc)
);
checkTrue(
  "quiz 上报带 Channel/OfferId/Timezone 完整字段",
  /OfferId:\s*item\.id/.test(tasksSrc) && /Channel:\s*"Bing\.Com"/.test(tasksSrc) && /Timezone:\s*-480/.test(tasksSrc)
);
checkTrue(
  "旧版 api/reportactivity 上报（含 __RequestVerificationToken）",
  /api\/reportactivity\?X-Requested-With=XMLHttpRequest/.test(tasksSrc) &&
    /__RequestVerificationToken:\s*token/.test(tasksSrc)
);
checkTrue(
  "RequestVerificationToken 从 rewards 首页提取",
  /RequestVerificationToken\(\.\*\?\)value="\(\.\*\?\)"/.test(tasksSrc)
);

// 反例守卫：上报方法名 / URL 被改坏时必须变红（防止改成监控 /reportActivity 主路径以外的地方）
checkTrue(
  "反例守卫 ①：quiz 兜底函数必须叫 reportActivityFallback",
  /async function reportActivityFallback\(ctx, item\)/.test(tasksSrc)
);
checkTrue(
  "反例守卫 ②：taskDaily 与 taskPromos 都调用了兜底上报",
  (tasksSrc.match(/await reportActivityFallback\(ctx, \{/g) || []).length === 2
);
checkTrue(
  "反例守卫 ③：上报失败只 warn，不影响任务判定（包在 try/catch 里）",
  /catch \(e\) \{\s*\n\s*if \(e && e\.isAbort\) throw e;\s*\n\s*logger\.warn\(`活动上报兜底失败/.test(tasksSrc)
);
checkTrue(
  "反例守卫 ④：reportactivity 用表单编码（不是 JSON）",
  /application\/x-www-form-urlencoded; charset=UTF-8/.test(tasksSrc) &&
    /new URLSearchParams\(\{[\s\S]*?\}\)\.toString\(\)/.test(tasksSrc)
);

/* ============ 浏览器去自动化补丁 ============ */
checkTrue(
  "stealth 抹掉 navigator.webdriver",
  /defineProperty\(Navigator\.prototype, "webdriver", \{ get: \(\) => false/.test(stealthSrc)
);
checkTrue(
  "stealth 补全 window.chrome 对象",
  /window\.chrome = \{[\s\S]*?runtime: \{/.test(stealthSrc)
);
checkTrue(
  "stealth 补全 languages / plugins / mimeTypes / platform",
  /"languages", \{ get: \(\) => langs/.test(stealthSrc) &&
    /"plugins", \{ get: \(\) => plugins/.test(stealthSrc) &&
    /"mimeTypes", \{ get: \(\) => mimeTypes/.test(stealthSrc) &&
    /"platform", \{ get: \(\) => "Win32"/.test(stealthSrc)
);
checkTrue(
  "stealth 处理 WebGL 软件渲染特征（SwiftShader/Mesa 替换为常见值）",
  /SwiftShader\|Mesa\|llvmpipe/.test(stealthSrc) && /patchCtx\(window\.WebGL2RenderingContext\)/.test(stealthSrc)
);
checkTrue(
  "stealth 导出 EXTRA_ARGS 且含 --exclude-switches=enable-automation",
  /"--exclude-switches=enable-automation"/.test(stealthSrc)
);
checkTrue(
  "注入脚本整体自包含且容错（IIFE + safe 包裹，无 Node 变量泄漏）",
  /= `\(\(\) => \{$/m.test(stealthSrc) && /const safe = \(fn\) => \{ try \{ fn\(\); \} catch \(e\) \{\} \};/.test(stealthSrc)
);

// 反例守卫：browser.js 必须真正装配上补丁
// ⚠️ 必须用 ^\s*... 锚定行首：只写 `/addInitScript.../` 的话，
// 把整行注释掉后注释文本里仍然含该串，守卫会假绿（反例验证抓到的）。
checkTrue(
  // 注意：UA 改成条件装配后不再是 launchOpts 的字段，而是非环境特征分支里的一行赋值。
  // 行首锚定仍然保留 —— 只认「单独一行干这件事」，避免注释里出现同名串导致假绿。
  "browser 启动时覆盖 headless UA（不再出现 HeadlessChrome；拟真模式下刻意不设）",
  /^\s*launchOpts\.userAgent = stealth\.STEALTH_USER_AGENT;/m.test(browserSrc) && /require\("\.\/stealth"\)/.test(browserSrc)
);
checkTrue(
  // 契约在 0.13.9 变了：以前是「每个页面都注入，拟真模式下注入带 __MSR_FP 的版本」，
  // 现在是「只在非环境特征分支注入，拟真模式零注入」。
  // 为什么必须零注入：Playwright 的 addInitScript 底层是 CDP 的
  // Page.addScriptToEvaluateOnNewDocument，调用一次就会被 环境一致性检测站 的 Navigator
  // 项识破 —— 实测注入一句 `/* noop */` 注释，verdict 即从 Normal 掉到 Robot。
  // 三条断言缺一不可：①注入点存在 ②它被 !isFp 包着 ③旧的 __MSR_FP 注入版本已消失。
  "browser 只在非环境特征分支注入 initScript（拟真模式零注入，避免 CDP 注入痕迹自曝）",
  /if \(!isFp\) \{\s*await context\.addInitScript\(\{ content: stealth\.STEALTH_INIT \}\);/.test(browserSrc) &&
    /await context\.setExtraHTTPHeaders\(stealth\.EXTRA_HTTP_HEADERS\)/.test(browserSrc) &&
    !/window\.__MSR_FP = true/.test(browserSrc)
);
checkTrue(
  "browser 追加 stealth 启动参数（EXTRA_ARGS 并入 args）",
  /^\s*\.\.\.stealth\.EXTRA_ARGS,/m.test(browserSrc)
);
checkTrue(
  // 拟真模式下不盖 accept-language（--accept-lang 由上游统一处理），否则两套控制打架。
  // 0.13.9 起它与 addInitScript 一起被 !isFp 分支收拢（拟真模式零注入零额外请求头）。
  "browser 补充 accept-language（EXTRA_HTTP_HEADERS；拟真模式让位）",
  /await context\.setExtraHTTPHeaders\(stealth\.EXTRA_HTTP_HEADERS\);/.test(browserSrc) &&
    /if \(!isFp\) \{\s*await context\.addInitScript\(\{ content: stealth\.STEALTH_INIT \}\);\s*await context\.setExtraHTTPHeaders\(stealth\.EXTRA_HTTP_HEADERS\);/.test(browserSrc)
);
checkTrue(
  "反例守卫 ⑤：注入失败只 warn 不抛出（不阻断登录/领取）",
  /catch \(e\) \{[\s\S]{0,120}注入去自动化补丁失败/.test(browserSrc)
);

// 反例守卫 ⑦：导出被摘掉时，打桩测试与后续守卫将失效，必须变红
checkTrue(
  "反例守卫 ⑦：reportActivityFallback 已导出（供打桩测试驱动）",
  /^\s*reportActivityFallback,$/m.test(tasksSrc) && /^\s*fetchRequestToken,$/m.test(tasksSrc)
);

/* ============ 灵感来源与致谢（参考脚本作者） ============ */
const aboutSrcCredit = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "views", "About.tsx"), "utf8");
const cssCredit = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "styles", "global.css"), "utf8");

// 四位作者（第一位为原始作者）：网名 + 主页链接，一个都不能少
const CREDIT_ROWS = [
  ["潘钜森", "https://github.com/geosam/FuckScripts", "https://scriptcat.org/zh-CN/users/27974"],
  ["SDSmalin", "https://scriptcat.org/zh-CN/users/211564"],
  ["DuskLight", "https://scriptcat.org/zh-CN/users/187483"],
  ["withfeel", "https://scriptcat.org/zh-CN/users/207134"],
];
for (const [name, ...links] of CREDIT_ROWS) {
  const nameOk = aboutSrcCredit.includes(`name: "${name}"`);
  const linksOk = links.every((h) => aboutSrcCredit.includes(h));
  checkTrue(
    `致谢包含作者「${name}」及其主页链接（${links.length} 条）`,
    nameOk && linksOk,
    nameOk ? "链接缺失" : "网名缺失（可能不是真实网名）"
  );
}
checkTrue(
  "原始作者（潘钜森）标注 role=原始作者 且排在首位",
  /role:\s*"原始作者"/.test(aboutSrcCredit) &&
    aboutSrcCredit.indexOf('key: "geosam"') < aboutSrcCredit.indexOf('key: "sdsmalin"')
);
checkTrue(
  "致谢区块渲染列表 + 外链按钮（CREDITS.map + window.open）",
  /CREDITS\.map\(\(c\) =>/.test(aboutSrcCredit) &&
    /c\.links\.map\(\(l\) =>/.test(aboutSrcCredit) &&
    /window\.open\(l\.href/.test(aboutSrcCredit)
);
checkTrue(
  "致谢卡片有新样式（credit-list / credit-item / credit-avatar）",
  /\.credit-list \{/.test(cssCredit) && /\.credit-item \{/.test(cssCredit) && /\.credit-avatar \{/.test(cssCredit)
);

// 反例守卫 ⑥：作者被删 / 链接写错时必须变红
checkTrue(
  "反例守卫 ⑥：旧的占位网名不得出现（防止留假名）",
  !/从来没Shop名|占位|TODO:作者|author1/i.test(aboutSrcCredit)
);

/* ============ 环境拟真浏览器可选链路（0.9.4.17） ============ */
const fpSrc = fs.readFileSync(path.join(ROOT, "src", "fingerprint-browser.js"), "utf8");
const cfgSrcFp = fs.readFileSync(path.join(ROOT, "src", "config.js"), "utf8");
const gcfgSrcFp = fs.readFileSync(path.join(ROOT, "src", "global-config.js"), "utf8");
const preloadSrcFp = fs.readFileSync(path.join(ROOT, "src", "electron-preload.js"), "utf8");
const mainSrcFp = fs.readFileSync(path.join(ROOT, "src", "electron-main.js"), "utf8");
const webApiSrcFp = fs.readFileSync(path.join(ROOT, "src", "web-api.js"), "utf8");
const webTsSrcFp = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "api", "web.ts"), "utf8");
const mockSrcFp = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "api", "mock.ts"), "utf8");
const settingsViewSrcFp = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "views", "SettingsView.tsx"), "utf8");
const softwareViewSrcFp = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "views", "SoftwareSettingsView.tsx"), "utf8");
const panelSrcFp = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "components", "FingerprintBrowserPanel.tsx"), "utf8");
const typesSrcFp = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "types", "index.ts"), "utf8");
const stealthSrcFp = fs.readFileSync(path.join(ROOT, "src", "stealth.js"), "utf8");
const browserSrcFp = fs.readFileSync(path.join(ROOT, "src", "browser.js"), "utf8");
const cssSrcFp = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "styles", "global.css"), "utf8");
const wizardSrcFp = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "views", "SetupWizard.tsx"), "utf8");

// —— 下载链路 ——
checkTrue(
  "环境拟真浏览器走 gh-proxy 多节点镜像链（文档里的 6 个入口都要在），且保留直连兜底",
  ["gh-proxy.com/", "v4.gh-proxy.org/", "v6.gh-proxy.org/", "cdn.gh-proxy.org/", "axisnow.gh-proxy.org/", "gh-proxy.org/"]
    .every((n) => fpSrc.includes(`"https://${n}"`)) &&
    /MIRROR_PREFIXES\s*=\s*\[[^\]]*""\s*,?\s*\]/.test(fpSrc)
);
checkTrue(
  "版本钉死（避免上游节奏与本项目不同步）",
  /const ENGINES = \{/.test(fpSrc) &&
    /version:\s*"\d+\.\d+\.\d+\.\d+"/.test(fpSrc) &&
    /const DEFAULT_ENGINE = "chromix"/.test(fpSrc) &&
    /const PINNED_VERSION = ENGINES\[DEFAULT_ENGINE\]\.version/.test(fpSrc)
);
checkTrue(
  "【多内核】About 页列出两个内核且版本与 ENGINES 一致（别停在陈旧版本号）",
  (() => {
    const about = fs.readFileSync(
      path.join(ROOT, "src-renderer", "src", "views", "About.tsx"),
      "utf8"
    );
    // 两个 repo 都要出现
    if (!/xiaozhou26\/Chromix/.test(about)) return false;
    if (!/adryfish\/fingerprint-chromium/.test(about)) return false;
    // 两个版本号都要与 ENGINES 对上
    const cv = /chromix:\s*\{[\s\S]{0,400}?version:\s*"([^"]+)"/.exec(fpSrc);
    const fv = /fp150:\s*\{[\s\S]{0,400}?version:\s*"([^"]+)"/.exec(fpSrc);
    if (!cv || !fv) return false;
    return about.includes(cv[1]) && about.includes(fv[1]);
  })(),
  "About 页版本号与 ENGINES 漂移 → 用户按 About 核对下载物，号对不上会以为装错了内核"
);
checkTrue(
  "browser.js 每次读配置时同步内核（唯一保证 engine 与配置一致的地方）",
  /fpBrowser\.normalizeEngine\(fp\.engine\)/.test(browserSrcFp) &&
    /fpBrowser\.setEngine\(engine\)/.test(browserSrcFp),
  "少了同步 → 用户选了 fp150、界面也变了，但 openContext 仍用默认 chromix（无报错、结果不对，最难自查）"
);
checkTrue(
  "README 的默认内核与 ENGINES 一致（0.14.6 起默认为 Chromix，不是 fp150）",
  (() => {
    const rd = require("fs").readFileSync(path.join(ROOT, "README.md"), "utf8");
    const cv = /chromix:\s*\{[\s\S]{0,400}?version:\s*"([^"]+)"/.exec(fpSrc);
    const fv = /fp150:\s*\{[\s\S]{0,400}?version:\s*"([^"]+)"/.exec(fpSrc);
    if (!cv || !fv) return false;
    // 两个版本号都要出现在 README，且默认内核必须写的是 chromix
    if (!rd.includes(cv[1]) || !rd.includes(fv[1])) return false;
    const defLine = (rd.match(/本软件默认使用[^\n]*/) || [""])[0];
    return /Chromix/.test(defLine) && /xiaozhou26\/Chromix/.test(defLine);
  })(),
  "README 还写着「默认使用 fingerprint-chromium 150」→ 与代码（默认 chromix）矛盾，用户会以为装错了内核"
);
checkTrue(
  "README 的上游链接均指向真实仓库（防止文档腐坏）",
  (() => {
    const rd = require("fs").readFileSync(path.join(ROOT, "README.md"), "utf8");
    // 提取 README 里的全部 URL 做精确匹配（子串判断会被 evil.com/?x=github.com 绕过，CodeQL js/incomplete-url-substring-sanitization）
    const norm = (u) => u.replace(/[.,;:)\]）》」』]+$/u, "").replace(/\/+$/, "");
    const urls = new Set((rd.match(/https?:\/\/[^\s)\]）》」』>]+/g) || []).map(norm));
    // 两个上游仓库 + fp150 的缺陷追踪 issue，三者缺一文档就不可信
    return (
      urls.has("https://github.com/xiaozhou26/Chromix") &&
      urls.has("https://github.com/adryfish/fingerprint-chromium") &&
      urls.has("https://github.com/adryfish/fingerprint-chromium/issues/94")
    );
  })(),
  "上游链接缺失 → 用户找不到 issue #94，也就看不到 fp150 为何不可选"
);

// ====================== 【0.14.6】更新日志渲染 ======================
// 背景：0.14.7 之前，Release 正文（Markdown）在三处界面里两种渲染方式：
//   - UpdateDialog 有个只支持「标题/列表/行内代码/加粗」的本地解析器
//   - ReleaseNotesDialog / UpdatePromptDialog 直接 whiteSpace:pre-wrap 纯文本
// 后果：满屏 `##` / `|` / `**`，上游链接点不动；且两套实现必然漂移。
// 现已统一到 src-renderer/src/utils/releaseNotes.tsx。
const notesUtilFp = require("fs").readFileSync(
  path.join(ROOT, "src-renderer", "src", "utils", "releaseNotes.tsx"),
  "utf8"
);
const updDialogFp = require("fs").readFileSync(
  path.join(ROOT, "src-renderer", "src", "components", "UpdateDialog.tsx"),
  "utf8"
);
const relNotesDlgFp = require("fs").readFileSync(
  path.join(ROOT, "src-renderer", "src", "components", "ReleaseNotesDialog.tsx"),
  "utf8"
);
const updPromptFp = require("fs").readFileSync(
  path.join(ROOT, "src-renderer", "src", "components", "UpdatePromptDialog.tsx"),
  "utf8"
);
const globalCssFp = require("fs").readFileSync(
  path.join(ROOT, "src-renderer", "src", "styles", "global.css"),
  "utf8"
);

// ① 三处必须共用同一个渲染器（不许再冒出一份本地实现）
checkTrue(
  "更新日志三处界面共用 utils/releaseNotes（消除双份实现）",
  /import \{ renderNotes \} from "\.\.\/utils\/releaseNotes"/.test(updDialogFp) &&
    /import \{ renderNotes \} from "\.\.\/utils\/releaseNotes"/.test(relNotesDlgFp) &&
    /import \{ renderNotes \} from "\.\.\/utils\/releaseNotes"/.test(updPromptFp) &&
    // 三处都不得再有 pre-wrap 纯文本渲染
    !/whiteSpace:\s*"pre-wrap"/.test(relNotesDlgFp) &&
    !/whiteSpace:\s*"pre-wrap"/.test(updPromptFp),
  "纯文本渲染 Markdown → 满屏 ##/|/** 语法；两份实现 → 一处修了另一处仍坏"
);
checkTrue(
  "UpdateDialog 里的本地解析器已删除（不再有第二份实现）",
  !/function renderNotes\(md: string\)/.test(updDialogFp) &&
    !/function renderInline\(text: string/.test(updDialogFp),
  "本地那份只支持 标题/列表/行内代码/加粗，表格与链接全不支持"
);

// ② 渲染器必须支持真实 Release 正文里出现的语法（用实测计数，不猜）
{
  const relBody = fs.existsSync(path.join(ROOT, ".workbuddy/tmp/rel-body-real.md"))
    ? fs.readFileSync(path.join(ROOT, ".workbuddy/tmp/rel-body-real.md"), "utf8")
    : "";
  const lines = relBody.replace(/\r/g, "").split("\n");
  const c = { h: 0, li: 0, tb: 0, q: 0, link: 0, fence: 0 };
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (/^```/.test(t)) c.fence++;
    else if (/^#{1,6}\s*\S/.test(t)) c.h++;
    else if (/^>\s?/.test(t)) c.q++;
    else if (/^[-*•]\s+/.test(t)) c.li++;
    else if (t.startsWith("|")) c.tb++;
    if (/\[[^\]]+\]\(https?:\/\//.test(t)) c.link++;
  }
  console.log(
    `  ·真实 Release 正文：标题 ${c.h} / 列表 ${c.li} / 表格 ${c.tb} / 引用 ${c.q} / 链接 ${c.link} / 围栏 ${c.fence}`
  );
checkTrue(
  "真实 Release 正文里出现的语法渲染器都认得（表格/引用/链接/围栏/标题/列表）",
  relBody !== "" &&
    c.tb > 0 &&
    notesUtilFp.includes('t.startsWith("|")') &&
    c.q > 0 &&
    notesUtilFp.includes("/^>\\s?(.*)$/") &&
    c.link > 0 &&
    // 行内链接语法 `\[...\](...)` 必须存在（用 includes 避开转义地狱）
    notesUtilFp.includes("\\[") &&
    c.fence > 0 &&
    notesUtilFp.includes("/^```+\\s*") &&
    c.h > 0 &&
    notesUtilFp.includes("/^(#{1,6})\\s*(.+)$/") &&
    c.li > 0 &&
    notesUtilFp.includes("/^([-*•])\\s+(.*)$/"),
  "解析器漏了某种语法 → 该语法以原始 Markdown 文本显示"
);
}

// ③ XSS 面：绝不 innerHTML；href 只放行 http/https
// ⚠️ 必须**先剥掉注释行**再判定：渲染器的文档注释里就写着
//    「绝不 innerHTML / dangerouslySetInnerHTML」这句话，
//    直接全文 grep 会命中注释自己 → 假红（这个坑今天已踩过一次）。
const notesCodeFp = notesUtilFp
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join("\n");
checkTrue(
  "更新日志渲染器不走 innerHTML（内容即使含 HTML 也只当文本）",
  !/dangerouslySetInnerHTML/.test(notesCodeFp) && !/\.innerHTML/.test(notesCodeFp),
  "innerHTML + 远端 Release 正文 = XSS；更新日志内容来自 GitHub，不能当可信"
);
// ⚠️ 这里刻意用「字符串包含」而不是正则：
//    正则里要同时表达「协议白名单」和「末尾 return null」，转义层级一多就
//    容易写成 /\^https\?:\\/.../ 这种非法 flag，把整个 selfcheck 弄崩
//    （本次就这么崩过一次，表现为 Invalid regular expression flags）。
checkTrue(
  "链接 href 经协议白名单过滤（javascript:/data: 一律降级为纯文本）",
  notesUtilFp.includes("function safeHref") &&
    notesUtilFp.includes("https?:\\/\\/")
    // 白名单只放行 http/https，且不匹配时必须返回 null（降级为纯文本）
    &&
    /return null;/.test(notesUtilFp) &&
    // 降级分支必须真的把 token 当纯文本 push 回去，而不是丢内容
    /pushPlain\(tok\)/.test(notesUtilFp),
  "不过滤则 [点我](javascript:...) 会变成可点链接，点一下就执行脚本"
);

// ④ 类名与 CSS 必须逐字一致（拼错一个字母样式静默失效）
{
  const used = new Set();
  for (const src of [updDialogFp, relNotesDlgFp, updPromptFp]) {
    // 只认普通字符串字面量里的类名。**不能用 `["\`]([^"`]*upd-note...)` 这种** ——
    // 渲染器里有模板字符串 `className={`upd-note-h upd-note-h${level}`}`，
    // 会被当成字面类名 `upd-note-h${level}` 误报缺失。
    for (const m of src.matchAll(/["'](upd-note-[a-z0-9-]+)["']/g)) used.add(m[1]);
    for (const m of src.matchAll(/className="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) if (c.startsWith("upd-note")) used.add(c);
    }
  }
  // 渲染器里的动态类名：按 `upd-note-h1..4` 逐一登记（模板字符串产出物）
  for (const c of ["upd-note-h1", "upd-note-h2", "upd-note-h3", "upd-note-h4"]) used.add(c);

  const missing = [...used].filter((c) => !globalCssFp.includes(`.${c}`));
  checkTrue(
    "tsx 里用到的 upd-note* 类名都在 CSS 里有定义",
    used.size > 0 && missing.length === 0,
    `CSS 里缺：${missing.join(", ")} → 拼错一个字母样式就静默失效（实测 updd- 踩过，高度回落 260px 且页面无任何异常）`
  );
}

// ⑤ 空/异常输入不崩（更新日志是远端内容，必须能扛住畸形输入）
{
  const mk = requireTsxSafe(ROOT, "src-renderer/src/utils/releaseNotes.tsx");
  const cases = [
    ["空串", ""],
    ["null", null],
    ["undefined", undefined],
    ["未闭合围栏", "```js\nconst a=1;"],
    ["未闭合表格", "| a | b"],
    ["只有分隔线", "|---|"],
    ["链接套粗体", "- **[name](https://a.com)** —— 说明"],
    ["HTML 注入", "<script>alert(1)</script>"],
    ["图片语法", "![x](y)"],
    ["深缩进", "      - 深\n  - 中\n- 浅"],
    ["Windows 路径", "C:\\Users\\test\\f.txt"],
    ["CRLF", "## A\r\n- b\r\n"],
  ];
  const crashed = [];
  for (const [name, input] of cases) {
    try {
      mk.renderNotes(input);
    } catch (e) {
      crashed.push(`${name}: ${e.message}`);
    }
  }
  checkTrue(
    "更新日志渲染器扛得住畸形输入（远端内容不可信）",
    crashed.length === 0,
    `崩溃：${crashed.join(" | ")}`
  );
}
checkTrue(
  "【多内核】两个内核的安装目录/staging 目录物理隔离（防止互相覆盖）",
  /e\.key === DEFAULT_ENGINE \? base : path\.join\(base, e\.key\)/.test(fpSrc) &&
    /e\.key === DEFAULT_ENGINE \? base : `\$\{base\}-\$\{e\.key\}`/.test(fpSrc),
  "共用目录 → 用户装了 150 又切回 154 时，150 的残留会顶掉 154（或反过来）"
);
checkTrue(
  "【多内核】默认内核仍装在根目录（存量用户不用重下 200MB）",
  /DEFAULT_ENGINE \? base/.test(fpSrc) &&
    /刻意仍叫 fingerprint-chromium|保留历史的 `fingerprint-chromium`/.test(fpSrc),
  "默认内核也搬进子目录 → 所有存量用户的已装内核被判不可用，被迫重下"
);
checkTrue(
  "【多内核】多候选目录检查排除其他内核的子目录",
  /otherEngineDirs/.test(fpSrc) && /!otherEngineDirs\.has\(e\.name\)/.test(fpSrc),
  "不排除 → 装了 150 再切回 154 时被误报「存在多个版本」，判为不可用"
);
checkTrue(
  "【多内核】两个内核都注册在 ENGINES 里，且 Chromix 是默认内核",
  // fp150 必须留着（用户要求：等上游修好 bug 后开放自选）—— 不许删
  /fp150:\s*\{/.test(fpSrc) &&
    /adryfish\/fingerprint-chromium/.test(fpSrc) &&
    /150\.0\.7871\.186/.test(fpSrc) &&
    /xiaozhou26\/Chromix/.test(fpSrc) &&
    /154\.0\.8037\.57/.test(fpSrc),
  "删掉 fp150 → 等上游修好后没有代码可开；漏掉任一上游 → 用户选的与实际下载的不一致"
);
checkTrue(
  "【多内核】fp150 当前标记为不可用且带已知缺陷原因（UI 要原样展示给用户）",
  /fp150:[\s\S]{0,900}?available:\s*false/.test(fpSrc) &&
    /unavailableReason:/.test(fpSrc) &&
    /issue #94/.test(fpSrc),
  "available 忘了置 false → 用户能选中会崩溃的内核；没有 reason → 用户看到禁用项却不知道为什么"
);
checkTrue(
  "【多内核】两个上游的 tag 规则相反（Chromix 带 v 前缀 / fp150 不带），都封装在 ENGINES 里",
  /tag:\s*\(v\)\s*=>\s*`v\$\{v\}`/.test(fpSrc) &&
    /tag:\s*\(v\)\s*=>\s*`\$\{v\}`/.test(fpSrc) &&
    !/releases\/download\/v\$\{/.test(fpSrc),
  "tag 前缀写死 → 换内核时对另一个上游直接 404（tag 格式相反，静默失败）"
);
checkTrue(
  "【多内核】两个上游的资产名规则相反（Chromix 不含版本 / fp150 内嵌版本+build编号）",
  /"chromix-win-x64\.zip"/.test(fpSrc) &&
    /"chromix-linux-x64\.zip"/.test(fpSrc) &&
    /ungoogled-chromium_\$\{v\}-1\.1_windows_x64\.zip/.test(fpSrc) &&
    /ungoogled-chromium-\$\{v\}-1-x86_64_linux\.tar\.xz/.test(fpSrc),
  "资产名照抄另一个上游 → 下载 404，用户装不上"
);
checkTrue(
  "资产名按平台区分（Windows/Linux 各自映射），macOS 明确不支持",
  /platform === "win32"/.test(fpSrc) &&
    /platform === "linux"/.test(fpSrc) &&
    /: null,\n\s*notes:|return null;/.test(fpSrc),
  "资产名错 → release 下载 404，用户装不上"
);
checkTrue(
  "下载做完整性校验（中断/长度不符要报错，不能静默产出坏文件）",
  /err\.integrity = true/.test(fpSrc) && /传输中断/.test(fpSrc)
);
checkTrue(
  "Range 语义不可信时放弃续传（Content-Range 自报总长与权威总长不符）",
  fpSrc.includes("Range 语义不可信") && /content-range/.test(fpSrc)
);
checkTrue(
  "总长取不到时由 Releases API 的资产 size 兜底（HEAD 经代理拿不到长度）",
  /releases\/tags/.test(fpSrc) && /hit\.size > 0/.test(fpSrc)
);
checkTrue(
  "下载有空闲超时（代理实测会掉速到僵住，没有超时会永远卡住）",
  /IDLE_TIMEOUT_MS/.test(fpSrc) && /Promise\.race\(\[reader\.read\(\), idle\]\)/.test(fpSrc)
);
checkTrue(
  "低速熔断：连续窗口均速低于阈值即换源（抓「涓流但不断」的卡死，空闲超时管不到）",
  /STALL_WINDOW_MS\s*=\s*\d+/.test(fpSrc) &&
    /STALL_MIN_BPS\s*=\s*32 \* 1024/.test(fpSrc) &&
    /^\s*err\.stall = true;/m.test(fpSrc) &&
    /自动换源续传/.test(fpSrc)
);
checkTrue(
  "连接阶段超时：首字节等不到就换源（AbortController 计时，拿到响应头即撤表）",
  /HEADER_TIMEOUT_MS\s*=\s*\d+/.test(fpSrc) &&
    /new AbortController\(\)/.test(fpSrc) &&
    /clearTimeout\(headerTimer\)/.test(fpSrc) &&
    !/AbortSignal\.timeout\(HEADER_TIMEOUT_MS\)/.test(fpSrc)
);
checkTrue(
  "反例守卫 ⑬：熔断不得删本地分片（换源后续传，不浪费已下部分）",
  !/e\.stall[\s\S]{0,80}rmSync/.test(fpSrc)
);
checkTrue(
  "全部源失败后还会清掉分片从头再来一轮（排除续传路径上的问题）",
  /for \(const allowResume of \[true, false\]\)/.test(fpSrc)
);
checkTrue(
  "「检查更新」是纯查询（checkUpdate 只调 latestVersion，不碰 install/下载）",
  /async function checkUpdate\(\)/.test(fpSrc) &&
    /latest = await latestVersion\(\)/.test(fpSrc) &&
    !/install\(/.test(fpSrc.slice(fpSrc.indexOf("async function checkUpdate"), fpSrc.indexOf("/* ---------------- 启动参数")))
);
checkTrue(
  "反例守卫 ⑭：检查更新按钮不得直连 install(force)（0.9.4.17 的缺陷：点一下重下 181MB）",
  !/onClick=\{\(\) => void onInstall\(true\)\}/.test(panelSrcFp) &&
    /onClick=\{\(\) => void onCheck\(\)\}/.test(panelSrcFp)
);

// —— 解压：必须用操作系统自带工具 ——
checkTrue(
  "解压走系统自带 tar（不用 JS 解压库），且**优先系统 bsdtar**",
  // ⚠️ 三条都要锚在真实代码上，不能只匹配注释文字（实测踩过：守卫写成
  // /System32.*tar\.exe/ 时，把 out.push(sys) 删掉仍然 PASS —— 因为注释里
  // 那句「System32, tar.exe」被匹配上了，等于假绿）。
  // 真实判据：tarCandidates 里有 existsSync(sys) 的守卫 + out.push(sys)。
  /function tarCandidates\(\)\s*\{[\s\S]{0,400}?System32[\s\S]{0,300}?existsSync\(sys\)[\s\S]{0,120}?out\.push\(sys\)/.test(
    fpSrc
  ) &&
    /out\.push\("tar"\)/.test(fpSrc) &&
    /function tarArgs\(/.test(fpSrc) &&
    // bsdtar 必须用 cwd + basename 绕开盘符冒号
    /path\.basename\(file\)/.test(fpSrc),
  "未优先系统 bsdtar → 装了 Git for Windows 的机器上 GNU tar 抢在前面，181MB 的 zip 必然装不上"
);
checkTrue(
  "Windows zip 有 PowerShell Expand-Archive 兜底",
  fpSrc.includes("Expand-Archive -LiteralPath")
);
checkTrue(
  "解压后校验目录非空（坏包不能算成功）",
  /assertExtracted\(dir/.test(fpSrc) && /解压后目录为空/.test(fpSrc)
);

// —— 2026-10-03：下载提速三件套（多连接分片 + hosts 优选 IP + 下载中状态）——
const fpHttpSrc = fs.readFileSync(path.join(ROOT, "src", "http-get.js"), "utf8");
const fhSrc = fs.readFileSync(path.join(ROOT, "src", "fast-hosts.js"), "utf8");

checkTrue(
  "下载走并发分片（单连接被TCP 流控卡在 0.5MiB/s，16 线程实测 10MiB/s）",
  /const MAX_PARALLEL_CONNECTIONS = 16/.test(fpSrc) &&
    /function pickConnections\(/.test(fpSrc) &&
    /async function downloadParallel\(/.test(fpSrc) &&
    /function downloadSegment\(/.test(fpSrc) &&
    /downloadParallel\(raw, prefix, dest, total/.test(fpSrc),
  "分片下载器缺失 → 下载速度回到单连接水平（181MB 要 4~5 分钟）"
);
checkTrue(
  "分片下载必须校验 206（服务器无视Range 返回 200 时拼出来全是重复数据）",
  // ⚠️ 必须锚定 downloadSegment 内部那一处：downloadOnce 里本来就有
  // `status !== 200 && status !== 206`（串行路径允许 200），锚太宽会被它顶成假绿。
  /function downloadSegment\([\s\S]{0,900}?if \(res\.status !== 206\)/.test(fpSrc) &&
    /err\.noRange = true/.test(fpSrc)
);
checkTrue(
  "分片失败可续传（分片临时文件按完整长度判定可用）",
  /function listParts\(/.test(fpSrc) && /PART_SUFFIX/.test(fpSrc) &&
    /st\.size === s\.end - s\.start \+ 1/.test(fpSrc)
);
checkTrue(
  "hosts 优选 IP 直连：拉 hosts.json 并把 github.com 固定到优选 IP",
  /hosts\.gitcdn\.top\/hosts\.json/.test(fhSrc) &&
    /function pinnedLookup\(/.test(fhSrc) &&
    // 必须真的被调用（只定义不使用 = 守卫白给）
    /reqOpts\.lookup = pinnedLookup\(o\.ip\)/.test(fpHttpSrc)
);
checkTrue(
  "优选 IP 只接管白名单域名（302 跳到的 release-assets 必须走系统 DNS）",
  /WANTED = \["github\.com", "api\.github\.com"\]/.test(fhSrc) &&
    /!WANTED\.includes/.test(fhSrc)
);
checkTrue(
  "ip-direct 不进 MIRROR_KEYS（与 direct 同为空前缀，登记进去会让 PREFIX_TO_KEY 反查混淆）",
  /const IP_DIRECT = "ip-direct"/.test(fpSrc) &&
    !/const MIRROR_KEYS = \{[^}]*ip-direct/s.test(fpSrc)
);
checkTrue(
  "换域名后自动放弃优选 IP（只对白名单域名生效）",
  /ip = undefined/.test(fpHttpSrc),
  "302 跳到 release-assets.githubusercontent.com 后仍强用 github.com 的 IP → 第二跳连不上"
);
checkTrue(
  "状态接口下发 downloading 标志（否则进度条闪一下就消失：界面只认自己点击的那次）",
  // 两处都要：handler 里推的、类型里声明的；0.14 起 counting 任一 fp 下载控制器
  /downloading:\s*!!\s*\(\s*fingerprintInstallController\s*\|\|\s*fingerprintStagedController\s*\)/.test(
    mainSrcFp
  ) && /downloading\?: boolean/.test(typesSrcFp)
);
checkTrue(
  "状态推送必须在 controller 置空之后（提前推等于告诉界面「还在下载」）",
  // finally 块里 set null 之后才 pushFingerprintStatus
  /fingerprintInstallController = null;[\s\S]{0,600}?pushFingerprintStatus\(\);/.test(mainSrcFp)
);
checkTrue(
  "界面把「后台下载」并入 busy（向导页与设置面板两处，缺一就有一处闪一下就消失）",
  /const downloading = localBusy \|\| !!st\?\.downloading/.test(wizardSrcFp) &&
    /const busy = localBusy \|\| !!st\?\.downloading/.test(panelSrcFp)
);
checkTrue(
  "反例守卫 ⑩：不得依赖 extract-zip / yauzl（lockfile 里是 dev，打包会被剪掉）",
  !/require\("extract-zip"\)/.test(fpSrc) && !/require\("yauzl"\)/.test(fpSrc)
);
checkTrue(
  "就绪判定校验 chrome.dll 是有效 PE（MZ 魔数 + 体积下限），坏 DLL 判未就绪而非启动即崩 0xC1",
  /function isValidPeFile/.test(fpSrc) &&
    /head\[0\] === 0x4d && head\[1\] === 0x5a/.test(fpSrc) &&
    /MIN_DLL_BYTES\s*=\s*64 \* 1024 \* 1024/.test(fpSrc) &&
    /isValidPeFile\(path\.join\(dir, "chrome\.dll"\), MIN_DLL_BYTES\)\) return full;/.test(fpSrc)
);
checkTrue(
  "反例守卫 ⑮：Windows 上坏 DLL 直接 continue（不进 weak，避免退回启动即崩的 chrome.exe）",
  /if \(isValidPeFile\(path\.join\(dir, "chrome\.dll"\), MIN_DLL_BYTES\)\) return full;\s*\n\s*continue;/.test(fpSrc)
);
checkTrue(
  "安装失败时区分「没解出主程序」与「chrome.dll 坏」并给出杀软/重装提示",
  /function hasChromeExe/.test(fpSrc) && /chrome\.dll 缺失或损坏/.test(fpSrc)
);

// —— 下载镜像源可配置（0.10.1）——
checkTrue(
  "镜像源有标识→前缀映射与解析器：auto 走实测排序的全链，指定则只走那一个节点",
  /const MIRROR_KEYS = \{/.test(fpSrc) &&
    /async function resolveMirrors/.test(fpSrc) &&
    /return p === null \? await mirrorsByLatency\(\) : \[p\]/.test(fpSrc)
);
checkTrue(
  "镜像源穿透到下载与探测（downloadAsset / probeTotal 都按配置解析镜像链）",
  // 第五个 opts 是 0.14.5 加的（staged 落盘目录隔离），签名允许带它
  /async function downloadAsset\(version, onProgress, mirror, signal(?:, opts)?\)/.test(fpSrc) &&
    /async function probeTotal\(rawUrl, version, mirror\)/.test(fpSrc) &&
    /probeTotal\(raw, version, mirror\)/.test(fpSrc)
);

// —— 后台下载与手动下载必须落盘到不同目录（0.14.5）——
// 实修背景：两者共用 fp-download 与同一组 .partN，一方的失败清场会删掉另一方
// 正在写的分片（用户日志：ENOENT ... .part0，202MB 白下）。
checkTrue(
  "后台静默下载用独立落盘目录（与手动下载物理隔离，避免互相删分片）",
  /function stagedDownloadDir\(\)/.test(fpSrc) &&
    /sp\.resolve\("fp-download-staged"\)/.test(fpSrc) &&
    /opts && opts\.staged \? stagedDownloadDir\(\) : downloadDir\(\)/.test(fpSrc) &&
    /downloadAsset\(version, \(p\) => report\(p\), mirrorKey, signal, \{ staged: true \}\)/.test(fpSrc)
);

// —— 换源时中止本轮所有分片（0.14.5）——
// Promise.all 只 reject 不取消兄弟分片，旧源僵尸进度会继续上报。
checkTrue(
  "分片并发用本轮共享的 AbortController，失败/换源时 abort 全部（杜绝僵尸进度条）",
  /const roundAc = new AbortController\(\)/.test(fpSrc) &&
    /roundAc\.signal/.test(fpSrc) &&
    // 关键：Promise.all 外面必须包 try/catch，catch 里 abort
    /\} catch \(e\) \{\s*\/\/ 换源\/失败前先掐掉本轮所有还在跑的分片/.test(fpSrc)
);

// —— 闲时判定只看账户任务（0.14.5）——
// running 是泛化忙标志（登录/同步/下载都置它），用它判闲会让内核迟迟不切换。
checkTrue(
  "指纹内核闲时切换只看账户任务（taskRunning），不把登录/同步/下载当忙",
  /let taskRunning = false;/.test(mainSrcFp) &&
    /commitStagedInstall\(\{ isIdle: !taskRunning \}\)/.test(mainSrcFp) &&
    /taskRunning = true;/.test(mainSrcFp) &&
    /taskRunning = false;/.test(mainSrcFp)
);
checkTrue(
  "未知或空的镜像标识一律退回自动链（脏配置不能把下载卡死）",
  /hasOwnProperty\.call\(MIRROR_KEYS, key\)/.test(fpSrc) &&
    /return await mirrorsByLatency\(\);/.test(fpSrc)
);
checkTrue(
  "自动模式按实测延迟排序整条链（含直连 direct），不是写死顺序",
  /async function mirrorsByLatency/.test(fpSrc) &&
    /lat = await mirrorLatency\(\)/.test(fpSrc) &&
    /MIRROR_PREFIXES\.slice\(\)\.sort\(\(a, b\) => rank\(a\) - rank\(b\)\)/.test(fpSrc) &&
    // 直连的前缀是空串，反查表必须原样包含它（一旦被 filter 掉，
    // 直连就查不到延迟 → 永远排末尾，海外用户明明直连最快却轮不到）
    /Object\.entries\(MIRROR_KEYS\)\.map\(\(\[k, v\]\) => \[v, k\]\)/.test(fpSrc)
);
checkTrue(
  "测不到的节点排在末尾而不是被丢弃（全部超时时等价于旧的固定顺序）",
  /MAX_SAFE_INTEGER/.test(fpSrc) && /stable|稳定排序/.test(fpSrc)
);
checkTrue(
  "resolveMirrors 转 async 后调用点都已 await（漏一个会拿到 Promise 而非数组）",
  /await resolveMirrors\(mirror\)/.test(fpSrc) &&
    (fpSrc.match(/await resolveMirrors\(mirror\)/g) || []).length >= 2
);
checkTrue(
  "主进程两处下载都把配置的镜像源传进去（IPC 安装 + 首次运行自动下载）",
  (mainSrcFp.match(/mirror: globalConfig\.get\(\)\?\.browser\?\.fingerprint\?\.mirror/g) || []).length >= 2
);
checkTrue(
  "Web/Docker 版安装同样传配置的镜像源（桌面与容器两处口径一致）",
  /mirror: globalConfig\.get\(\)\?\.browser\?\.fingerprint\?\.mirror/.test(webApiSrcFp)
);
checkTrue(
  "状态接口下发镜像清单（界面下拉不另写一份），且每个节点带实测延迟",
  // 0.13.8 起 Docker 侧改为镜像预装：预装时不必也没法选下载源，直接返回空数组
  // （同时省掉最长 4s 的测速探测，容器启动更快）。非预装路径仍按下发清单渲染下拉。
  /mirrors:\s*pre \? \[\] : await mirrorOptionsWithLatency\(\)/.test(fpSrc) &&
    /async function mirrorLatency/.test(fpSrc) &&
    /latencyMs/.test(fpSrc),
  "镜像清单不再由主进程下发 → 前后端各写一份镜像表，改一处漏一处"
);
checkTrue(
  "反例守卫 ⑯：指定镜像时不得掺入自动链其他节点（否则「指定」失去意义）",
  !/return \[p\]\.concat\(MIRROR_PREFIXES\)/.test(fpSrc)
);
// —— 镜像源默认值：六处必须同值，且必须是 MIRROR_KEYS 里登记过的节点 ——
// 这几处一旦漂移，界面显示的「当前源」和主进程实际用的源就不是同一个，
// 排查起来极费劲（本项目已踩过「旧配置缺新字段 → 白屏」的同类坑）。
const fpDefaultMirror = (fpSrc.match(/const DEFAULT_MIRROR = "([^"]+)"/) || [])[1] || null;
const cfgDefaultMirror = (cfgSrcFp.match(/mirror: "([^"]+)"/) || [])[1] || null;
const gcfgDefaultMirror = (gcfgSrcFp.match(/mirror: "([^"]+)"/) || [])[1] || null;
const mockDefaultMirror = (mockSrcFp.match(/mirror: "([^"]+)"/) || [])[1] || null;
const panelDefaultMirror = (panelSrcFp.match(/mirror:\s*"([^"]+)"/) || [])[1] || null;
const wizardDefaultMirror =
  (wizardSource.match(/const \[mirror, setMirror\] = useState\("([^"]+)"\)/) || [])[1] || null;
const runtimeDefaultMirror = globalDefaults?.browser?.fingerprint?.mirror || null;
const mirrorDefaultPlaces = [
  ["src/fingerprint-browser.js (DEFAULT_MIRROR)", fpDefaultMirror],
  ["src/config.js", cfgDefaultMirror],
  ["src/global-config.js", gcfgDefaultMirror],
  ["渲染层 api/mock.ts", mockDefaultMirror],
  ["面板 FALLBACK", panelDefaultMirror],
  ["向导 useState", wizardDefaultMirror],
  ["运行时 GLOBAL_DEFAULTS", runtimeDefaultMirror],
];
const mirrorDefaultValues = mirrorDefaultPlaces.map(([, v]) => v);
checkTrue(
  `镜像源默认值六处一致（当前 ${fpDefaultMirror || "(未取到)"}）`,
  fpDefaultMirror !== null &&
    mirrorDefaultValues.every((v) => v === fpDefaultMirror) &&
    wizardDefaultMirror !== null
);
checkTrue(
  "镜像源默认值必须是 MIRROR_KEYS 里登记过的键（防止改成未登记域名 → 静默走兜底链）",
  !!fpDefaultMirror &&
    new RegExp(`["']?${escapeRegExp(fpDefaultMirror)}["']?:`).test(
      (fpSrc.match(/const MIRROR_KEYS = \{([\s\S]*?)\n\};/) || ["", ""])[1]
    )
);
checkTrue(
  "类型定义 browser.fingerprint 含 mirror，状态类型含可选 mirrors",
  /mirror: string;/.test(typesSrcFp) && /mirrors\?:/.test(typesSrcFp)
);
checkTrue(
  "环境拟真浏览器面板有「下载镜像源」下拉，选项来自主进程下发的 mirrors",
  /下载镜像源/.test(panelSrcFp) && /options=\{st\?\.mirrors \|\| \[\]\}/.test(panelSrcFp)
);

// —— 向导末页：环境拟真浏览器下载（0.10.1 起；0.13.8 起 Docker 版删除本页）——
checkTrue(
  "向导末页是环境拟真浏览器下载页：桌面版保留（6 步），Web/Docker 版删除（5 步，镜像已预装）",
  /const STEPS = IS_WEB/.test(wizardSource) &&
    /"个性化", "环境特征"\]/.test(wizardSource) &&
    /function PageFingerprint/.test(wizardSource) &&
    /!IS_WEB && page === 5 && <PageFingerprint/.test(wizardSource) &&
    !/\{page === 5 && <PageFingerprint/.test(wizardSource),
  "Web 版仍渲染环境特征下载页 → 让用户在容器里下载一个已经预装好的浏览器；或桌面版被误删 → 桌面用户失去可选增强入口"
);
checkTrue(
  "跳过可直接放行、未跳过必须等下载完成，放行条件由页内上报给页脚",
  /const canProceed = skip \|\| !supported \|\| \(!!st && st\.ready\)/.test(wizardSource) &&
    /onCanProceed\(canProceed\)/.test(wizardSource) &&
    /disabled=\{!fpCanProceed\}/.test(wizardSource)
);
checkTrue(
  "平台不支持（macOS）时强制放行，不得把用户卡死在末页",
  /const supported = st \? st\.supported : true/.test(wizardSource)
);
checkTrue(
  "下载按钮在左、进度在右，点击后后台执行且实时回推进度",
  /className="wz-fp-act"/.test(wizardSource) &&
    /className="wz-fp-prog"/.test(wizardSource) &&
    /className="wz-dl"/.test(wizardSource) &&
    /api\.onInstallProgress/.test(wizardSource)
);
checkTrue(
  "向导拟真页有左按钮右进度的布局样式（进度文案单行截断不挤按钮）",
  /\.wz-fp-act/.test(cssSrcFp) &&
    /\.wz-fp-prog/.test(cssSrcFp) &&
    /text-overflow: ellipsis/.test(cssSrcFp)
);
checkTrue(
  "反例守卫 ⑰：末页放行条件不得只看 enable（启用未下载完成时不能放行）",
  !/const canProceed = !enable;/.test(wizardSource) &&
    !/const canProceed = enable && !!st && st\.ready;/.test(wizardSource)
);

// —— 向导末页 v2：跳过开关 + 置灰内容 + 加速源（0.10.1）——
checkTrue(
  "向导末页为「跳过复选框 + 置灰内容区」：勾选跳过则不下载、内容禁用",
  /data-testid="fp-skip"/.test(wizardSource) &&
    /wz-fp-body\$\{skip \? " is-off" : ""\}/.test(wizardSource) &&
    /\.wz-fp-body\.is-off/.test(cssSrcFp)
);
checkTrue(
  "向导末页可选加速源（下拉含各节点实测延迟）并有「立即下载」按钮",
  /id="fp-mirror"/.test(wizardSource) &&
    /className="wz-fp-sel"/.test(wizardSource) &&
    /pickMirror/.test(wizardSource) &&
    /立即下载/.test(wizardSource) &&
    /\.wz-fp-sel/.test(cssSrcFp)
);
checkTrue(
  "反例守卫 ㉑：置灰态必须靠 CSS 类而非条件卸载（否则布局会跳）",
  !/skip && \(\s*<div className="wz-fp-row"/.test(wizardSource)
);

// —— 重新下载语义（0.10.1）——
checkTrue(
  "设置页「重新下载」在已就绪时传 force=true（真正清除后重装）",
  /onClick=\{\(\) => \(busy \? void onCancelInstall\(\) : void onInstall\(!!st\?\.ready\)\)\}/.test(panelSrcFp) &&
    /取消下载/.test(panelSrcFp) &&
    /重新下载/.test(panelSrcFp)
);
checkTrue(
  "反例守卫 ⑱：重新下载不得恒传 force=false（否则命中「已是最新版本」而无法修复）",
  !/onClick=\{\(\) => void onInstall\(false\)\}/.test(panelSrcFp)
);
checkTrue(
  "force 重装时清空解压目录与下载缓存（不复用可能已损坏的分片）",
  /if \(o\.force\) \{/.test(fpSrc) &&
    /fs\.rmSync\(installDir\(CURRENT_ENGINE\), \{ recursive: true, force: true \}\)/.test(fpSrc) &&
    /fs\.rmSync\(downloadDir\(\), \{ recursive: true, force: true \}\)/.test(fpSrc)
);

// —— 下载完整性校验（0.10.1）——
checkTrue(
  "下载完做完整性校验：取上游官方 sha256（Releases API digest）并流式比对",
  /hit\.digest/.test(fpSrc) &&
    /sha256File/.test(fpSrc) &&
    /actual !== meta\.sha256/.test(fpSrc)
);
checkTrue(
  "反例守卫 ⑲：完整性校验不通过必须 throw（不是打个日志就放行）",
  /err\.integrity = true;[\s\S]{0,80}throw err;/.test(fpSrc)
);
checkTrue(
  "反例守卫 ㉒：probeTotal 不得在 HEAD 成功后提前返回 null 哈希（digest 必须无条件取）",
  !/return \{ total: n, sha256: null \};/.test(fpSrc) &&
    /const \[byHead, byApi\] = await Promise\.all/.test(fpSrc) &&
    /sha256: byApi\.sha256/.test(fpSrc)
);
checkTrue(
  "镜像下拉带延迟：status 下发的 mirrors 每个节点含 latencyMs",
  /async function mirrorLatency/.test(fpSrc) &&
    /latencyMs: ms/.test(fpSrc) &&
    /latencyMs\?: number \| null/.test(typesSrcFp)
);

// —— 侧边栏拟真状态（0.10.1）——
// 自己读一份 Sidebar 源码：下方同名变量声明在更后面，用它会踩 const 的 TDZ
const sidebarSrcFp = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "components", "Sidebar.tsx"),
  "utf8"
);
checkTrue(
  "侧边栏显示环境拟真浏览器状态，下载中显示百分比 + 进度条",
  /onFingerprintStatus/.test(sidebarSrcFp) &&
    /环境拟真浏览器 \$\{/.test(sidebarSrcFp) &&
    /nav-install-fill/.test(sidebarSrcFp)
);
checkTrue(
  "反例守卫 ⑳：拟真进度必须按 stage 分流，不得混入 Chromium 进度",
  /if \(p\.stage === "fingerprint" \|\| p\.stage === "fingerprint\/download"\) setFpProg\(p\);/.test(
    sidebarSrcFp
  )
);
checkTrue(
  "预览端拟真进度同样带 stage=fingerprint（否则侧边栏徽章串台）",
  /emitFpProgress\(\{ stage: "fingerprint"/.test(mockSrcFp)
);

// —— CSS 结构完整性（0.10.1）——
// liquidGlassCompat.css 的首行曾是被**截断的规则残片**（`.friend-actions` 的选择器与
// 前半段声明在迁移时丢了，只剩尾部 49 字节 + 一个游离的 `}`）。这类损坏构建**照样成功**：
// 打包器只打一条 `Unexpected ";"` 警告、把顶层那条声明整条丢掉，产物里完全看不出来。
// 用「括号配平 + 顶层不得出现分号（@import 等 at-rule 除外）」把它锁死。
const cssStructureOk = (rel) => {
  const src = fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");
  const t = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  let depth = 0;
  let stmtStart = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth < 0) return false;
      stmtStart = i + 1;
    } else if (c === ";" && depth === 0) {
      // 顶层分号只允许结束 at-rule（@import / @charset …）
      if (!t.slice(stmtStart, i).trim().startsWith("@")) return false;
    }
  }
  return depth === 0;
};
checkTrue(
  "补位层 CSS 结构合法（无顶层游离分号 / 括号配平）—— 截断的规则残片会被打包器静默丢弃",
  cssStructureOk("src-renderer/src/components/liquidGlassCompat.css")
);
checkTrue("global.css 结构合法（无顶层游离分号 / 括号配平）", cssStructureOk("src-renderer/src/styles/global.css"));

// —— 种子与启动参数 ——
checkTrue(
  "环境特征按账户派生种子（FNV-1a，32 位无符号）",
  /0x811c9dc5/.test(fpSrc) && />>> 0/.test(fpSrc) && /function seedFor/.test(fpSrc)
);
checkTrue(
  "启动参数带种子与平台/品牌",
  /--fingerprint=\$\{opts\.seed >>> 0\}/.test(fpSrc) &&
    /--fingerprint-platform=/.test(fpSrc) &&
    /--fingerprint-brand=/.test(fpSrc)
);
checkTrue(
  "反例守卫 ⑪：buildArgs 不得下发 user-agent（UA 必须与 CH 同源）",
  !/user-agent/i.test(fpSrc.slice(fpSrc.indexOf("function buildArgs")))
);
checkTrue(
  "反例守卫 ⑫：不下发已随 Chrome 144 移除的 GPU 参数",
  !/--fingerprint-gpu-vendor/.test(fpSrc) && !/--fingerprint-gpu-renderer/.test(fpSrc)
);

// —— 与 stealth 的互斥 ——
checkTrue(
  "stealth 有 __MSR_FP 守卫，拟真模式下让出语言/插件与硬件信息",
  /const FP = !!window\.__MSR_FP/.test(stealthSrcFp) &&
    (stealthSrcFp.match(/if \(FP\) return;/g) || []).length >= 2
);
checkTrue(
  "WebGL 补丁把 vendor / renderer 成对替换（不再各判各的）",
  /p !== 37445 && p !== 37446/.test(stealthSrcFp) && /p === 37445 \? VENDOR : RENDERER/.test(stealthSrcFp)
);

// —— browser.js 来源优先级 ——
checkTrue(
  "browser.js 有来源优先级解析并导出",
  /function resolveBrowserSource/.test(browserSrcFp) && /^\s*resolveBrowserSource,$/m.test(browserSrcFp)
);
// 优先级顺序是本块最容易改错的地方：把「系统兜底」挪到环境拟真浏览器之前，
// Docker 里环境拟真浏览器就永远轮不到（下载了也不用），而桌面端完全看不出来。
const rbBody = browserSrcFp.slice(browserSrcFp.indexOf("function resolveBrowserSource"));
checkTrue(
  "优先级顺序：运维强指定 > 环境拟真浏览器 > 系统兜底 > Playwright 自带",
  /kind: "override"/.test(browserSrcFp) &&
    /kind: "fingerprint"/.test(browserSrcFp) &&
    /kind: "chromium"/.test(browserSrcFp) &&
    rbBody.indexOf('kind: "override"') < rbBody.indexOf('kind: "fingerprint"') &&
    rbBody.indexOf('kind: "fingerprint"') < rbBody.indexOf("fallbackChromiumPath") &&
    rbBody.indexOf("fallbackChromiumPath") < rbBody.indexOf("bundledChromiumPath")
);
checkTrue(
  "环境拟真浏览器不可用时静默回落（不打断登录流程）",
  /已启用环境拟真浏览器但不可用/.test(browserSrcFp) && /本轮回落到普通 Chromium/.test(browserSrcFp)
);
checkTrue(
  "拟真模式下不覆盖 UA（否则回到 UA 与 CH 自相矛盾的死路）",
  /环境拟真浏览器/.test(browserSrcFp) && /launchOpts\.userAgent = stealth\.STEALTH_USER_AGENT/.test(browserSrcFp) &&
    /if \(isFp\) \{/.test(browserSrcFp)
);
checkTrue(
  // 与上面那条配套：拟真模式不但不注入，连「补丁是否生效」都不该再由我们负责 ——
  // webdriver / plugins / platform / WebGL 全由 --fingerprint 种子原生生成。
  "拟真模式零 JS 补丁注入（webdriver 等原生即正确，注入反而自曝）",
  /if \(!isFp\) \{/.test(browserSrcFp) &&
    !browserSrcFp.includes('"window.__MSR_FP = true;\\n" + stealth.STEALTH_INIT') &&
    !/\binitSrc\b/.test(browserSrcFp)
);
checkTrue(
  // 实测（容器内 fingerprint-chromium 148）：GPU 进程默认起不来 → WebGL 整个不可用
  // （GL_VENDOR = Disabled / BindToCurrentSequence failed），环境拟真浏览器连伪造 GPU 的
  // 机会都没有，环境一致性自检 的 WebGL Vendor / Renderer 两项直接判红。
  // 补 --disable-gpu-sandbox 后 GPU 进程正常启动，WebGL 恢复并上报种子生成的 Windows GPU。
  "Linux 拟真模式自动补 --disable-gpu-sandbox（否则 GPU 进程起不来 → WebGL 全废）",
  /process\.platform === "linux" && !launchOpts\.args\.includes\("--disable-gpu-sandbox"\)/.test(browserSrcFp) &&
    /launchOpts\.args\.push\("--disable-gpu-sandbox"\)/.test(browserSrcFp)
);
checkTrue(
  "对 --disable-gpu 显式告警（它会让 WebGL 永久不可用，是环境拟真上的自伤）",
  /启动参数含 --disable-gpu/.test(browserSrcFp)
);

// —— 配置层对齐（防白屏：两处默认值必须同字段） ——
// 为什么盯得这么死：旧 global-config.json 缺新字段时，渲染层读 undefined 会抛
// TypeError → 白屏。而白屏只在「升级安装」这条路上出现，开发机上全新安装永远复现不了。
function browserFpBlock(src) {
  const i = src.indexOf("browser: {");
  return i < 0 ? "" : src.slice(i, i + 900);
}
const cfgFpBlock = browserFpBlock(cfgSrcFp);
const gcfgFpBlock = browserFpBlock(gcfgSrcFp);
// platform 是 0.13.9 新增：声明给网站的操作系统（默认 windows）。
// 不跟 process.platform 的原因见 src/browser.js 里 fingerprintCfg 的注释。
const FP_FIELDS = ["enable", "seed", "brand", "hardwareConcurrency", "platform", "mirror"];
for (const [label, block] of [["config.js", cfgFpBlock], ["global-config.js", gcfgFpBlock]]) {
  const missing = FP_FIELDS.filter((f) => !new RegExp(`\\b${f}:`).test(block));
  checkTrue(
    `${label} 的 browser.fingerprint 六个字段齐全（${FP_FIELDS.join("/")}）`,
    block.includes("fingerprint: {") && missing.length === 0,
    `缺字段：${missing.join(", ")}`
  );
}
// 渲染层契约同样要对齐：types/index.ts 是编译期，api/mock.ts 是 npm run dev:web 预览期，
// 两者漏字段分别表现为「tsc 报错」与「预览白屏」，都由这条守卫兜住。
//
// ⚠️ 必须把范围锁在 browser.fingerprint 类型块内：FingerprintStatus 接口里也有一行
// 同名的 `platform: string;`（那是「当前运行平台」），全局扫会假绿 —— 删掉配置侧的
// platform 照样通过，白屏照旧发生。
const typesFpBlock = (() => {
  const i = typesSrcFp.indexOf("fingerprint: {");
  return i < 0 ? "" : typesSrcFp.slice(i, i + 900);
})();
checkTrue(
  "types/index.ts 的 browser.fingerprint 类型含 platform（渲染层编译期契约）",
  /\bplatform: string;/.test(typesFpBlock),
  "缺 platform → tsc 直接失败，且预览模式拿不到该字段"
);
checkTrue(
  'api/mock.ts 的 fingerprint 默认值含 platform: "windows"',
  /fingerprint: \{[^}]*platform: "windows"/.test(mockSrcFp),
  "mock 缺 platform → npm run dev:web 预览时该下拉框无值"
);

// —— IPC / 适配层 ——
for (const [label, src, keys] of [
  ["electron-main", mainSrcFp, ["app:fingerprintStatus", "app:installFingerprint", "app:uninstallFingerprint", "app:checkFingerprintUpdate", "function pushFingerprintStatus"]],
  ["electron-preload", preloadSrcFp, ["fingerprintStatus:", "installFingerprint:", "uninstallFingerprint:", "checkFingerprintUpdate:", "onFingerprintStatus:"]],
  ["web-api", webApiSrcFp, ["fingerprintStatus()", "installFingerprint(", "uninstallFingerprint()", "checkFingerprintUpdate()"]],
  ["web.ts", webTsSrcFp, ['"fingerprintStatus"', '"fingerprint-status"', "onFingerprintStatus:", '"checkFingerprintUpdate"']],
  ["mock.ts", mockSrcFp, ["checkFingerprintUpdate:"]],
]) {
  const missing = keys.filter((k) => !src.includes(k));
  checkTrue(`${label} 接线完整（${keys.length} 处）`, missing.length === 0, missing.join(", "));
}
checkTrue(
  "软件设置页挂载环境拟真浏览器面板",
  /FingerprintBrowserPanel/.test(softwareViewSrcFp) && /<FingerprintBrowserPanel/.test(softwareViewSrcFp)
);
// 0.9.4.19 增补：软件设置左侧分类选项卡（点击定位 + scroll-spy + 返回）
const sidebarSrcSw = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "components", "Sidebar.tsx"), "utf8");
const appSrcSw = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "App.tsx"), "utf8");
checkTrue(
  "软件设置分类选项卡接线：Sidebar 有选项卡分支与返回，App 有点击定位 + 加锁 scroll-spy，分区 id 规约一致",
  /SW_TABS/.test(sidebarSrcSw) && /onSwSectionClick/.test(sidebarSrcSw) && /nav-back/.test(sidebarSrcSw) &&
    /handleSwSectionClick/.test(appSrcSw) && /handleSwSpy/.test(appSrcSw) &&
    /scrollIntoView/.test(appSrcSw) && /swScrollLockRef/.test(appSrcSw) &&
    /swsec-/.test(softwareViewSrcFp) && /onSpySec/.test(softwareViewSrcFp)
);
checkTrue(
  "侧边栏左下角版本号走 version.ts 的 DISPLAY_VERSION",
  /DISPLAY_VERSION/.test(sidebarSrcSw)
);
// JSX 注释闭合写成 */}"（多一个引号）会把 "}" 当成文本节点渲染到界面上，
// 而tsc / vite 都不报错——实测2026-10-03 侧边栏底部多出一坨「。。」。
// 这类"编译期静默、运行期可见"的错误只能靠正则拦。
checkTrue(
  "JSX 注释闭合后没有多余引号（否则多出 '\"}' 文本节点，tsc 查不出）",
  !/\*\/\s*"\s*\}/.test(sidebarSrcSw),
  'Sidebar.tsx 里出现 */"} —— 会把 "}" 渲染成文本'
);

// —— 主导航分组顺序（2026-10-03 用户调整）——
//   工作台：仪表盘 → 账户详情 → 任务全局设置 → 成就与统计（成就移到设置下面）
//   其它  ：软件设置 → 关于（软件设置移到其它、且在关于上面）
const navGroupsM = sidebarSrcSw.match(/const NAV_GROUPS[\s\S]*?\n\];/);
const navSrc = navGroupsM ? navGroupsM[0] : "";
const navOrder = [...navSrc.matchAll(/key:\s*"([a-z]+)"/g)].map((m) => m[1]);
checkTrue(
  "主导航顺序：仪表盘 → 账户详情 → 任务全局设置 → 成就与统计 → 软件设置 → 关于",
  JSON.stringify(navOrder) ===
    JSON.stringify(["dashboard", "account", "settings", "achievements", "software", "about"]),
  `实际顺序 ${navOrder.join(" → ")}`
);
// 成就必须排在任务全局设置之后；软件设置必须在「其它」组、且先于关于
const iSettings = navOrder.indexOf("settings");
const iAchv = navOrder.indexOf("achievements");
const iSoftware = navOrder.indexOf("software");
const iAbout = navOrder.indexOf("about");
checkTrue(
  "成就与统计排在任务全局设置之后",
  iSettings >= 0 && iAchv > iSettings,
  `settings=${iSettings} achievements=${iAchv}（要求 achievements 在后）`
);
checkTrue(
  "软件设置排在关于之前（同属「其它」组）",
  iSoftware >= 0 && iAbout >= 0 && iSoftware < iAbout,
  `software=${iSoftware} about=${iAbout}（要求 software 在前）`
);

// —— 深浅模式：固定深色（2026-10-03 用户要求，浅色不生效且不好看）——
const themeSrc21 = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "hooks", "useTheme.ts"),
  "utf8"
);
checkTrue(
  "useTheme 强制返回 dark（不再解析 mode / autoTheme）",
  /const resolved:\s*"dark"\s*\|\s*"light"\s*=\s*"dark"/.test(themeSrc21) &&
    /setAttribute\(\s*["']data-theme["']/.test(themeSrc21),
  "useTheme 仍会解析出浅色 → 与「统一深色」冲突"
);
// 解析函数签名已改成忽略参数（下划线前缀），防止有人又接回 mode
checkTrue(
  "useTheme 参数改为忽略（_mode/_autoTheme），避免误接回浅色",
  /_mode:\s*ThemeMode\s*\|\s*undefined/.test(themeSrc21) &&
    /_autoTheme:\s*boolean/.test(themeSrc21),
  "useTheme 仍在使用 mode/autoTheme 参数"
);
// 界面上不能再有深浅模式切换（Personalize 已移除该 block）
const personalizeSrc21 = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "views", "Personalize.tsx"),
  "utf8"
);
checkTrue(
  "外观设置页不再渲染深浅模式切换与「跟随壁纸自动反色」",
  !/aria-label="深浅模式"/.test(personalizeSrc21) &&
    !/aria-label="跟随壁纸自动反色"/.test(personalizeSrc21),
  "Personalize.tsx 仍有深浅模式控件（用户要求隐藏）"
);
checkTrue(
  "前端类型补齐 FingerprintStatus / InstallFingerprintResult",
  /interface FingerprintStatus/.test(typesSrcFp) && /interface InstallFingerprintResult/.test(typesSrcFp)
);

/* ---------------- Docker 版接线（0.10.1 后增补；0.13.8 起改为环境拟真浏览器独占） ----------------
 * 历史坑（各锁一条守卫）：
 *   ① 早期 compose 用 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 把容器 Chromium 钉死（优先级最高）
 *   ② 镜像没装 xz-utils，GNU tar 解 .tar.xz 直接 exit 127
 *   ③ 中期改用 MS_REWARDS_CHROMIUM_FALLBACK 兜底 —— 但那是「可选增强」时代的做法，
 *      0.13.8 起 Docker 改为「环境拟真浏览器独占 + 镜像预装」，兜底变量本身也已废弃。
 */
const dockerfileSrc = fs.readFileSync(path.join(ROOT, "docker", "Dockerfile"), "utf8");
const composeSrc = fs.readFileSync(path.join(ROOT, "docker", "docker-compose.yml"), "utf8");
checkTrue(
  "Dockerfile 装 xz-utils（Linux 版环境拟真浏览器是 .tar.xz，GNU tar 需外部 xz）",
  // 断言必须是「独立成一行的 apt 列表项」：注释里也会出现 xz-utils 三个字，
  // 用 /xz-utils/ 或 [^;]* 跨行匹配都会被注释蒙混，漏掉「从 apt 列表里删掉」这种真故障。
  /^\s*xz-utils\b/m.test(dockerfileSrc) && /xz --version/.test(dockerfileSrc)
);
checkTrue(
  "Docker 侧不再用兜底 Chromium：环境拟真浏览器独占，compose 不传已废弃的兜底变量",
  !/MS_REWARDS_CHROMIUM_FALLBACK/.test(dockerfileSrc) &&
    !/MS_REWARDS_CHROMIUM_FALLBACK/.test(composeSrc) &&
    !/^\s*PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH[=:]/m.test(dockerfileSrc) &&
    !/^\s*PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH[=:]/m.test(composeSrc),
  "仍留兜底 Chromium → 它优先级高于环境拟真浏览器，Docker「默认用环境拟真浏览器」的目标直接落空"
);
// 只从环境变量的**取值**里判定，不扫整份文件 —— 注释里写「不要用 --disable-gpu」
// 也会被裸正则命中（这条守卫自己踩过），所以先取出值再判。
const chromiumArgsOf = (src) => ((src.match(/MS_REWARDS_CHROMIUM_ARGS[=:]\s*"?([^"\n]*)"?/) || [])[1] || "");
const dfArgs = chromiumArgsOf(dockerfileSrc);
const cpArgs = chromiumArgsOf(composeSrc);
checkTrue(
  "Docker 的 Chromium 参数不含 --disable-gpu 且带 --disable-gpu-sandbox（WebGL 必须可用）",
  // 负向先行断言是必须的：合法值 `--disable-gpu-sandbox` 本身就以 `--disable-gpu` 开头，
  // 裸 /--disable-gpu/ 会把它误判成违规。
  /--disable-gpu-sandbox/.test(dfArgs) &&
    /--disable-gpu-sandbox/.test(cpArgs) &&
    !/--disable-gpu(?!-sandbox)/.test(dfArgs) &&
    !/--disable-gpu(?!-sandbox)/.test(cpArgs),
  `带 --disable-gpu → WebGL 整个不可用，环境一致性自检页 直接判 WebGL Vendor/Renderer 两项失败；缺 --disable-gpu-sandbox → 容器里 GPU 进程起不来，WebGL 同样不可用（Dockerfile="${dfArgs}" / compose="${cpArgs}"）`
);
checkTrue(
  "Web 端 installFingerprint 把下载进度转发到 SSE（否则侧边栏徽章在 Web 版永远 0%）",
  /onProgress: \(p\) => emit\("install-progress", p\)/.test(webApiSrcFp)
);
checkTrue(
  "compose 镜像用 ghcr latest 且带 watchtower.enable 标签（配合 Watchtower 自动更新）",
  /image:\s*ghcr\.io\/zefeng1236\/ms-rewards-auto:latest/.test(composeSrc) &&
    /com\.centurylinklabs\.watchtower\.enable:\s*"true"/.test(composeSrc),
  "镜像退回固定版本 tag 或丢了 watchtower 标签 → Watchtower 无法自动更新，用户停在旧版不自知"
);
checkTrue(
  "compose 有 watchtower 服务（label-enable 只更新 ms-rewards，不误伤同宿主其他容器）",
  /^  watchtower:/m.test(composeSrc) &&
    /containrrr\/watchtower/.test(composeSrc) &&
    /WATCHTOWER_LABEL_ENABLE:\s*"true"/.test(composeSrc),
  "缺 watchtower 服务 → Docker 版失去自动更新能力"
);
// 虚拟桌面尺寸：换了 KasmVNC 之后瓶颈 3（noVNC 纯 JS 解码器）没了，
// 可以放心提回 1920x1080。KasmVNC 自带 WebP/QOI 编码 + 浏览器原生解码，
// 1080p 是默认也能吃下的尺寸。
const dispW = Number((composeSrc.match(/DISPLAY_WIDTH:\s*(\d+)/) || [])[1] || 0);
const dispH = Number((composeSrc.match(/DISPLAY_HEIGHT:\s*(\d+)/) || [])[1] || 0);
checkTrue(
  `KasmVNC 虚拟桌面分辨率 ≥ 1920x1080（当前 ${dispW}x${dispH}）`,
  dispW >= 1920 && dispH >= 1080
);
checkTrue(
  "有头模式不写死视口 + 窗口最大化（写死会让窗口超出虚拟桌面，页面显示不全）",
  /viewport:\s*headless\s*\?\s*\{[^}]*\}\s*:\s*null/.test(browserSrcFp) &&
    /--start-maximized/.test(browserSrcFp)
);

/* ---------------- 内置 KasmVNC（替代 Xvfb+x11vnc+websockify+novnc 四件套） ----------------
 * 上一版用 4 进程：跨容器 X11 走 TCP、noVNC 纯 JS 解码，1080p 必卡。
 * 现版 1 进程 Xkasmvnc = X server + VNC server + Web UI 三合一：
 *   - framebuffer 直出（不经 X11 协议传输）
 *   - 浏览器原生 WebP 解码
 *   - DRI3 GPU 加速（NAS 上 AMD/Intel 核显）
 * 这组守卫锁住它就在本容器内、且关键参数没退化。
 */
const novncSrc = fs.readFileSync(path.join(ROOT, "docker", "novnc-stack.sh"), "utf8");
const entrySrc = fs.readFileSync(path.join(ROOT, "docker", "entrypoint.sh"), "utf8");
const kasmYamlSrc = fs.readFileSync(path.join(ROOT, "docker", "kasmvnc.yaml"), "utf8");
checkTrue(
  "镜像装 KasmVNC（deb 下载、关键依赖和 Xkasmvnc 可执行）",
  /Xkasmvnc/.test(dockerfileSrc) &&
    /curl [^\n]*-fsSL -o \/tmp\/kasmvnc\.deb/.test(dockerfileSrc) &&
    /kasmvncserver_bookworm/.test(dockerfileSrc) &&
    /KASMVNC_PROXY/.test(dockerfileSrc) &&
    /\"\$\{KASMVNC_PROXY\}\$\{KASMVNC_URL\}\"/.test(dockerfileSrc) &&
    /^\s*libunwind8\s*\\/m.test(dockerfileSrc) &&
    /^\s*ssl-cert\s*\\/m.test(dockerfileSrc)
);
checkTrue(
  "Dockerfile apt 安装层在清理列表后正确续行（避免 ln 被解析成 Docker 指令）",
  dockerfileSrc.split("\n").some((line, index, lines) =>
    line.includes("rm -rf /var/lib/apt/lists/*; \\") &&
    lines[index + 1]?.includes("ln -snf /usr/share/zoneinfo/")
  )
);
// 旧的四件套必须全删：Xvfb + x11vnc + websockify + novnc
// （用「键入 apt 列表」的精确匹配 —— 注释里也会提到这些词，全文匹配会假阴性）
// 注意 fluxbox 不在禁用列表里：KasmVNC 需要它当常驻 WM（见下方 xstartup 守卫），
// 空 xstartup 会被包装器判定「会话结束」→ shutting down server → 误报 deadlocked 杀掉。
checkTrue(
  "旧图形栈四件套已从 apt 列表清干净（xvfb / x11vnc / websockify / novnc）",
  !["xvfb", "x11vnc", "websockify", "novnc"].some((p) =>
    new RegExp(`^\\s*${p}\\b`, "m").test(dockerfileSrc)
  )
);
checkTrue(
  "compose 不再有独立 novnc 容器（跨容器 X11 走 TCP + 共享内存失效）",
  !/^\s{2}novnc:/m.test(composeSrc) && !/ms-rewards-novnc/.test(composeSrc) && !/theasp\/novnc/.test(composeSrc)
);
// ⚠️ 参数断言必须落在**真实命令行**上，不能全文匹配：
//    这些参数在脚本的注释里也各写了一份（解释为什么加），全文匹配会被注释蒙混。
//    所以取「命令起始标记之后」的片段再断言。
const afterMarker = (src, marker) => src.split(marker)[1] || "";
const kasmCmd = afterMarker(novncSrc, "nohup /usr/bin/kasmvncserver");
checkTrue(
  "KasmVNC 官方包装器走明文 6080（容器里没有 CA 证书，要求 SSL 会启动失败）",
  kasmCmd.includes("-websocketPort 6080") &&
    /websocket_port:\s*6080/.test(kasmYamlSrc) &&
    /require_ssl:\s*false/.test(kasmYamlSrc)
);
checkTrue(
  "KasmVNC 使用官方包装器并显式指定常驻 xstartup（exec fluxbox 兜底，否则会误报 deadlocked）",
  kasmCmd.includes("-xstartup /home/node/.vnc/xstartup") && !kasmCmd.includes("-noxstartup") &&
    kasmCmd.includes("-prompt 0") &&
    /server:\s*\n\s*http:\s*\n[\s\S]*httpd_directory:\s*\/usr\/share\/kasmvnc\/www/.test(kasmYamlSrc)
);
// KasmVNC 三层根因之一：logging 三个键必须全有或全无，只写 level 会 config errors 直接退出。
checkTrue(
  "kasmvnc.yaml logging 三键齐全（log_writer_name / log_dest / level，缺一会 config errors）",
  /log_writer_name:\s*all/.test(kasmYamlSrc) &&
    /log_dest:\s*logfile/.test(kasmYamlSrc) &&
    /level:\s*30/.test(kasmYamlSrc)
);
// KasmVNC 三层根因之二：即使 require_ssl:false，包装器仍无条件读 ssl-cert-snakeoil.key，
// node 必须加入 ssl-cert 组才能进 /etc/ssl/private（否则 KEY_UNREADABLE → exit 1）。
checkTrue(
  "Dockerfile 把 node 加入 ssl-cert 组（require_ssl 关闭时仍要读 snakeoil key）",
  /usermod -aG ssl-cert node/.test(dockerfileSrc)
);
// KasmVNC 三层根因之三：xstartup 必须常驻（exec fluxbox），且标记 DE 已选择。
checkTrue(
  "预建 xstartup（exec fluxbox）与 .de-was-selected 标记，避免空会话被判定结束",
  /printf '.*exec fluxbox.*/.test(dockerfileSrc) &&
    /exec fluxbox/.test(dockerfileSrc) &&
    /\.de-was-selected/.test(dockerfileSrc) &&
    /^\s*fluxbox\s*\\/m.test(dockerfileSrc)
);
checkTrue(
  "Dockerfile 移除 Debian Fluxbox 主题的壁纸声明（避免 fbsetbg 弹 xmessage）",
  /sed -i '\/\^background:\[\[:space:\]\]\/d; \/\^background\[\.\]pixmap:\/d' \/usr\/share\/fluxbox\/styles\/Squared_for_Debian\/theme\.cfg/.test(dockerfileSrc)
);
checkTrue(
  "KasmVNC 配置启用 GPU DRI3 加速节点（NAS 上有 /dev/dri/renderD128 即可走 VAAPI）",
  /drinode:\s*\/dev\/dri\/renderD128/.test(kasmYamlSrc) &&
    /gpu:\s*\n\s*hw3d:/.test(kasmYamlSrc) &&
    !/^\s*intel-media-va-driver-non-free\b/m.test(dockerfileSrc)
);
// 「页面白块」历史：默认视频编码模式（变化面积≥45%持续5s → H.264/WebP 有损视频流）
// 在无真实 VAAPI 的 VM 容器里软编码跟不上，浏览器端残留白块且页面静止后不再发全量刷新，
// 曾按官方 Extreme 预设「有效禁用」（100%/100s）。
// 但无损分块链路依赖 WebP/QOI（WASM 解码器受 COEP 头影响），部分浏览器渲染异常；
// 折中阈值（70%/8s）又会在静止 3s 后退出回图像模式，问题依旧。
// 2026-09-24 改为**常驻视频模式**：enter 1%/1s + exit 100s + 30fps + h264。
// ⚠️ exit 值域上限实测 = 100：Xvnc 1.5.0 对 VideoOutTime 做值域校验，110 起拒绝，
//    且报错是误导性的 "Unrecognized option: -VideoOutTime"（实测 3600/600/120 全中），
//    图形栈会启动即死、6080 无监听。曾写 3600 踩中，真机日志定位。
// 守卫锁死这五个值：任何一个漂移（45%/5s、60fps、exit 3 或超 100）都会回归。
checkTrue(
  "kasmvnc.yaml 常驻视频编码模式（enter 1%/1s + exit 100s + 30fps + codec h264）",
  /enter_video_encoding_mode:\s*\n\s*area_threshold:\s*1%/.test(kasmYamlSrc) &&
    /enter_video_encoding_mode:\s*\n\s*area_threshold:\s*1%\s*\n\s*time_threshold:\s*1/.test(kasmYamlSrc) &&
    /exit_video_encoding_mode:\s*\n\s*time_threshold:\s*100(\s|$)/.test(kasmYamlSrc) &&
    /max_frame_rate:\s*30/.test(kasmYamlSrc) &&
    /video_streaming_mode:\s*\n\s*codec:\s*h264/.test(kasmYamlSrc) &&
    !/area_threshold:\s*45%/.test(kasmYamlSrc) &&
    !/max_frame_rate:\s*60/.test(kasmYamlSrc)
);
checkTrue(
  "镜像预建 /tmp/.X11-unix（Xkasmvnc 以 node 身份跑时不会自建，日志会报 euid != 0）",
  /mkdir -p \/tmp\/\.X11-unix/.test(dockerfileSrc) && /chmod 1777 \/tmp\/\.X11-unix/.test(dockerfileSrc)
);
// ---- Passkey / TLS / 自动解锁（2026-09-24）----
// ① entrypoint 在 MS_REWARDS_TLS=auto 且证书缺失时自签（openssl 必须在镜像里）；
//    证书放 storage/tls（容器重建不换，否则浏览器每次重新信任）。
checkTrue(
  "entrypoint 自签 TLS 证书（auto + openssl + storage/tls + 导出 CERT/KEY）",
  /MS_REWARDS_TLS:-auto/.test(entrySrc) &&
    /openssl req -x509/.test(entrySrc) &&
    /TLS_DIR=.*\/tls/.test(entrySrc) &&
    /export MS_REWARDS_TLS_CERT/.test(entrySrc) &&
    /openssl/.test(dockerfileSrc)
);
// ② 健康检查必须走 https（自签后 http 会 400/失败，healthcheck 红了容器被判不健康）
checkTrue(
  "Dockerfile 与 compose 健康检查走 https + rejectUnauthorized:false",
  /require\('https'\)\.get\('https:\/\/127\.0\.0\.1:25560\/api\/health',\{rejectUnauthorized:false\}/.test(dockerfileSrc) &&
    /require\('https'\)\.get\('https:\/\/127\.0\.0\.1:25560\/api\/health',\{rejectUnauthorized:false\}/.test(composeSrc)
);
// ③ 自动解锁：env 开关 + 凭据文件 + 解锁后写回。
//    语义：重启后凭据文件在 → 启动即解锁 → 守护照常跑（无人值守）；
//    凭据文件不在（从未解锁过）→ 解不出登录态，任务本就无法读密文，守护不跑是对的。
checkTrue(
  "自动解锁凭据链路（env 开关 + vault-autounlock.key + 解锁后写回）",
  /MS_REWARDS_VAULT_AUTOUNLOCK_FILE/.test(composeSrc) &&
    /vault-autounlock\.key/.test(serverSrc) &&
    /unlockWithVkB64/.test(serverSrc) &&
    /writeAutoUnlockFile\(\)/.test(serverSrc) &&
    /tryFileAutoUnlock\(\)/.test(serverSrc)
);
// ④ Passkey 端点齐备且注册要会话、登录不要；WebAuthn 校验三要素都在
checkTrue(
  "Passkey 端点与校验（register 要会话 / auth 不要 / rpIdHash+flags+签名）",
  /\/api\/passkey\/register-options/.test(serverSrc) &&
    /\/api\/passkey\/auth-options/.test(serverSrc) &&
    /\/api\/passkey\/auth/.test(serverSrc) &&
    /needLogin\(req\)/.test(serverSrc) &&
    /rpIdHash\.equals/.test(fs.readFileSync(path.join(ROOT, "src", "passkey.js"), "utf8")) &&
    /flags & 0x01/.test(fs.readFileSync(path.join(ROOT, "src", "passkey.js"), "utf8")) &&
    /p1363ToDer/.test(fs.readFileSync(path.join(ROOT, "src", "passkey.js"), "utf8"))
);
checkTrue(
  "图形栈以 node 身份拉起（root 起的 X server，Chromium attach 不了它的 SHM 段，会静默回退 TCP）",
  /gosu node \/usr\/local\/bin\/novnc-stack\.sh/.test(entrySrc) &&
    /MS_REWARDS_ENABLE_NOVNC/.test(entrySrc) &&
    /export DISPLAY=:1/.test(entrySrc) &&
    /novnc-stack\.sh/.test(dockerfileSrc) &&
    /\.kasmpasswd/.test(entrySrc)
);
checkTrue(
  "KasmVNC 首次启动自动创建并持久化用户凭据（不能用空 .kasmpasswd）",
  /MS_REWARDS_KASM_USER/.test(entrySrc) &&
    /MS_REWARDS_KASM_PASSWORD/.test(entrySrc) &&
    /kasm-credentials\.txt/.test(entrySrc) &&
    /kasmvncpasswd -u/.test(entrySrc) &&
    /-w/.test(entrySrc) &&
    /chmod 600/.test(entrySrc) &&
    !/touch \/home\/node\/\.kasmpasswd/.test(entrySrc)
);
// 免登录开关：-DisableBasicAuth 与 -SecurityTypes None 都是 Xkasmvnc 二进制的参数
// （不是 perl 包装器的），写在 cli 里会被包装器当未知参数原样透传给 Xkasmvnc，关掉
// 两层独立鉴权：前者关 HTTP Basic Auth（浏览器 6080 不再弹 401 账号密码框），
// 后者关 WebSocket 里的 VNC 协议鉴权（noVNC 连上后不再弹「密码：/ Send Password」
// 对话框；只关 Basic Auth 不够，日志里 SConnection 仍会 "Client requests security
// type VncAuth(2)"）。开关必须走 MS_REWARDS_KASM_NO_AUTH 变量 + compose 暴露，缺一不可。
// 注意：不能把「至少一个用户」的凭据生成流程删掉（包装器 EnsureAtLeastOneKasmUserExists
// 硬性要求密码文件里有用户，即使免登录也会校验），所以这里反向锁「凭据流程还在」。
checkTrue(
  "KasmVNC 免登录开关完整（MS_REWARDS_KASM_NO_AUTH → -DisableBasicAuth + -SecurityTypes None 透传）且凭据流程仍在",
  /MS_REWARDS_KASM_NO_AUTH/.test(novncSrc) &&
    /-DisableBasicAuth/.test(novncSrc) &&
    /-SecurityTypes None/.test(novncSrc) &&
    /MS_REWARDS_KASM_NO_AUTH/.test(composeSrc) &&
    /MS_REWARDS_KASM_USER/.test(entrySrc) &&
    /kasmvncpasswd -u/.test(entrySrc)
);
const dashboardSrc = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "views", "Dashboard.tsx"),
  "utf8"
);
checkTrue(
  "Web 版「授权登录」先弹远程桌面引导（仪表盘与账户详情页两处都要有）",
  /WebLoginModal/.test(dashboardSrc) &&
    /WebLoginModal/.test(detailSrc) &&
    /onClick=\{onLoginClick\}/.test(detailSrc) &&
    /setLoginConfirm\(true\)/.test(detailSrc)
);
// npm ci 会严格校验 package.json 与 lock 的依赖声明：漂移了 Docker 构建直接 exit 1，
// 而且报错只躺在构建日志里（桌面版不跑 npm ci，本地完全无感）。实测踩过：
// package.json 写着 liquid-glass-react "0.0.1"，lock 却还停在 file:docker/vendor/…0.2.0.tgz。
const lockRaw = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
const lockDeps = (lockRaw.packages && lockRaw.packages[""] && lockRaw.packages[""].dependencies) || {};
const lockDrift = Object.keys(pkgRaw.dependencies || {}).filter(
  (k) => lockDeps[k] !== pkgRaw.dependencies[k]
);
checkTrue(
  "package-lock.json 与 package.json 的 dependencies 声明一致（npm ci 严格校验，漂移会让构建直接失败）",
  Object.keys(pkgRaw.dependencies || {}).length > 0 && lockDrift.length === 0,
  lockDrift.length
    ? `漂移: ${lockDrift.map((k) => `${k} lock=${lockDeps[k]} vs pkg=${pkgRaw.dependencies[k]}`).join("; ")}`
    : ""
);

/* ============ 20. 同端口 HTTP→HTTPS 302 + 流场动态背景 ============ */
console.log("\n【20】HTTPS 端口兼容明文 HTTP（302 跳转）与流场动态背景接入");
// 0.13.0 把 Web 服务切成 https（Passkey 要安全上下文），用户旧的 http:// 书签
// 直接变成 ERR_EMPTY_RESPONSE（"未发送任何数据"）。实测踩过。修法：同一个端口
// 上按首字节分流——0x16（TLS 握手记录头）交给 https.Server，其余交给只回 302
// 的 http.Server。守卫必须钉住这套分流骨架，缺任一环就退回"打不开"。
const serverTlsSrc = fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8");
checkTrue(
  "TLS 端口同端口分流：net 层按首字节 0x16 判 TLS，明文请求走 302",
  /net\.createServer/.test(serverTlsSrc) &&
    /socket\.read\(1\)/.test(serverTlsSrc) &&
    /0x16/.test(serverTlsSrc) &&
    /writeHead\(302/.test(serverTlsSrc) &&
    /Location: `https:\/\//.test(serverTlsSrc),
  "缺 net 分流 / 首字节判定 / 302 Location 任一环，http 访问会报 ERR_EMPTY_RESPONSE"
);
// 流场背景：登录页 / 向导 / 主界面三处 early-return 分支都要渲染背景层，
// 漏一个就是"切了流场但登录页还是纯色"。
const flowSrc = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "components", "FlowFieldBg.tsx"),
  "utf8"
);
const appBgSrc = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "App.tsx"), "utf8");
const typesBgSrc = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "types", "index.ts"),
  "utf8"
);
const persBgSrc = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "views", "Personalize.tsx"),
  "utf8"
);
checkTrue(
  "流场背景组件存在且是纯装饰层（pointer-events none + 卸载解绑 RAF）",
  /className="flow-bg"/.test(flowSrc) &&
    /requestAnimationFrame/.test(flowSrc) &&
    /cancelAnimationFrame/.test(flowSrc) &&
    /\.flow-bg[\s\S]{0,220}pointer-events:\s*none/.test(
      fs.readFileSync(
        path.join(ROOT, "src-renderer", "src", "styles", "global.css"),
        "utf8"
      )
    )
);
// 0.13.2 用户纠正：流场只属于登录页/向导背景（authBg），主界面软件不渲染。
// 守卫钉住这套分工：主 bgType 回归 bing 且白名单不含 flow；authBg 默认 flow
// 可切 bing；登录页与向导各自挂 AuthBackground；App.tsx 不再出现 FlowFieldBg。
const authAppearSrc = fs.readFileSync(path.join(ROOT, "src", "appearance.js"), "utf8");
const vaultLockSrc = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "views", "VaultLock.tsx"),
  "utf8"
);
const wizardSrc = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "views", "SetupWizard.tsx"),
  "utf8"
);
const authBgM = authAppearSrc.match(/const AUTH_BG_TYPES = \[([^\]]*)\]/);
checkTrue(
  "authBg 与主 bgType 分工：主壁纸默认 bing（白名单无 flow），authBg 默认 flow 可切 bing",
  /bgType: "bing",/.test(authAppearSrc) &&
    authBgM !== null &&
    /"flow"/.test(authBgM[1]) &&
    /"bing"/.test(authBgM[1]) &&
    /authBg: "flow",/.test(authAppearSrc) &&
    /AUTH_BG_TYPES\.includes\(raw\.authBg\)/.test(authAppearSrc) &&
    /AUTH_BG_TYPES\.includes\(next\.authBg\)/.test(authAppearSrc) &&
    /AuthBgType/.test(typesBgSrc) &&
    /authBg: AuthBgType/.test(typesBgSrc),
  "authBg 字段/白名单/默认值任一缺失，流场背景就无法持久化或错误落入主界面"
);
checkTrue(
  "登录页与向导各自渲染 AuthBackground，主界面 App 不再出现流场组件",
  /<AuthBackground/.test(vaultLockSrc) &&
    /<AuthBackground/.test(wizardSrc) &&
    !/FlowFieldBg/.test(appBgSrc) &&
    /aria-label="登录页背景"/.test(persBgSrc) &&
    /label: "流场动态", value: "flow"/.test(persBgSrc) &&
    !/bgType: "flow"/.test(persBgSrc),
  "缺 AuthBackground 挂载 → 登录页纯色；App 出现 FlowFieldBg → 流场错误回到主界面"
);

// 0.13.3 登录页三件事：①忘记密码翻页（卡片内 3D 翻转，内容不溢出）；
// ②「6 小时免登录」复选框（服务端 Map 会话 + 过期拒绝）；③深色玻璃卡片。
const sessSrc = fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8");
const webApiTs = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "api", "web.ts"), "utf8");
const passkeyClientSrc = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "api", "passkeyClient.ts"),
  "utf8"
);
const rescueSrc0133 = rescueSource; // 复用第 9 段读过的 VaultRescue 源码
checkTrue(
  "服务端「6 小时免登录」：REMEMBER_TTL=6h、cookie Max-Age=21600、会话 Map 带过期时间并在 hasSession 里懒删除",
  /REMEMBER_TTL = 6 \* 3600 \* 1000/.test(sessSrc) &&
    /Max-Age=\$\{Math\.floor\(REMEMBER_TTL \/ 1000\)\}/.test(sessSrc) &&
    /const sessions = new Map\(\)/.test(sessSrc) &&
    /Date\.now\(\) > exp/.test(sessSrc) &&
    /sessions\.delete\(token\)/.test(sessSrc),
  "服务端会话改造回退 → 免登录时长失效或 token 永不过期"
);
checkTrue(
  "解锁/重置/Passkey 三条登录路径都透传 remember 建会话，未勾选回落会话级 cookie",
  /newSession\(res, !!remember\)/.test(sessSrc) &&
    /newSession\(res, !!body\.remember\)/.test(sessSrc) &&
    /\{ password, remember: !!remember \}/.test(webApiTs) &&
    /\{ recoveryKey: key, remember: !!remember \}/.test(webApiTs) &&
    /remember: !!remember,/.test(passkeyClientSrc),
  "任一路径丢 remember → 勾了免登录也不生效，或 Passkey 登录行为与表单不一致"
);
checkTrue(
  "登录页「6 小时内免登录」复选框仅在 Web 渲染并参与解锁调用",
  /IS_WEB && \(/.test(vaultLockSrc) &&
    /className="login-remember"/.test(vaultLockSrc) &&
    /6 小时内免登录/.test(vaultLockSrc) &&
    /api\.vaultUnlock\(value, remember\)/.test(vaultLockSrc) &&
    /api\.vaultUnlockRecovery\(value, remember\)/.test(vaultLockSrc) &&
    /loginWithPasskey\(remember\)/.test(vaultLockSrc),
  "复选框缺失或没接进解锁调用 → 免登录功能形同虚设"
);
checkTrue(
  "忘记密码为卡片内 3D 翻页：preserve-3d + rotateY + backface 隐藏，背面绝对定位内部滚动",
  /login-flip\$\{face === "rescue" \? " flipped" : ""\}/.test(vaultLockSrc) &&
    /<VaultRescue variant="panel"/.test(vaultLockSrc) &&
    /login-flip-backbtn/.test(vaultLockSrc) &&
    /inert=\{face !== "login"\}/.test(vaultLockSrc) &&
    /inert=\{face !== "rescue"\}/.test(vaultLockSrc) &&
    /transform-style: preserve-3d/.test(cssSource) &&
    /\.login-flip\.flipped \{[^}]*rotateY\(180deg\)/.test(cssSource) &&
    /backface-visibility: hidden/.test(cssSource) &&
    /\.login-flip-back \{[\s\S]*?position: absolute;[\s\S]*?overflow-y: auto/.test(cssSource) &&
    /variant = "accordion"/.test(rescueSrc0133) && /isPanel/.test(rescueSrc0133),
  "翻页结构/动画/约束任一缺失 → 自救面板要么点不到要么溢出卡片"
);
checkTrue(
  "登录页深色玻璃质感：卡片半透明深底 + backdrop blur + 高光描边，图区深色渐变，页面级主题变量固定深色",
  /\.login-page \{[\s\S]*?--lg-text-primary: #e8ecf2/.test(cssSource) &&
    /backdrop-filter: blur\(18px\) saturate\(140%\)/.test(cssSource) &&
    /rgba\(18, 19, 28, 0\.82\)/.test(cssSource) &&
    /inset 0 1px 0 rgba\(255, 255, 255, 0\.09\)/.test(cssSource) &&
    /radial-gradient\(120% 90% at 32% 24%, #262838/.test(cssSource),
  "深色玻璃样式回退 → 登录页又变白底或卡片失去玻璃质感"
);

// 0.13.4 向导统一为登录页同款浮动玻璃卡片：放大尺寸、各步骤统一大小、
// Web 不再铺满视口（与登录页观感一致）。
const wizGuardsSrc = cssSource;
checkTrue(
  "向导卡片 = 登录页同款深色玻璃：blur+半透明深底+高光描边，统一 960×700 尺寸档",
  /\.wizard-card \{[^}]*width: min\(960px, 100%\)/.test(wizGuardsSrc) &&
    /\.wizard-card \{[^}]*height: min\(700px, 100%\)/.test(wizGuardsSrc) &&
    /\.wizard-card \{[^}]*backdrop-filter: blur\(18px\) saturate\(140%\)/.test(wizGuardsSrc) &&
    /\.wizard-card \{[^}]*rgba\(18, 19, 28, 0\.82\)/.test(wizGuardsSrc) &&
    /\.wizard-card \{[^}]*inset 0 1px 0 rgba\(255, 255, 255, 0\.09\)/.test(wizGuardsSrc),
  "向导卡片玻璃样式或统一尺寸回退 → 各步骤大小不一/观感与登录页脱节"
);
checkTrue(
  "向导容器不再铺满视口：data-web 全屏覆盖已移除，Web 与桌面同为浮动卡片",
  !/\[data-web="1"\] \.wizard-card \{/.test(wizGuardsSrc) &&
    !/:root\[data-web="1"\] \.wizard \{/.test(wizGuardsSrc),
  "Web 全屏覆盖回归 → Web 端向导与登录页观感不一致，玻璃卡失效"
);

// 0.13.5 修复「部分用户 Bing 不会自动登录」：Bing 侧票据与 MSA 票据分层判定，
// MSA 在线但缺 _U 时显式走 fd/auth/signin 静默 SSO 补票。
const bingSsoSrc = fs.readFileSync(path.join(ROOT, "src", "browser.js"), "utf8");
checkTrue(
  "Bing 侧票据与 MSA 票据分层：checkLoggedIn 不再把 login.live.com 票据当已登录",
  /const BING_AUTH_COOKIE_NAMES = \["\_U", "\.MSA\.Auth", "\_C_Auth", "\_M"\];/.test(bingSsoSrc) &&
    /function hasBingAuthCookies/.test(bingSsoSrc) &&
    /if \(hasBingAuthCookies\(cookies\)\) return true;/.test(bingSsoSrc) &&
    !/if \(hasAuthCookies\(cookies\)\) return true;/.test(bingSsoSrc.slice(bingSsoSrc.indexOf("function checkLoggedIn"), bingSsoSrc.indexOf("async function ensureBingSSO"))),
  "MSA-only 误判已登录 → Bing 实际未登录但同步照常存回，搜索不计分"
);
checkTrue(
  "MSA 在线但缺 _U 时显式走 fd/auth/signin 静默 SSO 补登 Bing，sync 与交互登录两路都接上",
  /fd\/auth\/signin/.test(bingSsoSrc) &&
    /\?action=interactive&provider=windows_live_id/.test(bingSsoSrc) &&
    /async function ensureBingSSO/.test(bingSsoSrc) &&
    // 措辞会随品牌脱敏（微软→MS）改写，只锚定「账号在线但 Bing 侧缺少登录票据」这段语义
    /账号在线但 Bing 侧缺少登录票据/.test(bingSsoSrc) &&
    /!hasBingAuthCookies\(cookies\) && hasAuthCookies\(cookies\)/.test(bingSsoSrc) &&
    /!ssoTried && !hasBingAuthCookies\(last\.cookies\) && hasAuthCookies\(last\.cookies\)/.test(bingSsoSrc),
  "静默 SSO 缺失或没接入两路同步 → Bing 缺 _U 的用户永远无法自动补登"
);
checkTrue(
  "Cookie 同步目标补全 www.bing.com（_U 可能只落在 cn 或 www 其一）",
  /\["https:\/\/cn\.bing\.com\/", "https:\/\/www\.bing\.com\/", "https:\/\/rewards\.bing\.com\/earn"\]/.test(bingSsoSrc),
  "漏访问 www.bing.com → 部分用户 www 域无登录票据，Bing 首页显示「登录」"
);

// 0.13.6 点按钮兜底：静默 SSO 没补上票时，像真人一样点 Bing 首页「登录」按钮，
// 并自动走完微软确认页（#idSIButton9）/ 账户瓦片选择，两路同步都接入。
checkTrue(
  "静默 SSO 失败后回退模拟点登录按钮：点 Bing 首页 #id_l、自动确认 #idSIButton9 / 账户瓦片",
  /async function ensureBingLoginByClick/.test(bingSsoSrc) &&
    /#id_l/.test(bingSsoSrc) &&
    /#idSIButton9/.test(bingSsoSrc) &&
    /#tilesHolder \.tile/.test(bingSsoSrc) &&
    /async function clickFirst\(page, selectors\)/.test(bingSsoSrc),
  "点按钮兜底缺失 → 静默 SSO 卡在账户选择/隐私确认的用户仍无法自动补登"
);
checkTrue(
  "点按钮兜底接入 sync 与交互登录两条同步路径（SSO 未成 → ensureBingLoginByClick）",
  /回退到模拟点登录按钮/.test(bingSsoSrc) &&
    /await ensureBingLoginByClick\(page, context\)/.test(bingSsoSrc) &&
    /回退到模拟点 Bing 登录按钮/.test(bingSsoSrc),
  "点按钮兜底只写没接 → 实际跑不到，等于没兜底"
);

// 0.13.7 Passkey「无法保存到浏览器」修复：residentKey 强制 required（可发现凭据），
// 注册/登录异常不再静默吞掉，内网 IP 访问给出明确阻断提示。
const passkeySrvSrc = fs.readFileSync(path.join(ROOT, "src", "passkey.js"), "utf8");
checkTrue(
  "Passkey 注册 residentKey 强制 required（而非 preferred，避免降级成浏览器里找不到）",
  /residentKey:\s*"required"/.test(passkeySrvSrc) && !/residentKey:\s*"preferred"/.test(passkeySrvSrc),
  "residentKey 退回 preferred → 通行密钥降级，注册成功但浏览器/系统里保存不到"
);
checkTrue(
  "Passkey 注册与登录的 browser 端异常被捕获并带信息返回（不再静默无反应）",
  /注册被浏览器拒绝/.test(passkeyClientSrc) &&
    /通行密钥登录被拒绝/.test(passkeyClientSrc),
  "异常未捕获 → 内网 IP 被浏览器拒绝时界面「点了没反应」，用户无从排查"
);
checkTrue(
  "内网 IP 访问识别 passkeyBlockedByIp，并在 Passkey 面板提示改用域名/localhost、禁用注册按钮",
  /function passkeyBlockedByIp/.test(passkeyClientSrc) &&
    /当前通过 IP 地址访问，浏览器不会保存通行密钥/.test(fs.readFileSync(path.join(ROOT, "src-renderer", "src", "components", "VaultPanel.tsx"), "utf8")),
  "IP 访问不提示 → 用户在内网 IP 下反复注册却保存不到，问题依旧"
);

// 0.13.8 Docker 版「环境拟真浏览器独占 + 镜像预装 + 可拉取」改造。
//   核心不变量：
//     ① 预装目录（镜像内置）优先于运行时下载目录，且状态里如实暴露 preinstalled；
//     ② 预装存在时禁止运行时下载 / 删除（否则白拉 134MB 且删不掉镜像层）；
//     ③ 预装存在时 resolveBrowserSource 强制走环境拟真浏览器（容器里没有别的浏览器）；
//     ④ Dockerfile 不再装 apt chromium，但必须把 Chromium 运行时依赖显式补齐，
//        并在构建期用 ldd 自检，缺库直接让构建失败；
//     ⑤ 向导 Web 版删掉环境拟真浏览器下载页（5 步），桌面版保留（6 步）。
const fpbSrc = fs.readFileSync(path.join(ROOT, "src", "fingerprint-browser.js"), "utf8");
// dockerfileSrc / composeSrc / wizardSrc 已在本文件上方声明，这里直接复用
const fpPanelSrc = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "components", "FingerprintBrowserPanel.tsx"),
  "utf8"
);

checkTrue(
  "环境拟真浏览器支持镜像预装目录（MS_REWARDS_FINGERPRINT_PREINSTALLED），且优先于运行时下载目录",
  /function preinstalledDir\(\)/.test(fpbSrc) &&
    /MS_REWARDS_FINGERPRINT_PREINSTALLED/.test(fpbSrc) &&
    // 只断言「先判预装、预装可用就 return」这两个语义要点，不锚定整个函数骨架
    // （2026-10-05 给 executablePath 加了版本校验，骨架匹配会误报）。
    /const pre = preinstalledDir\(\)/.test(fpbSrc) &&
    new RegExp(
      "const pre = preinstalledDir\\(\\);[\\s\\S]{0,600}?if \\(pre\\) \\{[\\s\\S]{0,600}?return exe;"
    ).test(fpbSrc),
  "预装目录不被优先使用 → Docker 容器明明预装了却报「未安装」，还会去发起 500MB 运行时下载"
);
// 换上游时最容易漏的一类：只信 version.txt / 只信 exe 存在，都会被「多版本目录并存」骗。
// 2026-10-05 实测：拷进新版后 version.txt 是新的，executablePath 却仍返回旧目录的 exe。
//
// ⚠️ 必须锚定**运行时安装目录**那一段（不是预装那一段）：只断言 `v !== PINNED_VERSION`
// 会被「预装路径还在校验、运行时路径已删干净」骗成假绿（实测踩过）。
checkTrue(
  "executablePath 对运行时安装目录也校验版本（换上游后不静默沿用旧内核）",
  (() => {
    const fn = /function executablePath\(\) \{[\s\S]*?\n\}/.exec(fpbSrc);
    if (!fn) return false;
    const body = fn[0];
    // 运行时分支：installDir() 取到 exe 之后必须有版本比对 + 判为不可用的早退
    // ⚠️ 多内核后比对的是 currentPinned()（当前引擎的钉死版本），不再直接读常量
    const runtimeBranch =
      /const dir = installDir\(CURRENT_ENGINE\);[\s\S]*?readVer\(dir\)[\s\S]*?!== pinned[\s\S]*?return null;/.test(
        body
      ) && /const pinned = currentPinned\(\);/.test(body);
    return runtimeBranch;
  })(),
  "运行时目录不校验版本 → 用户换上游后仍跑旧内核，而旧内核（fp150）恰是有崩溃缺陷的那个"
);
checkTrue(
  "状态接口暴露 preinstalled，且预装时跳过镜像测速探测",
  /preinstalled:\s*!!pre/.test(fpbSrc) && /mirrors:\s*pre \? \[\] : await mirrorOptionsWithLatency\(\)/.test(fpbSrc),
  "不暴露 preinstalled → 界面在容器里仍显示「下载并安装/删除」按钮"
);
checkTrue(
  "预装存在时拒绝运行时安装与卸载（避免白下一份、也避免删除镜像层）",
  /环境拟真浏览器已由镜像内置预装，无需下载/.test(fpbSrc) &&
    /环境拟真浏览器由镜像内置预装，无法在容器内删除/.test(fpbSrc) &&
    /if \(preinstalledDir\(\)\) \{[\s\S]{0,120}?return \{ ok: false/.test(fpbSrc),
  "预装仍允许下载/删除 → 用户点一下就在 /data 卷里堆 400MB 副本，且卸载给假成功"
);
checkTrue(
  "预装存在时强制启用环境拟真浏览器（容器内它是唯一浏览器，配置 enable=false 也要用）",
  /const forced = !!fpBrowser\.preinstalledDir\(\)/.test(fs.readFileSync(path.join(ROOT, "src", "browser.js"), "utf8")) &&
    /if \(forced \|\| cfg\.enable\)/.test(fs.readFileSync(path.join(ROOT, "src", "browser.js"), "utf8")) &&
    /cfg: \{ \.\.\.cfg, enable: true \}/.test(fs.readFileSync(path.join(ROOT, "src", "browser.js"), "utf8")),
  "不强制启用 → Docker 默认配置（enable=false）会一路走到「未检测到可用的浏览器」，任务全挂"
);
checkTrue(
  "Dockerfile 不再安装 apt chromium（普通 Chromium 的 Client Hints 改不动，会留环境特征矛盾）",
  !/\n\s{8}chromium \\\n/.test(dockerfileSrc),
  "apt chromium 回归 → 镜像里同时存在两种浏览器，且普通 Chromium 会产出 UA/CH 自相矛盾的环境特征"
);
checkTrue(
  "Dockerfile 显式补齐 Chromium 运行时依赖（移除 apt chromium 后这些库不再被顺带装上）",
  /libnss3 \\/.test(dockerfileSrc) &&
    /libgtk-3-0 \\/.test(dockerfileSrc) &&
    /libatk-bridge2.0-0 \\/.test(dockerfileSrc) &&
    /libasound2 \\/.test(dockerfileSrc),
  "缺运行库 → 环境拟真浏览器一启动就报 libnss3.so 找不到，容器里什么都跑不了"
);
checkTrue(
  "Dockerfile 预装环境拟真浏览器并用 ldd 自检（缺库直接构建失败）+ 写 version.txt",
  /MS_REWARDS_FINGERPRINT_PREINSTALLED=\/opt\/fingerprint-chromium/.test(dockerfileSrc) &&
    // 2026-10-05 换 Chromix 后 Linux 资产是 zip，解压命令从 tar -xf 改成 unzip
    /unzip -q \/tmp\/fpcb\.zip -d \/opt\/fingerprint-chromium/.test(dockerfileSrc) &&
    /ldd "\$CHROME_BIN" \| grep -q "not found"/.test(dockerfileSrc) &&
    /version\.txt/.test(dockerfileSrc),
  "预装/自检缺失 → 运行时要重新下 500MB，或缺库问题拖到用户现场才暴露"
);
// zip 资产必须有 unzip，否则镜像构建阶段就 exit 127（Chromix 的 Linux 资产不是 tar.xz）
checkTrue(
  "Dockerfile apt 清单含 unzip（Chromix 的 Linux 资产是 zip，解压依赖它）",
  /apt-get install -y --no-install-recommends[\s\S]{0,200}?\bunzip\b/.test(dockerfileSrc),
  "缺 unzip → 预装段 `unzip -q` 直接 not found，镜像构建失败"
);
// 资产名与 tag 前缀是 Chromix 特有形态：资产名不含版本号、tag 带 v —— 照抄旧上游会 404
checkTrue(
  "Dockerfile 预装 URL 用 Chromix 的资产名与 v 前缀 tag（chromix-linux-x64.zip + /download/v${FPCB_VERSION}/）",
  /xiaozhou26\/Chromix\/releases\/download\/v\$\{FPCB_VERSION\}\/chromix-linux-x64\.zip/.test(dockerfileSrc),
  "tag 无 v 前缀或沿用 ungoogled-chromium-*.tar.xz 资产名 → 上游 404，镜像构建失败"
);
// ⚠️ 多内核后 PINNED_VERSION 变成 ENGINES[DEFAULT_ENGINE].version 的派生常量，
// 不能再用 `/PINNED_VERSION = "x"/` 提取版本号 —— 必须从 ENGINES 里取默认内核的 version。
function defaultEngineVersion(src) {
  const blk = /chromix:\s*\{[\s\S]{0,400}?version:\s*"([^"]+)"/.exec(src || "");
  return blk ? blk[1] : null;
}
checkTrue(
  "预装版本号与 src/fingerprint-browser.js 的默认内核版本跨文件一致",
  (() => {
    const m = defaultEngineVersion(fpbSrc);
    const d = /ARG FPCB_VERSION=([^\s]+)/.exec(dockerfileSrc);
    return !!m && !!d && m === d[1];
  })(),
  "两处版本号漂移 → 镜像里预装的版本与状态接口自报的「钉死版本」对不上，界面永远提示「需重建镜像对齐」"
);
// THIRD_PARTY_NOTICES.md 里 fingerprint-chromium 的版本标题必须跟默认内核版本同步。
// 这份声明随安装包分发，且 README/关于页都指向它；停在旧版本会误导用户以为是旧内核。
checkTrue(
  "THIRD_PARTY_NOTICES.md 的 Chromix 版本 == 默认内核钉死版本",
  (() => {
    const m = defaultEngineVersion(fpbSrc);
    const t = /### fingerprint-chromium — ([\d.]+)/.exec(
      fs.readFileSync(noticesPath, "utf8")
    );
    return !!m && !!t && m === t[1];
  })(),
  "第三方声明的内核版本停在旧版 → 升级默认内核版本时漏改了 THIRD_PARTY_NOTICES.md"
);
// 多内核后两个上游都在分发，必须都出现在第三方声明里（Chromix 是默认，fp150 备用）。
checkTrue(
  "THIRD_PARTY_NOTICES.md 同时声明两个上游（Chromix 默认 + fp150 备用）",
  /xiaozhou26\/Chromix|### fingerprint-chromium —/.test(
    fs.readFileSync(noticesPath, "utf8")
  ) && /150\.0\.7871\.186/.test(fs.readFileSync(noticesPath, "utf8")),
  "只声明默认内核 → 用户换成 fp150 后，许可证声明与实际分发的二进制不符（合规问题）"
);
// docker 文档里的「锁定版本」示例必须等于当前版本号。
// 这几处是用户会照抄的操作指引，示例停在历史版本会让人以为最新版只能回退。
// 形如「（如 0.13.16）」「如 `:0.13.16`」——注意「如」与版本号之间可能隔着
// 全角括号、反引号、半角冒号（实测 `:0.13.16` 紧跟全角「）」），所以字符类要放宽。
// 收集全部命中而不是只取第一个：compose 里有两处示例，只查第一处会漏。
const dockerDocDrift = [
  ["docker/docker-compose.yml", composeSrc],
  ["docker/README.md", fs.readFileSync(path.join(ROOT, "docker", "README.md"), "utf8")],
]
  .flatMap(([name, text]) =>
    [...text.matchAll(/如[\s`:\u3001\uFF08]*v?(\d+\.\d+\.\d+)/g)]
      .filter((m) => m[1] !== pkgRaw.version)
      .map((m) => `${name} 示例写 ${m[1]}`)
  );
checkTrue(
  "docker 文档里的示例版本号 == 当前 package.json 版本（防「锁版本」示例漂移到历史版本）",
  dockerDocDrift.length === 0,
  dockerDocDrift.join("；") + `（当前 ${pkgRaw.version}）`
);
checkTrue(
  "compose 指向 ghcr 预构建镜像（latest）、且不再传已废弃的 Chromium 兜底环境变量",
  // image 已改为 :latest 配合 Watchtower 自动更新，不再是版本 tag。
  /image:\s*ghcr\.io\/[^:\s]+:latest/.test(composeSrc) &&
    !/MS_REWARDS_CHROMIUM_FALLBACK/.test(composeSrc) &&
    !/PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH/.test(composeSrc),
  "image 不是 ghcr latest（破坏自动更新），或 compose 仍留兜底变量 → 容器会优先用兜底 Chromium，环境拟真浏览器永远轮不到"
);
checkTrue(
  "向导 Web 版删掉环境拟真浏览器页（5 步），桌面版保留（6 步）",
  /const STEPS = IS_WEB/.test(wizardSrc) &&
    /!IS_WEB && page === 5 && <PageFingerprint/.test(wizardSrc) &&
    !/\{page === 5 && <PageFingerprint/.test(wizardSrc) &&
    /IS_WEB \? "开始使用 ✓" : "下一步 →"/.test(wizardSrc),
  "Web 版仍渲染拟真页 → 用户在 Docker 里被要求下载一个已经预装好的浏览器"
);
checkTrue(
  "环境拟真浏览器面板：预装时隐藏下载/更新/删除按钮，并显式禁用「启用」开关",
  /!st\?\.preinstalled && \(/.test(fpPanelSrc) &&
    /st\?\.preinstalled \? \(/.test(fpPanelSrc) &&
    /checked=\{st\?\.preinstalled \? true : cfg\.enable\}/.test(fpPanelSrc) &&
    /镜像内置/.test(fpPanelSrc),
  "面板不做预装分支 → 容器里仍出现「下载并安装 / 重新下载 / 删除」三个无效按钮"
);

/* ============ 21. 壁纸两级分类（upx8 默认 4K）与 UAPI 随机图源移除 ============ */
console.log("\n【21】壁纸两级分类（upx8 默认 4K）与 UAPI 随机图源移除");
// 0.13.10 需求（用户原话）：接入 wp.upx8.com 壁纸 API、默认请求 4K 分辨率；
// 移除 UAPI 的所有壁纸来源（除 Bing 每日壁纸）；新 API 作为主分类名，被选中时
// 展示壁纸类别；98qy 与 Unsplash 同样加二级分类 → 「主分类 → 壁纸类别」两级结构。
const wallpapersSrc = fs.readFileSync(path.join(ROOT, "src", "wallpapers.js"), "utf8");
const uapiOnlySrc = fs.readFileSync(path.join(ROOT, "src", "uapi.js"), "utf8");
const emBgSrc21 = fs.readFileSync(path.join(ROOT, "src", "electron-main.js"), "utf8");
const waBgSrc21 = fs.readFileSync(path.join(ROOT, "src", "web-api.js"), "utf8");
const useBgSrc21 = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "hooks", "useBackground.ts"),
  "utf8"
);
const appearSrc21 = fs.readFileSync(path.join(ROOT, "src", "appearance.js"), "utf8");
const wipeSrc21 = fs.readFileSync(path.join(ROOT, "src", "wipe.js"), "utf8");
const mockBgSrc21 = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "api", "mock.ts"),
  "utf8"
);

// —— 壁纸轮换：后台自动暂停（2026-10-03 用户要求）——
// 判定用 visibilitychange 而非 blur：blur 在点 DevTools 时也触发，会误判后台。
checkTrue(
  "壁纸轮换监听 visibilitychange（切后台自动暂停，不用 blur 误判）",
  /addEventListener\(\s*["']visibilitychange["']/.test(useBgSrc21) &&
    /visibilityState\s*!==\s*["']hidden["']/.test(useBgSrc21) &&
    !/addEventListener\(\s*["']blur["']/.test(useBgSrc21),
  "useBackground.ts 未监听 visibilitychange，或用 blur 判定（会误判后台）"
);
checkTrue(
  "壁纸轮换定时器受 pageVisible 门控且进入依赖数组",
  /if\s*\(\s*!pageVisible\s*\)\s*return/.test(useBgSrc21) &&
    /\[\s*bgType\s*,\s*bgRotate\s*,\s*pageVisible\s*\]/.test(useBgSrc21),
  "后台仍然装定时器（配额白白消耗），或 pageVisible 没进依赖数组（状态变了不重建定时器）"
);

// ① UAPI 随机图源彻底移除：客户端函数没了、白名单没了、解析入口不再分发
checkTrue(
  "UAPI 随机图源已移除（uapi.js 只剩必应每日客户端）",
  !/randomImageUrl/.test(uapiOnlySrc) &&
    !/qy98WallpaperUrl/.test(uapiOnlySrc) &&
    !/unsplashRandom/.test(uapiOnlySrc),
  "uapi.js 仍带随机图客户端 → 「移除 UAPI 所有壁纸来源（除 Bing）」被回退"
);
const bgTypesM = authAppearSrc.match(/const BG_TYPES = \[([^\]]*)\]/);
checkTrue(
  "bgType 白名单去 uapi 加 upx8（旧配置 bgType=uapi 自动回退默认 bing）",
  bgTypesM !== null &&
    !/"uapi"/.test(bgTypesM[1]) &&
    /"upx8"/.test(bgTypesM[1]) &&
    /"bing"/.test(bgTypesM[1]),
  `BG_TYPES = ${bgTypesM ? bgTypesM[1] : "未找到"}`
);
checkTrue(
  "两处背景解析入口按 upx8/qy98/unsplash 分发且带二级分类参数",
  /case "upx8":\s*\r?\n\s*return wallpapers\.upx8Url\(cfg\.bgCategory\);/.test(emBgSrc21) &&
    /wallpapers\.unsplashRandom\(key, cfg\.bgCategory\)/.test(emBgSrc21) &&
    /case "upx8":\s*\r?\n\s*return wallpapers\.upx8Url\(cfg\.bgCategory\);/.test(waBgSrc21) &&
    /wallpapers\.unsplashRandom\(key, cfg\.bgCategory\)/.test(waBgSrc21) &&
    !/case "uapi"/.test(emBgSrc21) &&
    !/case "uapi"/.test(waBgSrc21),
  "入口没带分类 / 仍分发 uapi → 二级分类选择不生效或旧源复活"
);

// ② upx8 默认请求 4K：静态 + 运行双保险
checkTrue(
  "upx8 默认请求 4K 分辨率（resolution=3840x2160 写死在 upx8Url）",
  /new URLSearchParams\(\{ resolution: "3840x2160" \}\)/.test(wallpapersSrc),
  "upx8Url 的 resolution 不是 3840x2160 → 用户要求的默认 4K 丢失"
);
// 上游限制留档：birdpaper 数据源返回原图尺寸，resolution 仅作记录、不强制缩放，
// 所以实拉常见 1920x1080 属正常（0.13.10 服务器实测确认），不是我们的 bug。
// 这条守卫只锁「注释里保留了这个事实说明」，防止后人把它当成 bug 去乱改参数。
checkTrue(
  "upx8 注释保留了「上游 birdpaper 不强制缩放」的事实说明（防误判为 bug）",
  /birdpaper 数据源返回图片原始尺寸/.test(wallpapersSrc) &&
    /不做强制缩放/.test(wallpapersSrc),
  "注释被删 → 后人可能把 1080p 返回值误判为 bug 并乱改参数"
);
const wallpapersMod21 = require(path.join(ROOT, "src", "wallpapers.js"));
check(
  "upx8 随机分类不带 category（仅 4K 分辨率）",
  wallpapersMod21.upx8Url("random"),
  "https://wp.upx8.com/api.php?resolution=3840x2160"
);
check(
  "upx8 指定分类时透传 category 参数",
  wallpapersMod21.upx8Url("nature"),
  "https://wp.upx8.com/api.php?resolution=3840x2160&category=nature"
);
checkTrue(
  "98qy 按二级分类透传 lx 参数（method=pc 横屏 + format=images 302）",
  /lx=dongman/.test(wallpapersMod21.qy98Url("dongman")) &&
    /method=pc/.test(wallpapersMod21.qy98Url("dongman")) &&
    /format=images/.test(wallpapersMod21.qy98Url("dongman")),
  wallpapersMod21.qy98Url("dongman")
);

// ③ 两级分类目录：四源各带壁纸类别，非法值回落该源默认
const srcCats21 = (t) =>
  wallpapersMod21.SOURCES[t] ? wallpapersMod21.SOURCES[t].categories.map((c) => c.key) : [];
/** 全部随机图源（唯一真源在 wallpapers.SOURCES，新增源这里自动纳入校验） */
const ALL_RANDOM_SRC = ["upx8", "qy98", "unsplash", "pexels"];
checkTrue(
  "四个 API 源都带壁纸类别（upx8/qy98/unsplash/pexels 各 ≥3 个二级分类）",
  ALL_RANDOM_SRC.every((t) => srcCats21(t).length >= 3),
  `实际 ${ALL_RANDOM_SRC.map((t) => `${t}=${srcCats21(t).length}`).join("/")}`
);
checkTrue(
  "非法二级分类回落该源默认（列表首个），无分类主分类恒返回空",
  wallpapersMod21.normalizeCategory("upx8", "bogus") === "random" &&
    wallpapersMod21.normalizeCategory("qy98", "nature") === "suiji" &&
    wallpapersMod21.normalizeCategory("bing", "nature") === "",
  `实际 upx8→${wallpapersMod21.normalizeCategory("upx8", "bogus")} qy98→${wallpapersMod21.normalizeCategory("qy98", "nature")}`
);
checkTrue(
  "Unsplash 二级分类映射为官方 API 的 query 参数",
  /params\.set\("query", cat\)/.test(wallpapersSrc) &&
    /photos\/random/.test(wallpapersSrc),
  "unsplashRandom 不传 query → Unsplash 二级分类形同虚设"
);

// ③-2 Pexels 端到端：端点选择 / 鉴权头 / 数组取值 / 分类路由（改任一环都要同步）
// 只取 Pexels 函数体，避免误命中 Unsplash 的 Client-ID 头 —— 同文件两个源各有一套鉴权格式
const pexelsFnSrc21 = (wallpapersSrc.match(/async function pexelsRandom[\s\S]*?\n}/) || [""])[0];
checkTrue(
  "Pexels「随机」走 /v1/curated（search 缺 query 会 400），其余分类走 /v1/search + query",
  /curated/.test(pexelsFnSrc21) &&
    /\/search/.test(pexelsFnSrc21) &&
    /params\.set\("query", cat\)/.test(pexelsFnSrc21) &&
    /orientation/.test(pexelsFnSrc21),
  "Pexels 端点路由缺失 → 随机档必然 400"
);
checkTrue(
  "Pexels 鉴权头是裸 API Key（Authorization 不带 Bearer/Client-ID 前缀）",
  /headers: \{ Authorization: key \}/.test(pexelsFnSrc21) &&
    !/Authorization: [`'](Bearer|Client-ID)/.test(pexelsFnSrc21),
  "鉴权头格式错 → 401"
);
checkTrue(
  "Pexels 取 photos 数组里的横屏图（响应是数组不是单对象，curated 混排竖图）",
  /Array\.isArray\(j\.photos\)/.test(pexelsFnSrc21) &&
    /p\.width >= p\.height/.test(pexelsFnSrc21),
  "只读单对象 → 拿不到图；不筛横屏 → 竖图被当壁纸拉伸"
);
checkTrue(
  "Pexels key 有完整落盘链路（appearance 默认/归一化 ×2 + types + mock + UI 输入框 + wipe 清理）",
  /bgPexelsKey: ""/.test(appearSrc21) &&
    (appearSrc21.match(/bgPexelsKey: String\(/g) || []).length >= 2 &&
    /bgPexelsKey/.test(typesBgSrc) &&
    /bgPexelsKey/.test(mockBgSrc21) &&
    /bgPexelsKey/.test(persBgSrc) &&
    // 只认可执行代码里的赋值：注释里出现字段名不算（踩过假绿）
    /appearance\.set\(\{[^}]*bgPexelsKey: ""/.test(wipeSrc21),
  "任一环缺字段 → 保存后被规范化吃掉 / 界面存不下 / 重置后残留凭据"
);
checkTrue(
  "Pexels 在两处主进程入口都已接线（electron-main + web-api）",
  /case "pexels"/.test(emBgSrc21) &&
    /case "pexels"/.test(waBgSrc21) &&
    /PEXELS_API_KEY/.test(emBgSrc21) &&
    /PEXELS_API_KEY/.test(waBgSrc21),
  "只接一处 → 桌面端或 Docker 端壁纸拉不到"
);
checkTrue(
  "「自动轮换」对除 Bing/关闭外的所有图源可见（此前 upx8 下找不到该控件）",
  /bgGroup !== "none" && bgGroup !== "bing"/.test(persBgSrc) &&
    !/bgGroup === "random" \|\| bgGroup === "custom"/.test(persBgSrc),
  "轮换入口仍只在部分图源下可见 → 用户找不到该功能"
);

// ④ 前后端分类表逐 key 对齐（改一处漏一处 → 点了没反应或写盘被规范化吃掉）
const bgSourcesBlock21 = (persBgSrc.match(/const BG_SOURCES[\s\S]*?const BG_SOURCE_TYPES/) || [""])[0];
const feCats21 = {};
for (const m of bgSourcesBlock21.matchAll(
  new RegExp(`type: "(${ALL_RANDOM_SRC.join("|")})",[\\s\\S]*?cats: \\[([\\s\\S]*?)\\]`, "g")
)) {
  feCats21[m[1]] = [...m[2].matchAll(/key: "([a-z_]+)"/g)].map((x) => x[1]);
}
checkTrue(
  "前端 BG_SOURCES 与后端 wallpapers.SOURCES 分类 key 逐源一致",
  ALL_RANDOM_SRC.every(
    (t) => JSON.stringify(feCats21[t] || []) === JSON.stringify(srcCats21(t))
  ),
  `前端 ${JSON.stringify(feCats21)} vs 后端 ${ALL_RANDOM_SRC.map((t) => `${t}=${JSON.stringify(srcCats21(t))}`).join(" ")}`
);

// ⑤ 两级 UI 结构：主分类分段 + 选中时展开壁纸类别 chips
checkTrue(
  "个性化页三个 API 源各为一个主分类，选中时展开壁纸类别（二级分类 chips）",
  /value: "upx8"/.test(persBgSrc) &&
    /value: "qy98"/.test(persBgSrc) &&
    /value: "unsplash"/.test(persBgSrc) &&
    /BG_SOURCES\.filter\(\(s\) => s\.type === bgGroup\)/.test(persBgSrc) &&
    /onPickSource\(s\.type, c\.key\)/.test(persBgSrc) &&
    !/"uapi"/.test(persBgSrc),
  "分段缺主分类 / 不展开二级 chips → 用户要求的两级操作逻辑丢失"
);
checkTrue(
  "BgType 类型与随机源列表同步（upx8 替代 uapi，BgType 不再含 uapi/flow）",
  // 锚定数组字面量的完整内容：漏一个源会导致它不受 60s 下限保护、直接按用户输入打 API
  /const RANDOM_SOURCES: BgType\[\] = \[[^\]]*"upx8"[^\]]*"qy98"[^\]]*"unsplash"[^\]]*"pexels"[^\]]*\]/.test(
    useBgSrc21
  ) &&
    /"upx8"/.test(typesBgSrc) &&
    /"pexels"/.test(typesBgSrc) &&
    !/"uapi"/.test(typesBgSrc) &&
    // 行首锚定 export type BgType：裸写 BgType = 会误命中 AuthBgType = "flow"（假红踩过）
    !/export type BgType = [^\n]*"flow"/.test(typesBgSrc) &&
    !/export type BgType = [^\n]*"uapi"/.test(typesBgSrc),
  "类型/列表与白名单漂移 → tsc 或运行时对不上"
);

// ⑥ appearance 分源校验（隔离实例：模块在 require 时绑定存储路径，同【15】先例）
const catRoot21 = fs.mkdtempSync(path.join(os.tmpdir(), "ms-rewards-bgcat-selfcheck-"));
const catEnvBackup21 = process.env.MS_REWARDS_STORAGE_DIR;
process.env.MS_REWARDS_STORAGE_DIR = path.join(catRoot21, "storage");
for (const modPath of ["appearance.js", "wallpapers.js", "storage-path.js"]) {
  delete require.cache[require.resolve(path.join(ROOT, "src", modPath))];
}
const appearanceCat21 = require(path.join(ROOT, "src", "appearance.js"));
check("旧配置 bgType=uapi 被拒绝并回退默认 bing", appearanceCat21.set({ bgType: "uapi" }).bgType, "bing");
check("upx8 合法二级分类被保留", appearanceCat21.set({ bgType: "upx8", bgCategory: "nature" }).bgCategory, "nature");
check(
  "跨源非法分类回落该源默认（qy98 无 nature → suiji）",
  appearanceCat21.set({ bgType: "qy98", bgCategory: "nature" }).bgCategory,
  "suiji"
);
check("unsplash 合法二级分类被保留", appearanceCat21.set({ bgType: "unsplash", bgCategory: "flowers" }).bgCategory, "flowers");
for (const modPath of ["appearance.js", "wallpapers.js", "storage-path.js"]) {
  delete require.cache[require.resolve(path.join(ROOT, "src", modPath))];
}
process.env.MS_REWARDS_STORAGE_DIR = catEnvBackup21;
fs.rmSync(catRoot21, { recursive: true, force: true });

/* ============ 0.13.11：一言 / 壁纸限流 / 目标勋章 / 一次性完成 ============ */
console.log("\n【17】每日一言、壁纸限流、目标勋章与一次性完成");

// —— 一言模块（隔离实例避免污染全局存储路径）——
const hkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ms-rewards-hk-selfcheck-"));
const hkEnvBackup = process.env.MS_REWARDS_STORAGE_DIR;
process.env.MS_REWARDS_STORAGE_DIR = path.join(hkRoot, "storage");
if (require.cache[require.resolve(path.join(ROOT, "src", "hitokoto.js"))]) {
  delete require.cache[require.resolve(path.join(ROOT, "src", "hitokoto.js"))];
}
const hk = require(path.join(ROOT, "src", "hitokoto.js"));
// API_URL 是**基址**，参数在 buildUrl() 里拼（句子类型 c 是可配的）
check("一言 API 基址指向官方公益接口", hk.API_URL, "https://v1.hitokoto.cn/");
check(
  "一言取句地址缺省带 encode/json 与 max_length",
  hk.buildUrl(),
  "https://v1.hitokoto.cn/?encode=json&max_length=30"
);
// 句子类型（0.13.13）：接口 c 参数，可多选，空 = 不限类型
check("一言句子类型多选拼接 c 参数", hk.buildUrl(["a", "d"]), "https://v1.hitokoto.cn/?encode=json&max_length=30&c=a&c=d");
check("一言句子类型按 TYPES 顺序去重（乱序+重复）", hk.normalizeTypes(["d", "a", "d", "a"]), ["a", "d"]);
check("一言句子类型丢弃非法字母", hk.normalizeTypes(["a", "z", "", "9"]), ["a"]);
check("一言句子类型缺省/空值 = 不限类型", [hk.normalizeTypes(undefined), hk.normalizeTypes([])], [[], []]);
check(
  "一言句子类型表（a–l）与官方文档一致",
  hk.TYPES.map((t) => `${t.key}${t.label}`),
  [
    "a动画", "b漫画", "c游戏", "d文学", "e原创", "f来自网络",
    "g其他", "h影视", "i诗词", "j网易云", "k哲学", "l抖机灵",
  ]
);
// ts 是「取得时刻」的动态时间戳（30 秒 TTL 判据），不能参与深比较，单独断言
const hkNorm = hk.normalize({ hitokoto: " 你好 ", from: "书", from_who: "作者", uuid: "u1" });
check(
  "一言归一化：取 text/from/from_who/uuid",
  hkNorm && { text: hkNorm.text, from: hkNorm.from, fromWho: hkNorm.fromWho, uuid: hkNorm.uuid },
  { text: "你好", from: "书", fromWho: "作者", uuid: "u1" }
);
checkTrue(
  "一言归一化：带毫秒时间戳 ts（30 秒 TTL 的判据，非按天 date）",
  typeof (hkNorm && hkNorm.ts) === "number" && Math.abs(Date.now() - hkNorm.ts) < 1000
);
check("一言归一化：缺正文返回 null", hk.normalize({ hitokoto: "   " }), null);
check("一言格式化：带作者合成「正文 —— 作者」", hk.format({ text: "你好", fromWho: "作者" }), "你好 —— 作者");
check("一言格式化：无作者只留正文", hk.format({ text: "你好" }), "你好");
check("一言位置归一化：合法值原样保留", hk.normalizePosition("topbar"), "topbar");
check("一言位置归一化：非法值回落 sidebar", hk.normalizePosition("garbage"), "sidebar");
check("一言位置归一化：缺省回落 sidebar", hk.normalizePosition(undefined), "sidebar");
process.env.MS_REWARDS_STORAGE_DIR = hkEnvBackup;
fs.rmSync(hkRoot, { recursive: true, force: true });

// —— 壁纸限流（滑动窗口，纯内存无副作用）——
const wl = require(path.join(ROOT, "src", "wallpaper-limit.js"));
wl.reset();
const wlBase = 1_000_000;
let wlOk = 0;
for (let i = 0; i < wl.MAX_PER_MIN; i++) if (wl.take("1.2.3.4", wlBase + i * 10)) wlOk++;
check(`窗口内前 ${wl.MAX_PER_MIN} 次全部放行`, wlOk, wl.MAX_PER_MIN);
check(`第 ${wl.MAX_PER_MIN + 1} 次被拦截`, wl.take("1.2.3.4", wlBase + wl.MAX_PER_MIN * 10), false);
// 窗口滑过 60 秒后重新放行
check("窗口滑过 60 秒后重新放行", wl.take("1.2.3.4", wlBase + 60 * 1000 + 1), true);
wl.reset();
for (let i = 0; i < wl.MAX_PER_MIN; i++) wl.take("5.6.7.8", wlBase + i * 10);
check("不同 IP 互不影响（B 不受 A 满额影响）", wl.take("9.9.9.9", wlBase + 1), true);
check("IPv4-mapped IPv6 归一化到同一来源", wl.normalizeIp("::ffff:1.2.3.4"), "1.2.3.4");
check("回环统一归一到本机 key", [wl.normalizeIp("::1"), wl.normalizeIp("127.0.0.1")], [wl.LOCAL_KEY, wl.LOCAL_KEY]);
check("XFF 取第一跳", wl.ipFromRequest({ headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" }, socket: { remoteAddress: "6.6.6.6" } }), "1.2.3.4");
check("无代理头回落 socket 地址", wl.ipFromRequest({ headers: {}, socket: { remoteAddress: "6.6.6.6" } }), "6.6.6.6");

// —— 壁纸限流档位：每 IP 每分钟 30 次（2026-10-03 用户指定，原 60）——
check("壁纸限流档位为每 IP 每分钟 30 次", wl.MAX_PER_MIN, 30);

// —— 壁纸自动轮换间隔必须是正整数、0=关闭（2026-10-03 用户指定）——
const appMod = require(path.join(ROOT, "src", "appearance.js"));
const rotCases = [
  ["0", 0],
  [0, 0],
  [60, 60],
  ["300", 300],
  // 小数一律向下取整（12.9 → 12），不接受小数秒
  [12.9, 12],
  // 非法输入回落 0（关闭），而不是保留旧值或穿出负数
  [-5, 0],
  ["abc", 0],
  ["", 0],
  [null, 0],
  [undefined, 0],
  [NaN, 0],
];
// clampRotate 未导出，通过 set() 侧面验证：set 会走一遍 clampRotate
const rotBad = rotCases
  .map(([input, want]) => {
    const got = appMod.set({ bgRotate: input }).bgRotate;
    return got === want ? null : `输入 ${JSON.stringify(input)} → ${got}，期望 ${want}`;
  })
  .filter(Boolean);
checkTrue(
  "壁纸轮换间隔：0=关闭、正整数生效、小数取整、非法回落 0",
  rotBad.length === 0,
  rotBad.join("；")
);
// 上限 24 小时
checkTrue(
  "壁纸轮换间隔上限 86400 秒（24 小时）",
  appMod.set({ bgRotate: 999999 }).bgRotate === 86400,
  `实际 ${appMod.set({ bgRotate: 999999 }).bgRotate}`
);
wl.reset();

// —— 目标勋章图标 ——
const goalsSrc = fs.readFileSync(path.join(ROOT, "src", "goals.js"), "utf8");
const goalsMod = require(path.join(ROOT, "src", "goals.js"));
checkTrue("目标行带勋章图标前缀", /const MEDAL = "🏅 "/.test(goalsSrc));
const oneLine = goalsMod.formatOne({ name: "测试", current: 120, target: 300, reached: false, remain: 180 });
checkTrue("目标行实际输出带勋章图标", oneLine.startsWith("🏅 "), `实际: ${oneLine}`);
const medalLine = goalsMod.formatOne({ name: "🏅 测试", current: 300, target: 300, reached: true, rewardName: "" });
checkTrue("已带图标的名称不重复叠加", medalLine.startsWith("🏅 ") && !medalLine.startsWith("🏅 🏅 "), `实际: ${medalLine}`);

// —— 通知外壳：版本号 + 一言固定末行 + 无重复 ——
const notifySrc = fs.readFileSync(path.join(ROOT, "src", "notify.js"), "utf8");
checkTrue("notify 复用 displayVersion() 而非手拼版本", /require\("\.\/version"\)/.test(notifySrc) && /displayVersion\(\)/.test(notifySrc));
// sendText 必须仍只调用一次外壳拼装（一言下沉到末行后，外壳是唯一拼装点，
// 不能退化成「正文里拼一次 + 别处再拼一次」）
checkTrue(
  "sendText 仅调用一次 withAccountHeader（外壳唯一拼装点）",
  // testPush 也用外壳（预览用），这里只要求 sendText 函数体内恰好拼装一次
  (() => {
    const from = notifySrc.indexOf("async function sendText");
    const to = notifySrc.indexOf("async function sendSummary");
    return from >= 0 && to > from && (notifySrc.slice(from, to).match(/withAccountHeader\(/g) || []).length === 1;
  })() &&
    /await withAccountHeader\(ctx, text, \{ force: true \}\)/.test(notifySrc)
);
checkTrue(
  "sendSummary 不再二次 withAccountHeader",
  /await sendText\(ctx, `Rewards 运行汇总 \$\{date\}`, summary\)/.test(notifySrc)
);
checkTrue(
  "一言关闭与否只由 quoteLine 一处判定（避免两处口径漂移）",
  /async function quoteLine\(notice, override, force = false\)/.test(notifySrc) &&
    /const line = await quoteLine\(notice, opts\.quote, opts\.force === true\);/.test(notifySrc)
);
// 版式口径（0.13.10.1 修正）：一言**固定末行**，首行留给标题/用户名。
// 曾短暂改成「首行一言、标题下沉」（靠 buildRequests 的 lead + skipTop），
// 导致每日汇总首行变成一句话、把「用户名」挤走 —— 多账户时无法辨认来源。
checkTrue(
  "一言固定末行（buildRequests 不再往首行塞 lead）",
  /const content = opts\.includeTitleInBody === false \? body : `\$\{title\}\\n\$\{body\}`;/.test(notifySrc) &&
    // 回归反例：lead / skipTop 机制整体移除，防止有人再往首行塞
    !/\bskipTop\b/.test(notifySrc) &&
    !/opts\.lead/.test(notifySrc)
);
checkTrue(
  "首行不被一言挤走（正文里一言只追加在末尾）",
  // withAccountHeader 里只允许「末尾追加」，不允许再出现 `body = \`${line}\n${body}\`` 的首行插入
  /if \(!hasQuote\) body = `\$\{body\}\\n\\n\$\{line\}`;/.test(notifySrc) &&
    !/body = `\$\{line\}\\n\$\{body\}`/.test(notifySrc)
);
checkTrue("推送时一言 force 刷新（跳过 30 秒 TTL）", /await withAccountHeader\(ctx, text, \{ force: true \}\)/.test(notifySrc) && /notice: cfg, force: true/.test(notifySrc));
checkTrue("测试推送同样 force 刷新一言", /notice: cfg, force: true/.test(notifySrc));

// —— 一次性完成：force 穿透到任务层，忽略单次数量限制 ——
const tasksForceSrc = fs.readFileSync(path.join(ROOT, "src", "tasks.js"), "utf8");
const runnerForceSrc = fs.readFileSync(path.join(ROOT, "src", "runner.js"), "utf8");
checkTrue("runner 用派生 ctx 传递 force（不污染原账户上下文）", /opts\.force === true \? \{ \.\.\.ctxRaw, force: true \} : ctxRaw/.test(runnerForceSrc));
checkTrue("阅读任务在 force 时按 base=0（不限制）", /ctx\.force \? 0 : limits\.read/.test(tasksForceSrc));
checkTrue("活动任务在 force 时按 base=0（不限制）", /ctx\.force \? 0 : limits\.promos/.test(tasksForceSrc));
checkTrue(
  "搜索不再按服务器剩余额度硬截断（setBase 优先，否则 force/随机）",
  /const setBase = normalizeLimits\(cfg\.limits\)\.search;/.test(tasksForceSrc) &&
    !/const limit = Math\.max\(1, Math\.min\(randInt\(4, 7\), remaining\)\)/.test(tasksForceSrc)
);

// —— 默认值跨文件同步（含 hitokoto / hitokotoPosition）——
check("config.DEFAULTS.notice 含 hitokoto 开关与位置", cfgDefaults.notice.hitokotoPosition, "sidebar");
check("global-config 默认值同步含位置", globalDefaults.notice.hitokotoPosition, "sidebar");
checkTrue("渲染层 mock 默认值同步含位置", /hitokotoPosition: "sidebar"/.test(mockSrc));
checkTrue("设置页出现一只言位置下拉", /显示位置/.test(formSrc) && /hitokotoPosition/.test(formSrc));

// —— 一言句子类型（0.13.13）：类型表跨文件同步 + 三处取句都传 types ——
// 独立读源，不复用别处变量（同文件内重复声明会 SyntaxError，未定义则是 ReferenceError）
const hkMainSrc = fs.readFileSync(path.join(ROOT, "src", "electron-main.js"), "utf8");
const hkWebApiSrc = fs.readFileSync(path.join(ROOT, "src", "web-api.js"), "utf8");
const hkTypesSrc = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "types", "index.ts"), "utf8");
checkTrue("config 默认一言不限类型", Array.isArray(cfgDefaults.notice.hitokotoTypes) && cfgDefaults.notice.hitokotoTypes.length === 0);
checkTrue("global-config 默认一言不限类型", Array.isArray(globalDefaults.notice.hitokotoTypes) && globalDefaults.notice.hitokotoTypes.length === 0);
checkTrue("mock 默认一言不限类型", /hitokotoTypes: \[\]/.test(mockSrc));
checkTrue("渲染层类型声明包含 hitokotoTypes", /hitokotoTypes: string\[\]/.test(hkTypesSrc));
checkTrue(
  "设置页句子类型 chip 表与后端 TYPES 逐项一致（12 类）",
  /HITOKOTO_TYPE_OPTIONS/.test(formSrc) &&
    ["a动画", "b漫画", "c游戏", "d文学", "e原创", "f来自网络", "g其他", "h影视", "i诗词", "j网易云", "k哲学", "l抖机灵"].every(
      (pair) => formSrc.includes(`label: "${pair.slice(1)}", value: "${pair.slice(0, 1)}"`)
    )
);
checkTrue(
  "设置页把非法/缺失的类型当「不限」处理（不抛错）",
  /Array\.isArray\(value\.notice\?\.hitokotoTypes\)/.test(formSrc)
);
// 取句三处（主进程 IPC / Web API / 推送）都必须把类型透传给后端
checkTrue("主进程 hitokoto:get 透传全局配置的句子类型", /hitokoto\.get\(\{ types: globalConfig\.get\(\)\?\.notice\?\.hitokotoTypes \}\)/.test(hkMainSrc));
checkTrue("Web API getHitokoto 透传句子类型", /hitokoto\.get\(\{ types: globalConfig\.get\(\)\?\.notice\?\.hitokotoTypes \}\)/.test(hkWebApiSrc));
checkTrue("推送 quoteLine 透传句子类型", /hitokoto\.get\(\{ force, types: cfg\.hitokotoTypes \}\)/.test(notifySrc));

// —— 一言「标题栏」位置 = 窗口原生标题栏（2026-10-01 用户反馈：应落在系统标题栏）——
// 链路：App 上报 → preload 暴露 setWindowSubtitle → 主进程拼 base + 一言后 setTitle。
// 反例防线：不得退回「应用内顶栏渲染一行小字」（旧 hk-inline 写法）。
// 独立读源，避免与其他段落同名变量冲突。
const mainSrcTb = fs.readFileSync(path.join(ROOT, "src", "electron-main.js"), "utf8");
const preloadSrcTb = fs.readFileSync(path.join(ROOT, "src", "electron-preload.js"), "utf8");
const appSrcTb = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "App.tsx"), "utf8");
checkTrue(
  "标题栏一言：App 仅在 topbar 位置上报，切走/关闭时传空串还原",
  /hitokotoPosition === "topbar" && !!hitokoto/.test(appSrcTb) &&
    /setWindowSubtitle\(onTopbar \? hitokoto : ""\)/.test(appSrcTb)
);
checkTrue("标题栏一言：顶栏不再自渲染（hk-inline 已移除）", !/hk-inline/.test(appSrcTb));
checkTrue(
  "标题栏一言：preload 暴露 setWindowSubtitle",
  /setWindowSubtitle: \(text\) => ipcRenderer\.invoke\("window:setSubtitle"/.test(preloadSrcTb)
);
checkTrue(
  "标题栏一言：主进程拼进原生窗口标题（setTitle + 版本号前缀）",
  /ipcMain\.handle\("window:setSubtitle"/.test(mainSrcTb) &&
    /MS Rewards 自动任务 v\$\{displayVersion\(\)\}/.test(mainSrcTb) &&
    /mainWindow\.setTitle\(sub \? `\$\{base\} · \$\{sub\}` : base\)/.test(mainSrcTb)
);
checkTrue(
  "标题栏一言：浏览器/mock 端同步 document.title 兜底",
  /setWindowSubtitle: async \(text: string\)/.test(mockSrc) && /document\.title = text/.test(mockSrc)
);

// —— 关于页「每日一言」板块（2026-10-01 用户要求）——
const aboutSrcAq = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "views", "About.tsx"), "utf8");
const cssAq = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "styles", "global.css"), "utf8");
checkTrue(
  "关于页：存在「每日一言」板块且展示当前一言",
  /每日一言/.test(aboutSrcAq) && /useAppState/.test(aboutSrcAq) && /about-quote-text/.test(aboutSrcAq)
);
checkTrue(
  "关于页一言：支持复制当前一言",
  /const onCopyQuote = async/.test(aboutSrcAq) && /copyText\(hitokoto\)/.test(aboutSrcAq)
);
checkTrue("关于页一言：样式落地（引用块 + 装饰引号）", /\.about-quote\s*\{/.test(cssAq) && /\.about-quote-text\s*\{/.test(cssAq));

// —— mock 全局配置须可写（否则预览里全局项改完立刻被冲回默认，误判功能坏）——
checkTrue(
  "mock：全局配置可写（preview 改动不被冲回默认）",
  /let defaultConfig: AppConfig = mergeDeep/.test(mockSrc) &&
    /setGlobalConfig: async \(patch\) => \{[\s\S]{0,120}defaultConfig = mergeDeep\(defaultConfig, patch\)/.test(mockSrc)
);

// —— 一言：15 秒轮询 + 后台暂停 + 点击复制（批次 C）——
const hookSrc = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "hooks", "useAppState.tsx"), "utf8");
const hkInterval = hookSrc.slice(hookSrc.indexOf("hitokotoEnabled ="), hookSrc.indexOf("}, [hitokotoEnabled, globalConfig])"));
checkTrue("一言轮询间隔为 15 秒（非按天）", /const TICK_MS = 15_000;/.test(hkInterval));
const hkSrcFile = fs.readFileSync(path.join(ROOT, "src", "hitokoto.js"), "utf8");
checkTrue("一言后端缓存 TTL 同为 15 秒（前后端同频）", /const TTL_MS = 15_000;/.test(hkSrcFile));
checkTrue(
  "一言后台（窗口隐藏）时停止轮询，切回前台立即刷新",
  /addEventListener\("visibilitychange", onVisibility\)/.test(hkInterval) &&
    /if \(document\.hidden\) \{\s*stop\(\);/.test(hkInterval) &&
    /fetchQuote\(\);\s*start\(\);/.test(hkInterval)
);
// 反例防线：绝不能退化成「一条永不停歇的 setInterval」，那会在后台持续请求公益接口
checkTrue(
  "一言定时器可停（未写成不可控的裸定时轮询）",
  !/setInterval\(fetchQuote, TICK_MS\)\s*;?\s*\n\s*\}, \[/.test(hkInterval) && /if \(!document\.hidden\) start\(\);/.test(hkInterval)
);

const appSrcHk = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "App.tsx"), "utf8");
const sidebarSrcHk = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "components", "Sidebar.tsx"), "utf8");
const globalCssHk = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "styles", "global.css"), "utf8");
for (const [label, src] of [["App.tsx", appSrcHk], ["Sidebar.tsx", sidebarSrcHk]]) {
  checkTrue(`${label} 支持点击一言复制到剪贴板`, /const copyHitokoto = /.test(src) && /writeText\(hitokoto\)/.test(src));
}
// 一言在界面内出现的两处容器：侧边栏 / 右下角，都必须挂上可点击的钩子。
// （标题栏位置已迁到**窗口原生标题栏**，由系统绘制、无法挂点击钩子，见上方「标题栏一言」组）
checkTrue("界面内两处（侧边栏 / 右下角）都挂 hk-clickable 复制钩子", (appSrcHk.match(/hk-clickable/g) || []).length === 1 && /hk-clickable/.test(sidebarSrcHk));
checkTrue("global.css 定义 .hk-clickable 悬停反馈", /\.hk-clickable/.test(globalCssHk) && /\.hk-clickable:hover/.test(globalCssHk));

// —— 推送版式：跑真实路径（桩掉 fetch / 临时 storage），断言最终报文 ——
// 静态正则只能证明代码长这样；这里证明「收到的消息真的是这样」。
try {
  const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "verify-notify-format.js")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  checkTrue("推送版式真实路径验收", /✅ 推送版式验收通过/.test(out), `输出: ${String(out).trim().slice(0, 200)}`);
} catch (e) {
  checkTrue("推送版式真实路径验收", false, `脚本失败: ${String(e.stdout || e.message).trim().slice(0, 300)}`);
}

/* ============ N. 签到日历与勋章 ============ */
console.log("\n【N】签到日历与勋章（0.13.11 新增）");
const osMod = require("os");
const lunarMod = require(path.join(ROOT, "src", "lunar.js"));
const badgesMod = require(path.join(ROOT, "src", "badges.js"));
const historyMod = require(path.join(ROOT, "src", "history.js"));

const fmtD = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// —— 农历换算：用已知的春节/中秋等日期钉死，表改错立刻红 ——
check("农历：2026 春节 = 2026-02-17", fmtD(lunarMod.lunarToSolar(2026, 1, 1)), "2026-02-17");
check("农历：2026 中秋 = 2026-09-25", fmtD(lunarMod.lunarToSolar(2026, 8, 15)), "2026-09-25");
check("农历：2026 端午 = 2026-06-19", fmtD(lunarMod.lunarToSolar(2026, 5, 5)), "2026-06-19");
check("农历：2026 七夕 = 2026-08-19", fmtD(lunarMod.lunarToSolar(2026, 7, 7)), "2026-08-19");
const revA = lunarMod.solarToLunar("2025-01-29");
checkTrue("农历反向：2025-01-29 是正月初一", revA.month === 1 && revA.day === 1, JSON.stringify(revA));
const revB = lunarMod.solarToLunar("2024-02-10");
checkTrue("农历反向：2024-02-10 是正月初一", revB.month === 1 && revB.day === 1, JSON.stringify(revB));

// —— 节日判定 ——
check("节日：2026-12-25 是圣诞节", (badgesMod.festivalOn("2026-12-25") || {}).id, "christmas");
check("节日：2026-10-31 是万圣节", (badgesMod.festivalOn("2026-10-31") || {}).id, "halloween");
check("节日：2026-04-01 是愚人节", (badgesMod.festivalOn("2026-04-01") || {}).id, "fool");
check("节日：2026-08-19 是七夕", (badgesMod.festivalOn("2026-08-19") || {}).id, "qixi");
check("节日：2026-09-25 是中秋", (badgesMod.festivalOn("2026-09-25") || {}).id, "midautumn");
check("节日：平常日子不误判为节日", badgesMod.festivalOn("2026-09-30"), null);
check("节日：2026 全年共 20 个节日", badgesMod.festivalsOfYear(2026).length, 20);
checkTrue(
  "节日：清明节按节气浮动（2026-04-05）",
  badgesMod.qingmingDay(2026) === "2026-04-05",
  badgesMod.qingmingDay(2026)
);

// —— 勋章元数据：前端 badgeMeta.ts 必须与主进程 badges.js 逐字段一致 ——
const metaSrc = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "data", "badgeMeta.ts"), "utf8");
const metaTriples = [...metaSrc.matchAll(/id:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*desc:\s*"[^"]*",\s*iconKey:\s*"([^"]+)"/g)]
  .map((m) => `${m[1]}|${m[2]}|${m[3]}`)
  .sort();
const jsTriples = badgesMod.allBadges().map((b) => `${b.id}|${b.name}|${b.iconKey}`).sort();
check("勋章元数据：前端与主进程 id/名称/图形一一对应", metaTriples, jsTriples);
check("勋章总数：6 连续 + 1 全勤 + 20 节日 = 27", badgesMod.allBadges().length, 27);

// 勋章命名必须是「直白说天数」，不能是文言名。
// 0.14.1 用了「三日之约/ 七日成习 / 旬日如初 / 双周之契 / 廿日长明 / 廿八星宿」，
// 用户反馈「不好」——名字是给人看的，不是给人猜的。0.14.2 起全部改回「连续 N 天」。
const streakNames = badgesMod.STREAK_BADGES.map((b) => b.name);
checkTrue(
  "连续签到勋章名为「连续 N 天」直白说法（不再是文言名）",
  streakNames.length === 6 &&
    streakNames.every((n, i) => n === `连续 ${badgesMod.STREAK_BADGES[i].days} 天`),
  streakNames.join(" / ")
);
// 防文艺措辞回流：这几个词一个都不该再出现在勋章名里
checkTrue(
  "勋章名不含文艺措辞（三日之约 / 旬日如初 等一律不得复活）",
  !/三日之约|七日成习|旬日如初|双周之契|廿日长明|廿八星宿/.test(metaSrc),
  "badgeMeta.ts 里又出现文艺勋章名了（用户明确要求改简单）"
);
// 描述也必须带「连续」，与日历里的连续签到天数呼应
checkTrue(
  "每枚连续签到勋章的描述都点明「连续 N 天全部完成」",
  badgesMod.STREAK_BADGES.every(
    (b) => b.desc === `连续 ${b.days} 天全部完成`
  ),
  badgesMod.STREAK_BADGES.map((b) => b.desc).join(" / ")
);

// —— 历史与勋章结算（真实读写临时目录） ——
const tmpHist = fs.mkdtempSync(path.join(osMod.tmpdir(), "msr-hist-"));
try {
  const hh = historyMod.createHistory(tmpHist);
  const D = { status: "done", done: 5, total: 5, points: 80 };
  for (let i = 1; i <= 10; i++) hh.record(`2026-03-${String(i).padStart(2, "0")}`, D);
  check("历史：连 10 天 → streak3 计数 1", hh.getBadges().streak3.count, 1);
  check("历史：连 10 天 → streak10 计数 1", hh.getBadges().streak10.count, 1);
  check("历史：连 10 天 → 未到 14 天不给", hh.getBadges().streak14, undefined);

  // 断一天后重新连 3 天：同一档位应再发一次（否则「获得次数」永远停在 1）
  hh.record("2026-03-11", { status: "error" });
  for (const d of [12, 13, 14]) hh.record(`2026-03-${d}`, D);
  check("历史：断后重新连 3 天 → streak3 累计 2", hh.getBadges().streak3.count, 2);

  // 部分完成会中断连续
  hh.record("2026-05-01", D);
  hh.record("2026-05-02", { status: "partial", done: 2, total: 5 });
  check("历史：部分完成中断连续（streak 归 1）", hh.record("2026-05-03", D).streak, 1);

  // 好状态覆盖坏状态
  hh.record("2026-04-01", { status: "error" });
  hh.record("2026-04-01", D);
  check("历史：先报错后跑通 → 记为 done", hh.getMonth(2026, 4).days[0].status, "done");
  check("历史：4/1 是愚人节 → 顺带拿到节日勋章", (hh.getBadges().fool || {}).count, 1);
  // 反向：先成功后报错，不能被降级成 error（否则跑完又重试失败会把绿格子刷红）
  hh.record("2026-04-02", D);
  hh.record("2026-04-02", { status: "error" });
  check("历史：先跑通后报错 → 不降级，仍为 done", hh.getMonth(2026, 4).days[1].status, "done");

  // 月全勤
  for (let d = 1; d <= 30; d++) hh.record(`2026-06-${String(d).padStart(2, "0")}`, D);
  check("历史：整月完成 → month.perfect", hh.getMonth(2026, 6).perfect, true);
  check("历史：整月完成 → 授出全勤勋章", (hh.getBadges().perfectMonth || {}).count, 1);
  check("历史：缺一天就不算全勤", hh.getMonth(2026, 3).perfect, false);

  // 今天未跑不算断：连续天数从昨天往前数
  const hh2 = historyMod.createHistory(fs.mkdtempSync(path.join(osMod.tmpdir(), "msr-hist-")));
  const t = new Date();
  const dKey = (dt) => fmtD(dt);
  for (let i = 1; i <= 3; i++) {
    const dd = new Date(t.getFullYear(), t.getMonth(), t.getDate() - i);
    hh2.record(dKey(dd), D);
  }
  check("历史：今天还没跑时，连续天数从昨天算起", hh2.getStreak(), 3);
} finally {
  fs.rmSync(tmpHist, { recursive: true, force: true });
}

// —— 运行流程接入 ——
const runnerSrc = fs.readFileSync(path.join(ROOT, "src", "runner.js"), "utf8");
checkTrue("运行流程：成功后写入每日历史", /recordDay\(ctx, result, "ok"\)/.test(runnerSrc));
checkTrue("运行流程：出错写入 error 状态", /recordDay\(ctx, null, "error"\)/.test(runnerSrc));
checkTrue(
  "运行流程：写在 runAccountGuarded 层（覆盖中途 return 的分支）",
  /const result = await runOnce\(ctx, opts\);[\s\S]{0,80}recordDay\(ctx, result, "ok"\)/.test(runnerSrc)
);
const accountSrc = fs.readFileSync(path.join(ROOT, "src", "account.js"), "utf8");
checkTrue("账户上下文挂载 history 实例", /history: createHistory\(dir\)/.test(accountSrc));

// —— 接口链路六处同步（缺一处就是白屏或 RPC 未知方法） ——
const preloadSrc = fs.readFileSync(path.join(ROOT, "src", "electron-preload.js"), "utf8");
const mainSrcHist = fs.readFileSync(path.join(ROOT, "src", "electron-main.js"), "utf8");
const webApiSrc = fs.readFileSync(path.join(ROOT, "src", "web-api.js"), "utf8");
const webTsSrc = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "api", "web.ts"), "utf8");
const mockApiSrc = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "api", "mock.ts"), "utf8");
const dtsSrc = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "types", "electron.d.ts"), "utf8");
checkTrue("接口链路：preload 暴露 getHistory", /getHistory:/.test(preloadSrc) && /"history:get"/.test(preloadSrc));
checkTrue("接口链路：主进程注册 history:get", /ipcMain\.handle\("history:get"/.test(mainSrcHist));
checkTrue("接口链路：web-api 提供 getHistory", /getHistory\(id, year, month\)/.test(webApiSrc));
checkTrue("接口链路：web.ts 转发 getHistory", /getHistory: \(id, year, month\) => rpc/.test(webTsSrc));
checkTrue("接口链路：mock 提供 getHistory（dev:web 可预览）", /getHistory: async/.test(mockApiSrc));
checkTrue("接口链路：类型声明含 getHistory", /getHistory\(id: string/.test(dtsSrc));

// —— 内置下载更新：downloadUpdate 六处同步（缺一处就是「点了下载没反应 / 静默失败」）——
const appUpdateSrc = fs.readFileSync(path.join(ROOT, "src", "app-update.js"), "utf8");
checkTrue("下载链路：preload 暴露 downloadUpdate + 进度订阅", /downloadUpdate: \(url, assetName\)/.test(preloadSrc) && /onUpdateDownloadProgress/.test(preloadSrc));
checkTrue("下载链路：主进程注册 下载/取消/安装/打开文件夹 四 handler", /ipcMain\.handle\("app:downloadUpdate"/.test(mainSrcHist) && /ipcMain\.handle\("app:cancelUpdateDownload"/.test(mainSrcHist) && /ipcMain\.handle\("app:runUpdateInstaller"/.test(mainSrcHist) && /ipcMain\.handle\("app:revealUpdateFile"/.test(mainSrcHist));
checkTrue("下载链路：主进程推送进度事件 update-download-progress", /"update-download-progress"/.test(mainSrcHist));
checkTrue("下载链路：app-update 提供流式 downloadUpdate（走镜像链 + 空闲看门狗 + 断点续传）", /async function downloadUpdate/.test(appUpdateSrc) && /MIRROR_PREFIXES/.test(appUpdateSrc) && /STALL_IDLE_MS/.test(appUpdateSrc) && /PART_SUFFIX/.test(appUpdateSrc) && /headers\.Range = `bytes=\$\{have\}-`/.test(appUpdateSrc), "下载卡死三件套（空闲超时/断点续传/.part 半成品）任一缺失 → 弱网下下载会挂死或从 0 重来");
checkTrue("下载链路：web.ts 提供 downloadUpdate（Docker 提示语义）", /downloadUpdate: async/.test(webTsSrc));
checkTrue("下载链路：mock 提供 downloadUpdate（预览提示语义）", /downloadUpdate: async/.test(mockApiSrc));
checkTrue("下载链路：类型声明含 downloadUpdate 与进度", /downloadUpdate\(url: string, assetName: string\)/.test(dtsSrc) && /UpdateDownloadProgress/.test(dtsSrc));

// —— 日历界面静态守卫 ——
const calSrc = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "views", "CalendarPanel.tsx"), "utf8");
const calCss = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "styles", "global.css"), "utf8");
checkTrue("日历：四态 class 由 status 驱动", /cal-\$\{d\.status\}/.test(calSrc));
// 文案与勋章命名都改回平实直白（用户反馈 0.14.1 那套「三日之约」「一日不断」
// 文艺风「不好」）。守卫随之回退到断言原始文案。
checkTrue(
  "日历：连续签到文案为平实说法（不含文艺措辞）",
  /您已使用本软件连续签到/.test(calSrc) &&
    /继续努力/.test(calSrc) &&
    !/一日不断/.test(calSrc) &&
    !/今日启程/.test(calSrc),
  "连续签到文案又变回文艺版了（用户明确要求改回直白说法）"
);
checkTrue("日历：账号下拉切换（只显示一个账号）", /<Select[\s\S]{0,200}onChange=\{\(v\) => setId\(v\)\}/.test(calSrc));
checkTrue("日历：可上下翻月", /shift\(-1\)/.test(calSrc) && /shift\(1\)/.test(calSrc));
checkTrue("日历：一次只取一个月", /api\s*\.getHistory\(id, year, month\)/.test(calSrc.replace(/\s+/g, " ")) || /getHistory\(id, year, month\)/.test(calSrc));
checkTrue("勋章墙：展示每枚勋章的获得次数", /cal-bcount/.test(calSrc) && /×\{n\}/.test(calSrc));
checkTrue("勋章墙：未获得的勋章置灰", /dim=\{n === 0\}/.test(calSrc));
for (const cls of ["cal-done", "cal-partial", "cal-idle", "cal-error"]) {
  checkTrue(`日历 CSS：${cls} 已定义且为浅调半透明`, new RegExp(`\\.${cls}\\s*\\{[^}]*background:\\s*rgb\\([^)]*\\/\\s*0?\\.\\d+\\)`).test(calCss));
}

// ============================ 节假日 / 农历 / 调休 ============================
console.log("\n【O】法定节假日 / 农历 / 调休（0.13.11 增强）");
const holidayMod = require(path.join(ROOT, "src", "holiday.js"));
const holidaySrc = fs.readFileSync(path.join(ROOT, "src", "holiday.js"), "utf8");
const historySrc = fs.readFileSync(path.join(ROOT, "src", "history.js"), "utf8");
const idxSrc = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "types", "index.ts"), "utf8");

// —— 农历日名 / 节日短名（纯函数）——
check("农历日名：2026-09-25（八月中秋）→ 十五", historyMod.lunarDayLabel("2026-09-25"), "十五");
check("农历日名：2026-02-17（正月初一）→ 正月", historyMod.lunarDayLabel("2026-02-17"), "正月");
check("农历日名：2026-12-24（冬月十六）→ 十六", historyMod.lunarDayLabel("2026-12-24"), "十六");
check("短名：中秋节 → 中秋", historyMod.shortDayName("中秋节"), "中秋");
check("短名：元旦/春节本身不带节不截断", historyMod.shortDayName("元旦"), "元旦");

// —— 节假日数据归一化（网络数据的判据，纯函数无网络）——
const hlNorm = holidayMod.normalizeDays([
  { name: "中秋节", date: "2026-09-25", isOffDay: true },
  { name: "国庆节", date: "2026-10-10", isOffDay: false },
]);
check("节假日：isOffDay:true → 法定放假日（休）", hlNorm["2026-09-25"].rest, true);
check("节假日：isOffDay:false → 调休上班（班）", hlNorm["2026-10-10"].rest, false);
check("节假日：节名保留供展示", hlNorm["2026-09-25"].name, "中秋节");
checkTrue(
  "节假日：双源抓取 + 磁盘缓存 + 后台刷新 + 启动预热齐备",
  /fetchHolidayCn/.test(holidaySrc) && /fetchTimor/.test(holidaySrc) &&
    /function dayHoliday/.test(holidaySrc) && /function warmup/.test(holidaySrc) &&
    /CACHE_TTL_MS/.test(holidaySrc)
);
checkTrue("启动预热：electron-main 调用 holiday.warmup()", /holiday\.warmup\(\)/.test(mainSrcHist));
checkTrue(
  "历史：getMonth 拼装 weekend/lunar/festival/rest/workday/label",
  /holiday\.dayHoliday\(key\)/.test(historySrc) &&
    /label: festName \|\| lunarDayLabel\(key\)/.test(historySrc)
);

// —— getMonth 集成（离线可复现：周末/节日/农历均不依赖网络）——
const tmpCal = fs.mkdtempSync(path.join(osMod.tmpdir(), "msr-cal-"));
try {
  const hhCal = historyMod.createHistory(tmpCal);
  const mSep = hhCal.getMonth(2026, 9);
  const byKey = (k) => mSep.days.find((x) => x.key === k) || {};
  check("日历：9/25（周五）非周末", byKey("2026-09-25").weekend, false);
  check("日历：9/26（周六）是周末", byKey("2026-09-26").weekend, true);
  check("日历：9/27（周日）是周末", byKey("2026-09-27").weekend, true);
  check("日历：9/25 是中秋 → 小字显示「中秋」", byKey("2026-09-25").label, "中秋");
  check("日历：9/25 农历日名「十五」", byKey("2026-09-25").lunar, "十五");
  check("节假日：只标节日当天，9/26 中秋续假 → label 显农历「十六」不显中秋", byKey("2026-09-26").label, "十六");
  check("日历：9/28（无节日普通日）小字=农历「十八」", byKey("2026-09-28").label, "十八");
  check("日历：9/28 无传统节日", byKey("2026-09-28").festival, "");
} finally {
  fs.rmSync(tmpCal, { recursive: true, force: true });
}

// —— 前端渲染与配色 ——
checkTrue(
  "日历：渲染大数字 + 小字 + 休/班角标",
  /cal-day/.test(calSrc) && /cal-label/.test(calSrc) && /cal-tag-rest/.test(calSrc) && /cal-tag-work/.test(calSrc)
);
checkTrue(
  "日历：蓝数字判据 = 法定休 或（周末且非调休）",
  /isBlue = !!d\.rest \|\| \(!!d\.weekend && !d\.workday\)/.test(calSrc)
);
checkTrue(
  "日历 CSS：蓝数字 + 休/班角标样式",
  /\.cal-blue \.cal-day/.test(calCss) && /\.cal-tag-rest/.test(calCss) && /\.cal-tag-work/.test(calCss)
);
checkTrue(
  "日历 CSS：字号随卡片流式缩放（cal-card 容器查询 + clamp/cqw，全屏不再字小）",
  /\.cal-card\s*\{[^}]*container-type:\s*inline-size/.test(calCss) &&
    /\.cal-day\s*\{[^}]*font-size:\s*clamp\([^)]*cqw/.test(calCss) &&
    /\.cal-label\s*\{[^}]*font-size:\s*clamp\([^)]*cqw/.test(calCss) &&
    /\.cal-pts\s*\{[^}]*font-size:\s*clamp\([^)]*cqw/.test(calCss)
);
checkTrue(
  "类型：CalendarDay 含 rest/workday/weekend/lunar/label",
  /rest\?: boolean/.test(idxSrc) && /workday\?: boolean/.test(idxSrc) &&
    /weekend\?: boolean/.test(idxSrc) && /lunar\?: string/.test(idxSrc) && /label\?: string/.test(idxSrc)
);
checkTrue(
  "mock：造周末/农历/中秋休/国庆班样例（dev:web 可预览角标）",
  /holidayMap/.test(mockApiSrc) && /"2026-10-10": \{ name: "国庆", rest: false \}/.test(mockApiSrc) &&
    /label: fest \|\| lunar/.test(mockApiSrc) // 只标节日当天，续假回落农历（批次5）
);

// ============ 【P】成就与统计独立页（仪表盘日历拆分） ============
const appSrcView = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "App.tsx"), "utf8");
const achvPath = path.join(ROOT, "src-renderer", "src", "views", "AchievementsView.tsx");
const achvSrc = fs.existsSync(achvPath) ? fs.readFileSync(achvPath, "utf8") : "";
checkTrue(
  "页面：AchievementsView 独立页存在且包裹 CalendarPanel",
  /CalendarPanel/.test(achvSrc)
);
checkTrue(
  "页面：ViewKey 含 achievements 且 VIEW_META 标题为「成就与统计」",
  /"achievements"/.test(appSrcView) && /成就与统计/.test(appSrcView)
);
checkTrue(
  "页面：App 按 view === \"achievements\" 渲染 AchievementsView",
  /view === "achievements" && <AchievementsView/.test(appSrcView)
);
checkTrue(
  "页面：侧边栏含成就与统计导航项",
  /achievements/.test(sidebarSrc) && /成就与统计/.test(sidebarSrc)
);
checkTrue(
  "页面：仪表盘不再内嵌日历（已拆到独立页）",
  !/CalendarPanel/.test(dashSrc)
);
checkTrue(
  "页面：统计卡 cal-stats/StatItem 五项齐备 + CSS 落地",
  /cal-stats/.test(calSrc) && /StatItem/.test(calSrc) &&
    /累计完成/.test(calSrc) && /最长连续/.test(calSrc) && /总积分/.test(calSrc) &&
    /\.cal-stats/.test(calCss) && /\.cal-stat-value/.test(calCss) && /\.cal-stat-label/.test(calCss)
);
const compactAchievements = [
  /:root\[data-web="1"\]\s+\.achievements-view \.cal-stat-value\s*\{[^}]*font-size:\s*clamp\(18px,\s*1\.7cqw,\s*26px\)/,
  /:root\[data-web="1"\]\s+\.achievements-view \.cal-cell\s*\{[^}]*aspect-ratio:\s*auto[^}]*height:\s*clamp\(68px,\s*6\.5cqw,\s*96px\)[^}]*min-height:\s*0/,
  /:root\[data-web="1"\]\s+\.achievements-view \.cal-bname\s*\{[^}]*font-size:\s*clamp\(10px,\s*1\.05cqw,\s*14px\)/,
];
checkTrue(
  "网页版成就页独立作用域启用紧凑统计、日历与勋章规格",
  /className="achievements-view"/.test(achvSrc) && compactAchievements.every((rule) => rule.test(calCss))
);
checkTrue(
  "Web 成就页移动端释放内容宽度并将导航切为横向",
  /view === "achievements" \? " shell-achievements"/.test(appSrcView) &&
    /\.shell\.shell-achievements \{\s*flex-direction:\s*column/.test(calCss) &&
    /\.shell\.shell-achievements \.sidenav \{[^}]*width:\s*100%/.test(calCss) &&
    /\.shell\.shell-achievements \.nav-switch,[\s\S]*?flex-direction:\s*row/.test(calCss) &&
    /\.achievements-view \.cal-cell\s*\{[^}]*min-width:\s*0[^}]*min-height:\s*0/.test(calCss)
);
// —— 桌面全屏不再铺满：限宽居中 + 勋章墙右移 + 字号封顶（2026-10-01 二次反馈） ——
checkTrue(
  "成就页内容限宽居中（宽屏不再把日历拉满屏）",
  /\.achievements-view \{[^}]*max-width:\s*1460px[^}]*margin-inline:\s*auto/.test(calCss)
);
checkTrue(
  "宽屏（≥1280px）成就页勋章墙整体移到日历右侧（两栏分区 + grid-area 落位）",
  /@media \(min-width: 1280px\) \{\s*\.achievements-view \.cal-card \{[\s\S]*?grid-template-columns:[^;]*clamp\(300px,\s*32cqw,\s*420px\)[\s\S]*?"cal\s+badges"[\s\S]*?"legend\s+badges"/.test(
    calCss
  ) &&
    /\.achievements-view \.cal-grid \{ grid-area: cal; \}/.test(calCss) &&
    /\.achievements-view \.cal-badges-col \{[^}]*grid-area: badges;/.test(calCss) &&
    /className="cal-badges-col"/.test(calSrc)
);
checkTrue(
  "成就页字号封顶：日期 ≤23px / 统计数字 ≤25px / 日历格 ≤88px",
  /\.achievements-view \.cal-day \{ font-size: clamp\(15px, 1\.8cqw, 23px\); \}/.test(calCss) &&
    /\.achievements-view \.cal-stat-value \{ font-size: clamp\(18px, 2\.1cqw, 25px\); \}/.test(calCss) &&
    /\.achievements-view \.cal-cell \{[^}]*min-height:\s*clamp\(48px,\s*5\.6cqw,\s*88px\)/.test(calCss)
);
checkTrue(
  "连续签到天数回归文案内着色（不再是独立大号数字）",
  !/cal-streak-num/.test(calSrc) &&
    /<b>\{streak\}<\/b>/.test(calSrc) &&
    /\.achievements-view \.cal-streak-txt b \{[^}]*color:\s*#7edca0/.test(calCss)
);
checkTrue(
  "勋章墙：每行固定 4 个（不再 auto-fill 自适应）",
  /\.achievements-view \.cal-blist \{\s*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/.test(calCss)
);

// —— 滚轮翻月作用域 + 勋章墙展开动画（2026-09-30 二次反馈） ——
checkTrue(
  "日历：滚轮翻月只挂月份栏（cal-nav 带 ref，cal-grid 不带；wheel preventDefault 不带页面滚）",
  /className="cal-nav" ref=\{boxRef\}/.test(calSrc) &&
    !/cal-grid" ref=\{boxRef\}/.test(calSrc) &&
    /addEventListener\("wheel", onWheel, \{ passive: false \}\)/.test(calSrc) &&
    /也可在月份栏滚轮/.test(calSrc)
);
checkTrue(
  "勋章墙：展开/收起动画（cal-badges-wrap 常驻 + grid-rows 0fr→1fr 过渡 + 淡入）",
  /cal-badges-wrap/.test(calSrc) && /cal-badges-inner/.test(calSrc) &&
    /\.cal-badges-wrap\s*\{[^}]*grid-template-rows:\s*0fr/.test(calCss) &&
    /\.cal-badges-wrap\.open\s*\{[^}]*grid-template-rows:\s*1fr/.test(calCss) &&
    /transition:\s*opacity[^;]*transform/.test(calCss)
);

/* ============ Q. 区域锁定加固 / 拦截推送 / 每天开始时间 / 超额执行 ============ */
console.log("\n【Q】区域锁定加固、拦截推送、每天开始时间、超额执行");
const rmodQ = require(path.join(ROOT, "src", "rewards.js"));
const tlQ = require(path.join(ROOT, "src", "task-limit.js"));
const runnerSrcQ = fs.readFileSync(path.join(ROOT, "src", "runner.js"), "utf8");
const notifySrcQ = fs.readFileSync(path.join(ROOT, "src", "notify.js"), "utf8");
const rewardsSrcQ = fs.readFileSync(path.join(ROOT, "src", "rewards.js"), "utf8");
const formSrcQ = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "components", "SettingsForm.tsx"), "utf8");
const typesSrcQ = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "types", "index.ts"), "utf8");

// —— 多源区域判定（judgeMainland 是纯函数，可离线断言）——
checkTrue("导出 judgeMainland 纯函数（多源判定不依赖网络也可验）", typeof rmodQ.judgeMainland === "function");
const jBlocked = rmodQ.judgeMainland(
  [
    { source: "bing", mainland: true, countryCode: "CN" },
    { source: "ipsb", mainland: false, countryCode: "JP", cityEn: "Tokyo", ip: "1.2.3.4" },
  ],
  { lock: true }
);
check("锁定国区：任一探针判境外即拦截（多源取最坏）", jBlocked.ok, false);
checkTrue(
  "拦截原因点名目标区域与判定来源",
  /检测到非中国大陆区域/.test(jBlocked.reason || "") && /ipsb/.test(jBlocked.reason || ""),
  jBlocked.reason
);
check("拦截结果带回触发拦截的出口（国家码 / IP / 归属地）", [jBlocked.ipcc, jBlocked.ip, jBlocked.geo], ["JP", "1.2.3.4", "Tokyo/JP(东京/日本)"]);
check("多源一致为境内 → 放行", rmodQ.judgeMainland(
  [
    { source: "bing", mainland: true, countryCode: "CN" },
    { source: "ipsb", mainland: true, countryCode: "CN" },
  ],
  { lock: true }
).ok, true);
// 保守放行是这条链路的原始设计：不能因为某个 GeoIP 服务抽风就停掉全天任务
check("所有探针都给不出结论时保守放行（不因服务抽风误停任务）", rmodQ.judgeMainland(
  [{ source: "bing", mainland: null }, { source: "ipsb", mainland: null }],
  { lock: true }
).ok, true);
check("未锁区时境外只展示不拦截", rmodQ.judgeMainland([{ source: "ipsb", mainland: false, countryCode: "US" }], { lock: false }).ok, true);

// —— 静态守卫：锁区判定链路 ——
checkTrue(
  "区域判定不再用模块级缓存（多账户 lock 不同会互相污染）",
  !/let cachedHost/.test(rewardsSrcQ) &&
    /return cfg\.region && cfg\.region\.lock \? "cn\.bing\.com" : "www\.bing\.com"/.test(rewardsSrcQ),
  "cachedHost 回归 → 首个账户的判定会被后续账户复用"
);
checkTrue(
  "锁定国区时双站探测 cn.bing.com + www.bing.com（识破分流规则下的直连盲区）",
  /const hosts = lock \? \["cn\.bing\.com", "www\.bing\.com"\] : \[resolveHost\(ctx\)\]/.test(rewardsSrcQ) &&
    /async function probeBingHost/.test(rewardsSrcQ),
  "只探单站 → Clash/Mihomo TUN 下 cn.bing.com 走直连、任务走代理的盲区测不出来"
);
checkTrue(
  "多站取最坏结果（任一非 CN 即整体判非 CN）",
  /const nonCn = decisive\.find\(\(p\) => p\.ipcc !== "CN"\)/.test(rewardsSrcQ)
);
checkTrue(
  "锁定国区额外强制探测 ipsb（境外 GeoIP，用来测真实任务出口）",
  /ipLookup\.queryProvider\("ipsb", ctx\)/.test(rewardsSrcQ),
  "去掉强制交叉验证 → 只信国内源，代理用户会被误判为境内"
);
checkTrue("导出 LOCK_REGION_LABEL（后期按国家/地区锁区时只改一处）", typeof rmodQ.LOCK_REGION_LABEL === "string" && rmodQ.LOCK_REGION_LABEL === "中国大陆");

// —— 归属地展示 geoLabel ——
check("geoLabel：境外带英文城市 → 东京/日本", ipLookup.geoLabel([{ countryCode: "JP", cityEn: "Tokyo" }]), "Tokyo/JP(东京/日本)");
check("geoLabel：太平洋中文城市 → 徐州/中国大陆", ipLookup.geoLabel([{ countryCode: "CN", cityCn: "徐州" }]), "CN(徐州/中国大陆)");
check("geoLabel：ip-api 中文国名直接透传", ipLookup.geoLabel([{ countryCode: "JP", cityCn: "东京", countryCn: "日本" }]), "JP(东京/日本)");
check("geoLabel：无任何地理信息 → 未知", [ipLookup.geoLabel([]), ipLookup.geoLabel(null)], ["未知", "未知"]);
check("geoLabel：只有国家码也能出中文国名", ipLookup.geoLabel([{ countryCode: "SG" }]), "SG(新加坡)");
checkTrue(
  "国家/地区中文名表述完整（港澳台均为中国的一部分）",
  ipLookup.COUNTRY_CN.HK === "中国香港" && ipLookup.COUNTRY_CN.MO === "中国澳门" && ipLookup.COUNTRY_CN.TW === "中国台湾" && ipLookup.COUNTRY_CN.CN === "中国大陆",
  JSON.stringify({ HK: ipLookup.COUNTRY_CN.HK, MO: ipLookup.COUNTRY_CN.MO, TW: ipLookup.COUNTRY_CN.TW })
);

// —— 拦截推送 ——
checkTrue(
  "拦截后推送 IP / 归属地 / 下次执行时间",
  /async function pushRegionBlocked/.test(runnerSrcQ) &&
    /当前 IP：/.test(runnerSrcQ) &&
    /下次执行时间：/.test(runnerSrcQ) &&
    /MS积分任务-区域拦截/.test(runnerSrcQ),
  "拦截静默无声 → 用户只看到「今天没跑」，不知道是代理出口问题"
);
checkTrue(
  "拦截分支接上推送（env.ok 为假时调用）",
  /if \(!env\.ok\) \{[\s\S]{0,500}?await pushRegionBlocked\(ctx, env\)/.test(runnerSrcQ)
);
checkTrue(
  "拦截原因透传 env.reason（带判定来源），不再写死文案",
  /result\.reason = env\.reason \|\| "IP 非中国大陆，任务已停止"/.test(runnerSrcQ)
);
// —— 拦截推送版式（2026-10-03 用户指定）——
//   ⚠️ 检测到…   /   当前 IP：x    🔴 geo   /   下次执行时间：MM-DD HH:mm
// 三条硬要求：首行 ⚠️；IP 与归属地之间是红点 + 4 空格（不套括号）；归属地在红点后
checkTrue(
  "拦截推送首行带 ⚠️ 警示符",
  /`⚠️ \$\{env\.reason \|\|/.test(runnerSrcQ),
  "首行没有 ⚠️ —— 中止类通知要一眼看出事态"
);
checkTrue(
  "拦截推送：IP 后为红点 emoji + 4 空格 + 归属地，且不再套全角括号",
  /当前 IP：\$\{ip\}    �?[^\s]*? \$\{geo\}/.test(runnerSrcQ) ||
    /当前 IP：\$\{ip\}\s{4}🔴 \$\{geo\}/.test(runnerSrcQ),
  "IP 行版式不符（要求：IP + 4 空格 + 🔴 + 归属地，去掉「（）」）"
);
checkTrue(
  "拦截推送不再用全角括号包归属地（用户要求删除前后括号）",
  !/当前 IP：\$\{ip\}（\$\{geo\}）/.test(runnerSrcQ),
  "仍是「当前 IP：x（geo）」旧版式"
);
// 用户名行补运行环境（PC / Docker）
checkTrue(
  "推送用户名行带运行环境标识 (PC)/(Docker)",
  /function runtimeTag\(\)/.test(notifySrcQ) &&
    /process\.versions && process\.versions\.electron/.test(notifySrcQ) &&
    /v\$\{ver\}\(\$\{runtimeTag\(\)\}\)/.test(notifySrcQ),
  "notify.js 未加运行环境标识 → 多端推送分不清来自哪一端"
);
checkTrue(
  "notify 导出 runtimeTag（验收脚本复用，避免判定逻辑两处漂移）",
  /module\.exports = \{[\s\S]*?runtimeTag/.test(notifySrcQ)
);
checkTrue(
  "推送失败只 warn，绝不反过来影响拦截本身",
  /区域拦截推送失败/.test(runnerSrcQ) && /logger\.warn\(`区域拦截推送失败/.test(runnerSrcQ)
);

// —— 每天开始时间（startTime）——
check("config.schedule 默认 startTime 09:00", cfgDefaults.schedule.startTime, "09:00");
check("global-config.schedule 默认 startTime 09:00", globalDefaults.schedule.startTime, "09:00");
checkTrue("渲染层 mock 同步 startTime", /startTime: "09:00"/.test(mockSrc));
checkTrue("类型定义 schedule 含 startTime", /startTime: string;/.test(typesSrcQ));
check("老配置缺 startTime → 回落 09:00", runnerModule.normalizeSchedule({}).startTime, "09:00");
check("非法 startTime → 回落 09:00", runnerModule.normalizeSchedule({ startTime: "99:99" }).startTime, "09:00");
const atQ = (hh, mm) => {
  const d = new Date();
  d.setHours(hh, mm, 0, 0);
  return d;
};
gCtx.config.set({ schedule: { enable: true, mode: "interval", startTime: "09:00", intervalMinutes: 60 } });
check("每天开始时间之前不启动（08:30 < 09:00）", guardRunner.shouldRunNow(gCtx, atQ(8, 30)).run, false);
check("到达每天开始时间后可以启动（09:30 ≥ 09:00）", guardRunner.shouldRunNow(gCtx, atQ(9, 30)).run, true);
const qNext = guardRunner.nextRunTime(gCtx, atQ(6, 0));
checkTrue(
  "下次运行时间不早于每天开始时间（06:00 问 → 09:00）",
  !!qNext && qNext.getHours() === 9 && qNext.getMinutes() === 0,
  qNext ? String(qNext) : "null"
);
checkTrue("设置页有「每天开始时间」输入", /每天开始时间/.test(formSrcQ) && /patchSchedule\(\{ startTime: v \}\)/.test(formSrcQ));

// —— 超额执行（allowExceed）——
check("allowExceed：设定 10 / 剩余 3 → 保留设定值不截断", tlQ.resolveTaskCount({ base: 10, total: 3, random: false, allowExceed: true }).count, 10);
check("未开启：设定 10 / 剩余 3 → 截断到剩余量", tlQ.resolveTaskCount({ base: 10, total: 3, random: false }).count, 3);
check("没有可执行任务时始终为 0（超额也不凭空造任务）", tlQ.resolveTaskCount({ base: 10, total: 0, allowExceed: true }).count, 0);
checkTrue(
  "阅读与活动任务把 allowExceed 透传给 resolveTaskCount",
  (tasksSource.match(/allowExceed: ctx\.force \? false : limits\.allowExceed/g) || []).length >= 2,
  "只在配置里加字段、任务侧没透传 → 开关形同虚设"
);
checkTrue("设置页有「允许自定义数量超过剩余任务数」开关", /允许自定义数量超过剩余任务数/.test(formSrcQ) && /limits: \{ allowExceed: v \}/.test(formSrcQ));
checkTrue("类型定义 limits 含 allowExceed 注释说明", /allowExceed: boolean;/.test(typesSrcQ));

/* ============ P. 版本库完整性：「本地有、仓库没有」的隐雷 ============ */
console.log("\n【P】版本库完整性（本地有、仓库没有）");
//
// 背景：两次真实事故，都是「本地打包全绿、clone 之后必炸」：
//   1) build/license.txt 被 /build/*.txt 忽略 → 从未入库，但 package.json 的
//      nsis.license 指向它 → 别人 clone 后打出来的安装器不弹协议页；
//   2) 参考js脚本/ 被 .gitignore 排除，却仍留在 build.files → 第三方作者的脚本
//      跟着安装包分发（版权风险）。
// 共同点：electron-builder / CI 都只按**文件系统**收集，看不见 git，
// 所以「本机存在」骗得过打包，骗不过一次干净 clone。
// 因此这里把「被引用」与「已入库」直接对撞，让这类隐雷在本地就变红。
const gitRun = (args) => {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch (e) {
    return null; // 读不到 git 索引时下面两条必须失败，绝不能静默放行
  }
};
const gitTracked = gitRun(["ls-files"]);
const gitLoose = gitRun(["ls-files", "--others", "--exclude-standard"]);
const trackedSet = new Set(gitTracked || []);
checkTrue(
  "自检可读到 git 索引（读不到即判失败：否则下面两条守卫形同虚设）",
  gitTracked !== null && gitLoose !== null,
  "git ls-files 执行失败（非 git 工作区？）"
);
checkTrue(
  "工作区没有未纳入版本库的游离文件（本地有、仓库没有 → clone 后必缺）",
  gitLoose !== null && gitLoose.length === 0,
  `游离文件 ${(gitLoose || []).length} 个：${(gitLoose || []).slice(0, 8).join(" | ")}`
);

// —— 收集「被引用」的仓库相对路径 ——
const refList = [];
const addRef = (rel, origin) => {
  if (!rel) return;
  const p = String(rel).replace(/\\/g, "/").replace(/^\.\//, "");
  // 绝对路径与含通配的条目留给别的守卫（如 build.files 白名单），这里只管「确定的单个文件」
  if (!p || p.startsWith("/") || /[*?[\]]/.test(p)) return;
  refList.push({ p, origin });
};
const bcfg = pkgRaw.build || {};
addRef(pkgRaw.main, "package.json#main");
addRef(bcfg.beforePack, "package.json#build.beforePack");
addRef(bcfg.afterPack, "package.json#build.afterPack");
for (const f of bcfg.files || []) addRef(f, "package.json#build.files");
for (const e of bcfg.extraResources || []) addRef(e && e.from, "package.json#build.extraResources");
addRef(bcfg.win && bcfg.win.icon, "package.json#build.win.icon");
if (bcfg.nsis) {
  // nsis.license 相对 buildResources（build/）解析；图标/脚本是仓库相对路径
  if (bcfg.nsis.license) addRef(`build/${bcfg.nsis.license}`, "package.json#build.nsis.license");
  addRef(bcfg.nsis.include, "package.json#build.nsis.include");
  addRef(bcfg.nsis.installerIcon, "package.json#build.nsis.installerIcon");
  addRef(bcfg.nsis.uninstallerIcon, "package.json#build.nsis.uninstallerIcon");
  addRef(bcfg.nsis.installerHeaderIcon, "package.json#build.nsis.installerHeaderIcon");
}
// Dockerfile：COPY 的第一组参数（跳过 --from 跨阶段拷贝与绝对路径）
const dockerFileRef = path.join(ROOT, "docker", "Dockerfile");
if (fs.existsSync(dockerFileRef)) {
  for (const line of fs.readFileSync(dockerFileRef, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*COPY\s+(?!-?-?-?from)(.+?)\s+(\S+)\s*$/);
    if (!m) continue;
    for (const tok of m[1].trim().split(/\s+/)) addRef(tok, "docker/Dockerfile#COPY");
  }
}
// CI：工作流里直接 node 执行的本地脚本
const wfDirRef = path.join(ROOT, ".github", "workflows");
if (fs.existsSync(wfDirRef)) {
  for (const wf of fs.readdirSync(wfDirRef).filter((f) => /\.ya?ml$/.test(f))) {
    const wfSrc = fs.readFileSync(path.join(wfDirRef, wf), "utf8");
    for (const m of wfSrc.matchAll(/(?:node\s+)?(scripts\/[A-Za-z0-9_./-]+\.js)/g)) {
      addRef(m[1], `.github/workflows/${wf}`);
    }
  }
}
// 主进程源码：require 的相对文件（构建产物目录跳过，它们本就不需要入库）
const walkJsRef = (dir, out = []) => {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkJsRef(abs, out);
    else if (e.name.endsWith(".js")) out.push(abs);
  }
  return out;
};
const srcDirRef = path.join(ROOT, "src");
if (fs.existsSync(srcDirRef)) {
  for (const abs of walkJsRef(srcDirRef)) {
    const jsSrc = fs.readFileSync(abs, "utf8");
    for (const m of jsSrc.matchAll(/require\((['"])(\.\.?\/[^'"]+)\1\)/g)) {
      const base = path.resolve(path.dirname(abs), m[2]);
      for (const cand of [base, `${base}.js`, `${base}.json`, path.join(base, "index.js")]) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
          addRef(path.relative(ROOT, cand), `require@${path.relative(ROOT, abs)}`);
          break;
        }
      }
    }
  }
}
const refsNotInGit = gitTracked === null ? [] : refList.filter((r) => {
  if (trackedSet.has(r.p)) return false;
  // 目录型引用（如 Dockerfile 的 `COPY src/ ./src/`）：目录下只要有任一文件入库即算通过
  const absRef = path.join(ROOT, r.p);
  if (fs.existsSync(absRef) && fs.statSync(absRef).isDirectory()) {
    const prefix = `${r.p.replace(/\/+$/, "")}/`;
    return !gitTracked.some((f) => f.startsWith(prefix));
  }
  return true;
});
checkTrue(
  "被引用的文件全部已入库（打包 / CI / require 引用的文件不许只活在本地）",
  refsNotInGit.length === 0,
  refsNotInGit.slice(0, 8).map((r) => `${r.p} ← ${r.origin}`).join(" | ")
);
checkTrue(
  "引用清单非空（断言非空转：至少覆盖 main / 打包资源 / EULA / 源码依赖）",
  refList.length >= 8,
  `只收集到 ${refList.length} 条引用，扫描逻辑可能失效`
);

// 同一类隐雷的另一种形态：**本地垃圾被通配符扫进安装包**。
// 0.13.15 实测：本地打包出 105MB，而干净 clone 的 CI 只出 82.9MB —— 差的 23MB 全是
// electron-builder 按文件系统收集进来的本地产物：`src/web/dist/**`（只给 Docker 服务端
// 用的 SPA 目录，桌面端根本不读）与 `gui-react/*.png`（30+ 张本地验证截图，
// .gitignore 里排除了但 electron-builder 不看 gitignore）。
// 这些文件被 .gitignore 排除 → 别人 clone 后打不出同样的包；截图还可能是未公开的界面稿。
const filesQ = bcfg.files || [];
checkTrue(
  "打包白名单排除 src/web/dist（只给 Docker 服务端用，桌面端不读）",
  filesQ.includes("!src/web/dist/**"),
  JSON.stringify(filesQ)
);
checkTrue(
  "打包白名单排除 gui-react 下的验证截图，只放行 icon.png",
  filesQ.includes("!gui-react/*.png") && filesQ.includes("gui-react/icon.png"),
  JSON.stringify(filesQ)
);
checkTrue(
  "排除项顺序正确（先含后排除，icon.png 在排除之后再单独放行）",
  filesQ.indexOf("!gui-react/*.png") > filesQ.indexOf("gui-react/**/*") &&
    filesQ.indexOf("gui-react/icon.png") > filesQ.indexOf("!gui-react/*.png"),
  "electron-builder 的 files 按顺序生效，顺序错了排除不生效"
);

/* ============ 【R】0.14.0 新功能 ==============================
 * 内核升级 150 / 后台 staging / 闲时 commit / 任务停止立即生效 /
 * Bing 登录自动点 + 引导提示 / 自适应 4~16 线程 / 检查更新双 V 修复
 * ============================================================ */
console.log("\n【R】0.14.0 新功能（内核升级 + 后台 staging + 停止立即生效 + Bing 引导）");

// 内核版本：2026-10-05 从 adryfish/fingerprint-chromium 150 换成 xiaozhou26/Chromix 154。
// 守卫改成「断言具体版本」而不是「断言等于某个可变量」——升级时故意让它变红，
// 逼着同步 Dockerfile / THIRD_PARTY_NOTICES / UI 文案（这四处漂移会 404 或误导用户）。
// 2026-10-06 起是两个内核并存（用户要求保留 fp150 备用，等上游修 bug 后开放自选）。
const fpSrcR = fpbSrc; // 同一份源码，前面 2426 行已读
checkTrue(
  "默认内核为 Chromix 154.0.8037.57（2026-10-05 从 fp-chromium 150 换，理由见 fingerprint-browser.js 注释）",
  /version:\s*"154\.0\.8037\.57"/.test(fpSrcR) &&
    /repo:\s*"xiaozhou26\/Chromix"/.test(fpSrcR) &&
    /const DEFAULT_ENGINE = "chromix"/.test(fpSrcR),
  fpSrcR.match(/chromix:\s*\{[\s\S]{0,400}?version:\s*"([^"]+)"/)?.[1] || "(未匹配)"
);
checkTrue(
  "备用内核 fp150 的版本与 repo 未被改动（用户要求：保留旧的，等上游修 bug）",
  /version:\s*"150\.0\.7871\.186"/.test(fpSrcR) &&
    /repo:\s*"adryfish\/fingerprint-chromium"/.test(fpSrcR),
  fpSrcR.match(/fp150:\s*\{[\s\S]{0,400}?version:\s*"([^"]+)"/)?.[1] || "(未匹配)"
);

// 自适应并发 4..16
checkTrue(
  "并发下载自适应 4..16 线程（MIN/MAX 常量在档）",
  /MIN_PARALLEL_CONNECTIONS\s*=\s*4/.test(fpSrcR) &&
    /MAX_PARALLEL_CONNECTIONS\s*=\s*16/.test(fpSrcR) &&
    /function\s+pickConnections\s*\(/.test(fpSrcR),
  "pickConnections 缺失或 MIN/MAX 偏移"
);

// staging 暂存 + 闲时 commit
checkTrue(
  "存在 stagingDir / installStaged / commitStagedInstall / fpContextActive / notifyFpContext 导出",
  /function\s+stagingDir\s*\(/.test(fpSrcR) &&
    /async\s+function\s+installStaged\s*\(/.test(fpSrcR) &&
    /function\s+commitStagedInstall\s*\(/.test(fpSrcR) &&
    /function\s+fpContextActive\s*\(/.test(fpSrcR) &&
    /function\s+notifyFpContext\s*\(/.test(fpSrcR),
  "staging/commit/fpContext 任一缺失"
);
checkTrue(
  "module.exports 含 stagingDir / installStaged / commitStagedInstall / fpContextActive / notifyFpContext",
  /module\.exports\s*=\s*\{[\s\S]*?stagingDir[\s\S]*?installStaged[\s\S]*?commitStagedInstall[\s\S]*?fpContextActive[\s\S]*?notifyFpContext[\s\S]*?\};/.test(fpSrcR),
  "新导出至少缺一个（render / 主进程靠这几个 import）"
);
checkTrue(
  "staging 不与 installDir 混用：installStaged 写 stagingDir，install() 写 installDir",
  /async\s+function\s+install\s*\(/.test(fpSrcR) &&
    /async\s+function\s+installStaged\s*\(/.test(fpSrcR) &&
    /const\s+dir\s*=\s*stagingDir\(\)/.test(fpSrcR),
  "installStaged 必须显式写到 stagingDir() 而不是 installDir()"
);
checkTrue(
  "commitStagedInstall 全部条件：staged===pinned / fpContextActive===0 / isIdle!==false",
  // 多内核后 pinned 来自 currentPinned()（当前引擎的钉死版本），不再直接读常量
  /staged\s*!==\s*currentPinned\(\)/.test(fpSrcR) &&
    /fpContextActive\(\)\s*>\s*0/.test(fpSrcR) &&
    /o\.isIdle\s*===\s*false/.test(fpSrcR),
  "commit 缺任一守门"
);

// 主进程后台编排
const mainSrcR = fs.readFileSync(path.join(ROOT, "src", "electron-main.js"), "utf8");
checkTrue(
  "主进程有 fingerprintStagedController + maybeStartBackgroundFingerprint + tryCommitFingerprintStaged + ensureFingerprintCommitTimer",
  /fingerprintStagedController\s*=\s*null/.test(mainSrcR) &&
    /function\s+maybeStartBackgroundFingerprint\s*\(/.test(mainSrcR) &&
    /function\s+tryCommitFingerprintStaged\s*\(/.test(mainSrcR) &&
    /function\s+ensureFingerprintCommitTimer\s*\(/.test(mainSrcR),
  "主进程编排入口至少缺一个"
);
checkTrue(
  "pushFingerprintStatus 把任一 fp 下载控制器都计入 downloading（不丢后台下载态）",
  /downloading:\s*!!\s*\(\s*fingerprintInstallController\s*\|\|\s*fingerprintStagedController\s*\)/.test(mainSrcR),
  "downloading 标志只看了 fingerprintInstallController（漏 staged）"
);
checkTrue(
  "maybeStartBackgroundFingerprint 在 pushFingerprintStatus 路径上周期性重评估",
  /pushFingerprintStatus[\s\S]{0,1200}maybeStartBackgroundFingerprint\(\)/.test(mainSrcR),
  "push 后没调 maybeStartBackgroundFingerprint（永远不会触发升级）"
);

// browser.js 上下文计数 + page-guide
const brSrcR = fs.readFileSync(path.join(ROOT, "src", "browser.js"), "utf8");
checkTrue(
  "browser.js openContext 调用 fpBrowser.notifyFpContext(+1)，closeContext 调用 -1",
  /notifyFpContext\(\s*\+1\s*\)/.test(brSrcR) &&
    /notifyFpContext\(\s*-1\s*\)/.test(brSrcR),
  "fp 上下文计数未生效"
);
checkTrue(
  "browser.js openContext 用 context.on('page') 装 page-guide（拟真模式也能用）",
  /context\.on\(\s*['"]page['"]/.test(brSrcR) &&
    /pageGuide\.attachPageGuide\s*\(/.test(brSrcR),
  "page-guide 漏装（拟真模式页面无引导提示）"
);
checkTrue(
  "page-guide 模块存在并导出 attachPageGuide / TERMS_KEYWORDS",
  fs.existsSync(path.join(ROOT, "src", "page-guide.js")) &&
    /module\.exports[\s\S]*?attachPageGuide[\s\S]*?TERMS_KEYWORDS/.test(fs.readFileSync(path.join(ROOT, "src", "page-guide.js"), "utf8")),
  "src/page-guide.js 缺失或 export 不全"
);

// Bing 登录自动点
const pgSrcR = fs.readFileSync(path.join(ROOT, "src", "page-guide.js"), "utf8");
checkTrue(
  "Bing 登录入口自动点（#id_l + 几个兜底选择器）",
  /tryClickBingLogin/.test(pgSrcR) &&
    /#id_l/.test(pgSrcR) &&
    /a\[aria-label\*?=['"]登录['"]\]?/.test(pgSrcR),
  "Bing 登录入口选择器缺失"
);
checkTrue(
  "「微软更新条款」类页面命中关键词 + 切换引导文案",
  /TERMS_KEYWORDS/.test(pgSrcR) &&
    /更新条款|更新服务协议|更新隐私政策/.test(pgSrcR) &&
    /请按微软要求点下方「下一步」按钮继续|请按微软要求点下方/.test(pgSrcR),
  "条款更新页引导逻辑缺失"
);
checkTrue(
  "page-guide 提示元素 z-index=2147483647（置顶）+ 右下角（不挡用户操作）",
  /z-index:\s*2147483647/.test(pgSrcR) &&
    /right:\s*24px/.test(pgSrcR) &&
    /bottom:\s*24px/.test(pgSrcR),
  "提示元素位置 / 层级不合格"
);

// 任务停止立即生效
checkTrue(
  "src/cancel.js 提供 throwIfAborted（poll 循环用它判断中止）",
  /function\s+throwIfAborted\s*\(/.test(fs.readFileSync(path.join(ROOT, "src", "cancel.js"), "utf8")),
  "cancel.throwIfAborted 缺失"
);
// runner.js 延时日志必须含 scheduledAt/startedAt
const runSrcR = fs.readFileSync(path.join(ROOT, "src", "runner.js"), "utf8");
checkTrue(
  "runner.js 启动延时日志包含「计划 / 实际开始 / 延时时长」",
  /命中随机启动延迟/.test(runSrcR) &&
    /scheduledAt/.test(runSrcR) &&
    /实际开始执行/.test(runSrcR),
  "延时日志缺字段（用户无法核对实际开始时间）"
);
// 关键的等待超时（page.waitForTimeout）应被 cancel.sleep 替换
checkTrue(
  "browser.js syncCookies / ensureBingLoginByClick / loginInteractive 中 page.waitForTimeout 已替换为 cancel.sleep",
  // 仅断言剩下的 waitForTimeout 都是 user 主动点「取消」之类的不可中断等待
  (brSrcR.match(/page\.waitForTimeout\(/g) || []).length <= 1,
  `剩余 ${(brSrcR.match(/page\.waitForTimeout\(/g) || []).length} 处 page.waitForTimeout 不可中断`
);

// GitHub 连通判定：fast-hosts.js 头注释必须区分"看就阻断" vs "Watt Toolkit 本地代理"
const fhSrcR = fs.readFileSync(path.join(ROOT, "src", "fast-hosts.js"), "utf8");
checkTrue(
  "fast-hosts.js 头注释明确指出 127.0.0.1 可能是 Watt Toolkit 等本地代理",
  /127\.0\.0\.1/.test(fhSrcR) && /Watt Toolkit|本地代理|代理客户端/.test(fhSrcR) && /不能假设|不能作为判据|不要/.test(fhSrcR),
  "fast-hosts.js 头注释没改正（用户反馈的关键误解）"
);
checkTrue(
  "下载链路：wantPinned 退化为只看 IP_DIRECT（不再因 auto 链到 direct 就接管）",
  /const\s+wantPinned\s*=\s*mirror\s*===\s*IP_DIRECT/.test(fpSrcR),
  "wantPinned 仍带 auto 直连兜底分支（违反用户修正）"
);

// 自适应 4~16 线程：downloadParallel 必须用 pickConnections
checkTrue(
  "downloadParallel 用 pickConnections(total) 取并发数（不再写死 16）",
  /async\s+function\s+downloadParallel[\s\S]*?pickConnections\(total\)/.test(fpSrcR),
  "downloadParallel 仍写死并发数"
);

// 应用更新 VV 修复
const updSrcR = fs.readFileSync(path.join(ROOT, "src", "app-update.js"), "utf8");
checkTrue(
  "app-update.js checkAppUpdate 剥掉 tag_name 前导 v（修双 V）",
  /tag_name[\s\S]{0,200}\.replace\(\s*\/\^v\/i/.test(updSrcR) ||
    /tag_name[\s\S]{0,200}\.replace\(\s*\/\^v\//.test(updSrcR),
  "latestVersion 仍带前导 v（UI 会拼出双 V）"
);

// 渲染层 UI 不准硬拼 v 前缀（防止上游漏剥 v 时再次出现「VV0.13.X」双 V bug）
const updDlgSrcR = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "components", "UpdateDialog.tsx"), "utf8");
const sidebarSrcR = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "components", "Sidebar.tsx"), "utf8");
const mockSrcR = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "api", "mock.ts"), "utf8");
const rVerSrcR = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "version.ts"), "utf8");
// 「>v${...}」形态：HTML 元素内容起始 + v 模板。SVG path data 里的 "V" 大写且独立，
// 这里用「小写 v + ${...}」的组合精确锁定，禁止这种拼接出现在 .tsx。
const vPrefixTpl = /<span[^>]*>\s*v\s*\$\{[^}]+\}|>\s*v\s*\$\{\s*(DISPLAY_VERSION|info|updateInfo)/;
const oldSideTitle = /v\$\{updateInfo\.latestVersion\}/;
const oldSideBtn = />\s*v\{DISPLAY_VERSION\}/;
const oldUpdHero = />\s*v\{info\.currentVersion[^}]*\}|>\s*v\{info\.latestVersion\}/;
const oldUpdChecking = />\s*v\{DISPLAY_VERSION\}/;
checkTrue(
  "UpdateDialog.tsx 不再硬拼 v 前缀（currentVersion / latestVersion 自带展示）",
  !oldUpdHero.test(updDlgSrcR) && !oldUpdChecking.test(updDlgSrcR) && !vPrefixTpl.test(updDlgSrcR),
  "UpdateDialog.tsx 里发现 >v${...} 形态拼接 → 一旦 app-update.js 漏剥前导 v，会拼出双 V"
);
checkTrue(
  "Sidebar.tsx 不再硬拼 v 前缀（DISPLAY_VERSION / latestVersion 自带展示）",
  !oldSideBtn.test(sidebarSrcR) && !oldSideTitle.test(sidebarSrcR) && !vPrefixTpl.test(sidebarSrcR),
  "Sidebar.tsx 里发现 >v${...} 形态拼接 → 会拼出双 V（用户 2026-10-03 反馈）"
);

// mock.ts currentVersion 必须走 DISPLAY_VERSION，不准另起炉灶
checkTrue(
  "mock.ts currentVersion 从 DISPLAY_VERSION 取（与 package.json 单源，避免侧边栏与检查更新对不齐）",
  /currentVersion:\s*DISPLAY_VERSION/.test(mockSrcR),
  "mock.ts currentVersion 仍写死字符串 → 与 Sidebar 左下角的 DISPLAY_VERSION 对不齐"
);
checkTrue(
  "mock.ts latestVersion 不带前导 v（修双 V 的辅助：连 mock 也不准写）",
  !/latestVersion:\s*["']v\d/.test(mockSrcR),
  "mock.ts latestVersion 带前导 v"
);

// version.ts APP_VERSION 必须不带 v 前缀（DISPLAY_VERSION 自带展示）
checkTrue(
  "version.ts APP_VERSION / DISPLAY_VERSION 不带 v 前缀",
  /APP_VERSION\s*=\s*"\d/.test(rVerSrcR) &&
    /DISPLAY_VERSION\s*=/.test(rVerSrcR) &&
    !/DISPLAY_VERSION\s*=\s*`v\$\{/.test(rVerSrcR),
  "version.ts APP_VERSION 或 DISPLAY_VERSION 带 v 前缀"
);

// 设置文案
const fpPanelR = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "components", "FingerprintBrowserPanel.tsx"), "utf8");
checkTrue(
  "「启用环境拟真浏览器」文案跟随所选内核（多内核后不能写死单一上游名）",
  // 2026-10-06：文案改成按 currentEngineKey 动态取 repo，写死会让切到 fp150 后
  // 标签仍显示 Chromix（用户看到「已切到 150」但界面写着 Chromix，且 About 链接也错）
  /currentEngineKey === "fp150" \? "adryfish\/fingerprint-chromium" : "xiaozhou26\/Chromix"/.test(
    fpPanelR
  ) && /label=\{`启用环境拟真浏览器/.test(fpPanelR),
  "写死单一上游名 → 切换内核后界面文案仍是另一个内核的名字"
);
checkTrue(
  "设置页有内核选择卡片组，且不可用内核是 disabled 而不是隐藏",
  // 0.14.7 从下拉改成卡片组（role=radio）：下拉混在「拟真种子 / CPU 核数 /
  // 操作系统 / 镜像源」里看不出来「这是切内核」，用户反馈找不到切换。
  // 语义不变：两个内核都要列出来，不可用的**灰显 + disabled**，不是隐藏。
  /role="radiogroup"[\s\S]{0,80}aria-label="环境拟真内核选择"/.test(fpPanelR) &&
    /disabled=\{blocked\}/.test(fpPanelR) &&
    /const blocked = !e\.available/.test(fpPanelR) &&
    /theme-card fp-engine-card/.test(fpPanelR),
  "隐藏不可用内核 → 用户以为没这个内核，看不到「修好就能用」；不 disabled → 用户能选中会崩的"
);
checkTrue(
  "不可用内核的原因由主进程原样下发并展示（前端不自己编措辞）",
  /unavailableReason/.test(fpPanelR) && /unavailableReason:/.test(fpbSrc),
  "前端自己写原因 → 与实测结论漂移，用户被误导"
);
checkTrue(
  "主进程下发内核清单（engines），UI 有回落（接口异常时不能让下拉空掉）",
  /engines: engineCatalog\(\)/.test(fpbSrc) &&
    /st\?\.engines && st\.engines\.length/.test(fpPanelR),
  "没下发 → 设置页无法选择；没回落 → 下拉空掉，用户以为功能坏了且回不到默认内核"
);
// 上游换 Chromix 时最容易漏的一类：flag 命名整套变了（--timezone → --fingerprint-timezone、
// --accept-lang/--lang → --fingerprint-locale）。少改一个 → 参数被静默忽略
// （Chromix 不认旧名字，不会报错，只是没生效 → 时区/语言露馅且无从察觉）。
//
// ⚠️ 必须剥注释再断言：buildArgs 的文档注释里为了说明迁移写了旧 flag 名原文，
// 直接正则匹配会命中注释而假红（同类坑今天在 wipe.js / page-guide.js 已各踩一次）。
const fpbCodeOnly = fpbSrc
  .split("\n")
  .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
  .join("\n");
checkTrue(
  "buildArgs 用 Chromix 的 flag 命名（--fingerprint-timezone / --fingerprint-locale）",
  /--fingerprint-timezone=/.test(fpbCodeOnly) &&
    /--fingerprint-locale=/.test(fpbCodeOnly) &&
    // 旧上游的三个名字必须都已消失
    !/`--timezone=/.test(fpbCodeOnly) &&
    !/--accept-lang=/.test(fpbCodeOnly) &&
    !/`--lang=/.test(fpbCodeOnly),
  "沿用旧上游 flag 名 → Chromix 静默忽略，时区/Accept-Language 露馅"
);
checkTrue(
  "release URL 拼接走 ENGINES 的 repo/tag/asset（不再硬编码 Chromix 的 v 前缀）",
  /`https:\/\/github\.com\/\$\{e\.repo\}\/releases\/download\/\$\{e\.tag\(v\)\}\/\$\{asset\}`/.test(fpbSrc) &&
    /const e = engine\(engineKey\);/.test(fpbSrc),
  "URL 拼接硬编码 → 换内核时对另一个上游直接 404（tag 格式相反，静默失败）"
);

/* ============ 0.14.4 登录链路三个 bug 的回归守卫（2026-10-04 用户日志实测暴露）============
   三个都是「代码看着对、真实操作才炸」的一类，必须钉死：
   ① 授权登录/刷新状态 两条独立入口漏 cancel.reset() → 停一次之后每次都被判「已停止」
   ② 条款页 checkLoggedIn 误判已登录 → finally 关浏览器，用户没机会点「下一步」
   ③ Bing 搜索页未登录无提示（SPA 晚渲染，domcontentloaded/load 已过） */
const mainAbortR = fs.readFileSync(path.join(ROOT, "src", "electron-main.js"), "utf8");
// 只取两个 handler 的函数体，避免误命中别处的 cancel.reset()
const loginHandlerR = (mainAbortR.match(/ipcMain\.handle\("account:login"[\s\S]*?\n  \}\);/) || [""])[0];
const syncHandlerR = (mainAbortR.match(/ipcMain\.handle\("account:sync"[\s\S]*?\n  \}\);/) || [""])[0];
checkTrue(
  "授权登录入口 account:login 入口/出口都 cancel.reset()（停一次后仍能再登录）",
  /cancel\.reset\(\)/.test(loginHandlerR) &&
    // reset 必须出现 2 次：进入前清残留 + finally 复位，否则下次一进去又被打断
    (loginHandlerR.match(/cancel\.reset\(\)/g) || []).length >= 2,
  "缺入口或出口 reset → 用户点过一次停止后，之后每次点授权登录都被秒断"
);
checkTrue(
  "刷新状态入口 account:sync 同样在进入前 cancel.reset()",
  /cancel\.reset\(\)/.test(syncHandlerR),
  "漏 reset → 用户停止后刷新状态永远报「已被手动停止」"
);
checkTrue(
  "两个入口都把 isAbort 与真实错误分开（中止不被当成登录失败/状态 error）",
  /isAbort/.test(loginHandlerR) &&
    /aborted:\s*true/.test(loginHandlerR) &&
    /isAbort/.test(syncHandlerR) &&
    /aborted:\s*true/.test(syncHandlerR),
  "中止被混进普通错误分支 → 用户看到「登录失败」而不是自己点的停止"
);
const termsFnR = (brSrcR.match(/function\s+isTermsGatePage[\s\S]*?\n\}/) || [""])[0];
checkTrue(
  "条款页未被误判为已登录：waitForRewardsSession 在 checkLoggedIn 之前先判条款页",
  // 必须断言函数体真有检测逻辑：只数调用次数的话，把函数体改成 return false 照样过（假绿踩过）
  /TERMS_KEYWORDS/.test(termsFnR) &&
    /account\\?\.live\\?\.com|login\\?\.live\\?\.com/.test(termsFnR) &&
    /return\s+[^;]*some\(/.test(termsFnR) &&
    !/return\s+false\s*;\s*\}/.test(termsFnR) &&
    // 目标页循环里必须先 isTermsGatePage → continue，且 SSO/点登录两条回退路径同样判
    (brSrcR.match(/isTermsGatePage\(/g) || []).length >= 5,
  "少一处判断/检测逻辑被掏空 → 条款页提前 return，finally 关掉浏览器，用户点不了「下一步」"
);
checkTrue(
  "条款页有额外宽限等待（超时后仍停在条款页再等 2 分钟，不直接关浏览器）",
  /仍在条款确认页，额外等待/.test(brSrcR) && /grace/.test(brSrcR),
  "无宽限 → 90 秒一到就关浏览器，用户慢一步就点不上了"
);
checkTrue(
  "Bing 未登录有明确提示态（bing-login）且优先级低于条款页",
  /probeBingLoginState/.test(pgSrcR) &&
    /GUIDE_BING_LOGIN_TITLE/.test(pgSrcR) &&
    /isBing && needBingLogin/.test(pgSrcR) &&
    // 条款判断写在 bing-login 之前
    guideTermsFirst(pgSrcR),
  "缺 Bing 登录提示或被条款页盖住 → 用户看不到该点右上角登录"
);
checkTrue(
  "Bing 是 SPA 晚渲染，page-guide 补了短周期重试（只在需要提示时跑，命中即停）",
  /setInterval\(/.test(pgSrcR) &&
    /probeRounds/.test(pgSrcR) &&
    /clearInterval\(timer\)/.test(pgSrcR),
  "只挂 domcontentloaded/load → 登录入口渲染晚于事件触发，永远探不到"
);
// ⚠️ 断言前必须先剥注释：文件里为了记录教训留了反例字符串原文，
// 直接正则会命中注释而假红（2026-10-04 同类坑踩过两次：wipe.js 的 bgPexelsKey、
// page-guide 的 !page.isClosed）。声明位置必须在所有用到它的守卫之前（TDZ）。
const pgCodeOnlyR = pgSrcR
  .split("\n")
  .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
  .join("\n");

// 页内自闭环：提示元素由页内 MutationObserver 自己更新，不新增 CDP 通道
checkTrue(
  "提示由页内 MutationObserver 自闭环更新（DOM 变化即重算，零新增 CDP 通道）",
  // 必须断言「真的会挂」：只匹配标志名的话，把条件改成 if (false) 照样过（假绿踩过）
  /if\s*\(!window\.__msraGuideObserver\)\s*\{/.test(pgCodeOnlyR) &&
    /new\s+MutationObserver\(/.test(pgCodeOnlyR) &&
    /window\.__msraGuideApply\s*=\s*applyState/.test(pgCodeOnlyR) &&
    // 观察范围必须覆盖 head（title 在 head，只观察 body 会漏掉条款页标题变化）
    /mo\.observe\(document\.documentElement/.test(pgCodeOnlyR) &&
    /characterData:\s*true/.test(pgCodeOnlyR),
  "Observer 没真挂上/观察范围不足 → SPA 晚渲染的登录入口仍然探不到"
);
checkTrue(
  "页内自闭环不会自激循环（状态未变就不改 DOM，避免改→触发→再改）",
  /data-state/.test(pgSrcR) &&
    /const prev = body\.getAttribute\("data-state"\)/.test(pgSrcR),
  "缺状态比较 → 自己插入提示元素触发 Observer，无限递归刷爆页面"
);
checkTrue(
  "页内自己能算 Bing 登录态（不依赖主进程传值，否则 Observer 触发时算不出新状态）",
  /let needBingLogin = false/.test(pgSrcR) &&
    /applyState/.test(pgSrcR),
  "页内只信主进程传值 → MutationObserver 触发时拿不到最新登录态"
);
// 这条守卫钉的是我 2026-10-04 自己写反的条件（!page.isClosed() 使轮询完全失效）。
checkTrue(
  "主进程轮询的终止条件正确（page.isClosed() 而非 !page.isClosed()）",
  /if \(page\.isClosed\(\)\) \{/.test(pgCodeOnlyR) &&
    !/!page\.isClosed\(\)/.test(pgCodeOnlyR),
  "写成 !page.isClosed() → 页面正常时每轮都 return，轮询一次都不执行"
);

// —— 导航竞态不再刷 WARN（2026-10-06 用户反馈「日志里老是报」）——
// refresh 挂 3 个高频事件 + 轮询，导航瞬间并发触发 → 旧文档的 execution context
// 已被销毁 → evaluate 必然抛「Execution context was destroyed」。这不代表故障。
checkTrue(
  "导航期 evaluate 失败被识别为竞态（不再刷 WARN 干扰真正的问题排查）",
  /function isNavigationRaceError/.test(pgSrcR) &&
    /execution context was destroyed/i.test(pgSrcR) &&
    /isNavigationRaceError\(msg\)/.test(pgSrcR),
  "不识别 → 正常导航就刷一屏 WARN，用户的注意力全被噪音占走"
);
checkTrue(
  "导航竞态日志有节流（60 秒窗口，且不永久吞掉）",
  /NAV_RACE_LOG/.test(pgSrcR) && /60_000|60000/.test(pgSrcR) && /unref/.test(pgSrcR),
  "无节流 → 一次导航风暴刷十几条；无 unref → 定时器吊住主进程不退出"
);
checkTrue(
  "真的脚本错误仍走 WARN（不能被竞态判定一起吞掉）",
  /if \(isNavigationRaceError\(msg\)\) \{[\s\S]{0,300}?\} else \{[\s\S]{0,200}?logger\.warn/.test(pgSrcR),
  "一律降级 → TypeError 之类的真错误被静默，出问题查无对症"

);

const installerSrcFp = require("fs").readFileSync(
  path.join(ROOT, "build", "installer.nsh"),
  "utf8"
);

/** terms 分支必须排在 bing-login 之前（条款点了才有 _U 票据） */
function guideTermsFirst(src) {
  const iTerms = src.indexOf('if (isTerms) {');
  const iLogin = src.indexOf("if (isBing && needBingLogin) {");
  return iTerms !== -1 && iLogin !== -1 && iTerms < iLogin;
}

// ====================== 【0.14.5】指纹内核下载并发与换源修复 ======================
checkTrue(
  "手动下载与后台下载控制器双向检查（防止后台下载时被手动触发踩踏同一目录）",
  /fingerprintInstallController \|\| fingerprintStagedController/.test(mainSrcFp) &&
    /fingerprintStagedController[\s\S]{0,80}?abort/.test(mainSrcFp),
  "任一通道漏查 → 并发下载写到同一 fp-download/ 目录，分片互删导致 ENOENT"
);
checkTrue(
  "手动下载时若正在跑账户任务则中止任务（用户要求：点下载优先）",
  /cancel\.abort\(\)/.test(mainSrcFp) &&
    /taskRunning/.test(mainSrcFp),
  "不中止任务就 install → 任务产物会被覆盖、回写失败"
);
checkTrue(
  "后台与原下载目录物理隔离（根治并发踩踏的关键）",
  /function stagedDownloadDir\(\)/.test(fpSrc) &&
    /function downloadDir\(\)/.test(fpSrc) &&
    /opts && opts\.staged \? stagedDownloadDir\(\) : downloadDir\(\)/.test(fpSrc),
  "共用 downloadDir() → 并发清场函数会删掉对方未完成的分片"
);
checkTrue(
  "换源前中止本轮所有还在跑的分片（杜绝僵尸进度）",
  /先掐掉本轮所有还在跑的分片/.test(fpSrc) &&
    /roundAc\.abort/.test(fpSrc),
  "不 abort → 旧镜像的分片还在跑，进度条交替显示像在反复下载"
);
checkTrue(
  "闲时判断只看 taskRunning（不再被登录/同步/下载拉为忙）",
  /let taskRunning = false/.test(mainSrcFp) &&
    /isIdle: !taskRunning/.test(mainSrcFp),
  "复用 running → 登录/同步期间也判为忙，内核永远切换不上"
);
checkTrue(
  "切换成功后清理 commit 定时器（不再每 30 秒无脑续命）",
  /if \(r && r\.ok\) \{[\s\S]{0,600}?clearInterval\(fingerprintCommitTimer\)/.test(mainSrcFp),
  "成功还重启定时器 → 每 30 秒刷一条「闲时切换未触发: staging 没有新版本」"
);

// ====================== 【0.14.5】软件更新：静默下载/安装/弹窗 ======================
checkTrue(
  "app-update.js 暴露 resolveUpdateDir / verifyUpdateFile / fetchReleaseNotes（IPC 链不缺）",
  /resolveUpdateDir\b/.test(appUpdateSrc) &&
    /verifyUpdateFile\b/.test(appUpdateSrc) &&
    /fetchReleaseNotes\b/.test(appUpdateSrc)
),
checkTrue(
  "更新包落盘目录解析：实测可写 → 失败则回落 userData（绝不提权）",
  /function resolveUpdateDir/.test(appUpdateSrc) &&
    /probeWritable\(dir\)/.test(appUpdateSrc) &&
    !/verb\s*runas|elevated/i.test(appUpdateSrc),
  "必须实测可写：UAC 虚拟化会让写失败看似成功、用户事后找不到文件"
);
checkTrue(
  "app:runUpdateInstaller 通道：先确认文件存在 + 提权启动 + 启动后让本体退出（NSIS 卸载前要拿到锁）",
  /app:runUpdateInstaller/.test(mainSrcFp) &&
    /fs\.existsSync\(p\)/.test(mainSrcFp) &&
    /launchInstallerElevated\(p\)/.test(mainSrcFp) &&
    /app\.quit\(\)/.test(mainSrcFp),
  "缺校验/不提权/不退 → 半截文件启动即崩；不退出就启动 → 旧 exe 占着文件；不弹 UAC → 智能应用控制拦截"
);
checkTrue(
  "app:installUpdate: 启动安装程序前先把软件退干净（让 UAC 提升后的写文件无锁）",
  /forceQuit = true/.test(mainSrcFp) &&
    /app\.quit\(\)/.test(mainSrcFp),
  "不退出就启动 → 写 Program Files 时旧 exe 的 mmap 会卡住新文件"
);
checkTrue(
  "提权启动走 Start-Process -Verb RunAs（不依赖 shell.openPath 默认动词）",
  /Start-Process[\s\S]{0,120}?-Verb\s+RunAs/.test(mainSrcFp) ||
    /powershell\.exe[\s\S]{0,200}?Verb RunAs/.test(mainSrcFp) ||
    /MSEDGEDRIVER\.exe|VERB\s*=\s*"runas"/i.test(mainSrcFp),
  "shell.openPath 提权不可靠 → Program Files 下安装会 ACCESS_DENIED"
);
checkTrue(
  "弹窗时按规则触发：静默下完 / 当天首次 / 未开启三种规则（dayBoundary 用本地日，避免 UTC 漂移）",
  /async function maybePromptUpdate/.test(mainSrcFp) &&
    /lastPromptDate/.test(mainSrcFp) &&
    /dismissedVersion/.test(mainSrcFp) &&
    /silentDownload/.test(require("fs").readFileSync(
      path.join(ROOT, "src", "global-config.js"),
      "utf8"
    )),
  "缺任一 → 用户被重复骚扰或永远收不到更新通知"
);
checkTrue(
  "NSIS 静默安装后自动拉起新版本（否则「装完自动打开」不成立）",
  /customInstall\$?\{?[\s\S]{0,200}?Silent[\s\S]{0,200}?ExecShell[\s\S]{0,200}?APP_EXECUTABLE_FILENAME/.test(installerSrcFp),
  "静默完成后不启动 → 用户点安装后还要自己找去原程序"
);

// ====================== 【0.14.5】四段配置一致（铁律：GLOBAL_DEFS / config / types / mock） ======================
const updateStrs = [
  /silentDownload:\s*false/.test(require("fs").readFileSync(path.join(ROOT, "src", "global-config.js"), "utf8")) &&
    /silentDownload:\s*false/.test(require("fs").readFileSync(path.join(ROOT, "src", "config.js"), "utf8")) &&
    /silentDownload:\s*boolean/.test(typesSrcFp) &&
    /silentDownload:\s*false/.test(require("fs").readFileSync(path.join(ROOT, "src-renderer", "src", "api", "mock.ts"), "utf8")),
];
checkTrue(
  "update 配置段四处字段一致（global-config / config / types / mock）",
  updateStrs[0],
  "任何一处少字段 → 旧配置文件加载后类型为 undefined，渲染白屏"
);
checkTrue(
  "update.readyFile / readyVersion / readyBytes / readySha256 字段在配置和类型都已定义",
  /readyFile:\s*"",?\s*\/\//.test(require("fs").readFileSync(path.join(ROOT, "src", "global-config.js"), "utf8")) &&
    /readyVersion:\s*"",/.test(require("fs").readFileSync(path.join(ROOT, "src", "config.js"), "utf8")) &&
    /readySha256\??:\s*string/.test(typesSrcFp),
  "记录缺失则点安装时无法校验完整性"
);

// ====================== 【0.14.6】retry 必须指名任务 ======================
// 用户反馈：「部分任务未完成，稍后会自动重试」但界面上看不到是哪一项没完成。
// 根因是 retry 不带 reason + 判定逻辑在两处各写一份，退化时无处可查。
const outcomeSrcFp = require("fs").readFileSync(path.join(ROOT, "src", "outcome.js"), "utf8");
const { classifyOutcome: classifyOutcomeFp } = require(path.join(ROOT, "src", "outcome.js"));

// ① 两处必须共用 outcome.js，不能各写一份 classifyOutcome（否则改一边忘另一边）
checkTrue(
  "终态判定只有一处实现（electron-main 与 app-core 均 require outcome.js）",
  /require\("\.\/outcome"\)/.test(
    require("fs").readFileSync(path.join(ROOT, "src", "electron-main.js"), "utf8")
  ) &&
    /require\("\.\/outcome"\)/.test(
      require("fs").readFileSync(path.join(ROOT, "src", "app-core.js"), "utf8")
    ) &&
    !/function classifyOutcome/.test(
      require("fs").readFileSync(path.join(ROOT, "src", "electron-main.js"), "utf8")
    ) &&
    !/function classifyOutcome/.test(
      require("fs").readFileSync(path.join(ROOT, "src", "app-core.js"), "utf8")
    ),
  "两份实现必然漂移：桌面版显示「需要注意」而 Docker 版显示正常"
);

// ② 所有 retry 返回都必须带 reason（漏一个就退化成笼统提示）
const tasksSrcRetryFp = require("fs").readFileSync(path.join(ROOT, "src", "tasks.js"), "utf8");
const retryReturnsFp = tasksSrcRetryFp.match(/return \{ status: "retry"[^}]*\}/g) || [];
checkTrue(
  "tasks.js 中每处 retry 返回都带 reason",
  retryReturnsFp.length >= 2 && retryReturnsFp.every((r) => /reason:/.test(r)),
  `有 ${retryReturnsFp.filter((r) => !/reason:/.test(r)).length} 处 retry 未带 reason → 界面无法说明缺哪一项`
);

// ③ 判定逻辑：retry 必须点名具体任务，而不是「部分任务未完成」
//    注意 reason 若与任务名重复会被去重成「阅读（进度接口获取失败）」，
//    所以不能拿完整子串去断言，分别校验任务名与原因片段即可。
const retryOutcomeFp = classifyOutcomeFp({
  result: { tasks: { sign: { status: "done" }, read: { status: "retry", reason: "阅读进度接口获取失败" } } },
});
checkTrue(
  "retry 判定会点名具体任务并带原因",
  !!retryOutcomeFp &&
    retryOutcomeFp.status === "warning" &&
    /阅读/.test(retryOutcomeFp.reason) &&
    /进度接口获取失败/.test(retryOutcomeFp.reason) &&
    !/部分任务未完成/.test(retryOutcomeFp.reason),
  "笼统文案「部分任务未完成」不告诉用户缺什么，只剩一个「需要注意」"
);

// ④ 多项 retry 要全部列出，不能只报第一项
const multiRetryFp = classifyOutcomeFp({
  result: {
    tasks: {
      read: { status: "retry", reason: "阅读进度接口获取失败" },
      search: { status: "retry", reason: "搜索进度获取失败" },
    },
  },
});
checkTrue(
  "多项 retry 全部列出而非只报第一项",
  !!multiRetryFp && /阅读/.test(multiRetryFp.reason) && /搜索/.test(multiRetryFp.reason),
  "漏报会让用户修好一项后才发现还有下一项"
);

// ⑤ retry 不得盖住 error（error 优先，红色高于橙色）
const errAndRetryFp = classifyOutcomeFp({
  result: {
    tasks: {
      read: { status: "retry", reason: "阅读进度接口获取失败" },
      promos: { status: "error", error: "交卷接口 500" },
    },
  },
});
checkTrue(
  "error 优先于 retry 判定",
  !!errAndRetryFp && errAndRetryFp.status === "error" && /交卷接口 500/.test(errAndRetryFp.reason),
  "retry 先命中会把真正的报错降级成橙色，错误被掩盖"
);

// ⑥ 前端徽标必须把 reason 显示出来，不能只挂在 title 上
const dashSrcFp = require("fs").readFileSync(
  path.join(ROOT, "src-renderer", "src", "views", "Dashboard.tsx"),
  "utf8"
);
checkTrue(
  "账号卡片徽标直接显示 reason（不再只靠 title 悬停）",
  /acc-issue-reason/.test(dashSrcFp) &&
    /global\.css|acc-issue-reason/.test(
      require("fs").readFileSync(path.join(ROOT, "src-renderer", "src", "styles", "global.css"), "utf8")
    ),
  "reason 只在 title 里 → 不悬停就看不到「哪一项没完成」"
);

// ⑦ 汇总行必须把 retry 与「未运行」区分开
const runnerSrcFp2 = require("fs").readFileSync(path.join(ROOT, "src", "runner.js"), "utf8");
checkTrue(
  "汇总行把 retry 显示为「未完成(原因)」而非「未运行」",
  /rRead\.status === "retry"/.test(runnerSrcFp2) && /rSign\.status === "retry"/.test(runnerSrcFp2),
  "写成「未运行」会让用户以为程序根本没执行，而实际是被接口挡住了"
);

// ====================== 【0.14.7】版本号单一来源（运行时真值） ======================
// 用户实测「窗口标题 v0.14.6.1、侧边栏 0.14.5」——两处版本号来源不同：
//   标题栏 ← 主进程 src/version.js 的 displayVersion()，**运行时读 package.json**
//   侧边栏 ← 渲染层 src-renderer/src/version.ts 的 DISPLAY_VERSION，
//            **vite 打包时烧进 JS 的常量**（改了不重新 build:web 就还是旧值）
// 修法：所有「当前版本是多少」的展示都走 getRuntimeVersion IPC 问主进程拿真值，
// 编译期常量只作**取不到时的回落**（预览 / mock 场景没有主进程）。
console.log("\n【0.14.7】版本号单一来源（运行时真值）");
{
  const preloadFp = require("fs").readFileSync(path.join(ROOT, "src", "electron-preload.js"), "utf8");
  const mainFp2 = require("fs").readFileSync(path.join(ROOT, "src", "electron-main.js"), "utf8");
  const webApiFp = require("fs").readFileSync(path.join(ROOT, "src", "web-api.js"), "utf8");

  // ① IPC 通道三端齐备（Electron preload / 主进程 handler / Web RPC / mock）
  checkTrue(
    "getRuntimeVersion 通道四端齐备（preload 暴露 + 主进程 handler + web-api）",
    /getRuntimeVersion:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("app:getRuntimeVersion"\)/.test(preloadFp) &&
      /ipcMain\.handle\("app:getRuntimeVersion"/.test(mainFp2) &&
      /getRuntimeVersion\(\)\s*\{/.test(webApiFp),
    "少一端 → 桌面/Web/预览三处行为不一致"
  );
  // ② 主进程 handler 必须读运行时 package.json，不能写死
  checkTrue(
    "主进程 getRuntimeVersion 返回 displayVersion()（运行时读 package.json，非写死）",
    /ipcMain\.handle\("app:getRuntimeVersion"[\s\S]{0,300}displayVersion\(\)/.test(mainFp2),
    "写死版本号 → 与窗口标题又变成两套真值"
  );
  // ③ 四个展示位都必须用 runtimeVer，不能直接渲染编译期常量
  const versionViews = [
    ["Sidebar", "src-renderer/src/components/Sidebar.tsx", "{runtimeVer}"],
    ["About", "src-renderer/src/views/About.tsx", "v{appVersion}"],
    ["UpdatePanel", "src-renderer/src/components/UpdatePanel.tsx", "<strong>{runtimeVer}</strong>"],
    ["UpdateDialog", "src-renderer/src/components/UpdateDialog.tsx", 'className="upd-checking-ver">{runtimeVer}'],
  ];
  for (const [name, rel, needle] of versionViews) {
    const src = require("fs").readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");
    checkTrue(
      `${name} 的版本号展示走运行时真值（不直接渲染编译期常量）`,
      src.includes(needle) &&
        /getRuntimeVersion\?\.\(\)/.test(src) &&
        // 渲染处的 {DISPLAY_VERSION} 必须已被 runtimeVer 取代（import 与 useState 初始值允许存在）
        !/\{DISPLAY_VERSION\}/.test(src.replace(/useState\(DISPLAY_VERSION\)/g, "")),
      `直接渲染 {DISPLAY_VERSION} → 改了版本号没重新 build:web 时与窗口标题分叉`
    );
  }
}

// ====================== 【0.14.7】UX 回归守卫 ======================
// 用户报的 4 件事（README 域名泄密+格式破损 / 弹窗不居中 / 更新侧栏缺位 /
// 智能应用控制拦截安装包）的防回潮。每条对应一个真实可观察的 bug，被
// 误删/回退时必须变红。
console.log("\n【0.14.7】用户体验回归守卫");
{
  const cssFp = require("fs").readFileSync(path.join(ROOT, "src-renderer", "src", "styles", "global.css"), "utf8");
  const sidebarFp = require("fs").readFileSync(
    path.join(ROOT, "src-renderer", "src", "components", "Sidebar.tsx"),
    "utf8"
  );
  const mainFp = require("fs").readFileSync(path.join(ROOT, "src", "electron-main.js"), "utf8");
  const readmeFp = require("fs").readFileSync(path.join(ROOT, "README.md"), "utf8");
  const fbFp = require("fs").readFileSync(path.join(ROOT, "src", "fingerprint-browser.js"), "utf8");

  // ① 弹窗居中：所有 .compat-modal 弹窗（UpdateDialog/UpdatePromptDialog/ModalBase/DisclaimerModal）
  //    走 .compat-modal 类，CSS 必须显式 position:fixed + inset:0 + margin:auto，否则 React 19 /
  //    自定义容器偶尔会把 dialog 默认的 absolute 顶掉让弹窗跑顶部。
  checkTrue(
    ".compat-modal 在 global.css 显式居中（防 React 19 容器吃掉 UA 默认 absolute）",
    /\.compat-modal\s*\{[\s\S]{0,200}position:\s*fixed/.test(cssFp) &&
      /\.compat-modal\s*\{[\s\S]{0,200}inset:\s*0/.test(cssFp) &&
      /\.compat-modal\s*\{[\s\S]{0,200}margin:\s*auto/.test(cssFp),
    "原生 <dialog> 默认 absolute 在自定义容器里偶尔失效 → 弹窗跑顶部偏左"
  );
  // ② 软件设置侧栏含「更新」分类（不再只有 4 个）
  checkTrue(
    "软件设置侧栏 SW_TABS 含「更新」分类（之前 4 个、用户找不到入口）",
    /key:\s*"update"[\s\S]{0,40}label:\s*"更新"/.test(sidebarFp),
    "软件设置里没有「更新」分类 → 用户找不到自动更新设置"
  );
  // ③ 智能应用控制拦截：app:runUpdateInstaller 必须走提权（Start-Process -Verb RunAs），
  //    不能用 shell.openPath。shell.openPath 不弹 UAC，无签名安装包被 SAC 拦。
  checkTrue(
    "app:runUpdateInstaller 走提权（launchInstallerElevated），不再用 shell.openPath",
    /ipcMain\.handle\("app:runUpdateInstaller"[\s\S]{0,800}launchInstallerElevated\(p\)/.test(mainFp) &&
      !/ipcMain\.handle\("app:runUpdateInstaller"[\s\S]{0,800}shell\.openPath\(p\)/.test(mainFp),
    "shell.openPath 不弹 UAC、无签名安装包被 Windows 智能应用控制拦截"
  );
  // ④ REQUIRED_HOSTS 是单一真源，README / fp150 unavailableReason 都引用它
  //    （不该让具体域名散落在文档各处）
  checkTrue(
    "REQUIRED_HOSTS 是项目需要访问的必要域名的单一真源",
    /const REQUIRED_HOSTS = Object\.freeze\(\[/.test(fbFp) &&
      /login\.live\.com/.test(fbFp.REQUIRED_HOSTS || "") ||
      /REQUIRED_HOSTS/.test(fbFp),
    "文档里散落具体域名 → 改域名时容易漏改；统一从 REQUIRED_HOSTS 读取"
  );
  // ⑤ README 不再出现裸写的具体域名（统一改写为「项目需要访问的必要域名」）
  checkTrue(
    "README 的「网络可达」一段不再裸写 login.live.com / rewards.bing.com（避免泄密 + 改域名漏改）",
    !/运行需网络可达\s+`?login\.live\.com`?/i.test(readmeFp) &&
      !/运行需网络可达\s+`?rewards\.bing\.com`?/i.test(readmeFp),
    "文档硬编码具体域名 = 改一处忘一处"
  );
  // ⑥ README 不可用 markup（用户截图里 `getImageData` / `readPixels` 那段反引号闭合丢了）
  //    检测：典型 bug 形态是同段内同时出现 `getImageData` / `readPixels` 这两个代码段
  //    且**用 `/` 直接相连**（而非顿号/换行/标点），这会被 markdown 引擎当斜体分割
  checkTrue(
    "README 不再出现「两个反引号代码段被 `/` 直接相连」的斜体分割陷阱",
    !/`getImageData`\s*\/\s*WebGL\s+`readPixels`/i.test(readmeFp) &&
      !/`getImageData`\s*\/\s*`/i.test(readmeFp),
    "`getImageData` / WebGL `readPixels` 这种相邻代码段被 `/` 隔开会触发斜体语法，整段渲染错乱"
  );
}

// ====================== 【0.14.7】CodeQL 安全告警修复守卫 ======================
// GitHub Code scanning 15 条告警修复后的防回潮。每条都对应一个真实攻击面，
// 被误删/回退时必须变红（反例验证见 .workbuddy/tmp/test-codeql-guards.js 的思路：
// 逐条注入旧值跑本脚本，确认对应守卫报 FAIL）。
console.log("\n【0.14.7】CodeQL 安全告警修复守卫");
{
  const guiSrc = require("fs").readFileSync(path.join(ROOT, "gui", "renderer.js"), "utf8");
  // ① 原型链污染：mergeInto 必须跳过危险键（js/prototype-pollution-utility）
  //    CodeQL 判定的是「从 patch 读值 → 往 base 写属性」这一对，光在循环里
  //    continue 不够（实测仍报 open），必须同时显式判 hasOwnProperty。
  checkTrue(
    "gui/mergeInto 阻断原型链污染（黑名单 + hasOwnProperty 双防护）",
    /FORBIDDEN_KEYS = new Set\(\["__proto__", "constructor", "prototype"\]\)/.test(guiSrc) &&
      /FORBIDDEN_KEYS\.has\(k\)/.test(guiSrc) &&
      /Object\.prototype\.hasOwnProperty\.call\(patch, k\)/.test(guiSrc),
    "mergeInto 无键名过滤 → 恶意 patch 可污染全局原型，所有对象行为被劫持"
  );
  // ② XSS：主题色进 innerHTML 模板前必须过 safeAccent 白名单（js/xss-through-dom）
  checkTrue(
    "gui 主题色经 safeAccent 白名单校验（hex 颜色格式）后才进 innerHTML",
    /function safeAccent/.test(guiSrc) && /escapeHtml\(safeAccent\(cfg\.accent\)\)/.test(guiSrc),
    "cfg.accent 来自 DOM 输入，裸拼进 value=\"...\" 可闭合属性注入脚本"
  );
  // ③ URL 判定必须用 new URL 主机名精确比对（js/incomplete-url-substring-sanitization）
  const ensureDepsSrc2 = require("fs").readFileSync(path.join(ROOT, "src", "ensure-deps.js"), "utf8");
  const exploreDailySrc2 = require("fs").readFileSync(path.join(ROOT, "scripts", "explore-daily.js"), "utf8");
  checkTrue(
    "URL 校验走主机名精确比对（cdn.npmmirror.com / rewards.bing.com）",
    /new URL\(hostValue\)/.test(ensureDepsSrc2) &&
      !/startsWith\("https:\/\/cdn\.npmmirror\.com"\)/.test(ensureDepsSrc2) &&
      /st\.host === "rewards\.bing\.com"/.test(exploreDailySrc2) &&
      !/st\.host\.includes\("rewards\.bing\.com"\)/.test(exploreDailySrc2),
    "子串/前缀判断可被 cdn.npmmirror.com.evil.com 等伪装域名绕过"
  );
  // ④ 正则拼接必须完整转义元字符（js/regex-injection / js/incomplete-sanitization）
  const bumpSrcGuard = require("fs").readFileSync(path.join(ROOT, "scripts", "bump-version.js"), "utf8");
  checkTrue(
    "版本号进正则走 escapeRegExp（完整转义，非只转义点号）",
    /function escapeRegExp/.test(bumpSrcGuard) &&
      !bumpSrcGuard.includes('replace(/\\./g') &&
      /escapeRegExp\(expected\)/.test(bumpSrcGuard) &&
      /escapeRegExp\(targetVersion\)/.test(bumpSrcGuard),
    "只转义点号 → 括号/星号等元字符仍可注入正则，导致校验被绕过或误匹配"
  );
  // ⑤ workflow 最小权限（actions/missing-workflow-permissions）
  const ciSrcGuard = require("fs").readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  checkTrue(
    "ci.yml 三个 job 都显式声明 permissions（最小权限原则）",
    (ciSrcGuard.match(/^\s{4}permissions:/gm) || []).length >= 3 &&
      !/permissions:\s*\n\s*contents:\s*write/.test(ciSrcGuard),
    "缺 permissions 声明 → job 默认拿 GITHUB_TOKEN 全量写权限"
  );
}

/* ============ 汇总 ============ */
console.log(`\n${"=".repeat(46)}`);
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
console.log("=".repeat(46));
process.exit(fail === 0 ? 0 : 1);
