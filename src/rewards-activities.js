/**
 * 新版 Rewards 活动统一执行器（2026-11-17 真机抓包后实现）。
 *
 * 覆盖：连胜保护、网页 PunchCards、视觉搜索、更多活动 / App 端任务。
 * 全部基于 /api/getuserinfo 的真实数据 + Next.js Server Action 上报，
 * 不靠 HTML 正则猜 offer，也不复制任何第三方实现。
 *
 * ⚠️ 安全约定：
 *   · 默认 dryRun=true —— 只盘点「今天有哪些可做活动」，绝不向账号发 POST。
 *   · 只有调用方显式传 dryRun:false 才执行，且执行后重新拉 dashboard 复核状态，
 *     不拿「请求成功」当「已计分」。
 *   · 写操作必须先过 account-safety 闸门（数据源 / 风控 / 单轮上限 / 冷却 /
 *     开关型动作），过不了就一个 POST 都不发；写前先落账，失败绝不重发。
 *   · 兑换页「最后领取」类（redeem/sku）一律跳过，与桌面应用任务保持一致口径。
 */
"use strict";

const logger = require("./logger");
const next = require("./rewards-next");
const safety = require("./account-safety");

const REDEEM_RE = /redeem\/sku|redeem\/|claimreward/i;
const MAX_ITEMS_PER_RUN = 10;

function timezoneOffset() {
  return String(-new Date().getTimezoneOffset());
}

/** 兑换类最后领取：点了也不计分，需要人工在应用里确认 */
function needsManualClaim(item) {
  return REDEEM_RE.test(`${item.offerId || ""} ${item.destination || ""}`);
}

function activityArgs(item) {
  return [
    item.hash,
    item.activityType,
    {
      offerid: item.offerId,
      isPromotional: item.isPromotional ? true : "$undefined",
      timezoneOffset: timezoneOffset(),
    },
  ];
}

/** 纯函数：把 dashboard 数据结构化成「待办动作」，便于离线断言 */
function collectPending(dash, opts = {}) {
  const d = dash || {};
  const out = [];
  const seen = new Set();
  const max = Number(opts.maxItems) > 0 ? Number(opts.maxItems) : MAX_ITEMS_PER_RUN;

  // ① 连胜保护：未开启且有资格时才需要动作；已开启 / 无剩余天数都不碰
  const sp = d.streakProtection || {};
  if (opts.ensureStreakProtection !== false && sp.on === false && sp.eligible && sp.remainingDays > 0) {
    out.push({
      kind: "streakProtection",
      actionName: "reportToggleStreakProtection",
      offerId: sp.offerId || "StreakProtection_A",
      title: "开启连续打卡保护",
      url: `${next.REWARDS}/earn?section=streaks`,
      tree: next.routerStateTree("earn"),
      args: [true],
    });
  }

  /**
   * 周 punchcard 的子项按星期命名（Monday/Tuesday/...）。getuserinfo 里未来几天
   * 也全是 complete=false，但服务端同一时刻只解锁当天那项（真机 11-17 抓包实证：
   * 7 个 punchcard 一次性给出 6 个「未完成」子项）。不过滤会把整周都报上去。
   * 不含星期名的子项不受影响。
   */
  const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const nowMs = Number(opts.nowMs) > 0 ? Number(opts.nowMs) : Date.now();
  const isAvailableToday = (item) => {
    const m = /(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/i.exec(`${item.offerId || ""} ${item.title || ""}`);
    if (!m) return true;
    return m[1].toLowerCase() === WEEKDAY_NAMES[new Date(nowMs).getDay()];
  };

  const addPromotion = (item, kind, url, tree, parentTitle) => {
    if (!item || !item.hash || item.complete || needsManualClaim(item)) return;
    if (kind === "punchCard" && !isAvailableToday(item)) return;
    if (opts.skipNonPointTasks !== false && item.points <= 0) return;
    const key = item.offerId || item.hash;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      kind,
      actionName: "reportActivity",
      offerId: key,
      hash: item.hash,
      title: item.title || parentTitle || key,
      points: item.points,
      url,
      tree,
      args: activityArgs(item),
    });
  };

  // ② 网页 PunchCards：子项各自上报，URL / tree 用父 quest 页
  if (opts.doPunchCards !== false) {
    for (const card of d.punchCards || []) {
      if (card.complete) continue;
      const parentId = card.offerId || card.name;
      const url = `${next.REWARDS}/earn/quest/${parentId}`;
      const tree = next.questRouterStateTree(parentId);
      for (const child of card.children || []) addPromotion(child, "punchCard", url, tree, card.name);
    }
  }

  // ③ 更多活动 / App 端任务 / 视觉搜索：都走 dashboard 的 reportActivity
  const dashboardUrl = `${next.REWARDS}/dashboard`;
  const dashboardTree = next.routerStateTree("dashboard");
  const extra = [...(d.morePromotions || []), ...(d.promotionalItems || []), ...(d.visualSearch || [])];
  for (const item of extra) {
    const kind = /visual.?search/i.test(`${item.offerId} ${item.title} ${item.promotionType}`)
      ? "visualSearch"
      : /app|dailycheckin|readtoearn|checkin/i.test(`${item.offerId} ${item.title} ${item.promotionType}`)
        ? "app"
        : "promotion";
    addPromotion(item, kind, dashboardUrl, dashboardTree, "");
  }

  return out.slice(0, max);
}

/** 只读盘点摘要（不泄露账号具体值） */
function summarizePending(pending) {
  const byKind = {};
  for (const p of pending) byKind[p.kind] = (byKind[p.kind] || 0) + 1;
  return Object.entries(byKind).map(([k, n]) => `${k}:${n}`).join(" ") || "无";
}

/**
 * @param {object} ctx 账户上下文
 * @param {object} opts dryRun(默认 true) / maxItems / ensureStreakProtection / doPunchCards /
 *                      skipNonPointTasks / request（离线打桩注入）
 */
async function runActivities(ctx, opts = {}) {
  const dryRun = opts.dryRun !== false;
  const fetchOpts = opts.request ? { request: opts.request } : {};
  const before = await next.fetchDashboard(ctx, fetchOpts);
  const report = {
    ok: Boolean(before && before.ok),
    source: before && before.source,
    dryRun,
    streakProtection: before && before.streakProtection,
    punchCardCount: (before && before.punchCards || []).length,
    pending: collectPending(before, opts),
    executed: [],
    reason: before && before.ok ? "" : (before && before.reason) || "数据源不可用",
  };
  if (!report.ok) return report;
  logger.info(`活动盘点(${dryRun ? "只读" : "执行"}): ${summarizePending(report.pending)} | punchcard ${report.punchCardCount} 个`);
  if (dryRun || !report.pending.length) return report;

  // 账号安全闸门：任一条件不过就一个 POST 都不发（用户硬约束：别把号搞封）。
  const plan = safety.planWrites(report.pending, before, {
    accountId: ctx.id,
    nowMs: opts.nowMs,
    maxWrites: opts.maxWrites,
    allowBulk: opts.allowBulk,
    allowToggleWrite: opts.allowToggleWrite,
    ledgerDir: opts.ledgerDir,
    requireGetuserinfo: opts.requireGetuserinfo,
  });
  report.safety = {
    allowed: plan.allowed.length,
    skipped: plan.skipped,
    reason: plan.reason,
    botScore: plan.risk && plan.risk.botScore,
  };
  if (!plan.allowed.length) {
    report.reason = plan.reason || "本轮没有可安全执行的活动";
    logger.warn(`活动写入被安全闸门拦截: ${report.reason}`);
    return report;
  }

  const discovery = await next.discoverActions(ctx, { request: opts.request });
  if (!discovery.ok) {
    report.reason = "未能发现 Server Action id，已跳过全部写操作";
    return report;
  }
  for (let i = 0; i < plan.allowed.length; i++) {
    const item = plan.allowed[i];
    const actionId = discovery.actions[item.actionName];
    if (!actionId) {
      report.executed.push({ offerId: item.offerId, ok: false, reason: `缺少 action ${item.actionName}` });
      continue;
    }
    // 写前先落账：POST 超时 / 失败也不重发，避免服务端状态未知时重复上报。
    try {
      safety.markWrite(plan.ledger, item.offerId, Number(opts.nowMs) > 0 ? Number(opts.nowMs) : Date.now());
    } catch (e) {
      logger.warn(`写入账本失败，跳过该活动: ${String((e && e.message) || e).slice(0, 80)}`);
      report.executed.push({ offerId: item.offerId, ok: false, reason: "写入账本失败" });
      continue;
    }
    const r = await next.reportServerAction(ctx, {
      actionId, args: item.args, url: item.url, tree: item.tree,
      dryRun: false, request: opts.request,
    });
    safety.auditWrite(ctx.id, item, r);
    report.executed.push({ offerId: item.offerId, kind: item.kind, ...r });
    // 两次写之间留出拟人间隔（离线测试可传 gapMs:0 跳过）
    if (i < plan.allowed.length - 1) await safety.pace(opts);
  }
  // 复核：只有服务器数据真的变了才算数，不能用「POST 200」冒充计分。
  // 真机 11-17 实证：单独发 Server Action 上报能拿到 200，但 punchcard 进度与
  // 可用积分都不变 —— 说明还需要真实页面交互。此时必须如实标「未确认」且不重试。
  const after = await next.fetchDashboard(ctx, fetchOpts);
  const pendingAfter = collectPending(after, opts);
  const pointsBefore = Number(before && before.availablePoints);
  const pointsAfter = Number(after && after.availablePoints);
  const confirmed =
    (Number.isFinite(pointsAfter) && Number.isFinite(pointsBefore) && pointsAfter > pointsBefore) ||
    pendingAfter.length < report.pending.length;
  report.confirmed = confirmed;
  report.after = {
    ok: Boolean(after && after.ok),
    availablePoints: after && after.availablePoints,
    streakProtection: after && after.streakProtection,
    punchCardCount: (after && after.punchCards || []).length,
    pendingRemaining: pendingAfter.length,
  };
  if (!confirmed) {
    logger.warn(
      "活动上报已发出，但服务器进度未变化：单纯 Server Action 上报不足以计分，" +
      "本轮不重试（冷却生效），需要真实页面交互才能到账"
    );
  }
  return report;
}

module.exports = {
  REDEEM_RE,
  MAX_ITEMS_PER_RUN,
  needsManualClaim,
  activityArgs,
  collectPending,
  summarizePending,
  runActivities,
};
