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
  idleGateMinutes: 3,
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
    idleGateMinutes: num(rt.idleGateMinutes, DEFAULTS.idleGateMinutes, 0, 120),
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

/**
 * 空闲门禁（2026-11-19 用户要求「桌面任务别打断工作」）。
 *
 * 【为什么是空闲才跑，而不是最小化 / 移窗口 / 另开虚拟桌面】
 * 驱动每做完一项就重启一次应用（干净实例 / 水合要求，见 desktop-app.js），
 * 运行期间必然反复弹窗、抢焦点 —— 这是承重设计，去不掉。所以：
 *   · 最小化 / 隐藏：WebView2 视口塌成 40px，点击全超时（2026-11-01 踩），死路；
 *   · 另开虚拟桌面：每次重启都在当前桌面重新激活，要么每项弹一次、要么把人拽去
 *     另一桌面；移窗口还得靠随 Windows 版本变的未文档化 COM + 本机受限的 P/Invoke；
 *   · 移到屏幕外：渲染可行（真机验证过），但每次重启仍会先闪一下抢焦点，治标。
 * 唯一「保证零打断」的办法：只在用户键鼠空闲 ≥ N 分钟时才跑。读不到空闲就放行。
 */

/** 解析 `query user` 输出里当前会话的空闲时间 → 分钟数；读不出返回 null。 */
function parseUserIdleMinutes(out) {
  const lines = String(out || "").split(/\r?\n/);
  const line =
    lines.find((l) => /console/i.test(l)) ||
    lines.find((l) => l.trim().startsWith(">")) ||
    "";
  if (!line) return null;
  // 列：用户名 会话名 ID 状态 空闲时间 登录时间 → 空闲是第 5 列（下标 4）
  const idleTok = line.trim().split(/\s+/)[4];
  if (!idleTok) return null;
  // 正在使用：英文 "." / "none"，中文 locale 显示 "无"
  if (idleTok === "." || /^(none|无)$/i.test(idleTok)) return 0;
  const m = idleTok.match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = m[3] !== undefined ? Number(m[3]) : null;
  return c === null ? a + b / 60 : a * 60 + b + c / 60;
}

/** 读当前会话空闲分钟数。query.exe 退出码可能非 0 但 stdout 可用；失败返回 null（放行）。 */
function readUserIdleMinutes() {
  try {
    const { spawnSync } = require("node:child_process");
    const r = spawnSync("query.exe", ["user"], { timeout: 5000, windowsHide: true });
    const buf = r.stdout;
    if (!buf || !buf.length) return null;
    // 输出是 GBK（中文 locale 空闲列显示 "无"），必须按 GBK 解码，否则 "无" 识别不出。
    let txt;
    try {
      txt = new TextDecoder("gbk").decode(buf);
    } catch {
      txt = buf.toString("latin1");
    }
    return parseUserIdleMinutes(txt);
  } catch {
    return null;
  }
}

/** 是否应因「用户还在用电脑」而延后。gate<=0 关闭；读不到空闲(null)一律放行。 */
function shouldDeferForIdle(idleMinutes, gateMinutes) {
  if (!(Number(gateMinutes) > 0)) return false;
  if (idleMinutes === null || idleMinutes === undefined || !Number.isFinite(Number(idleMinutes))) return false;
  return Number(idleMinutes) < Number(gateMinutes);
}

module.exports = {
  DEFAULTS,
  num,
  effectiveRuntime,
  circuitOptions,
  parseUserIdleMinutes,
  readUserIdleMinutes,
  shouldDeferForIdle,
};
