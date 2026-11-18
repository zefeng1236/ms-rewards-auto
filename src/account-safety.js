/**
 * 账号安全闸门（2026-11-17）。
 *
 * 用户硬约束：测试号可以随便用，但**绝不能把号搞封**。本模块把「别封号」从
 * 口头注意事项变成写入路径上的硬校验 —— 任何真实 Server Action 上报都必须
 * 先过这里，过不了就一个 POST 都不发。
 *
 * 六道闸：
 *  ① 数据源必须是 /api/getuserinfo。flyout 兜底源没有 userWarnings / punchcard
 *     完成态，信息不足时一律拒写（只读盘点仍可正常展示）。
 *  ② 命中明确风控警告（Fraud_UserWarning_BotScore_UX 等）→ 拒写，与 runner
 *     的整轮暂停同一判据。机器人评分只记录不拦截：真机 0.09、离线样例 17，
 *     量纲不明确，按数值卡阈值会误伤。
 *  ③ 单轮写入硬上限：默认 1，显式 allowBulk 时最多 3。绝不连发 10 个 POST。
 *  ④ 按账号 + offerId 冷却（20 小时，跨天自动失效），并且同一账号两次写之间
 *     至少隔 10 分钟 —— 换了活动也不能短时间内连发。**写前先落账**，即使
 *     请求超时/失败也不重发，避免服务端状态未知时重复上报。
 *  ⑤ 开关型动作（连胜保护 toggle）默认不自动写 —— 它是「切换」语义，
 *     状态判错可能把已开启的保护关掉。
 *  ⑥ 两次写之间随机间隔 3~8 秒，模拟人工节奏；每次写留审计日志（不含
 *     cookie / hash / 任何凭据）。
 *
 * 账本按 accountId 哈希分文件、原子写、损坏时 fail-closed（宁可这轮不写）。
 * 纯函数与账本读写分离，可离线打桩测试，不联网、不碰账号。
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const logger = require("./logger");
const riskSignals = require("./risk-signals");
const storagePath = require("./storage-path");

const DEFAULT_MAX_WRITES = 1;
const HARD_MAX_WRITES = 3;
const COOLDOWN_MS = 20 * 3600 * 1000;
/** 账号级最小写间隔：同一账号两次写之间至少隔 10 分钟，防止定时任务重复触发时连发 */
const ACCOUNT_COOLDOWN_MS = 10 * 60 * 1000;
const TOGGLE_KINDS = new Set(["streakProtection"]);

function accountKey(accountId) {
  return crypto.createHash("sha256").update(String(accountId || "default")).digest("hex").slice(0, 12);
}

function ledgerPath(accountId, dir) {
  const name = `activity-writes-${accountKey(accountId)}.json`;
  return dir ? path.join(dir, name) : storagePath.resolve(name);
}

/** 读取当天账本；跨天自动清空；文件损坏时 fail-closed 拒绝写 */
function readLedger(accountId, opts = {}) {
  const nowMs = Number(opts.nowMs) > 0 ? Number(opts.nowMs) : Date.now();
  const date = new Date(nowMs).toLocaleDateString("sv-SE");
  const file = ledgerPath(accountId, opts.ledgerDir);
  const empty = { ok: true, date, entries: {}, lastWriteAt: 0, file };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return empty;
    logger.warn(`活动写入账本不可读，本轮拒绝写操作: ${String((e && e.message) || e).slice(0, 80)}`);
    return { ...empty, ok: false, reason: "活动写入账本不可读" };
  }
  try {
    const j = JSON.parse(raw);
    if (j && j.date === date && j.entries && typeof j.entries === "object" && !Array.isArray(j.entries)) {
      return { ok: true, date, entries: j.entries, lastWriteAt: Number(j.lastWriteAt) || 0, file };
    }
    return empty;
  } catch {
    logger.warn("活动写入账本损坏，本轮拒绝写操作");
    return { ...empty, ok: false, reason: "活动写入账本损坏" };
  }
}

function isCoolingDown(ledger, offerId, nowMs = Date.now()) {
  const t = Number((ledger.entries || {})[String(offerId)] || 0);
  return t > 0 && nowMs - t < COOLDOWN_MS;
}

/** 写前落账：原子写，失败也不重发 */
function markWrite(ledger, offerId, nowMs = Date.now()) {
  ledger.entries[String(offerId)] = Number(nowMs);
  ledger.lastWriteAt = Number(nowMs);
  const payload = JSON.stringify(
    { date: ledger.date, lastWriteAt: ledger.lastWriteAt, entries: ledger.entries }, null, 2
  );
  fs.mkdirSync(path.dirname(ledger.file), { recursive: true });
  const tmp = `${ledger.file}.tmp`;
  fs.writeFileSync(tmp, payload);
  fs.renameSync(tmp, ledger.file);
  return ledger;
}

/** ① 数据源 + ② 风控：只认明确警告名，数值评分只记录不拦截 */
function checkRisk(dash, opts = {}) {
  const d = dash || {};
  if (opts.requireGetuserinfo !== false && d.source !== "getuserinfo") {
    return { allow: false, reason: "数据源不是 /api/getuserinfo，风控与完成态信息不足，拒绝写操作" };
  }
  const verdict = riskSignals.shouldPauseAccount({ warnings: d.warnings || [], botScore: d.botScore });
  if (verdict.pause) return { allow: false, reason: verdict.reason, botScore: d.botScore ?? null };
  return { allow: true, reason: "", botScore: d.botScore ?? null };
}

/**
 * 把待办过滤成「本轮可安全执行」的动作。
 * @returns {{allowed:object[], skipped:{offerId:string,reason:string}[], reason:string,
 *            ledger:object|null, risk:object}}
 */
function planWrites(pending, dash, opts = {}) {
  const accountId = opts.accountId || "default";
  const nowMs = Number(opts.nowMs) > 0 ? Number(opts.nowMs) : Date.now();
  const risk = checkRisk(dash, opts);
  if (!risk.allow) return { allowed: [], skipped: [], reason: risk.reason, ledger: null, risk };

  const ledger = readLedger(accountId, opts);
  if (!ledger.ok) {
    return { allowed: [], skipped: [], reason: ledger.reason || "活动写入账本不可用", ledger: null, risk };
  }
  // 账号级间隔：即使换了活动，短时间内也不连发第二个 POST
  if (ledger.lastWriteAt > 0 && nowMs - ledger.lastWriteAt < ACCOUNT_COOLDOWN_MS) {
    const mins = Math.ceil((ACCOUNT_COOLDOWN_MS - (nowMs - ledger.lastWriteAt)) / 60000);
    return {
      allowed: [], skipped: [], ledger, risk,
      reason: `账号级写入冷却中（距上次写不足 10 分钟，还需约 ${mins} 分钟）`,
    };
  }

  let max = Number(opts.maxWrites) > 0 ? Math.floor(Number(opts.maxWrites)) : DEFAULT_MAX_WRITES;
  if (!opts.allowBulk) max = Math.min(max, DEFAULT_MAX_WRITES);
  max = Math.min(max, HARD_MAX_WRITES);

  const allowed = [];
  const skipped = [];
  for (const item of pending || []) {
    if (allowed.length >= max) {
      skipped.push({ offerId: item.offerId, reason: `单轮写入上限 ${max}` });
      continue;
    }
    if (TOGGLE_KINDS.has(item.kind) && opts.allowToggleWrite !== true) {
      skipped.push({ offerId: item.offerId, reason: "开关型动作默认不自动写" });
      continue;
    }
    if (isCoolingDown(ledger, item.offerId, nowMs)) {
      skipped.push({ offerId: item.offerId, reason: "冷却期内，避免重复上报" });
      continue;
    }
    allowed.push(item);
  }
  return { allowed, skipped, reason: "", ledger, risk };
}

/** 两次写之间的拟人间隔；gapMs=0 供离线测试跳过等待 */
function nextGapMs(opts = {}) {
  if (opts.gapMs === 0) return 0;
  if (Number(opts.gapMs) > 0) return Number(opts.gapMs);
  return 3000 + Math.floor(Math.random() * 5000);
}

async function pace(opts = {}) {
  const ms = nextGapMs(opts);
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

/** 审计日志：只记账号哈希 / 类型 / offer 前 48 字符 / 结果，绝不输出凭据 */
function auditWrite(accountId, item, result) {
  logger.info(
    `[账号安全] 写 account=${accountKey(accountId)} kind=${item.kind} ` +
    `offer=${String(item.offerId).slice(0, 48)} status=${result.status} ok=${result.ok}`
  );
}

module.exports = {
  DEFAULT_MAX_WRITES,
  HARD_MAX_WRITES,
  COOLDOWN_MS,
  ACCOUNT_COOLDOWN_MS,
  TOGGLE_KINDS,
  accountKey,
  ledgerPath,
  readLedger,
  isCoolingDown,
  markWrite,
  checkRisk,
  planWrites,
  nextGapMs,
  pace,
  auditWrite,
};
