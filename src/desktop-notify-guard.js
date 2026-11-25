/**
 * 桌面任务「无响应弹窗」限流状态机（2026-11-22 用户定）。
 *
 * 【要解决的问题】notify 模式下，用户离开电脑就弹一条系统通知等人授权。若人一直
 * 不在（或压根不想理），每来一个空闲 episode 就弹一条，通知中心堆一叠，还可能在
 * 打游戏 / 看视频时突然蹦出来。用户要求：
 *   · 当日 1 小时内「连续超过 3 次」无响应弹窗 → 接下来 2 小时不再弹窗；
 *   · 或者用户可选自动执行：新增开关「1小时内多次未响应弹窗自动运行」（默认关闭），
 *     开启后触发限流时不再纯静默，而是本次直接自动执行一次（仍然不弹窗）。
 *
 * 【「无响应」怎么判定】Windows 点通知走 COM 激活会被 Chromium 以 exit 9 杀掉，
 * 拿不到 click 回调，只能靠「待授权时间窗」判定（见 toast-activation.js）。因此这里
 * 不试图分辨「用户看过但没点」：一条通知发出后，直到下一条通知要发出、或超过
 * PENDING_WINDOW_MS 仍未被授权，就记一次 miss；用户一旦授权，连续计数立刻清零
 * （这就是「连续」的语义：中间响应过一次就重新算）。
 *
 * 【为什么按「当日」+ 滑动 1 小时】用户明确说「当日」「1 小时内」。跨天把连续计数
 * 清零（新的一天重新算）；但「2 小时抑制期」存的是绝对时间戳，跨天 / 重启照样生效
 * —— 否则零点一过或重启一次软件就能绕过限流，等于没限。
 *
 * 【纯逻辑 + 可序列化】本模块不碰 fs / Electron / 通知，所有 now 由调用方注入
 * （离线测试传固定时间戳）；状态用 snapshot() / createDesktopNotifyGuard(snapshot)
 * 交给主进程落盘。改状态的方法返回是否变化，方便上层只在变化时写盘。
 */
"use strict";

/** 一条通知最长等多久算「无响应」：与 toast-activation 的待授权窗口保持一致 */
const PENDING_WINDOW_MS = 30 * 60 * 1000;
/** miss 的滑动窗口：1 小时 */
const MISS_WINDOW_MS = 60 * 60 * 1000;
/** 「连续超过 3 次」→ 第 4 次无响应才触发（用户原话「超过 3 次」） */
const MISS_LIMIT = 3;
/** 触发后停止弹窗的时长：2 小时 */
const SUPPRESS_MS = 2 * 60 * 60 * 1000;

function defaultDayOf(ts) {
  const d = new Date(ts);
  return Number(
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`
  );
}

/** 调用方没传 now 时的兜底；离线用例一律显式传固定值 */
function tsOrNow(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const misses = Array.isArray(r.misses)
    ? r.misses
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0)
        .slice(-64)
    : [];
  const pos = (v) => (Number(v) > 0 && Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    day: pos(r.day),
    misses,
    pendingAt: pos(r.pendingAt),
    suppressUntil: pos(r.suppressUntil),
    lastAutoRunAt: pos(r.lastAutoRunAt),
    triggerCount: pos(r.triggerCount),
  };
}

/**
 * @param {object} [initial] 由 snapshot() 恢复的状态
 * @param {{ dayOf?: (ts:number)=>number }} [opts] 可注入「取日期」，便于固定时区测试
 */
function createDesktopNotifyGuard(initial, opts = {}) {
  const dayOf = typeof (opts && opts.dayOf) === "function" ? opts.dayOf : defaultDayOf;
  let s = normalize(initial);

  /** 跨天：清连续计数与待授权；⚠️ 抑制期是绝对时间，必须保留 */
  function rollDay(t) {
    const d = dayOf(t);
    if (s.day !== d) {
      s.day = d;
      s.misses = [];
      s.pendingAt = 0;
    }
  }

  function pushMiss(t) {
    // 只保留 1 小时窗口内、且不晚于当前时刻的（时钟回拨也不炸）
    s.misses = s.misses.filter((x) => x <= t && t - x < MISS_WINDOW_MS);
    s.misses.push(t);
    if (s.misses.length > 64) s.misses = s.misses.slice(-64);
  }

  /** 把「还挂着、没人响应」的那条通知结算成一次 miss */
  function settlePending(t) {
    if (s.pendingAt <= 0) return false;
    pushMiss(t);
    s.pendingAt = 0;
    return true;
  }

  /**
   * 巡检用：只在待授权窗口已过期时结算，返回状态是否变化（供上层决定是否写盘）。
   * 窗口内不结算 —— 通知还在有效期，用户可能马上就点。
   */
  function settle(now) {
    const t = tsOrNow(now);
    rollDay(t);
    if (s.pendingAt > 0 && t - s.pendingAt >= PENDING_WINDOW_MS) return settlePending(t);
    return false;
  }

  /** 发通知前调用：结算上一条无响应 + 判定本次该 allow / suppress / auto-run */
  function decide(now, autoRunOnMiss) {
    const t = tsOrNow(now);
    rollDay(t);
    // 又要发通知了，上一条还没被响应 → 记一次 miss
    settlePending(t);

    // ① 2 小时抑制期内：一律不弹窗（触发瞬间的那次 auto-run 已经跑过，不重复）
    if (t < s.suppressUntil) {
      return { action: "suppress", reason: "cooldown", until: s.suppressUntil, misses: s.misses.length };
    }
    // ② 1 小时内连续超过 3 次无响应 → 触发限流
    if (s.misses.length > MISS_LIMIT) {
      s.suppressUntil = t + SUPPRESS_MS;
      s.triggerCount += 1;
      s.misses = [];
      s.pendingAt = 0;
      if (autoRunOnMiss === true) {
        s.lastAutoRunAt = t;
        return { action: "auto-run", reason: "miss-limit", until: s.suppressUntil, misses: 0 };
      }
      return { action: "suppress", reason: "miss-limit", until: s.suppressUntil, misses: 0 };
    }
    return { action: "allow", reason: "ok", until: s.suppressUntil, misses: s.misses.length };
  }

  /** 真正弹出一条通知后调用（只记待授权，不记 miss —— miss 由下一次 decide/settle 结算） */
  function noteShown(now) {
    const t = tsOrNow(now);
    rollDay(t);
    s.pendingAt = t;
    return snapshot();
  }

  /** 用户点通知 / 唤回应用完成授权 → 连续计数中断 */
  function noteResponded(now) {
    const t = tsOrNow(now);
    rollDay(t);
    s.pendingAt = 0;
    s.misses = [];
    return snapshot();
  }

  function pendingAt() {
    return s.pendingAt;
  }

  function snapshot() {
    return {
      day: s.day,
      misses: s.misses.slice(),
      pendingAt: s.pendingAt,
      suppressUntil: s.suppressUntil,
      lastAutoRunAt: s.lastAutoRunAt,
      triggerCount: s.triggerCount,
    };
  }

  return { decide, settle, noteShown, noteResponded, pendingAt, snapshot };
}

module.exports = {
  createDesktopNotifyGuard,
  PENDING_WINDOW_MS,
  MISS_WINDOW_MS,
  MISS_LIMIT,
  SUPPRESS_MS,
};
