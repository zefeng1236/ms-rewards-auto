/**
 * 中国法定节假日 + 调休安排（自动从网络获取，磁盘缓存）
 *
 * 需求（用户 2026-09-30）：日历每天要标出法定休假日（蓝「休」角标）与
 * 调休上班日（橙「班」角标），例如 2026 中秋 9/25-9/27 放三天。
 *
 * 数据源（双源，一个挂了自动退另一个）：
 *   1. 主源 NateScarlet/holiday-cn —— 国务院放假安排的结构化数据，
 *      格式 { year, days: [{ name, date, isOffDay }] }；
 *      isOffDay:true  = 法定放假（休），isOffDay:false = 调休上班（班）。
 *   2. 备源 timor.tech/api/holiday —— { holiday: { "MM-DD": { holiday, name, date } } }。
 *
 * 为什么放磁盘而不是只内存：
 *   服务器/Docker 直连 GitHub 不可达时会降级；磁盘缓存保证「拉过一次
 *   之后断网也能用」，TTL 15 天到期后尝试刷新，失败则继续沿用旧缓存。
 */

const fs = require("fs");
const path = require("path");
const sp = require("./storage-path");

/** 缓存多久后尝试刷新（15 天） */
const CACHE_TTL_MS = 15 * 86400000;
/** 单源请求超时（毫秒） */
const FETCH_TIMEOUT_MS = 8000;

/** year -> { fetchedAt, days: { "YYYY-MM-DD": { name, rest } } } */
const memCache = new Map();
/** 正在刷新中的年份，防止并发重复请求 */
const pending = new Set();

function cacheFile(year) {
  return sp.resolve("holidays", `${year}.json`);
}

/** 把 holiday-cn 的 days 数组 / timor 的 map 归一化成 { date: {name, rest} } */
function normalizeDays(list) {
  const out = {};
  if (Array.isArray(list)) {
    for (const d of list) {
      if (!d || !d.date) continue;
      out[String(d.date).slice(0, 10)] = {
        name: String(d.name || "").trim(),
        rest: d.isOffDay === true,
      };
    }
  } else if (list && typeof list === "object") {
    // timor 格式：key "MM-DD" → { holiday, name, date }
    for (const k of Object.keys(list)) {
      const v = list[k];
      if (!v || !v.date) continue;
      out[String(v.date).slice(0, 10)] = {
        name: String(v.name || "").trim(),
        rest: v.holiday === true,
      };
    }
  }
  return out;
}

async function fetchHolidayCn(year, signal) {
  const url = `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`holiday-cn HTTP ${res.status}`);
  const j = await res.json();
  if (!j || !Array.isArray(j.days)) throw new Error("holiday-cn 结构不符");
  return normalizeDays(j.days);
}

async function fetchTimor(year, signal) {
  const url = `https://timor.tech/api/holiday/year/${year}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`timor HTTP ${res.status}`);
  const j = await res.json();
  if (!j || j.code !== 0 || !j.holiday) throw new Error("timor 未命中节假日");
  return normalizeDays(j.holiday);
}

async function fetchYear(year) {
  for (const fn of [fetchHolidayCn, fetchTimor]) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const days = await fn(year, ctrl.signal);
      clearTimeout(timer);
      return { fetchedAt: Date.now(), days };
    } catch {
      clearTimeout(timer);
      // 换个源再试
    }
  }
  throw new Error(`festival ${year} 双源均失败`);
}

/** 读磁盘缓存（不存在/损坏返回 null） */
function readDisk(year) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(year), "utf-8"));
    if (raw && raw.days && typeof raw.days === "object") return raw;
  } catch {
    /* 忽略 */
  }
  return null;
}

/** 缓存是否新鲜（未过期） */
function isFresh(year) {
  const c = memCache.get(year) || readDisk(year);
  if (!c || !c.fetchedAt) return false;
  return Date.now() - c.fetchedAt < CACHE_TTL_MS;
}

/**
 * 后台刷新某年（网络）。只增不减：失败保留旧缓存，静默降级。
 * @returns {Promise<void>}
 */
async function refreshYear(year) {
  if (pending.has(year)) return;
  if (isFresh(year)) return;
  pending.add(year);
  try {
    const data = await fetchYear(year);
    memCache.set(year, data);
    try {
      fs.mkdirSync(path.dirname(cacheFile(year)), { recursive: true });
      fs.writeFileSync(cacheFile(year), JSON.stringify(data, null, 2), "utf-8");
    } catch {
      /* 磁盘写失败不致命，内存缓存仍在 */
    }
  } catch {
    /* 网络失败：沿用旧缓存 / 空，静默降级 */
  } finally {
    pending.delete(year);
  }
}

/**
 * 同步查某天的节假日/调休信息（供 history.getMonth 同步调用）。
 * 内存 → 磁盘；都没有则原地触发一次后台刷新（不阻塞返回 null）。
 * @param {string} key YYYY-MM-DD
 * @returns {{name:string, rest:boolean}|null} rest=true 休，rest=false 班
 */
function dayHoliday(key) {
  const year = Number(String(key || "").slice(0, 4));
  if (!year) return null;
  let c = memCache.get(year);
  if (!c) {
    c = readDisk(year);
    if (c) memCache.set(year, c);
  }
  if (!c) {
    refreshYear(year); // 后台补，本次先返回 null
    return null;
  }
  return c.days[String(key).slice(0, 10)] || null;
}

/** 启动预热：拉今年 + 明年（不阻塞） */
function warmup() {
  const y = new Date().getFullYear();
  refreshYear(y);
  refreshYear(y + 1);
}

module.exports = {
  dayHoliday,
  refreshYear,
  isFresh,
  warmup,
  fetchYear,
  normalizeDays,
  cacheFile,
  CACHE_TTL_MS,
};