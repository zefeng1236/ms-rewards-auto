/**
 * 每日任务额度归一化（2026-11-24，用户要求「动态获取每天需要阅读和搜索的次数」）。
 *
 * 【为什么要单独一个模块】微软会把当日上限压到很小：真机日志里 PC 搜索上限出现过
 * 60 / 30 / 15，`必应 Star 奖励` 这类独立月度计划（金牌会员每月 2,100 分）拿满后，
 * 当日活动甚至只剩「搜索 1/1」。旧代码有三处把动态值又写死回去：
 *   ① `max = readPro.max || 30` —— 服务器明确返回 0（今日无额度/已封顶）被当成 30 分；
 *   ② `if (cur >= max) { cur = 0; max = 30 }` —— 接口说满了，反而强制重跑 10 篇；
 *   ③ `pcMax = dashboard.pc.max > 0 ? ... : 15` —— max=0 回落 15 次。
 * 结果就是封顶之后还在白跑，既浪费也徒增风控特征。
 *
 * 【本模块的两条原则】
 *   1) **区分「服务器明确给了 0」和「字段缺失」**：前者是法定额度 0（capped），
 *      必须按 0 处理；后者才允许用兜底值，并在 source 里标明是 fallback。
 *   2) 服务器返回的是**积分额度**，用户要的是**次数**，统一按每次/每篇积分换算：
 *      `unitsRequired = ceil((max - progress) / pointsPerUnit)`。
 *
 * 【借鉴 MRS助手 26.11.23.1】对方 `SearchProgress.summarize()` 从
 * `userStatus.counters.pcSearch[]` 逐项累加 `pointProgressMax - pointProgress` 算缺口，
 * 并把 Edge 搜索单独拆出来。本模块的 `summarizeCounters()` 保留同样的入口，
 * 便于日后接入 counters 数组；当前仍以本项目 earn 页的 pointsCounters 为主。
 * 参考：C:\Users\19961\Desktop\MSR助手\MRS助手-26.11.23.1\dist\functions\activities\search\SearchProgress.js
 *
 * 【纯函数】不碰网络 / 磁盘 / 时钟，便于离线回归。
 */
"use strict";

/** 国区搜索每次 3 分（与 tasks.js 循环里的 progress +3 一致） */
const POINTS_PER_SEARCH = 3;
/** ENUS_readarticle3_30points：每篇 3 分 */
const POINTS_PER_ARTICLE = 3;
/** 解析失败时的保守兜底（仅 source=fallback 时用） */
const FALLBACK_SEARCH_MAX = 15;
const FALLBACK_READ_MAX = 30;
/**
 * 月度额度耗尽后的「每日保活」次数区间（含端点，2026-11-24 用户定：随机 10~20 次）。
 * 注意这是**行为次数**而不是积分次数：封顶后这些搜索/阅读都拿不到分，
 * 目的是维持账号日常活跃度，别让当月剩下十几天完全零行为。
 */
const KEEP_ALIVE_MIN = 10;
const KEEP_ALIVE_MAX = 20;

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** 服务器是否明确给了上限（0 也算「明确」） */
function hasExplicitMax(node) {
  if (!node || typeof node !== "object") return false;
  // rewards.normProgress 已经判过一次，优先信它的结论（避免把 emptyInfo 的 0 当成法定额度）
  if (node.explicitMax === false) return false;
  if (node.explicitMax === true) return true;
  return node.max !== undefined || node.pointProgressMax !== undefined || node.originalMax !== undefined;
}

/**
 * 归一化一个积分计数器 → 今日所需次数。
 * @param {{max?:number, progress?:number, pointProgressMax?:number,
 *          pointProgress?:number, originalMax?:number}|null} node
 * @param {{fallbackMax?:number, pointsPerUnit?:number}} [opts]
 */
function normalizeCounter(node, opts = {}) {
  const ppu = Number(opts.pointsPerUnit) > 0 ? Number(opts.pointsPerUnit) : POINTS_PER_SEARCH;
  const fallbackMax = Number.isFinite(Number(opts.fallbackMax)) ? Math.max(0, Number(opts.fallbackMax)) : 0;
  const explicit = hasExplicitMax(node);
  const originalMax = explicit ? Math.max(0, num(node && node.originalMax, 0)) : 0;

  let max;
  if (!explicit) {
    max = fallbackMax;
  } else if (node.max !== undefined) {
    max = num(node.max, 0);
  } else if (node.pointProgressMax !== undefined) {
    max = num(node.pointProgressMax, 0);
  } else {
    max = num(node.originalMax, 0);
  }
  max = Math.max(0, max);

  const rawProgress = node && (node.progress !== undefined ? node.progress : node.pointProgress);
  const progress = Math.min(max, Math.max(0, num(rawProgress, 0)));
  const remainingPoints = Math.max(0, max - progress);

  return {
    max,
    progress,
    remainingPoints,
    unitsRequired: Math.ceil(remainingPoints / ppu),
    explicit,
    /** 服务器明确把今日额度压成 0（月度计划封顶 / 今日无任务） */
    capped: explicit && max === 0,
    /** 服务器给了 originalMax 且当前 max 更小：额度被压缩过（如 60 → 1） */
    compressed: explicit && originalMax > 0 && max < originalMax,
    source: explicit ? "server" : "fallback",
  };
}

/**
 * 阅读额度：max/progress 都是积分，换算成篇数。
 * @param {object} attrs dapi/me 里 readarticle 节点的 attributes
 */
function normalizeReadQuota(attrs, opts = {}) {
  const ppa = Number(opts.pointsPerArticle) > 0 ? Number(opts.pointsPerArticle) : POINTS_PER_ARTICLE;
  const fallbackMax = Number.isFinite(Number(opts.fallbackMax)) ? Number(opts.fallbackMax) : FALLBACK_READ_MAX;
  const q = normalizeCounter(attrs, { fallbackMax, pointsPerUnit: ppa });
  return {
    maxPoints: q.max,
    progressPoints: q.progress,
    articlesTotal: Math.ceil(q.max / ppa),
    articlesLeft: q.unitsRequired,
    articlesDone: Math.floor(q.progress / ppa),
    explicit: q.explicit,
    capped: q.capped,
    compressed: q.compressed,
    source: q.source,
  };
}

/**
 * 借鉴 MRS助手：counters 数组逐项累加 pointProgressMax - pointProgress。
 * 当前 earn 页未必下发这个数组，故保留为可选输入（hasCounters=false 时不参与决策）。
 */
function summarizeCounters(counters, opts = {}) {
  const arr = Array.isArray(counters) ? counters : [];
  const ppu = Number(opts.pointsPerUnit) > 0 ? Number(opts.pointsPerUnit) : POINTS_PER_SEARCH;
  let max = 0;
  let earned = 0;
  for (const c of arr) {
    const m = Math.max(0, num(c && c.pointProgressMax, 0));
    const e = Math.min(m, Math.max(0, num(c && c.pointProgress, 0)));
    max += m;
    earned += e;
  }
  const remaining = Math.max(0, max - earned);
  return { max, earned, remaining, unitsRequired: Math.ceil(remaining / ppu), hasCounters: arr.length > 0 };
}

/**
 * 本轮计划次数：以服务器剩余次数为硬上界。
 * 用户设定 / 随机节奏都不允许超过「今天还需要的次数」——否则日志说 6 次、
 * 服务器只剩 1 次，多出来的 5 次只是空转。
 */
function planSearchUnits(pcQuota, mobileQuota, requested) {
  const remaining = Math.max(0, (pcQuota && pcQuota.unitsRequired) || 0) +
    Math.max(0, (mobileQuota && mobileQuota.unitsRequired) || 0);
  const want = Math.max(0, Math.floor(num(requested, 0)));
  const count = Math.min(want, remaining);
  return { count, remaining, truncated: want > remaining };
}

/**
 * 「本月额度已耗尽 / 当月无需执行计分任务」判定。
 *
 * 服务器至少明确给过一个上限（explicit=true），且所有上限之和为 0 —— 这正是
 * 必应 Star 月度计划拿满（2,100/2,100）后当日被压成 0/0 的形态。
 * 全是「字段缺失」时不算耗尽：那是解析失败，该走 fallback 而不是保活。
 *
 * @param {object|object[]} quotas normalizeCounter / normalizeReadQuota 的结果
 */
function isQuotaExhausted(quotas) {
  const arr = (Array.isArray(quotas) ? quotas : [quotas]).filter(Boolean);
  if (arr.length === 0) return false;
  const explicit = arr.some((q) => q && q.explicit === true);
  const totalMax = arr.reduce((s, q) => s + Math.max(0, num(q && q.max, 0)), 0);
  return explicit && totalMax === 0;
}

/**
 * 每日保活账本规划（纯函数，不碰时钟/磁盘/网络）。
 *
 * 语义（2026-11-24 用户要求）：额度耗尽后仍要「维持每日随机 10-20 次搜索和阅读」。
 *   - 同一天只掷一次随机数：目标写进 state，重跑/中断续跑不会每天变来变去；
 *   - 跨天自动重置并重新掷；
 *   - 搜索与阅读各自独立掷（两个 10~20 的随机数）；
 *   - left = target - done，跑满后由调用方 setTaskDone，保证一天只保活一轮，
 *     不会因为有额度上限 0 而被自动循环反复触发。
 *
 * @param {{date?:number,searchTarget?:number,readTarget?:number,searchDone?:number,readDone?:number}|null} ledger
 * @param {number} dateNum YYYYMMDD
 * @param {() => number} [rng] 返回 [0,1)，测试可注入固定序列
 * @param {{min?:number,max?:number}} [opts] 仅测试/调参用，默认 10~20
 */
function planKeepAlive(ledger, dateNum, rng = Math.random, opts = {}) {
  const min = Math.max(1, Math.floor(num(opts.min, KEEP_ALIVE_MIN)));
  const max = Math.max(min, Math.floor(num(opts.max, KEEP_ALIVE_MAX)));
  const day = Math.floor(num(dateNum, 0));
  const sameDay = Boolean(ledger) && day > 0 && Math.floor(num(ledger.date, 0)) === day;
  const roll = () => {
    const raw = Number(rng());
    const r = Number.isFinite(raw) ? Math.max(0, Math.min(0.999999, raw)) : 0.5;
    return min + Math.floor(r * (max - min + 1));
  };
  const keptTarget = (v) => {
    const n = Math.floor(num(v, 0));
    return n >= min && n <= max ? n : 0;
  };
  // 旧账本里合法的目标当天沿用；脏值/跨天重新掷。
  // 目标一旦重掷，旧的 done 必须一起归零：否则 99 会被钳到新目标 10 上，
  // 账本看起来「今天已保活满」，实际一次都没跑（离线回归 ② 实测踩到）。
  const keptSearch = sameDay ? keptTarget(ledger.searchTarget) : 0;
  const keptRead = sameDay ? keptTarget(ledger.readTarget) : 0;
  const searchTarget = keptSearch || roll();
  const readTarget = keptRead || roll();
  const clampDone = (v, target) => Math.min(target, Math.max(0, Math.floor(num(v, 0))));
  const searchDone = keptSearch ? clampDone(ledger.searchDone, searchTarget) : 0;
  const readDone = keptRead ? clampDone(ledger.readDone, readTarget) : 0;
  return {
    date: day,
    searchTarget,
    readTarget,
    searchDone,
    readDone,
    searchLeft: Math.max(0, searchTarget - searchDone),
    readLeft: Math.max(0, readTarget - readDone),
    isNewDay: !sameDay,
  };
}

module.exports = {
  POINTS_PER_SEARCH,
  POINTS_PER_ARTICLE,
  FALLBACK_SEARCH_MAX,
  FALLBACK_READ_MAX,
  KEEP_ALIVE_MIN,
  KEEP_ALIVE_MAX,
  hasExplicitMax,
  normalizeCounter,
  normalizeReadQuota,
  summarizeCounters,
  planSearchUnits,
  isQuotaExhausted,
  planKeepAlive,
};
