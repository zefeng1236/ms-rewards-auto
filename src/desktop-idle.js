/**
 * 桌面任务空闲触发器（2026-11-19，仅桌面版）。
 *
 * 【为什么按空闲触发】驱动每做一项就重启一次 Rewards 应用、必然弹窗抢焦点，
 * 最小化会塌视口、另开虚拟桌面会被每次重启拽回来 —— 都治不了本。唯一不打断
 * 工作的办法是挑用户不在的时候跑。三种模式（2026-11-19 用户定，默认先通知）：
 *   notify ——（默认）空闲达标发系统通知，用户点通知打开软件授权后才执行；
 *   auto   —— 键鼠空闲 ≥ idleMinutes 自动执行；
 *   manual —— 仅限手动：空闲触发器不触发（本模块只回 none），
 *              由账户详情「执行桌面任务」按钮手动跑（按账号每天 1 次）。
 * 三种方案执行完都由 runDesktopTask 调 stop() 结束 Rewards 进程。
 *
 * 【本模块是纯逻辑状态机】依赖注入（readIdle / getConfig / isBusy），不碰 Electron、
 * 不发通知、不跑任务 —— 那些由主进程按 tick() 返回的 action 去做。这样能离线测试。
 *
 * 【episode 语义】一次「空闲达标」算一个 episode，只触发一次（auto 跑一次 / notify
 * 通知一次），避免每 30 秒巡检都重复跑/重复弹通知。用户恢复操作（空闲 < 阈值）即
 * 复位，下次再空闲算新 episode。读不到空闲(null)一律不动作（fail-open，不误触发）。
 */
"use strict";

/**
 * @param {{ readIdle: () => (number|null), getConfig: () => object, isBusy?: () => boolean }} deps
 *   getConfig 返回 { enabled, mode: "notify"|"auto"|"manual", idleMinutes }
 */
function createDesktopIdleWatcher(deps = {}) {
  let episodeHandled = false;

  function tick() {
    const cfg = (deps.getConfig && deps.getConfig()) || {};
    if (!cfg.enabled) {
      episodeHandled = false;
      return { action: "none", reason: "disabled" };
    }
    // manual = 仅限手动（2026-11-19 用户定）：空闲触发器完全不动作，
    // 执行只走账户详情「执行桌面任务」按钮（runDesktopManual，按账号每天 1 次）。
    if (cfg.mode === "manual") {
      episodeHandled = false;
      return { action: "none", reason: "manual" };
    }
    const idle = deps.readIdle ? deps.readIdle() : null;
    if (idle === null || idle === undefined || !Number.isFinite(Number(idle))) {
      return { action: "none", reason: "idle-unknown" };
    }
    const threshold = Number(cfg.idleMinutes) > 0 ? Number(cfg.idleMinutes) : 5;
    if (Number(idle) < threshold) {
      episodeHandled = false; // 用户回到电脑前 → 复位，下次空闲再触发
      return { action: "none", reason: "user-active" };
    }
    if (episodeHandled) return { action: "none", reason: "episode-handled" };
    if (deps.isBusy && deps.isBusy()) return { action: "none", reason: "busy" };
    episodeHandled = true;
    if (cfg.mode === "notify") return { action: "notify", idle: Number(idle), threshold };
    return { action: "run", idle: Number(idle), threshold };
  }

  /** 通知被点击 → 授权执行（用户明确同意，不受 episode / 空闲限制）。 */
  function authorize() {
    return { action: "run", authorized: true };
  }

  function reset() {
    episodeHandled = false;
  }

  return { tick, authorize, reset };
}

module.exports = { createDesktopIdleWatcher };
