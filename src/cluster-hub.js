/**
 * 跨客户端状态汇聚：存各机上报名单 + 本机身份。
 *
 * 【为什么不需要「选主」了】（2026-10-11 架构调整）
 *   最初设计里有一段 shouldBeHub() —— 靠 clientId 字典序裁决哪台连 Stream 收群消息。
 *   但实测证明「汇总机读群消息」这条路走不通（群消息只投递给被人类 @ 的机器人，
 *   且机器人之间无法互相 @，拉群记录接口也不存在，详见 global-config.cluster 的注释）。
 *   改成「客户端主动上报到汇总机」后，**角色由用户显式配置**（role: hub/client），
 *   不再需要任何自动选举 —— 谁监听、谁上报，是配出来的，不是算出来的。
 *   ⚠️ 别再把选举逻辑加回来：那是对着一条已废弃的链路写的。
 *
 * 【本机身份】clientId 存 storage/cluster-identity.json，首次生成后不再变。
 *   同一台机器重装/改名后要保持同一个身份，否则汇总表里会出现两条同名记录。
 *
 * 【存储形态】JSONL（一行一条），按 clientId 就地覆盖，只保留每台最新状态。
 *   选 JSONL 而不是整份 JSON 覆写，是为了单条坏数据不会毁掉整个文件
 *   （解析失败跳过那一行即可，其他机器的数据照样能用）。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sp = require("./storage-path");
const logger = require("./logger");

const IDENTITY_FILE = () => path.join(sp.resolve(), "cluster-identity.json");
const STATES_FILE = () => path.join(sp.resolve(), "cluster-states.jsonl");

/** 在线判定窗口：15 分钟没上报算离线（与 dingtalk-report 的 ONLINE_WINDOW_MS 对齐） */
const ONLINE_WINDOW_MS = 15 * 60 * 1000;

let identityCache = null;

/**
 * 取本机在集群里的身份。
 * 用「机器名 + 随机后缀」：机器名会变（改网名、重装），纯随机数不会冲突但不可读，
 * 两者兼顾 —— 人能从名字认出是哪台，随机后缀保证不撞。
 *
 * @returns {{clientId:string, host:string, createdAt:string}}
 */
function getIdentity() {
  if (identityCache) return identityCache;
  const file = IDENTITY_FILE();
  try {
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      if (j && j.clientId) {
        identityCache = j;
        return j;
      }
    }
  } catch (e) {
    logger.warn(`读取集群身份失败，将重新生成：${e.message}`);
  }
  let host = "";
  try {
    host = require("os").hostname() || "";
  } catch { /* 拿不到就用空串 */ }
  const suffix = crypto.randomBytes(4).toString("hex");
  const id = {
    clientId: `${host || "pc"}-${suffix}`,
    host,
    createdAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(id, null, 2), "utf8");
  } catch (e) {
    logger.warn(`写入集群身份失败（本次运行内仍可用，重启后会变）：${e.message}`);
  }
  identityCache = id;
  return id;
}

/**
 * 列出已知各机的上报状态。
 * @returns {Map<string, {clientId:string, host:string, at:string, payload:object}>}
 */
function listKnownClients() {
  const out = new Map();
  const file = STATES_FILE();
  let text = "";
  try {
    if (fs.existsSync(file)) text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const j = JSON.parse(s);
      if (j && j.clientId) out.set(j.clientId, j);
    } catch { /* 坏行跳过，不让一行坏数据毁掉整个列表 */ }
  }
  return out;
}

/**
 * 写一份上报记录（本机自报，或汇总机收到别的机器上报后落盘）。
 *
 * @param {object} record {clientId, host, at, payload}
 * @returns {{ok:boolean, clientId?:string, error?:string}}
 */
function upsertClient(record) {
  const rec = record && typeof record === "object" ? record : {};
  // ⚠️ 没有 clientId 的记录一律拒绝：汇总表按 clientId 去重，空 id 会互相覆盖，
  //    表现成「只有最后一台机器」这种极难查的错。
  const clientId = String(rec.clientId || "").trim();
  if (!clientId) return { ok: false, error: "缺少 clientId" };

  const entry = {
    clientId,
    host: String(rec.host || ""),
    at: String(rec.at || new Date().toISOString()),
    payload: rec.payload && typeof rec.payload === "object" ? rec.payload : {},
  };
  try {
    const existing = listKnownClients();
    existing.set(clientId, entry);
    const lines = Array.from(existing.values())
      .map((r) => JSON.stringify(r))
      .join("\n");
    fs.writeFileSync(STATES_FILE(), `${lines}\n`, "utf8");
    return { ok: true, clientId };
  } catch (e) {
    logger.warn(`写入上报状态失败：${e.message}`);
    return { ok: false, error: e.message };
  }
}

/**
 * 记录本机的完成情况（客户端定时调用 / 汇总机把自己的状态也并进去）。
 *
 * @param {object} payload 形如 {accounts:[{account, points, pc:{progress,max}, m:{...}, done, date}]}
 */
function reportSelf(payload) {
  const me = getIdentity();
  return upsertClient({
    clientId: me.clientId,
    host: me.host,
    at: new Date().toISOString(),
    payload: payload || {},
  });
}

/**
 * 供界面显示：本机身份 + 已知各机状态。
 *
 * ⚠️ 在线判定传**固定 now**（参数化），别在函数里取真实时间 —— 否则守卫断言
 *    会随运行时段假红/假绿（守卫铁律）。
 *
 * @param {number} [now] 固定当前时刻（毫秒）
 */
function getClusterView(now) {
  const me = getIdentity();
  const known = listKnownClients();
  const t = Number.isFinite(now) ? now : Date.now();
  const rows = Array.from(known.values()).sort((a, b) =>
    String(a.clientId).localeCompare(String(b.clientId))
  );
  return {
    me: { clientId: me.clientId, host: me.host, createdAt: me.createdAt },
    clients: rows.map((r) => ({
      clientId: r.clientId,
      host: r.host || "",
      at: r.at || "",
      online: t - Date.parse(r.at || 0) < ONLINE_WINDOW_MS,
      payload: r.payload || {},
      isMe: r.clientId === me.clientId,
    })),
  };
}

/** 清空各机上报状态（界面「重置集群数据」） */
function clearAll() {
  try {
    const f = STATES_FILE();
    if (fs.existsSync(f)) fs.rmSync(f);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  ONLINE_WINDOW_MS,
  getIdentity,
  listKnownClients,
  upsertClient,
  reportSelf,
  getClusterView,
  clearAll,
  STATES_FILE,
  IDENTITY_FILE,
};
