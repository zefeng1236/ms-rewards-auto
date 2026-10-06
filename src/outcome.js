/**
 * 运行终态判定（Electron 与 Docker 版共用）
 *
 * 为什么单独拆出来：
 *   electron-main.js 与 app-core.js 历史上各写了一份 classifyOutcome，
 *   改一边忘另一边就会让「桌面版显示需要注意、Docker 版显示正常」这类
 *   漂移反复出现。这里收口成纯函数，两边都 require 它。
 *
 * 纯 Node，无副作用，不依赖 Electron / 网络 / 存储。
 */

/** result.tasks 的 key → 中文任务名（用于拼出「哪一项没完成」） */
const TASK_LABELS = {
  sign: "签入",
  read: "阅读",
  daily: "每日活动",
  promos: "积分活动",
  claim: "定期收取积分",
  search: "搜索",
};

/** 取任务的中文名，未知 key 原样返回 */
function taskLabel(key) {
  return TASK_LABELS[key] || key;
}

/**
 * 根据 runner 批次/单账号的结束信息判定终态。
 *
 * retry（任务跑了但被接口挡住、下轮再试）必须点名具体是哪几项，
 * 否则界面上只剩一个「需要注意」，用户无从判断到底缺什么。
 *
 * @param {object} info runner 的 end 信息
 * @returns {{status:"warning"|"error", reason:string}|null} null 表示回到空闲（不标记）
 */
function classifyOutcome(info) {
  if (!info) return null;
  // 用户主动停止（整批 / 单个 / 排队中跳过）不算错误，回到无标记
  if (info.aborted || info.abortAll || info.skipped) return null;
  // 业务阻断但拿到了 result（如 IP 非大陆）→ 橙色「需要注意」
  if (info.ok === false) {
    if (info.error && !info.result) return { status: "error", reason: info.reason || info.error || "运行失败" };
    return { status: "warning", reason: info.reason || "需要注意" };
  }

  const tasks = (info.result && info.result.tasks) || {};

  // 1) 真正报错 → 红。error 优先于一切 warning，先扫一遍。
  for (const k of Object.keys(tasks)) {
    const t = tasks[k];
    if (t && t.status === "error") {
      return { status: "error", reason: `${taskLabel(k)}出错：${t.error || "未知错误"}` };
    }
  }

  // 2) 需要人工介入的单项（未授权 / 收入受限）→ 橙。这两类是全局性的，
  //    命中任何一项都足以解释整轮异常，直接返回即可。
  for (const k of Object.keys(tasks)) {
    const t = tasks[k];
    if (!t) continue;
    if (t.unauthorized) return { status: "warning", reason: "未授权，请重新登录后再运行" };
    if (t.status === "restricted") return { status: "warning", reason: "搜索任务收入受限" };
  }

  // 3) retry：不自动重试成功就别承诺「会自动重试」，把具体项与原因摊开。
  //    reason 若与任务名重复（如「阅读」+「阅读进度接口获取失败」）就去掉前缀，
  //    避免拼成「阅读（阅读进度接口获取失败）」这种读起来啰嗦的句子。
  const pending = [];
  for (const k of Object.keys(tasks)) {
    const t = tasks[k];
    if (!t || t.status !== "retry") continue;
    const label = taskLabel(k);
    let why = (t.reason || "").trim();
    if (why && why.startsWith(label)) why = why.slice(label.length).replace(/^[（(：:]\s*/, "");
    pending.push(why ? `${label}（${why}）` : `${label}未完成`);
  }
  if (pending.length) {
    return { status: "warning", reason: `${pending.join("、")}，稍后会自动重试` };
  }

  return null;
}

module.exports = { classifyOutcome, taskLabel, TASK_LABELS };