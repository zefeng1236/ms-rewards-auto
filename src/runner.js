const accounts = require("./account");
const auth = require("./auth");
const browser = require("./browser");
const logger = require("./logger");
const notify = require("./notify");
const rewards = require("./rewards");
const tasks = require("./tasks");
const cancel = require("./cancel");
const goals = require("./goals");
const { STATUS } = require("./history");

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * 区域拦截推送：告知当前 IP + 国家/地区、取消说明与下次执行时间。
 * 推送失败只 warn —— 绝不能反过来影响拦截本身。
 *
 * 版式（2026-10-03 用户指定，逐条对应）：
 *   ⚠️ 检测到非中国大陆区域（由 bing 判定），本次任务已取消执行
 *   当前 IP：43.198.88.83    ● Hong Kong/HK(香港/中国香港)
 *   下次执行时间：10-03 13:49
 *
 * 三条硬要求，改版式时别丢：
 *   ① 首行带 ⚠️ 警示符（拦截是中止类通知，要一眼看出事态）
 *   ② IP 与归属地之间：红色点 ● + 4 个空格，**不套括号**
 *      （原来是「当前 IP：x（geo）」，用户要求去掉前后括号）
 *   ③ 归属地本身保留 Hong Kong/HK(香港/中国香港) 这种「英文/代码(中文)」格式
 */
async function pushRegionBlocked(ctx, env) {
  try {
    const next = nextRunTime(ctx);
    const nextText = next
      ? `${pad2(next.getMonth() + 1)}-${pad2(next.getDate())} ${pad2(next.getHours())}:${pad2(next.getMinutes())}`
      : "未启用自动调度（或未登录），请处理后手动运行";
    const ip = env.ip || "未知";
    const geo = env.geo || env.ipcc || "未知";
    const lines = [
      `⚠️ ${env.reason || "检测到非中国大陆区域，本次任务已取消执行"}`,
      // 红点：推送渠道走 msgtype=text（钉钉/企微），**不支持颜色与富文本**，
      // 所以只能用红色圆形 emoji 🔴 表达「红色状态点」，别改回 <font color=…>（不生效）。
      `当前 IP：${ip}    🔴 ${geo}`,
      `下次执行时间：${nextText}`,
    ];
    await notify.sendText(ctx, "MS积分任务-区域拦截", lines.join("\n"));
  } catch (e) {
    logger.warn(`区域拦截推送失败: ${e.message}`);
  }
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
/**
 * 把当天结局写进 history.json —— 日历与勋章的唯一写入口。
 *
 * 挂在这一层而不是 runOnce 末尾，是为了覆盖 runOnce 的**所有**出口：
 * IP 非大陆、明确未登录这些中途 return 的分支同样要记一笔，
 * 否则日历上那天是空白，看起来像「没用过」而不是「失败了」。
 *
 * @param {object} ctx 账户上下文（含 history）
 * @param {object|null} result runOnce 的返回值
 * @param {"ok"|"error"|"aborted"} kind 出口类型
 */
function recordDay(ctx, result, kind) {
  try {
    if (!ctx || !ctx.history || typeof ctx.history.record !== "function") return;

    const cfg = ctx.config.get();
    const ev = ctx.state.evaluateDayDone(cfg);
    const total = ev.enabled.length;
    const done = total - ev.pending.length;

    let status;
    if (kind === "error") status = STATUS.ERROR;
    else if (kind === "aborted") status = done > 0 ? STATUS.PARTIAL : STATUS.IDLE;
    else if (!result || result.ok === false) status = STATUS.ERROR;
    else if (ev.done) status = STATUS.DONE;
    else if (done > 0) status = STATUS.PARTIAL;
    else status = STATUS.IDLE;

    // 积分以服务器权威值为准，拿不到才回落本地估算
    const st = ctx.state.get();
    const serverPts = Number(st.todayPointsServer) || 0;
    const points = serverPts > 0 ? serverPts : Number(st.todayPoints) || 0;

    const r = ctx.history.record(undefined, { status, done, total, points });
    if (r && r.awarded && r.awarded.length) {
      logger.success(`🏅 账户「${ctx.name}」获得勋章：${r.awarded.join("、")}`);
    }
  } catch (e) {
    // 历史只是附加价值，绝不能因为它写失败就影响任务本身
    logger.warn(`写入每日历史失败（不影响任务）: ${e.message}`);
  }
}

async function runAccountGuarded(ctx, opts) {
  cancel.setActiveScope(ctx.id);
  cancel.clearScope(ctx.id);
  logger.setContext(ctx.id, ctx.name);
  try {
    const result = await runOnce(ctx, opts);
    recordDay(ctx, result, "ok");
    return { result };
  } catch (e) {
    if (e && e.isAbort) {
      recordDay(ctx, null, "aborted");
      if (e.all) return { aborted: true, abortAll: true, error: "已手动停止" };
      return { aborted: true, error: "此账号任务已被手动停止" };
    }
    logger.error(`账户「${ctx.name}」运行出错: ${e.message}`);
    recordDay(ctx, null, "error");
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
async function runOnce(ctxRaw, opts = {}) {
  const interactive = !!opts.interactive;
  // 「立即一次性完成全部」模式：忽略单次执行数量限制（limits.read/promos），
  // 一轮把当天的任务全部做完。
  // 用派生 ctx 而不是直接改 accounts.context() 返回的对象 —— 那个对象可能被复用，
  // 原地写 force 会让之后的定时运行也被"解锁限制"，等于开关关不掉。
  const ctx = opts.force === true ? { ...ctxRaw, force: true } : ctxRaw;
  if (opts.force === true) logger.info("已进入「一次性完成」模式：本轮忽略单次执行数量限制");
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
    result.reason = env.reason || "IP 非中国大陆，任务已停止";
    state.get().lastResult = result.reason;
    state.save();
    logger.error(result.reason);
    // 拦截也推送：IP / 归属地 / 取消说明 / 下次执行时间（推送失败只 warn，不影响拦截）
    await pushRegionBlocked(ctx, env);
    return result;
  }

  // 2. 获取 access token（签入/阅读需要）
  let token = null;
  if (cfg.tasks.sign || cfg.tasks.read) {
    token = await auth.ensureAccessToken(ctx, interactive);
  }
  cancel.throwIfAborted();

  // 3. 同步浏览器 Cookie（活动/搜索依赖，顺带刷新登录态）
  // null = 没能判定（同步失败，沿用旧行为继续跑）；true/false = 明确判定
  let loggedIn = null;
  try {
    const sync = await browser.syncCookies(ctx);
    loggedIn = !!sync.loggedIn;
  } catch (e) {
    if (e && e.isAbort) throw e;
    logger.warn(`Cookie 同步失败: ${e.message}`);
  }
  cancel.throwIfAborted();

  // 明确判定为「未登录」时直接收工：后面的签入/阅读/活动/搜索全部依赖登录态，
  // 硬跑只会把「未授权」的空结果写回状态，还会在未登录的帮助页上点一堆无效入口
  // （既拿不到分，又白搭一轮时间，日志里也全是误导性的"已点击领取入口"）。
  if (loggedIn === false) {
    result.ok = false;
    result.reason = "未登录，已跳过本轮任务";
    state.get().lastResult = "未登录：请先在账户里点「授权登录」";
    state.save();
    logger.warn(`账户「${ctx.name}」未检测到登录态，跳过本轮全部任务（请先点「授权登录」）`);
    return result;
  }

  // 4. 顺序执行任务（签入/阅读依赖 access token，无 token 则跳过并提示授权）
  // 每个任务完成后增量保存今日合计，避免在搜索长等待中被中断时数据全丢
  const persistSummary = (extra) => {
    const g = state.get();
    const sp = Number.isFinite(g.signPoint) ? g.signPoint : 0;
    const rp = Number.isFinite(g.readPoint) ? g.readPoint : 0;
    const dp = Number.isFinite(g.dailyPoint) ? g.dailyPoint : 0;
    const pp = Number.isFinite(g.promosPoint) ? g.promosPoint : 0;
    const srp = Number.isFinite(g.searchPoint) ? g.searchPoint : 0;
    // 服务器权威值可用时不要用本地累加覆盖（promosPoint/dailyPoint 是累计值，会虚高）
    const server = Number.isFinite(g.todayPointsServer) ? g.todayPointsServer : 0;
    g.todayPoints = server > 0 ? server : Math.max(0, sp) + rp + dp + pp + srp;
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
  // 每日活动（dashboard dailySet），默认关闭，由 tasks.daily 控制
  const rDaily = cfg.tasks.daily ? await tasks.taskDaily(ctx) : { status: "skip", disabled: true };
  result.tasks.daily = rDaily;
  persistSummary();
  cancel.throwIfAborted();
  const rPromos = await tasks.taskPromos(ctx);
  result.tasks.promos = rPromos;
  persistSummary();
  cancel.throwIfAborted();
  // 定期收取积分：默认关闭（tasks.claim），开启后每周自动点一次「领取」（内部 7 天节流）
  const rClaim = cfg.tasks.claim ? await tasks.taskClaimRewards(ctx) : { status: "skip", disabled: true };
  result.tasks.claim = rClaim;
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
  const dailyPoint = state.get().dailyPoint || 0;
  const promosPoint = state.get().promosPoint;
  // 今日合计：服务器权威值绝对优先。
  // promosPoint/dailyPoint 记录的是「已完成活动累计总分」，不等于当日增量，
  // 因此本地累加只能在拿不到服务器值时兜底，不可与服务器值取 max。
  const searchPoint = state.get().searchPoint || 0;
  const localTotal = Math.max(0, signPoint) + readPoint + dailyPoint + promosPoint + searchPoint;
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

  // 每日活动：仅在开启该开关时显示一行，避免默认配置下汇总里多出无意义项
  if (cfg.tasks.daily) {
    const dailyDone = state.isTaskDoneToday("daily");
    lines.push(`📆 每日活动: ${dailyDone ? "已完成" + (dailyPoint > 0 ? ` +${dailyPoint} 分` : "") : rDaily && rDaily.status === "error" ? `失败(${rDaily.error || "未知错误"})` : "未运行"}`);
  }

  lines.push(`🧩 积分活动: ${promosPoint > 0 ? promosPoint + " 分(累计)" : "未运行"}`);

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
  // 随机启动延迟（秒）：老配置没有这两个字段时回落 20–300（20 秒 ~ 5 分钟）
  let delayMin = Number(raw.randomDelayMin);
  if (!Number.isFinite(delayMin) || delayMin < 0) delayMin = 20;
  let delayMax = Number(raw.randomDelayMax);
  if (!Number.isFinite(delayMax) || delayMax < delayMin) delayMax = 300;
  // 每天最早开始时刻（HH:mm）：「不早于该时刻才自动运行」，三种模式统一生效。
  // 老配置缺字段回落 09:00（上午 9 点）；非法值同样回 09:00。
  const rawStart = hhmmToMinutes(raw.startTime);
  const startTime = rawStart !== null ? raw.startTime : "09:00";
  return {
    enable: raw.enable !== false,
    mode,
    intervalMinutes: interval,
    stopWhenDone: raw.stopWhenDone !== false,
    maxRounds,
    time: hhmmToMinutes(raw.time) !== null ? raw.time : "08:00",
    windows,
    randomDelay: raw.randomDelay !== false,
    randomDelayMin: delayMin,
    randomDelayMax: delayMax,
    startTime,
  };
}

/**
 * 为一次「定时触发」抽取随机启动延迟
 *
 * 固定间隔/固定时刻启动本身就是一个很明显的特征，所以在真正开跑前先随机
 * 等一段时间（默认 20 秒 ~ 5 分钟），把启动时刻打散。手动运行不走这里。
 *
 * @param {object} cfg 该账户的有效配置
 * @param {() => number} [rng] 随机源（自检用）
 * @returns {{seconds:number, ms:number}} 关闭时返回 {seconds:0, ms:0}
 */
function pickStartDelay(cfg, rng) {
  const sc = normalizeSchedule(cfg);
  if (!sc.randomDelay) return { seconds: 0, ms: 0 };
  const seconds = randomBetween(sc.randomDelayMin, sc.randomDelayMax, rng);
  return { seconds, ms: seconds * 1000 };
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

  // 从未登录过的账户不纳入自动调度：没有登录态时跑一轮纯属空转（任务全判未授权，
  // 还会在未登录页面上点无效入口）。刚添加的账号默认就是这个状态，
  // 等它授权登录一次（有认证 Cookie 或 refreshToken）后自然进入循环。
  const st0 = state.get();
  if (!browser.hasAuthCookies(st0.cookies || []) && !st0.refreshToken) {
    return { run: false, reason: "账户尚未登录，跳过自动运行" };
  }

  // 跨天先清账，否则昨天的「今日已完成」标记会一直挡着
  state.resetIfNewDay();

  const nowMin = now.getHours() * 60 + now.getMinutes();

  // 每天开始时刻门禁：不早于 schedule.startTime（默认 09:00）不启动。
  // 三种模式统一生效；daily 模式另受 time 精确触发时刻约束，二者取更晚者自然成立。
  const startAt = hhmmToMinutes(sc.startTime);
  if (startAt !== null && nowMin < startAt) {
    return { run: false, reason: `未到每天开始时刻 ${sc.startTime}` };
  }

  // daily 模式：到达固定时刻与开始时刻两者中较晚的一刻后，每天只跑一次
  if (sc.mode === "daily") {
    const target = hhmmToMinutes(sc.time);
    if (target === null) return { run: false, reason: "定时时间格式非法" };
    if (nowMin < Math.max(target, startAt)) return { run: false, reason: "未到定时时刻" };
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
function nextRunTime(ctx, now = new Date()) {
  const sc = normalizeSchedule(ctx.config.get());
  if (!sc.enable) return null;
  // 未登录的账户没有可预期的运行时间（自动调度会跳过它）
  const st0 = ctx.state.get();
  if (!browser.hasAuthCookies(st0.cookies || []) && !st0.refreshToken) return null;

  if (sc.mode === "daily") {
    const target = Math.max(hhmmToMinutes(sc.time), hhmmToMinutes(sc.startTime));
    const next = new Date(now);
    next.setHours(Math.floor(target / 60), target % 60, 0, 0);
    if (next <= now || ctx.state.getAutoRounds() > 0) next.setDate(next.getDate() + 1);
    return next;
  }

  const dayFinished = (sc.stopWhenDone && ctx.state.isDayComplete()) ||
    (sc.maxRounds > 0 && ctx.state.getAutoRounds() >= sc.maxRounds);
  const last = Number(ctx.state.get().lastAutoRunAt) || 0;
  let candidate = last > 0 ? new Date(last + sc.intervalMinutes * 60000) : new Date(now);
  if (candidate < now) candidate = new Date(now);
  if (dayFinished) {
    candidate = new Date(now);
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(0, 0, 0, 0);
  }

  const startAt = hhmmToMinutes(sc.startTime);
  const todayStart = new Date(candidate);
  todayStart.setHours(Math.floor(startAt / 60), startAt % 60, 0, 0);
  if (candidate < todayStart) candidate = todayStart;
  if (sc.mode !== "windows") return candidate;

  // 按本地日历日逐段寻找交集；跨零点段的凌晨部分受 startTime 门禁限制。
  for (let day = 0; day < 3; day++) {
    const probeDay = new Date(candidate);
    probeDay.setDate(probeDay.getDate() + day);
    probeDay.setHours(0, 0, 0, 0);
    let earliest = null;
    for (const w of sc.windows) {
      const starts = w.start <= w.end ? [w.start] : [0, w.start];
      for (const windowStart of starts) {
        const end = w.start <= w.end ? w.end : windowStart === 0 ? w.end : 1439;
        const minute = Math.max(startAt, windowStart);
        if (minute > end) continue;
        const first = new Date(probeDay);
        first.setMinutes(minute);
        const lastMinute = new Date(probeDay);
        lastMinute.setMinutes(end);
        const due = candidate > first ? candidate : first;
        if (due <= lastMinute && (!earliest || due < earliest)) earliest = due;
      }
    }
    if (earliest) return earliest;
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

        // 随机启动延迟：不在固定时刻精确开跑，弱化「定时器」特征。
        // 每个账户按自己的调度设置各等一次；等待期间可被「停止任务」立即打断。
        const delay = pickStartDelay(ctx.config.get());
        if (delay.seconds > 0) {
          cancel.setActiveScope(null);
          const scheduledAt = new Date();
          logger.info(
            `账户「${acc.name}」命中随机启动延迟 ${delay.seconds} 秒（计划于 ${scheduledAt.toISOString()} 起算），规避固定时刻特征…`
          );
          try {
            await cancel.sleep(delay.ms);
          } catch (e) {
            if (e && e.isAbort) break; // 全局停止：结束本轮巡检
          }
          const startedAt = new Date();
          logger.info(
            `账户「${acc.name}」延迟结束，实际开始执行（${startedAt.toISOString()}，实际等了 ${Math.round((startedAt - scheduledAt) / 1000)} 秒）`
          );
          // 延迟窗口最长达 5 分钟，期间用户可能已经手动开跑，别再插一脚
          if (typeof opts.isBusy === "function" && opts.isBusy()) {
            logger.info("检测到手动任务已在运行，本轮定时触发跳过。");
            break;
          }
        }

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
  pickStartDelay,
  randomBetween,
  hhmmToMinutes,
  minutesToHHmm,
  inAnyWindow,
};
