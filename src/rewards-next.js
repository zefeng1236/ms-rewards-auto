/**
 * Rewards 新版（Next.js / RSC）数据层与 Server Action 层。
 *
 * 2026-11-17 真机抓包结论（开发环境测试号，只读）：
 *   · GET https://rewards.bing.com/api/getuserinfo  → 904KB JSON，含
 *     dashboard.punchCards[].childPromotions[]（hash / activityType / complete）、
 *     dashboard.streakProtectionPromo、dashboard.userWarnings、
 *     profile.attributes.serpbotscore、dashboard.morePromotions[]。
 *   · JS chunk 里的 createServerReference("<40~64 hex>", ..., "<name>") 给出 actionId：
 *     reportActivity / reportToggleStreakProtection / reportClaimAllPoints 等 16 个。
 *   · 上报 = POST 到 /earn|/dashboard|/earn/quest/<id>，头部带 Next-Action 与
 *     Next-Router-State-Tree，body 是 JSON 数组 [hash, activityType, {...}]。
 *
 * ⚠️ 写操作默认 dryRun=true：只盘点、不往账号发任何 POST。actionId 只在真正要写时
 *    才去动态发现（避免每轮下载几十个 chunk），发现结果按小时缓存。
 */
"use strict";

const logger = require("./logger");
const { httpRequest } = require("./http");

const REWARDS = "https://rewards.bing.com";
const USERINFO_API = `${REWARDS}/api/getuserinfo`;
const FLYOUT_API = "https://www.bing.com/rewards/panelflyout/getuserinfo?channel=BingFlyout&partnerId=BingRewards";
const HEX = "[a-f0-9]{40,64}";
const NON_NAMES = new Set(["callServer", "findSourceMapURL", "encodeFormAction", "default"]);

/* ==================== 纯函数：解析 ==================== */

function boolish(v) {
  return v === true || /^(true|1|yes|on)$/i.test(String(v ?? ""));
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseStreakProtection(d) {
  const p = (d && d.streakProtectionPromo) || {};
  return {
    offerId: p.offerid || "",
    on: boolish(p.streakProtectionStatus),
    eligible: boolish(p.isStreakProtectionOnEligible),
    remainingDays: num(p.remainingDays),
    streakCount: num(p.streakCount),
    todayComplete: boolish(p.isTodayStreakComplete),
    autoTurnOn: boolish(p.autoTurnOn),
  };
}

function normalizePromotion(p) {
  if (!p || typeof p !== "object") return null;
  const a = p.attributes || {};
  return {
    offerId: String(p.offerId || a.offerid || ""),
    hash: String(p.hash || a.hash || ""),
    title: String(p.title || a.title || ""),
    complete: boolish(p.complete) || boolish(a.complete),
    points: num(p.pointProgressMax, num(a.max)),
    activityType: num(p.activityType, num(a.type, 11)) || 11,
    promotionType: String(p.promotionType || a.type || ""),
    destination: String(p.destinationUrl || a.destination || ""),
    isPromotional: boolish(a.promotional),
    giveEligible: boolish(p.isGiveEligible),
  };
}

function parsePunchCards(d) {
  const cards = Array.isArray(d && d.punchCards) ? d.punchCards : [];
  return cards.map((c) => ({
    name: String(c.name || ""),
    offerId: String((c.parentPromotion && c.parentPromotion.offerId) || c.name || ""),
    complete: boolish(c.parentPromotion && c.parentPromotion.complete),
    points: num(c.parentPromotion && c.parentPromotion.pointProgressMax),
    children: (Array.isArray(c.childPromotions) ? c.childPromotions : [])
      .map(normalizePromotion)
      .filter(Boolean),
  }));
}

function parseRisk(d) {
  const warnings = (Array.isArray(d && d.userWarnings) ? d.userWarnings : [])
    .map((w) => (typeof w === "string" ? w : w && w.name))
    .filter(Boolean);
  const attrs = (d && d.userProfile && d.userProfile.attributes) || null;
  let botScore = null;
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      if (/^serpbotscore$/i.test(k)) { botScore = num(attrs[k], null); break; }
    }
  }
  return { warnings, botScore };
}

/** 从整个 dashboard 里找视觉搜索相关的 offer（activation / streak 都可能带） */
function parseVisualSearch(d) {
  const pools = [
    ...(Array.isArray(d && d.morePromotions) ? d.morePromotions : []),
    ...(Array.isArray(d && d.promotionalItems) ? d.promotionalItems : []),
    ...(Array.isArray(d && d.streakBonusPromotions) ? d.streakBonusPromotions : []),
  ];
  return pools
    .map(normalizePromotion)
    .filter((p) => p && /visual.?search/i.test(`${p.offerId} ${p.title} ${p.promotionType}`));
}

function parseDashboard(payload) {
  const d = (payload && payload.dashboard) || {};
  const root = payload || {};
  const status = (root.status && root.status.userStatus) || {};
  const user = d.userStatus || {};
  const riskAttrs = (root.profile && root.profile.attributes) || {};
  let botScore = null;
  for (const k of Object.keys(riskAttrs)) {
    if (/^serpbotscore$/i.test(k)) { botScore = num(riskAttrs[k], null); break; }
  }
  return {
    ok: true,
    availablePoints: num(user.availablePoints, num(root.catalog && root.catalog.availablePoints)),
    counters: user.counters || status.counters || {},
    warnings: parseRisk(d).warnings,
    botScore: botScore != null ? botScore : parseRisk(d).botScore,
    streakProtection: parseStreakProtection(d),
    punchCards: parsePunchCards(d),
    morePromotions: (Array.isArray(d.morePromotions) ? d.morePromotions : []).map(normalizePromotion).filter(Boolean),
    promotionalItems: (Array.isArray(d.promotionalItems) ? d.promotionalItems : []).map(normalizePromotion).filter(Boolean),
    visualSearch: parseVisualSearch(d),
    dailySetKeys: Object.keys(d.dailySetPromotions || {}),
  };
}

function parseFlyout(payload) {
  const u = (payload && payload.userInfo) || {};
  const promos = (Array.isArray(u.promotions) ? u.promotions : []).map(normalizePromotion).filter(Boolean);
  return {
    ok: true,
    source: "flyout",
    availablePoints: num(u.balance),
    counters: u.counters || {},
    warnings: [],
    botScore: null,
    streakProtection: { offerId: "", on: null, eligible: false, remainingDays: 0, streakCount: 0 },
    punchCards: [],
    morePromotions: promos,
    promotionalItems: [],
    visualSearch: promos.filter((p) => /visual.?search/i.test(`${p.offerId} ${p.title}`)),
    dailySetKeys: [],
  };
}

/* ==================== 网络：只读拉取 ==================== */

const UA_PC = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";

function isDashboardResponse(r) {
  if (!r || r.status !== 200 || !r.text) return false;
  try {
    const j = JSON.parse(r.text);
    return Boolean(j && (j.dashboard || j.userInfo));
  } catch { return false; }
}

/**
 * 浏览器通道（2026-11-17 真机实证）。
 * Node fetch 跟随跨域重定向时会剥掉 Cookie 头，/api/getuserinfo 的 302 跳到
 * login.live.com 后就变成未登录页面；Playwright 的 cookie jar 会按域重新附加，
 * 实测稳定返回 904KB JSON。
 *
 * ⚠️ 真实写操作也**必须**走这里：POST 若用裸 Node fetch，既会丢 Cookie，
 *    又缺少浏览器前置页面请求与指纹请求头，从服务端看是异常会话。因此写操作
 *    会先 GET 一次 earn 页建立会话，再 POST Server Action。
 */
function cookiesFor(ctx) {
  const raw = ctx && ctx.state
    ? (typeof ctx.state.getCookies === "function" ? ctx.state.getCookies() : (ctx.state.get().cookies || []))
    : [];
  return (raw || []).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain || ".bing.com",
    path: c.path || "/",
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: /^strict$/i.test(String(c.sameSite)) ? "Strict" : /^none$/i.test(String(c.sameSite)) ? "None" : "Lax",
    ...(Number(c.expires) > 0 ? { expires: Number(c.expires) } : {}),
  }));
}

async function browserRequest(ctx, o) {
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({
    executablePath: chromium.executablePath(), headless: true, args: ["--no-first-run"],
  });
  try {
    const context = await browser.newContext({ userAgent: UA_PC, locale: "zh-CN" });
    await context.addCookies(cookiesFor(ctx));
    const page = await context.newPage();
    const isPost = o.method === "POST";
    // 写操作前置 GET：让这次上报看起来像「正在浏览 earn 页时触发的正常交互」
    if (isPost && o.warmupUrl) {
      try {
        await page.request.get(o.warmupUrl, {
          headers: { Accept: "text/html,application/xhtml+xml", "Accept-Language": "zh-CN,zh;q=0.9" },
          timeout: 20000,
        });
      } catch (e) {
        logger.warn(`写操作前置页面请求失败: ${String((e && e.message) || e).slice(0, 80)}`);
      }
    }
    const r = isPost
      ? await page.request.post(o.url, { headers: o.headers || {}, data: o.data, timeout: o.timeout || 20000 })
      : await page.request.get(o.url, { headers: o.headers || {}, timeout: o.timeout || 20000 });
    return { status: r.status(), text: await r.text() };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** 只读拉取走的薄封装（fetchDashboard 用） */
async function browserFetch(ctx, o) {
  return browserRequest(ctx, o);
}

/**
 * 真实页面导航取 HTML。
 * ⚠️ 不能用 page.request.get 取 /earn：它是 API 请求、不执行 JS，服务端会返回
 *    2910 字节的「登录需要启用 JavaScript」拦截页（11-17 真机实证），chunk 路径为 0。
 *    必须 page.goto + 等一会儿让 Next.js 把 script 标签写进 DOM，才能拿到 321KB RSC。
 */
async function browserPageHtml(ctx, url) {
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({
    executablePath: chromium.executablePath(), headless: true, args: ["--no-first-run"],
  });
  try {
    const context = await browser.newContext({ userAgent: UA_PC, locale: "zh-CN" });
    await context.addCookies(cookiesFor(ctx));
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);
    return { status: 200, text: await page.content() };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * 批量浏览器 GET：一次启动、同一个 cookie jar，顺序下载多个 URL。
 * 用于 actionId 发现（earn 页 + 几十个 JS chunk），避免每个 chunk 起一个 Chromium。
 * 总时限 90 秒，超时后剩下的直接放弃 —— 宁可这轮不写，也不能拖住任务链。
 */
async function browserFetchBatch(ctx, urls) {
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({
    executablePath: chromium.executablePath(), headless: true, args: ["--no-first-run"],
  });
  const started = Date.now();
  const out = [];
  try {
    const context = await browser.newContext({ userAgent: UA_PC, locale: "zh-CN" });
    await context.addCookies(cookiesFor(ctx));
    const page = await context.newPage();
    for (const url of urls || []) {
      if (Date.now() - started > 90000) { out.push({ status: 0, text: "" }); continue; }
      try {
        const r = await page.request.get(url, {
          headers: { Accept: "*/*", "Accept-Language": "zh-CN,zh;q=0.9" },
          timeout: 15000,
        });
        out.push({ status: r.status(), text: r.status() === 200 ? await r.text() : "" });
      } catch {
        out.push({ status: 0, text: "" });
      }
    }
    return out;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function fetchDashboard(ctx, opts = {}) {
  // 离线测试可注入 request；注入时不启用浏览器兜底，保证测试确定性
  const injected = typeof opts.request === "function" ? opts.request : null;
  const primary = injected || httpRequest;
  const tryOnce = async (o) => {
    let r = await primary(o);
    if (!injected && !isDashboardResponse(r)) {
      try { r = await browserFetch(ctx, o); }
      catch (e) { logger.warn(`dashboard 浏览器兜底失败: ${String((e && e.message) || e).slice(0, 80)}`); }
    }
    return r;
  };

  const r = await tryOnce({
    url: USERINFO_API,
    headers: { "user-agent": UA_PC, Accept: "application/json, text/plain, */*", Referer: `${REWARDS}/` },
    ctx, timeout: 20000, dontLog: true,
  });
  if (isDashboardResponse(r)) {
    const j = JSON.parse(r.text);
    if (j.dashboard) return { ...parseDashboard(j), source: "getuserinfo" };
    return parseFlyout(j);
  }

  const f = await tryOnce({
    url: FLYOUT_API,
    headers: { "user-agent": UA_PC, Accept: "application/json, text/plain, */*", Referer: "https://www.bing.com/" },
    ctx, timeout: 20000, dontLog: true,
  });
  if (isDashboardResponse(f)) return parseFlyout(JSON.parse(f.text));

  return {
    ok: false, reason: "dashboard 与 flyout 均不可用",
    punchCards: [], morePromotions: [], promotionalItems: [], visualSearch: [],
  };
}

/* ==================== Server Action id 发现 ==================== */

function extractChunkPaths(html) {
  const out = new Set();
  for (const m of String(html || "").matchAll(/(?:static\/chunks\/|static\/media\/)[\w\-./()]+?\.js/g)) {
    out.add("/_next/" + m[0]);
  }
  return [...out];
}

/** 纯函数：从一段 JS 里提取具名 server action id */
function extractNamedActions(js) {
  const out = {};
  const text = String(js || "");
  const patterns = [
    new RegExp(`createServerReference\\s*\\)?\\s*\\(\\s*"(${HEX})"([\\s\\S]{0,800}?)\\)`, "g"),
    new RegExp(`registerServerReference\\s*\\)?\\s*\\([^,]+,\\s*"(${HEX})"([\\s\\S]{0,800}?)\\)`, "g"),
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const names = [...(m[2] || "").matchAll(/"([A-Za-z_$][\w$]*)"/g)]
        .map((x) => x[1])
        .filter((n) => n.length > 3 && !NON_NAMES.has(n));
      if (names.length) out[names[names.length - 1]] = m[1];
    }
  }
  return out;
}

let actionCache = { at: 0, actions: {} };
const ACTION_TTL_MS = 6 * 3600 * 1000;

function cachedActions(nowMs = Date.now()) {
  return actionCache.at && nowMs - actionCache.at < ACTION_TTL_MS ? actionCache.actions : null;
}

async function discoverActions(ctx, opts = {}) {
  const cached = opts.force ? null : cachedActions(opts.nowMs);
  if (cached && Object.keys(cached).length) return { ok: true, cached: true, actions: cached };
  const injected = typeof opts.request === "function" ? opts.request : null;
  const merged = {};
  let downloaded = 0;

  if (injected) {
    // 离线打桩：完全走注入 request，保证测试确定性，不起浏览器
    const htmlRes = opts.earnHtml != null
      ? { status: 200, text: opts.earnHtml }
      : await injected({ url: `${REWARDS}/earn`, ctx, timeout: 25000, dontLog: true });
    const paths = extractChunkPaths(htmlRes && htmlRes.text).slice(0, Number(opts.maxChunks) || 60);
    if (!paths.length) return { ok: false, reason: "earn 页未发现 JS chunk", actions: {} };
    for (const p of paths) {
      const r = await injected({ url: REWARDS + p, ctx, timeout: 15000, dontLog: true });
      if (!r || r.status !== 200 || !r.text) continue;
      downloaded++;
      Object.assign(merged, extractNamedActions(r.text));
    }
  } else {
    // 真机：直连 /earn 会因跨域重定向丢 Cookie 拿到 35KB 登录页（11-17 实证），
    // chunk 路径数为 0。所以整批走浏览器通道：一次启动、同一 cookie jar。
    const earnRes = opts.earnHtml != null
      ? { status: 200, text: opts.earnHtml }
      : await browserPageHtml(ctx, `${REWARDS}/earn`);
    const html = (earnRes && earnRes.text) || "";
    const paths = extractChunkPaths(html).slice(0, Number(opts.maxChunks) || 60);
    if (!paths.length) return { ok: false, reason: "earn 页未发现 JS chunk（浏览器通道）", actions: {} };
    const chunks = await browserFetchBatch(ctx, paths.map((p) => REWARDS + p));
    for (const r of chunks) {
      if (!r || r.status !== 200 || !r.text) continue;
      downloaded++;
      Object.assign(merged, extractNamedActions(r.text));
    }
  }

  actionCache = { at: opts.nowMs || Date.now(), actions: merged };
  logger.info(`Server Action 发现: ${downloaded} 个 chunk，${Object.keys(merged).length} 个具名 action`);
  return { ok: Object.keys(merged).length > 0, downloaded, actions: merged };
}

function resetActionCache() { actionCache = { at: 0, actions: {} }; }

/* ==================== Router State Tree（固定结构，不需要抓） ==================== */

const REFRESH_FLAG = 4096;
function routerStateTree(segment) {
  const tree = ["", {
    children: ["(nav)", {
      children: [segment, { children: ["PAGE", {}, null, null, REFRESH_FLAG] }, null, null, REFRESH_FLAG],
    }, null, null, REFRESH_FLAG],
  }, null, null, REFRESH_FLAG + 16];
  return encodeURIComponent(JSON.stringify(tree));
}

function questRouterStateTree(questId) {
  const tree = ["", {
    children: ["(nav)", {
      children: ["earn", {
        children: ["quest", {
          children: [["questId", questId, "d", null], { children: ["__PAGE__", {}, null, null, 0] }, null, null, 0],
        }, null, null, 0],
      }, null, null, 0],
    }, null, null, 0],
  }, null, null, 16];
  return encodeURIComponent(JSON.stringify(tree));
}

/* ==================== 上报（默认 dryRun） ==================== */

async function reportServerAction(ctx, opts = {}) {
  const {
    actionId, args = [], url = `${REWARDS}/dashboard`, tree = routerStateTree("dashboard"),
    dryRun = true,
  } = opts;
  if (dryRun) return { dryRun: true, status: 0, ok: false, bodyBytes: 0 };
  if (!actionId) return { dryRun: false, status: 0, ok: false, reason: "缺少 actionId" };
  const injected = typeof opts.request === "function" ? opts.request : null;
  const requestOpts = {
    url,
    method: "POST",
    ctx,
    timeout: 20000,
    dontLog: true,
    headers: {
      Accept: "text/x-component",
      "Content-Type": "text/plain;charset=UTF-8",
      "Next-Action": actionId,
      "Next-Router-State-Tree": tree,
      Referer: opts.referer || url,
      Origin: REWARDS,
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    },
    data: JSON.stringify(args),
  };
  // ⚠️ 真实写操作一律走浏览器通道：裸 Node fetch 跨域重定向会剥 Cookie，
  //    且缺少前置页面请求与浏览器请求头（真机 11-17 实证）。离线注入 request 时
  //    仍走注入桩，保证测试确定性；绝不因失败自动重发同一个 POST。
  const r = injected
    ? await injected(requestOpts)
    : await browserRequest(ctx, { ...requestOpts, warmupUrl: opts.warmup === false ? null : `${REWARDS}/earn` });
  const ok = r.status >= 200 && r.status < 300;
  // 只清 actionId 缓存，不重发本次请求：服务端状态未知时重复上报风险更大。
  if (!ok) resetActionCache();
  return { dryRun: false, status: r.status, ok, bodyBytes: String(r.text || "").length };
}

module.exports = {
  REWARDS,
  USERINFO_API,
  FLYOUT_API,
  parseDashboard,
  parseFlyout,
  parseStreakProtection,
  normalizePromotion,
  parseVisualSearch,
  fetchDashboard,
  browserFetch,
  browserRequest,
  browserPageHtml,
  browserFetchBatch,
  cookiesFor,
  extractChunkPaths,
  extractNamedActions,
  discoverActions,
  cachedActions,
  resetActionCache,
  routerStateTree,
  questRouterStateTree,
  reportServerAction,
};
