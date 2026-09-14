const logger = require("./logger");
const { httpRequest } = require("./http");
const rewards = require("./rewards");
const notify = require("./notify");
const cancel = require("./cancel");
const { randomUUID, randomUUIDHex, randInt, randArr, getRandomSubstring, getDateSlash, getDayEn, isJSON } = require("./utils");

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
    await notify.sendText(ctx, "微软积分任务-签入", msg);
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
      state.get().signPoint = point || 0;
      state.setTaskDone("sign", state.getDateNum());
      const msg = `📅签入任务已完成！\n${point > 0 ? `✨今日签入奖励：${point}` : "🍵今日已签入，无法二次签入"}`;
      logger.success(msg);
      await notify.sendText(ctx, "微软积分任务-签入", msg);
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
  if (!ctx.config.get().tasks.read || state.isTaskDoneToday("read")) {
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
    // 写入初始篇数，GUI 卡片可实时显示「已读/总数」
    state.get().readArticles = { done: articlesDone, total: articlesTotal };
    state.save();
    logger.log("📖", `需要阅读 ${readsNeeded} 篇文章（当前 ${articlesDone}/${articlesTotal} 篇）`);
    for (let i = 0; i < readsNeeded; i++) {
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
      logger.log("📖", `正在阅读第 ${i + 1}/${readsNeeded} 篇文章...（累计 ${articlesDone}/${articlesTotal} 篇）`);
      // 每篇后即时落盘，中途被停止也能在界面看到真实进度
      state.get().readArticles = { done: articlesDone, total: articlesTotal };
      state.get().readPoint = Math.min(cur + (i + 1) * rewards.POINTS_PER_ARTICLE, max);
      state.save();
      await sleep(randInt(3000, 7000));
    }
    state.setTaskDone("read", state.getDateNum());
    const finalCur = Math.min(cur + readsNeeded * rewards.POINTS_PER_ARTICLE, max);
    state.get().readPoint = finalCur;
    state.get().readArticles = { done: articlesTotal, total: articlesTotal };
    state.save();
    const msg = `📖阅读任务已完成！\n✨今日阅读：${articlesTotal}/${articlesTotal} 篇`;
    logger.success(msg);
    await notify.sendText(ctx, "微软积分任务-阅读", msg);
    return { status: "done", point: finalCur, articles: articlesTotal, articlesTotal };
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

async function taskPromos(ctx) {
  const state = ctx.state;
  if (!ctx.config.get().tasks.promos || state.isTaskDoneToday("promos")) {
    return { status: "skip" };
  }
  let promosArr = [];
  const seenIds = new Set();
  let dashPoints = 0, dashMax = 0;
  let earnPoints = 0, earnMax = 0;

  try {
    const dashHtml = (await httpRequest({ url: "https://rewards.bing.com/dashboard", ctx })).text.replace(/\\"/g, '"');
    const todayStr = getDateSlash();
    const dailySetItems = extractJsonArray(dashHtml, '"dailySetItems":', "[", "]");
    if (dailySetItems) {
      for (const item of dailySetItems) {
        if (item.points === 0 || seenIds.has(item.offerId) || item.date !== todayStr) continue;
        seenIds.add(item.offerId);
        dashMax += item.points;
        if (item.isCompleted) {
          dashPoints += item.points;
        } else {
          promosArr.push({ id: item.offerId, hash: item.hash, url: "https://rewards.bing.com/dashboard", points: item.points, type: "dash" });
        }
      }
    }

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
          promosArr.push({ id: offerId, hash, url: "https://rewards.bing.com/earn", points, type: "earn" });
        }
      }
    }
  } catch (e) {
    logger.error(`活动解析出错！${e.message}`);
  }

  state.get().promosPoint = Math.max(state.get().promosPoint, dashPoints + earnPoints);
  state.save();

  const dashTasks = promosArr.filter((i) => i.type === "dash").length;
  const earnTasks = promosArr.filter((i) => i.type === "earn").length;
  const totalNewTasks = dashTasks + earnTasks;

  if (totalNewTasks < 1) {
    state.setTaskDone("promos", state.getDateNum());
    const dashReport = dashMax > 0 ? `\n📱手机端活动：${dashPoints}/${dashMax}` : "";
    const earnReport = earnMax > 0 ? `\n💻电脑端活动：${earnPoints}/${earnMax}` : "";
    const msg = `🧩活动任务已完成！${dashReport}${earnReport}`;
    logger.success(msg);
    await notify.sendText(ctx, "微软积分任务-活动", msg);
    return { status: "done", points: dashPoints + earnPoints };
  }

  try {
    const taskMsgs = [];
    if (dashTasks > 0) taskMsgs.push(`${dashTasks}个手机端活动`);
    if (earnTasks > 0) taskMsgs.push(`${earnTasks}个电脑端活动`);
    logger.log("🧩", `检测到有${taskMsgs.join("、")}未完成，开始执行...`);
    await sleep(500);

    let dashCurrent = 1;
    let earnCurrent = 1;
    let i = 0;
    for (const item of promosArr) {
      cancel.throwIfAborted();
      i++;
      if (item.type === "dash") {
        logger.log("📱", `正在执行第${dashCurrent}/${dashTasks}个手机端活动...`);
        dashCurrent++;
      } else {
        logger.log("💻", `正在执行第${earnCurrent}/${earnTasks}个电脑端活动...`);
        earnCurrent++;
      }
      const reqHeaders = {
        "content-type": "text/plain;charset=UTF-8",
        "next-action": NEXT_ACTION,
        referer: item.url,
      };
      if (item.type === "dash") {
        reqHeaders["next-router-state-tree"] = NEXT_ROUTER_TREE;
      }
      await httpRequest({
        method: "POST",
        url: item.url,
        headers: reqHeaders,
        data: JSON.stringify([item.hash, 11, { offerid: item.id, isPromotional: "$undefined", timezoneOffset: "-480" }]),
        ctx,
      });
      if (item.type === "dash") dashPoints += item.points;
      else earnPoints += item.points;
      state.get().promosPoint = Math.max(state.get().promosPoint, dashPoints + earnPoints);
      state.save();
      if (i < totalNewTasks) await sleep(randInt(2000, 4000));
    }

    state.setTaskDone("promos", state.getDateNum());
    const dashReport = dashMax > 0 ? `\n📱手机端活动：${dashPoints}/${dashMax}` : "";
    const earnReport = earnMax > 0 ? `\n💻电脑端活动：${earnPoints}/${earnMax}` : "";
    const msg = `🧩活动任务已完成！${dashReport}${earnReport}`;
    logger.success(msg);
    await notify.sendText(ctx, "微软积分任务-活动", msg);
    return { status: "done", points: dashPoints + earnPoints };
  } catch (e) {
    if (e && e.isAbort) throw e;
    logger.error(`活动交卷出错！${e.message}`);
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

  // 获取初始进度
  if (search.lastSearchProgress === -1) {
    const dashboard = await rewards.getRewardsInfo(ctx);
    // getRewardsInfo 失败时也会返回对象（ok:false），必须判 ok 而不是判对象是否存在
    if (!dashboard || !dashboard.ok) {
      return { status: "error", error: "获取搜索进度失败（earn 页解析失败或 Cookie 已失效）" };
    }
    // 新版 earn 页 PC 搜索上限为 15（旧版 60），必须采用服务器返回值，
    // 只有在服务器完全没给上限时才退回默认值，否则会一直搜不完
    const pcMax = dashboard.pc.max > 0 ? dashboard.pc.max : DEFAULT_PC_SEARCH_MAX;
    const mMax = dashboard.m.max > 0 ? dashboard.m.max : 0;
    const pcPro = dashboard.pc.progress;
    const mPro = dashboard.m.progress;
    const currentTotal = pcPro + mPro;

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
      await notify.sendText(ctx, "微软积分任务-搜索", msg);
      return { status: "restricted", progress: searchProgressSnapshot(state) };
    }
    search.pc = { progress: pcPro, max: pcMax };
    search.m = { progress: mPro, max: mMax };
    search.searchPoint = pcPro + mPro;
    state.save();
    // 搜索额度已满则直接标记完成，避免空转
    if (pcPro >= pcMax && mPro >= mMax) {
      state.setTaskDone("search", state.getDateNum());
      logger.success(`🔍搜索任务已完成！（PC:${pcPro}/${pcMax}${mMax ? ` Mobile:${mPro}/${mMax}` : ""}）`);
      return { status: "skip", searched: 0, progress: searchProgressSnapshot(state) };
    }
  } else {
    search.pc = search.pc || { progress: 0, max: DEFAULT_PC_SEARCH_MAX };
    search.m = search.m || { progress: 0, max: 0 };
  }

  const limit = randInt(4, 7);
  logger.log("🔍", `本轮计划搜索 ${limit} 次（PC:${search.pc.progress}/${search.pc.max} Mobile:${search.m.progress}/${search.m.max}）`);
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
      await notify.sendText(ctx, "微软积分任务-搜索", msg);
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

module.exports = { taskSign, taskRead, taskPromos, taskSearch, searchProgressSnapshot };
