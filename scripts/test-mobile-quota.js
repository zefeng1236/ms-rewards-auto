/**
 * 统一搜索池离线回归（2026-11-25 手机真机抓包定案）。
 *
 * 全程离线：不联网、不登录账号、不碰真实 state.json。
 * fixture 取自本人账号 balance=16073 的 dapi/me 真实任务卡：
 *   WW_NewLevel3_search_PC { type:"search", max:"60", progress:"51" }
 *
 * 覆盖：搜索卡解析（真机 / Level2 / 独立移动卡 / 脏数据 / 抽奖卡排除）、
 *       按账户缓存与跨天失效、不再补拉错误端点、earn 页解析失败时用 dapi/me 兜底、
 *       并用 Module._load 打桩驱动真实的 getRewardsInfo / getReadPro。
 *
 * 用法: npm run test:mobile-quota
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const REWARDS_FILE = path.join(ROOT, "src", "rewards.js");
const M = require(path.join(ROOT, "src", "mobile-quota.js"));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const lines = [];
let failed = 0;
async function test(name, fn) {
  try { await fn(); lines.push(`  ✅ ${name}`); }
  catch (e) { failed++; lines.push(`  ❌ ${name} — ${String((e && e.message) || e).slice(0, 240)}`); }
}

const T = Date.UTC(2026, 10, 25, 2, 0, 0); // 固定时间，避免跨天/时钟导致假红

/** 真机抓包里的搜索卡（本人账号，19:52 时 51/60） */
const L3_SEARCH = {
  name: "WW_NewLevel3_search_PC",
  attributes: {
    offerid: "WW_search_global_NewLevel3",
    title: "搜索",
    max: "60",
    progress: "51",
    originalmax: "60",
    description: "每天最多可赚取 60 积分，每次搜索可获得 3 积分",
    type: "search",
    complete: "False",
  },
};
/** 另一个测试号（balance 2858 / Level2）的 30 分卡 */
const L2_SEARCH = {
  name: "WW_NewLevel2_search_PC",
  attributes: {
    offerid: "WW_search_global_NewLevel2",
    title: "搜索",
    max: "30",
    progress: "0",
    originalmax: "30",
    type: "search",
    complete: "False",
  },
};
const READ_CARD = {
  name: "ENUS_readarticle3_30points_Default",
  attributes: { offerid: "ENUS_readarticle3_30points", type: "msnreadearn", max: "30", progress: "18" },
};

const dapiMe = (cards) => ({ response: { profile: null, balance: 16073, counters: null, promotions: cards } });
const realPayload = () => dapiMe([L3_SEARCH, READ_CARD]);

/** 造一份可被 parsePointsCounters / findFlatNumber 解析的 earn 页 */
function earnHtml(withPc = true, pcMax = 60, pcProgress = 0) {
  const counters = withPc
    ? `"pc":{"max":${pcMax},"progress":${pcProgress},"originalMax":${pcMax}}`
    : `"mobileSearch":{"max":0,"progress":0}`;
  return `<html><body><script>DATA={"balance":16073,"pointsCounters":{"dailyOffer":5,${counters},"totalPoints":10,"boostActivated":false},"pointsHistory":{"thisMonth":{"earn":8388,"spend":0}}}</script></body></html>`;
}

function loadRewards(stubs) {
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return orig.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(REWARDS_FILE)];
    return require(REWARDS_FILE);
  } finally {
    Module._load = orig;
  }
}

function stubsFor(earnText, dapiPayload, logs = []) {
  const calls = [];
  return {
    calls,
    logs,
    stubs: {
      "./logger": {
        log: (...a) => logs.push(a.join(" ")),
        info: (...a) => logs.push(a.join(" ")),
        warn: (...a) => logs.push(a.join(" ")),
        error: (...a) => logs.push(a.join(" ")),
        success: (...a) => logs.push(a.join(" ")),
      },
      "./http": {
        httpRequest: async (o) => {
          calls.push(String(o.url));
          if (String(o.url).includes("/earn")) return { status: 200, text: earnText };
          if (String(o.url).includes("dapi/me")) return { status: 200, text: JSON.stringify(dapiPayload) };
          return { status: 404, text: "" };
        },
      },
    },
  };
}

async function main() {
  await test("① 真机卡 WW_NewLevel3_search_PC → 统一池 51/60，无独立移动额度", async () => {
    const r = M.parseSearchCards(realPayload());
    assert.equal(r.ok, true);
    assert.equal(r.max, 60);
    assert.equal(r.progress, 51);
    assert.equal(r.pc.max, 60);
    assert.equal(r.pc.progress, 51);
    assert.equal(r.mobile.max, 0, "国区没有第二张移动搜索卡");
    assert.equal(r.unifiedPool, true);
    assert.equal(r.hasMobileCard, false);
    assert.equal(r.source, "dapi/me");
    assert.ok(r.cardNames.includes("WW_NewLevel3_search_PC"));
    assert.equal(M.hasSeparateMobilePool(realPayload()), false);
  });

  await test("② Level2 30 分卡 / 数字类型 / originalmax 回退 / 进度钳位", async () => {
    const a = M.parseSearchCards(dapiMe([L2_SEARCH]));
    assert.equal(a.max, 30);
    assert.equal(a.progress, 0);
    const numeric = M.parseSearchCards(dapiMe([{
      name: "WW_NewLevel3_search_PC", attributes: { offerid: "WW_search_global_NewLevel3", type: "search", max: 60, progress: 999 },
    }]));
    assert.equal(numeric.max, 60);
    assert.equal(numeric.progress, 60, "进度越界要钳到上限");
    const orig = M.parseSearchCards(dapiMe([{
      name: "WW_search_PC", attributes: { type: "search", originalmax: "45", progress: "6" },
    }]));
    assert.equal(orig.max, 45);
    assert.equal(orig.progress, 6);
  });

  await test("③ 抽奖/统计卡与脏上限必须排除，绝不能当成明确 0 额度", async () => {
    const dirty = dapiMe([
      { name: "HVA_1M_Sweeps_task43_instantwinsearch_daily", attributes: { type: "search", max: "60" } },
      { name: "WW_NewLevel3_search_PC", attributes: { type: "search", max: "x", progress: null } },
      READ_CARD,
    ]);
    const r = M.parseSearchCards(dirty);
    assert.equal(r.ok, false, "脏上限卡丢弃后不能算成有效额度");
    assert.equal(r.reason, "no-valid-search-card");
    assert.equal(r.max, 0);
    assert.equal(M.parseSearchCards({ response: { counters: null } }).ok, false);
    assert.equal(M.parseSearchCards(null).ok, false);
    assert.equal(M.parseSearchCards({ response: { promotions: [{ name: "DailySet" }] } }).ok, false);
  });

  await test("④ 别的区服真有独立移动卡时才拆成两个池", async () => {
    const two = dapiMe([
      L3_SEARCH,
      { name: "WW_NewLevel3_search_Mobile", attributes: { offerid: "WW_search_global_Mobile", type: "search", max: "30", progress: "9" } },
    ]);
    const r = M.parseSearchCards(two);
    assert.equal(r.ok, true);
    assert.equal(r.hasMobileCard, true);
    assert.equal(r.unifiedPool, false);
    assert.equal(r.pc.max, 60);
    assert.equal(r.mobile.max, 30);
    assert.equal(r.mobile.progress, 9);
    assert.equal(M.hasSeparateMobilePool(two), true);
  });

  await test("⑤ 按账户缓存：隔离、TTL、跨天失效、不收失败结果", async () => {
    const s1 = {}, s2 = {};
    const good = M.parseSearchCards(realPayload());
    assert.equal(M.noteSearchQuota({ state: s1 }, good, T), true);
    assert.equal(M.readSearchQuota({ state: s1 }, T + 1000).max, 60);
    assert.equal(M.readSearchQuota({ state: s2 }, T + 1000), null, "不能串号");
    assert.equal(M.readSearchQuota({ state: s1 }, T + M.OK_TTL_MS + 1), null, "过期失效");
    assert.equal(M.readSearchQuota({ state: s1 }, T + 86400000), null, "跨天失效");
    assert.equal(M.noteSearchQuota({ state: s1 }, { ok: false }, T), false, "失败结果不入缓存");
    assert.ok(M._cacheGet(s1));
  });

  await test("⑥ 打桩真路径：earn 页给 PC 60 → m 明确 0/0，且不再补拉任何外部端点", async () => {
    const h = stubsFor(earnHtml(true, 60, 51), realPayload());
    const rewards = loadRewards(h.stubs);
    const info = await rewards.getRewardsInfo({ state: {}, config: { get: () => ({}) } });
    assert.equal(info.ok, true);
    assert.equal(info.pc.max, 60);
    assert.equal(info.pc.progress, 51);
    assert.equal(info.m.max, 0, "统一搜索池没有独立移动额度");
    assert.equal(info.m.progress, 0);
    assert.equal(info.m.explicitMax, true, "是「确认无独立池」，不是解析失败");
    assert.equal(h.calls.length, 1, "只应该请求 earn 页，绝不补拉 getuserinfo/flyout");
    assert.ok(h.calls[0].includes("/earn"));
    assert.ok(h.logs.some((l) => l.includes("统一搜索池，无独立移动额度")), "日志要说清是统一池");
  });

  await test("⑦ 打桩真路径：earn 页 pc 节点缺失 → 用 dapi/me 搜索卡兜底出 60 分", async () => {
    const state = {};
    const h1 = stubsFor(earnHtml(false), realPayload());
    const rewards1 = loadRewards(h1.stubs);
    await rewards1.getReadPro({ state, config: { get: () => ({}) } }, "fake-token");
    assert.ok(h1.logs.some((l) => l.includes("统一搜索池(dapi/me): 51/60 分")), "getReadPro 要顺手解析并记日志");

    const h2 = stubsFor(earnHtml(false), realPayload());
    const rewards2 = loadRewards(h2.stubs);
    const info = await rewards2.getRewardsInfo({ state, config: { get: () => ({}) } });
    assert.equal(info.ok, true);
    assert.equal(info.pc.max, 60, "earn 页没给上限时用 dapi/me 的真值");
    assert.equal(info.pc.progress, 51);
    assert.equal(info.pc.explicitMax, true);
    assert.ok(h2.logs.some((l) => l.includes("来源 dapi/me")), "日志要标明兜底来源");
  });

  await test("⑧ 打桩真路径：服务器明确给 0（封顶）不能被缓存覆盖", async () => {
    const state = {};
    const h1 = stubsFor(earnHtml(false), realPayload());
    const rewards1 = loadRewards(h1.stubs);
    await rewards1.getReadPro({ state, config: { get: () => ({}) } }, "fake-token");
    const h2 = stubsFor(earnHtml(true, 0, 0), realPayload());
    const rewards2 = loadRewards(h2.stubs);
    const info = await rewards2.getRewardsInfo({ state, config: { get: () => ({}) } });
    assert.equal(info.pc.max, 0, "明确 0 是封顶信号，不能被旧缓存盖掉");
    assert.equal(info.pc.explicitMax, true);
    assert.equal(info.m.max, 0);
  });

  await test("⑨ 接线守卫：错误端点补拉已移除，taskSearch 与保活判定不受影响", async () => {
    const rewardsSrc = read("src/rewards.js");
    const modSrc = read("src/mobile-quota.js");
    const tasksSrc = read("src/tasks.js");
    const quotaSrc = read("src/daily-quota.js");
    assert.match(rewardsSrc, /const searchQuota = require\("\.\/mobile-quota"\);/);
    assert.match(rewardsSrc, /m: mobileProgress/);
    assert.match(rewardsSrc, /searchQuota\.parseSearchCards\(data\)/);
    assert.match(rewardsSrc, /searchQuota\.readSearchQuota\(ctx\)/);
    assert.ok(!rewardsSrc.includes("mobileQuota.fetchMobileQuota"), "旧的错误补拉必须消失");
    assert.ok(!modSrc.includes('url: "https://rewards.bing.com/api/getuserinfo"'), "模块不得再配置错误端点");
    assert.ok(!modSrc.includes("panelflyout/getuserinfo?channel=BingFlyout"), "flyout 端点配置必须消失");
    assert.ok(!modSrc.includes("function fetchMobileQuota"), "模块不得再发网络请求");
    assert.ok(rewardsSrc.includes("统一搜索池"), "真机结论要写进注释/日志");
    assert.match(tasksSrc, /dailyQuota\.normalizeCounter\(dashboard\.m/);
    assert.match(tasksSrc, /search\.m = \{ progress: mPro, max: mMax \}/);
    assert.match(quotaSrc, /if \(node\.explicitMax === true\) return true;/);
  });

  await test("⑩ m 明确 0 不会让「pc 解析失败」误触发封顶保活", async () => {
    const Q = require(path.join(ROOT, "src", "daily-quota.js"));
    const mQ = Q.normalizeCounter({ progress: 0, max: 0, explicitMax: true }, { fallbackMax: 0 });
    const pcMissing = Q.normalizeCounter({ progress: 0, max: 0, explicitMax: false }, { fallbackMax: 15 });
    assert.equal(Q.isQuotaExhausted([pcMissing, mQ]), false, "pc 解析失败有兜底额度，不该去保活");
    const pcCapped = Q.normalizeCounter({ progress: 0, max: 0, explicitMax: true }, { fallbackMax: 15 });
    assert.equal(Q.isQuotaExhausted([pcCapped, mQ]), true, "两池都明确 0 才是真封顶");
  });

  console.log(lines.join("\n"));
  console.log(`\n结果: ${lines.length - failed} 通过 / ${failed} 失败\n`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error("测试脚本自身异常:", e);
  process.exitCode = 1;
});
