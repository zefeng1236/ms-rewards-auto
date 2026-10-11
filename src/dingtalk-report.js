/**
 * 跨客户端汇总报告：把各台客户端的所有账号拼成一份能一眼看懂的清单。
 *
 * 用途（用户 2026-10-11 提的需求）：多台/多地客户端把完成情况报到同一个群，
 * 但群消息是**时间流**，看一屏只能看到最近几条，谁漏做了一目了然不了。
 * 本模块把它整理成固定结构：
 *   ① 今日完成/未完成清单 —— 谁没做（用户明确要的第一项）
 *   ② 各账号积分与进度 —— PC/移动搜索进度、积分（用户要的第二项）
 *   ③ 客户端在线状态 —— 谁离线了（用户要的第三项）
 *
 * 【数据结构】一台客户端有**多个账号**，所以：
 *   rows（每台一条）= [{clientId, host, at, payload:{accounts:[{account,points,pc,m,done,date}]}}]
 *   → 先展开成「账号级」行，再按 (clientId, account) 去重取最新。
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

/** 当前日期串 YYYY-MM-DD（只依赖传入的 now，不读系统时钟） */
function dateStrOf(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

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
 * 把一个账号的状态判为「今日是否完成」。
 *
 * ⚠️ 只认「搜索进度满额」这一条硬标准，**不看 date 字段**。反例实测踩到过：
 *    客户端可能只是在**心跳上报**，date 是它自己填的、跟今天做没做任务无关；
 *    拿 date 当完成 → 什么都没做也判 ✅，用户看到满屏绿字，反而漏掉真没做的人。
 *
 * 但客户端已经自己判过 done（它有完整的任务上下文，比这里猜得更准），
 * 所以优先采信 done；只有在 done 缺失时才用进度满额兜底。
 *
 * 【兜底为什么是「两个都满」而不是「任一满」】（2026-10-11 冒烟测出的真 bug）
 *    `pcFull || mFull` 只要移动搜索做满就算完成 —— PC 还差 7 分也照样打 ✅。
 *    每日积分本来就要 PC + 移动都跑满，`||` 会把「只做了一半」报成完成，
 *    正是上面那条要防的「满屏绿字」。改成**每侧各自判定、缺哪侧算哪侧、都要满**：
 *      · 某侧 max <= 0 = 没在统计这一侧（比如只开了 PC），不参与判定；
 *      · 两侧都没数据（max 全 0）= 判不出，宁可算未完成也不算完成。
 *
 * @param {object} acc 账号级记录
 * @returns {boolean}
 */
function isAccountDone(acc) {
  if (!acc || typeof acc !== "object") return false;
  if (acc.done === true) return true;
  const pc = acc.pc || {};
  const m = acc.m || {};
  const pcOn = Number(pc.max) > 0;
  const mOn = Number(m.max) > 0;
  // 两侧都没在统计 → 判不出完成，按未完成处理（宁可催一下也不误报✅）
  if (!pcOn && !mOn) return false;
  const pcFull = !pcOn || Number(pc.progress) >= Number(pc.max);
  const mFull = !mOn || Number(m.progress) >= Number(m.max);
  return pcFull && mFull;
}

/**
 * 把「每台一条」的 rows 展开成「账号级」行，并按 (clientId, account) 去重取最新。
 *
 * @param {Array<object>} rows 各机上报记录
 * @returns {Array<object>} 账号级行，每条含 clientId/host/at/account/...
 */
function expandRows(rows) {
  const map = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    const list = (r.payload && Array.isArray(r.payload.accounts) && r.payload.accounts) || [];
    // 兼容单账号写法（早期版本 payload 直接是账号对象）：有 account 字段就当成一条
    const items = list.length ? list : r.payload && r.payload.account ? [r.payload] : [];
    for (const a of items) {
      const acc = String((a && a.account) || "").trim();
      if (!acc) continue;
      const key = `${r.clientId || "?"}::${acc}`;
      const prev = map.get(key);
      // 取更新时间晚的那条；时间相同则后到的覆盖（同毫秒内重传）
      if (!prev || Date.parse(r.at || 0) >= Date.parse(prev.at || 0)) {
        map.set(key, {
          clientId: r.clientId || "",
          host: r.host || "",
          at: r.at || "",
          account: acc,
          points: Number(a.points) || 0,
          pc: a.pc || { progress: 0, max: 0 },
          m: a.m || { progress: 0, max: 0 },
          done: isAccountDone(a),
          loggedIn: a.loggedIn !== false,
        });
      }
    }
  }
  return Array.from(map.values());
}

/**
 * 从一条群消息里解析出客户端上报（**已不用于主链路**，保留供兼容与测试）。
 *
 * ⚠️ 主链路已改走 HTTP 上报（见 cluster-service），本函数不再被生产代码调用。
 *    留着是因为：① 早期版本自己发过这种格式的群消息，历史数据仍可解析；
 *    ② 守卫靠它锁「解析失败必须返回 null 不抛」这条纪律。
 *    **不要**把它接回主链路 —— 那条路经实测走不通（群消息收不到）。
 *
 * @param {string} text 群消息正文
 * @returns {{account?:string, points?:number, date?:string}|null}
 */
function parseClientReport(text) {
  const raw = String(text == null ? "" : text);
  if (!raw.trim()) return null;
  const plain = stripMarkdown(raw);
  if (!plain) return null;

  const isOurs = /Rewards\s*运行汇总/.test(plain) || /\(PC\)|\(Docker\)/.test(plain);
  if (!isOurs) return null;

  const accMatch = plain.match(/([^\s:：]{1,40}?)\s{2,}(v?\d+\.\d+\.\d+)/);
  const dateMatch = plain.match(/(\d{4}-\d{2}-\d{2})/);
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
 * 生成汇总报告（markdown，供钉钉 markdown 消息直接用）。
 *
 * @param {object} input
 * @param {Array<object>} input.rows       各机上报记录（含 payload.accounts）
 * @param {number}   input.now             固定当前时刻（毫秒）
 * @param {Array<string>} [input.expected] 应做账号清单；给了才算「未完成」
 * @returns {{text: string, stats: object, missing: string[]}}
 */
function buildReport(input) {
  const cfg = input || {};
  const now = Number.isFinite(cfg.now) ? cfg.now : Date.now();
  const rows = expandRows(cfg.rows);
  const expected = Array.isArray(cfg.expected) ? cfg.expected.filter(Boolean) : [];
  const dateStr = dateStrOf(now);

  const done = rows.map((r) => ({
    ...r,
    online: isOnline({ at: r.at }, now),
  }));
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
  // 应做清单为空时，「未完成」段没意义（不知道应做谁）；但至少要提示有账号没做满
  if (!expected.length) {
    for (const d of done) if (!d.done && !seen.has(d.account)) missing.push(d.account);
  }

  // ---- 拼正文 ----
  const lines = [];
  lines.push(`📊 **多客户端运行汇总**（${dateStr}）`);
  lines.push("");

  // ① 未完成（最重要，放最前 —— 用户要「一眼看出谁没完成」）
  lines.push("**❌ 未完成**");
  if (missing.length) {
    for (const name of missing) {
      // 在线却没做完 → 标出来，用户一眼知道「是没做」还是「联系不上」
      const rec = byAccount.get(name);
      lines.push(rec && rec.online ? `- ${name}（在线，未做满）` : `- ${name}`);
    }
  } else {
    lines.push(done.length ? "- 无，全部完成" : "- 暂无数据");
  }
  lines.push("");

  // ② 各账号积分与进度
  lines.push("**✅ 账号进度**");
  if (done.length) {
    for (const d of done) {
      const flag = d.done ? "✅" : "⏳";
      const net = d.online ? "" : "（离线）";
      lines.push(
        `- ${flag} ${d.account}${net} · 积分 ${d.points} · ` +
          `PC ${d.pc.progress || 0}/${d.pc.max || 0} · 移动 ${d.m.progress || 0}/${d.m.max || 0}`
      );
    }
  } else {
    lines.push("- 暂无数据（客户端还没上报）");
  }
  lines.push("");

  // ③ 客户端在线状态（按机器聚合，一眼看出哪台掉线）
  lines.push("**🖥 客户端状态**");
  const byClient = new Map();
  for (const d of done) {
    const k = d.clientId || "?";
    if (!byClient.has(k)) byClient.set(k, { clientId: k, host: d.host, at: d.at, online: d.online, n: 0, doneN: 0 });
    const c = byClient.get(k);
    c.n++;
    if (d.done) c.doneN++;
  }
  // 汇总机自己即使一个账号都没上报，也该出现在列表里（否则用户以为它没在跑）
  for (const r of Array.isArray(cfg.rows) ? cfg.rows : []) {
    if (!r || !r.clientId || byClient.has(r.clientId)) continue;
    byClient.set(r.clientId, {
      clientId: r.clientId, host: r.host, at: r.at,
      online: isOnline(r, now), n: 0, doneN: 0,
    });
  }
  const clients = Array.from(byClient.values()).sort((a, b) =>
    String(a.clientId).localeCompare(String(b.clientId))
  );
  if (clients.length) {
    for (const c of clients) {
      const at = c.at ? new Date(c.at).toLocaleTimeString("zh-CN", { hour12: false }) : "";
      lines.push(
        `- ${c.online ? "🟢 在线" : "🔴 离线"} ${c.host || c.clientId}` +
          `（${c.doneN}/${c.n} 已完成）${at ? ` · 最后上报 ${at}` : ""}`
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
    clients: clients.length,
  };

  return { text: lines.join("\n"), stats, missing };
}

module.exports = {
  buildReport,
  parseClientReport,
  expandRows,
  isAccountDone,
  isOnline,
  dateStrOf,
  ONLINE_WINDOW_MS,
};
