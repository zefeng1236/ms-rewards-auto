/**
 * 单次执行数量规划（阅读篇数 / 活动个数）
 *
 * 目的：把当天的任务摊到多轮里做，而不是一轮清空 —— 一次性把剩余任务全部
 * 做完，比「分几次慢慢做」更像脚本行为。
 *
 * 规则（逐条对应需求）：
 *   1. 用户设定的数量 base 就是本轮基准；显式设为 0 表示不限制（一次做完）。
 *   2. 随机开关打开时，在 base 上随机 ±（2–4），但结果必须同时满足：
 *        · 不得 >= 任务总数 total —— 否则会把剩余任务「一次性做完」；
 *        · 不得 < 1               —— 否则会变成「一个都不做」；
 *        · 做减法时 base 必须大于随机数 —— 否则减不动，同样放弃随机。
 *      任意一条不满足，就放弃这次随机，保持 base 原值。
 *   3. 兜底保护：最终数量一定落在 [0, total]，既不会超过任务总数，也不会为负。
 *
 * 纯函数，无副作用，便于自检直接断言。
 */

/** 随机波动的幅度上限（个） */
const MIN_DELTA = 2;
const MAX_DELTA = 4;

/** 把任意输入归一化成非负整数，非法值一律当 0（不限制） */
function toCount(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 归一化配置里的 limits 段，兼容老配置（缺字段 / 类型飘）
 * @param {object} [raw]
 * @returns {{random: boolean, read: number, promos: number}}
 */
function normalizeLimits(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    random: o.random === true,
    read: toCount(o.read),
    promos: toCount(o.promos),
  };
}

/**
 * 规划本轮要执行多少个任务
 *
 * @param {object} opts
 * @param {number} opts.base   用户设定的每次执行数量，0 = 不限制
 * @param {number} opts.total  当前还可执行的任务总数（剩余量）
 * @param {boolean} [opts.random] 是否启用随机波动
 * @param {() => number} [opts.rng] 随机源，默认 Math.random（自检注入固定序列）
 * @returns {{
 *   count:number,    // 本轮实际执行数量（已保证 0 <= count <= total）
 *   total:number,    // 可执行任务总数
 *   base:number,     // 基准数量（已按 total 截断）
 *   unlimited:boolean, // 是否「未设上限」
 *   applied:boolean,   // 随机是否生效
 *   cancelled:boolean, // 随机被放弃（命中保护条件）
 *   delta:number,      // 实际生效的偏移量（未生效为 0）
 *   mag:number,        // 本次抽到的随机幅度 2–4
 *   note:string        // 供日志/Debug 显示的说明
 * }}
 */
function resolveTaskCount(opts = {}) {
  const total = toCount(opts.total);
  const rng = typeof opts.rng === "function" ? opts.rng : Math.random;

  const empty = { total: 0, base: 0, unlimited: false, applied: false, cancelled: false, delta: 0, mag: 0 };

  // 保护①：没有可执行的任务
  if (total <= 0) {
    return { ...empty, count: 0, note: "没有可执行的任务" };
  }

  const rawBase = Number(opts.base);
  const unlimited = !Number.isFinite(rawBase) || rawBase <= 0;

  // 保护②：设定值不能大于任务总数（也兜住历史脏数据）
  const base = unlimited ? total : Math.min(Math.floor(rawBase), total);

  if (unlimited) {
    return { ...empty, count: base, base, total, unlimited: true, note: "未设置上限，本轮全部执行" };
  }
  if (opts.random !== true) {
    return { ...empty, count: base, base, total, note: "" };
  }

  // 抽取随机幅度（2–4）与方向（加 / 减）
  const mag = MIN_DELTA + Math.floor(rng() * (MAX_DELTA - MIN_DELTA + 1));
  const sign = rng() < 0.5 ? 1 : -1;
  const delta = sign * mag;
  const cand = base + delta;

  let applied = false;
  let cancelled = false;
  let note = "";

  if (cand >= 1 && cand < total) {
    applied = true;
    note = `随机 ${delta > 0 ? "+" : ""}${delta}`;
  } else if (delta > 0) {
    // 加上去就正好等于（或超过）任务总数 —— 会一次性做完，放弃
    cancelled = true;
    note = `随机 +${mag} 会一次做完，已取消随机`;
  } else if (base <= mag) {
    // 设定值比随机数还小，减不动 —— 放弃
    cancelled = true;
    note = `设定值不足以减去 ${mag}，已取消随机`;
  } else {
    // 减到 0 个 —— 变成了什么都不做，放弃
    cancelled = true;
    note = `随机 ${delta} 会变成 0 个，已取消随机`;
  }

  // 保护③：最终夹在 [0, total]
  const count = Math.max(0, Math.min(applied ? cand : base, total));

  return {
    count,
    total,
    base,
    unlimited: false,
    applied,
    cancelled,
    delta: applied ? delta : 0,
    mag,
    note,
  };
}

module.exports = { resolveTaskCount, normalizeLimits, MIN_DELTA, MAX_DELTA };
