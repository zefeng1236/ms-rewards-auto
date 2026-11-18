/**
 * 桌面专属任务：远程规则 → 生效参数的唯一解析点（2026-11-18）。
 *
 * 【为什么单独一个模块】
 * 规则文件里早写了一批字段（startTimeoutMs / minRenderChars / maxWaitMs /
 * dwellMs / dwellRounds），但代码里全是硬编码，等于远程调了没用 —— 真正能热更新的
 * 只有 3 个参数。把解析与钳制集中到这里，驱动（desktop-app.js）和熔断
 * （runner.js → desktop-circuit.js）读同一份结果，不会一处改了另一处漏。
 *
 * 【安全边界】
 * 只解析「时长 / 次数 / 阈值」这类数值与布尔。选择器模板、正则片段、URL 一律
 * 留在代码里当行为边界：远程规则能被 GitHub 侧影响，让它改「怎么判断计分」
 * 比让它改「等多久」危险得多（见 plugin-rules.js 顶部注释）。
 *
 * 所有数值都做范围钳制，非法值回落内置默认 —— 即便远程规则被换成坏值、
 * 或绕过 validate 直接塞进来，也不会把流程搞成 0ms 空转 / 无限等待。
 */
"use strict";

const DEFAULTS = {
  renderWaitMs: 18000,
  startTimeoutMs: 30000,
  restartMaxTimes: 1,
  circuitMaxFailures: 3,
  circuitCountEnvFailures: true,
  minRenderChars: 300,
  cardMaxWaitMs: 40000,
  dwellMs: 2500,
  dwellRounds: 3,
};

/** 数值钳制：非有限数 / 越界 → 默认值 */
function num(v, def, min, max) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
}

/**
 * @param {object} [rules] 生效规则（远程优先、内置兜底）
 * @returns {object} 已钳制的参数集合
 */
function effectiveRuntime(rules) {
  const rt = (rules && rules.runtime) || {};
  const quest = (rules && rules.quest) || {};
  const card = (rules && rules.card) || {};
  const landing = (rules && rules.landing) || {};
  return {
    renderWaitMs: num(rt.renderWaitMs, DEFAULTS.renderWaitMs, 5000, 120000),
    startTimeoutMs: num(rt.startTimeoutMs, DEFAULTS.startTimeoutMs, 5000, 120000),
    restartMaxTimes: Math.floor(num(rt.restartMaxTimes, DEFAULTS.restartMaxTimes, 0, 5)),
    circuitMaxFailures: Math.floor(num(rt.circuitMaxFailures, DEFAULTS.circuitMaxFailures, 1, 10)),
    circuitCountEnvFailures: rt.circuitCountEnvFailures !== false,
    minRenderChars: Math.floor(num(quest.minRenderChars, DEFAULTS.minRenderChars, 50, 5000)),
    cardMaxWaitMs: num(card.maxWaitMs, DEFAULTS.cardMaxWaitMs, 5000, 180000),
    dwellMs: num(landing.dwellMs, DEFAULTS.dwellMs, 0, 30000),
    dwellRounds: Math.floor(num(landing.dwellRounds, DEFAULTS.dwellRounds, 0, 20)),
  };
}

/** 只给熔断用的两个参数（runner 侧读同一份解析结果） */
function circuitOptions(rules) {
  const r = effectiveRuntime(rules);
  return {
    maxFailures: r.circuitMaxFailures,
    countEnvFailures: r.circuitCountEnvFailures,
  };
}

module.exports = {
  DEFAULTS,
  num,
  effectiveRuntime,
  circuitOptions,
};
