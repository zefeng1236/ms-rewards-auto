/**
 * 「通知被点击」的启动参数识别（2026-11-21 真机实证）。
 *
 * 【为什么要识别启动参数】Windows 上点击通知（尤其是已经从横幅收进「操作中心」的
 * 那一条）**不是**直接调用创建 toast 的那个进程里的 click 回调，而是走激活：
 *   ① COM 激活 —— 系统启动 exe 并带 `-Embedding`（LocalServer32 当 COM 服务器拉起）；
 *   ② 快捷方式激活 —— 系统按 AUMID 找到开始菜单快捷方式，用它的参数启动，通常带
 *      `-ToastActivated`；
 *   ③ 协议激活（2026-11-24 起，取代前两种）—— 原生 toast 带
 *      `activationType="protocol" launch="msrewards://desktop-authorize"`，
 *      Windows 用 URL 协议启动 exe，参数就是这个 URL，**不带 `-Embedding`**，
 *      进程能正常跑到 JS。前两条在本机实测都走不通（COM 会被 Chromium exit 9 杀掉，
 *      快捷方式又缺 ToastActivatorCLSID），见 desktop-toast.js 顶部复盘。
 * 三种方式都会**新起一个进程**。也就是说，持有 toast 的那个老进程永远收不到
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

/**
 * 「用户点了原生 Toast」的协议激活参数（2026-11-24）。
 *
 * 0.17.0 的 Electron 通知不带 launch，Windows 点击时找不到激活器 —— 既没有
 * click 回调也没有 second-instance。改用 `activationType="protocol"` 的原生
 * Toast 后，Windows 会用 ShellExecute 打开 `msrewards://desktop-authorize`，
 * 启动时把这个 URL 作为普通参数传进来（**不带 -Embedding**，进程能正常跑到 JS）。
 * 这是明确的「用户点了通知」信号，优先级与 -ToastActivated 相同。
 * ⚠️ 正则与 desktop-toast.js 的 PROTOCOL_RE 保持一致（selfcheck 有守卫）。
 */
const PROTOCOL_ACTIVATION_RE = /^msrewards:\/\/desktop-authorize\/?$/i;

/**
 * @param {string[]} argv 进程启动参数
 * @returns {boolean}
 */
function isProtocolActivationArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return false;
  return argv.some((a) => PROTOCOL_ACTIVATION_RE.test(String(a == null ? "" : a).trim()));
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
  // 明确的激活参数优先：老的 COM / 快捷方式标记 + 新的协议激活 URL
  if (isToastActivationArgv(argv) || isProtocolActivationArgv(argv)) return true;
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
  isProtocolActivationArgv,
  shouldAuthorizeFromSecondInstance,
  TOAST_ACTIVATION_RE,
  PROTOCOL_ACTIVATION_RE,
  PENDING_WINDOW_MS,
};
