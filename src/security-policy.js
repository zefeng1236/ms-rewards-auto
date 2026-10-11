const globalConfig = require("./global-config");

/**
 * 安全策略（2026-10-11 安全中心第三层）。
 *
 * 三档，语义参照 Claude Code / Cursor 那类 AI 编程工具的权限模式 ——
 * 但**用途不同**，说清楚免得误解：
 *
 *   ask    询问审批：命中敏感操作时**先问过用户**再执行。
 *                 桌面软件没有"等待审批"的交互位置（用户可能已经关窗口了），
 *                 所以这里的 ask 实现为：**拒绝 + 记审计 + 在界面上留待办提示**，
 *                 由用户回到「安全中心」面板显式放行。不阻塞任务，也不假装能弹窗。
 *   auto   自动通过：命中敏感操作直接执行，但**一定记审计**。这是默认值。
 *   full   完全访问：全部放行且**不记**敏感操作审计（越界拦截仍然生效 ——
 *                 那是路径边界层的职责，与策略无关）。
 *
 * ⚠️ **策略不覆盖路径边界**：`sp.resolve("../..")` 在任何档位下都会被拒。
 *    策略管的是「合不合法的事要不要问」，越界是「不合法」，两件事。
 *    任何人以为把策略调到 full 就能越界，会立刻撞墙（这是有意为之）。
 *
 * @see 行为落点是 security-audit.js 记录，本模块只决定「要不要问 / 记不记」。
 */

const MODES = ["ask", "auto", "full"];
const DEFAULT_MODE = "auto";

function normalizeMode(value) {
  const v = String(value == null ? "" : value).trim().toLowerCase();
  return MODES.includes(v) ? v : DEFAULT_MODE;
}

/** 读当前策略（从全局配置里挂，缺字段回落默认） */
function get() {
  try {
    const saved = globalConfig.get()?.security?.approvalMode;
    return { mode: normalizeMode(saved) };
  } catch {
    return { mode: DEFAULT_MODE };
  }
}

/**
 * 写入策略。
 * @param {string|{mode?: string}} next
 * @returns {{mode: string}} 实际生效的模式（非法值回落默认）
 */
function set(next) {
  const raw = next && typeof next === "object" ? next.mode : next;
  const mode = normalizeMode(raw);
  const cfg = globalConfig.get();
  // 整对象 merge 落盘（见 global-config.js），这里只需给出要改的字段
  globalConfig.set({ security: { ...(cfg.security || {}), approvalMode: mode } });
  return { mode };
}

/**
 * 某类敏感操作在当前策略下要不要「先问」。
 * @param {"delete"|"spawn"|"deny"} kind
 * @returns {{needApproval: boolean, record: boolean, mode: string}}
 */
function decide(kind) {
  const { mode } = get();
  return {
    mode,
    // 只有 ask 档需要用户表态；auto/full 都直接放行
    needApproval: mode === "ask" && kind !== "deny",
    // full 档不记敏感操作审计（deny 类始终记 —— 有东西在试探边界，这本身就该留痕）
    record: !(mode === "full" && kind !== "deny"),
  };
}

module.exports = { MODES, DEFAULT_MODE, get, set, decide, normalizeMode };
