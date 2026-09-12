const accounts = require("./account");
const auth = require("./auth");
const browser = require("./browser");
const logger = require("./logger");
const notify = require("./notify");
const rewards = require("./rewards");
const tasks = require("./tasks");
const cancel = require("./cancel");
const goals = require("./goals");

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** [min,max] 之间的随机整数（含端点） */
function randomBetween(min, max) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * 运行单个账号（含日志上下文、取消作用域、异常归一化），不抛出。
 *
 * 抽出来给手动批处理与自动守护共用，保证两条路径行为一致：
 *  - 进入时设置取消作用域与日志归属，退出时清理；
 *  - 单账号中止（e.all===false）只让该账号失败，批处理继续；
 *  - 全局中止（e.all）向上传播，由调用方决定停止整个批次。
 *
 * @returns {Promise<{result?:object, aborted?:boolean, abortAll?:boolean, error?:string}>}
 */
async function runAccountGuarded(ctx, opts) {
  cancel.setActiveScope(ctx.id);
  cancel.clearScope(ctx.id);
  logger.setContext(ctx.id, ctx.name);
  try {
    const result = await runOnce(ctx, opts);
    return { result };
  } catch (e) {
    if (e && e.isAbort) {
      if (e.all) return { aborted: true, abortAll: true, error: "已手动停止" };
      return { aborted: true, error: "此账号任务已被手动停止" };
    }
    logger.error(`账户「${ctx.name}」运行出错: ${e.message}`);
    return { error: e.message };
  } finally {
    logger.clearContext();
    cancel.setActiveScope(null);
  }
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
  // 签到任务执行成功后清理浏览器缓存（保留登录 Cookie）；跳过/失败时不清。
  // best-effort：失败仅告警，不影响后续任务
  if (token && rSign && rSign.status === "done") await browser.clearBrowserCache(ctx);
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

  // 签入：以「今日是否已完成」为准，不要只看分数。
  // signPoint 为 0 是合法结果（当天已签过、无二次奖励），
  // 只有真的没跑过才算「未运行」。
  const signDone = state.isTaskDoneToday("sign");
  lines.push(
    `📅 签入: ${
      signDone
        ? signPoint > 0
          ? `已签入 +${signPoint} 分`
          : "已签入（无额外奖励）"
        : rSign.unauthorized
        ? "跳过(未授权)"
        : "未运行"
    }`
  );

  // 阅读：按需求改成显示篇数而不是分数
  const ra = state.get().readArticles || {};
  const raDone = Number(ra.done) || 0;
  const raTotal = Number(ra.total) || 0;
  const readDone = state.isTaskDoneToday("read");
  lines.push(
    `📖 阅读: ${
      readDone || raDone > 0
        ? raTotal > 0
          ? `${raDone}/${raTotal} 篇`
          : `${raDone} 篇`
        : rRead.unauthorized
        ? "跳过(未授权)"
        : "未运行"
    }`
  );

  lines.push(`🧩 活动: ${promosPoint > 0 ? promosPoint + " 分(累计)" : "未运行"}`);

  // 搜索：显示「已完成多少、还剩多少」，而不是只说「已完成」
  const sp2 = (rSearch && rSearch.progress) || tasks.searchProgressSnapshot(state);
  const searchDone = state.isTaskDoneToday("search");
  let searchText;
  if (sp2 && sp2.total > 0) {
    const detail =
      sp2.m.max > 0
        ? `PC ${sp2.pc.progress}/${sp2.pc.max}，移动 ${sp2.m.progress}/${sp2.m.max}`
        : `PC ${sp2.pc.progress}/${sp2.pc.max}`;
    searchText =
      sp2.left > 0
        ? `${sp2.done}/${sp2.total} 分，还剩 ${sp2.left} 分（${detail}）`
        : `已完成 ${sp2.done}/${sp2.total} 分（${detail}）`;
  } else if (searchDone) {
    searchText = "已完成";
  } else if (rSearch.status === "restricted") {
    searchText = "已中断(收入受限)";
  } else if (rSearch.status === "error") {
    searchText = `失败(${rSearch.error || "未知错误"})`;
  } else {
    searchText = `${rSearch.status}(${rSearch.searched || 0}次)`;
  }
  lines.push(`🔍 搜索: ${searchText}`);

  lines.push(`📊 今日合计: ${todayTotal} 分${serverToday > 0 ? "" : "(本地估算)"}`);
  if (balance > 0) lines.push(`💰 总积分: ${balance} 分`);

  // 积分目标：放在末尾，逐条显示还差多少 / 已达成
  try {
    const goalLines = goals.formatLines(cfg.goals, { today: todayTotal, balance });
    if (goalLines.length) lines.push(...goalLines);
  } catch (e) {
    logger.warn(`积分目标计算失败: ${e.message}`);
  }

  const summaryText = [`用户名：${ctx.name}`, ...lines].join("\n");
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
 * 串行运行一批账户（账号间不并发），一个账号跑完后随机等待 20–60 秒再跑下一个。
 *
 * 等待期间该账号不算「正在工作」，主进程可把后续账号标记为 waiting（排队）。
 * 单账号被单独停止时不影响批次；全局停止或等待期间被停止则结束整个批次。
 *
 * @param {string[]} ids 要运行的账户 id（按给定顺序）
 * @param {object} [opts]
 * @param {boolean} [opts.interactive]
 * @param {number} [opts.minGap=20] 账号间最小间隔（秒）
 * @param {number} [opts.maxGap=60] 账号间最大间隔（秒）
 * @param {(id:string,name:string,phase:"start"|"end"|"waiting",info?:object)=>void} [opts.onPhase]
 *        start: 某账号开始执行；end: 某账号结束（info.ok/info.reason/info.result）；
 *        waiting: 进入账号间随机等待（info.seconds）。
 * @returns {Promise<Array>} 每个账号一个结果对象（{account, ok, reason, ...}）
 */
async function runBatch(ids, opts = {}) {
  const minGap = Number.isFinite(opts.minGap) ? opts.minGap : 20;
  const maxGap = Number.isFinite(opts.maxGap) ? opts.maxGap : 60;
  const emit = typeof opts.onPhase === "function" ? opts.onPhase : () => {};
  const results = [];

  // 规整出仍存在的账户，缺 id/已删除的直接跳过
  const queue = [];
  for (const id of ids || []) {
    const acc = accounts.get(id);
    if (acc) queue.push(acc);
  }
  if (queue.length === 0) {
    logger.warn("没有可运行的账户，请先选择账户。");
    return results;
  }

  for (let i = 0; i < queue.length; i++) {
    const acc = queue[i];

    // 排队等待期间用户单独停止了该账号：轮到时直接跳过，不执行
    if (typeof opts.shouldSkip === "function" && opts.shouldSkip(acc.id)) {
      logger.info(`账户「${acc.name}」已被取消排队，跳过。`);
      results.push({ account: { id: acc.id, name: acc.name }, ok: false, reason: "已取消" });
      emit(acc.id, acc.name, "end", { ok: false, reason: "已取消", skipped: true });
      continue;
    }

    let ctx;
    try {
      ctx = accounts.context(acc.id);
    } catch (e) {
      logger.warn(`账户「${acc.name}」上下文缺失，已跳过: ${e.message}`);
      results.push({ account: { id: acc.id, name: acc.name }, ok: false, reason: "账户缺失" });
      continue;
    }

    emit(acc.id, acc.name, "start");
    const r = await runAccountGuarded(ctx, { interactive: opts.interactive });
    if (r.result) {
      results.push(r.result);
      emit(acc.id, acc.name, "end", {
        ok: r.result.ok !== false,
        reason: r.result.reason || "",
        result: r.result,
        aborted: false,
        abortAll: false,
      });
    } else {
      results.push({ account: { id: acc.id, name: acc.name }, ok: false, reason: r.error || "运行失败" });
      emit(acc.id, acc.name, "end", {
        ok: false,
        reason: r.error || "运行失败",
        aborted: !!r.aborted,
        abortAll: !!r.abortAll,
        error: r.error || "",
      });
    }

    // 全局停止：不再执行剩余账号
    if (r.abortAll) {
      logger.warn("已手动停止全部任务，剩余账户不再执行。");
      for (const rest of queue.slice(i + 1)) {
        results.push({ account: { id: rest.id, name: rest.name }, ok: false, reason: "已取消" });
        emit(rest.id, rest.name, "end", { ok: false, reason: "已取消" });
      }
      break;
    }

    // 最后一个账号跑完不再等待；maxGap<=0（runAll 兼容路径）也不等待
    if (i === queue.length - 1 || maxGap <= 0) continue;

    const waitSec = randomBetween(minGap, maxGap);
    emit(acc.id, acc.name, "waiting", { seconds: waitSec });
    logger.info(`账户「${acc.name}」已完成，随机等待 ${waitSec} 秒后再运行下一个账户…`);
    cancel.setActiveScope(null);
    try {
      // 账号间等待不受单账号中止影响，只响应全局停止
      await cancel.sleep(waitSec * 1000);
    } catch (e) {
      if (e && e.isAbort) {
        logger.warn("等待期间收到停止指令，剩余账户不再执行。");
        for (const rest of queue.slice(i + 1)) {
          results.push({ account: { id: rest.id, name: rest.name }, ok: false, reason: "已取消" });
          emit(rest.id, rest.name, "end", { ok: false, reason: "已取消" });
        }
        break;
      }
    }
  }
  return results;
}

/**
 * 依次运行所有启用账户（无间隔，供旧调用/守护外的场景使用）
 */
async function runAll(opts = {}) {
  const enabled = accounts.list().filter((a) => a.enabled);
  if (enabled.length === 0) {
    logger.warn("没有已启用的账户，请在 GUI 中添加账户。");
    return [];
  }
  return runBatch(enabled.map((a) => a.id), { ...opts, minGap: 0, maxGap: 0 });
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
      // 先判定本轮要跑哪些账号（判定不产生副作用之外的 IO），再串行执行，
      // 账号之间随机等待 20–60 秒，绝不并发。
      const due = [];
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
        if (decision.run) due.push({ acc, ctx, reason: decision.reason });
      }

      for (let i = 0; i < due.length; i++) {
        const { acc, ctx, reason } = due[i];
        const round = ctx.state.bumpAutoRound();
        logger.info(`账户「${acc.name}」自动运行第 ${round} 轮（${reason}）`);
        // 上一轮若被手动停止，中止标志还留着，不重置会导致本轮立刻抛 AbortError
        cancel.reset();
        if (typeof opts.onRunStart === "function") opts.onRunStart(acc);
        const gr = await runAccountGuarded(ctx, { interactive: false });
        try {
          if (gr.abortAll) {
            logger.warn(`账户「${acc.name}」自动运行被手动停止`);
          } else if (gr.aborted) {
            logger.warn(`账户「${acc.name}」自动运行被单独停止`);
          } else if (gr.error) {
            // runAccountGuarded 内部已记录错误，这里只负责调度层收尾
          } else {
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
          }
        } finally {
          if (typeof opts.onRunEnd === "function") opts.onRunEnd(acc, gr);
        }

        // 全局停止：不再执行本轮剩余账号
        if (gr.abortAll) break;

        // 后面还有账号要跑：随机等待 20–60 秒，不并发
        if (i < due.length - 1) {
          const waitSec = randomBetween(20, 60);
          logger.info(`账户「${acc.name}」已完成，随机等待 ${waitSec} 秒后再运行下一个账户…`);
          cancel.setActiveScope(null);
          try {
            await cancel.sleep(waitSec * 1000);
          } catch (e) {
            if (e && e.isAbort) break; // 全局停止：结束本轮巡检
          }
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
  runBatch,
  runAccountGuarded,
  startDaemon,
  nextRunTime,
  shouldRunNow,
  normalizeSchedule,
  hhmmToMinutes,
  minutesToHHmm,
  inAnyWindow,
};
