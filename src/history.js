/**
 * 每日运行历史 + 签到勋章（每账户一份 history.json）
 *
 * 与 state.json 的分工：
 *   state.json 只存「此刻」的任务进度，跨天即被 resetIfNewDay 清零；
 *   history.json 存「每一天」的结局，是日历与勋章的唯一数据源。
 *
 * 每日状态四档（用户 2026-09-30 确认口径）：
 *   done    全部启用的任务都完成 —— 只有这一档算「签到」
 *   partial 完成了一部分
 *   idle    当天未运行
 *   error   运行出错，无进度
 *
 * 同日多次运行的合并规则：按「好状态优先」覆盖（done > partial > idle > error），
 * 积分取最大值。这样先报错后跑通的那天不会被记成失败。
 */

const fs = require("fs");
const path = require("path");
const badgesMod = require("./badges");
const lunar = require("./lunar");
const holiday = require("./holiday");

const { STATUS, STREAK_BADGES, PERFECT_BADGE, festivalOn, pad2 } = badgesMod;

// ---- 农历日名 + 节日短名（供日历小字展示）----
const LUNAR_DAYS = [
  "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
  "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
  "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十",
];
const LUNAR_MONTHS = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊"];

/** 农历日名：初一是该农历月起点，显示月份名（如「八月」），其余显示日名（如「十五」） */
function lunarDayLabel(key) {
  const s = String(key || "").slice(0, 10);
  const y = Number(s.slice(0, 4));
  if (!y || y < 1900 || y > 2100) return "";
  const info = lunar.solarToLunar(s);
  if (!info) return "";
  if (info.day === 1) return `${LUNAR_MONTHS[info.month - 1] || ""}月`;
  return LUNAR_DAYS[info.day - 1] || "";
}

/** 节日短名：去掉尾部「节」让日历小字更紧凑（春节/元旦/除夕这类本就不带的不动） */
function shortDayName(name) {
  const s = String(name || "").trim();
  return s.length > 2 ? s.replace(/节$/, "") : s;
}

/** 状态优先级：数字越大越好，只有更好的状态才能覆盖当天的旧记录 */
const STATUS_RANK = {
  [STATUS.DONE]: 4,
  [STATUS.PARTIAL]: 3,
  [STATUS.IDLE]: 2,
  [STATUS.ERROR]: 1,
};

const FILE_VERSION = 1;
/** 只保留最近这些年的日记录，防止文件无限增长 */
const KEEP_YEARS = 5;

const pad4 = (n) => String(n).padStart(4, "0");
const dayKey = (y, m, d) => `${pad4(y)}-${pad2(m)}-${pad2(d)}`;

function keyOfDate(dt) {
  return dayKey(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

function todayKey() {
  return keyOfDate(new Date());
}

/** YYYYMMDD 数字 → YYYY-MM-DD */
function numToKey(n) {
  const s = String(n || "");
  if (s.length !== 8) return todayKey();
  return dayKey(Number(s.slice(0, 4)), Number(s.slice(4, 6)), Number(s.slice(6, 8)));
}

/** YYYY-MM-DD → YYYYMMDD 数字 */
function keyToNum(k) {
  return Number(String(k).replace(/-/g, ""));
}

const EMPTY = () => ({ version: FILE_VERSION, days: {}, badges: {}, meta: {} });

/**
 * 连续完成天数（纯函数，便于 selfcheck 直接断言）。
 * 今天还没跑完不算断 —— 从昨天往前数；今天已完成则从今天往前数。
 */
function computeStreak(days, from) {
  const start = new Date(`${from}T00:00:00`);
  if (Number.isNaN(start.getTime())) return 0;
  const rec0 = days[from];
  if (!rec0 || rec0.status !== STATUS.DONE) start.setDate(start.getDate() - 1);

  let n = 0;
  const cur = start;
  // 上限 3650 天，防止脏数据导致死循环
  for (let i = 0; i < 3650; i++) {
    const rec = days[keyOfDate(cur)];
    if (rec && rec.status === STATUS.DONE) {
      n += 1;
      cur.setDate(cur.getDate() - 1);
    } else {
      break;
    }
  }
  return n;
}

/** 整月是否每一天都完成（未来日期没记录 → 不算全勤） */
function isMonthPerfect(days, y, m) {
  const total = new Date(y, m, 0).getDate();
  for (let d = 1; d <= total; d++) {
    const rec = days[dayKey(y, m, d)];
    if (!rec || rec.status !== STATUS.DONE) return false;
  }
  return true;
}

/**
 * 创建绑定到指定账户目录的历史实例
 * @param {string} dir 账户目录
 */
function createHistory(dir) {
  const FILE = path.join(dir, "history.json");
  let cache = null;

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, "utf-8"));
      cache = {
        version: FILE_VERSION,
        days: raw.days && typeof raw.days === "object" ? raw.days : {},
        badges: raw.badges && typeof raw.badges === "object" ? raw.badges : {},
        meta: raw.meta && typeof raw.meta === "object" ? raw.meta : {},
      };
    } catch {
      cache = EMPTY();
    }
    return cache;
  }

  function get() {
    return cache || load();
  }

  function save() {
    if (!cache) load();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2), "utf-8");
  }

  /**
   * 记录某一天的结局，并结算勋章
   *
   * @param {string|number} day YYYY-MM-DD 或 YYYYMMDD，缺省为今天
   * @param {object} info
   * @param {string} info.status   done/partial/idle/error
   * @param {number} [info.done]   已完成任务数
   * @param {number} [info.total]  启用任务总数
   * @param {number} [info.points] 当日积分
   * @returns {{ day: string, status: string, streak: number, awarded: object[] }}
   */
  function record(day, info = {}) {
    const g = get();
    const key = day == null ? todayKey() : typeof day === "number" ? numToKey(day) : String(day).slice(0, 10);
    const status = STATUS_RANK[info.status] ? info.status : STATUS.IDLE;

    const prev = g.days[key];
    const better = !prev || (STATUS_RANK[status] || 0) > (STATUS_RANK[prev.status] || 0);

    const rec = {
      status: better ? status : prev.status,
      done: Math.max(Number(info.done) || 0, prev ? Number(prev.done) || 0 : 0),
      total: Math.max(Number(info.total) || 0, prev ? Number(prev.total) || 0 : 0),
      points: Math.max(Number(info.points) || 0, prev ? Number(prev.points) || 0 : 0),
      at: Date.now(),
    };
    g.days[key] = rec;

    if (!g.meta.first) g.meta.first = key;

    // ---- 结算勋章 ----
    // 基准是「被记录的那一天」而不是今天：跨天补记（任务跑过零点）、
    // 月末最后一天延迟落盘时，才不会把连续天数算成 0。
    const awarded = [];
    const streak = computeStreak(g.days, key);

    // 1) 连续签到：只认「完整完成」
    let cur = Number(g.meta.awardedStreak) || 0;
    // 已授予档位高于当前 streak ⇒ 连续段断了重来（例如 10 天断掉后重新连到 3 天）。
    // 这里必须重置，否则同一档位一辈子只发一次，「获得次数」永远停在 1。
    if (streak < cur) cur = 0;
    if (streak > (Number(g.meta.bestStreak) || 0)) g.meta.bestStreak = streak;
    if (status === STATUS.DONE) {
      for (const b of STREAK_BADGES) {
        if (b.days > cur && streak >= b.days) {
          award(g, b.id, key);
          awarded.push(b.id);
          cur = b.days;
        }
      }
      g.meta.awardedStreak = cur;
    }

    // 2) 节日：当天完成且是节日
    if (status === STATUS.DONE) {
      const f = festivalOn(key);
      if (f) {
        // 同一节日同一天只给一次
        const rec0 = g.badges[f.id];
        if (!rec0 || rec0.last !== key) {
          award(g, f.id, key);
          awarded.push(f.id);
        }
      }
    }

    // 3) 月全勤：整月每一天都是 done 才授予，同月只给一次
    const [yy, mm] = key.split("-").map(Number);
    if (isMonthPerfect(g.days, yy, mm)) {
      const mk = `${pad4(yy)}-${pad2(mm)}`;
      const rec0 = g.badges[PERFECT_BADGE.id];
      if (!rec0 || rec0.month !== mk) {
        award(g, PERFECT_BADGE.id, key);
        g.badges[PERFECT_BADGE.id].month = mk;
        awarded.push(PERFECT_BADGE.id);
      }
    }

    prune(g);
    save();
    return { day: key, status: rec.status, streak, awarded };
  }

  /** 授予一枚勋章（计数 +1，记录最近获得日期） */
  function award(g, id, key) {
    const b = g.badges[id] || { count: 0, last: "" };
    b.count = (Number(b.count) || 0) + 1;
    b.last = key;
    g.badges[id] = b;
  }

  /** 清理超过 KEEP_YEARS 的旧记录 */
  function prune(g) {
    const keys = Object.keys(g.days);
    if (keys.length < 400) return;
    const cutoffY = new Date().getFullYear() - KEEP_YEARS;
    for (const k of keys) {
      if (Number(k.slice(0, 4)) < cutoffY) delete g.days[k];
    }
  }

  /**
   * 取某个月的日历数据
   * @param {number} year
   * @param {number} month 1-12
   */
  function getMonth(year, month) {
    const g = get();
    const y = Number(year);
    const m = Number(month);
    if (!y || !m || m < 1 || m > 12) return { year: 0, month: 0, days: [] };

    const total = new Date(y, m, 0).getDate();
    const days = [];
    for (let d = 1; d <= total; d++) {
      const key = dayKey(y, m, d);
      const rec = g.days[key];
      const wdIdx = new Date(y, m - 1, d).getDay();
      const weekend = wdIdx === 0 || wdIdx === 6;
      const fest = festivalOn(key);
      const holi = holiday.dayHoliday(key);
      const festName = fest ? shortDayName(fest.name) : "";
      const holiName = holi && holi.name ? shortDayName(holi.name) : "";
      const rest = !!(holi && holi.rest);
      const workday = !!(holi && !holi.rest);
      days.push({
        day: d,
        key,
        status: rec ? rec.status : STATUS.IDLE,
        done: rec ? Number(rec.done) || 0 : 0,
        total: rec ? Number(rec.total) || 0 : 0,
        points: rec ? Number(rec.points) || 0 : 0,
        hasRecord: !!rec,
        weekend,
        lunar: lunarDayLabel(key),
        festival: festName,
        holidayName: holiName,
        rest,
        workday,
        // 小字展示优先级：法定休 > 传统节日 > 农历
        label: rest ? holiName : festName || lunarDayLabel(key),
      });
    }
    return {
      year: y,
      month: m,
      days,
      perfect: isMonthPerfect(g.days, y, m),
      // 当月完成天数（用于「本月 X/Y 天」之类的展示）
      doneDays: days.filter((x) => x.status === STATUS.DONE).length,
    };
  }

  /** 当前连续签到天数 */
  function getStreak() {
    return computeStreak(get().days, todayKey());
  }

  /** 勋章与获得次数：{ id: { count, last } } */
  function getBadges() {
    return get().badges || {};
  }

  /** 汇总统计 */
  function getStats() {
    const g = get();
    const keys = Object.keys(g.days);
    let done = 0;
    let partial = 0;
    let error = 0;
    let points = 0;
    for (const k of keys) {
      const r = g.days[k];
      if (r.status === STATUS.DONE) done += 1;
      else if (r.status === STATUS.PARTIAL) partial += 1;
      else if (r.status === STATUS.ERROR) error += 1;
      points += Number(r.points) || 0;
    }
    return {
      first: g.meta.first || "",
      trackedDays: keys.length,
      doneDays: done,
      partialDays: partial,
      errorDays: error,
      totalPoints: points,
      streak: computeStreak(g.days, todayKey()),
      bestStreak: Number(g.meta.bestStreak) || 0,
      badgeCount: Object.keys(g.badges || {}).length,
      badgeTotal: Object.values(g.badges || {}).reduce((s, b) => s + (Number(b.count) || 0), 0),
    };
  }

  /** 有记录的年份列表（翻月时禁用没有数据的月份更快） */
  function getYears() {
    const g = get();
    const set = new Set();
    for (const k of Object.keys(g.days)) set.add(Number(k.slice(0, 4)));
    const y = new Date().getFullYear();
    set.add(y);
    return [...set].sort((a, b) => b - a);
  }

  /** 供 UI 直接消费的整包快照 */
  function snapshot(year, month) {
    const now = new Date();
    const y = Number(year) || now.getFullYear();
    const m = Number(month) || now.getMonth() + 1;
    return {
      month: getMonth(y, m),
      streak: getStreak(),
      badges: getBadges(),
      stats: getStats(),
      years: getYears(),
      today: todayKey(),
    };
  }

  return {
    load,
    get,
    save,
    record,
    getMonth,
    getStreak,
    getBadges,
    getStats,
    getYears,
    snapshot,
    getFile: () => FILE,
  };
}

module.exports = {
  createHistory,
  computeStreak,
  isMonthPerfect,
  lunarDayLabel,
  shortDayName,
  STATUS,
  STATUS_RANK,
  dayKey,
  keyOfDate,
  todayKey,
  numToKey,
  keyToNum,
  FILE_VERSION,
};
