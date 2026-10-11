/**
 * 钉钉「企业内部应用机器人」发送通道。
 *
 * 【为什么不能直接用 notify.js 那套 webhook】
 *   自定义 webhook 机器人是**群内独立机器人**，一条 URL 对应一个群，
 *   只能发不能收。而本模块走的是**企业内部应用机器人**（走 OpenAPI），
 *   它和 Stream 收消息共用同一个应用身份 —— 同一个 robotCode
 *   既能收（Stream）又能发（groupMessages/send），这才是「统计机器人」
 *   这条链路成立的前提。
 *
 * 【与 notify.js 的分工】
 *   · notify.js/webhook：把每日运行汇总发进群（原有能力，继续用）
 *   · 本模块：把「多客户端统计报告」发进群（新增能力）
 *   两者是两条独立通道，配置也各自独立，互不影响。
 *
 * 【发送需要的三样东西】
 *   ① appKey / appSecret —— 换 accessToken
 *   ② robotCode         —— 官方取 AppKey（企业内部应用机器人的 robotCode
 *                          就是应用的 Client ID / AppKey）
 *   ③ openConversationId —— 群会话ID。**这个最难拿**，两种来源：
 *        a) 群消息回调里自带（Stream 收到一次就学到了）→ 自动落盘
 *        b) 配置里手填
 *      优先级：配置 > 学到缓存。学到了就写进 storage，下次重启不用再等消息。
 *
 * 【accessToken 要缓存】官方 expireIn 是 7200 秒，每次发消息都换一次
 *   会被限流（QPS 限制 + 每日调用量），所以缓存到过期前 5 分钟。
 */

const logger = require("./logger");
const { httpRequest } = require("./http");
const sp = require("./storage-path");
const fs = require("fs");
const path = require("path");

const TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken";
const SEND_URL = "https://api.dingtalk.com/v1.0/robot/groupMessages/send";

/** accessToken 缓存（进程内） */
let tokenCache = { token: "", expireAt: 0, appKey: "" };

/** 学到的 openConversationId 落盘位置 */
const CONV_FILE = () => path.join(sp.resolve(), "dingtalk-conversation.json");

/**
 * 读取学到的群会话ID（Stream 收到消息时写入）。
 * @returns {{openConversationId:string, learnedAt:string}}
 */
function loadLearnedConversation() {
  try {
    const f = CONV_FILE();
    if (!fs.existsSync(f)) return { openConversationId: "", learnedAt: "" };
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    return {
      openConversationId: String((j && j.openConversationId) || ""),
      learnedAt: String((j && j.learnedAt) || ""),
    };
  } catch (e) {
    logger.warn(`读取钉钉群会话ID缓存失败：${e.message}`);
    return { openConversationId: "", learnedAt: "" };
  }
}

/**
 * 记下从消息里学到的群会话ID。
 *
 * ⚠️ 只在**变化时**才写盘：每条群消息都写一次会造成无意义的磁盘抖动，
 *    而且日志会被刷屏。
 *
 * @param {string} convId
 * @returns {boolean} 是否真的更新了
 */
function learnConversation(convId) {
  const id = String(convId || "").trim();
  if (!id) return false;
  const cur = loadLearnedConversation();
  if (cur.openConversationId === id) return false;
  try {
    fs.writeFileSync(
      CONV_FILE(),
      JSON.stringify({ openConversationId: id, learnedAt: new Date().toISOString() }, null, 2),
      "utf8"
    );
    logger.info(`[钉钉] 已记下群会话ID：${id.slice(0, 12)}…（后续报告直接发这个群）`);
    return true;
  } catch (e) {
    logger.warn(`写入钉钉群会话ID失败：${e.message}`);
    return false;
  }
}

/**
 * 决定往哪个群发。
 * 配置里填了就用配置的（用户显式指定优先），否则用学到的。
 *
 * @param {object} clusterCfg 全局配置 cluster 段
 * @returns {string}
 */
function resolveConversationId(clusterCfg) {
  const fromCfg = String((clusterCfg && clusterCfg.openConversationId) || "").trim();
  if (fromCfg) return fromCfg;
  return loadLearnedConversation().openConversationId;
}

/**
 * 取 accessToken（带缓存）。
 *
 * @param {object} clusterCfg
 * @param {boolean} [force] 忽略缓存强制刷新（token 被吊销时用）
 * @returns {Promise<{ok:boolean, token?:string, error?:string}>}
 */
async function getAccessToken(clusterCfg, force) {
  const cfg = clusterCfg || {};
  const appKey = String(cfg.appKey || "").trim();
  const appSecret = String(cfg.appSecret || "").trim();
  if (!appKey || !appSecret) {
    return { ok: false, error: "Client ID / Client Secret 未配置" };
  }
  // 缓存命中：同一 appKey 且还没到过期保护线
  if (
    !force &&
    tokenCache.token &&
    tokenCache.appKey === appKey &&
    Date.now() < tokenCache.expireAt
  ) {
    return { ok: true, token: tokenCache.token };
  }

  const res = await httpRequest({
    url: TOKEN_URL,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    data: { appKey, appSecret },
    dontLog: true,
  });
  if (res.status !== 200) {
    const msg = `换取 accessToken 失败：HTTP ${res.status} ${String(res.text || "").slice(0, 160)}`;
    logger.warn(`[钉钉] ${msg}`);
    return { ok: false, error: msg };
  }
  let token = "";
  let expireIn = 7200;
  try {
    const j = JSON.parse(res.text || "{}");
    token = String(j.accessToken || "");
    if (Number.isFinite(j.expireIn)) expireIn = j.expireIn;
  } catch (e) {
    return { ok: false, error: `accessToken 响应解析失败：${e.message}` };
  }
  if (!token) return { ok: false, error: "accessToken 响应里没有 accessToken 字段" };

  // 提前 5 分钟失效，避免边界上刚好过期
  tokenCache = {
    token,
    appKey,
    expireAt: Date.now() + Math.max(60, expireIn - 300) * 1000,
  };
  return { ok: true, token };
}

/** 清掉 token 缓存（改了密钥、或者收到 401 时调） */
function clearTokenCache() {
  tokenCache = { token: "", expireAt: 0, appKey: "" };
}

/**
 * 往群里发一条 markdown 消息（企业内部应用机器人）。
 *
 * @param {object} clusterCfg 全局配置 cluster 段
 * @param {string} title markdown 标题
 * @param {string} text  markdown 正文
 * @returns {Promise<{ok:boolean, error?:string, conversationId?:string, raw?:object}>}
 */
async function sendGroupMarkdown(clusterCfg, title, text) {
  const cfg = clusterCfg || {};
  const robotCode = String(cfg.appKey || "").trim();
  if (!robotCode) return { ok: false, error: "Client ID 未配置（robotCode 取 Client ID）" };

  const convId = resolveConversationId(cfg);
  if (!convId) {
    return {
      ok: false,
      error:
        "还没有群会话ID。两种拿法：① 在群里 @一次机器人（收到消息后自动记下）；" +
        "② 在设置里手填 openConversationId。",
    };
  }

  const tok = await getAccessToken(cfg);
  if (!tok.ok) return { ok: false, error: tok.error };

  const body = {
    robotCode,
    openConversationId: convId,
    // 官方消息类型标识：sampleMarkdown → 群里渲染成 markdown 卡片
    msgKey: "sampleMarkdown",
    msgParam: JSON.stringify({ title: String(title || ""), text: String(text || "") }),
  };

  let res = await httpRequest({
    url: SEND_URL,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acs-dingtalk-access-token": tok.token,
    },
    data: body,
    dontLog: true,
  });

  // token 可能被后台重置 —— 收到 401 就强刷一次再试一次（只重试一次，不递归）
  if (res.status === 401) {
    clearTokenCache();
    const retry = await getAccessToken(cfg, true);
    if (retry.ok) {
      res = await httpRequest({
        url: SEND_URL,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": retry.token,
        },
        data: body,
        dontLog: true,
      });
    }
  }

  if (res.status !== 200) {
    const msg = `发送群消息失败：HTTP ${res.status} ${String(res.text || "").slice(0, 200)}`;
    logger.warn(`[钉钉] ${msg}`);
    return { ok: false, error: msg, conversationId: convId };
  }

  let raw = {};
  try {
    raw = JSON.parse(res.text || "{}");
  } catch { /* 成功但响应不是 JSON，不影响结果 */ }
  // 官方成功响应形如 {processQueryKey: "..."}；有些版本返回空对象
  logger.success(`[钉钉] 统计报告已发往群 ${convId.slice(0, 12)}…`);
  return { ok: true, conversationId: convId, raw };
}

/**
 * 配置自检：只验「换 token」这一步能不能过。
 *
 * 为什么不直接发一条测试消息：往群里发测试消息会打扰所有人，
 * 而且如果 openConversationId 还没拿到就必然失败，会把「密钥对不对」
 * 这个无关的问题混进来。换 token 成功就说明 appKey/appSecret/应用状态
 * 都是通的，剩下的只是群ID的问题，界面能分开提示。
 *
 * @param {object} clusterCfg
 * @returns {Promise<{ok:boolean, error?:string, conversationId?:string, hasConversation:boolean, tokenMasked?:string}>}
 */
async function testConnection(clusterCfg) {
  const cfg = clusterCfg || {};
  const tok = await getAccessToken(cfg, true);
  const convId = resolveConversationId(cfg);
  if (!tok.ok) {
    return { ok: false, error: tok.error, hasConversation: !!convId };
  }
  const t = tok.token;
  return {
    ok: true,
    hasConversation: !!convId,
    conversationId: convId,
    tokenMasked: t ? `${t.slice(0, 6)}…${t.slice(-4)}` : "",
  };
}

module.exports = {
  sendGroupMarkdown,
  testConnection,
  learnConversation,
  loadLearnedConversation,
  resolveConversationId,
  getAccessToken,
  clearTokenCache,
  TOKEN_URL,
  SEND_URL,
};
