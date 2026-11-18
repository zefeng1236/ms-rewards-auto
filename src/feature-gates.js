/**
 * 功能发布闸门（2026-11-04）
 *
 * 为什么要有这个文件：某些功能代码已经写完了，但还没准备好上线 ——
 * 需要一个**单一真源**来关掉它，而不是在界面、主进程、任务执行器里各写一遍
 * `if (false)`。散着写必然漏一处，而这类漏法极难自查：
 * 界面灰了但后台照跑、或者反过来，用户看到的和实际发生的不一致。
 *
 * 2026-11-18：桌面 Rewards 应用专属任务已解除闸门（连续 5 次真机验证通过）。
 * 本文件保留作**紧急回滚开关**：改回 true 即可一次性把界面 / 探测 / 执行 / 汇总
 * 全部关停；selfcheck 有守卫盯住这个值，别悄悄改。
 *
 * 用法（闸门关闭时）：
 *   · 界面：入口置灰 + 标「测试中 · 延迟上线」
 *   · 主进程：detect / 执行一律返回不可用
 *   · 任务执行器：直接 skip，不发请求、不启动外部程序
 *
 * ⚠️ 这个模块**必须同时被渲染层和主进程读到同一份值**。
 *    渲染层通过 IPC 拿状态，不自己写常量（否则改一处漏一处）。
 */

/**
 * 桌面 Rewards 应用专属任务：2026-11-18 解除闸门，随下一版上线。
 * 依据：11-07~11-15 连续 5 次真机验证（冷启动 15.1s、真实点击到账 +10 分、
 * 服务器 punchcard 进度上涨、兑换类领取跳过、跨天冷却正确）。
 * ⚠️ 上线后仍需留意：ensureStarted 会重启用户当前开着的 Rewards 应用。
 */
const DESKTOP_APP_DELAYED = false;

/** 延迟上线功能的说明文案（界面与日志共用，避免两处措辞不一致） */
const DESKTOP_APP_DELAY_NOTE = "该功能正在测试中，暂缓上线";

/**
 * 是否允许使用「桌面应用专属任务」
 * @returns {{ allowed: boolean, note: string }}
 */
function desktopAppGate() {
  return { allowed: !DESKTOP_APP_DELAYED, note: DESKTOP_APP_DELAYED ? DESKTOP_APP_DELAY_NOTE : "" };
}

module.exports = { DESKTOP_APP_DELAYED, DESKTOP_APP_DELAY_NOTE, desktopAppGate };
