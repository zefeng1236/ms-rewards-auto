/**
 * 跨客户端汇总编排层：把「收集状态 → 生成报告 → 发进群」串起来，
 * 并区分本机是汇总机（hub）还是客户端（client）。
 *
 * 【触发时机】
 *   · 启动时：按 role 决定是开监听（hub）还是启动定时上报（client）
 *   · 客户端：每 pushIntervalMin 分钟 POST 一次自己的账号状态
 *   · 汇总机：每 reportIntervalMin 分钟生成一份报告发进群；也可手动触发
 *   · 账户任务跑完后：立即上报一次（不用等下个周期，用户马上就能看到进度）
 *
 * 【为什么不用定时器轮询整个状态】
 *   账户状态在 state.json 里，读它是磁盘 IO。定时器只唤醒「该干活了吗」，
 *   真正的数据在触发瞬间才读 —— 避免空转读盘。
 *
 * 【与 transport 解耦】本模块不直接开 HTTP 服务，
 *   只暴露 handleReport()（hub 收到上报时调）与 reportNow()（生成并发报告）。
 *   HTTP 那层由 electron-main（内置小服务）或 server.js（Docker 版）负责。
 *   这样 Electron 与 Docker 两个变体共用同一份汇总逻辑，不会跑偏。
 */

const logger = require("./logger");
const globalConfig = require("./global-config");
const accounts = require("./account");
const hub = require("./cluster-hub");
const rep = require("./dingtalk-report");

/** 运行期状态（供界面显示） */
const state = {
  started: false,
  role: "off",
  lastReportAt: "",
  lastReportOk: false,
  lastReportError: "",
  lastPushAt: "",
  lastPushOk: false,
  lastPushError: "",
  reportCount: 0,
  pushCount: 0,
};

let reportTimer = null;
let pushTimer = null;
/** 报告发送器：由主进程注入（Electron 与 Docker 版实现不同，见 setSender） */
let sendReportFn = null;
/** 本机账号状态采集器：由主进程注入（避免直接依赖 runner，防循环引用） */
let collectFn = null;

/**
 * 注入依赖。
 *
 * 为什么要注入而不是直接 require：
 *   ① collectAccounts 需要读账户状态，直接 require account 是可以的，
 *      但 Electron 下「状态从哪来」可能随上下文变（如刚跑完任务时用内存快照），
 *      注入让调用方能覆盖；
 *   ② sendReport 在 Electron 版走 notify/webhook 或企业机器人，在 Docker 版
 *      可能走同一个，未来如果加别的通道也不用改本模块。
 *
 * @param {object} deps
 * @param {(report:{title:string,text:string}) => Promise<{ok:boolean,error?:string}>} deps.sendReport
 * @param {() => Array<object>} [deps.collectAccounts]
 */
function configure(deps) {
  const d = deps || {};
  if (typeof d.sendReport === "function") sendReportFn = d.sendReport;
  if (typeof d.collectAccounts === "function") collectFn = d.collectAccounts;
}

/**
 * 采集本机所有账号的当前状态（用于上报给汇总机）。
 *
 * 只上报汇总需要的字段，**不包括 Cookie / token 之类敏感信息** ——
 * 这是要发到网络上的数据，多一个字段就多一分泄露面。
 *
 * @returns {{accounts: Array<object>, host: string, at: string}}
 */
function collectAccounts() {
  if (collectFn) {
    try {
      return collectFn();
    } catch (e) {
      logger.warn(`采集账号状态失败（用内置实现兜底）：${e.message}`);
    }
  }
  const list = [];
  let items = [];
  try {
    items = accounts.describeAll() || [];
  } catch (e) {
    logger.warn(`读取账号列表失败：${e.message}`);
  }
  for (const a of items) {
    const st = (a && a.state) || {};
    list.push({
      account: a.name || a.id || "",
      // 只报积分与搜索进度，不报 cookie/token
      points: Number(st.todayPoints) || 0,
      balance: Number(st.lastBalance) || 0,
      pc: { progress: Number((st.pc && st.pc.progress) || 0), max: Number((st.pc && st.pc.max) || 0) },
      m: { progress: Number((st.m && st.m.progress) || 0), max: Number((st.m && st.m.max) || 0) },
      // 已收工 = 今日任务全做完（客户端本地判定，比汇总机猜得准）
      done: !!(st.sched && st.sched.dayDone),
      loggedIn: !!st.loggedIn,
      date: dateToday(),
    });
  }
  return { accounts: list, host: hub.getIdentity().host, at: new Date().toISOString() };
}

/** 今天日期串 YYYY-MM-DD */
function dateToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 解析「应做账号清单」文本（逗号/顿号/换行/空格分隔，去重去空） */
function parseExpected(raw) {
  return Array.from(
    new Set(
      String(raw == null ? "" : raw)
        .split(/[,，、\n\r\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

/**
 * 生成并发送汇总报告（汇总机专用）。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.manual] 是否手动触发（日志措辞不同）
 * @returns {Promise<{ok:boolean, text?:string, stats?:object, error?:string}>}
 */
async function reportNow(opts = {}) {
  const cfg = (globalConfig.get() || {}).cluster || {};
  // 把本机自己的状态也写进去（汇总机自己也是一个数据源）
  try {
    hub.reportSelf(collectAccounts());
  } catch (e) {
    logger.warn(`汇总机自身上报失败：${e.message}`);
  }

  const rows = Array.from(hub.listKnownClients().values());
  const built = rep.buildReport({
    rows,
    now: Date.now(),
    expected: parseExpected(cfg.expectedAccounts),
  });

  state.lastReportAt = new Date().toISOString();
  state.reportCount++;

  if (!rows.length) {
    state.lastReportOk = false;
    state.lastReportError = "还没有任何客户端上报，报告没内容可发";
    logger.warn(`[汇总] ${state.lastReportError}`);
    return { ok: false, error: state.lastReportError, text: built.text, stats: built.stats };
  }

  if (!sendReportFn) {
    state.lastReportOk = false;
    state.lastReportError = "报告发送器未注入（内部错误）";
    logger.warn(`[汇总] ${state.lastReportError}`);
    return { ok: false, error: state.lastReportError, text: built.text, stats: built.stats };
  }

  const title = `MS Rewards 多客户端汇总`;
  let sent;
  try {
    sent = await sendReportFn({ title, text: built.text });
  } catch (e) {
    sent = { ok: false, error: e && e.message ? e.message : String(e) };
  }
  state.lastReportOk = !!sent.ok;
  state.lastReportError = sent.ok ? "" : sent.error || "未知错误";
  if (sent.ok) {
    logger.success(
      `[汇总]${opts.manual ? "（手动）" : ""}报告已发送：` +
        `共 ${built.stats.total} 个账号，已完成 ${built.stats.done}，未完成 ${built.stats.missing}，` +
        `客户端 ${built.stats.clients} 台`
    );
  } else {
    logger.warn(`[汇总]${opts.manual ? "（手动）" : ""}发送失败：${state.lastReportError}`);
  }
  return { ok: !!sent.ok, error: sent.error, text: built.text, stats: built.stats };
}

/**
 * 把本机状态 POST 给汇总机（客户端专用）。
 *
 * @returns {Promise<{ok:boolean, status?:number, error?:string}>}
 */
async function pushNow() {
  const cfg = (globalConfig.get() || {}).cluster || {};
  const url = String(cfg.reportUrl || "").trim();
  const token = String(cfg.reportToken || "").trim();
  if (!url) {
    return { ok: false, error: "未填写汇总机上报地址" };
  }
  const me = hub.getIdentity();
  const body = {
    clientId: me.clientId,
    host: me.host,
    at: new Date().toISOString(),
    payload: collectAccounts(),
  };

  state.lastPushAt = new Date().toISOString();
  state.pushCount++;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(normalizeReportUrl(url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // 密钥放头里而不是 URL：URL 会进日志、进代理记录
        "X-Cluster-Token": token,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (res.status !== 200) {
      state.lastPushOk = false;
      state.lastPushError = `HTTP ${res.status} ${String(text).slice(0, 160)}`;
      logger.warn(`[上报] 失败：${state.lastPushError}`);
      return { ok: false, status: res.status, error: state.lastPushError };
    }
    state.lastPushOk = true;
    state.lastPushError = "";
    logger.log("上报", `已上报 ${body.payload.accounts.length} 个账号状态到汇总机`);
    return { ok: true, status: res.status };
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "请求超时(20s)" : e && e.message ? e.message : String(e);
    state.lastPushOk = false;
    state.lastPushError = msg;
    logger.warn(`[上报] 失败：${msg}`);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把用户填的上报地址规范化成完整的上报端点。
 *
 * 用户可能填 `http://100.64.0.5:3210` 或 `http://100.64.0.5:3210/` 或
 * `http://hub:3210/api/cluster/report`。前两种补上 `/api/cluster/report`，
 * 已经带了就不重复加 —— 否则会拼成 `.../report/api/cluster/report`。
 *
 * @param {string} url
 * @returns {string}
 */
function normalizeReportUrl(url) {
  let u = String(url || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  if (!/\/api\/cluster\/report$/i.test(u)) u = `${u}/api/cluster/report`;
  return u;
}

/**
 * 汇总机收到一条上报时调（由 HTTP 层调用）。
 *
 * @param {object} body 上报体
 * @param {string} token 请求头里的密钥
 * @returns {{ok:boolean, status:number, error?:string}}
 */
function handleReport(body, token) {
  const cfg = (globalConfig.get() || {}).cluster || {};
  const expect = String(cfg.reportToken || "").trim();

  // ⚠️ 汇总机没配密钥时**拒收**（而不是放行）。
  //    这台机器可能挂在公网/隧道上，无密钥等于任何人都能往里灌数据、
  //    污染统计。宁可让用户多填一个字段，也不能默认裸奔。
  if (!expect) {
    return { ok: false, status: 403, error: "汇总机未配置共享密钥，已拒收（请在汇总机设置里填写）" };
  }
  if (String(token || "").trim() !== expect) {
    return { ok: false, status: 401, error: "共享密钥不匹配" };
  }
  const rec = body && typeof body === "object" ? body : {};
  if (!rec.clientId) return { ok: false, status: 400, error: "缺少 clientId" };

  const r = hub.upsertClient({
    clientId: rec.clientId,
    host: rec.host,
    at: rec.at,
    payload: rec.payload && typeof rec.payload === "object" ? rec.payload : {},
  });
  if (!r.ok) return { ok: false, status: 500, error: r.error };
  return { ok: true, status: 200 };
}

/** 停掉所有定时器 */
function stopTimers() {
  if (reportTimer) { clearInterval(reportTimer); reportTimer = null; }
  if (pushTimer) { clearInterval(pushTimer); pushTimer = null; }
}

/**
 * 按当前配置启动/重启编排。
 *
 * 设置改了之后要重新调一次（先 stop 再 start），否则改了间隔不生效。
 *
 * @returns {{ok:boolean, role:string, error?:string, note?:string}}
 */
function start() {
  stopTimers();
  const cfg = (globalConfig.get() || {}).cluster || {};
  const role = String(cfg.role || "off");

  state.started = role !== "off";
  state.role = role;

  if (role === "off") {
    logger.info("[汇总] 集群功能未启用（role=off）");
    return { ok: true, role, note: "未启用" };
  }

  if (role === "hub") {
    const mins = Math.max(0, Number(cfg.reportIntervalMin) || 0);
    if (mins > 0) {
      reportTimer = setInterval(() => {
        reportNow().catch((e) => logger.warn(`[汇总] 定时报告异常：${e.message}`));
      }, mins * 60 * 1000);
      if (reportTimer.unref) reportTimer.unref();
      logger.info(`[汇总] 本机为汇总机，每 ${mins} 分钟自动发一次报告（端口 ${cfg.listenPort || 3210}）`);
    } else {
      logger.info("[汇总] 本机为汇总机，自动报告已关闭（间隔=0），只在仪表盘手动触发");
    }
    // 启动后先自报一次，让汇总表里立刻有自己的状态
    try {
      hub.reportSelf(collectAccounts());
    } catch { /* 自报失败不影响启动 */ }
    return { ok: true, role };
  }

  // role === client
  const pushMins = Math.max(1, Number(cfg.pushIntervalMin) || 5);
  pushTimer = setInterval(() => {
    pushNow().catch((e) => logger.warn(`[上报] 定时上报异常：${e.message}`));
  }, pushMins * 60 * 1000);
  if (pushTimer.unref) pushTimer.unref();
  logger.info(`[上报] 本机为客户端，每 ${pushMins} 分钟上报到 ${cfg.reportUrl || "(未配置地址)"}`);
  if (!String(cfg.reportUrl || "").trim()) {
    logger.warn("[上报] ⚠️ 未填写汇总机地址，上报会一直失败。请到「跨客户端汇总」设置里填写。");
  } else {
    // 启动时立刻报一次，不用等第一个周期
    pushNow().catch((e) => logger.warn(`[上报] 首次上报异常：${e.message}`));
  }
  return { ok: true, role };
}

function getState() {
  return { ...state, view: hub.getClusterView() };
}

module.exports = {
  configure,
  start,
  stop: stopTimers,
  getState,
  reportNow,
  pushNow,
  handleReport,
  collectAccounts,
  parseExpected,
  normalizeReportUrl,
  dateToday,
};
