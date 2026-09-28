/**
 * 单次执行数量规划（阅读篇数 / 活动个数）
 *
 * 目的：把当天的任务摊到多轮里做，而不是一轮清空 —— 一次性把剩余任务全部
 * 做完，比「分几次慢慢做」更像脚本行为。
 *
 * 规则（逐条对应需求）：
 *   1. 用户设定的数量 base 就是本轮上限；显式设为 0 表示不限制（一次做完）。
 *   2. 随机开关打开时，在 base 上随机 ±（2–4）：
 *        · 不得 < 1               —— 否则会变成「一个都不做」；
 *        · 做减法时 base 必须大于随机数 —— 否则减不动，放弃随机。
 *      满足即生效，**随机结果允许超过当日剩余任务数 total**（见保护③）。
 *   3. 保护：
 *      · 未随机      → 结果严格不超过 total（设定值就是用户给的上限）；
 *      · 已随机      → 上限放宽到 total + MAX_DELTA。
 *
 * 为什么允许「随机多于当日任务数」（0.13.11 起）：
 *   每次都把剩余任务做得刚好接满，本身就是很强的规律性特征；
 *   多出来那几次（超出已满额的任务其实拿不到分）在行为上看不出异常。
 *   此前那条「随机不得 >= total」会把大多数随机降级为取消，
 *   结果就是数量永远等于设定值 —— 随机开关名存实亡。
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
 * @returns {{random: boolean, read: number, promos: number, search: number}}
 */
function normalizeLimits(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    random: o.random === true,
    read: toCount(o.read),
    promos: toCount(o.promos),
    search: toCount(o.search),
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

  // 保护②：设定值不能大于任务总数（也兜住历史脏数据）——
  // 注意这只管「未启用随机」的基准；随机开关会把结果在 base 上再 ±(2–4)，
  // 允许最终数量超过 total（见下方 cand 判定与保护③）。
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

  // 允许随机结果超过总数 total：多的那几次在任务侧会被满额/数组截断，
  // 拿不到额外分，但从行为上看不出「每次刚好接满」的规律（见顶部注释）。
  // 上限放宽到 total + MAX_DELTA —— 理性上 base 已 <= total，delta 最多 +4，
  // 这里再 clamp 一次只为防御脏数据，正常路径不会被触发。
  if (cand >= 1 && cand <= total + MAX_DELTA) {
    applied = true;
    note = `随机 ${delta > 0 ? "+" : ""}${delta}`;
  } else if (base <= mag) {
    // 设定值比随机数还小，减不动（或减到 0/负数）—— 放弃
    cancelled = true;
    note = `设定值不足以减去 ${mag}，已取消随机`;
  } else {
    // 减到 0 个 —— 变成了什么都不做，放弃
    cancelled = true;
    note = `随机 ${delta} 会变成 0 个，已取消随机`;
  }

  // 保护③：未随机时夹在 [0, total]；随机生效时可上探到 total + MAX_DELTA
  const ceil = applied ? total + MAX_DELTA : total;
  const count = Math.max(0, Math.min(applied ? cand : base, ceil));

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
