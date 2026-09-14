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

/* ============ 汇总 ============ */
console.log(`\n${"=".repeat(46)}`);
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
console.log("=".repeat(46));
process.exit(fail === 0 ? 0 : 1);
