/**
 * 勋章体系定义与判定
 *
 * 三类勋章：
 *   1. 连续签到 —— 连续「完整完成」3/7/10/14/20/28 天各一枚，造型互不相同；
 *   2. 月全勤   —— 某自然月内每一天都完成，单独一枚；
 *   3. 节日专属 —— 在节日当天完成即得，含农历节日（春节/端午/七夕/中秋…）与公历节日。
 *
 * 计数口径（用户 2026-09-30 确认）：
 *   - 「连续」只认**完整完成**（日历绿色）；部分完成会中断连续。
 *   - 每枚勋章累计获得**次数**：断了再重新达成同一档位，次数 +1。
 *     例如连续 3 天拿到「三日」，断掉后再连续 3 天，三日勋章计数变成 2。
 *
 * 这里只放**元数据与判定**，不含任何图形/SVG —— 图形在渲染层的 BadgeIcon 组件里，
 * 用 iconKey 关联，避免主进程被打进 UI 代码。
 */

const lunar = require("./lunar");

/** 每日状态（与 src/history.js 的 status 字段一致） */
const STATUS = {
  DONE: "done",       // 全部启用任务完成 —— 只有这一档算「签到」
  PARTIAL: "partial", // 完成一部分
  IDLE: "idle",       // 当天未运行
  ERROR: "error",     // 运行出错，无进度
};

const pad2 = (n) => String(n).padStart(2, "0");

/** YYYY-M-D → YYYY-MM-DD */
function normDay(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/**
 * 清明（节气）：公历日期在 4/4–4/6 之间浮动，用通用近似公式。
 * 公式：INT(Y*0.2422 + 4.81) - INT((Y-1)/4)，Y 为年份后两位。
 */
function qingmingDay(year) {
  const Y = year % 100;
  const day = Math.floor(Y * 0.2422 + 4.81) - Math.floor((Y - 1) / 4);
  return normDay(year, 4, Math.min(6, Math.max(4, day)));
}

/** 某年 11 月第 4 个星期四（感恩节） */
function thanksgivingDay(year) {
  // 11/1 是星期几，算出第一个周四，再 +21 天
  const first = new Date(year, 10, 1);
  const wd = first.getDay(); // 0=周日
  const firstThu = 1 + ((4 - wd + 7) % 7);
  return normDay(year, 11, firstThu + 21);
}

/** 某年 12 月 25 日 */
const fixed = (m, d) => (year) => normDay(year, m, d);

/**
 * 节日表：dateOf(year) 返回该年对应的公历日期（YYYY-MM-DD）。
 * lunar 字段非空时按农历换算（month/day 为农历月日；day 为 "last" 表示当月最后一天）。
 */
const FESTIVALS = [
  // ---- 中国农历传统节日 ----
  { id: "spring", name: "春节", desc: "正月初一，万象更新", iconKey: "spring", lunar: { month: 1, day: 1 }, tone: "red" },
  { id: "lantern", name: "元宵节", desc: "正月十五，灯火可亲", iconKey: "lantern", lunar: { month: 1, day: 15 }, tone: "amber" },
  { id: "longtaitou", name: "龙抬头", desc: "二月初二，春回大地", iconKey: "dragon", lunar: { month: 2, day: 2 }, tone: "teal" },
  { id: "qingming", name: "清明节", desc: "踏青时节，春和景明", iconKey: "qingming", dateOf: qingmingDay, tone: "green" },
  { id: "dragonboat", name: "端午节", desc: "五月初五，粽叶飘香", iconKey: "zongzi", lunar: { month: 5, day: 5 }, tone: "green" },
  { id: "qixi", name: "七夕节", desc: "七月初七，鹊桥相会", iconKey: "qixi", lunar: { month: 7, day: 7 }, tone: "violet" },
  { id: "midautumn", name: "中秋节", desc: "八月十五，花好月圆", iconKey: "mooncake", lunar: { month: 8, day: 15 }, tone: "amber" },
  { id: "chongyang", name: "重阳节", desc: "九月初九，登高望远", iconKey: "chongyang", lunar: { month: 9, day: 9 }, tone: "amber" },
  { id: "laba", name: "腊八节", desc: "腊月初八，粥暖岁寒", iconKey: "laba", lunar: { month: 12, day: 8 }, tone: "brown" },
  { id: "chuxi", name: "除夕", desc: "岁除之夜，辞旧迎新", iconKey: "chuxi", lunar: { month: 12, day: "last" }, tone: "red" },

  // ---- 公历节日（中国 + 世界）----
  { id: "newyear", name: "元旦", desc: "一月一日，新年伊始", iconKey: "newyear", dateOf: fixed(1, 1), tone: "red" },
  { id: "valentine", name: "情人节", desc: "二月十四，心意相通", iconKey: "valentine", dateOf: fixed(2, 14), tone: "pink" },
  { id: "fool", name: "愚人节", desc: "四月一日，玩笑万岁", iconKey: "fool", dateOf: fixed(4, 1), tone: "violet" },
  { id: "earth", name: "世界地球日", desc: "四月廿二，守护蓝色星球", iconKey: "earth", dateOf: fixed(4, 22), tone: "green" },
  { id: "labor", name: "劳动节", desc: "五月一日，致敬耕耘", iconKey: "labor", dateOf: fixed(5, 1), tone: "amber" },
  { id: "children", name: "儿童节", desc: "六月一日，童心未泯", iconKey: "children", dateOf: fixed(6, 1), tone: "cyan" },
  { id: "national", name: "国庆节", desc: "十月一日，举国同庆", iconKey: "national", dateOf: fixed(10, 1), tone: "red" },
  { id: "halloween", name: "万圣节", desc: "十月卅一，南瓜灯的夜晚", iconKey: "halloween", dateOf: fixed(10, 31), tone: "orange" },
  { id: "thanksgiving", name: "感恩节", desc: "十一月第四个周四，心怀感激", iconKey: "thanksgiving", dateOf: thanksgivingDay, tone: "brown" },
  { id: "christmas", name: "圣诞节", desc: "十二月廿五，铃儿响叮当", iconKey: "christmas", dateOf: fixed(12, 25), tone: "red" },
];

/**
 * 把节日换算成某年的公历日期。
 * 农历节日要注意跨年：农历 2026 年腊月初八落在公历 2027 年 1 月，
 * 所以求「某公历年的春节」时要同时看相邻农历年。
 * @returns {string} YYYY-MM-DD
 */
function festivalDateInYear(f, year) {
  if (typeof f.dateOf === "function") return f.dateOf(year);
  if (!f.lunar) return "";

  // 农历月日 → 公历，需覆盖 year-1 / year / year+1 三个农历年，
  // 再筛出落在目标公历年的那个
  for (const ly of [year - 1, year, year + 1]) {
    let day = f.lunar.day;
    if (day === "last") {
      // 除夕：腊月最后一天（可能是廿九或三十）
      day = lunar.lunarMonthDays(ly, 12);
    }
    const d = lunar.lunarToSolar(ly, f.lunar.month, day);
    if (d.getFullYear() === year) return normDay(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  return "";
}

/** 缓存：key = `${festivalId}:${year}` */
const _festCache = new Map();

/**
 * 某天是哪个节日（同一天最多返回一个，以表中靠前的为准）
 * @param {string} day YYYY-MM-DD
 * @returns {object|null} 节日对象（含 date 字段）
 */
function festivalOn(day) {
  const s = String(day || "").slice(0, 10);
  const year = Number(s.slice(0, 4));
  if (!year) return null;
  for (const f of FESTIVALS) {
    const key = `${f.id}:${year}`;
    let d = _festCache.get(key);
    if (d === undefined) {
      d = festivalDateInYear(f, year);
      _festCache.set(key, d);
    }
    if (d && d === s) return { ...f, date: d };
  }
  return null;
}

/** 某年全部节日（用于「今年还有哪些节日」之类的展示，按日期升序） */
function festivalsOfYear(year) {
  const out = [];
  for (const f of FESTIVALS) {
    const d = festivalDateInYear(f, year);
    if (d) out.push({ ...f, date: d });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** 连续签到勋章：连续完整完成 N 天
 *
 * 命名原则：**直白说人话**。勋章名一眼能看出是几天，
 * 不用「三日之约 / 旬日如初」这类需要琢磨的文言表述——
 * 名字是给人看的，不是给人猜的（2026-10-03 用户反馈「不好」）。
 * 描述也补上「连续」二字，与日历里的连续签到天数呼应。
 */
const STREAK_BADGES = [
  { id: "streak3", name: "连续 3 天", desc: "连续 3 天全部完成", iconKey: "streak3", days: 3, tone: "cyan" },
  { id: "streak7", name: "连续 7 天", desc: "连续 7 天全部完成", iconKey: "streak7", days: 7, tone: "teal" },
  { id: "streak10", name: "连续 10 天", desc: "连续 10 天全部完成", iconKey: "streak10", days: 10, tone: "green" },
  { id: "streak14", name: "连续 14 天", desc: "连续 14 天全部完成", iconKey: "streak14", days: 14, tone: "amber" },
  { id: "streak20", name: "连续 20 天", desc: "连续 20 天全部完成", iconKey: "streak20", days: 20, tone: "orange" },
  { id: "streak28", name: "连续 28 天", desc: "连续 28 天全部完成", iconKey: "streak28", days: 28, tone: "violet" },
];

/** 月全勤勋章 */
const PERFECT_BADGE = {
  id: "perfectMonth",
  name: "满月全勤",
  desc: "一整个月，天天都没落下",
  iconKey: "perfectMonth",
  tone: "gold",
};

/** 全部勋章（连续 + 全勤 + 节日），供界面枚举 */
function allBadges() {
  return [...STREAK_BADGES, PERFECT_BADGE, ...FESTIVALS.map((f) => ({
    id: f.id,
    name: f.name,
    desc: f.desc,
    iconKey: f.iconKey,
    tone: f.tone,
  }))];
}

/** 按 id 取勋章定义 */
function badgeById(id) {
  return allBadges().find((b) => b.id === id) || null;
}

module.exports = {
  STATUS,
  STREAK_BADGES,
  PERFECT_BADGE,
  FESTIVALS,
  allBadges,
  badgeById,
  festivalOn,
  festivalsOfYear,
  festivalDateInYear,
  qingmingDay,
  thanksgivingDay,
  normDay,
  pad2,
};
