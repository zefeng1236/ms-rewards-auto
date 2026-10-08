const logger = require("./logger");
const hitokoto = require("./hitokoto");
// 一言的「句子类型」0.14.14 起住在外观配置里（界面侧三件套都在 appearance），
// 推送侧要取同一份类型，所以这里直接读 appearance ——
// 不能从 notice 读，那个字段已经迁走了（推送侧只剩开关 hitokotoInPush）。
const appearance = require("./appearance");
const { displayVersion } = require("./version");
// markdown 排版与三家 IM 的方言适配（钉钉/企微/飞书各一套，详见该文件头注释）
const md = require("./notify-markdown");

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
 *
 * ⚠️ 2026-10-08：**比较的是「纯文本」**（先剥 markdown 标记），不是原始正文。
 *   改用 markdown 后正文里会有 `**`、`- ` 等标记，而钉钉的关键词安全模式
 *   是按纯文本匹配的 —— 若拿带标记的正文去比，用户设的关键词永远匹配不上，
 *   结果就是消息被钉钉静默丢弃（errcode 310000）。
 */
function ensureKeyword(content, keyword) {
  const src = (content == null) ? "" : String(content);
  if (!keyword) return src;
  const list = Array.isArray(keyword)
    ? keyword.map((k) => String(k)).filter(Boolean)
    : [String(keyword)];
  if (!list.length) return src;
  // 用剥掉 markdown 后的纯文本判断「用户想说的那句话在不在」
  if (md.stripMarkdown(src).includes(list[0])) return src;
  if (list.some((k) => md.stripMarkdown(src).includes(k))) return src;
  return `${list[0]}\n\n${src}`;
}

/** 统一构造各通道的请求参数，测试与正式推送共用，避免两套逻辑跑偏 */
function buildRequests(notice, title, text) {
  // 标题**不再**拼进正文开头：markdown 版式把标题放进各平台的
  // title / header 字段（钉钉 markdown.title、飞书卡片 header、企微正文首行），
  // 正文只放内容。否则首屏标题与正文标题会重复显示两次。
  // 曾经这里有个 includeTitleInBody 开关（汇总推送不拼标题），
  // 改markdown 后已无意义 —— 汇总推送的标题同样该走 title 字段，故彻底删除。
  const content = String(text == null ? "" : text);
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
        // 企业微信 markdown：标题放正文首行（它没有独立 title 字段）
        body: JSON.stringify(md.weworkBody(title, md.buildMarkdown(title, content))),
      },
    });
  }
  const dingdingUrl = normalizeWebhook(notice.dingding, "dingding");
  if (dingdingUrl) {
    const mdText = md.buildMarkdown(title, content);
    // 关键词补在 markdown 化**之后**、发送之前，保证补进去的词也在正文里
    const ddText = ensureKeyword(mdText, notice.dingdingKeyword);
    list.push({
      channel: "钉钉",
      platform: "dingding",
      url: dingdingUrl,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify(md.dingdingBody(title, ddText)),
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
        // 飞书没有 markdown 消息类型，走 interactive 卡片
        body: JSON.stringify(md.feishuBody(title, md.buildMarkdown(title, content))),
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
 * 用户名 Header 的标准格式：用户名后空几格（全角空格更稳）+ 软件版本号。
 *
 * 版本号统一复用 src/version.js 的 displayVersion()，不在这里手工拼字符串——
 * 否则每次发版都会漏改一处，推送里出现的版本与实际运行版本不一致。
 */
/**
 * 运行环境标签：PC（Electron 桌面版）还是 Docker（Web 服务端）。
 *
 * 判定依据：Electron 主进程才有 process.versions.electron；
 * Docker / Web 版跑的是 src/server.js，没有这个字段。
 * 多实例/多端看同一批推送时，光有版本号分不清这条来自哪一端。
 */
function runtimeTag() {
  const hasElectron = !!(process.versions && process.versions.electron);
  return hasElectron ? "PC" : "Docker";
}

function accountHeaderLine(ctx) {
  // 无账户上下文（如推送测试）时不生成用户名行，避免冒出「用户名：未知账号」
  if (!ctx) return "";
  const name = String(ctx.name || ctx.id || "未知账号");
  let ver = "";
  try {
    ver = displayVersion();
  } catch {
    ver = "";
  }
  // 版本号后补运行环境，形如 v0.13.14(PC) —— 用户 2026-10-03 要求区分端
  const tail = ver ? `v${ver}(${runtimeTag()})` : `(${runtimeTag()})`;
  // ⚠️ 中间只留**两个半角空格**：早先用的是两个全角空格（　　），钉钉移动端
  //    按字符宽度算会把版本号挤到下一行，看起来像断了（用户 2026-10-09 反馈）。
  //    版本号不被挤走的真正保障在 buildMarkdown —— 这一行整个独立成块，
  //    不与后面的正文黏在同一段（钉钉 markdown 不认单个换行符）。
  return `用户名：${name}  ${tail}`;
}

/**
 * 给推送正文套上统一外壳：用户名+版本号一行、一言固定在末行。
 *
 * 格式（一句话一目）：
 *   ┌ 用户名：xxx　　v0.13.11
 *   │ ……正文……
 *   │ 🏅 目标行（勋章图标在 goals.formatOne 里加）
 *   │
 *   └ 每日一言（可选，末行前空一行）
 *
 * 「位置」与「新鲜度」是两个正交维度，别混成一个改动：
 *   - 位置：一言永远在**末行**，首行留给标题/用户名（多账户一眼可辨）；
 *   - 新鲜度：推送时 force 跳过 TTL 取新句，只影响「取哪一句」。
 * 早先版本为了让汇总推送刷新一言而误改位置，把用户名挤到了第二行。
 *
 * 一言按 15 秒 TTL 缓存（见 ./hitokoto.js），推送时 force 跳过缓存取新句。
 * 句子类型跟随 notice.hitokotoTypes（接口 c 参数，空数组 = 不限类型）。
 * 接口不可用或用户关闭时静默跳过，
 * 绝不能因为拿不到一句话就把整条推送卡住 —— 推送的价值在任务结果本身。
 *
 * 注意：本函数是推送外壳的**唯一**拼装点。调用方（sendText）只调用它一次，
 * 别在上层提前 withAccountHeader 再传进来，否则末尾一言会重复出现两次。
 *
 * @param {object} ctx     账户上下文（提供 name 与 config.notice）
 * @param {string} text    正文
 * @param {object} [opts]
 * @param {object} [opts.notice]   无账户上下文时直接传入推送配置（测试推送用）
 * @param {boolean} [opts.quote]   是否附加一言，默认按配置的 notice.hitokotoInPush
 *                              （旧配置只有 hitokoto 时由 normalize 兜底）
 * @param {boolean} [opts.force]   一言是否跳过 30 秒缓存取新句（推送时用）
 * @returns {Promise<string>}
 */
/**
 * 取当天的一言正文（已拼接作者），关闭或接口不可用时返回空串。
 *
 * 抽成单一出口，是为了让所有调用方共用同一条开关 + 降级判断，
 * 避免口径漂移导致一处加一处不加。
 *
 * @param {object} notice     推送配置（只用其中的开关 hitokotoInPush）
 * @param {boolean} [override] 显式开关；未传则跟随 notice.hitokotoInPush（缺省 true）。
 *                             旧配置只有 notice.hitokoto 没有 hitokotoInPush 时，
 *                             global-config 的 migrateNoticeHitokoto 会按 hitokoto
 *                             同值兜底（保持旧意图），所以这里直接读即可。
 * @param {boolean} [force]    跳过 TTL 缓存重新请求（推送时取新句用）
 * @returns {Promise<string>}
 */
async function quoteLine(notice, override, force = false) {
  const cfg = notice || {};
  const off = override != null ? override === false : cfg.hitokotoInPush === false;
  if (off) return "";
  try {
    // 句子类型读**外观配置**（0.14.14 从 notice 迁到 appearance），
    // 空数组 = 不限类型。读盘失败时按不限处理，绝不因为读不到配置就卡住推送。
    let types = [];
    try {
      types = appearance.get()?.hitokotoTypes || [];
    } catch {
      types = [];
    }
    return hitokoto.format(await hitokoto.get({ force, types }));
  } catch {
    // 公益接口超时/不可用时静默跳过：只为美观，不值得阻塞任务推送
    return "";
  }
}

async function withAccountHeader(ctx, text, opts = {}) {
  let body = String(text == null ? "" : text);
  const head = accountHeaderLine(ctx);

  if (head && opts.header !== false) {
    if (/^用户名[：:]/m.test(body)) {
      // 正文自带用户名行（如每日汇总）：把版本号补到那一行末尾，不另起一行
      const m = body.match(/^用户名[：:].*$/m);
      const old = m ? m[0] : "";
      if (old && !/v\d+\.\d+/.test(old)) body = body.replace(old, head);
    } else {
      body = `${head}\n${body}`;
    }
  }

  // 一言：默认跟随推送配置 notice.hitokotoInPush 开关（界面侧的一言开关独立）。
  // 位置固定在**消息末尾**（前面空一行）——首行留给标题/用户名，
  // 多账户时一眼就能看出这条推送来自哪个账号，不会被一句话挤走。
  const notice =
    opts.notice || (ctx && ctx.config && typeof ctx.config.get === "function" ? ctx.config.get().notice : null);
  const line = await quoteLine(notice, opts.quote, opts.force === true);
  if (line) {
    // 已经在别处加过同一句话就不要再加（防止重复）
    const hasQuote = body.includes(line);
    if (!hasQuote) body = `${body}\n\n${line}`;
  }
  return body;
}

/**
 * 发送文本通知（多通道）
 * @param {object} ctx 账户上下文
 * @param {string} title
 * @param {string} text
 */
async function sendText(ctx, title, text) {
  const cfg = ctx.config.get();
  const noticeCfg = cfg.notice || {};

  // 一言固定在**末段**（由 withAccountHeader 统一拼装，前面空一行）。
  // 首行留给用户名（汇总推送）或正文，保证多账户场景下一眼看出这条推送来自哪个账号。
  //
  // 刷新口径：推送时 force 取新句（30 秒 TTL 太短，不 force 可能推到界面正显示的旧句）。
  // force 只影响「取哪一句」，不影响「放在哪里」。
  const content = await withAccountHeader(ctx, text, { force: true });

  const reqs = buildRequests(noticeCfg, title, content);
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
  // 外壳（用户名+版本号 / 一言）由 sendText → withAccountHeader 统一拼一次即可。
  // 这里不再二次调用 withAccountHeader —— 否则一句话会在首行与末行各出现两遍。
  await sendText(ctx, `Rewards 运行汇总 ${date}`, summary);
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
  // 测试推送也套同一层外壳（含版本号与一言），这样用户点一下就能预览
  // 真实任务推送的完整观感，而不是只看到一句脱离上下文的测试文本。
  // 版本号由 accountHeaderLine 统一带出，正文里不再重复写一行，避免两处口径不一致
  const raw = `这是一条测试消息。\n发送时间：${new Date().toLocaleString("zh-CN")}\n若你收到此消息，说明该通道配置正确。`;
  // 与真实任务推送同一版式：标题在最前，一言在末尾（前空一行）。
  // 测试推送没有账户上下文，用户名行自然省略。
  const content = await withAccountHeader(null, raw, { notice: cfg, force: true });
  const reqs = buildRequests(cfg, title, content);

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

module.exports = {
  sendText,
  sendSummary,
  testPush,
  withAccountHeader,
  accountHeaderLine,
  quoteLine,
  // 运行环境标识（PC / Docker）：验收脚本与 UI 都从这里取，避免各写一份判定
  runtimeTag,
  describeTarget,
  buildRequests,
  ensureKeyword,
  normalizeWebhook,
  judgeBusinessOk,
};
