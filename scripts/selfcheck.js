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
  new RegExp(`^## ${pkgVersion.replace(/\./g, "\\.")}\\s*$`, "m").test(changelogSrc),
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
check("例①总10/设6/随机+4：会一次做完 → 取消随机，仍执行 6", lim1.count, 6);
check("例①：随机未生效", lim1.applied, false);
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

// —— 穷举：任意组合下数量恒在 [0,total]，随机生效时恒在 1..total-1 ——
let bad = 0;
let appliedCount = 0;
for (let total = 0; total <= 12; total++) {
  for (let base = 0; base <= 14; base++) {
    for (const r1 of [0, 0.1, 0.49, 0.5, 0.51, 0.99]) {
      for (const r2 of [0, 0.1, 0.49, 0.5, 0.51, 0.99]) {
        const p = resolveTaskCount({ base, total, random: true, rng: seqRng(r1, r2) });
        if (!Number.isInteger(p.count) || p.count < 0 || p.count > total) bad++;
        if (p.applied) {
          appliedCount++;
          if (p.count < 1 || p.count >= total) bad++;
        }
      }
    }
  }
}
check("穷举组合：数量恒在 [0,total]，随机生效时恒在 1..total-1", bad, 0);
checkTrue("穷举中确有随机生效的样本（断言非空转）", appliedCount > 200, `applied 样本仅 ${appliedCount} 个`);

// —— 归一化 ——
check(
  "limits 归一化：随机只认 true，篇数取整、负数回 0",
  normalizeLimits({ random: "yes", read: 6.9, promos: -3 }),
  { random: false, read: 6, promos: 0 }
);
check("limits 归一化：空值 → 全部不限制", normalizeLimits(null), { random: false, read: 0, promos: 0 });

// —— 静态守卫：任务侧接入 ——
const tasksSrc2 = fs.readFileSync(path.join(ROOT, "src", "tasks.js"), "utf8");
checkTrue("阅读任务接入单次数量限制", /resolveTaskCount\(\{ base: limits\.read/.test(tasksSrc2));
checkTrue("活动任务接入单次数量限制", /resolveTaskCount\(\{ base: limits\.promos/.test(tasksSrc2));
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
check("config.DEFAULTS 含 limits", cfgDefaults.limits, { random: false, read: 0, promos: 0 });
check("global-config 默认值同步含 limits", globalDefaults.limits, { random: false, read: 0, promos: 0 });
checkTrue("渲染层 mock 默认值同步含 limits", /limits: \{ random: false, read: 0, promos: 0 \}/.test(mockSrc));
for (const [name, d] of [["config", cfgDefaults], ["global-config", globalDefaults]]) {
  check(`${name} 随机延迟默认 开启/20/300`, [d.schedule.randomDelay, d.schedule.randomDelayMin, d.schedule.randomDelayMax], [true, 20, 300]);
}
checkTrue("渲染层 mock 随机延迟默认同步", /randomDelay: true,\s*\n\s*randomDelayMin: 20,\s*\n\s*randomDelayMax: 300,/.test(mockSrc));

// —— 静态守卫：设置页 ——
const formSrc = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "components", "SettingsForm.tsx"), "utf8");
checkTrue("设置页有阅读/网页浏览单次数量输入", /阅读文章每次篇数/.test(formSrc) && /网页浏览每次个数/.test(formSrc));
checkTrue("设置页有随机波动开关", /limits: \{ random: v \}/.test(formSrc));
checkTrue("设置页有随机延迟开关与区间", /randomDelay: v/.test(formSrc) && /randomDelayMin/.test(formSrc) && /randomDelayMax/.test(formSrc));

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
checkTrue("tasks.js 导出 taskDaily", /taskSign, taskRead, taskDaily, taskPromos/.test(tasksSource));
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
checkTrue("设置页有「定期收取积分」开关", /key: "claim", label: "定期收取积分"/.test(formSrc));
checkTrue("设置页 promos 文案改为「网页浏览」", /key: "promos", label: "网页浏览"/.test(formSrc));
checkTrue("设置页有 IP 服务下拉", /IP_PROVIDER_OPTIONS/.test(formSrc) && /IP 归属地查询服务/.test(formSrc));
checkTrue("设置页可选 ip.sb / 太平洋 / ipinfo / ip-api / Bing",
  /value: "ipsb"/.test(formSrc) && /value: "pconline"/.test(formSrc) && /value: "ipinfo"/.test(formSrc) &&
  /value: "ipapi"/.test(formSrc) && /value: "bing"/.test(formSrc));
checkTrue("类型定义含 IpProvider 联合类型", /type IpProvider = "auto" \| "ipsb" \| "pconline" \| "ipinfo" \| "ipapi" \| "bing"/.test(typesSrc));
const detailSrc = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "views", "AccountDetail.tsx"), "utf8");
checkTrue("账户详情页有条件渲染的「每日活动」卡片", /dailyEnabled/.test(detailSrc) && /label="每日活动"/.test(detailSrc));

/* ============ 汇总 ============ */
console.log(`\n${"=".repeat(46)}`);
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
console.log("=".repeat(46));
process.exit(fail === 0 ? 0 : 1);
