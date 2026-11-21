/**
 * 「通知被点击」的启动参数识别（2026-11-21 真机实证）。
 *
 * 【为什么要识别启动参数】Windows 上点击通知（尤其是已经从横幅收进「操作中心」的
 * 那一条）**不是**直接调用创建 toast 的那个进程里的 click 回调，而是走激活：
 *   ① COM 激活 —— 系统启动 exe 并带 `-Embedding`（LocalServer32 当 COM 服务器拉起）；
 *   ② 快捷方式激活 —— 系统按 AUMID 找到开始菜单快捷方式，用它的参数启动，通常带
 *      `-ToastActivated`。
 * 两种方式都会**新起一个进程**。也就是说，持有 toast 的那个老进程永远收不到
 * `notification.on("click")`；真正能感知「用户点了通知」的只有这个新进程。
 *
 * 所以新进程必须把「我被通知激活了」这件事转告给已有实例（second-instance），
 * 由它执行授权动作；否则用户点了通知只会看到窗口弹一下、任务并不跑。
 *
 * 本模块只做纯字符串判断，方便离线测试（不依赖 Electron）。
 */
"use strict";

/** `-ToastActivated` / `--toastactivated` / `/ToastActivated` / `-Embedding` */
const TOAST_ACTIVATION_RE = /^(-{1,2}|\/)?(toastactivated|embedding)$/i;

/**
 * 判断启动参数里是否带「通知激活」标记。
 *
 * @param {string[]} argv 进程启动参数（一般为 process.argv）
 * @returns {boolean}
 */
function isToastActivationArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return false;
  return argv.some((a) => TOAST_ACTIVATION_RE.test(String(a == null ? "" : a).trim()));
}

/** 「通知待授权」有效期：用户点通知的动作通常发生在通知发出后的这段时间内 */
const PENDING_WINDOW_MS = 30 * 60 * 1000;

/**
 * 第二个实例被拉起时，是否应当视为「用户授权执行桌面任务」。
 *
 * 【为什么不能只认激活参数】（2026-11-21 真机实证）
 * Windows 走 COM 激活时给进程加 `-Embedding`，而 Chromium 对未知单横线开关
 * **直接致命退出（exit 9）**，JS 一行都跑不到 —— 这条路在 Electron 44 上走不通。
 * 于是退一步：只要「刚发过待授权通知」（默认 30 分钟内），用户把应用唤起来
 * （双击图标 / 点通知不管系统怎么拉起）就当作他点了「授权」。
 *
 * @param {string[]} argv 第二实例的启动参数
 * @param {number} pendingAt 最近一次发出待授权通知的时间戳（毫秒），0 = 没有待授权
 * @param {number} now 当前时间戳（毫秒），便于离线测试注入
 * @param {number} [windowMs] 待授权有效期，默认 30 分钟
 * @returns {boolean}
 */
function shouldAuthorizeFromSecondInstance(argv, pendingAt, now, windowMs) {
  if (isToastActivationArgv(argv)) return true; // 明确的激活参数优先
  const at = Number(pendingAt);
  if (!Number.isFinite(at) || at <= 0) return false;
  const t = Number(now);
  const limit = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0 ? Number(windowMs) : PENDING_WINDOW_MS;
  const nowMs = Number.isFinite(t) && t > 0 ? t : Date.now();
  const elapsed = nowMs - at;
  // 允许 1 分钟时钟抖动；超过有效期视为过期（用户可能几天后才再唤回软件）
  return elapsed >= -60000 && elapsed <= limit;
}

module.exports = {
  isToastActivationArgv,
  shouldAuthorizeFromSecondInstance,
  TOAST_ACTIVATION_RE,
  PENDING_WINDOW_MS,
};
