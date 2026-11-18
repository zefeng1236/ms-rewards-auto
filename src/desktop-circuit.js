/**
 * 桌面专属任务熔断（2026-11-18 用户要求）。
 *
 * 「多次失效」= 连续 N 轮（默认 3）跑不通。跑通一次立刻清零；触发后自动把
 * tasks.desktopApp 关掉并推送说明，避免每轮白跑、反复重启用户开着的 Rewards
 * 应用、或在异常状态下继续对账号点卡片。
 *
 * 什么算「失效」：
 *   · retry（应用未就绪 / 无法接管 CDP / 启动失败 / 页面反复失效）
 *   · error（插件或驱动抛异常）
 *   · skip + notInstalled / notLoggedIn（环境一直不具备，继续跑纯属浪费）
 *   · 其余非 done 结果
 * 不算失效（**不能**因此关开关）：
 *   · skip + disabled / delayed：开关没开或闸门关闭，根本没执行
 *   · 扫描模式（dryRun）：调试，不是任务结果
 *   · status === "done"：含「今天没有可做项」「已点击但未到账」—— 脚本跑通了，
 *     那是活动本身的特性，不是脚本失效
 *
 * ⚠️ 关闭开关有两个坑（src/config.js 注释里写明）：
 *   set() 只写账户自己的 config.json；账户默认 useGlobal=true 时，账户级写入
 *   会被 global-config 覆盖 ⇒ 只写账户等于没关。所以必须**账户级 + 全局级双写**，
 *   再 load() 刷新缓存。不改 useGlobal 本身，避免悄悄改变用户的设置模式。
 *
 * 账本按账号哈希分文件、原子写、跨天累计（只有成功 / 手动重开才清零）、
 * 损坏时 fail-safe（当空账本，绝不误关开关）。
 * 用户手动重开开关后自动「重新武装」：清计数、重新给 N 次机会。
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const logger = require("./logger");
const sp = require("./storage-path");
const globalConfig = require("./global-config");

const MAX_CONSECUTIVE_FAILURES = 3;

function accountKey(accountId) {
  return crypto.createHash("sha256").update(String(accountId || "default")).digest("hex").slice(0, 12);
}

function ledgerPath(accountId, dir) {
  const name = `desktop-circuit-${accountKey(accountId)}.json`;
  return dir ? path.join(dir, name) : sp.resolve(name);
}

/** 账本损坏 / 不可读时返回空账本：宁可晚一点触发，也不能误关用户开关 */
function readLedger(accountId, opts = {}) {
  const file = ledgerPath(accountId, opts.ledgerDir);
  const empty = { consecutive: 0, lastReason: "", lastAt: 0, tripped: false, file };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return empty;
  }
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return empty;
    return {
      consecutive: Number(j.consecutive) || 0,
      lastReason: String(j.lastReason || ""),
      lastAt: Number(j.lastAt) || 0,
      tripped: j.tripped === true,
      rearmedAt: Number(j.rearmedAt) || 0,
      disabledAt: Number(j.disabledAt) || 0,
      file,
    };
  } catch {
    logger.warn("桌面任务熔断账本损坏，已按空账本处理（不会误关开关）");
    return empty;
  }
}

function writeLedger(ledger, opts = {}) {
  const { file, ...data } = ledger;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
  return ledger;
}

function isFailure(r, opts = {}) {
  if (!r || typeof r !== "object") return false;
  if (r.disabled || r.delayed) return false;
  if (r.reason === "扫描模式") return false;
  if (r.status === "done") return false;
  // 环境一直不具备（未安装 / 桌面应用未登录）是否算「脚本失效」可远程配置：
  // 关掉后只累计 retry / error，避免用户暂时没装应用就把开关熔断。
  if (opts.countEnvFailures === false && (r.notInstalled || r.notLoggedIn)) return false;
  return true;
}

function reasonOf(r) {
  return String((r && (r.reason || r.error || r.status)) || "未知原因").slice(0, 100);
}

function isSwitchOn(ctx) {
  try {
    const c = ctx && ctx.config ? ctx.config.get() : null;
    return Boolean(c && c.tasks && c.tasks.desktopApp);
  } catch {
    return false;
  }
}

/**
 * 自动关闭执行开关。返回诊断信息，供日志/测试断言。
 * @param {object} ctx 账户上下文
 * @param {object} [deps] 可注入 globalConfig（离线测试用），避免写真实配置文件
 */
function disableSwitch(ctx, deps = {}) {
  const gc = deps.globalConfig || globalConfig;
  const cfg = ctx && ctx.config ? ctx.config.get() : {};
  const useGlobal = cfg.useGlobal !== false;
  let accountWritten = false;
  let globalWritten = false;
  // ① 账户级一定写：用户之后切到「独立设置」时也保持关闭
  try {
    ctx.config.set({ tasks: { desktopApp: false } });
    accountWritten = true;
  } catch (e) {
    logger.warn(`关闭账户级桌面任务开关失败: ${String((e && e.message) || e).slice(0, 80)}`);
  }
  // ② 遵循全局时，账户级写入会被覆盖，必须同时关全局
  if (useGlobal) {
    try {
      gc.set({ tasks: { desktopApp: false } });
      globalWritten = true;
    } catch (e) {
      logger.warn(`关闭全局桌面任务开关失败: ${String((e && e.message) || e).slice(0, 80)}`);
    }
  }
  // ③ 刷新有效配置缓存，保证本进程后续读到的也是「已关闭」
  try { ctx.config.load(); } catch { /* 预览/桩环境可能没有 load */ }
  return { useGlobal, accountWritten, globalWritten, ok: accountWritten && (!useGlobal || globalWritten) };
}

/**
 * 记录一轮结果并决定是否熔断。
 * @param {object} ctx 账户上下文
 * @param {object} result runDesktopApp / 插件的返回对象
 * @param {object} [opts] ledgerDir / maxFailures / nowMs / accountId / disable（注入）
 */
function record(ctx, result, opts = {}) {
  const accountId = opts.accountId || ctx.id || "default";
  // 阈值可来自远程规则（desktop-runtime.circuitOptions），但必须在 1~10 内：
  // 远程写 0 会每轮立刻熔断，写 999 等于永不熔断，两者都不能放行。
  const rawMax = Number(opts.maxFailures);
  const max = Number.isFinite(rawMax) && rawMax > 0
    ? Math.min(10, Math.floor(rawMax))
    : MAX_CONSECUTIVE_FAILURES;
  const nowMs = Number(opts.nowMs) > 0 ? Number(opts.nowMs) : Date.now();
  const ledger = readLedger(accountId, opts);

  // 根本没执行：开关没开 / 闸门关闭 / 调试扫描 → 不动账本
  if (!result || result.disabled || result.delayed || result.reason === "扫描模式") {
    return { skipped: true, tripped: false };
  }

  // 已熔断：用户手动重开 → 重新武装；否则保持关闭且不重复推送
  if (ledger.tripped) {
    if (isSwitchOn(ctx)) {
      ledger.consecutive = 0;
      ledger.lastReason = "";
      ledger.tripped = false;
      ledger.rearmedAt = nowMs;
      writeLedger(ledger, opts);
      logger.info("桌面专属任务开关已由用户手动重开，熔断计数已清零");
      return { rearmed: true, tripped: false, consecutive: 0 };
    }
    return {
      tripped: true, already: true,
      consecutive: ledger.consecutive, lastReason: ledger.lastReason,
    };
  }

  // 跑通一次就清零（含「今天没有可做项」）
  if (result.status === "done") {
    if (ledger.consecutive !== 0 || ledger.lastReason) {
      ledger.consecutive = 0;
      ledger.lastReason = "";
      writeLedger(ledger, opts);
    }
    return { tripped: false, consecutive: 0, reset: true };
  }
  if (!isFailure(result, opts)) return { skipped: true, tripped: false };

  ledger.consecutive = (Number(ledger.consecutive) || 0) + 1;
  ledger.lastReason = reasonOf(result);
  ledger.lastAt = nowMs;
  if (ledger.consecutive >= max) {
    ledger.tripped = true;
    ledger.disabledAt = nowMs;
    writeLedger(ledger, opts);
    const disable = typeof opts.disable === "function" ? opts.disable : disableSwitch;
    const written = disable(ctx) || {};
    return {
      tripped: true, consecutive: ledger.consecutive,
      lastReason: ledger.lastReason, ...written,
    };
  }
  writeLedger(ledger, opts);
  return {
    tripped: false, consecutive: ledger.consecutive,
    remaining: max - ledger.consecutive, lastReason: ledger.lastReason,
  };
}

module.exports = {
  MAX_CONSECUTIVE_FAILURES,
  accountKey,
  ledgerPath,
  readLedger,
  writeLedger,
  isFailure,
  reasonOf,
  disableSwitch,
  record,
};
