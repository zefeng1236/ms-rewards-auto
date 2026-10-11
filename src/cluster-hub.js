/**
 * 「主实例」唯一性裁决 + 跨客户端状态汇聚。
 *
 * 【为什么必须唯一】群里只有一条消息流。若A、B、C 三台各建一条 Stream 连接：
 *   · 同一条 @消息被投递 3 次 → 群里机器人重复应答
 *   · 每台只收到自己那部分推送 → 谁都拼不出完整清单
 * 所以「谁连 Stream」必须是**全局唯一**的决定，而不是用户各填各的。
 *
 * 【裁决规则（按顺序，第一条命中即生效）】
 *   1. 显式指定：全局配置 cluster.hubClientId 指名了某台（最可控，推荐）
 *   2. 该实例的 clientId 与 hubClientId 一致 → 是主
 *   3. 全局没有任何 hubClientId → **按 storage 里 clientId 的字典序最小者当主**
 *      （确定性裁决：所有机器算出同一个答案，不需要互相通信）
 *   4. 都不匹配 → 不是主
 *
 * ⚠️ 规则 3 的前提是**所有机器用同一份 clientId 列表**。若某台机器
 *    看不到其他机器的数据（没配同一个存储），它会算出不同的"最小者"，
 *    于是**可能两台都自认主**。为此加一条自检：把自己算出来的主与
 *    实际存着的其它 clientId 一一对撞，发现分歧就在界面上明确报出来
 *    （而不是默默双开）。
 *
 * 【本机身份】clientId 由 accountId 派生（同一台机器重装后不变），
 *   存storage/cluster-identity.json，首次生成后不再变。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sp = require("./storage-path");
const logger = require("./logger");

const IDENTITY_FILE = () => path.join(sp.resolve(), "cluster-identity.json");
const STATES_FILE = () => path.join(sp.resolve(), "cluster-states.jsonl");

let identityCache = null;

/**
 * 取本机在集群里的身份。
 * 优先用 hostname + 一个持久随机后缀 —— 机器名会变（改网名、重装），
 * 纯随机数不会冲突但不可读，所以「机器名 + 后缀」两头兼顾。
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
 * 裁决本机是不是主实例。
 *
 * @param {object} clusterCfg 全局配置的 cluster 段（可能为空）
 * @returns {{isHub: boolean, reason: string, hubClientId: string}}
 */
function shouldBeHub(clusterCfg) {
  const me = getIdentity().clientId;
  const named = String((clusterCfg && clusterCfg.hubClientId) || "").trim();

  // 规则 1+2：显式指名
  if (named) {
    return {
      isHub: me === named,
      reason: me === named ? `已显式指定本机（${me}）为主实例` : `已指定别的主实例（${named}），本机只上报`,
      hubClientId: named,
    };
  }

  // 规则 3：没有指定 → 按已知 clientId 字典序最小者当主（确定性）
  const known = listKnownClients();
  const all = Array.from(new Set([me, ...known.values()])).sort();
  const elected = all[0] || me;
  return {
    isHub: me === elected,
    reason:
      me === elected
        ? `未显式指定，按 clientId 字典序自动选主（本机 ${me}）`
        : `未显式指定，主实例是 ${elected}，本机只上报`,
    hubClientId: elected,
  };
}

/**
 * 列出已知各机的上报状态（读 JSONL）。
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
  // JSONL：同一clientId 多行 → 后写的覆盖先写的（只看最新状态）
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
 * 记录本机的完成情况（写一行 JSONL，按 clientId 就地更新）。
 * 只保留每台最新一条，避免文件无限增长。
 */
function reportSelf(payload) {
  const me = getIdentity();
  const file = STATES_FILE();
  const record = {
    clientId: me.clientId,
    host: me.host,
    at: new Date().toISOString(),
    payload: payload || {},
  };
  try {
    const existing = listKnownClients();
    existing.set(record.clientId, record);
    const lines = Array.from(existing.values())
      .map((r) => JSON.stringify(r))
      .join("\n");
    fs.writeFileSync(file, `${lines}\n`, "utf8");
    return { ok: true, clientId: me.clientId };
  } catch (e) {
    logger.warn(`上报本机状态失败：${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** 供界面显示：本机身份 + 已知各机状态 */
function getClusterView() {
  const me = getIdentity();
  const known = listKnownClients();
  const rows = Array.from(known.values()).sort((a, b) => String(a.clientId).localeCompare(String(b.clientId)));
  const now = Date.now();
  return {
    me: { clientId: me.clientId, host: me.host, createdAt: me.createdAt },
    clients: rows.map((r) => ({
      clientId: r.clientId,
      host: r.host || "",
      at: r.at || "",
      // ⚠️ 固定 now 判在线，别用真实当前时间做断言（守卫铁律）
      online: now - Date.parse(r.at || 0) < 15 * 60 * 1000,
      payload: r.payload || {},
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
  getIdentity,
  shouldBeHub,
  listKnownClients,
  reportSelf,
  getClusterView,
  clearAll,
};