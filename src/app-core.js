/**
 * 运行编排核心（Electron 与 Docker 版共用）
 *
 * 为什么单独拆出来：
 *   桌面版通过 webContents.send 推送状态，Docker 版通过 SSE 推送，
 *   但「何时算 running / 每账号什么状态 / 批次怎么串行」这套编排逻辑必须完全一致，
 *   否则两个版本的行为会慢慢漂移。这里把逻辑收口，两版只做事件转发。
 *
 * 事件（用 on() 订阅）：
 *   "running"        (boolean)                   全局运行态变化
 *   "accounts"       (Account[])                 账户数据刷新
 *   "account-status" ({id, status, reason})      单账号运行态变化
 *   "account-log"    (AccountLogEntry)           单账号结构化日志
 *
 * 纯 Node，不依赖 Electron。
 */
const EventEmitter = require("events");

const accounts = require("./account");
const runner = require("./runner");
const cancel = require("./cancel");
const browser = require("./browser");
const logger = require("./logger");
const vault = require("./vault");
const rewards = require("./rewards");
const auth = require("./auth");

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

/** 订阅事件，返回退订函数 */
function on(evt, cb) {
  emitter.on(evt, cb);
  return () => emitter.off(evt, cb);
}

function emit(evt, payload) {
  try {
    emitter.emit(evt, payload);
  } catch (e) {
    logger.warn(`事件 ${evt} 的订阅者抛错: ${e.message}`);
  }
}

/* ------------------------------ 全局运行态 ------------------------------ */

let running = false;

function isRunning() {
  return running;
}

function setRunning(v) {
  running = v;
  emit("running", v);
  // 运行态变化时立即刷一次账户数据，让卡片反映最新结果
  pushAccounts();
}

/** 主动广播最新账户数据 */
function pushAccounts() {
  try {
    emit("accounts", accounts.describeAll());
  } catch (e) {
    logger.warn(`推送账户数据失败: ${e.message}`);
  }
}

function pushChromiumStatus() {
  emit("chromium-status", chromiumStatus());
}

function chromiumStatus() {
  return { ready: browser.isChromiumReady(), executable: browser.chromiumExecutablePath() };
}

/* ---------------------------- 每账号运行态 ---------------------------- */

/**
 * 账号 id -> { status, reason, at }
 * status: "running" 正在工作 | "waiting" 排队等待 | "warning" 需要注意 | "error" 发生错误
 * 空闲账号不在 Map 中（前端不显示任何标记）。
 */
const runStatus = new Map();
/** 批次运行中、用户在排队阶段就要求「停止此账号」的 id 集合（轮到时直接跳过） */
const batchSkip = new Set();

/** 设置/清除某账号运行态并广播；status 传 "idle" 表示清除 */
function setAccountStatus(id, status, reason) {
  const key = String(id);
  const idle = status === "idle" || !status;
  if (idle) runStatus.delete(key);
  else runStatus.set(key, { status, reason: reason || "", at: Date.now() });
  emit("account-status", { id: key, status: idle ? "idle" : status, reason: reason || "" });
}

function runStatusSnapshot() {
  const out = {};
  for (const [id, s] of runStatus.entries()) out[id] = s;
  return out;
}

/**
 * 根据 runner 批次/单账号的结束信息判定终态。
 * @returns {{status:"warning"|"error", reason:string}|null} null 表示回到空闲
 */
function classifyOutcome(info) {
  if (!info) return null;
  // 用户主动停止（整批 / 单个 / 排队中跳过）不算错误
  if (info.aborted || info.abortAll || info.skipped) return null;
  // 业务阻断但拿到了 result（如 IP 非大陆）→ 橙色「需要注意」
  if (info.ok === false) {
    if (info.error && !info.result) return { status: "error", reason: info.reason || info.error || "运行失败" };
    return { status: "warning", reason: info.reason || "需要注意" };
  }
  // 任务级：真正报错 → 红；需人工介入 → 橙
  const tasks = (info.result && info.result.tasks) || {};
  for (const k of Object.keys(tasks)) {
    const t = tasks[k];
    if (t && t.status === "error") return { status: "error", reason: t.error || "任务执行出错" };
  }
  for (const k of Object.keys(tasks)) {
    const t = tasks[k];
    if (!t) continue;
    if (t.unauthorized) return { status: "warning", reason: "未授权，请重新登录后再运行" };
    if (t.status === "restricted") return { status: "warning", reason: "搜索任务收入受限" };
    if (t.status === "retry") return { status: "warning", reason: "部分任务未完成，稍后会自动重试" };
  }
  return null;
}

function applyOutcome(id, info) {
  const verdict = classifyOutcome(info);
  setAccountStatus(id, verdict ? verdict.status : "idle", verdict ? verdict.reason : "");
}

/**
 * 保险库闸门：已启用加密但未解锁时，任何要动登录态的操作都必须挡住。
 * 解不出 Cookie 就跑任务，只会被判未登录，甚至把空结果写回去冲掉会话。
 * @returns {{ok:false,error:string}|null} null 表示放行
 */
function vaultGuard() {
  if (!vault.isConfigured()) return null;
  if (vault.isUnlocked()) return null;
  return { ok: false, error: "保险库已锁定，请先解锁后再执行该操作" };
}

/**
 * 串行运行一批账号（账号间随机 20–60 秒），统一维护每账号状态。
 * 调用方需自行做 running 全局锁判断。
 */
async function runIds(ids, interactive) {
  const valid = [];
  for (const rawId of ids || []) {
    const id = String(rawId);
    if (accounts.get(id)) valid.push(id);
  }
  if (valid.length === 0) return { ok: false, error: "请先选择要运行的账户" };

  cancel.reset();
  batchSkip.clear();
  // 预置：第一个立即工作，其余排队
  valid.forEach((id, i) => setAccountStatus(id, i === 0 ? "running" : "waiting"));
  setRunning(true);
  try {
    const results = await runner.runBatch(valid, {
      interactive,
      minGap: 20,
      maxGap: 60,
      shouldSkip: (id) => batchSkip.has(String(id)),
      onPhase: (id, _name, phase, info) => {
        if (phase === "start") {
          batchSkip.delete(String(id));
          setAccountStatus(id, "running");
        } else if (phase === "end") {
          applyOutcome(id, info || {});
        }
        // phase === "waiting" 时其余账号保持 waiting
      },
    });
    return { ok: true, results };
  } catch (e) {
    if (e && e.isAbort) {
      logger.warn("任务已被手动停止");
      return { ok: false, aborted: true, error: "任务已停止" };
    }
    logger.error(`运行失败: ${e.message}`);
    return { ok: false, error: e.message };
  } finally {
    // 兜底：批次结束后仍停留在 running/waiting 的账号复位
    for (const id of valid) {
      const s = runStatus.get(id);
      if (s && (s.status === "running" || s.status === "waiting")) setAccountStatus(id, "idle");
    }
    setRunning(false);
  }
}

/** 停止全部（唤醒等待中的 sleep） */
function stopAll() {
  if (!running) return { ok: false, error: "当前没有正在运行的任务" };
  logger.warn("收到停止指令，正在中断当前任务...");
  cancel.abort();
  return { ok: true };
}

/** 只停止单个账号：正在执行则中断其作用域；排队中则标记轮到时跳过 */
function stopAccount(id) {
  const key = String(id);
  const acc = accounts.get(key);
  if (!acc) return { ok: false, error: "账户不存在" };
  const st = runStatus.get(key);
  if (!st) return { ok: false, error: "该账号当前没有在执行的任务" };
  if (st.status === "running") {
    cancel.abortScope(key);
    logger.warn(`正在停止账户「${acc.name}」的任务…`);
  } else if (st.status === "waiting") {
    batchSkip.add(key);
    setAccountStatus(key, "idle");
    logger.info(`账户「${acc.name}」已从排队中移除。`);
  } else {
    return { ok: false, error: "该账号当前没有在执行的任务" };
  }
  return { ok: true };
}

/* ------------------------------ 单账号操作 ------------------------------ */

/** 授权登录（需要可见浏览器 → Docker 下靠 Xvfb/noVNC 或从桌面版迁移登录态） */
async function loginInteractive(id) {
  const vg = vaultGuard();
  if (vg) return vg;
  if (running) return { ok: false, error: "已有任务正在运行，请稍候" };
  const acc = accounts.get(id);
  if (!acc) return { ok: false, error: "账户不存在" };
  setRunning(true);
  // 登录是独立入口（不走 runIds 的 batch），进入前清一次中止标志：
  // 上一轮任务被「停止」后 globalAborted 会残留，不清的话这里首次循环检查
  // 就会误判成「登录已被停止」，直接中断。
  cancel.reset();
  logger.setContext(id, acc.name);
  logger.info(`开始为「${acc.name}」授权登录（弹出独立干净浏览器）...`);
  try {
    const { code, loggedIn } = await browser.loginInteractive(accounts.context(id));
    if (code) {
      const token = await auth.exchangeCode(accounts.context(id), code);
      return {
        ok: !!token,
        loggedIn,
        message: token
          ? loggedIn
            ? "授权成功，登录状态已同步"
            : "授权成功，但未捕获到 bing 认证 Cookie，可点「⟳ 刷新状态」重试"
          : "授权码换取 token 失败",
      };
    }
    return { ok: false, loggedIn, message: "未捕获授权码" };
  } catch (e) {
    if (e && e.isAbort) {
      logger.warn("登录已手动停止");
      return { ok: false, aborted: true, error: "登录已手动停止" };
    }
    logger.error(`登录失败: ${e.message}`);
    return { ok: false, error: e.message };
  } finally {
    logger.clearContext();
    setRunning(false);
    // 登录是独立入口（不走 runIds 的批处理），中止标志要在这里复位，
    // 否则下一次登录/运行会一进去就被 throwIfAborted 打断。
    cancel.reset();
  }
}

/** 刷新登录状态 + 积分/阅读进度（不含授权交互） */
async function syncAccount(id) {
  const vg = vaultGuard();
  if (vg) return vg;
  if (running) return { ok: false, error: "已有任务正在运行，请稍候" };
  const acc = accounts.get(id);
  if (!acc) return { ok: false, error: "账户不存在" };
  setRunning(true);
  logger.setContext(id, acc.name);
  logger.info(`正在刷新「${acc.name}」的登录状态...`);
  try {
    const ctx = accounts.context(id);
    const r = await browser.syncCookies(ctx);
    if (r.loggedIn) {
      try {
        // 跨天先清零昨日累计
        if (ctx.state.resetIfNewDay()) {
          logger.info("检测到新的一天，已重置每日积分累计");
        }
        const info = await rewards.getRewardsInfo(ctx);
        if (info && info.ok) {
          const st = ctx.state.get();
          if (info.balance > 0) st.lastBalance = info.balance;
          if (Number.isFinite(info.todayTotal)) {
            st.todayPointsServer = info.todayTotal;
            st.todayPoints = info.todayTotal;
          }
          if (info.pc) st.pc = { progress: info.pc.progress, max: info.pc.max };
          if (info.m) st.m = { progress: info.m.progress, max: info.m.max };
          st.lastRunDate = ctx.state.getDateNum();
          ctx.state.save();
          logger.success(
            `积分已刷新：总积分 ${info.balance}，今日已得 ${info.todayTotal}，PC搜索 ${info.pc.progress}/${info.pc.max}`
          );
        } else {
          logger.warn("积分信息获取失败，卡片数据未更新");
        }
        // 顺便刷新阅读进度
        try {
          const token = await auth.ensureAccessToken(ctx, false);
          if (token) {
            const rp = await rewards.getReadPro(ctx, token);
            if (rp && rp.ok) {
              const st2 = ctx.state.get();
              st2.readPoint = rp.progress;
              st2.readArticles = { done: rp.articlesDone, total: rp.articlesTotal };
              ctx.state.save();
              logger.success(`阅读进度已刷新：${rp.articlesDone}/${rp.articlesTotal} 篇（${rp.progress}/${rp.max} 分）`);
            }
          }
        } catch (e) {
          logger.warn(`刷新阅读进度失败: ${e.message}`);
        }
      } catch (e) {
        logger.warn(`刷新积分余额失败: ${e.message}`);
      }
    }
    return {
      ok: true,
      loggedIn: r.loggedIn,
      message: r.loggedIn ? "登录状态已同步：已登录" : "未检测到登录态，请点「授权登录」重新登录",
    };
  } catch (e) {
    logger.error(`刷新状态失败: ${e.message}`);
    return { ok: false, error: e.message };
  } finally {
    logger.clearContext();
    setRunning(false);
  }
}

/** 运行单个账户（单账号无账号间等待） */
async function runOne(id) {
  const vg = vaultGuard();
  if (vg) return vg;
  if (running) return { ok: false, error: "已有任务正在运行，请稍候" };
  const acc = accounts.get(id);
  if (!acc) return { ok: false, error: "账户不存在" };
  const r = await runIds([id], true);
  const single = (r.results || [])[0];
  if (r.ok && single) {
    return {
      ok: single.ok !== false,
      result: single,
      aborted: single.reason === "已手动停止" || single.reason === "此账号任务已被手动停止",
    };
  }
  return r;
}

/** 运行全部已启用账户 */
async function runAllEnabled() {
  const vg = vaultGuard();
  if (vg) return vg;
  if (running) return { ok: false, error: "已有任务正在运行，请稍候" };
  const ids = accounts.list().filter((a) => a.enabled).map((a) => a.id);
  if (ids.length === 0) return { ok: false, error: "没有已启用的账户" };
  return runIds(ids, true);
}

/** 运行勾选的账户 */
async function runSelected(ids) {
  const vg = vaultGuard();
  if (vg) return vg;
  if (running) return { ok: false, error: "已有任务正在运行，请稍候" };
  if (!Array.isArray(ids) || ids.length === 0) return { ok: false, error: "请先勾选要运行的账户" };
  return runIds(ids, true);
}

module.exports = {
  on,
  emit,
  isRunning,
  setRunning,
  pushAccounts,
  pushChromiumStatus,
  chromiumStatus,
  setAccountStatus,
  runStatusSnapshot,
  classifyOutcome,
  applyOutcome,
  vaultGuard,
  runIds,
  runOne,
  runAllEnabled,
  runSelected,
  stopAll,
  stopAccount,
  loginInteractive,
  syncAccount,
};
