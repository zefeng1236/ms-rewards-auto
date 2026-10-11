/**
 * 钉钉 Stream 模式连接：唯一能「收到群消息」的方式。
 *
 * ⚠️ 为什么不用自定义 webhook：官方文档明说自定义机器人
 *    「当前机器人尚不支持应答机制」「只发不收」—— 它没有收消息的通道。
 *    企业内部应用机器人的 Stream 模式走 WebSocket 长连接，才收得到。
 *
 * ✅ Stream 模式**不需要公网地址**：不用域名、不用 TLS、不用内网穿透。
 *    192.168.1.38 这类内网机器直接就能跑（HTTP 回调模式才需要）。
 *
 * ⚠️⚠️ 版本必须 >= 2.1.5：dingtalk-stream 2.1.0~2.1.2 把网关地址硬编码成
 *   预发布域名 `pre-api.dingtalk.com`，部分网络不可达，表现为
 *   `connect ETIMEDOUT` 且日志里没有任何其他线索（不会报权限错）。
 *   2.1.5 起才切到正式域名 api.dingtalk.com。**别回退到旧版。**
 *
 * 【主实例唯一性】—— 本模块**只应在「主实例」那一台启动**。
 *   群里只有一条消息流：A、B、C 三台各建一条 Stream 连接，
 *   同一条 @消息会被投递 3 次，且每台只知道自己那一半数据，
 *   谁都拼不出完整清单。所以由 cluster-hub.shouldBeHub() 唯一裁决。
 *
 * 【它解决什么】跨地点多客户端推送到同一个群时，一眼看出哪个账号没完成：
 *   ① 主实例收 Stream → 看到所有客户端推来的完成情况
 *   ② 客户端也主动 POST 上报（兜底，Stream 断了也能统计）
 *   ③ 定时汇总成一份报告推回群里（完成/未完成 + 积分进度 + 在线状态）
 *
 * 【SDK 真实 API（v2.1.5，2026-10-11 逐行核对过源码，别凭记忆写）】
 *   · 构造：new DWClient({ clientId, clientSecret, debug, keepAlive })
 *   · 注册：client.registerCallbackListener(TOPIC_ROBOT, cb)  ← 不是 registerMessageListener
 *   · 启动：await client.connect()                            ← 不是 start()
 *   · 停止：client.disconnect()                                ← 不是 stop()
 *   · 回调：CALLBACK 类型走 EventEmitter emit，SDK **不会自动回执**，
 *          必须自己调 client.socketCallBackResponse(messageId, {})，
 *          否则钉钉 60 秒后会重推同一条消息（群里会出现重复统计）。
 *   · msg.data 是 **JSON 字符串**，要先 JSON.parse。
 *
 * 【registered 与 connected 是两回事（实测踩到）】
 *   connect() 返回时 connected=true，但 registered 可能仍是 false ——
 *   前者表示 WebSocket 通了，后者表示**订阅被网关确认**。
 *   后台若没把机器人消息接收模式设为 Stream、或没加「机器人被群@」事件，
 *   就会出现「连上了但一条消息都收不到」。状态必须两个都暴露给界面，
 *   只报 connected 会让用户以为配好了（这正是最难查的那类静默失效）。
 */

const logger = require("./logger");

/** 当前连接状态（供界面显示与守卫用） */
const state = {
  connected: false,
  registered: false,
  reconnecting: false,
  lastMessageAt: "",
  lastError: "",
  startedAt: "",
  clientId: "",
};

let clientRef = null;
let statusTimer = null;
let sdkMod = null;

function loadSdk() {
  if (sdkMod) return sdkMod;
  try {
    // 延迟 require：SDK 不在依赖里时不要让整个主进程起不来
    const mod = require("dingtalk-stream");
    if (!mod || typeof mod.DWClient !== "function") {
      throw new Error("SDK 里找不到 DWClient 导出");
    }
    sdkMod = {
      DWClient: mod.DWClient,
      TOPIC_ROBOT: mod.TOPIC_ROBOT || "/v1.0/im/bot/messages/get",
    };
    return sdkMod;
  } catch (e) {
    state.lastError = `dingtalk-stream 未安装或加载失败：${e.message}`;
    logger.warn(`[钉钉Stream] ${state.lastError}`);
    return null;
  }
}

/**
 * 从 Stream 收到的一条消息里抽出「正文 + 群会话ID + 是否@ 了我们」。
 *
 * 真实形状（v2.1.5 的 RobotMessage，官方 constants.d.ts 定义的字段）：
 *   { conversationId, conversationType, senderNick, senderStaffId, senderId,
 *     msgId, msgtype, text: { content }, sessionWebhook, sessionWebhookExpiredTime,
 *     robotCode, chatbotCorpId, chatbotUserId, senderCorpId, isAdmin, createAt }
 *
 * ⚠️ **没有 atUsers 字段** —— 曾经按记忆写过 atUsers 判断，实际取到空数组，
 *    「是否被@」永远为 false。改按 conversationType 判断：
 *    "2"=群聊（群里**只有@了机器人**才会推给机器人，所以收到即被@），
 *    "1"=单聊（不需要@）。
 *
 * @param {object} data 解析后的回调 data
 * @returns {{text:string, mentioned:boolean, msgId:string, senderId:string,
 *            senderNick:string, conversationId:string, sessionWebhook:string,
 *            conversationType:string, msgtype:string}}
 */
function extractMessage(data) {
  const out = {
    text: "",
    mentioned: false,
    msgId: "",
    senderId: "",
    senderNick: "",
    conversationId: "",
    sessionWebhook: "",
    conversationType: "",
    msgtype: "",
  };
  if (!data || typeof data !== "object") return out;

  out.msgId = String(data.msgId || "");
  out.senderId = String(data.senderStaffId || data.senderId || "");
  out.senderNick = String(data.senderNick || "");
  out.conversationId = String(data.conversationId || "");
  out.sessionWebhook = String(data.sessionWebhook || "");
  out.conversationType = String(data.conversationType || "");
  out.msgtype = String(data.msgtype || "");

  // 正文：新版是 data.text.content；老版或别的消息类型是 data.text 字符串。
  // 兜底再递归找一次，钉钉改字段形状时不至于整条消息丢掉。
  if (data.text && typeof data.text.content === "string") out.text = data.text.content;
  else if (typeof data.text === "string") out.text = data.text;
  else out.text = findFirstText(data, 0);
  out.text = String(out.text || "").trim();

  // 群聊推过来 == 被@了（钉钉只在被@时推群消息给机器人）
  out.mentioned = out.conversationType === "2" ? true : out.conversationType === "1" ? false : /@/.test(out.text);
  return out;
}

/** 深度优先找第一个像正文的字符串字段（带深度上限防环形结构） */
function findFirstText(node, depth) {
  if (depth > 6 || node == null) return "";
  if (typeof node === "string") {
    // 排除明显的 id / 噪声字段值
    return node.length > 60 ? "" : node;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const t = findFirstText(item, depth + 1);
      if (t) return t;
    }
    return "";
  }
  if (typeof node !== "object") return "";
  for (const key of ["text", "content", "msg"]) {
    if (key in node) {
      const v = node[key];
      if (typeof v === "string") return v;
      const t = findFirstText(v, depth + 1);
      if (t) return t;
    }
  }
  return "";
}

/** 把 SDK 实例上的实时状态同步到本地 state（SDK 不改状态时不会通知） */
function syncStatus() {
  if (!clientRef) return;
  try {
    state.connected = !!clientRef.connected;
    state.registered = !!clientRef.registered;
    state.reconnecting = !!clientRef.reconnecting;
  } catch { /* 状态读失败不影响连接本身 */ }
}

/**
 * 启动 Stream 连接。
 *
 * @param {object} opts
 * @param {string} opts.appKey    Client ID（钉钉后台「凭证与基础信息」）
 * @param {string} opts.appSecret Client Secret
 * @param {boolean} [opts.debug]  打开 SDK 调试日志（排查连接问题用）
 * @param {(msg: object, raw: object) => (void|Promise)} opts.onMessage
 * @returns {Promise<{ok:boolean, error?:string, connected?:boolean, registered?:boolean}>}
 */
async function start(opts) {
  const cfg = opts || {};
  if (clientRef) return { ok: false, error: "Stream 已在运行（一个进程只允许一条连接）" };

  const appKey = String(cfg.appKey || "").trim();
  const appSecret = String(cfg.appSecret || "").trim();
  if (!appKey || !appSecret) {
    state.lastError = "Client ID / Client Secret 未配置";
    return { ok: false, error: state.lastError };
  }

  const sdk = loadSdk();
  if (!sdk) return { ok: false, error: state.lastError };

  let client;
  try {
    client = new sdk.DWClient({
      clientId: appKey,
      clientSecret: appSecret,
      // keepAlive 让 SDK 自己发心跳（8s 一次），长连接不会静默断掉
      keepAlive: true,
      debug: cfg.debug === true,
    });

    client.registerCallbackListener(sdk.TOPIC_ROBOT, (msg) => {
      state.lastMessageAt = new Date().toISOString();

      // data 是 JSON 字符串，解析失败也不能让回调抛（抛了 SDK 不会重试，消息就丢了）
      let data = {};
      try {
        data = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data || {};
      } catch (e) {
        logger.warn(`[钉钉Stream] 消息体解析失败：${e.message}`);
      }
      const parsed = extractMessage(data);

      // ⚠️ 先回执再干活：CALLBACK 模式下 SDK 不自动回执，超过 60 秒钉钉会重推，
      //    群统计会因此重复。回执本身很轻，不必等业务处理完。
      try {
        const messageId = (msg.headers && msg.headers.messageId) || parsed.msgId;
        if (messageId) client.socketCallBackResponse(messageId, {});
      } catch (e) {
        logger.warn(`[钉钉Stream] 回执失败（钉钉可能重推本条）：${e.message}`);
      }

      // 业务处理放回执之后，且异常必须自己吞掉 —— 不能让一条坏消息带崩连接
      Promise.resolve()
        .then(() => (cfg.onMessage ? cfg.onMessage(parsed, data) : null))
        .catch((e) => logger.warn(`[钉钉Stream] 处理消息出错：${e && e.message}`));
    });

    await client.connect();
  } catch (e) {
    state.lastError = e && e.message ? e.message : String(e);
    state.connected = false;
    state.registered = false;
    logger.warn(`[钉钉Stream] 启动失败：${state.lastError}`);
    try {
      if (client && typeof client.disconnect === "function") client.disconnect();
    } catch { /* 清不干净也不影响主流程 */ }
    return { ok: false, error: state.lastError };
  }

  clientRef = client;
  state.startedAt = new Date().toISOString();
  state.clientId = appKey;
  state.lastError = "";
  syncStatus();

  // SDK 只在收到网关 SYSTEM 帧时改内部状态、不发 EventEmitter 事件，
  // 所以这里轮询同步，界面才能看到 connected / registered 的真实变化。
  statusTimer = setInterval(syncStatus, 2000);
  if (statusTimer.unref) statusTimer.unref();

  logger.info(
    `[钉钉Stream] 已启动（Client ID ${appKey.slice(0, 6)}…）connected=${state.connected} registered=${state.registered}`
  );
  if (!state.registered) {
    logger.warn(
      "[钉钉Stream] ⚠️ 已连上网关但订阅未生效（registered=false）。" +
        "请到钉钉开发者后台：应用能力→机器人→消息接收模式选 Stream，" +
        "并在事件订阅里加上「机器人被群@」，然后**发布应用版本**。"
    );
  }
  return { ok: true, connected: state.connected, registered: state.registered };
}

/** 停掉连接（切换设置项、退出程序时调） */
function stop() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  try {
    if (clientRef && typeof clientRef.disconnect === "function") clientRef.disconnect();
  } catch { /* 停不干净也不能带崩主流程 */ }
  clientRef = null;
  state.connected = false;
  state.registered = false;
  state.reconnecting = false;
  state.startedAt = "";
  state.clientId = "";
  logger.info("[钉钉Stream] 已停止");
}

function getState() {
  syncStatus();
  return {
    running: !!clientRef,
    connected: state.connected,
    registered: state.registered,
    reconnecting: state.reconnecting,
    startedAt: state.startedAt,
    lastMessageAt: state.lastMessageAt,
    lastError: state.lastError,
    clientId: state.clientId,
  };
}

module.exports = {
  start,
  stop,
  getState,
  extractMessage,
  isRunning: () => !!clientRef,
};
