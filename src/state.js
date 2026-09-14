const path = require("path");
const fs = require("fs");
const sp = require("./storage-path");
const vault = require("./vault");
const logger = require("./logger");

// 存储根（打包环境指向 userData/storage，见 storage-path.js）
const ROOT = sp.storageRoot;

/**
 * 需要收进保险库的敏感字段。
 *
 * 这些字段在内存里仍是普通字段（上层 tasks/rewards/auth 无感），
 * 但写盘时会被抽出来加密成单个 secrets 密文块，磁盘上不再出现明文。
 */
const SECRET_FIELDS = ["cookies", "refreshToken", "accessToken", "accessTokenAt"];

function pickSecrets(cache) {
  const out = {};
  for (const k of SECRET_FIELDS) if (cache[k] !== undefined) out[k] = cache[k];
  return out;
}

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
  searchPoint: 0,              // 搜索任务今日累计得分
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
      applySecrets(raw);
    } catch {
      cache = JSON.parse(JSON.stringify(DEFAULT_STATE));
    }
    return cache;
  }

  /**
   * 把密文块解回内存字段，让上层（tasks/rewards/auth/describe）无感读取。
   *
   * 只有保险库已配置且已解锁时才解得出内容；锁定时这些字段保持为空，
   * 界面显示"未登录/待解锁"，不会把密文当明文用。
   *
   * 解密失败（密文损坏或主密钥不匹配）时置 __secretsCorrupt，
   * save() 据此拒绝覆盖原密文，避免把还能救的数据冲掉。
   */
  function applySecrets(raw) {
    cache.__secretsCorrupt = false;
    if (!raw.secrets) return;
    if (!vault.isUnlocked()) return;
    try {
      const s = vault.decryptJSON(raw.secrets) || {};
      cache.cookies = Array.isArray(s.cookies) ? s.cookies : [];
      cache.refreshToken = s.refreshToken || "";
      cache.accessToken = s.accessToken || "";
      cache.accessTokenAt = Number(s.accessTokenAt) || 0;
    } catch (e) {
      cache.__secretsCorrupt = true;
      cache.cookies = [];
      cache.refreshToken = "";
      cache.accessToken = "";
      cache.accessTokenAt = 0;
      logger.warn(`解密账户登录态失败，已保留原密文: ${e.message}`);
    }
  }

  function get() {
    return cache || load();
  }

  /**
   * 写盘：敏感字段抽出来加密，其余字段照常明文。
   *
   * 三种情况：
   *   未配置保险库 -> 沿用旧版明文存储（未启用加密时行为不变）
   *   已解锁       -> 重新加密写入 secrets，磁盘不留明文
   *   已锁定/损坏  -> 保留磁盘上原有密文，绝不写成空值（防止丢数据）
   */
  function save() {
    if (!cache) load();
    const out = { ...cache };
    delete out.__secretsCorrupt;
    for (const k of SECRET_FIELDS) delete out[k];

    if (!vault.isConfigured()) {
      for (const k of SECRET_FIELDS) if (cache[k] !== undefined) out[k] = cache[k];
      delete out.secrets;
    } else if (vault.isUnlocked() && !cache.__secretsCorrupt) {
      out.secrets = vault.encryptJSON(pickSecrets(cache));
    } else {
      out.secrets = cache.secrets || "";
    }

    fs.writeFileSync(STATE_FILE, JSON.stringify(out, null, 2), "utf-8");
  }

  function buildCookieHeader(hostname, excludes = ["_EDGE_S", "_Rwho", "_RwBf"]) {
    const cookies = (get().cookies || [])
      .filter((c) => cookieApplies(c, hostname) && !excludes.includes(c.name))
      .map((c) => `${c.name}=${c.value}`);
    return cookies.join("; ");
  }

  /**
   * 锁定状态下禁止覆写登录态。
   *
   * 解锁前 Cookie 解不出来（内存里是空数组），此时若让 syncCookies 之类的流程
   * 把"当前未登录"的结果写回去，会直接把用户的会话冲掉。宁可不动，也不能丢。
   */
  function canPersistSecrets() {
    if (!vault.isConfigured()) return true;
    if (vault.isUnlocked()) return true;
    logger.error("保险库已锁定，拒绝覆写登录态（原密文保持不变）");
    return false;
  }

  function setCookies(cookies) {
    load();
    if (!canPersistSecrets()) return;
    cache.cookies = cookies || [];
    save();
  }

  function getCookies() {
    return get().cookies || [];
  }

  function setTokens(refreshToken, accessToken) {
    load();
    if (!canPersistSecrets()) return;
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
    // 本地任务完成标记：跨天清零。
    // 原本依赖 === getDateNum() 比较也能正确判「未完成」，但遗留的旧日期
    // 会让 describe() 看起来脏，也和 GUI 「跨天自动归零」的提示对不上。
    g.tasksDone = { sign: 0, read: 0, promos: 0, search: 0 };
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
