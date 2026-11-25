/**
 * 月度额度耗尽后的「每日保活」离线回归（2026-11-24，用户定）。
 *
 * 全程离线：不联网、不登录账号、不碰真实 state.json。
 * 用 Module._load 在 require 之前把外部依赖打桩，驱动 **tasks.js 里真实的
 * runKeepAliveSearch / runKeepAliveRead 代码路径**（不是复制一份逻辑来测），
 * 验证：封顶后真的会发请求、按天目标固定、跑满即收工、不写服务器计分进度。
 *
 * 用法: npm run test:keep-alive
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TASKS_FILE = path.join(ROOT, "src", "tasks.js");
const Q = require(path.join(ROOT, "src", "daily-quota.js"));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const lines = [];
let failed = 0;
async function test(name, fn) {
  try { await fn(); lines.push(`  ✅ ${name}`); }
  catch (e) { failed++; lines.push(`  ❌ ${name} — ${String((e && e.message) || e).slice(0, 240)}`); }
}

/** 造一份内存态 state + 配置，记录所有 HTTP 请求 */
function makeScenario(opts = {}) {
  const sc = {
    dateNum: opts.dateNum || 20261124,
    calls: [],
    logs: [],
    marked: {},
    saves: 0,
  };
  const s = {
    keepAlive: opts.ledger,
    pc: { progress: 0, max: 0 },
    m: { progress: 0, max: 0 },
    readArticles: { done: 0, total: 0 },
    readPoint: 0,
    searchPoint: 0,
    tasksDone: {},
  };
  sc.store = s;
  const state = {
    get() { return s; },
    save() { sc.saves++; },
    setTaskDone(t, d) { sc.marked[t] = d; s.tasksDone[t] = d; },
    getDateNum() { return sc.dateNum; },
    getDateHyphen() { return "2026-11-24"; },
    buildCookieHeader() { return ""; },
    isTaskDoneToday(t) { return s.tasksDone[t] === sc.dateNum; },
  };
  const cfg = {
    limits: { random: false },
    search: { api: "offline", span: 0 },
    region: { lock: false },
    tasks: { search: true, read: true },
  };
  sc.ctx = { state, config: { get: () => cfg }, name: "保活离线测试" };

  const stubs = {
    "./logger": {
      log: (...a) => sc.logs.push(a.join(" ")),
      info: (...a) => sc.logs.push(a.join(" ")),
      warn: (...a) => sc.logs.push(a.join(" ")),
      error: (...a) => sc.logs.push(a.join(" ")),
      success: (...a) => sc.logs.push(a.join(" ")),
    },
    "./http": {
      httpRequest: async (o) => {
        sc.calls.push(o);
        return { text: '<html>,IG:"TESTIG"</html>' };
      },
    },
    "./rewards": {
      resolveHost: async () => "www.bing.com",
      UA_PC: "UA-PC-STUB",
      UA_MOBILE: "UA-MOBILE-STUB",
      READ_OFFER_ID: "ENUS_readarticle3_30points",
      POINTS_PER_ARTICLE: 3,
      getRewardsInfo: async () => ({ ok: false }),
    },
    "./notify": { sendText: async () => ({}) },
    "./cancel": { throwIfAborted() {}, sleep: async () => {} },
    "./browser": { clearBrowserCache: async () => {} },
    "./query-sources": {
      createCache: () => ({}),
      hasPool: () => true,
      addSource: () => 0,
      nextQuery: () => "每日保活测试词",
    },
    "./humanize": { randomRatio: () => 0.6 },
  };
  sc.stubs = stubs;
  return sc;
}

/** 装桩后重新 require 产品代码；daily-quota 故意不打桩，测的是真实纯函数联动 */
function loadTasks(stubs) {
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return orig.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(TASKS_FILE)];
    return require(TASKS_FILE);
  } finally {
    Module._load = orig;
  }
}

/** 固定随机源：0 → 目标恒为 10；0.999 → 恒为 20；调用方自行恢复 */
function withRandom(value, fn) {
  const orig = Math.random;
  Math.random = () => value;
  return Promise.resolve(fn()).finally(() => { Math.random = orig; });
}

async function main() {
  await test("① 纯函数：本月额度耗尽判定只认「服务器明确给 0」", async () => {
    const capped = Q.normalizeCounter({ max: 0, progress: 0 }, { fallbackMax: 15 });
    assert.equal(capped.capped, true);
    assert.equal(Q.isQuotaExhausted([capped]), true, "PC 0 + 移动缺失也应判耗尽");
    assert.equal(Q.isQuotaExhausted([capped, Q.normalizeCounter({ max: 0, progress: 0 })]), true);
    const missing = Q.normalizeCounter({}, { fallbackMax: 0 });
    assert.equal(missing.explicit, false);
    assert.equal(Q.isQuotaExhausted([missing]), false, "字段缺失是解析失败，不能误判成封顶去保活");
    assert.equal(Q.isQuotaExhausted([Q.normalizeCounter({ max: 3, progress: 1 })]), false, "还有额度不该保活");
    assert.equal(Q.isQuotaExhausted([]), false);
  });

  await test("② 纯函数：每日目标随机 10~20，同一天固定、跨天重掷", async () => {
    const day = 20261124;
    const lo = Q.planKeepAlive(null, day, () => 0);
    assert.equal(lo.searchTarget, 10);
    assert.equal(lo.readTarget, 10);
    assert.equal(lo.searchLeft, 10);
    assert.equal(lo.isNewDay, true);
    const hi = Q.planKeepAlive(null, day, () => 0.999999);
    assert.equal(hi.searchTarget, 20);
    assert.equal(hi.readTarget, 20);
    const same = Q.planKeepAlive({ date: day, searchTarget: 17, readTarget: 13, searchDone: 5, readDone: 2 }, day, () => 0);
    assert.equal(same.searchTarget, 17, "同一天不能重掷目标");
    assert.equal(same.readTarget, 13);
    assert.equal(same.searchLeft, 12);
    assert.equal(same.readLeft, 11);
    assert.equal(same.isNewDay, false);
    const next = Q.planKeepAlive(same, day + 1, () => 0);
    assert.equal(next.isNewDay, true);
    assert.equal(next.searchDone, 0, "跨天已完成数归零");
    assert.equal(next.searchTarget, 10, "跨天重新掷");
    const dirty = Q.planKeepAlive({ date: day, searchTarget: 999, readTarget: -1, searchDone: 99, readDone: -5 }, day, () => 0);
    assert.equal(dirty.searchTarget, 10, "脏目标要重新掷");
    assert.equal(dirty.searchDone, 0);
  });

  await test("③ 打桩真路径：封顶后搜索真的跑满 10 次，且不写服务器积分进度", async () => {
    const sc = makeScenario();
    const tasks = loadTasks(sc.stubs);
    await withRandom(0, async () => {
      const r = await tasks.runKeepAliveSearch(sc.ctx);
      assert.equal(r.status, "done");
      assert.equal(r.keepAlive, true);
      assert.equal(r.capped, true);
      assert.equal(r.searched, 10, "目标 10 次要跑满");
      assert.equal(r.keepAliveDone, 10);
      assert.match(r.reason, /当月无需执行计分搜索任务/);
      const gets = sc.calls.filter((c) => String(c.url).includes("/search?"));
      assert.equal(gets.length, 10, `真实搜索请求应为 10 次，实际 ${gets.length}`);
      assert.ok(sc.calls.some((c) => String(c.url).includes("ncheader")), "保活也要走真实上报形态");
      assert.equal(sc.store.pc.progress, 0, "保活绝不能伪造 PC 积分进度");
      assert.equal(sc.store.m.progress, 0);
      assert.equal(sc.store.searchPoint, 0, "不计分路径不得写 searchPoint");
      assert.equal(sc.marked.search, 20261124, "跑满后标记当天完成，避免被自动循环反复触发");
      assert.equal(sc.store.keepAlive.searchDone, 10);
      assert.equal(sc.store.keepAlive.searchTarget, 10);
      assert.ok(sc.logs.some((l) => l.includes("转入每日保活")));
    });
  });

  await test("④ 同一天目标已达成 → 不再重复发请求（按天账本生效）", async () => {
    const sc = makeScenario({ ledger: { date: 20261124, searchTarget: 10, readTarget: 10, searchDone: 10, readDone: 0 } });
    const tasks = loadTasks(sc.stubs);
    await withRandom(0, async () => {
      const r = await tasks.runKeepAliveSearch(sc.ctx);
      assert.equal(r.status, "skip");
      assert.equal(r.searched, 0);
      assert.equal(sc.calls.length, 0, "已达目标不该再发任何请求");
      assert.match(r.reason, /保活已达目标/);
    });
  });

  await test("⑤ 中断续跑 / 跨天重置：只补差额，换天重新掷目标", async () => {
    const sc = makeScenario({ ledger: { date: 20261124, searchTarget: 15, readTarget: 13, searchDone: 12, readDone: 13 } });
    const tasks = loadTasks(sc.stubs);
    await withRandom(0, async () => {
      const r = await tasks.runKeepAliveSearch(sc.ctx);
      assert.equal(r.searched, 3, "只补 15-12=3 次");
      assert.equal(r.keepAliveDone, 15);
      assert.equal(sc.store.keepAlive.readTarget, 13, "搜索保活不能把阅读账本冲掉");
      assert.equal(sc.store.keepAlive.readDone, 13);
    });
    const sc2 = makeScenario({ dateNum: 20261125, ledger: { date: 20261124, searchTarget: 15, readTarget: 13, searchDone: 15, readDone: 13 } });
    const tasks2 = loadTasks(sc2.stubs);
    await withRandom(0, async () => {
      const r2 = await tasks2.runKeepAliveSearch(sc2.ctx);
      assert.equal(r2.searched, 10, "新的一天重新掷成 10 次");
      assert.equal(sc2.store.keepAlive.date, 20261125);
      assert.equal(sc2.marked.search, 20261125);
    });
  });

  await test("⑥ 打桩真路径：阅读保活发真实阅读上报 10 次，point 恒为 0", async () => {
    const sc = makeScenario();
    const tasks = loadTasks(sc.stubs);
    await withRandom(0, async () => {
      const r = await tasks.runKeepAliveRead(sc.ctx, "STUB_TOKEN");
      assert.equal(r.status, "done");
      assert.equal(r.keepAlive, true);
      assert.equal(r.point, 0, "封顶后阅读不计分");
      assert.equal(r.articles, 10);
      assert.equal(r.articlesTotal, 10);
      assert.match(r.reason, /当月无需执行计分阅读任务/);
      const posts = sc.calls.filter((c) => c.method === "POST" && String(c.url).includes("/dapi/me/activities"));
      assert.equal(posts.length, 10, `阅读上报应为 10 次，实际 ${posts.length}`);
      const body = JSON.parse(posts[0].data);
      assert.equal(body.type, 101);
      assert.equal(body.attributes.offerid, "ENUS_readarticle3_30points");
      assert.equal(sc.marked.read, 20261124);
      assert.equal(sc.store.readPoint, 0, "保活不能伪造阅读积分");
      assert.equal(sc.store.readArticles.done, 10);
    });
  });

  await test("⑦ 接线守卫：封顶分支必须走保活，不许退回「本轮跳过，不白跑」", async () => {
    const tasksSrc = read("src/tasks.js");
    const stateSrc = read("src/state.js");
    const runnerSrc = read("src/runner.js");
    assert.match(tasksSrc, /dailyQuota\.isQuotaExhausted\(\[pcQ, mQ\]\)[\s\S]{0,300}?return await runKeepAliveSearch\(ctx\)/);
    assert.match(tasksSrc, /if \(readPro\.capped \|\| readPro\.max <= 0\)[\s\S]{0,300}?return await runKeepAliveRead\(ctx, token\)/);
    assert.ok(!tasksSrc.includes("本轮跳过，不白跑"), "旧的封顶跳过文案必须消失");
    assert.match(stateSrc, /keepAlive: \{[\s\S]{0,400}?searchTarget: 0/);
    assert.match(stateSrc, /cache\.keepAlive = \{ \.\.\.DEFAULT_STATE\.keepAlive, \.\.\.\(raw\.keepAlive \|\| \{\}\) \}/);
    assert.match(runnerSrc, /当月无需执行搜索任务 · 每日保活/);
    assert.match(runnerSrc, /当月无需执行阅读任务 · 每日保活/);
    assert.equal(Q.KEEP_ALIVE_MIN, 10);
    assert.equal(Q.KEEP_ALIVE_MAX, 20);
    // 保活循环内部不得篡改服务器计分进度（否则仪表盘会出现「0 分却显示已搜 N 次」）
    const kaSearch = tasksSrc.slice(tasksSrc.indexOf("async function runKeepAliveSearch"), tasksSrc.indexOf("async function runKeepAliveRead"));
    const kaRead = tasksSrc.slice(tasksSrc.indexOf("async function runKeepAliveRead"), tasksSrc.indexOf("function searchProgressSnapshot"));
    assert.ok(!kaSearch.includes("search.pc.progress ="), "保活搜索不得写 PC 进度");
    assert.ok(!kaSearch.includes("getRewardsInfo("), "保活搜索不得做积分复核（max=0 会误标完成）");
    assert.ok(!kaRead.includes("readPoint ="), "保活阅读不得写积分");
    assert.ok(kaSearch.includes("planKeepAlive") && kaRead.includes("planKeepAlive"));
  });

  console.log(lines.join("\n"));
  console.log(`\n结果: ${lines.length - failed} 通过 / ${failed} 失败\n`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error("测试脚本自身异常:", e);
  process.exitCode = 1;
});
