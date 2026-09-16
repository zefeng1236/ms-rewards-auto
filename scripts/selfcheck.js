/**
 * 自检脚本：密码强度 / 每日活动解析 / 领取节流
 *
 * 用法: node scripts/selfcheck.js
 * 退出码 0 = 全部通过，1 = 有失败项
 *
 * passwordStrength.ts 是 TS，这里用 esbuild 现转 CJS 后 require，
 * 避免为了跑测试引入额外测试框架。
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
let pass = 0;
let fail = 0;

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
const os = require("os");
const outFile = path.join(os.tmpdir(), "ms-rewards-pw-selfcheck.cjs");
execFileSync(process.execPath, [
  path.join(ROOT, "node_modules", "esbuild", "bin", "esbuild"),
  path.join(ROOT, "src-renderer", "src", "utils", "passwordStrength.ts"),
  "--format=cjs",
  "--platform=node",
  `--outfile=${outFile}`,
]);
const { evaluatePassword } = require(outFile);

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

fs.rmSync(outFile, { force: true });

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
const g2 = guardRunner.shouldRunNow(gCtx);
checkTrue("授权后（有 refreshToken）恢复自动调度", g2.run === true, `实际 ${JSON.stringify(g2)}`);

/* ============ 汇总 ============ */
console.log(`\n${"=".repeat(46)}`);
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
console.log("=".repeat(46));
process.exit(fail === 0 ? 0 : 1);
