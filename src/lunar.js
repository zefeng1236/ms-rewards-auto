/**
 * 公历 ↔ 农历换算（1900-2100）
 *
 * 为什么自己实现而不装 npm 包：
 *   1. 日历要按农历定位春节/端午/七夕/中秋/除夕等节日，没有农历就只剩公历节日；
 *   2. 打进 asar 的包越多越难核对，这套表是定长常量、可直接写断言验证；
 *   3. 只用得到「某天是农历几月初几」，不需要干支、八字、宜忌那些庞杂部分。
 *
 * 数据编码（每年一个 20 位整数，是通用的农历压缩表）：
 *   bit0-3    闰月月份（0 = 当年无闰月）
 *   bit4-15   正月~腊月的大小月（1 = 30 天，0 = 29 天）
 *   bit16     闰月大小（1 = 闰月 30 天）
 *
 * 基准：1900-01-31 = 农历 1900 年正月初一。
 */

// 1900-2100 逐年压缩表
const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900-1909
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910-1919
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920-1929
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930-1939
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940-1949
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950-1959
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960-1969
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, // 1970-1979
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980-1989
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0, // 1990-1999
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000-2009
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010-2019
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020-2029
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030-2039
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, // 2040-2049
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0, // 2050-2059
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4, // 2060-2069
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0, // 2070-2079
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160, // 2080-2089
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252, // 2090-2099
  0x0d520, // 2100
];

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
const DAY_MS = 86400000;

/** 基准日：1900-01-31 = 农历 1900 年正月初一 */
const BASE_DATE = Date.UTC(1900, 0, 31);

/** 闰月月份（0 = 无闰月） */
function leapMonth(y) {
  return LUNAR_INFO[y - MIN_YEAR] & 0xf;
}

/** 闰月天数（无闰月返回 0） */
function leapDays(y) {
  if (!leapMonth(y)) return 0;
  return (LUNAR_INFO[y - MIN_YEAR] & 0x10000) ? 30 : 29;
}

/** 农历某月天数（m 为 1-12 的月份，不含闰月） */
function monthDays(y, m) {
  if (m < 1 || m > 12) return -1;
  return (LUNAR_INFO[y - MIN_YEAR] & (0x10000 >> m)) ? 30 : 29;
}

/** 农历一年总天数 */
function yearDays(y) {
  let sum = 348; // 12 个月 × 29 天
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += (LUNAR_INFO[y - MIN_YEAR] & i) ? 1 : 0;
  return sum + leapDays(y);
}

/**
 * 公历 → 农历
 * @param {Date|string|number} date 公历日期（字符串按 YYYY-MM-DD 解析，数字按 YYYYMMDD）
 * @returns {{year:number, month:number, day:number, isLeap:boolean}}
 */
function solarToLunar(date) {
  const d = toDate(date);
  const utc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());

  let offset = Math.floor((utc - BASE_DATE) / DAY_MS);
  if (offset < 0) offset = 0;

  let year = MIN_YEAR;
  let temp = 0;
  for (; year <= MAX_YEAR && offset >= 0; year++) {
    temp = yearDays(year);
    offset -= temp;
  }
  // 上面循环多减了一年，回退
  if (offset < 0) {
    offset += temp;
    year -= 1;
  }
  // offset 现在是「该农历年内已过天数」

  const leap = leapMonth(year);
  let isLeap = false;
  let month = 1;
  for (; month <= 12 && offset >= 0; month++) {
    if (leap > 0 && month === leap + 1 && !isLeap) {
      // 走到闰月位置：先过闰月
      month -= 1;
      isLeap = true;
      temp = leapDays(year);
    } else {
      temp = monthDays(year, month);
    }
    offset -= temp;
    if (isLeap && month === leap + 1) isLeap = false;
  }
  if (offset < 0) {
    offset += temp;
    month -= 1;
  }
  // 边界：正好落在闰月最后一天
  if (offset === 0 && leap > 0 && month === leap + 1) {
    if (isLeap) isLeap = false;
    else {
      isLeap = true;
      month -= 1;
    }
  }

  return { year, month: Math.max(1, month), day: offset + 1, isLeap };
}

/** 把入参统一成 Date（本地时区的当天 00:00） */
function toDate(v) {
  if (v instanceof Date) return v;
  if (typeof v === "number") {
    const s = String(v);
    return new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
  }
  const s = String(v || "").trim();
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** 农历月初一对应的公历日期（用于「腊月最后一天 = 除夕」这类推算） */
function lunarToSolar(lYear, lMonth, lDay, isLeap = false) {
  let offset = 0;
  for (let y = MIN_YEAR; y < lYear; y++) offset += yearDays(y);

  const leap = leapMonth(lYear);
  for (let m = 1; m < lMonth; m++) {
    offset += monthDays(lYear, m);
    if (leap > 0 && m === leap) offset += leapDays(lYear);
  }
  if (isLeap) offset += monthDays(lYear, lMonth);

  offset += lDay - 1;
  const d = new Date(BASE_DATE + offset * DAY_MS);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** 农历当月天数（用于判断除夕是廿九还是三十） */
function lunarMonthDays(lYear, lMonth, isLeap = false) {
  if (isLeap) return leapDays(lYear);
  return monthDays(lYear, lMonth);
}

module.exports = {
  solarToLunar,
  lunarToSolar,
  lunarMonthDays,
  leapMonth,
  leapDays,
  monthDays,
  yearDays,
  MIN_YEAR,
  MAX_YEAR,
};
