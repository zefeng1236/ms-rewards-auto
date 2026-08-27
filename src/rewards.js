const logger = require("./logger");
const { httpRequest } = require("./http");

const UA_PC = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const UA_MOBILE = "Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.0.0";

let cachedHost = "";

/** 解析 bing 主机：锁定国区则使用 cn.bing.com */
function resolveHost(ctx) {
  if (cachedHost) return cachedHost;
  const cfg = ctx.config.get();
  cachedHost = cfg.region && cfg.region.lock ? "cn.bing.com" : "www.bing.com";
  return cachedHost;
}

/**
 * 大陆 IP 检查：解析 bing 首页脚本中的 Region / RevIpCC
 * @returns {Promise<{ok: boolean, region: string, ipcc: string}>}
 */
async function mainlandCheck(ctx) {
  const cfg = ctx.config.get();
  const host = resolveHost(ctx);
  const res = await httpRequest({
    url: `https://${host}/`,
    headers: {
      "user-agent": UA_PC,
      cookie: ctx.state.buildCookieHeader(host, ["_EDGE_S", "_Rwho", "_RwBf"]),
    },
    ctx,
    dontLog: true,
  });
  if (!res.text) {
    logger.warn("无法获取 bing 首页（区域检查跳过）");
    return { ok: true, region: "", ipcc: "" };
  }
  const clean = res.text.replace(/\s+/g, "");
  const m = clean.match(/Region:"(.*?)"(.*?)RevIpCC:"(.*?)"/);
  if (!m) {
    logger.warn("未从 bing 首页解析到区域信息（区域检查跳过）");
    return { ok: true, region: "", ipcc: "" };
  }
  const region = m[1].toUpperCase();
  const ipcc = m[3].toUpperCase();
  logger.info(`区域检测: Region=${region}, RevIpCC=${ipcc}`);
  if (cfg.region && cfg.region.lock && ipcc !== "CN") {
    logger.warn("当前 IP 非中国大陆，已锁定国区，停止任务。");
    return { ok: false, region, ipcc };
  }
  return { ok: true, region, ipcc };
}

/**
 * 从文本指定位置起，按括号配对提取一段 JSON 对象源码
 * @param {string} text
 * @param {number} from 起始搜索位置（会自动跳到第一个 `{`）
 * @returns {string} JSON 源码，找不到返回空串
 */
function sliceJsonObject(text, from) {
  let start = from;
  while (start < text.length && text[start] !== "{") start++;
  if (start >= text.length) return "";
  let depth = 0;
  let inStr = false;
  let escape = false;
  let end = start;
  for (; end < text.length; end++) {
    const ch = text[end];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
  }
  if (depth !== 0) return "";
  return text.slice(start, end + 1);
}

/**
 * 在文本中查找某个 key 对应的 JSON 对象并解析
 * @param {string} text
 * @param {string} keyName 例如 "pointsCounters"
 */
function findJsonByKey(text, keyName) {
  const key = `"${keyName}":`;
  let idx = -1;
  while ((idx = text.indexOf(key, idx + 1)) >= 0) {
    const raw = sliceJsonObject(text, idx + key.length);
    if (!raw) continue;
    try {
      return JSON.parse(raw);
    } catch {
      // 继续找下一个同名 key
    }
  }
  return null;
}

/**
 * 解析 pointsCounters 内嵌 JSON
 *
 * 2026-08 起 rewards.bing.com/earn 改版为 Next.js RSC（React Server Components）
 * flight 数据，业务 JSON 被作为字符串二次编码嵌入 `self.__next_f.push([1,"..."])`，
 * 页面源码中的实际形态是转义后的 `\"pointsCounters\":{\"dailyOffer\":115,...}`。
 * 因此不能直接按裸 `"pointsCounters":` 检索，需要先做转义归一化。
 *
 * 兼容两种结构：
 * - 新版：{ dailyOffer: 115, pc: {max,progress,originalMax}, totalPoints, boostActivated }
 * - 旧版：{ dailyOffer: {dailyPoint,todayTotal}, pcSearch: {pointProgress:{...}}, ... }
 */
function parsePointsCounters(text) {
  if (!text) return null;
  // 候选文本：原文 + 逐层去转义后的版本（RSC 数据为一层 \" 转义）
  const candidates = [text];
  if (text.includes('\\"pointsCounters\\"')) {
    candidates.push(text.split('\\"').join('"'));
  }
  if (text.includes('\\\\"pointsCounters\\\\"')) {
    candidates.push(text.split('\\\\"').join('"'));
  }
  for (const cand of candidates) {
    const obj = findJsonByKey(cand, "pointsCounters");
    if (obj && typeof obj === "object") return obj;
  }
  return null;
}

/**
 * 解析 pointsHistory（新版 earn 页附带的历史积分）
 * 形如 { thisMonth:{earn,spend}, thisYear:{earn,spend}, lifetime:{earn,spend} }
 */
function parsePointsHistory(text) {
  if (!text) return null;
  const candidates = [text];
  if (text.includes('\\"pointsHistory\\"')) candidates.push(text.split('\\"').join('"'));
  for (const cand of candidates) {
    const obj = findJsonByKey(cand, "pointsHistory");
    if (obj && typeof obj === "object") return obj;
  }
  return null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 空返回值（获取失败时） */
function emptyInfo() {
  return {
    ok: false,
    balance: 0,
    pc: { progress: 0, max: 0 },
    m: { progress: 0, max: 0 },
    dailyPoint: 0,
    todayTotal: 0,
    monthEarn: 0,
    boostActivated: false,
  };
}

/**
 * 归一化搜索计数节点，兼容新旧结构
 * - 新版：{ max: 15, progress: 0, originalMax: 15 }
 * - 旧版：{ pointProgress: { progress: n, max: n } }
 */
function normProgress(obj) {
  if (!obj || typeof obj !== "object") return { progress: 0, max: 0 };
  const pp = obj.pointProgress && typeof obj.pointProgress === "object" ? obj.pointProgress : null;
  if (pp) return { progress: num(pp.progress), max: num(pp.max !== undefined ? pp.max : pp.originalMax) };
  return {
    progress: num(obj.progress),
    max: num(obj.max !== undefined ? obj.max : obj.originalMax),
  };
}

/**
 * 获取 Rewards 账户积分信息
 *
 * 新版 earn 页 pointsCounters 结构（2026-08 改版后）：
 *   { "dailyOffer": 115, "pc": {"max":15,"progress":0,"originalMax":15},
 *     "totalPoints": 115, "boostActivated": false }
 * 其中 dailyOffer 已由对象变为数字（= 今日已得积分），旧版的 todayTotal /
 * pointProgress / mobileSearch 字段均已不存在，移动搜索额度需从 pc 之外单独判断
 * （国区当前不下发 mobile 节点，缺失时按 0 处理）。
 *
 * @returns {Promise<{ok:boolean, balance:number, pc:{progress:number,max:number}, m:{progress:number,max:number}, dailyPoint:number, todayTotal:number, monthEarn:number, boostActivated:boolean}>}
 */
async function getRewardsInfo(ctx) {
  const res = await httpRequest({
    url: "https://rewards.bing.com/earn",
    headers: { "user-agent": UA_PC },
    ctx,
  });
  if (res.status !== 200 || !res.text) {
    logger.warn(`获取积分信息失败（HTTP ${res.status}${res.error ? ": " + res.error : ""}）`);
    return emptyInfo();
  }
  const pc = parsePointsCounters(res.text);
  if (!pc) {
    // 若被重定向到登录页，说明 Cookie 失效，给出更明确的提示
    const looksLikeLogin = /JavaScript required to sign in|login\.live\.com/i.test(res.text.slice(0, 2000));
    logger.warn(looksLikeLogin ? "未解析到 pointsCounters（页面被重定向到登录，Cookie 可能已失效）" : "未解析到 pointsCounters（earn 页结构可能已变化）");
    return emptyInfo();
  }

  // dailyOffer：新版为数字（今日已得积分）；旧版为对象 {dailyPoint, todayTotal}
  const dailyOfferIsNum = typeof pc.dailyOffer === "number";
  const dailyOffer = !dailyOfferIsNum && pc.dailyOffer && typeof pc.dailyOffer === "object" ? pc.dailyOffer : {};

  const pcNode = pc.pcSearch !== undefined ? pc.pcSearch : pc.pc;
  const mNode = pc.mobileSearch !== undefined ? pc.mobileSearch : pc.mobile;

  // 今日已得积分：新版取 dailyOffer 数字；旧版取 dailyOffer.todayTotal
  let todayTotal = 0;
  if (dailyOfferIsNum) todayTotal = num(pc.dailyOffer);
  else if (dailyOffer.todayTotal !== undefined) todayTotal = num(dailyOffer.todayTotal);
  else if (pc.todayTotal !== undefined) todayTotal = num(pc.todayTotal);

  const history = parsePointsHistory(res.text);
  const monthEarn = history && history.thisMonth ? num(history.thisMonth.earn) : 0;

  const info = {
    ok: true,
    balance: num(pc.totalPoints !== undefined ? pc.totalPoints : pc.balance),
    pc: normProgress(pcNode),
    m: normProgress(mNode),
    dailyPoint: dailyOfferIsNum ? 0 : num(dailyOffer.dailyPoint !== undefined ? dailyOffer.dailyPoint : pc.dailyPoint),
    todayTotal,
    monthEarn,
    boostActivated: !!pc.boostActivated,
  };
  logger.info(
    `积分信息: 总积分=${info.balance}, PC搜索=${info.pc.progress}/${info.pc.max}, 移动搜索=${info.m.progress}/${info.m.max}, 今日已得=${info.todayTotal}, 本月累计=${info.monthEarn}${info.boostActivated ? ", 2倍搜索已激活" : ""}`
  );
  return info;
}

/** 阅读任务的 offerId（每篇 3 分，共 30 分） */
const READ_OFFER_ID = "ENUS_readarticle3_30points";
/** 每篇文章积分 */
const POINTS_PER_ARTICLE = 3;

/**
 * 读取阅读文章进度
 *
 * 改用移动端 dapi/me 接口（与参考脚本一致）。旧的
 * `rewardspanelapi/rewardsummary` 接口已不稳定，经常返回空或非 JSON，
 * 导致 progress 一直是 -1、GUI 阅读卡片拿不到真实进度。
 *
 * @returns {Promise<{ok:boolean, progress:number, max:number, articlesDone:number, articlesTotal:number, articlesLeft:number}>}
 *          ok=false 表示获取失败（progress=-1）
 */
async function getReadPro(ctx, token) {
  const fail = { ok: false, progress: -1, max: 30, articlesDone: 0, articlesTotal: 10, articlesLeft: 10 };
  if (!token) return fail;
  try {
    const res = await httpRequest({
      url: "https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613",
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "user-agent": UA_MOBILE,
        authorization: `Bearer ${token}`,
        "x-rewards-appid": "SAAndroid/31.4.2110003555",
        "x-rewards-ismobile": "true",
      },
      ctx,
    });
    if (!res.text) return fail;
    const data = JSON.parse(res.text);
    const promos = (data.response && data.response.promotions) || [];
    const readTask = promos.find((x) => x.attributes && x.attributes.offerid === READ_OFFER_ID);
    if (!readTask) {
      logger.warn("未在 dapi/me 中找到阅读任务节点");
      return fail;
    }
    const progress = num(readTask.attributes.progress);
    const max = num(readTask.attributes.max) || 30;
    const articlesTotal = Math.ceil(max / POINTS_PER_ARTICLE);
    const articlesDone = Math.floor(progress / POINTS_PER_ARTICLE);
    const articlesLeft = Math.max(0, Math.ceil((max - progress) / POINTS_PER_ARTICLE));
    logger.info(`阅读进度: ${progress}/${max} 分（已读 ${articlesDone}/${articlesTotal} 篇，还需 ${articlesLeft} 篇）`);
    return { ok: true, progress, max, articlesDone, articlesTotal, articlesLeft };
  } catch (e) {
    logger.warn(`阅读进度获取出错: ${e.message}`);
    return fail;
  }
}

module.exports = {
  UA_PC,
  UA_MOBILE,
  READ_OFFER_ID,
  POINTS_PER_ARTICLE,
  resolveHost,
  mainlandCheck,
  getRewardsInfo,
  getReadPro,
  parsePointsCounters,
  parsePointsHistory,
};
