/**
 * 功能发布闸门（2026-11-04）
 *
 * 为什么要有这个文件：某些功能代码已经写完了，但还没准备好上线 ——
 * 需要一个**单一真源**来关掉它，而不是在界面、主进程、任务执行器里各写一遍
 * `if (false)`。散着写必然漏一处，而这类漏法极难自查：
 * 界面灰了但后台照跑、或者反过来，用户看到的和实际发生的不一致。
 *
 * 用法：
 *   · 界面：入口置灰 + 标「测试中 · 延迟上线」
 *   · 主进程：detect / 执行一律返回不可用
 *   · 任务执行器：直接 skip，不发请求、不启动外部程序
 *
 * ⚠️ 这个模块**必须同时被渲染层和主进程读到同一份值**。
 *    渲染层通过 IPC 拿状态，不自己写常量（否则改一处漏一处）。
 */

/** 桌面 Rewards 应用专属任务：功能已完成，但暂时不上线 */
const DESKTOP_APP_DELAYED = true;

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
