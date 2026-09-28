const logger = require("./logger");
const { httpRequest } = require("./http");
const rewards = require("./rewards");
const notify = require("./notify");
const cancel = require("./cancel");
const browser = require("./browser");
const { randomUUID, randomUUIDHex, randInt, randArr, getRandomSubstring, getDateSlash, getDayEn, isJSON } = require("./utils");
const { resolveTaskCount, normalizeLimits } = require("./task-limit");

// 使用可被「停止任务」中断的 sleep（中止时立即抛出 AbortError）
const sleep = cancel.sleep;

// PC 搜索每日上限兜底值。2026-08 改版后国区实际为 15（服务器返回 pointsCounters.pc.max），
// 仅在服务器未返回上限时使用此值，避免写死导致搜索永远跑不完。
const DEFAULT_PC_SEARCH_MAX = 15;

function getRegion() {
  return "cn";
}

/* ============ 搜索词 ============ */
const HOT_APIS = [
  { name: "hot.baiwumm.com", url: "https://hot.baiwumm.com/api/", hot: ["weibo", "douyin", "baidu", "toutiao", "thepaper", "qq", "netease", "zhihu"] },
  { name: "hot.cnxiaobai.com", url: "https://cnxiaobai.com/DailyHotApi/", hot: ["weibo", "douyin", "baidu", "toutiao", "thepaper", "qq-news", "netease-news", "zhihu"] },
  { name: "hot.nntool.cc", url: "https://hotapi.nntool.cc/", hot: ["weibo", "douyin", "baidu", "toutiao", "thepaper", "qq-news", "netease-news", "zhihu"] },
];

const keywordCache = { index: 0, list: [] };

async function getQueryWord(ctx) {
  const keywords = ["天气预报", "今日新闻", "体育赛事", "股票行情", "电影推荐", "科技资讯", "美食食谱", "旅游攻略", "历史上的今天", "健康常识"];
  const baseWord = keywords[randInt(0, keywords.length - 1)];
  const randomSuffix = Math.random().toString(36).slice(2, 6);
  let sentence = `${baseWord} ${randomSuffix}`;

  const mode = ctx.config.get().search.api || "offline";
  if (mode !== "offline") {
    const apiCfg = HOT_APIS.find((i) => i.name === mode) || HOT_APIS[0];
    if (keywordCache.index < 1 || keywordCache.list.length < 1) {
      const hotName = randArr(apiCfg.hot)[0];
      try {
        const { text } = await httpRequest({ url: apiCfg.url + hotName, ctx });
        if (isJSON(text)) {
          const res = JSON.parse(text);
          if (res.code === 200) {
            keywordCache.index = 1;
            keywordCache.list = randArr((res.data || []).map((i) => i.title));
            if (keywordCache.list.length) {
              return getRandomSubstring(keywordCache.list[0]);
            }
          }
        }
      } catch (e) {
        logger.warn(`搜索词获取出错！${e.message}`);
      }
    } else {
      keywordCache.index++;
      if (keywordCache.index > keywordCache.list.length - 1) keywordCache.index = 0;
      return getRandomSubstring(keywordCache.list[keywordCache.index]);
    }
    logger.warn("搜索词接口异常，已临时使用随机搜索词");
  }
  return sentence;
}

/* ============ 签入 ============ */
async function taskSign(ctx, token) {
  const state = ctx.state;
  if (!ctx.config.get().tasks.sign || state.isTaskDoneToday("sign")) {
    // signPoint 初值是 -1（"从未签入"的哨兵值）。
    // 今日已签入却仍是 -1 时必须修正为 0，否则汇总里 `signPoint >= 0`
    // 判定失败，会把已经签好的账号显示成「未运行」。
    // 出现这种情况是因为跨天重置把 signPoint 归为 -1，
    // 而当天的签入走的是本分支直接 return，没有回写过分数。
    if (state.isTaskDoneToday("sign") && !(state.get().signPoint >= 0)) {
      state.get().signPoint = 0;
      state.save();
    }
    return { status: "skip", point: state.get().signPoint, doneToday: state.isTaskDoneToday("sign") };
  }
  // 本地已有今日签入记录但状态未写
  if (state.get().signPoint >= 0) {
    state.setTaskDone("sign", state.getDateNum());
    const msg = `📅签入任务已完成！\n${state.get().signPoint > 0 ? `✨今日签入奖励：${state.get().signPoint}` : "🍵今日已签入，无法二次签入"}`;
    logger.info(msg);
    await notify.sendText(ctx, "MS积分任务-签入", msg);
    return { status: "done", point: state.get().signPoint };
  }
  try {
    const region = getRegion();
    const result = await httpRequest({
      method: "POST",
      url: "https://prod.rewardsplatform.microsoft.com/dapi/me/activities",
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "user-agent": rewards.UA_MOBILE,
        authorization: `Bearer ${token}`,
        "x-rewards-appid": "SAAndroid/31.4.2110003555",
        "x-rewards-ismobile": "true",
        "x-rewards-country": region,
        "x-rewards-partnerid": "startapp",
        "x-rewards-flights": "rwgobig",
      },
      data: JSON.stringify({
        amount: 1,
        attributes: {},
        id: randomUUID(),
        type: 103,
        country: region,
        risk_context: {},
        channel: "SAAndroid",
      }),
      ctx,
    });
    if (isJSON(result.text)) {
      const res = JSON.parse(result.text);
      const point = res.response?.activity?.p;
      // 奖励分必须兜负数：接口对「已签过/无效」会返回 p=-1 这类负数标记，
      // `point || 0` 拦不住（-1 是真值），会把哨兵值写进 signPoint，
      // 仪表盘随即显示「已完成 · -1 分」。-1 只允许作为「从未签入」的初值存在。
      state.get().signPoint = Math.max(0, point || 0);
      state.setTaskDone("sign", state.getDateNum());
      const msg = `📅签入任务已完成！\n${point > 0 ? `✨今日签入奖励：${point}` : "🍵今日已签入，无法二次签入"}`;
      logger.success(msg);
      await notify.sendText(ctx, "MS积分任务-签入", msg);
      return { status: "done", point: point || 0 };
    }
    logger.warn("签入接口返回异常，稍后重试");
    return { status: "retry" };
  } catch (e) {
    if (e && e.isAbort) throw e;
    logger.error(`签入任务出错！${e.message}`);
    return { status: "error", error: e.message };
  }
}

/* ============ 阅读 ============ */
async function taskRead(ctx, token) {
  const state = ctx.state;
  const cfg = ctx.config.get();
  if (!cfg.tasks.read || state.isTaskDoneToday("read")) {
    const ra = state.get().readArticles || {};
    return {
      status: "skip",
      point: state.get().readPoint,
      articles: Number(ra.done) || 0,
      articlesTotal: Number(ra.total) || 0,
      doneToday: state.isTaskDoneToday("read"),
    };
  }
  try {
    const readPro = await rewards.getReadPro(ctx, token);
    if (!readPro || !readPro.ok) {
      logger.warn("阅读进度获取失败，稍后重试");
      return { status: "retry" };
    }
    let cur = readPro.progress || 0;
    let max = readPro.max || 30;

    if (cur >= max) {
      logger.log("📖", "接口返回进度已满，但本地无今日记录，强制开始阅读...");
      cur = 0;
      max = 30;
    }

    const region = getRegion();
    const readsNeeded = Math.ceil((max - cur) / rewards.POINTS_PER_ARTICLE);
    const articlesTotal = Math.ceil(max / rewards.POINTS_PER_ARTICLE);
    let articlesDone = Math.floor(cur / rewards.POINTS_PER_ARTICLE);
    // 单次数量限制：把剩余篇数摊到多轮里读，随机开关打开时还会小幅波动
    const limits = normalizeLimits(cfg.limits);
    // 一次性完成模式（首页红色按钮）：base=0 即不限制、并关掉随机，
    // 保证这一轮真的把剩余篇数全部读完，而不是只做设定的几篇
    const plan = resolveTaskCount({
      base: ctx.force ? 0 : limits.read,
      total: readsNeeded,
      random: ctx.force ? false : limits.random,
    });
    const toRead = plan.count;
    // 写入初始篇数，GUI 卡片可实时显示「已读/总数」
    state.get().readArticles = { done: articlesDone, total: articlesTotal };
    state.save();
    logger.log(
      "📖",
      `需要阅读 ${readsNeeded} 篇文章（当前 ${articlesDone}/${articlesTotal} 篇），本轮计划阅读 ${toRead} 篇${
        plan.applied || plan.cancelled ? `（${plan.note}）` : ""
      }`
    );
    for (let i = 0; i < toRead; i++) {
      cancel.throwIfAborted();
      await httpRequest({
        method: "POST",
        url: "https://prod.rewardsplatform.microsoft.com/dapi/me/activities",
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "user-agent": rewards.UA_MOBILE,
          authorization: `Bearer ${token}`,
          "x-rewards-appid": "SAAndroid/31.4.2110003555",
          "x-rewards-ismobile": "true",
          "x-rewards-country": region,
        },
        data: JSON.stringify({
          amount: 1,
          country: region,
          id: randomUUID(),
          type: 101,
          attributes: { offerid: rewards.READ_OFFER_ID },
        }),
        ctx,
      });
      articlesDone = Math.min(articlesTotal, articlesDone + 1);
      logger.log("📖", `正在阅读第 ${i + 1}/${toRead} 篇文章...（累计 ${articlesDone}/${articlesTotal} 篇）`);
      // 每篇后即时落盘，中途被停止也能在界面看到真实进度
      state.get().readArticles = { done: articlesDone, total: articlesTotal };
      state.get().readPoint = Math.min(cur + (i + 1) * rewards.POINTS_PER_ARTICLE, max);
      state.save();
      await sleep(randInt(3000, 7000));
    }
    const finalCur = Math.min(cur + toRead * rewards.POINTS_PER_ARTICLE, max);
    state.get().readPoint = finalCur;
    // 只有把剩余篇数读完才算完成；受单次数量限制时保持「未完成」，
    // 让今日汇总与自动循环如实反映出「还有篇数留待下轮」
    if (toRead >= readsNeeded) {
      state.setTaskDone("read", state.getDateNum());
      state.get().readArticles = { done: articlesTotal, total: articlesTotal };
      state.save();
      const msg = `📖阅读任务已完成！\n✨今日阅读：${articlesTotal}/${articlesTotal} 篇`;
      logger.success(msg);
      await notify.sendText(ctx, "MS积分任务-阅读", msg);
      return { status: "done", point: finalCur, articles: articlesTotal, articlesTotal };
    }
    state.get().readArticles = { done: articlesDone, total: articlesTotal };
    state.save();
    logger.log(
      "📖",
      `本轮已阅读 ${toRead} 篇（累计 ${articlesDone}/${articlesTotal} 篇），剩余 ${readsNeeded - toRead} 篇留待下轮`
    );
    return { status: "partial", point: finalCur, articles: articlesDone, articlesTotal, planned: toRead };
  } catch (e) {
    if (e && e.isAbort) throw e;
    logger.error(`阅读任务出错！${e.message}`);
    return { status: "error", error: e.message };
  }
}

/* ============ 活动交卷 ============ */
const NEXT_ACTION = "707e6eb15bdfdd5fba193f0a77e934f7018faf87ce";
const NEXT_ROUTER_TREE =
  "%5B%22%22%2C%7B%22children%22%3A%5B%22(nav)%22%2C%7B%22children%22%3A%5B%22dashboard%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%2C4096%5D%7D%2Cnull%2Cnull%2C4096%5D%7D%2Cnull%2Cnull%2C4096%5D%7D%2Cnull%2C%22refetch%22%2C4112%5D";

function extractJsonArray(cleanHtml, marker, openChar, closeChar) {
  const idx = cleanHtml.indexOf(marker);
  if (idx === -1) return null;
  let start = idx + marker.length;
  while (start < cleanHtml.length && /\s/.test(cleanHtml[start])) start++;
  if (cleanHtml[start] !== openChar) return null;
  let count = 1;
  let end = start + 1;
  while (count > 0 && end < cleanHtml.length) {
    if (cleanHtml[end] === openChar) count++;
    else if (cleanHtml[end] === closeChar) count--;
    end++;
  }
  const arrayStr = cleanHtml.substring(start, end).replace(/\\"/g, '"');
  try {
    return JSON.parse(arrayStr);
  } catch {
    return null;
  }
}

/* ============ 活动上报兜底（quiz / BingTrivia） ============ */

/**
 * 从 HTML 里提取 __RequestVerificationToken。
 *
 * 页面改版后 token 的落点不固定：可能是 <input> 的 value、<meta> 的 content，
 * 也可能是内联 JSON 里的键值，且属性顺序会变。所以逐一尝试多种形态，
 * 而不是死磕单一正则（旧版单正则匹配在改版后经常落空）。
 *
 * @param {string} html 原始 HTML
 * @returns {string} 取不到返回空串
 */
function extractVerificationToken(html) {
  const clean = String(html || "").replace(/\s/g, "");
  const patterns = [
    // <input name="__RequestVerificationToken" … value="xxx">
    /name="__RequestVerificationToken"[^>]*value="([^"]+)"/,
    // 属性顺序反过来
    /value="([^"]+)"[^>]*name="__RequestVerificationToken"/,
    // <meta name="__RequestVerificationToken" content="xxx">
    /name="__RequestVerificationToken"[^>]*content="([^"]+)"/,
    /content="([^"]+)"[^>]*name="__RequestVerificationToken"/,
    // 内联 JSON："__RequestVerificationToken":"xxx"
    /["']?__RequestVerificationToken["']?\s*[:=]\s*["']([^"']+)["']/,
    // 旧版宽松匹配，保留兜底，防老页面形态回归时失效
    /RequestVerificationToken(.*?)value="(.*?)"/,
  ];
  for (const re of patterns) {
    const m = clean.match(re);
    if (m && m[1]) return m[1];
  }
  return "";
}

/**
 * 从 rewards.bing.com 首页提取 __RequestVerificationToken。
 * 旧版 `api/reportactivity` 接口需要它，缺失时那条上报直接跳过（不影响主流程）。
 *
 * ⚠️ 取不到 token 不代表出错：真正干活的是 reportActivityFallback 里的
 * quiz 专报（②，无需 token）。所以这里只记 info，不再用 WARN 制造「出错了」
 * 的错觉 —— 早期版本用 WARN，用户每次都看到一条吓人的告警却毫无影响。
 *
 * @returns {Promise<string>} 取不到返回空串
 */
async function fetchRequestToken(ctx) {
  const pages = ["https://rewards.bing.com/", "https://rewards.bing.com/earn"];
  let lastStatus = 0;
  for (const url of pages) {
    try {
      const res = await httpRequest({ url, headers: { referer: "https://rewards.bing.com/" }, ctx });
      lastStatus = res.status;
      if (res.status !== 200 || !res.text) continue;
      const token = extractVerificationToken(res.text);
      if (token) return token;
    } catch (e) {
      if (e && e.isAbort) throw e;
      if (!lastStatus) lastStatus = -1; // 请求异常（超时/DNS 等），用 -1 表示
    }
  }
  logger.info(
    `未取到 RequestVerificationToken（HTTP ${lastStatus || "?"}，跳过 api/reportactivity 上报；quiz 专报不受影响）`
  );
  return "";
}

/**
 * 活动完成上报的兜底组合。
 *
 * 主路径是 next-action 交卷（见 taskDaily / taskPromos），但对「每日活动」里的
 * 答题类活动（quiz）来说，仅靠访问 destination 未必能让服务端记分。参考脚本
 * （原版.js）在处理活动时额外发两条请求，这里补上：
 *
 *   ① rewards.bing.com/api/reportactivity —— 旧版服务端上报，需 __RequestVerificationToken
 *   ② {bingHost}/msrewards/api/v1/ReportActivity —— quiz 专报（PartnerId=BingTrivia），无需 token
 *
 * 两条都是「尽力而为」：失败只 warn，绝不影响任务的完成判定与积分统计。
 *
 * @param {object} ctx 账户上下文
 * @param {{id: string, hash: string, referer?: string}} item
 */
async function reportActivityFallback(ctx, item) {
  if (!item || !item.id) return;
  const referer = item.referer || "https://rewards.bing.com/";
  const host = await rewards.resolveHost(ctx);

  // ② quiz 专报（最主要的兜底，无需 token）
  try {
    const res = await httpRequest({
      method: "POST",
      url: `https://${host}/msrewards/api/v1/ReportActivity?ajaxreq=1`,
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "user-agent": rewards.UA_PC,
        referer,
      },
      data: JSON.stringify({
        ActivitySubType: "quiz",
        ActivityType: "notification",
        OfferId: item.id,
        Channel: "Bing.Com",
        PartnerId: "BingTrivia",
        Timezone: -480,
      }),
      ctx,
    });
    if (res.status === 200) logger.log("📆", `已补发 quiz 上报（${item.id}）`);
    else logger.warn(`quiz 上报返回 HTTP ${res.status}（${item.id}）`);
  } catch (e) {
    if (e && e.isAbort) throw e;
    logger.warn(`quiz 上报失败: ${e.message}`);
  }

  // ① 旧版服务端上报（需首次 200 后取到的 token）
  try {
    const token = await fetchRequestToken(ctx);
    if (!token) return;
    await httpRequest({
      method: "POST",
      url: "https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "user-agent": rewards.UA_PC,
        referer,
      },
      // 参考脚本用 URLSearchParams 序列化，这里保持一致（-1 等价于 HTTP 错误占位）
      data: new URLSearchParams({
        id: item.id,
        hash: item.hash || "",
        timeZone: 480,
        activityAmount: 1,
        dbs: 0,
        form: "",
        type: "",
        __RequestVerificationToken: token,
      }).toString(),
      ctx,
    });
  } catch (e) {
    if (e && e.isAbort) throw e;
    logger.warn(`api/reportactivity 上报失败: ${e.message}`);
  }
}

/**
 * 访问每日活动的奖励链接（等价于手工「点开标签 → 等页面加载 → 停留几秒 → 关闭」）
 *
 * 改版后 earn/dashboard 页把每条每日活动渲染成带追踪参数的 Bing 搜索链接，
 * 形如：
 *   https://www.bing.com/search?q=…&FORM=tgrew4&filters=sid:"…"
 *     BTEPOKey:"REWARDSQUIZ_DailySet_UrlOffer"
 *     BTDSUOID:"Gamification_DailySet_ZHCN_20260914_Child1"&rnoreward=1
 * 服务端按这些参数记分，因此只需带着登录 Cookie 真正请求一次即可，
 * 无需启动浏览器（与搜索任务一致）。
 *
 * @param {object} ctx 账户上下文
 * @param {string} url 活动的 destination 链接
 */
async function visitDailySetUrl(ctx, url) {
  if (!url) return;
  const host = await rewards.resolveHost(ctx);
  const cookie = ctx.state.buildCookieHeader(host);
  const ua = rewards.UA_PC;
  const r = await httpRequest({
    url,
    headers: {
      "user-agent": ua,
      cookie,
      referer: "https://rewards.bing.com/",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    ctx,
  });
  if (!r || !r.text) {
    logger.warn(`活动链接无响应（HTTP ${r ? r.status : "?"}）`);
  }
  // 与手工操作对齐：加载后停留几秒再「关闭」，给服务端记分留出时间
  await sleep(randInt(3000, 5000));
}

/**
 * 每周领取一次「可领取 / 待领取」积分
 *
 * 背景：rewards 首页有两类需要手动点一下才入账的积分：
 *   1. 「可领取」卡片（可领取 N 分 + 「领取」按钮）
 *   2. 「必应 Star 奖励 / 默认搜索奖励」等卡片，标注「上个月赚取的积分: 待领取」
 * 这些只能靠点击触发（React 服务端组件），没有可直接调用的公开接口，
 * 因此这里用无头浏览器点一次，并做 7 天节流，避免每次运行都点。
 *
 * @returns {Promise<{status:string, claimed?:number, reason?:string}>}
 */
async function taskClaimRewards(ctx) {
  const state = ctx.state;
  // 开关守卫：默认关闭（见 config DEFAULTS.tasks.claim）。关闭时 runner 也不会调用，
  // 这里再守一层，避免任何旧调用路径绕过开关。
  if (!ctx.config.get().tasks.claim) {
    return { status: "skip", reason: "未开启定期收取积分" };
  }
  const todayNum = Number(state.getDateNum()); // YYYYMMDD

  /** 两个 YYYYMMDD 之间相差的天数 */
  const daysBetween = (from, to) => {
    const p = (n) => {
      const s = String(n);
      return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
    };
    return Math.floor((p(to) - p(from)) / 86400000);
  };

  const last = Number(state.get().lastClaimDate || 0);
  if (last && daysBetween(last, todayNum) < 7) {
    return { status: "skip", reason: `距上次领取仅 ${daysBetween(last, todayNum)} 天（7 天一次）` };
  }

  let handle = null;
  let claimed = 0;
  try {
    handle = await browser.openContext(ctx, true, { cookies: state.getCookies() });
    const page = handle.context.pages()[0] || (await handle.context.newPage());
    await page.goto("https://rewards.bing.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(4000);

    // 找出所有「可点击的领取入口」：文案含「领取」且不在「已领取」语境里
    const targets = await page.evaluate(() => {
      const out = [];
      const els = document.querySelectorAll("button, a[href], [role='button']");
      for (const el of els) {
        const t = (el.innerText || el.getAttribute("aria-label") || "").trim();
        if (!t || !t.includes("领取")) continue;
        if (t.includes("已领取")) continue;
        // 卡片整体文案，用来判断是不是「待领取」状态
        const card = el.closest("[class*='card'], [class*='Card']") || el.parentElement;
        const cardText = (card && card.innerText ? card.innerText : t).replace(/\s+/g, " ");
        out.push({ text: t.slice(0, 60), cardText: cardText.slice(0, 120) });
      }
      return out;
    });

    if (!targets.length) {
      logger.info("🎁 没有可领取的积分（未找到待领取入口）");
      state.get().lastClaimDate = todayNum;
      state.save();
      return { status: "done", claimed: 0, reason: "无待领取项" };
    }

    // 逐个点击（页面中「领取」入口可能不止一个）。
    // 第一次点击可能弹出站内确认对话框；若继续用 Playwright 普通 click 点页面旧元素，
    // 对话框遮罩会拦截 pointer events 并等待满 30 秒。这里用 DOM click 触发入口，
    // 随后优先处理可见对话框中的「领取 / 确认 / 继续」按钮。
    const els = await page.$$("button, a[href], [role='button']");
    for (const el of els) {
      cancel.throwIfAborted();
      let info = null;
      try {
        info = await el.evaluate((n) => {
          const t = (n.innerText || n.getAttribute("aria-label") || "").trim();
          return { t };
        });
      } catch {
        continue;
      }
      if (!info || !info.t || !info.t.includes("领取") || info.t.includes("已领取")) continue;
      try {
        await el.evaluate((n) => n.click());
        logger.log("🎁", `已点击领取入口：${info.t.slice(0, 40)}`);
        await sleep(800);

        const confirmed = await page.evaluate(() => {
          const dialogs = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true'], [data-rac]"));
          const visible = dialogs.find((node) => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          });
          if (!visible) return false;
          const buttons = Array.from(visible.querySelectorAll("button, [role='button'], a[href]"));
          const action = buttons.find((node) => {
            const text = (node.innerText || node.getAttribute("aria-label") || "").trim();
            return /^(领取|确认|确定|继续|立即领取)/.test(text) && !/取消|关闭/.test(text);
          });
          if (!action) return false;
          action.click();
          return true;
        });
        if (confirmed) logger.log("🎁", "已确认领取对话框");
        claimed++;
        await sleep(2500);
      } catch (e) {
        logger.warn(`点击领取入口失败: ${e.message}`);
      }
    }

    state.get().lastClaimDate = todayNum;
    state.save();
    const msg = claimed > 0 ? `🎁 已处理 ${claimed} 个领取入口（每周一次）` : "🎁 本周无需领取";
    logger.success(msg);
    return { status: "done", claimed };
  } catch (e) {
    if (e && e.isAbort) throw e;
    logger.warn(`领取积分出错: ${e.message}`);
    return { status: "error", error: e.message };
  } finally {
    if (handle) await browser.closeContext(handle).catch(() => {});
  }
}

/**
 * 每日活动（dashboard 页的 dailySet，每日三格）
 *
 * 从原混合活动任务里拆出来的独立任务，由 tasks.daily 开关控制（默认关闭）。
 * 与积分活动（taskPromos，earn 页）分开统计、分开标记完成。
 * 每日活动通常只有固定的 2–3 条，一次做完即可，不做单次数量限流。
 */
async function taskDaily(ctx) {
  const state = ctx.state;
  const cfg = ctx.config.get();
  if (!cfg.tasks.daily || state.isTaskDoneToday("daily")) {
    return { status: "skip", point: state.get().dailyPoint, doneToday: state.isTaskDoneToday("daily") };
  }
  let queue = [];
  let donePoints = 0, maxPoints = 0;
  try {
    const dashHtml = (await httpRequest({ url: "https://rewards.bing.com/dashboard", ctx })).text.replace(/\\"/g, '"');
    const todayStr = getDateSlash();
    const dailySetItems = extractJsonArray(dashHtml, '"dailySetItems":', "[", "]");
    if (dailySetItems) {
      for (const item of dailySetItems) {
        if (item.points === 0 || item.date !== todayStr) continue;
        maxPoints += item.points;
        if (item.isCompleted) {
          donePoints += item.points;
        } else {
          queue.push({
            id: item.offerId,
            hash: item.hash,
            points: item.points,
            // 改版后真正的完成方式是访问这条 destination（Bing 搜索奖励链接），
            // 与用户手工「点开标签→等加载→关闭」等价；POST 交卷仅作兜底
            destination: item.destination,
          });
        }
      }
    }
  } catch (e) {
    logger.error(`每日活动解析出错！${e.message}`);
  }

  state.get().dailyPoint = Math.max(state.get().dailyPoint || 0, donePoints);
  state.save();

  if (queue.length < 1) {
    state.setTaskDone("daily", state.getDateNum());
    const msg = `📆每日活动已完成！\n✨活动积分：${donePoints}/${maxPoints || donePoints}`;
    logger.success(msg);
    await notify.sendText(ctx, "MS积分任务-每日活动", msg);
    return { status: "done", points: donePoints };
  }

  try {
    logger.log("📆", `检测到 ${queue.length} 个未完成每日活动，本轮全部执行`);
    await sleep(500);
    let i = 0;
    for (const item of queue) {
      cancel.throwIfAborted();
      i++;
      logger.log("📆", `正在执行第 ${i}/${queue.length} 个每日活动...`);

      // ① 先按「手工点开标签」真正访问活动链接（服务端按 URL 追踪参数记分）
      if (item.destination) {
        try {
          await visitDailySetUrl(ctx, item.destination);
        } catch (e) {
          if (e && e.isAbort) throw e;
          logger.warn(`访问每日活动链接失败（将继续尝试交卷）: ${e.message}`);
        }
      }

      // ② next-action 交卷兜底（旧结构 / 链接无效时仍可能生效）
      try {
        await httpRequest({
          method: "POST",
          url: "https://rewards.bing.com/dashboard",
          headers: {
            "content-type": "text/plain;charset=UTF-8",
            "next-action": NEXT_ACTION,
            "next-router-state-tree": NEXT_ROUTER_TREE,
            referer: "https://rewards.bing.com/dashboard",
          },
          data: JSON.stringify([item.hash, 11, { offerid: item.id, isPromotional: "$undefined", timezoneOffset: "-480" }]),
          ctx,
        });
      } catch (e) {
        if (e && e.isAbort) throw e;
        logger.warn(`每日活动交卷失败: ${e.message}`);
      }

      // ③ 答题类（quiz）兜底上报：next-action 交卷有时不计分，参考脚本额外发的两条上报
      try {
        await reportActivityFallback(ctx, {
          id: item.id,
          hash: item.hash,
          referer: item.destination || "https://rewards.bing.com/dashboard",
        });
      } catch (e) {
        if (e && e.isAbort) throw e;
        logger.warn(`活动上报兜底失败: ${e.message}`);
      }
      donePoints += item.points;
      state.get().dailyPoint = Math.max(state.get().dailyPoint || 0, donePoints);
      state.save();
      if (i < queue.length) await sleep(randInt(2000, 4000));
    }

    state.setTaskDone("daily", state.getDateNum());
    const msg = `📆每日活动已完成！\n✨活动积分：${donePoints}/${maxPoints || donePoints}`;
    logger.success(msg);
    await notify.sendText(ctx, "MS积分任务-每日活动", msg);
    return { status: "done", points: donePoints };
  } catch (e) {
    if (e && e.isAbort) throw e;
    logger.error(`每日活动出错！${e.message}`);
    return { status: "error", error: e.message };
  }
}

/**
 * 积分活动 / 更多活动（earn 页 activityCards）
 *
 * 由 tasks.promos 开关控制。只处理 earn 页的更多活动；dashboard 的每日三格
 * 已拆到 taskDaily。受单次数量限制（limits.promos）时本轮只做一部分、不标记完成。
 */
async function taskPromos(ctx) {
  const state = ctx.state;
  const cfg = ctx.config.get();
  if (!cfg.tasks.promos || state.isTaskDoneToday("promos")) {
    return { status: "skip" };
  }
  let promosArr = [];
  const seenIds = new Set();
  let earnPoints = 0, earnMax = 0;

  try {
    const earnHtml = (await httpRequest({ url: "https://rewards.bing.com/earn", ctx })).text.replace(/\\"/g, '"');
    if (earnHtml.includes('"activityCards":[')) {
      const todayDayEn = getDayEn();
      const taskRegex = /"isCompleted":(true|false).*?"points":(\d+).*?"offerId":"([^"]+)","hash":"([^"]+)"/g;
      let match;
      while ((match = taskRegex.exec(earnHtml)) !== null) {
        const isCompleted = match[1] === "true";
        const points = parseInt(match[2]);
        const offerId = match[3];
        const hash = match[4];
        if (points === 0 || seenIds.has(offerId)) continue;
        if (isCompleted) {
          if (offerId.includes("Evergreen") && !offerId.includes(todayDayEn)) continue;
          const dateMatch = offerId.match(/(20\d{6})/);
          if (dateMatch && dateMatch[1] !== String(state.getDateNum())) continue;
          if (/(w[1-5]|week|month)/i.test(offerId) || /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\d{2}/i.test(offerId)) continue;
        }
        seenIds.add(offerId);
        earnMax += points;
        if (isCompleted) {
          earnPoints += points;
        } else {
          promosArr.push({ id: offerId, hash, url: "https://rewards.bing.com/earn", points });
        }
      }
    }
  } catch (e) {
    logger.error(`积分活动解析出错！${e.message}`);
  }

  state.get().promosPoint = Math.max(state.get().promosPoint, earnPoints);
  state.save();

  const totalNewTasks = promosArr.length;

  if (totalNewTasks < 1) {
    state.setTaskDone("promos", state.getDateNum());
    const earnReport = earnMax > 0 ? `\n💻积分活动：${earnPoints}/${earnMax}` : "";
    const msg = `🧩积分活动任务已完成！${earnReport}`;
    logger.success(msg);
    await notify.sendText(ctx, "MS积分任务-积分活动", msg);
    return { status: "done", points: earnPoints };
  }

  // 单次数量限制：本轮只做其中一部分，剩下的留到下一轮（随机开关可小幅波动）
  const limits = normalizeLimits(cfg.limits);
  // 一次性完成模式：base=0（不限制）+ 关随机，一轮把检测到的活动全部做完
  const plan = resolveTaskCount({
    base: ctx.force ? 0 : limits.promos,
    total: totalNewTasks,
    random: ctx.force ? false : limits.random,
  });
  const queue = promosArr.slice(0, plan.count);
  const runCount = queue.length;

  try {
    logger.log(
      "🧩",
      `检测到 ${totalNewTasks} 个未完成积分活动，本轮计划执行 ${runCount} 个${
        plan.applied || plan.cancelled ? `（${plan.note}）` : ""
      }`
    );
    await sleep(500);

    let i = 0;
    for (const item of queue) {
      cancel.throwIfAborted();
      i++;
      logger.log("💻", `正在执行第 ${i}/${runCount} 个积分活动...`);
      const reqHeaders = {
        "content-type": "text/plain;charset=UTF-8",
        "next-action": NEXT_ACTION,
        referer: item.url,
      };

      // ① next-action 交卷为主（earn 页活动无 destination 链接）
      await httpRequest({
        method: "POST",
        url: item.url,
        headers: reqHeaders,
        data: JSON.stringify([item.hash, 11, { offerid: item.id, isPromotional: "$undefined", timezoneOffset: "-480" }]),
        ctx,
      });

      // ② 答题类（quiz）兜底上报：失败只 warn，不影响本条活动的计分与任务状态
      try {
        await reportActivityFallback(ctx, { id: item.id, hash: item.hash, referer: item.url });
      } catch (e) {
        if (e && e.isAbort) throw e;
        logger.warn(`活动上报兜底失败: ${e.message}`);
      }

      earnPoints += item.points;
      state.get().promosPoint = Math.max(state.get().promosPoint, earnPoints);
      state.save();
      if (i < runCount) await sleep(randInt(2000, 4000));
    }

    const earnReport = earnMax > 0 ? `\n💻积分活动：${earnPoints}/${earnMax}` : "";

    // 只有把剩余活动全做完才算完成；受单次数量限制时保持「未完成」，
    // 让今日汇总与自动循环如实反映出「还有活动留待下轮」
    if (runCount >= totalNewTasks) {
      state.setTaskDone("promos", state.getDateNum());
      const msg = `🧩积分活动任务已完成！${earnReport}`;
      logger.success(msg);
      await notify.sendText(ctx, "MS积分任务-积分活动", msg);
      return { status: "done", points: earnPoints };
    }

    const partialMsg = `🧩本轮已执行 ${runCount}/${totalNewTasks} 个积分活动，剩余 ${
      totalNewTasks - runCount
    } 个留待下轮`;
    logger.log("🧩", partialMsg);
    return { status: "partial", points: earnPoints, pending: totalNewTasks - runCount };
  } catch (e) {
    if (e && e.isAbort) throw e;
    logger.error(`积分活动交卷出错！${e.message}`);
    return { status: "error", error: e.message };
  }
}

/* ============ 搜索 ============ */

/** 从 state 里取搜索进度快照，供汇总输出「完成多少 / 还剩多少」 */
function searchProgressSnapshot(state) {
  const g = state.get();
  const pc = g.pc || { progress: 0, max: 0 };
  const m = g.m || { progress: 0, max: 0 };
  const done = (Number(pc.progress) || 0) + (Number(m.progress) || 0);
  const total = (Number(pc.max) || 0) + (Number(m.max) || 0);
  return {
    done,
    total,
    left: Math.max(0, total - done),
    pc: { progress: Number(pc.progress) || 0, max: Number(pc.max) || 0 },
    m: { progress: Number(m.progress) || 0, max: Number(m.max) || 0 },
  };
}

async function taskSearch(ctx) {
  const state = ctx.state;
  const cfg = ctx.config.get();
  if (!cfg.tasks.search || state.isTaskDoneToday("search")) {
    return {
      status: "skip",
      searched: 0,
      progress: searchProgressSnapshot(state),
      doneToday: state.isTaskDoneToday("search"),
    };
  }
  const host = await rewards.resolveHost(ctx);
  const search = state.get();

  // 每轮开始都先拉一次服务器真实进度，再决定「还要搜多少」：
  // 用户随时可能在浏览器 Bing / 手机 App 上手动搜索赚分，本地计数只是估算，
  // 拿它当依据会重复搜索或迟迟不标记完成。拉取失败时：
  // 当日首轮（无基准）直接报错收工；续轮沿用本地计数继续（绝不能把好数据冲成 0）。
  const dashboard = await rewards.getRewardsInfo(ctx);
  if (!dashboard || !dashboard.ok) {
    if (search.lastSearchProgress === -1 || !search.pc) {
      return { status: "error", error: "获取搜索进度失败（earn 页解析失败或 Cookie 已失效）" };
    }
    logger.warn("搜索进度拉取失败，本轮沿用本地计数继续（下一轮会重试服务器）");
  } else {
    // 新版 earn 页 PC 搜索上限为 15（旧版 60），必须采用服务器返回值，
    // 只有在服务器完全没给上限时才退回默认值，否则会一直搜不完
    const pcMax = dashboard.pc.max > 0 ? dashboard.pc.max : DEFAULT_PC_SEARCH_MAX;
    const mMax = dashboard.m.max > 0 ? dashboard.m.max : 0;
    const pcPro = dashboard.pc.progress;
    const mPro = dashboard.m.progress;
    const currentTotal = pcPro + mPro;

    // 连续两轮服务器进度纹丝不动且未满额 → 收入受限/账号异常，中止今日搜索
    if (search.lastSearchProgress !== -1) {
      if (currentTotal === search.lastSearchProgress && currentTotal < pcMax + mMax) {
        search.restrictedTimes++;
      } else {
        search.restrictedTimes = 0;
      }
    }
    search.lastSearchProgress = currentTotal;
    if (search.restrictedTimes >= 2) {
      search.lastSearchProgress = -1;
      search.restrictedTimes = 0;
      state.save();
      const msg = "⚠️积分收入受限或账号异常，已中断今日搜索！";
      logger.error(msg);
      await notify.sendText(ctx, "MS积分任务-搜索", msg);
      return { status: "restricted", progress: searchProgressSnapshot(state) };
    }
    search.pc = { progress: pcPro, max: pcMax };
    search.m = { progress: mPro, max: mMax };
    search.searchPoint = pcPro + mPro;
    state.save();
    // 搜索额度已满（含用户手动搜满的情形）则直接标记完成，避免空转
    if (pcPro >= pcMax && mPro >= mMax) {
      state.setTaskDone("search", state.getDateNum());
      logger.success(`🔍搜索任务已完成！（PC:${pcPro}/${pcMax}${mMax ? ` Mobile:${mPro}/${mMax}` : ""}）`);
      return { status: "skip", searched: 0, progress: searchProgressSnapshot(state) };
    }
  }

  // 本轮计划次数 = 随机节奏 4–7（不再与服务器剩余额度取小）。
  // 允许随机多于当天的剩余额度：多出来的几次在下方 while 的满额判定里会被
  // 安全短路，拿不到额外分，但从「每次刚好接到额度上限」的规律性中走了出来。
  // 循环内仍保留 `progress < max` 的硬护栏，绝不可能无限搜或打爆接口。
  const remaining =
    Math.max(0, (search.pc.max || 0) - (search.pc.progress || 0)) +
    Math.max(0, (search.m.max || 0) - (search.m.progress || 0));
  // limit 来源优先级：limit.search >0（用户显式设了固定值）> force（一次性完成，6–9）> 默认随机（4–7）。
  // 不再受 remaining 截断 —— 多出来的几次在循环满额判定里自然短路。
  const setBase = normalizeLimits(cfg.limits).search;
  let limit;
  if (setBase > 0) {
    limit = setBase;
  } else if (ctx.force) {
    limit = randInt(6, 9);
  } else {
    limit = randInt(4, 7);
  }
  const source = setBase > 0 ? "用户设定" : ctx.force ? "force" : "随机";
  logger.log("🔍", `服务器进度已同步，本轮计划搜索 ${limit} 次（来源 ${source}，剩余 ${remaining} 次，PC:${search.pc.progress}/${search.pc.max} Mobile:${search.m.progress}/${search.m.max}）`);
  let searched = 0;

  while (searched < limit && (search.pc.progress < search.pc.max || search.m.progress < search.m.max)) {
    cancel.throwIfAborted();
    let pcorm = Math.random() > 0.6 ? false : true; // 60% PC
    if (search.pc.progress >= search.pc.max) pcorm = false;
    if (search.m.progress >= search.m.max) pcorm = true;

    const keyword = await getQueryWord(ctx);
    const device = pcorm ? "Desktop" : "Mobile";
    const dateHyphen = state.getDateHyphen();
    const baseCookie = state.buildCookieHeader(host);
    const rwho = pcorm ? "u=d" : "u=m";
    const cookie = baseCookie ? `${baseCookie}; _Rwho=${rwho}&ts=${dateHyphen}` : `_Rwho=${rwho}&ts=${dateHyphen}`;
    const ua = pcorm ? rewards.UA_PC : rewards.UA_MOBILE;
    const regionMKT = cfg.region.lock ? "&mkt=zh-CN" : "";
    const params = `q=${encodeURIComponent(keyword)}&form=QBLH${regionMKT}`;
    const query = `https://${host}/search?${params}`;

    try {
      const result = await httpRequest({
        url: query,
        headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "user-agent": ua, cookie, referer: `https://${host}/?form=QBLH` },
        cookie, // 覆盖自动组装（保留 _Rwho）
        ctx,
      });
      if (result.text) {
        const res = result.text.replace(/\s/g, "");
        const data0 = res.match(/,IG:"([^"]+)"/);
        const guid = data0 ? data0[1] : randomUUIDHex();
        const data = res.match(/class="b_algo(.*?)href="(.*?)"h="ID=(.*?)">(.*?)<\/h2/);
        const ncheader = `https://${host}/rewardsapp/ncheader?ver=88888888&IID=SERP.5047&IG=${guid}&ajaxreq=1`;
        const report = `https://${host}/rewardsapp/reportActivity?IG=${guid}&IID=SERP.5047&${params}&ajaxreq=1`;
        const headers = { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "user-agent": ua, cookie, referer: query };
        await httpRequest({ method: "POST", url: ncheader, headers, data: "wb=1%3bi%3d1%3bv%3d1", ctx });
        await httpRequest({ method: "POST", url: report, headers, data: `url=${encodeURIComponent(query)}&V=web`, ctx });
        if (data) {
          const click = `https://${host}/fd/ls/GLinkPingPost.aspx?IG=${guid}&ID=${data[3]}&url=${data[2]}`;
          await httpRequest({ url: click, headers, timeout: 10000, ctx }).catch(() => {});
        }
        if (pcorm) {
          search.pc.progress = Math.min(search.pc.progress + 3, search.pc.max);
        } else {
          search.m.progress = Math.min(search.m.progress + 3, search.m.max);
        }
        search.searchPoint = (search.pc.progress || 0) + (search.m.progress || 0);
        state.save();
        searched++;
        logger.log("🔍", `第 ${searched}/${limit} 次搜索完成（${device}），进度 PC:${search.pc.progress}/${search.pc.max} M:${search.m.progress}/${search.m.max}`);
      }
    } catch (e) {
      if (e && e.isAbort) throw e;
      logger.error(`搜索任务出错！${e.message}`);
    }
    const span = Number(cfg.search.span) || 30;
    await sleep(randInt(Math.max(span - 15, 5), span + 15) * 1000);
  }

  // 校验实际进度
  await sleep(3210);
  const finalDashboard = await rewards.getRewardsInfo(ctx);
  // 必须判 ok：失败时返回的 progress 全为 0，直接写回会把真实进度冲掉
  if (finalDashboard && finalDashboard.ok) {
    const realPc = finalDashboard.pc.progress;
    const realM = finalDashboard.m.progress;
    search.searchPoint = realPc + realM;
    if (realPc >= search.pc.max && realM >= search.m.max) {
      search.lastSearchProgress = -1;
      search.restrictedTimes = 0;
      state.setTaskDone("search", state.getDateNum());
      state.save();
      const pcReport = search.pc.max > 0 ? `\n💻电脑端搜索：${realPc}/${search.pc.max}` : "";
      const mReport = search.m.max > 0 ? `\n📱手机端搜索：${realM}/${search.m.max}` : "";
      const msg = `🔍搜索任务已完成！${pcReport}${mReport}`;
      logger.success(msg);
      await notify.sendText(ctx, "MS积分任务-搜索", msg);
      return { status: "done", pc: realPc, m: realM, searched, progress: searchProgressSnapshot(state) };
    }
    search.pc.progress = realPc;
    search.m.progress = realM;
    search.searchPoint = realPc + realM;
    state.save();
  }

  const pcReport = search.pc.max > 0 ? `\n💻电脑端搜索：${search.pc.progress}/${search.pc.max}` : "";
  const mReport = search.m.max > 0 ? `\n📱手机端搜索：${search.m.progress}/${search.m.max}` : "";
  const msg = `本轮运行正常，共搜索 ${searched} 次！${pcReport}${mReport}`;
  logger.log("🔍", msg);
  return { status: "partial", searched, pc: search.pc.progress, m: search.m.progress, progress: searchProgressSnapshot(state) };
}

// reportActivityFallback / fetchRequestToken 导出是为了让自检脚本与打桩测试能直接驱动，
// 业务侧仍通过 taskDaily / taskPromos 调用。
module.exports = {
  taskSign,
  taskRead,
  taskDaily,
  taskPromos,
  taskClaimRewards,
  taskSearch,
  searchProgressSnapshot,
  reportActivityFallback,
  fetchRequestToken,
};
