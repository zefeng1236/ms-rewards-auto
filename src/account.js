const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { createConfig, DEFAULTS } = require("./config");
const { createState } = require("./state");
const { hasAuthCookies } = require("./browser");
const sp = require("./storage-path");

const ACCOUNTS_DIR = sp.accountsDir;
const INDEX_FILE = path.join(ACCOUNTS_DIR, "index.json");

function ensureDirs() {
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  if (!fs.existsSync(INDEX_FILE)) {
    fs.writeFileSync(INDEX_FILE, "[]", "utf-8");
  }
}

function readIndex() {
  ensureDirs();
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeIndex(list) {
  ensureDirs();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(list, null, 2), "utf-8");
}

/** 账户列表（含元信息） */
function list() {
  return readIndex().map((a) => ({ ...a }));
}

/** 根据 id 获取账户元信息 */
function get(id) {
  return readIndex().find((a) => a.id === id) || null;
}

/** 创建账户（独立目录 + 独立配置/状态/浏览器 profile） */
function create(name = "") {
  ensureDirs();
  const id = crypto.randomUUID();
  const meta = {
    id,
    name: String(name || "").trim() || `账户${readIndex().length + 1}`,
    createdAt: Date.now(),
    enabled: true,
  };
  const dir = path.join(ACCOUNTS_DIR, id);
  // 不再创建 profile/ 目录：浏览器改为「临时目录 + 注入 Cookie」，
  // 登录态唯一的落地副本是 state.json 里的密文（见 browser.js 说明）。
  fs.mkdirSync(dir, { recursive: true });
  // 生成独立的 config.json / state.json
  // 新账户默认遵循全局设置（只写 useGlobal 标志，不快照当前全局值）
  const config = createConfig(dir);
  config.setUseGlobal(true);
  const state = createState(dir);
  state.load();
  const list = readIndex();
  list.push(meta);
  writeIndex(list);
  return meta;
}

/** 删除账户（连同其目录） */
function remove(id) {
  const dir = path.join(ACCOUNTS_DIR, id);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  writeIndex(readIndex().filter((a) => a.id !== id));
}

/**
 * 清空指定账户的用户数据，但保留账户元信息（id / 名称 / 启用状态）。
 * 重建后的账户恢复为「遵循全局设置」且无登录态、无任务进度。
 */
function clearData(id) {
  const meta = get(id);
  if (!meta) return false;
  const dir = getDir(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const config = createConfig(dir);
  config.setUseGlobal(true);
  const state = createState(dir);
  state.load();
  return true;
}

/** 重命名 */
function rename(id, name) {
  writeIndex(readIndex().map((a) => (a.id === id ? { ...a, name: String(name || "").trim() || a.name } : a)));
}

/** 启用/停用 */
function setEnabled(id, enabled) {
  writeIndex(readIndex().map((a) => (a.id === id ? { ...a, enabled: !!enabled } : a)));
}

/** 账户目录 */
function getDir(id) {
  return path.join(ACCOUNTS_DIR, id);
}

/**
 * 浏览器 profile 目录（已废弃，仅为兼容保留）
 *
 * 旧版本用它做 Playwright 持久化上下文，Chromium 会把登录 Cookie 明文写进去；
 * 现在改为临时目录 + 注入 Cookie（见 browser.js），此路径不再使用。
 * 存量目录由 vault/migrate.js 在启用加密时清理。
 */
function getProfileDir(id) {
  return path.join(ACCOUNTS_DIR, id, "profile");
}

/**
 * 账户运行时上下文：绑定该账户的 config / state / 目录
 * @param {string} id
 */
function context(id) {
  const meta = get(id);
  const dir = getDir(id);
  return {
    id,
    name: meta ? meta.name : id,
    dir,
    profileDir: getProfileDir(id),
    config: createConfig(dir),
    state: createState(dir),
  };
}

/** 生成 GUI 展示视图（不含敏感 Cookie 明细） */
function describe(id) {
  const meta = get(id);
  if (!meta) return null;
  const ctx = context(id);
  const cfg = ctx.config.get();
  const st = ctx.state.get();
  const dateNum = ctx.state.getDateNum();

  // 今日合计的取值优先级：
  //   1) 服务器权威值 todayPointsServer（earn 页 pointsCounters.dailyOffer）
  //   2) 本地各任务积分累加（兜底：任务被中断、还没来得及拉服务器值时）
  // 注意：不能对两者取 max。promosPoint 是「已完成活动的累计总分」，
  // 跨天未清零时会远大于当日真实值（例如本地算 620，服务器实际只有 115），
  // 取 max 会稳定选中错误的大数。服务器值可用时必须无条件采信。
  const signPt = Number.isFinite(st.signPoint) ? st.signPoint : 0;
  const readPt = Number.isFinite(st.readPoint) ? st.readPoint : 0;
  const dailyPt = Number.isFinite(st.dailyPoint) ? st.dailyPoint : 0;
  const promosPt = Number.isFinite(st.promosPoint) ? st.promosPoint : 0;
  const searchPt = Number.isFinite(st.searchPoint) ? st.searchPoint : 0;
  const computedToday = Math.max(0, signPt) + readPt + dailyPt + promosPt + searchPt;
  // 服务器值仅在"今天运行/同步过"时才采用，避免显示昨天的旧值
  const ranToday = st.lastRunDate === dateNum;
  const serverToday = ranToday && Number.isFinite(st.todayPointsServer) ? st.todayPointsServer : 0;
  // 本地累加值同样只在当天有效，跨天且还没重置时直接归零，避免显示昨天残留
  const todayPoints = serverToday > 0 ? serverToday : (ranToday ? computedToday : 0);

  // 搜索进度：pc/m 由「刷新状态」和搜索任务写入（服务器 pointsCounters 权威值）。
  // 跨天未重置时旧值会残留，因此同样按 ranToday 判断有效性。
  const rawPc = st.pc && typeof st.pc === "object" ? st.pc : { progress: 0, max: 0 };
  const rawM = st.m && typeof st.m === "object" ? st.m : { progress: 0, max: 0 };
  const searchPc = ranToday ? rawPc : { progress: 0, max: rawPc.max || 0 };
  const searchM = ranToday ? rawM : { progress: 0, max: rawM.max || 0 };
  // tasksDone 只在「今日实际跑过 runner」时才采信。
  // 否则可能是手动改了 state.json、或 tasksDone 还没被 resetIfNewDay 清掉的脏值，
  // 直接显示"✓ 完成"会误导用户（实际今天还没同步服务器状态）。
  const searchDone = ranToday && st.tasksDone?.search === dateNum;
  const searchProgress = (searchPc.max || 0) + (searchM.max || 0) > 0
    ? `${searchPc.progress || 0}/${searchPc.max || 0}${searchM.max ? ` · M:${searchM.progress || 0}/${searchM.max}` : ""}`
    : "";

  // 阅读篇数进度（每篇 3 分）：优先用 readArticles，缺失时按 readPoint 反推
  const POINTS_PER_ARTICLE = 3;
  const READ_MAX_POINTS = 30;
  const ra = st.readArticles && typeof st.readArticles === "object" ? st.readArticles : null;
  let readArticlesDone = ra && Number.isFinite(ra.done) ? ra.done : Math.floor(readPt / POINTS_PER_ARTICLE);
  let readArticlesTotal = ra && Number.isFinite(ra.total) && ra.total > 0
    ? ra.total
    : Math.ceil(READ_MAX_POINTS / POINTS_PER_ARTICLE);
  if (!ranToday) readArticlesDone = 0;
  // 任务标记为今日完成时，篇数视为满额（只在今天真的跑过 runner 时才相信）
  const readDone = ranToday && st.tasksDone?.read === dateNum;
  if (readDone) readArticlesDone = readArticlesTotal;
  const readProgress = readArticlesTotal > 0 ? `${readArticlesDone}/${readArticlesTotal} 篇` : "";

  // 签入完成判定（display 层 signPoint 兜底也要用它）
  const signDone = ranToday && st.tasksDone?.sign === dateNum;

  // 调度状态：当天是否已收工、已跑几轮、下次预计运行时间
  // 延迟 require 避免与 runner 形成循环依赖（runner 顶部已 require account）
  let sched = { dayDone: false, rounds: 0, pending: [], nextRunText: "", mode: "interval" };
  try {
    const runner = require("./runner");
    const sc = runner.normalizeSchedule(cfg);
    const ev = ctx.state.evaluateDayDone(cfg);
    const next = runner.nextRunTime(ctx);
    sched = {
      dayDone: ranToday && ctx.state.isDayComplete(),
      rounds: ctx.state.getAutoRounds(),
      pending: ev.pending,
      mode: sc.mode,
      enable: sc.enable,
      intervalMinutes: sc.intervalMinutes,
      nextRunText: next
        ? `${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")} ` +
          `${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`
        : "",
    };
  } catch {}

  return {
    ...meta,
    config: cfg,
    // 是否遵循全局设置：GUI 用它决定要不要展开「独立设置」区块
    useGlobal: cfg.useGlobal !== false,
    state: {
      loggedIn: hasAuthCookies(st.cookies || []),
      hasRefreshToken: !!(st.refreshToken || ""),
      todayPoints,
      lastBalance: st.lastBalance || 0,
      lastResult: st.lastResult || "",
      lastRunDate: st.lastRunDate || 0,
      signDone,
      readDone,
      dailyEnabled: !!cfg.tasks?.daily,
      dailyDone: ranToday && st.tasksDone?.daily === dateNum,
      dailyPoint: st.dailyPoint || 0,
      promosDone: ranToday && st.tasksDone?.promos === dateNum,
      searchDone,
      // signPoint 的 -1 是「从未签入」的哨兵初值；今天已签入却残留负数
      // （旧版会把接口返回的负数奖励原样落盘），展示层统一按 0 分处理，
      // 避免仪表盘出现「已完成 · -1 分」。存量脏数据由此立即自愈。
      signPoint: signDone && !(st.signPoint >= 0) ? 0 : st.signPoint,
      readPoint: st.readPoint,
      promosPoint: st.promosPoint,
      searchPoint: st.searchPoint,
      searchProgress,
      readProgress,
      readArticlesDone,
      readArticlesTotal,
      restrictedTimes: st.restrictedTimes || 0,
      cookiesCount: (st.cookies || []).length,
      sched,
    },
  };
}

/** 全部账户的展示视图 */
function describeAll() {
  return readIndex()
    .map((a) => {
      try {
        return describe(a.id);
      } catch (e) {
        // 单个账户数据损坏不应导致整个列表加载失败
        return {
          ...a,
          config: JSON.parse(JSON.stringify(DEFAULTS)),
          state: { loggedIn: false, hasRefreshToken: false, todayPoints: 0, lastBalance: 0, broken: e.message },
        };
      }
    })
    .filter(Boolean);
}

/**
 * 仪表盘聚合数据
 *
 * 复用 describeAll() 的结果做汇总，避免再走一遍磁盘 IO。
 * @returns {{accounts: object[], stats: object}}
 */
function overview() {
  const list = describeAll();
  const stats = {
    total: list.length,          // 账号数量
    enabled: 0,                  // 已启用
    loggedIn: 0,                 // 已登录
    todayPoints: 0,              // 今日积分合计
    balance: 0,                  // 总积分合计
    dayDone: 0,                  // 今日已收工的账号数
    pendingAccounts: 0,          // 仍有待办任务的账号数（仅统计已启用）
  };
  for (const a of list) {
    const st = a.state || {};
    if (a.enabled) stats.enabled++;
    if (st.loggedIn) stats.loggedIn++;
    stats.todayPoints += Number(st.todayPoints) || 0;
    stats.balance += Number(st.lastBalance) || 0;
    const sched = st.sched || {};
    if (sched.dayDone) stats.dayDone++;
    else if (a.enabled) stats.pendingAccounts++;
  }
  return { accounts: list, stats };
}

module.exports = {
  ACCOUNTS_DIR,
  DEFAULTS,
  list,
  get,
  create,
  remove,
  clearData,
  rename,
  setEnabled,
  getDir,
  getProfileDir,
  context,
  describe,
  describeAll,
  overview,
};
