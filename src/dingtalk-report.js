/**
 * 跨客户端汇总报告：把各台客户端的完成情况拼成一份能一眼看懂的清单。
 *
 * 用途（用户 2026-10-11 提的需求）：多台/多地客户端把完成情况推到同一个钉钉群，
 * 但群消息是**时间流**，看一屏只能看到最近几条，谁漏做了一目了然不了。
 * 本模块把它整理成固定结构：
 *   ① 今日完成/未完成清单 —— 谁没做（用户明确要的第一项）
 *   ② 各账号积分与进度 —— PC/移动搜索进度、积分（用户要的第二项）
 *   ③ 客户端在线状态 —— 谁离线了（用户要的第三项）
 *
 * 【数据来源有两路，互为兜底】
 *   · 客户端主动上报（cluster-hub.reportSelf）—— Stream 断了也能统计
 *   · 主实例从群里收到的推送消息解析 —— 客户端没配上报时仍能工作
 * 两者合并，**按 clientId+账号名去重**，取更新时间晚的那条。
 *
 * 【纯函数优先】buildReport 不碰IO、不读时钟，全部输入由调用方传入。
 *   这样守卫能用**固定 now** 测试在线判定（守卫铁律：依赖时刻的断言必须传固定输入）。
 */

const { stripMarkdown } = (() => {
  try {
    return require("./notify-markdown");
  } catch {
    return { stripMarkdown: (s) => String(s == null ? "" : s) };
  }
})();

/** 在线判定窗口：15 分钟没上报算离线 */
const ONLINE_WINDOW_MS = 15 * 60 * 1000;

/**
 * 判断一台客户端在给定时刻是否在线。
 *
 * @param {{at?: string}} rec 上报记录
 * @param {number} now 固定「当前时刻」毫秒 —— **不要在函数里取真实时间**
 * @returns {boolean}
 */
function isOnline(rec, now) {
  const t = Date.parse((rec && rec.at) || "");
  if (!Number.isFinite(t)) return false;
  return now - t < ONLINE_WINDOW_MS;
}

/**
 * 从一条钉钉群消息里解析出「哪台客户端的哪个账号完成了」。
 *
 * 推送正文里本来就带「用户名 + 版本号」那一行（withAccountHeader），
 * 所以这里不需要客户端额外上报也能拼出清单 —— 这是 Stream 兜底路的价值。
 *
 * ⚠️ 解析失败**绝不抛**，返回 null 让上层跳过这一条 —— 群里可能有
 *    人工发言、别的机器人消息，不能因为解析不了就把整份报告搞崩。
 *
 * @param {string} text 群消息正文
 * @returns {{clientId?:string, account?:string, points?:number, date?:string}|null}
 */
function parseClientReport(text) {
  const raw = String(text == null ? "" : text);
  if (!raw.trim()) return null;
  const plain = stripMarkdown(raw);
  if (!plain) return null;

  // 只认本软件推的：有「Rewards 运行汇总」或带账号头特征
  const isOurs = /Rewards\s*运行汇总/.test(plain) || /\(PC\)|\(Docker\)/.test(plain);
  if (!isOurs) return null;

  // 账号名：用户名后跟若干空格（全角空格更稳）再跟版本号
  const accMatch = plain.match(/([^\s:：]{1,40}?)\s{2,}(v?\d+\.\d+\.\d+)/);
  const dateMatch = plain.match(/(\d{4}-\d{2}-\d{2})/);
  // 今日积分
  const ptMatch =
    plain.match(/今日[^\d]{0,6}(\d+)/) || plain.match(/积分[^\d]{0,6}(\d+)/);

  return {
    account: accMatch ? accMatch[1].trim() : "",
    version: accMatch ? accMatch[2] : "",
    date: dateMatch ? dateMatch[1] : "",
    points: ptMatch ? Number(ptMatch[1]) : 0,
  };
}

/**
 * 合并多路数据源，按 (clientId + 账号名) 去重，取较新的一条。
 *
 * @param {Array<object>} rows 形如 {clientId, at, payload:{account, points, pc:{progress,max}, m:{...}}}
 * @returns {Array<object>}
 */
function mergeRows(rows) {
  const map = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    const payload = r.payload || {};
    const key = `${r.clientId || "?"}::${payload.account || "?"}`;
    const prev = map.get(key);
    // 取更新时间晚的那条；时间相同则后到的覆盖（同毫秒内重传）
    if (!prev || Date.parse(r.at || 0) >= Date.parse(prev.at || 0)) map.set(key, r);
  }
  return Array.from(map.values());
}

/**
 * 生成汇总报告（markdown，供钉钉 markdown 消息直接用）。
 *
 * @param {object} input
 * @param {Array<object>} input.rows     各机上报记录（含 payload）
 * @param {number}   input.now           固定当前时刻（毫秒）
 * @param {Array<string>} [input.expected] 应做账号清单；给了才算「未完成」
 * @param {string}   [input.titleSuffix]
 * @returns {{text: string, stats: object}}
 */
function buildReport(input) {
  const cfg = input || {};
  const now = Number.isFinite(cfg.now) ? cfg.now : Date.now();
  const rows = mergeRows(cfg.rows);
  const expected = Array.isArray(cfg.expected) ? cfg.expected.filter(Boolean) : [];

  // ---- 今日完成 / 未完成 ----
  // 判「完成」：今天有上报记录，或搜索进度已满
  const today = new Date(now);
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
    today.getDate()
  ).padStart(2, "0")}`;

  const done = [];
  for (const r of rows) {
    const p = r.payload || {};
    // 判「完成」用**搜索进度满额**这一条硬标准。
    // ⚠️ 曾经把「payload.date === 今天」也算完成，那是错的 —— 客户端
    //    可能只是在**心跳上报**，date 是它自己填的、跟今天做没做任务无关。
    //    结果：什么都没做也判✅，用户看到满屏绿字反而漏掉真没做的人。
    //    现在只有「PC 或移动搜索进度真的满了」才算完成。
    const pcFull = !!(p.pc && p.pc.max > 0 && p.pc.progress >= p.pc.max);
    const mFull = !!(p.m && p.m.max > 0 && p.m.progress >= p.m.max);
    const reportedToday = String(p.date || "").trim() === dateStr;
    const isDone = pcFull || mFull;
    done.push({
      clientId: r.clientId || "",
      host: r.host || "",
      account: p.account || "",
      points: Number(p.points) || 0,
      pc: p.pc || { progress: 0, max: 0 },
      m: p.m || { progress: 0, max: 0 },
      online: isOnline(r, now),
      at: r.at || "",
      done: isDone,
      reason: pcFull ? "PC 已满" : mFull ? "移动已满" : reportedToday ? "已上报" : "",
    });
  }
  done.sort((a, b) => String(a.account).localeCompare(String(b.account)));

  // ⚠️ 未完成要包含**两类人**，缺一不可（反例实测踩到过）：
  //   ① 应做清单里有、但**从未上报**的人（连不上/没开机）
  //   ② 上报了、但**进度没满**的人（在线却在摸鱼 —— 用户原话「一眼看出哪个账号没完成」）
  // 只算 ① 的话，在线摸鱼的账号只会出现在下方清单里，**恰恰漏掉了最该提醒的那批**。
  const byAccount = new Map();
  for (const d of done) {
    if (d.account && !byAccount.has(d.account)) byAccount.set(d.account, d);
  }
  const missing = [];
  const seen = new Set();
  for (const name of expected) {
    if (seen.has(name)) continue;
    seen.add(name);
    const rec = byAccount.get(name);
    // 上报了但没做完 → 也算未完成（并标出它在线，可以立刻催）
    if (!rec || !rec.done) missing.push(name);
  }

  // ---- 拼正文 ----
  const lines = [];
  lines.push(`📊 **多客户端运行汇总**（${dateStr}）`);
  lines.push("");

  // ① 未完成（最重要，放最前 —— 用户要「一眼看出谁没完成」）
  if (expected.length) {
    lines.push("**❌ 未完成**");
    if (missing.length) {
      for (const name of missing) {
        // 在线却没做完 → 标出来，用户一眼知道「是没做」还是「联系不上」
        const rec = byAccount.get(name);
        lines.push(rec && rec.online ? `- ${name}（在线，未做满）` : `- ${name}`);
      }
    } else {
      lines.push("- 无，全部完成");
    }
    lines.push("");
  }

  // ② 今日完成清单
  lines.push("**✅ 今日完成**");
  if (done.length) {
    for (const d of done) {
      const flag = d.done ? "✅" : "⏳";
      const net = d.online ? "" : "（离线）";
      lines.push(
        `- ${flag} ${d.account || d.clientId}${net} · 积分 ${d.points} · ` +
          `PC ${d.pc.progress || 0}/${d.pc.max || 0} · 移动 ${d.m.progress || 0}/${d.m.max || 0}`
      );
    }
  } else {
    lines.push("- 暂无数据");
  }
  lines.push("");

  // ③ 客户端在线状态
  lines.push("**🖥 客户端状态**");
  if (done.length) {
    for (const d of done) {
      const at = d.at ? new Date(d.at).toLocaleTimeString("zh-CN", { hour12: false }) : "";
      lines.push(
        `- ${d.online ? "🟢 在线" : "🔴 离线"} ${d.host || d.clientId}${at ? ` · 最后上报 ${at}` : ""}`
      );
    }
  } else {
    lines.push("- 暂无客户端");
  }

  const stats = {
    total: done.length,
    done: done.filter((d) => d.done).length,
    missing: missing.length,
    online: done.filter((d) => d.online).length,
  };

  return { text: lines.join("\n"), stats };
}

module.exports = {
  buildReport,
  parseClientReport,
  mergeRows,
  isOnline,
  ONLINE_WINDOW_MS,
};