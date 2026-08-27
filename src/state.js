const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");

const DEFAULT_STATE = {
  cookies: [],        // 浏览器会话 Cookie（含 domain / name / value / expires 等）
  refreshToken: "",
  accessToken: "",
  accessTokenAt: 0,   // access token 获取时间戳
  tasksDone: { sign: 0, read: 0, promos: 0, search: 0 }, // 完成任务时的日期数字 20260821
  signPoint: -1,
  readPoint: 0,
  readArticles: { done: 0, total: 0 }, // 阅读篇数进度（每篇 3 分，满额 30 分 = 10 篇）
  promosPoint: 0,
  pc: { progress: 0, max: 0 },  // PC 搜索进度
  m: { progress: 0, max: 0 },   // 移动搜索进度
  todayPoints: 0,
  todayPointsServer: 0, // 服务器返回的今日已得积分（权威值，按 lastRunDate 判断是否当天）
  lastSearchProgress: -1,
  restrictedTimes: 0,
  lastRunDate: 0,
  lastResult: "",
  // ---- 自动循环调度用 ----
  dayCompleteDate: 0,  // 「当天全部任务已完成」时的日期数字，用于退出当日循环
  autoRounds: 0,       // 当天已自动运行的轮数
  autoRoundsDate: 0,   // autoRounds 对应的日期，跨天归零
  lastAutoRunAt: 0,    // 上次自动运行的时间戳（毫秒），用于计算间隔
};

function getDateNum() {
  const d = new Date();
  return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`);
}

function getDateHyphen() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 判断某个 cookie 是否适用于某 hostname
function cookieApplies(c, hostname) {
  let d = String(c.domain || "").toLowerCase();
  if (d.startsWith(".")) d = d.slice(1);
  hostname = hostname.toLowerCase();
  if (!d || !hostname) return false;
  if (c.expires && c.expires !== -1 && c.expires * 1000 < Date.now()) return false;
  return hostname === d || hostname.endsWith("." + d);
}

/**
 * 创建绑定到指定目录的状态实例（每个账户独立一份 state.json）
 * @param {string} dir 账户目录
 */
function createState(dir) {
  const STATE_FILE = path.join(dir, "state.json");
  let cache = null;

  function ensure() {
    if (!fs.existsSync(STATE_FILE)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(DEFAULT_STATE, null, 2), "utf-8");
    }
  }

  function load() {
    ensure();
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      cache = { ...JSON.parse(JSON.stringify(DEFAULT_STATE)), ...raw };
      cache.cookies = Array.isArray(raw.cookies) ? raw.cookies : [];
      cache.tasksDone = { ...DEFAULT_STATE.tasksDone, ...(raw.tasksDone || {}) };
    } catch {
      cache = JSON.parse(JSON.stringify(DEFAULT_STATE));
    }
    return cache;
  }

  function get() {
    return cache || load();
  }

  function save() {
    if (!cache) load();
    fs.writeFileSync(STATE_FILE, JSON.stringify(cache, null, 2), "utf-8");
  }

  function buildCookieHeader(hostname, excludes = ["_EDGE_S", "_Rwho", "_RwBf"]) {
    const cookies = (get().cookies || [])
      .filter((c) => cookieApplies(c, hostname) && !excludes.includes(c.name))
      .map((c) => `${c.name}=${c.value}`);
    return cookies.join("; ");
  }

  function setCookies(cookies) {
    load();
    cache.cookies = cookies || [];
    save();
  }

  function getCookies() {
    return get().cookies || [];
  }

  function setTokens(refreshToken, accessToken) {
    load();
    cache.refreshToken = refreshToken || "";
    cache.accessToken = accessToken || "";
    cache.accessTokenAt = Date.now();
    save();
  }

  function getRefreshToken() {
    return get().refreshToken || "";
  }

  function getAccessToken() {
    return get().accessToken || "";
  }

  function setTaskDone(task, dateNum) {
    load();
    cache.tasksDone[task] = dateNum;
    save();
  }

  function isTaskDoneToday(task) {
    return get().tasksDone[task] === getDateNum();
  }

  /**
   * 跨天重置每日累计字段
   *
   * signPoint / readPoint / promosPoint 在任务里都是单调递增写入
   * （promosPoint 用 Math.max 累计已完成活动总分），若不按天清零，
   * 第二天会把昨天的分数继续累加进「今日合计」，导致数值虚高。
   *
   * @returns {boolean} 是否发生了重置
   */
  function resetIfNewDay() {
    const g = get();
    const today = getDateNum();
    if (!g.lastRunDate || g.lastRunDate === today) return false;
    g.signPoint = -1;
    g.readPoint = 0;
    g.readArticles = { done: 0, total: 0 };
    g.promosPoint = 0;
    g.todayPoints = 0;
    g.todayPointsServer = 0;
    g.lastSearchProgress = -1;
    g.restrictedTimes = 0;
    g.pc = { progress: 0, max: 0 };
    g.m = { progress: 0, max: 0 };
    // 自动循环相关也一并归零，否则昨天的「已完成」会挡住今天的循环
    g.dayCompleteDate = 0;
    g.autoRounds = 0;
    g.autoRoundsDate = 0;
    save();
    return true;
  }

  /**
   * 判断当天任务是否全部完成（只统计配置里启用的任务）
   *
   * 这是自动循环的退出条件：所有启用的任务都在 tasksDone 里标记为今天，
   * 就认为今日无事可做，标记 dayCompleteDate 后当天不再触发。
   *
   * @param {object} cfg 该账户的配置对象
   * @returns {{done: boolean, pending: string[], enabled: string[]}}
   */
  function evaluateDayDone(cfg) {
    const today = getDateNum();
    const g = get();
    const t = (cfg && cfg.tasks) || {};
    const names = { sign: "签入", read: "阅读", promos: "活动", search: "搜索" };
    const enabled = [];
    const pending = [];
    for (const key of ["sign", "read", "promos", "search"]) {
      if (!t[key]) continue;
      enabled.push(key);
      if ((g.tasksDone || {})[key] !== today) pending.push(names[key]);
    }
    // 没有启用任何任务时不算「完成」，否则会静默什么都不做
    const done = enabled.length > 0 && pending.length === 0;
    return { done, pending, enabled };
  }

  /** 标记当天任务已全部完成（幂等） */
  function markDayComplete() {
    const g = get();
    const today = getDateNum();
    if (g.dayCompleteDate === today) return false;
    g.dayCompleteDate = today;
    save();
    return true;
  }

  /** 当天是否已标记完成 */
  function isDayComplete() {
    return get().dayCompleteDate === getDateNum();
  }

  /** 记录一次自动运行（返回当天累计轮数） */
  function bumpAutoRound() {
    const g = get();
    const today = getDateNum();
    if (g.autoRoundsDate !== today) {
      g.autoRoundsDate = today;
      g.autoRounds = 0;
    }
    g.autoRounds = (g.autoRounds || 0) + 1;
    g.lastAutoRunAt = Date.now();
    save();
    return g.autoRounds;
  }

  /** 当天已自动运行的轮数 */
  function getAutoRounds() {
    const g = get();
    return g.autoRoundsDate === getDateNum() ? g.autoRounds || 0 : 0;
  }

  return {
    load,
    get,
    save,
    buildCookieHeader,
    setCookies,
    getCookies,
    setTokens,
    getRefreshToken,
    getAccessToken,
    setTaskDone,
    isTaskDoneToday,
    resetIfNewDay,
    evaluateDayDone,
    markDayComplete,
    isDayComplete,
    bumpAutoRound,
    getAutoRounds,
    getDateNum,
    getDateHyphen,
    getStateFile: () => STATE_FILE,
  };
}

module.exports = { createState, DEFAULT_STATE, getDateNum, getDateHyphen };
