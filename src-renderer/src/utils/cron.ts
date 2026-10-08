/**
 * 极简 cron 表达式解析与「下一次触发时刻」计算（5 段标准格式）。
 *
 * 为什么自己写而不用依赖：
 *   - 需求只有「每天几点几分换壁纸」这种量级，引一个 cron 库不划算；
 *   - 项目里已有 `runner.js` 的「自定义时间」先例，但那是 `hh:mm` 单点，
 *     不是 cron 表达式，语义不同不能复用。
 *
 * 支持的格式（空格分隔 5 段，缺一不可）：
 *   分 时 日 月 周
 *   例：`30 7 * * *`（每天 07:30）、每两小时的整点（分写 `0`、时写 `步长 2`）、
 *       `15 3 * * 1-5`（工作日 03:15）
 *
 * ⚠️ 本注释**故意不写**含「星号紧跟斜杠」的表达式：那是块注释的结束符，
 *    写在注释里会让整个文件语法错误（本项目已踩过一次，写完立刻 node --check 验）。
 *    要在注释里讲步长语法，就写「步长 N」这种中文说法。
 *
 * 每一段支持 3 种写法（可混用，用逗号并列）：
 *   - `*`        所有值
 *   - `a`        单个值
 *   - `a-b`      闭区间
 *   - `a-b/n`    带步长的区间（单独的 `*` + `/n` 也行）
 *   - `a,b,c-d`  逗号并列（union）
 * 例：`0,30 * * * *` = 每小时的 0 分和 30 分。
 *
 * 范围约定（与 Linux crontab 一致）：
 *   - 分 0–59、时 0–23、日 1–31、月 1–12、周 0–7（0 与 7 都是周日）
 *   - **日 与 周 是「或」关系**：同时指定时，任一命中即触发（crontab 的标准行为）
 *   - 周日用 0 或 7 都行，内部归一为 0
 *
 * 时区：**用本地时间**（与项目里 `hh:mmToMinutes` / 账户调度的做法一致，
 * 用户看到的就是墙上时间，跨时区部署时也符合直觉）。
 *
 * 只处理「未来最紧的一次」——不支持秒级、不支持月份第 N 个周几之类扩展。
 */

/** 解析结果：每一段命中取值的集合 */
export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
}

/** 每一段的合法范围 */
const FIELD_RANGE: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // 分
  [0, 23], // 时
  [1, 31], // 日
  [1, 12], // 月
  [0, 7], // 周（7 归一为 0）
];

export const FIELD_NAME = ["分钟", "小时", "日期", "月份", "星期"];

/**
 * 解析单段字段。
 *
 * @param part  该段原文，如 `*` / `5` / `1-10` / 带步长 / `0,30`
 * @param idx  段序号（0=分 … 4=周），决定合法范围
 * @returns 命中的取值集合；null = 解析失败
 */
function parseField(part: string, idx: number): Set<number> | null {
  const [lo, hi] = FIELD_RANGE[idx];
  const out = new Set<number>();
  const src = String(part == null ? "" : part).trim();
  if (!src) return null;

  for (const chunk of src.split(",")) {
    const piece = chunk.trim();
    if (!piece) return null;

    // 拆出步长：*/3 → base="*", step=3 ；1-10/2 → base="1-10", step=2
    let base = piece;
    let step = 1;
    const slashAt = piece.indexOf("/");
    if (slashAt >= 0) {
      base = piece.slice(0, slashAt).trim();
      const stepTxt = piece.slice(slashAt + 1).trim();
      if (!/^\d+$/.test(stepTxt)) return null;
      step = Number(stepTxt);
      if (step <= 0) return null; // 步长 0 会死循环
    }

    // `*` 与 `a-b` 的单值展开
    let start;
    let end;
    if (base === "*") {
      start = lo;
      end = hi;
    } else if (base.includes("-")) {
      const m = base.match(/^(\d+)-(\d+)$/);
      if (!m) return null;
      start = Number(m[1]);
      end = Number(m[2]);
      if (start > end) return null; // 写成 10-1 视为笔误，直接判非法而不是猜
    } else if (/^\d+$/.test(base)) {
      start = Number(base);
      end = step > 1 ? hi : start; // `5/10` = 5,15,25…（基点 + 步长）
    } else {
      return null;
    }

    if (start < lo || end > hi) return null;
    for (let v = start; v <= end; v += step) {
      out.add(idx === 4 && v === 7 ? 0 : v); // 周 7 → 0（周日）
    }
  }
  return out.size ? out : null;
}

/**
 * 解析完整 cron 表达式。
 *
 * @returns 解析失败返回 null（调用方负责回落，**绝不**静默当「每分钟」用）
 */
export function parseCron(expr: string): ParsedCron | null {
  const parts = String(expr == null ? "" : expr).trim().split(/\s+/);
  if (parts.length !== 5 || parts[0] === "") return null;
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const s = parseField(parts[i], i);
    if (!s) return null;
    sets.push(s);
  }
  return {
    minutes: sets[0],
    hours: sets[1],
    days: sets[2],
    months: sets[3],
    weekdays: sets[4],
  };
}

/** 该 Date 是否命中给定 cron（用于搜索下一次触发时刻） */
function matches(cron: ParsedCron, date: Date): boolean {
  if (!cron.minutes.has(date.getMinutes())) return false;
  if (!cron.hours.has(date.getHours())) return false;
  if (!cron.months.has(date.getMonth() + 1)) return false;
  // 日与周的组合语义（与 Linux crontab 一致）：
  //   - 两者**都**是 `*` 时，等价于每天都触发；
  //   - 只有其中一个被限定时，用「或」：如 `0 0 13 * 5` = 每月 13 号或每个周五；
  //   - 两者都被限定时，同样是「或」。
  //
  // ⚠️ 这里**不能**简写成 `dayHit || weekHit`：当「周 = *」且「日」被限定时，
  //   `weekHit` 恒为 true ⇒ 变成每天触发，`0 12 29 2 *`（二月 29 日）会在**二月 1 日**
  //   就命中（2028 年实测踩到：期望 2/29，实际 2/1）。所以周为通配时必须只看日。
  if (cron.weekdays.size === 7) return cron.days.has(date.getDate());
  if (cron.days.size === 31) return cron.weekdays.has(date.getDay());
  return cron.days.has(date.getDate()) || cron.weekdays.has(date.getDay());
}

/**
 * 求「严格晚于 from」的下一个触发时刻。
 *
 * 逐分钟向前找，最多看 366 天（覆盖 `0 0 29 2 *` 这类一年才一次的表达；
 * 366 > 平年 365，保证闰年 2/29 也能命中）。
 *
 * @param expr cron 表达式
 * @param from 起算时刻，默认现在
 * @returns 下一次触发时刻；表达式非法（或未来一年内无匹配）时返回 null
 */
export function nextCronTime(expr: string, from: Date = new Date()): Date | null {
  const cron = parseCron(expr);
  if (!cron) return null;
  // 从「下一分钟」开始找：cron 精度就是分钟，当分钟整点已过就该看下一分钟
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const LIMIT_MIN = 366 * 24 * 60;
  for (let i = 0; i < LIMIT_MIN; i++) {
    if (matches(cron, d)) return new Date(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** describeCron 的结果 */
export type CronDescription =
  | { ok: true; next: Date | null }
  | { ok: false; error: string };

/**
 * 校验 + 生成错误说明（给设置页展示）。
 *
 * @param expr cron 表达式
 */
export function describeCron(expr: string): CronDescription {
  const cron = parseCron(expr);
  if (!cron) {
    return {
      ok: false,
      error: `格式应为「分 时 日 月 周」共 5 段，例如 30 7 * * *（每天 07:30）；各段范围 ${FIELD_NAME.map((n, i) => `${n} ${FIELD_RANGE[i][0]}-${FIELD_RANGE[i][1]}`).join("，")}`,
    };
  }
  return { ok: true, next: nextCronTime(expr) };
}
