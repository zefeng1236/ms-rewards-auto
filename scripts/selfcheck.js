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
checkTrue("设置页有「定期收取积分」开关", /key: "claim", label: "定期收取积分"/.test(formSrc));
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
  /title: `Microsoft Rewards 自动任务 v\$\{displayVersion\(\)\}`/.test(mainSrcVer)
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
// 默认外观：深色 + 必应每日一图（安装即体验，而非跟随系统/内置壁纸）
checkTrue("默认深浅模式为 dark", appearance.DEFAULTS.mode === "dark");
checkTrue("默认背景为必应每日一图 bing", appearance.DEFAULTS.bgType === "bing");

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
checkTrue(
  "taskSearch 本轮计划次数以服务器剩余额度封顶",
  /const limit = Math\.max\(1, Math\.min\(randInt\(4, 7\), remaining\)\)/.test(tasksSrcSearch)
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
  // 注意：UA 改成条件装配后不再是 launchOpts 的字段，而是非指纹分支里的一行赋值。
  // 行首锚定仍然保留 —— 只认「单独一行干这件事」，避免注释里出现同名串导致假绿。
  "browser 启动时覆盖 headless UA（不再出现 HeadlessChrome；指纹模式下刻意不设）",
  /^\s*launchOpts\.userAgent = stealth\.STEALTH_USER_AGENT;/m.test(browserSrc) && /require\("\.\/stealth"\)/.test(browserSrc)
);
checkTrue(
  "browser 在每个页面注入 initScript（指纹模式下注入的是带 __MSR_FP 置位的版本）",
  /^\s*await context\.addInitScript\(\{ content: initSrc \}\);/m.test(browserSrc) &&
    /const initSrc = isFp \? "window\.__MSR_FP = true;\\n" \+ stealth\.STEALTH_INIT : stealth\.STEALTH_INIT;/.test(browserSrc)
);
checkTrue(
  "browser 追加 stealth 启动参数（EXTRA_ARGS 并入 args）",
  /^\s*\.\.\.stealth\.EXTRA_ARGS,/m.test(browserSrc)
);
checkTrue(
  // 指纹模式下不盖 accept-language（--accept-lang 由上游统一处理），否则两套控制打架
  "browser 补充 accept-language（EXTRA_HTTP_HEADERS；指纹模式让位）",
  /^\s*if \(!isFp\) await context\.setExtraHTTPHeaders\(stealth\.EXTRA_HTTP_HEADERS\);/m.test(browserSrc)
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

/* ============ 指纹浏览器可选链路（0.9.4.17） ============ */
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

// —— 下载链路 ——
checkTrue(
  "指纹浏览器走 gh-proxy 多节点镜像链（文档里的 6 个入口都要在），且保留直连兜底",
  ["gh-proxy.com/", "v4.gh-proxy.org/", "v6.gh-proxy.org/", "cdn.gh-proxy.org/", "axisnow.gh-proxy.org/", "gh-proxy.org/"]
    .every((n) => fpSrc.includes(`"https://${n}"`)) &&
    /MIRROR_PREFIXES\s*=\s*\[[^\]]*""\s*,?\s*\]/.test(fpSrc)
);
checkTrue(
  "版本钉死（避免上游节奏与本项目不同步）",
  /PINNED_VERSION\s*=\s*"\d+\.\d+\.\d+\.\d+"/.test(fpSrc)
);
checkTrue(
  "资产名按平台区分（Windows zip / Linux tar.xz），macOS 明确不支持",
  fpSrc.includes("_windows_x64.zip") && fpSrc.includes("_linux.tar.xz") && /return null;/.test(fpSrc)
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
  "解压走系统自带 tar（不用 JS 解压库）",
  /runCmd\("tar", \["-xf"/.test(fpSrc)
);
checkTrue(
  "Windows zip 有 PowerShell Expand-Archive 兜底",
  fpSrc.includes("Expand-Archive -LiteralPath")
);
checkTrue(
  "解压后校验目录非空（坏包不能算成功）",
  /assertExtracted\(dir/.test(fpSrc) && /解压后目录为空/.test(fpSrc)
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
  /async function downloadAsset\(version, onProgress, mirror\)/.test(fpSrc) &&
    /async function probeTotal\(rawUrl, version, mirror\)/.test(fpSrc) &&
    /probeTotal\(raw, version, mirror\)/.test(fpSrc)
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
  /mirrors: await mirrorOptionsWithLatency\(\)/.test(fpSrc) &&
    /async function mirrorLatency/.test(fpSrc) &&
    /latencyMs/.test(fpSrc)
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
    new RegExp(`["']?${fpDefaultMirror.replace(/\./g, "\\.")}["']?:`).test(
      (fpSrc.match(/const MIRROR_KEYS = \{([\s\S]*?)\n\};/) || ["", ""])[1]
    )
);
checkTrue(
  "类型定义 browser.fingerprint 含 mirror，状态类型含可选 mirrors",
  /mirror: string;/.test(typesSrcFp) && /mirrors\?:/.test(typesSrcFp)
);
checkTrue(
  "指纹浏览器面板有「下载镜像源」下拉，选项来自主进程下发的 mirrors",
  /下载镜像源/.test(panelSrcFp) && /options=\{st\?\.mirrors \|\| \[\]\}/.test(panelSrcFp)
);

// —— 向导末页：指纹浏览器下载（0.10.1）——
checkTrue(
  "向导扩为六步且末页是指纹浏览器下载页",
  /const STEPS = \[[^\]]*"指纹"/.test(wizardSource) &&
    /function PageFingerprint/.test(wizardSource) &&
    /page === 5 && <PageFingerprint/.test(wizardSource)
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
  "向导指纹页有左按钮右进度的布局样式（进度文案单行截断不挤按钮）",
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
  /onClick=\{\(\) => void onInstall\(!!st\?\.ready\)\}/.test(panelSrcFp) &&
    /重新下载/.test(panelSrcFp)
);
checkTrue(
  "反例守卫 ⑱：重新下载不得恒传 force=false（否则命中「已是最新版本」而无法修复）",
  !/onClick=\{\(\) => void onInstall\(false\)\}/.test(panelSrcFp)
);
checkTrue(
  "force 重装时清空解压目录与下载缓存（不复用可能已损坏的分片）",
  /if \(o\.force\) \{/.test(fpSrc) &&
    /fs\.rmSync\(installDir\(\), \{ recursive: true, force: true \}\)/.test(fpSrc) &&
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

// —— 侧边栏指纹状态（0.10.1）——
// 自己读一份 Sidebar 源码：下方同名变量声明在更后面，用它会踩 const 的 TDZ
const sidebarSrcFp = fs.readFileSync(
  path.join(ROOT, "src-renderer", "src", "components", "Sidebar.tsx"),
  "utf8"
);
checkTrue(
  "侧边栏显示指纹浏览器状态，下载中显示百分比 + 进度条",
  /onFingerprintStatus/.test(sidebarSrcFp) &&
    /指纹浏览器 \$\{/.test(sidebarSrcFp) &&
    /nav-install-fill/.test(sidebarSrcFp)
);
checkTrue(
  "反例守卫 ⑳：指纹进度必须按 stage 分流，不得混入 Chromium 进度",
  /if \(p\.stage === "fingerprint" \|\| p\.stage === "fingerprint\/download"\) setFpProg\(p\);/.test(
    sidebarSrcFp
  )
);
checkTrue(
  "预览端指纹进度同样带 stage=fingerprint（否则侧边栏徽章串台）",
  /emitFpProgress\(\{ stage: "fingerprint"/.test(mockSrcFp)
);

// —— CSS 结构完整性（0.10.1）——
// liquidGlassCompat.css 的首行曾是被**截断的规则残片**（`.friend-actions` 的选择器与
// 前半段声明在迁移时丢了，只剩尾部 49 字节 + 一个游离的 `}`）。这类损坏构建**照样成功**：
// esbuild 只打一条 `Unexpected ";"` 警告、把顶层那条声明整条丢掉，产物里完全看不出来。
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
  "补位层 CSS 结构合法（无顶层游离分号 / 括号配平）—— 截断的规则残片会被 esbuild 静默丢弃",
  cssStructureOk("src-renderer/src/components/liquidGlassCompat.css")
);
checkTrue("global.css 结构合法（无顶层游离分号 / 括号配平）", cssStructureOk("src-renderer/src/styles/global.css"));

// —— 种子与启动参数 ——
checkTrue(
  "指纹按账户派生种子（FNV-1a，32 位无符号）",
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
  "stealth 有 __MSR_FP 守卫，指纹模式下让出语言/插件与硬件信息",
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
// 优先级顺序是本块最容易改错的地方：把「系统兜底」挪到指纹浏览器之前，
// Docker 里指纹浏览器就永远轮不到（下载了也不用），而桌面端完全看不出来。
const rbBody = browserSrcFp.slice(browserSrcFp.indexOf("function resolveBrowserSource"));
checkTrue(
  "优先级顺序：运维强指定 > 指纹浏览器 > 系统兜底 > Playwright 自带",
  /kind: "override"/.test(browserSrcFp) &&
    /kind: "fingerprint"/.test(browserSrcFp) &&
    /kind: "chromium"/.test(browserSrcFp) &&
    rbBody.indexOf('kind: "override"') < rbBody.indexOf('kind: "fingerprint"') &&
    rbBody.indexOf('kind: "fingerprint"') < rbBody.indexOf("fallbackChromiumPath") &&
    rbBody.indexOf("fallbackChromiumPath") < rbBody.indexOf("bundledChromiumPath")
);
checkTrue(
  "指纹浏览器不可用时静默回落（不打断登录流程）",
  /已启用指纹浏览器但不可用/.test(browserSrcFp) && /本轮回落到普通 Chromium/.test(browserSrcFp)
);
checkTrue(
  "指纹模式下不覆盖 UA（否则回到 UA 与 CH 自相矛盾的死路）",
  /指纹浏览器/.test(browserSrcFp) && /launchOpts\.userAgent = stealth\.STEALTH_USER_AGENT/.test(browserSrcFp) &&
    /if \(isFp\) \{/.test(browserSrcFp)
);
checkTrue(
  "指纹模式下给 stealth 置位 __MSR_FP",
  browserSrcFp.includes('"window.__MSR_FP = true;\\n" + stealth.STEALTH_INIT')
);

// —— 配置层对齐（防白屏：两处默认值必须同字段） ——
function browserFpBlock(src) {
  const i = src.indexOf("browser: {");
  return i < 0 ? "" : src.slice(i, i + 700);
}
const cfgFpBlock = browserFpBlock(cfgSrcFp);
const gcfgFpBlock = browserFpBlock(gcfgSrcFp);
for (const [label, block] of [["config.js", cfgFpBlock], ["global-config.js", gcfgFpBlock]]) {
  checkTrue(
    `${label} 的 browser.fingerprint 五个字段齐全（enable/seed/brand/hardwareConcurrency/mirror）`,
    block.includes("fingerprint: {") &&
      /enable:/.test(block) &&
      /seed:/.test(block) &&
      /brand:/.test(block) &&
      /hardwareConcurrency:/.test(block) &&
      /mirror:/.test(block)
  );
}

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
  "软件设置页挂载指纹浏览器面板",
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
checkTrue(
  "前端类型补齐 FingerprintStatus / InstallFingerprintResult",
  /interface FingerprintStatus/.test(typesSrcFp) && /interface InstallFingerprintResult/.test(typesSrcFp)
);

/* ---------------- Docker 版接线（0.10.1 后增补） ----------------
 * 此前容器里指纹浏览器「装了也用不上」的两个原因，各锁一条守卫：
 *   ① compose 用 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 把容器 Chromium 钉死（优先级最高）
 *   ② 镜像没装 xz-utils，GNU tar 解 .tar.xz 直接 exit 127
 */
const dockerfileSrc = fs.readFileSync(path.join(ROOT, "docker", "Dockerfile"), "utf8");
const composeSrc = fs.readFileSync(path.join(ROOT, "docker", "docker-compose.yml"), "utf8");
checkTrue(
  "Dockerfile 装 xz-utils（Linux 版指纹浏览器是 .tar.xz，GNU tar 需外部 xz）",
  // 断言必须是「独立成一行的 apt 列表项」：注释里也会出现 xz-utils 三个字，
  // 用 /xz-utils/ 或 [^;]* 跨行匹配都会被注释蒙混，漏掉「从 apt 列表里删掉」这种真故障。
  /^\s*xz-utils\b/m.test(dockerfileSrc) && /xz --version/.test(dockerfileSrc)
);
checkTrue(
  "Docker 侧用 MS_REWARDS_CHROMIUM_FALLBACK 兜底，而非强指定 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
  /MS_REWARDS_CHROMIUM_FALLBACK=\/usr\/bin\/chromium/.test(dockerfileSrc) &&
    /MS_REWARDS_CHROMIUM_FALLBACK: \/usr\/bin\/chromium/.test(composeSrc) &&
    !/^\s*PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH[=:]/m.test(dockerfileSrc) &&
    !/^\s*PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH[=:]/m.test(composeSrc)
);
checkTrue(
  "Web 端 installFingerprint 把下载进度转发到 SSE（否则侧边栏徽章在 Web 版永远 0%）",
  /onProgress: \(p\) => emit\("install-progress", p\)/.test(webApiSrcFp)
);
checkTrue(
  "compose 镜像 tag 与 package.json 版本一致",
  new RegExp(`image: ms-rewards-auto:${String(pkgRaw.version).replace(/\./g, "\\.")}(\\s|$)`).test(composeSrc)
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
  "镜像装 KasmVNC（必备 deb 下载 + Xkasmvnc 可执行）",
  /Xkasmvnc/.test(dockerfileSrc) &&
    /curl -fsSL -o \/tmp\/kasmvnc\.deb/.test(dockerfileSrc) &&
    /kasmvncserver_bookworm/.test(dockerfileSrc)
);
// 老的四件套必须全删：Xvfb + x11vnc + websockify + novnc + fluxbox
// （用「键入 apt 列表」的精确匹配 —— 注释里也会提到这些词，全文匹配会假阴性）
checkTrue(
  "旧图形栈四件套已从 apt 列表清干净（xvfb / x11vnc / websockify / novnc / fluxbox）",
  !["xvfb", "x11vnc", "websockify", "novnc", "fluxbox"].some((p) =>
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
const xkasmCmd = afterMarker(novncSrc, "nohup /usr/bin/Xkasmvnc");
checkTrue(
  "KasmVNC 走明文 6080（容器里没有 CA 证书，要求 SSL 会启动失败）",
  xkasmCmd.includes("-port 6080") &&
    xkasmCmd.includes("-ssl=0") &&
    /require_ssl:\s*false/.test(kasmYamlSrc)
);
checkTrue(
  "KasmVNC 跳过交互式引导（容器里没法跑那个密码+选桌面的脚本）",
  xkasmCmd.includes("-no-bootstrap") && xkasmCmd.includes("-select-de none")
);
checkTrue(
  "KasmVNC 配置启用 GPU DRI3 加速节点（NAS 上有 /dev/dri/renderD128 即可走 VAAPI）",
  /drinode:\s*\/dev\/dri\/renderD128/.test(kasmYamlSrc) &&
    /gpu:\s*\n\s*hw3d:/.test(kasmYamlSrc)
);
checkTrue(
  "镜像预建 /tmp/.X11-unix（Xkasmvnc 以 node 身份跑时不会自建，日志会报 euid != 0）",
  /mkdir -p \/tmp\/\.X11-unix/.test(dockerfileSrc) && /chmod 1777 \/tmp\/\.X11-unix/.test(dockerfileSrc)
);
checkTrue(
  "图形栈以 node 身份拉起（root 起的 X server，Chromium attach 不了它的 SHM 段，会静默回退 TCP）",
  /gosu node \/usr\/local\/bin\/novnc-stack\.sh/.test(entrySrc) &&
    /MS_REWARDS_ENABLE_NOVNC/.test(entrySrc) &&
    /export DISPLAY=:1/.test(entrySrc) &&
    /novnc-stack\.sh/.test(dockerfileSrc) &&
    /\.kasmpasswd/.test(entrySrc)
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

/* ============ 汇总 ============ */
console.log(`\n${"=".repeat(46)}`);
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
console.log("=".repeat(46));
process.exit(fail === 0 ? 0 : 1);
