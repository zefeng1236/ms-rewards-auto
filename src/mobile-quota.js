/**
 * 统一搜索池校验（2026-11-25 手机真机抓包实证）。
 *
 * 【文件名沿用 mobile-quota.js，语义已改】历史名，实际职责是「从 dapi/me 的
 * promotions 里读出当天搜索额度，并确认是否存在独立移动端池」。
 *
 * 【真机证据 · 本人账号 balance=16073 / 金牌 Level3 · Reqable 抓包】
 *   手机 Bing App 打开 Rewards 时请求
 *     https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613
 *   响应 `response.promotions[]` 里**只有一张**搜索卡：
 *     WW_NewLevel3_search_PC { offerid: WW_search_global_NewLevel3,
 *       type: "search", max: "60", progress: "51", originalmax: "60",
 *       description: "每天最多可赚取 60 积分，每次搜索可获得 3 积分" }
 *   `response.counters` 里对应
 *     WW_search_global_NewLevel320261125 = "17;0;51;0"  (17 次 × 3 分 = 51)
 *     search_daily20261125 = "17;..."
 *   而同一时刻本软件日志是 `PC搜索=51/60`，state.json 是 `pc:{51,60}` —— **完全一致**。
 *   counters 里的 `search_mobile` / `search_mobilemonthly202611` 等只是历史行为计数
 *   （lifetime 4946 次 / 本月 201 次），不是额度池；promotions 里也没有第二张移动搜索卡。
 *
 * 【结论】国区是「统一搜索池」：PC 与手机共用同一张 60 分卡，不存在额外的
 *   「手机端每日 60 分」。`m` 恒为 0/0 是正确值，不是漏解析。
 *
 * 【为什么删掉上一版的补拉】上一版按 MRS助手（PC 浏览器脚本）的
 *   `/api/getuserinfo` + Bing flyout 的 `counters.mobileSearch[]` 补拉额度，那是
 *   **别的账号/区服的两池结构**，与本账号无关。手机 App 抓包里这两个端点一次都没出现，
 *   整个抓包也没有 `mobileSearch` / `pointProgressMax` 字段。更糟的是：一旦补拉返回
 *   非 0，`tasks.js` 的 `if (m.progress >= m.max) pcorm = true` 会把搜索切到从未验证过
 *   的移动 UA 路径（UA_MOBILE + `_Rwho=u=m`），重复计同一个池甚至触发风控。
 *   ⇒ 本模块**不再发任何网络请求**，只做纯解析 + 按账户内存缓存。
 *
 * 【缓存用途】`rewards.getReadPro()` 本来就会请求 dapi/me（拿阅读进度），顺手把搜索卡
 *   解析结果存进 WeakMap；`getRewardsInfo()` 在 earn 页 pc 节点**解析失败**（字段缺失）
 *   时用它兜底。明确给 0（封顶）不会用缓存覆盖，避免破坏保活判定。
 */
"use strict";

/** 缓存有效期：只用于同一轮任务内的跨接口兜底，进程退出即消失 */
const OK_TTL_MS = 5 * 60 * 1000;

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function dayNum(nowMs) {
  const d = new Date(nowMs);
  return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`);
}

/**
 * 从 dapi/me 响应里解析搜索任务卡（纯函数，不碰网络）。
 *
 * 兼容：type="search" / name 或 offerid 含 search；max|originalmax|originalMax；
 *       progress|pointprogress；数字或数字字符串；多张卡逐项累加。
 * 排除：抽奖类 instantwinsearch / sweep（它们的 name 也含 search，但不是搜索额度）。
 * 脏上限（非数字）直接丢弃，避免被当成「明确给 0」误触发封顶保活。
 *
 * @returns {{ok:boolean, max:number, progress:number, source:string,
 *            pc:{max:number,progress:number}, mobile:{max:number,progress:number},
 *            hasMobileCard:boolean, unifiedPool:boolean, cardNames:string[], reason?:string}}
 */
function parseSearchCards(payload) {
  const fail = {
    ok: false, max: 0, progress: 0, source: "dapi/me",
    pc: { max: 0, progress: 0 }, mobile: { max: 0, progress: 0 },
    hasMobileCard: false, unifiedPool: true, cardNames: [], reason: "no-search-card",
  };
  if (!payload || typeof payload !== "object") return { ...fail, reason: "not-json" };
  const root = payload.response && typeof payload.response === "object" ? payload.response : payload;
  const promos = Array.isArray(root.promotions) ? root.promotions : [];
  if (!promos.length) return { ...fail, reason: "no-promotions" };

  const cards = [];
  for (const p of promos) {
    if (!p || typeof p !== "object" || !p.attributes || typeof p.attributes !== "object") continue;
    const a = p.attributes;
    const name = String(p.name == null ? "" : p.name);
    const offerid = String(a.offerid == null ? "" : a.offerid);
    const type = String(a.type == null ? "" : a.type);
    const tag = `${name} ${offerid}`;
    const isSearch = type === "search" || /(^|_)search(_|$)|SearchPC/i.test(name) || /search/i.test(offerid);
    if (!isSearch) continue;
    // 抽奖/活动统计卡不是每日搜索额度
    if (/sweep|instantwin|lottery/i.test(tag)) continue;

    const maxRaw = a.max !== undefined ? a.max
      : a.originalmax !== undefined ? a.originalmax
        : a.originalMax;
    if (maxRaw === undefined) continue;
    const maxNum = Number(maxRaw);
    if (!Number.isFinite(maxNum)) continue; // 脏上限丢弃
    const progressRaw = a.progress !== undefined ? a.progress : a.pointprogress;
    const max = Math.max(0, maxNum);
    const progress = Math.min(max, Math.max(0, num(progressRaw, 0)));
    const isMobile = /mobile/i.test(tag);
    cards.push({ name, offerid, max, progress, isMobile });
  }
  if (!cards.length) return { ...fail, reason: "no-valid-search-card" };

  const sum = (arr) => ({
    max: arr.reduce((s, c) => s + c.max, 0),
    progress: arr.reduce((s, c) => s + c.progress, 0),
  });
  const mobiles = cards.filter((c) => c.isMobile);
  const desktops = cards.filter((c) => !c.isMobile);
  // 只有 PC 卡时，整包就是统一池；真有独立移动卡时才拆成两个池
  const pc = sum(desktops.length ? desktops : cards);
  const mobile = sum(mobiles);
  return {
    ok: true,
    max: pc.max,
    progress: pc.progress,
    source: "dapi/me",
    pc,
    mobile,
    hasMobileCard: mobiles.length > 0,
    unifiedPool: mobiles.length === 0,
    cardNames: cards.map((c) => c.name),
  };
}

/** 是否存在独立的移动端搜索卡（有的话才允许 tasks.js 走移动 UA 路径） */
function hasSeparateMobilePool(payload) {
  return parseSearchCards(payload).hasMobileCard === true;
}

/** 按账户缓存：key 用 ctx.state 对象本身，天然不串号、不落盘 */
const cache = new WeakMap();

function noteSearchQuota(ctx, value, now = Date.now()) {
  const key = ctx && ctx.state ? ctx.state : null;
  if (!key || !value || value.ok !== true) return false;
  cache.set(key, { date: dayNum(now), at: now, value });
  return true;
}

function readSearchQuota(ctx, now = Date.now()) {
  const key = ctx && ctx.state ? ctx.state : null;
  const hit = key ? cache.get(key) : null;
  if (!hit) return null;
  if (hit.date !== dayNum(now) || now - hit.at > OK_TTL_MS) return null;
  return hit.value;
}

/** 仅供离线回归：窥探缓存 */
function _cacheGet(state) { return cache.get(state) || null; }

module.exports = {
  OK_TTL_MS,
  num,
  dayNum,
  parseSearchCards,
  hasSeparateMobilePool,
  noteSearchQuota,
  readSearchQuota,
  _cacheGet,
};
