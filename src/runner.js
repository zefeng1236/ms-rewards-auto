const accounts = require("./account");
const auth = require("./auth");
const browser = require("./browser");
const logger = require("./logger");
const notify = require("./notify");
const rewards = require("./rewards");
const tasks = require("./tasks");
const cancel = require("./cancel");

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * 运行单个账户的全部任务
 * @param {object} ctx 账户上下文
 * @param {{interactive?: boolean}} [opts]
 */
async function runOnce(ctx, opts = {}) {
  const interactive = !!opts.interactive;
  const cfg = ctx.config.get();
  const state = ctx.state;
  const result = { account: { id: ctx.id, name: ctx.name }, tasks: {}, ok: true, reason: "" };

  logger.setTag(`[${ctx.name}]`);
  logger.info(`===== 开始运行账户「${ctx.name}」 =====`);
  // 跨天先清零每日累计字段，否则昨天的 signPoint/readPoint/promosPoint 会继续累加
  if (state.resetIfNewDay()) {
    logger.info("检测到新的一天，已重置每日积分累计");
  }
  state.get().lastRunDate = state.getDateNum();
  state.save();

  // 1. 区域检查
  const env = await rewards.mainlandCheck(ctx);
  if (!env.ok) {
    result.ok = false;
    result.reason = "IP 非中国大陆，任务已停止";
    state.get().lastResult = result.reason;
    state.save();
    logger.error(result.reason);
    return result;
  }

  // 2. 获取 access token（签入/阅读需要）
  let token = null;
  if (cfg.tasks.sign || cfg.tasks.read) {
    token = await auth.ensureAccessToken(ctx, interactive);
  }
  cancel.throwIfAborted();

  // 3. 同步浏览器 Cookie（活动/搜索依赖，顺带刷新登录态）
  let loggedIn = false;
  try {
    const sync = await browser.syncCookies(ctx);
    loggedIn = sync.loggedIn;
  } catch (e) {
    if (e && e.isAbort) throw e;
    logger.warn(`Cookie 同步失败: ${e.message}`);
  }
  cancel.throwIfAborted();

  // 4. 顺序执行任务（签入/阅读依赖 access token，无 token 则跳过并提示授权）
  // 每个任务完成后增量保存今日合计，避免在搜索长等待中被中断时数据全丢
  const persistSummary = (extra) => {
    const g = state.get();
    const sp = Number.isFinite(g.signPoint) ? g.signPoint : 0;
    const rp = Number.isFinite(g.readPoint) ? g.readPoint : 0;
    const pp = Number.isFinite(g.promosPoint) ? g.promosPoint : 0;
    // 服务器权威值可用时不要用本地累加覆盖（promosPoint 是累计值，会虚高）
    const server = Number.isFinite(g.todayPointsServer) ? g.todayPointsServer : 0;
    g.todayPoints = server > 0 ? server : Math.max(0, sp) + rp + pp;
    if (extra) Object.assign(g, extra);
    state.save();
  };

  // Cookie 同步后尝试拉取一次总积分与今日合计（即使后续任务被中断也能显示余额）
  try {
    const info0 = await rewards.getRewardsInfo(ctx);
    if (info0 && info0.ok) {
      const g = state.get();
      if (info0.balance > 0) g.lastBalance = info0.balance;
      if (Number.isFinite(info0.todayTotal)) g.todayPointsServer = info0.todayTotal;
      // 无条件写入搜索进度（国区 m.max 为 0，用 >0 判断会导致永不更新）
      if (info0.pc) g.pc = { progress: info0.pc.progress, max: info0.pc.max };
      if (info0.m) g.m = { progress: info0.m.progress, max: info0.m.max };
      state.save();
    }
  } catch {}

  const rSign = token ? await tasks.taskSign(ctx, token) : { status: "skip", point: -1, unauthorized: true };
  result.tasks.sign = rSign;
  persistSummary();
  cancel.throwIfAborted();
  const rRead = token ? await tasks.taskRead(ctx, token) : { status: "skip", point: 0, unauthorized: true };
  result.tasks.read = rRead;
  persistSummary();
  cancel.throwIfAborted();
  const rPromos = await tasks.taskPromos(ctx);
  result.tasks.promos = rPromos;
  persistSummary();
  cancel.throwIfAborted();
  const rSearch = await tasks.taskSearch(ctx);
  result.tasks.search = rSearch;

  // 5. 获取最新积分并汇总
  let balance = state.get().lastBalance || 0;
  let serverToday = 0; // 服务器返回的今日已得积分（权威值）
  try {
    const info = await rewards.getRewardsInfo(ctx);
    if (info && info.ok) {
      if (info.balance > 0) balance = info.balance;
      if (Number.isFinite(info.todayTotal) && info.todayTotal > 0) serverToday = info.todayTotal;
    }
  } catch {}

  const signPoint = state.get().signPoint;
  const readPoint = state.get().readPoint;
  const promosPoint = state.get().promosPoint;
  // 今日合计：服务器权威值绝对优先。
  // promosPoint 记录的是「已完成活动累计总分」，不等于当日增量，
  // 因此本地累加只能在拿不到服务器值时兜底，不可与服务器值取 max。
  const localTotal = Math.max(0, signPoint) + readPoint + promosPoint;
  const todayTotal = serverToday > 0 ? serverToday : localTotal;

  const lines = [];
  lines.push(`📅 签入: ${signPoint >= 0 ? signPoint + " 分" : rSign.unauthorized ? "跳过(未授权)" : "未运行"}`);
  lines.push(`📖 阅读: ${readPoint > 0 ? readPoint + " 分" : rRead.unauthorized ? "跳过(未授权)" : "未运行"}`);
  lines.push(`🧩 活动: ${promosPoint > 0 ? promosPoint + " 分(累计)" : "未运行"}`);
  lines.push(`🔍 搜索: ${rSearch.status === "skip" ? "已完成/跳过" : rSearch.status === "done" ? "已完成" : `${rSearch.status}(${rSearch.searched || 0}次)`}`);
  lines.push(`📊 今日合计: ${todayTotal} 分${serverToday > 0 ? "" : "(本地估算)"}`);
  if (balance > 0) lines.push(`💰 总积分: ${balance} 分`);

  const summaryText = lines.join("\n");
  state.get().lastResult = summaryText;
  state.get().todayPoints = todayTotal;
  if (serverToday > 0) state.get().todayPointsServer = serverToday;
  if (balance > 0) state.get().lastBalance = balance;
  state.save();

  // 判断今日是否已收工（手动运行跑完也应标记，避免自动循环重复空跑）
  const dayEval = state.evaluateDayDone(cfg);
  result.dayDone = dayEval.done;
  result.pending = dayEval.pending;
  if (dayEval.done) {
    if (state.markDayComplete()) {
      logger.success(`账户「${ctx.name}」今日全部任务已完成，自动循环将在明日恢复`);
    }
  } else if (dayEval.pending.length) {
    logger.info(`账户「${ctx.name}」尚未完成：${dayEval.pending.join("、")}`);
  }

  logger.success(`===== 账户「${ctx.name}」运行结束 =====\n${summaryText}`);
  await notify.sendSummary(ctx, summaryText);
  return result;
}

/**
 * 依次运行所有启用账户
 */
async function runAll(opts = {}) {
  const enabled = accounts.list().filter((a) => a.enabled);
  const results = [];
  if (enabled.length === 0) {
    logger.warn("没有已启用的账户，请在 GUI 中添加账户。");
    return results;
  }
  for (const acc of enabled) {
    const ctx = accounts.context(acc.id);
    try {
      results.push(await runOnce(ctx, opts));
    } catch (e) {
      if (e && e.isAbort) {
        logger.warn(`已手动停止，剩余账户不再执行。`);
        results.push({ account: { id: acc.id, name: acc.name }, ok: false, reason: "已手动停止" });
        break;
      }
      logger.error(`账户「${acc.name}」运行出错: ${e.message}`);
      results.push({ account: { id: acc.id, name: acc.name }, ok: false, reason: e.message });
    }
  }
  return results;
}

/* ================= 调度 ================= */

/** "HH:mm" -> 当天零点起的分钟数，非法返回 null */
function hhmmToMinutes(s) {
  const m = String(s || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

/** 分钟数 -> "HH:mm" */
function minutesToHHmm(total) {
  const t = ((total % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`;
}

/** 规范化 schedule 配置，兼容只有 enable/time 的老配置 */
function normalizeSchedule(cfg) {
  const raw = (cfg && cfg.schedule) || {};
  const mode = ["interval", "windows", "daily"].includes(raw.mode) ? raw.mode : "interval";
  let interval = Number(raw.intervalMinutes);
  if (!Number.isFinite(interval) || interval < 5) interval = 45;
  if (interval > 720) interval = 720;
  let windows = Array.isArray(raw.windows) ? raw.windows : [];
  windows = windows
    .map((w) => ({ start: hhmmToMinutes(w && w.start), end: hhmmToMinutes(w && w.end) }))
    .filter((w) => w.start !== null && w.end !== null);
  if (!windows.length) windows = [{ start: 9 * 60, end: 23 * 60 }];
  let maxRounds = Number(raw.maxRounds);
  if (!Number.isFinite(maxRounds) || maxRounds < 0) maxRounds = 0;
  return {
    enable: raw.enable !== false,
    mode,
    intervalMinutes: interval,
    stopWhenDone: raw.stopWhenDone !== false,
    maxRounds,
    time: hhmmToMinutes(raw.time) !== null ? raw.time : "08:00",
    windows,
  };
}

/**
 * 当前时刻是否落在任一时间段内（支持 22:00-02:00 这类跨零点写法）
 * @returns {object|null} 命中的时间段
 */
function inAnyWindow(windows, nowMin) {
  for (const w of windows) {
    if (w.start <= w.end) {
      if (nowMin >= w.start && nowMin <= w.end) return w;
    } else {
      // 跨零点：22:00-02:00 等价于 [22:00,24:00) ∪ [00:00,02:00]
      if (nowMin >= w.start || nowMin <= w.end) return w;
    }
  }
  return null;
}

/**
 * 决定某账户此刻是否应该自动运行
 * @param {object} ctx 账户上下文
 * @param {Date} [now]
 * @returns {{run: boolean, reason: string}}
 */
function shouldRunNow(ctx, now = new Date()) {
  const cfg = ctx.config.get();
  const sc = normalizeSchedule(cfg);
  const state = ctx.state;
  if (!sc.enable) return { run: false, reason: "未启用自动运行" };

  // 跨天先清账，否则昨天的「今日已完成」标记会一直挡着
  state.resetIfNewDay();

  const nowMin = now.getHours() * 60 + now.getMinutes();

  // daily 模式：保持旧语义，每天只在指定时刻跑一次
  if (sc.mode === "daily") {
    const target = hhmmToMinutes(sc.time);
    if (target === null) return { run: false, reason: "定时时间格式非法" };
    if (nowMin !== target) return { run: false, reason: "未到定时时刻" };
    if (state.getAutoRounds() > 0) return { run: false, reason: "今日已触发过" };
    return { run: true, reason: `每日定时 ${sc.time}` };
  }

  // interval / windows：当天任务全部完成即退出循环
  if (sc.stopWhenDone && state.isDayComplete()) {
    return { run: false, reason: "今日任务已全部完成" };
  }
  if (sc.maxRounds > 0 && state.getAutoRounds() >= sc.maxRounds) {
    return { run: false, reason: `已达今日轮数上限 ${sc.maxRounds}` };
  }
  if (sc.mode === "windows" && !inAnyWindow(sc.windows, nowMin)) {
    return { run: false, reason: "当前不在设定时间段内" };
  }

  // 间隔检查：距上次自动运行不足 intervalMinutes 则继续等
  const last = Number(state.get().lastAutoRunAt) || 0;
  const elapsedMin = last > 0 ? (now.getTime() - last) / 60000 : Infinity;
  if (elapsedMin < sc.intervalMinutes) {
    const wait = Math.ceil(sc.intervalMinutes - elapsedMin);
    return { run: false, reason: `距上次运行 ${Math.floor(elapsedMin)} 分钟，还需等 ${wait} 分钟` };
  }
  return { run: true, reason: sc.mode === "windows" ? "时间段内循环触发" : "间隔循环触发" };
}

/**
 * 计算指定账户下次自动运行的预计时间
 * @returns {Date|null}
 */
function nextRunTime(ctx) {
  const sc = normalizeSchedule(ctx.config.get());
  if (!sc.enable) return null;
  const now = new Date();

  if (sc.mode === "daily") {
    const target = hhmmToMinutes(sc.time);
    if (target === null) return null;
    const next = new Date(now);
    next.setHours(Math.floor(target / 60), target % 60, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  // 今日已收工 -> 次日首个可运行时刻
  if (sc.stopWhenDone && ctx.state.isDayComplete()) {
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    const firstStart = sc.mode === "windows" ? Math.min(...sc.windows.map((w) => w.start)) : 0;
    next.setHours(Math.floor(firstStart / 60), firstStart % 60, 0, 0);
    return next;
  }

  const last = Number(ctx.state.get().lastAutoRunAt) || 0;
  let candidate = last > 0 ? new Date(last + sc.intervalMinutes * 60000) : new Date(now);
  if (candidate < now) candidate = new Date(now);
  if (sc.mode !== "windows") return candidate;

  // windows 模式：把候选时间推进到最近的段内时刻（最多往后找 2 天）
  for (let i = 0; i < 2 * 24 * 60; i++) {
    const probe = new Date(candidate.getTime() + i * 60000);
    const probeMin = probe.getHours() * 60 + probe.getMinutes();
    if (inAnyWindow(sc.windows, probeMin)) {
      probe.setSeconds(0, 0);
      return probe;
    }
  }
  return null;
}

/**
 * 启动自动运行守护（多账户，每 30 秒巡检一次）
 *
 * 与旧实现的区别：不再是「每天某个时刻跑一次就完」，而是按间隔反复跑，
 * 直到当天所有启用的任务都完成后标记收工、退出本日循环。
 *
 * @param {{onRunStart?: Function, onRunEnd?: Function}} [opts]
 * @returns {() => void} 停止函数
 */
function startDaemon(opts = {}) {
  let busy = false;
  logger.info("自动运行守护已启动（每 30 秒巡检，按各账户调度设置触发）");

  const tick = async () => {
    if (busy) return; // 上一轮还没跑完，跳过本次巡检
    // 用户正在手动运行/授权时不要插队（isBusy 由主进程注入）
    if (typeof opts.isBusy === "function" && opts.isBusy()) return;
    busy = true;
    try {
      const now = new Date();
      for (const acc of accounts.list()) {
        if (!acc.enabled) continue;
        let ctx;
        try {
          ctx = accounts.context(acc.id);
        } catch {
          continue;
        }
        let decision;
        try {
          decision = shouldRunNow(ctx, now);
        } catch (e) {
          logger.warn(`账户「${acc.name}」调度判断出错: ${e.message}`);
          continue;
        }
        if (!decision.run) continue;

        const round = ctx.state.bumpAutoRound();
        logger.info(`账户「${acc.name}」自动运行第 ${round} 轮（${decision.reason}）`);
        // 上一轮若被手动停止，中止标志还留着，不重置会导致本轮立刻抛 AbortError
        cancel.reset();
        if (typeof opts.onRunStart === "function") opts.onRunStart(acc);
        try {
          await runOnce(ctx, { interactive: false });
          // 跑完立刻判断今日是否已收工
          const cfg = ctx.config.get();
          const sc = normalizeSchedule(cfg);
          const ev = ctx.state.evaluateDayDone(cfg);
          if (ev.done) {
            if (sc.stopWhenDone && ctx.state.markDayComplete()) {
              logger.success(`账户「${acc.name}」今日全部任务已完成（共 ${round} 轮），本日自动运行结束`);
            }
          } else {
            logger.info(
              `账户「${acc.name}」仍有未完成任务：${ev.pending.join("、")}，约 ${sc.intervalMinutes} 分钟后重试`
            );
          }
        } catch (e) {
          if (e && e.isAbort) logger.warn(`账户「${acc.name}」自动运行被手动停止`);
          else logger.error(`账户「${acc.name}」自动运行失败: ${e.message}`);
        } finally {
          if (typeof opts.onRunEnd === "function") opts.onRunEnd(acc);
        }
      }
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(tick, 30 * 1000);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  runOnce,
  runAll,
  startDaemon,
  nextRunTime,
  shouldRunNow,
  normalizeSchedule,
  hhmmToMinutes,
  minutesToHHmm,
  inAnyWindow,
};
