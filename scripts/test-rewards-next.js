/**
 * 新版 Rewards 活动层离线回归（不联网、不登录账号、不写账号）。
 * 运行: npm run test:next
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const next = require(path.join(ROOT, "src", "rewards-next.js"));
const acts = require(path.join(ROOT, "src", "rewards-activities.js"));
const totp = require(path.join(ROOT, "src", "totp.js"));

const lines = [];
let failed = 0;
async function test(name, fn) {
  try { await fn(); lines.push(`  ✅ ${name}`); }
  catch (e) { failed++; lines.push(`  ❌ ${name} — ${String((e && e.message) || e).slice(0, 220)}`); }
}

const H = (c) => c.repeat(64);
const FIXTURE = {
  dashboard: {
    userStatus: { availablePoints: 1234, counters: {} },
    userWarnings: [],
    streakProtectionPromo: {
      offerid: "StreakProtection_A", streakProtectionStatus: "False",
      isStreakProtectionOnEligible: "True", remainingDays: "4", streakCount: "10",
    },
    punchCards: [{
      name: "PC_A",
      parentPromotion: { offerId: "PC_A", complete: false, pointProgressMax: 70 },
      childPromotions: [
        { offerId: "C1", hash: H("a"), activityType: 11, complete: false, pointProgressMax: 10, title: "普通子项", attributes: { offerid: "C1" } },
        { offerId: "C2", hash: H("b"), activityType: 11, complete: true, pointProgressMax: 10, title: "已完成", attributes: {} },
        { offerId: "C3", hash: H("c"), activityType: 11, complete: false, pointProgressMax: 0, title: "零分", attributes: {} },
        { offerId: "C4", hash: H("d"), activityType: 11, complete: false, pointProgressMax: 10, title: "兑换领取", destinationUrl: "https://rewards.bing.com/redeem/sku/x", attributes: {} },
      ],
    }],
    morePromotions: [
      { offerId: "M1", hash: H("e"), complete: false, pointProgressMax: 5, promotionType: "urlreward", activityType: 11, attributes: {} },
      { offerId: "VS1", hash: H("f"), complete: false, pointProgressMax: 10, title: "视觉搜索", promotionType: "visualsearch", activityType: 714, attributes: {} },
      { offerId: "APP1", hash: H("1"), complete: false, pointProgressMax: 3, promotionType: "dailycheckin", activityType: 11, attributes: {} },
    ],
    promotionalItems: [],
    dailySetPromotions: { "11/17/2026": [] },
  },
  profile: { attributes: { serpbotscore: "17" } },
  catalog: { availablePoints: 1234 },
};

function fakeRequest(log) {
  return async (o) => {
    log.push({ method: o.method || "GET", url: String(o.url).split("?")[0] });
    if (String(o.url).includes("/api/getuserinfo")) return { status: 200, text: JSON.stringify(FIXTURE) };
    if (String(o.url).endsWith("/earn")) return { status: 200, text: '<script src="/_next/static/chunks/app/earn/page-abc.js"></script>' };
    if (String(o.url).includes("/_next/")) {
      return { status: 200, text:
        `createServerReference)("${H("7")}",callServer,"reportActivity");` +
        `createServerReference)("${H("4")}",callServer,"reportToggleStreakProtection");` };
    }
    if (o.method === "POST") return { status: 200, text: "1:ok" };
    return { status: 404, text: "" };
  };
}

async function main() {
  console.log("\n=== 新版 Rewards 活动层 · 离线回归测试 ===");

  // ---- 解析 ----
  await test("parseDashboard 解析余额 / punchcard / 连胜保护 / 机器人评分", async () => {
    const d = next.parseDashboard(FIXTURE);
    assert.equal(d.ok, true);
    assert.equal(d.availablePoints, 1234);
    assert.equal(d.punchCards.length, 1);
    assert.equal(d.punchCards[0].children.length, 4);
    assert.equal(d.punchCards[0].children[0].hash.length, 64);
    assert.equal(d.streakProtection.on, false);
    assert.equal(d.streakProtection.eligible, true);
    assert.equal(d.streakProtection.remainingDays, 4);
    assert.equal(d.botScore, 17);
    assert.deepEqual(d.warnings, []);
  });

  await test("风控警告能被解析出来（数组里带 name）", async () => {
    const f = JSON.parse(JSON.stringify(FIXTURE));
    f.dashboard.userWarnings = [{ name: "Fraud_UserWarning_BotScore_UX" }];
    assert.deepEqual(next.parseDashboard(f).warnings, ["Fraud_UserWarning_BotScore_UX"]);
  });

  await test("normalizePromotion 补齐 activityType 默认值 11", async () => {
    const p = next.normalizePromotion({ offerId: "X", hash: "h", complete: false, attributes: { offerid: "X" } });
    assert.equal(p.activityType, 11);
    assert.equal(p.offerId, "X");
  });

  // ---- 待办判定 ----
  await test("collectPending：连胜保护未开 + 普通子项 + 更多活动 + 视觉搜索/App 任务", async () => {
    const d = next.parseDashboard(FIXTURE);
    const p = acts.collectPending(d);
    const kinds = p.map((x) => x.kind);
    assert.ok(kinds.includes("streakProtection"));
    assert.ok(kinds.includes("punchCard"));
    assert.ok(kinds.includes("visualSearch"));
    assert.ok(kinds.includes("app"));
    assert.ok(kinds.includes("promotion"));
    assert.equal(p.filter((x) => x.kind === "punchCard").length, 1, "只有 C1 该被选中");
  });

  await test("已完成 / 零分 / 兑换领取 / 无 hash 一律不进待办", async () => {
    const d = next.parseDashboard(FIXTURE);
    const ids = acts.collectPending(d).map((x) => x.offerId);
    for (const bad of ["C2", "C3", "C4"]) assert.ok(!ids.includes(bad), `${bad} 不该进待办`);
    assert.equal(acts.needsManualClaim({ destination: "https://rewards.bing.com/redeem/sku/x" }), true);
  });

  await test("连胜保护已开启 / 无资格 / 无剩余天数时不产生动作", async () => {
    const d = next.parseDashboard(FIXTURE);
    for (const patch of [
      { on: true, eligible: true, remainingDays: 4 },
      { on: false, eligible: false, remainingDays: 4 },
      { on: false, eligible: true, remainingDays: 0 },
    ]) {
      const p = acts.collectPending({ ...d, streakProtection: patch });
      assert.ok(!p.some((x) => x.kind === "streakProtection"), `不该动作: ${JSON.stringify(patch)}`);
    }
  });

  await test("上报参数严格是 [hash, activityType, {offerid,isPromotional,timezoneOffset}]", async () => {
    const args = acts.activityArgs({ hash: "hh", activityType: 714, offerId: "VS1", isPromotional: false });
    assert.equal(args.length, 3);
    assert.equal(args[0], "hh");
    assert.equal(args[1], 714);
    assert.equal(args[2].offerid, "VS1");
    assert.equal(args[2].isPromotional, "$undefined");
    assert.match(args[2].timezoneOffset, /^-?\d+$/);
  });

  await test("周 punchcard 只保留当天星期那一项（真机 11-17 暴露的未来项误判）", async () => {
    const d = next.parseDashboard({
      dashboard: {
        userStatus: { availablePoints: 1 },
        streakProtectionPromo: { streakProtectionStatus: "True" },
        punchCards: [{
          name: "WEEK", parentPromotion: { offerId: "WEEK", complete: false, pointProgressMax: 70 },
          childPromotions: ["Monday", "Tuesday", "Wednesday"].map((day) => ({
            offerId: `WW_pcchild_${day}_weekly`, hash: H(day[0]), complete: false,
            pointProgressMax: 10, title: day, attributes: {},
          })),
        }],
        morePromotions: [], promotionalItems: [], userWarnings: [],
      },
    });
    const tuesday = new Date(2026, 10, 17, 10, 0, 0).getTime(); // 2026-11-17 是周二
    const picked = acts.collectPending(d, { nowMs: tuesday });
    assert.equal(picked.length, 1);
    assert.match(picked[0].offerId, /Tuesday/);
  });

  await test("maxItems 上限生效", async () => {
    const d = next.parseDashboard(FIXTURE);
    assert.ok(acts.collectPending(d, { maxItems: 2 }).length <= 2);
  });

  // ---- Server Action ----
  await test("extractChunkPaths / extractNamedActions 能从 JS 里提取具名 action", async () => {
    const paths = next.extractChunkPaths('<script src="/_next/static/chunks/app/earn/page-abc.js"></script>');
    assert.equal(paths.length, 1);
    const a = next.extractNamedActions(`createServerReference)("${H("7")}",callServer,"reportActivity");`);
    assert.equal(a.reportActivity, H("7"));
  });

  await test("routerStateTree / questRouterStateTree 含目标段且是 URL 编码的 JSON", async () => {
    const t = decodeURIComponent(next.routerStateTree("dashboard"));
    assert.match(t, /dashboard/);
    assert.ok(Array.isArray(JSON.parse(t)));
    const q = decodeURIComponent(next.questRouterStateTree("PC_A"));
    assert.match(q, /PC_A/);
    assert.ok(Array.isArray(JSON.parse(q)));
  });

  await test("reportServerAction 默认 dryRun：绝不发 POST", async () => {
    const log = [];
    const r = await next.reportServerAction({}, { actionId: "x", args: [1], request: fakeRequest(log) });
    assert.equal(r.dryRun, true);
    assert.equal(log.length, 0);
  });

  await test("reportServerAction 真实执行带 Next-Action / Router-State-Tree 头", async () => {
    const log = [];
    const req = async (o) => { log.push(o); return { status: 200, text: "1:ok" }; };
    const r = await next.reportServerAction({}, {
      actionId: "abc", args: ["h", 11, {}], url: "https://rewards.bing.com/dashboard",
      dryRun: false, request: req,
    });
    assert.equal(r.ok, true);
    assert.equal(log[0].headers["Next-Action"], "abc");
    assert.ok(log[0].headers["Next-Router-State-Tree"]);
    assert.equal(log[0].headers["Content-Type"], "text/plain;charset=UTF-8");
    assert.equal(log[0].method, "POST");
  });

  await test("runActivities 默认只读：不下载 chunk、不发 POST", async () => {
    const log = [];
    const r = await acts.runActivities({}, { request: fakeRequest(log) });
    assert.equal(r.dryRun, true);
    assert.equal(r.pending.length > 0, true);
    assert.equal(log.filter((x) => x.method === "POST").length, 0);
    assert.equal(log.filter((x) => x.url.includes("/_next/")).length, 0);
  });

  await test("runActivities 显式执行：过安全闸门 → 只写 1 项 → 复核 dashboard", async () => {
    next.resetActionCache();
    const log = [];
    const ledgerDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "msr-next-write-"));
    try {
      const r = await acts.runActivities({}, { dryRun: false, request: fakeRequest(log), ledgerDir, gapMs: 0 });
      assert.equal(r.dryRun, false);
      assert.ok(r.executed.length > 0);
      assert.equal(r.safety.allowed, 1, "默认每轮最多写 1 项");
      assert.ok(r.safety.skipped.some((s) => /开关型/.test(s.reason)), "连胜保护 toggle 应被跳过");
      assert.equal(log.filter((x) => x.method === "POST").length, 1, "不能连发多个 POST");
      assert.ok(log.filter((x) => x.url.includes("/_next/")).length > 0);
      assert.equal(r.after.ok, true);
      // 真机 11-17：POST 200 但服务器数据没变 → 绝不能标成「已计分」
      assert.equal(r.confirmed, false, "HTTP 200 不能冒充计分");
      assert.equal(r.after.pendingRemaining, r.pending.length);
    } finally {
      fs.rmSync(ledgerDir, { recursive: true, force: true });
    }
  });

  await test("重复调用不重发 POST（写前落账 + 冷却生效）", async () => {
    next.resetActionCache();
    const log = [];
    const ledgerDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "msr-next-repeat-"));
    try {
      const opts = { dryRun: false, request: fakeRequest(log), ledgerDir, gapMs: 0 };
      const a = await acts.runActivities({}, opts);
      const b = await acts.runActivities({}, opts);
      assert.equal(a.executed.length, 1);
      assert.equal(b.executed.length, 0, "第二次应被冷却挡住");
      assert.equal(log.filter((x) => x.method === "POST").length, 1, "总共只能有 1 个 POST");
    } finally {
      fs.rmSync(ledgerDir, { recursive: true, force: true });
    }
  });

  // ---- TOTP ----
  await test("TOTP RFC 6238 标准向量（8 位 / T=59 → 94287082）", async () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890"
    assert.equal(totp.generateTotp(secret, 59000, { digits: 8 }), "94287082");
    assert.equal(totp.generateTotp(secret, 1111111109000, { digits: 8 }), "07081804");
  });

  await test("TOTP 6 位默认、去空格小写密钥、非法字符报错", async () => {
    assert.match(totp.generateTotp("gezdgnbvgy3tqojqgezdgnbvgy3tqojq", 59000), /^\d{6}$/);
    assert.equal(totp.normalizeSecret("ab cd-ef"), "ABCDEF");
    assert.throws(() => totp.base32Decode("!!!"), /非法字符/);
  });

  await test("fillTotpIfNeeded 找到 otc 输入框才填，页面无输入框时不动作", async () => {
    let filled = null;
    const page = { isClosed: () => false, locator: (sel) => ({
      first() { return this; }, count: async () => (sel.includes("otc") ? 1 : 0),
      isVisible: async () => true, fill: async (v) => { filled = v; },
    }) };
    const r = await totp.fillTotpIfNeeded(page, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", { nowMs: 59000 });
    assert.equal(r.filled, true);
    assert.match(filled, /^\d{6}$/);
    const empty = { isClosed: () => false, locator: () => ({ first() { return this; }, count: async () => 0, isVisible: async () => true, fill: async () => {} }) };
    assert.equal((await totp.fillTotpIfNeeded(empty, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", { nowMs: 59000 })).filled, false);
  });

  // ---- 接线 ----
  await test("runner 默认只读盘点，写操作必须显式开启", async () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "runner.js"), "utf8");
    assert.match(src, /nextActivities\.runActivities\(ctx, \{ dryRun: opts\.runNextActivities !== true \}\)/);
  });

  console.log(lines.join("\n"));
  console.log(`\n结果: ${lines.length - failed} 通过 / ${failed} 失败`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error("[测试异常]", e); process.exitCode = 1; });
