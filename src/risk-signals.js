/**
 * 风控信号解析（2026-11-17 竞品分析后第一批增强）。
 *
 * 微软会在 rewards dashboard / dapi/me 响应里下发机器人评分（serpbotscore）与
 * userWarnings。命中 Fraud_UserWarning_BotScore_UX 说明该账号已被降权，继续
 * 自动跑任务只会加重风控 —— 应当整轮暂停并明确告知用户。
 *
 * 纯字符串/对象解析：不联网、不依赖浏览器，可离线打桩测试。
 * 判据刻意保守：只有「明确的风控警告名」才暂停；未知警告、高分值只记录不拦截，
 * 避免把一次误判变成「账号整天不跑」。
 */
"use strict";

const BOT_WARNING = "Fraud_UserWarning_BotScore_UX";
const KNOWN_WARNINGS = [BOT_WARNING, "Fraud_UserWarning_BotScore", "Fraud_UserWarning"];
const SCORE_KEYS = ["serpbotscore", "serpBotScore", "SerpBotScore"];
const SCORE_UPDATED_KEYS = ["serpbotscore_upd", "serpBotScore_upd", "SerpBotScore_upd"];

/** 从任意嵌套对象里收集警告名（只认常见的 warnings 容器，避免全量深挖） */
function collectWarningNames(value, out = new Set(), depth = 0) {
  if (value == null || depth > 6) return out;
  if (Array.isArray(value)) {
    for (const v of value) collectWarningNames(v, out, depth + 1);
    return out;
  }
  if (typeof value === "object") {
    if (typeof value.name === "string" && /warning|fraud|botscore/i.test(value.name)) out.add(value.name);
    for (const k of Object.keys(value)) {
      const v = value[k];
      if (v && typeof v === "object") collectWarningNames(v, out, depth + 1);
      else if (typeof v === "string" && /warning|fraud|botscore/i.test(k)) collectWarningNames(v, out, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    for (const name of KNOWN_WARNINGS) if (value.includes(name)) out.add(name);
  }
  return out;
}

function findNumberByKeys(obj, keys, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return null;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (keys.includes(k) && v != null && Number.isFinite(Number(v))) return Number(v);
    if (v && typeof v === "object") {
      const found = findNumberByKeys(v, keys, depth + 1);
      if (found != null) return found;
    }
  }
  return null;
}

/**
 * @param {object|string} input JSON 对象、JSON 文本或 earn 页 HTML/RSC 文本
 * @returns {{warnings:string[], botScore:number|null, scoreUpdated:string|null,
 *            limited:boolean, observed:boolean}}
 */
function parseRiskSignals(input) {
  let data = input;
  let text = "";
  if (typeof input === "string") {
    text = input;
    try { data = JSON.parse(input); } catch { data = null; }
  } else if (input && typeof input === "object") {
    try { text = JSON.stringify(input); } catch { text = ""; }
  } else {
    data = null;
  }

  const warnings = new Set();
  collectWarningNames(data, warnings);
  // HTML / RSC 里警告名常常只以裸字符串出现，JSON.parse 会失败
  for (const name of KNOWN_WARNINGS) if (text.includes(name)) warnings.add(name);

  let score = findNumberByKeys(data, SCORE_KEYS);
  if (score == null) {
    const m = /"?(?:serpbotscore|SerpBotScore|serpBotScore)"?\s*[:=]\s*"?(-?\d+(?:\.\d+)?)/i.exec(text);
    if (m) score = Number(m[1]);
  }
  let scoreUpdated = null;
  for (const key of SCORE_UPDATED_KEYS) {
    const m = new RegExp(`"?${key}"?\\s*[:=]\\s*"?([^",}\\s]+)`, "i").exec(text);
    if (m) { scoreUpdated = m[1]; break; }
  }

  const list = [...warnings];
  return {
    warnings: list,
    botScore: score,
    scoreUpdated,
    limited: list.some((w) => KNOWN_WARNINGS.includes(w)),
    observed: list.length > 0 || score != null || scoreUpdated != null,
  };
}

/** 是否暂停该账号本轮任务。只有明确警告才暂停。 */
function shouldPauseAccount(signals, opts = {}) {
  const s = signals || {};
  const hits = (s.warnings || []).filter((w) => KNOWN_WARNINGS.includes(w));
  if (!hits.length) return { pause: false, reason: "", warnings: [] };
  const scoreText = s.botScore != null ? `（机器人评分 ${s.botScore}）` : "";
  return {
    pause: true,
    warnings: hits,
    reason:
      `检测到微软风控警告 ${hits.join("、")}${scoreText}，已暂停本轮任务；` +
      "继续自动化只会加重降权。请先在浏览器里人工正常使用该账号，" +
      "确认警告消除后再恢复自动运行。",
  };
}

module.exports = {
  BOT_WARNING,
  KNOWN_WARNINGS,
  parseRiskSignals,
  shouldPauseAccount,
};
