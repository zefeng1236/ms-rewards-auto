/**
 * 积分目标评估
 *
 * 用户可以配置多个总积分目标，也可以为目标设置奖品名称。
 * 输出规则：未达成显示差额；达成后显示目标倍数；设置奖品后显示可兑换数量与下一个奖品的差额。
 */

/** 目标条目规范化，非法项直接剔除 */
function normalizeGoals(raw) {
  const g = raw || {};
  const items = Array.isArray(g.items) ? g.items : [];
  const out = [];
  items.forEach((it, idx) => {
    const target = Number(it && it.target);
    if (!Number.isFinite(target) || target <= 0) return;
    const rewardName = String((it && it.rewardName) || "").trim().slice(0, 10);
    out.push({
      name: String((it && it.name) || `目标${idx + 1}`).slice(0, 24),
      scope: "balance",
      target: Math.round(target),
      rewardName,
      showDashboard: it && it.showDashboard === false ? false : true,
    });
  });
  return { enable: g.enable !== false, items: out };
}

/**
 * 评估单个目标
 * @param {object} goal 规范化后的目标
 * @param {number} current 当前值
 */
function evalOne(goal, current) {
  const cur = Number.isFinite(current) ? current : 0;
  const pct = goal.target > 0 ? (cur / goal.target) * 100 : 0;
  const reached = cur >= goal.target;
  return {
    ...goal,
    current: cur,
    reached,
    // 还差多少（已达成为 0）
    remain: Math.max(0, goal.target - cur),
    percent: pct,
  };
}

/**
 * 评估全部目标
 * @param {object} cfgGoals 配置里的 goals
 * @param {object} ctxNums { today, balance }
 */
function evaluate(cfgGoals, ctxNums) {
  const norm = normalizeGoals(cfgGoals);
  if (!norm.enable || !norm.items.length) return { enable: norm.enable, items: [] };
  const nums = ctxNums || {};
  const today = Number(nums.today) || 0;
  const balance = Number(nums.balance) || 0;
  return {
    enable: true,
    items: norm.items.map((g) => evalOne(g, g.scope === "balance" ? balance : today)),
  };
}

const SCOPE_LABEL = { balance: "总积分" };

/**
 * 目标行统一的勋章图标前缀。
 *
 * 加在【推送汇总】与所有复用本模块的输出里（展示口径必须一致，
 * 否则仪表盘和推送消息会长得不一样）。抽成常量而不是散落在各条 return 里，
 * 是为了 selfcheck 能直接断言「目标行必带图标」这条规则。
 */
const MEDAL = "🏅 ";

/**
 * 单条目标的展示文案
 *
 * 未达成      -> 🏅 目标已完成120还差180积分
 * 刚好/超出   -> 🏅 目标当前已可兑换2个奖品名，距离下一个还剩xx积分
 */
function formatOne(r) {
  const rawName = String((r && r.name) || "").trim();
  // 调用方可能已经带了别的图标，这里不再叠一层
  const head = rawName.startsWith(MEDAL.trim()) ? `${rawName}目标` : `${MEDAL}${rawName}目标`;
  if (!r.reached) return `${head}已完成${r.current}还差${r.remain}积分`;
  if (r.rewardName) {
    const count = Math.floor(r.current / r.target);
    const nextRemain = r.target - (r.current % r.target);
    return `${head}当前已可兑换${count}个${r.rewardName}，距离下一个还剩${nextRemain}积分`;
  }
  const multiple = Math.round((r.current / r.target) * 10) / 10;
  return `${head}当前已达成${multiple}倍目标`;
}

/** 生成汇总里的目标区块（无目标时返回空数组） */
function formatLines(cfgGoals, ctxNums) {
  const res = evaluate(cfgGoals, ctxNums);
  if (!res.items.length) return [];
  return res.items.map(formatOne);
}

module.exports = { normalizeGoals, evaluate, evalOne, formatOne, formatLines, SCOPE_LABEL, MEDAL };
