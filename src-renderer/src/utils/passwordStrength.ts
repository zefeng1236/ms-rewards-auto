/**
 * 密码强度评估（仅前端提示用，不影响主进程的加解密实现）
 *
 * 规则：
 *  - 复杂度：长度 ≥ 8，且同时包含小写、大写、数字、特殊字符 → 才算「满足要求」
 *  - 强度分 1~5 档，界面画 5 段分色条；**达到第 3 段（level >= 3）**才允许提交
 *  - 弱模式（生日、年月日、连续/重复数字等）只在界面上红色小字提醒，不阻断
 */

export interface PasswordStrength {
  /** 强度档位 0~5（0 = 空密码） */
  level: number;
  /** 是否满足最低复杂度（长度+四类字符） */
  complex: boolean;
  /** 是否可以提交：达到第 3 段且满足复杂度 */
  pass: boolean;
  /** 未满足的复杂度项（用于界面打勾提示） */
  missing: string[];
  /** 命中的弱密码模式描述，非空时界面显示红色小字 */
  weakHints: string[];
  /** 简短的强度文案 */
  label: string;
}

const SPECIAL_RE = /[^A-Za-z0-9]/;

/** 是否含常见日期形态：YYYYMMDD / YYYY-MM-DD / MMDD / YYMMDD 等 */
function hitDateLike(pw: string): boolean {
  // 连续 8 位且像日期：20240914 / 1999-01-01 / 19990101
  const ymd = pw.match(/(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})/g);
  if (ymd) {
    for (const s of ymd) {
      const d = s.replace(/[-/.]/g, "");
      const y = parseInt(d.slice(0, 4), 10);
      const m = parseInt(d.slice(4, 6), 10);
      const day = parseInt(d.slice(6, 8), 10);
      if (y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && day >= 1 && day <= 31) return true;
    }
  }
  // 4~6 位短日期：0101 / 1225 / 990101 / 011223
  const short = pw.match(/\d{4,6}/g);
  if (short) {
    for (const s of short) {
      if (s.length === 4) {
        const m = parseInt(s.slice(0, 2), 10);
        const day = parseInt(s.slice(2, 4), 10);
        if ((m >= 1 && m <= 12 && day >= 1 && day <= 31) || /^(19|20)\d{2}$/.test(s)) return true;
      }
      if (s.length === 6) {
        const y = parseInt(s.slice(0, 2), 10);
        const m = parseInt(s.slice(2, 4), 10);
        const day = parseInt(s.slice(4, 6), 10);
        if (y >= 0 && m >= 1 && m <= 12 && day >= 1 && day <= 31) return true;
        const y4 = parseInt(s.slice(0, 4), 10);
        const m2 = parseInt(s.slice(4, 6), 10);
        if (y4 >= 1900 && y4 <= 2100 && m2 >= 1 && m2 <= 12) return true;
      }
    }
  }
  return false;
}

/** 连续数字/字母（abcd、1234、4321） */
function hitSequential(pw: string): boolean {
  const lower = pw.toLowerCase();
  for (let i = 0; i + 3 < lower.length; i++) {
    const a = lower.charCodeAt(i);
    const b = lower.charCodeAt(i + 1);
    const c = lower.charCodeAt(i + 2);
    const d = lower.charCodeAt(i + 3);
    if (b - a === 1 && c - b === 1 && d - c === 1) return true;
    if (a - b === 1 && b - c === 1 && c - d === 1) return true;
  }
  return false;
}

/** 同一字符重复 4 次以上（aaaa、1111） */
function hitRepeat(pw: string): boolean {
  return /(.)\1{3,}/.test(pw);
}

/** 常见弱密码 / 键盘序列 */
function hitCommon(pw: string): boolean {
  const lower = pw.toLowerCase();
  const common = [
    "password", "passw0rd", "123456", "12345678", "qwerty", "abc123",
    "admin", "iloveyou", "letmein", "welcome", "monkey", "dragon",
    "microsoft", "rewards", "msrewards", "111111", "000000", "a123456",
  ];
  for (const c of common) {
    if (lower === c || lower.includes(c)) return true;
  }
  const kb = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "1qaz", "qazwsx"];
  for (const k of kb) {
    if (lower.includes(k)) return true;
  }
  return false;
}

/**
 * 评估密码强度
 * @param pw 待评估的密码
 */
export function evaluatePassword(pw: string): PasswordStrength {
  const empty: PasswordStrength = {
    level: 0,
    complex: false,
    pass: false,
    missing: ["长度至少 8 位"],
    weakHints: [],
    label: "未输入",
  };
  if (!pw) return empty;

  const hasLower = /[a-z]/.test(pw);
  const hasUpper = /[A-Z]/.test(pw);
  const hasDigit = /\d/.test(pw);
  const hasSpecial = SPECIAL_RE.test(pw);
  const lenOk = pw.length >= 8;

  const missing: string[] = [];
  if (!lenOk) missing.push("长度至少 8 位");
  if (!hasLower) missing.push("小写字母");
  if (!hasUpper) missing.push("大写字母");
  if (!hasDigit) missing.push("数字");
  if (!hasSpecial) missing.push("特殊字符");
  const complex = missing.length === 0;

  // 种类数（0~4）+ 长度加分 → 映射到 1~5 档
  const kinds = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;
  let score = 0;
  score += kinds; // 0~4
  if (pw.length >= 8) score += 1;
  if (pw.length >= 12) score += 1;
  if (pw.length >= 16) score += 1;
  // 复杂度未达标最多只能到 2 档（红/橙），逼用户补齐字符种类
  let level = Math.min(5, Math.max(1, Math.round(score * 0.7)));
  if (!complex) level = Math.min(2, level);
  if (pw.length < 8) level = Math.min(level, 2);

  const weakHints: string[] = [];
  if (hitDateLike(pw)) weakHints.push("包含疑似生日或日期，容易被猜到");
  if (hitSequential(pw)) weakHints.push("包含连续字符（如 1234、abcd）");
  if (hitRepeat(pw)) weakHints.push("包含重复字符（如 aaaa、1111）");
  if (hitCommon(pw)) weakHints.push("接近常见弱密码或键盘序列");

  const labels = ["太弱", "弱", "一般", "较强", "强", "非常强"];
  const pass = complex && level >= 3;

  return {
    level,
    complex,
    pass,
    missing,
    weakHints,
    label: labels[level] || "太弱",
  };
}

/** 5 段分色条的每段颜色（索引 0~4） */
export const STRENGTH_COLORS = ["#ff4d4f", "#ff7a45", "#ffa940", "#95de64", "#52c41a"];
