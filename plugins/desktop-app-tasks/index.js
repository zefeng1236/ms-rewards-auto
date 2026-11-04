/**
 * 插件入口：桌面应用专属任务
 *
 * 这个插件本身很薄 —— 真正的驱动逻辑在 src/desktop-app.js（那是「怎么点」），
 * 插件这层负责「点哪些、什么时候点、用什么参数」（来自 rules）。
 *
 * 拆开的理由：活动规则每周都在变，改规则不该发新版本。规则走远程热更新
 * （见 src/plugin-rules.js），代码保持稳定。
 */

const desktopApp = require("../../src/desktop-app");

module.exports = {
  id: "desktop-app-tasks",

  /**
   * @param {object} ctx 账户上下文（含 config / state）
   * @param {object} rules 生效规则（远程优先，内置兜底）
   * @param {{ onLog?: Function, dryRun?: boolean, maxItems?: number }} opts
   */
  async run(ctx, rules, opts = {}) {
    const runtime = (rules && rules.runtime) || {};
    return desktopApp.runDesktopApp(ctx, {
      ...opts,
      rules,
      maxItems: opts.maxItems != null ? opts.maxItems : runtime.maxItemsPerRun || 1,
    });
  },
};
