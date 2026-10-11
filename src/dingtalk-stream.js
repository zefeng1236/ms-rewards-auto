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
 *   谁都拼不出完整清单。所以由 dingtalkCluster.shouldBeHub() 唯一裁决。
 *
 * 【它解决什么】跨地点多客户端推送到同一个群时，一眼看出哪个账号没完成：
 *   ① 主实例收 Stream → 看到所有客户端推来的完成情况
 *   ② 客户端也主动 POST 上报（兜底，Stream 断了也能统计）
 *   ③ 定时汇总成一份报告推回群里（完成/未完成 + 积分进度 + 在线状态）
 */

const logger = require("./logger");

/** 当前连接状态（供界面显示与守卫用） */
const state = {
  client: null,
  connected: false,
  lastMessageAt: "",
  lastError: "",
  startedAt: "",
};

let DWClientMod = null;
let robotHandlerRef = null;

function loadSdk() {
  if (DWClientMod) return DWClientMod;
  try {
    // 延迟 require：SDK 不在依赖里时不要让整个主进程起不来
    const mod = require("dingtalk-stream");
    DWClientMod = {
      DWClient: mod.DWClient || (mod.default && mod.default.DWClient),
      TOPIC_ROBOT: mod.TOPIC_ROBOT || "*/v1.0/im/bot/messages/get",
    };
    if (!DWClientMod.DWClient) throw new Error("SDK 里找不到 DWClient 导出");
    return DWClientMod;
  } catch (e) {
    state.lastError = `dingtalk-stream 未安装或加载失败：${e.message}`;
    logger.warn(`[钉钉Stream] ${state.lastError}`);
    return null;
  }
}

/**
 * 从 Stream 收到的一条消息里，抽出「文本 + 是不是@ 了我们」。
 *
 * 钉钉 Stream 的机器人消息回调有多代格式（v1.0 与老版 text/ 嵌套不同），
 * 这里做**形状无关**的提取：递归找 text.content，再从 atUsers 里判断@。
 * 写死某一版的字段形状 → 钉钉一改就静默失效。
 *
 * @param {object} data 回调里的 data 字段
 * @returns {{text: string, mentioned: boolean, msgId: string, senderId: string}}
 */
function extractMessage(data) {
  const out = { text: "", mentioned: false, msgId: "", senderId: "" };
  if (!data || typeof data !== "object") return out;

  out.msgId = String(data.msgId || data.messageId || "");
  const sender = data.senderStaffId || data.senderId || "";
  out.senderId = typeof sender === "string" ? sender : String((sender && sender.staffId) || "");

  // 递归找 text（老格式是 data.text.content，新格式是 data.text.text）
  const found = findFirstText(data, 0);
  out.text = found;

  // @判断：atUsers 是数组，每项可能带 staffId / dingtalkId
  const ats = data.atUsers || (data.content && data.content.atUsers) || [];
  if (Array.isArray(ats) && ats.length) {
    // 只要消息里带了 @ 列表且文本里出现 @ 就算被@
    // ⚠️ 不去比对 staffId 是否是自己 —— @机器人时钉钉给的是机器人 id，
    //    各版本不一致；「群里@了谁」这个语义交给上层的过滤逻辑决定。
    out.mentioned = true;
  }
  if (!out.mentioned && /@\S+/.test(out.text)) out.mentioned = true;
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
  // 优先 text 字段（两代格式都在这），其次 content
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

/**
 * 启动 Stream 连接。
 *
 * @param {object} opts
 * @param {string} opts.appKey    Client ID（钉钉后台「凭证与基础信息」）
 * @param {string} opts.appSecret Client Secret
 * @param {(msg: {text:string, mentioned:boolean, msgId:string, senderId:string}, raw: object) => (void|Promise)} opts.onMessage
 * @returns {{ok: boolean, error?: string}}
 */
function start(opts) {
  const cfg = opts || {};
  if (state.client) return { ok: false, error: "Stream 已在运行（一个进程只允许一条连接）" };

  const appKey = String(cfg.appKey || "").trim();
  const appSecret = String(cfg.appSecret || "").trim();
  if (!appKey || !appSecret) {
    state.lastError = "Client ID / Client Secret 未配置";
    return { ok: false, error: state.lastError };
  }

  const sdk = loadSdk();
  if (!sdk) return { ok: false, error: state.lastError };

  try {
    const client = new sdk.DWClient({
      clientId: appKey,
      clientSecret: appSecret,
      // 官方 SDK 负责心跳与断线重连，这两参数只是给它更多确定性
      dingtalkRobotAPICall: undefined,
    });

    const robotHandler = new sdk.DWClient.robotCallback({
      onRobotMessage: async (msg) => {
        state.lastMessageAt = new Date().toISOString();
        const data = (msg && msg.data) || {};
        const parsed = extractMessage(data);
        try {
          if (cfg.onMessage) await cfg.onMessage(parsed, msg);
        } catch (e) {
          logger.warn(`[钉钉Stream] 处理消息出错：${e.message}`);
        }
        // ⚠️ 必须 ack：Stream 协议靠回执确认消费，不ack 会被钉钉判定连接异常
        try {
          this.socketCallBackResponse({ data: { content: JSON.stringify({}) }, messageId: parsed.msgId || (data && data.msgId) });
        } catch { /* 回执失败不影响主流程 */ }
      },
    });
    robotHandlerRef = robotHandler;

    client.registerMessageListener(sdk.TOPIC_ROBOT, robotHandler);
    client.start();
    state.client = client;
    state.connected = true;
    state.startedAt = new Date().toISOString();
    state.lastError = "";
    logger.info(`[钉钉Stream] 已启动（Client ID ${appKey.slice(0, 6)}…），等待群消息`);
    return { ok: true };
  } catch (e) {
    state.lastError = e && e.message ? e.message : String(e);
    state.client = null;
    state.connected = false;
    logger.warn(`[钉钉Stream] 启动失败：${state.lastError}`);
    return { ok: false, error: state.lastError };
  }
}

/** 停掉连接（切换设置项、退出程序时调） */
function stop() {
  try {
    if (state.client && typeof state.client.stop === "function") state.client.stop();
  } catch { /* 停不干净也不能带崩主流程 */ }
  state.client = null;
  state.connected = false;
  state.startedAt = "";
  logger.info("[钉钉Stream] 已停止");
}

function getState() {
  return {
    connected: state.connected,
    startedAt: state.startedAt,
    lastMessageAt: state.lastMessageAt,
    lastError: state.lastError,
  };
}

module.exports = {
  start,
  stop,
  getState,
  extractMessage,
};