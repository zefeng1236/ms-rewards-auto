const logger = require("./logger");

/**
 * 把 URL 里的密钥部分打码，只留够辨认的头尾。
 * 日志会落盘、也可能被截图，webhook token 泄露等于别人能往你群里发消息。
 */
function maskSecret(s) {
  const str = String(s || "");
  if (!str) return "";
  if (str.length <= 4) return "****";
  if (str.length <= 10) return `${str.slice(0, 2)}****`;
  return `${str.slice(0, 4)}****${str.slice(-4)}`;
}

/** 查询参数里属于密钥的字段名 */
const SECRET_PARAMS = ["key", "access_token", "token", "push_key", "sendkey"];

/**
 * 生成可读且安全的目标地址描述
 *
 * 目的是让用户在控制台一眼看出「发到哪个平台、哪个机器人」，
 * 同时不把完整密钥打进日志。
 *
 * 输出示例：
 *   https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a****5aaa
 *   https://open.feishu.cn/open-apis/bot/v2/hook/9f3c****5b6c
 *   https://api.day.app/AbCd****9abc/<标题>/<正文>
 *
 * 注意：不要拿「pathname 末段」当密钥 —— Bark 的密钥在中间段，
 * 末段是标题正文（还可能是 URL 编码的中文），会误判。
 */
function describeTarget(url) {
  const raw = String(url || "");
  let u;
  try {
    u = new URL(raw);
  } catch {
    // 不是合法 URL（比如用户只填了个 key），整体打码
    return maskSecret(raw);
  }

  // 1) 查询参数里的密钥
  for (const k of [...u.searchParams.keys()]) {
    if (SECRET_PARAMS.includes(k.toLowerCase())) {
      u.searchParams.set(k, maskSecret(u.searchParams.get(k)));
    }
  }

  const host = u.hostname.toLowerCase();
  let pathname = u.pathname;

  // 2) Bark：/<key>/<title>/<body>，密钥固定在第一段
  if (host === "api.day.app") {
    const segs = pathname.split("/").filter(Boolean);
    if (segs.length >= 1) {
      segs[0] = maskSecret(segs[0]);
      // 后面的标题正文对定位目标没意义，且含中文编码会很难读，直接省略
      pathname = "/" + segs[0] + (segs.length > 1 ? "/…" : "");
    }
  }
  // 3) 飞书 / Slack 这类把 token 放在路径末段的 webhook
  else if (/^\/open-apis\/bot\/v2\/hook\//.test(pathname) || /\/services\//.test(pathname)) {
    const segs = pathname.split("/");
    const lastIdx = segs.length - 1;
    if (segs[lastIdx]) segs[lastIdx] = maskSecret(segs[lastIdx]);
    pathname = segs.join("/");
  }

  const query = u.searchParams.toString()
    ? "?" + decodeURIComponent(u.searchParams.toString())
    : "";
  return `${u.protocol}//${u.host}${pathname}${query}`;
}

/**
 * 归一化 Webhook 配置。
 * 用户常犯错误：只填 access_token / key，而不是完整 URL。
 * 这里自动识别并补全，避免 "Failed to parse URL" 错误。
 *
 * 规则：
 *   - 已经是 http(s):// 开头的，原样返回
 *   - 钉钉：补为 https://oapi.dingtalk.com/robot/send?access_token=<值>
 *   - 企业微信：补为 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<值>
 *   - 飞书：补为 https://open.feishu.cn/open-apis/bot/v2/hook/<值>
 */
function normalizeWebhook(raw, platform) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  switch (platform) {
    case "dingding":
      return `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(v)}`;
    case "wework":
      return `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(v)}`;
    case "feishu":
      return `https://open.feishu.cn/open-apis/bot/v2/hook/${encodeURIComponent(v)}`;
    default:
      return v;
  }
}

/**
 * 保证 content 里包含指定关键词（钉钉关键词安全模式需要）。
 * 已经包含就原样返回，否则在最前面补一次。
 * keyword 支持字符串（单个）或字符串数组（多个任选其一命中，未命中补第一个）。
 */
function ensureKeyword(content, keyword) {
  const src = (content == null) ? "" : String(content);
  if (!keyword) return src;
  const list = Array.isArray(keyword)
    ? keyword.map((k) => String(k)).filter(Boolean)
    : [String(keyword)];
  if (!list.length) return src;
  if (list.some((k) => src.includes(k))) return src;
  return `${list[0]} ${src}`;
}

/** 统一构造各通道的请求参数，测试与正式推送共用，避免两套逻辑跑偏 */
function buildRequests(notice, title, text, opts = {}) {
  const body = String(text == null ? "" : text);
  const content = opts.includeTitleInBody === false ? body : `${title}\n${body}`;
  const list = [];

  const weworkUrl = normalizeWebhook(notice.wework, "wework");
  if (weworkUrl) {
    list.push({
      channel: "企业微信",
      platform: "wework",
      url: weworkUrl,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ msgtype: "text", text: { content } }),
      },
    });
  }
  const dingdingUrl = normalizeWebhook(notice.dingding, "dingding");
  if (dingdingUrl) {
    const ddContent = ensureKeyword(content, notice.dingdingKeyword);
    list.push({
      channel: "钉钉",
      platform: "dingding",
      url: dingdingUrl,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ msgtype: "text", text: { content: ddContent } }),
      },
    });
  }
  const feishuUrl = normalizeWebhook(notice.feishu, "feishu");
  if (feishuUrl) {
    list.push({
      channel: "飞书",
      platform: "feishu",
      url: feishuUrl,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ msg_type: "text", content: { text: content } }),
      },
    });
  }
  if (notice.pushme) {
    list.push({
      channel: "PushMe",
      platform: "pushme",
      url: `https://push.i-i.me/get.php?push_key=${encodeURIComponent(notice.pushme)}&title=${encodeURIComponent(title)}&content=${encodeURIComponent(text)}`,
      init: { method: "GET" },
    });
  }
  if (notice.bark) {
    const key = notice.bark.replace(/^https?:\/\/(api\.day\.app)\//, "").split("/")[0];
    list.push({
      channel: "Bark",
      platform: "bark",
      url: `https://api.day.app/${encodeURIComponent(key)}/${encodeURIComponent(title)}/${encodeURIComponent(text)}`,
      init: { method: "GET" },
    });
  }
  return list;
}

/**
 * 根据平台的响应 JSON 判断「业务层」是否成功。
 * 钉钉/企微/飞书 都会先返回 HTTP 200，再用 errcode / StatusCode / code 字段
 * 表示真实业务结果。之前只看 HTTP 状态码，会出现"日志写成功但实际机器人没响"的假象。
 */
function judgeBusinessOk(req, bodyText) {
  if (!bodyText) return { ok: true, detail: null };
  // 优先尝试 JSON 解析
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return { ok: true, detail: null }; // 非 JSON，按 HTTP 层判断为准
  }
  if (!data || typeof data !== "object") return { ok: true, detail: null };

  const platform = req.platform || "";
  const fmt = (code, msg) => `业务码=${code}${msg ? `，消息=${msg}` : ""}`;

  // 钉钉：errcode === 0 才成功；常见 310000=关键词不匹配/签名不对
  if (platform === "dingding") {
    if (Object.prototype.hasOwnProperty.call(data, "errcode")) {
      const ok = data.errcode === 0;
      return { ok, detail: ok ? null : fmt(data.errcode, data.errmsg) };
    }
  }
  // 企业微信：errcode === 0
  if (platform === "wework") {
    if (Object.prototype.hasOwnProperty.call(data, "errcode")) {
      const ok = Number(data.errcode) === 0;
      return { ok, detail: ok ? null : fmt(data.errcode, data.errmsg) };
    }
  }
  // 飞书：code === 0 或 StatusCode === 0
  if (platform === "feishu") {
    if (Object.prototype.hasOwnProperty.call(data, "code")) {
      const ok = Number(data.code) === 0;
      return { ok, detail: ok ? null : fmt(data.code, data.msg || data.message) };
    }
    if (Object.prototype.hasOwnProperty.call(data, "StatusCode")) {
      const ok = Number(data.StatusCode) === 0;
      return { ok, detail: ok ? null : fmt(data.StatusCode, data.StatusMessage || data.msg) };
    }
  }
  // Bark：code === 200
  if (platform === "bark" && Object.prototype.hasOwnProperty.call(data, "code")) {
    const ok = Number(data.code) === 200;
    return { ok, detail: ok ? null : fmt(data.code, data.message) };
  }
  return { ok: true, detail: null };
}

/** 发一个请求并把结果写进日志（含具体地址） */
async function fire(req, { verbose = false } = {}) {
  const target = describeTarget(req.url);
  if (verbose) logger.log("📨", `${req.channel} → ${req.init.method || "GET"} ${target}`);
  const started = Date.now();
  try {
    const r = await fetch(req.url, { ...req.init, signal: AbortSignal.timeout(8000) });
    const ms = Date.now() - started;
    let body = "";
    try {
      body = (await r.text()).slice(0, 400);
    } catch {}

    // 协议层成功 + 业务层成功 的双条件判定
    const httpOk = r.ok;
    const biz = judgeBusinessOk(req, body);
    const ok = httpOk && biz.ok;
    const bizTag = biz.detail ? `，业务异常：${biz.detail}` : "";
    const line = `${req.channel} → ${target} | HTTP ${r.status}${bizTag} | ${ms}ms${body ? ` | ${body}` : ""}`;
    if (ok) logger.ok(`推送成功: ${line}`);
    else logger.warn(`推送${httpOk ? "业务失败" : "异常"}: ${line}`);
    return { channel: req.channel, target, ok, status: r.status, ms, body, bizOk: biz.ok, bizDetail: biz.detail };
  } catch (e) {
    const ms = Date.now() - started;
    const reason = e && e.name === "TimeoutError" ? "请求超时（8 秒）" : e.message;
    logger.warn(`推送失败: ${req.channel} → ${target} | ${reason} | ${ms}ms`);
    return { channel: req.channel, target, ok: false, status: 0, ms, error: reason };
  }
}

/**
 * 给推送正文加上账号用户名，避免多账号运行时无法辨认消息来源。
 * @param {object} ctx 账户上下文
 * @param {string} text
 */
function withAccountHeader(ctx, text) {
  const body = String(text == null ? "" : text);
  if (/^用户名[：:]/m.test(body)) return body;
  const name = String(ctx && (ctx.name || ctx.id) || "未知账号");
  return `用户名：${name}\n${body}`;
}

/**
 * 发送文本通知（多通道）
 * @param {object} ctx 账户上下文
 * @param {string} title
 * @param {string} text
 */
async function sendText(ctx, title, text) {
  const cfg = ctx.config.get();
  const content = withAccountHeader(ctx, text);
  const isSummary = /^Rewards 运行汇总/.test(String(title || ""));
  const reqs = buildRequests(cfg.notice || {}, title, content, { includeTitleInBody: !isSummary });
  if (!reqs.length) return [];
  const results = await Promise.allSettled(reqs.map((r) => fire(r)));
  return results.map((r) => (r.status === "fulfilled" ? r.value : { ok: false, error: String(r.reason) }));
}

/**
 * 发送每日运行汇总
 * @param {object} ctx 账户上下文
 * @param {string} summary 多行文本（首行会显示用户名）
 */
async function sendSummary(ctx, summary) {
  const date = ctx.state.getDateHyphen();
  await sendText(ctx, `Rewards 运行汇总 ${date}`, withAccountHeader(ctx, summary));
}

/**
 * 测试推送：把配置好的通道全都试一遍，日志里打出具体地址与响应
 *
 * @param {object} notice 推送配置（直接传值，方便测试「尚未保存」的表单内容）
 * @param {string} label  显示在标题里的来源说明
 */
async function testPush(notice, label = "测试") {
  const cfg = notice || {};
  const title = `Rewards 推送测试（${label}）`;
  const text = `这是一条测试消息。\n发送时间：${new Date().toLocaleString("zh-CN")}\n若你收到此消息，说明该通道配置正确。`;
  const reqs = buildRequests(cfg, title, text);

  if (!reqs.length) {
    logger.warn("推送测试：没有配置任何通道，请先填写至少一个 Webhook 或 Key");
    return { ok: false, total: 0, results: [], reason: "未配置任何推送通道" };
  }

  logger.log("📨", `推送测试开始，共 ${reqs.length} 个通道：${reqs.map((r) => r.channel).join("、")}`);
  const settled = await Promise.allSettled(reqs.map((r) => fire(r, { verbose: true })));
  const results = settled.map((s, i) =>
    s.status === "fulfilled" ? s.value : { channel: reqs[i].channel, target: describeTarget(reqs[i].url), ok: false, error: String(s.reason) }
  );
  const okCount = results.filter((r) => r.ok).length;
  const summary = `推送测试结束：${okCount}/${results.length} 个通道成功`;
  if (okCount === results.length) logger.success(summary);
  else logger.warn(`${summary}（失败：${results.filter((r) => !r.ok).map((r) => r.channel).join("、")}）`);

  return { ok: okCount > 0, total: results.length, okCount, results };
}

module.exports = { sendText, sendSummary, testPush, describeTarget, buildRequests, ensureKeyword, normalizeWebhook, judgeBusinessOk };
