const logger = require("./logger");
const { httpRequest } = require("./http");
const ipLookup = require("./ip-lookup");
const riskSignals = require("./risk-signals");
const dailyQuota = require("./daily-quota");
const searchQuota = require("./mobile-quota");

const UA_PC = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const UA_MOBILE = "Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.0.0";

// 锁区目标展示名。当前只锁中国大陆；预留后期按国家/地区锁区（届时改成配置项读取）。
const LOCK_REGION_LABEL = "中国大陆";

/** 解析 bing 主机：锁定国区则使用 cn.bing.com。
 *
 * 不再使用模块级缓存：早期实现把首次解析结果缓存在 `cachedHost` 上，
 * 后续所有账户复用同一份首账户的判定；lock 状态在多账户间翻转时会污染。
 * 这里直接读 config（廉价），避免跨账户缓存。 */
function resolveHost(ctx) {
  const cfg = ctx.config.get();
  return cfg.region && cfg.region.lock ? "cn.bing.com" : "www.bing.com";
}

/**
 * 解析单个 bing 主机首页中的 Region / RevIpCC。
 * @returns {Promise<{host:string, region:string, ipcc:string, decisive:boolean}>}
 *          decisive=false 表示拿到响应但 Bing 内嵌无国家码（构造失败 / 改版）
 */
async function probeBingHost(ctx, host) {
  try {
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
      logger.warn(`区域检测(Bing/${host}) 无法获取首页，跳过`);
      return { host, region: "", ipcc: "", decisive: false };
    }
    const clean = res.text.replace(/\s+/g, "");
    const m = clean.match(/Region:"(.*?)"(.*?)RevIpCC:"(.*?)"/);
    if (!m) {
      logger.warn(`区域检测(Bing/${host}) 未解析到区域信息，跳过`);
      return { host, region: "", ipcc: "", decisive: false };
    }
    const region = m[1].toUpperCase();
    const ipcc = m[3].toUpperCase();
    logger.info(`区域检测(Bing/${host}): Region=${region}, RevIpCC=${ipcc}`);
    return { host, region, ipcc, decisive: true };
  } catch (e) {
    logger.warn(`区域检测(Bing/${host}) 异常: ${e.message}`);
    return { host, region: "", ipcc: "", decisive: false };
  }
}

/**
 * Bing 首页区域检查
 *
 * lock=false：按 `resolveHost` 单站探针，返回单一国家码。
 * lock=true：双站（cn.bing.com + www.bing.com）并发探测，取最坏结果——
 *   在分流规则下（如 Clash/Mihomo TUN 模式），`cn.bing.com` 几乎必然被
 *   GEOIP,CN,DIRECT 命中走国内直连，而 `www.bing.com` 在某些规则集里
 *   路由不同。两个站点比对能识破「检测走直连 / 任务走代理」的盲区。
 *
 * @returns {Promise<{ok: boolean, region: string, ipcc: string, decisive: boolean}>}
 *          decisive=false 表示全部站都没拿到判断（调用方据此保守放行）
 */
async function bingRegionCheck(ctx) {
  const cfg = ctx.config.get();
  const lock = !!(cfg.region && cfg.region.lock);
  const hosts = lock ? ["cn.bing.com", "www.bing.com"] : [resolveHost(ctx)];
  const probes = await Promise.all(hosts.map((h) => probeBingHost(ctx, h)));
  const decisive = probes.filter((p) => p.decisive);
  if (decisive.length === 0) {
    return { ok: true, region: "", ipcc: "", decisive: false };
  }
  // 保守：任何一个非 CN → 整体判定为非 CN（多源中取最坏）
  const nonCn = decisive.find((p) => p.ipcc !== "CN");
  if (nonCn) {
    return { ok: true, region: nonCn.region, ipcc: nonCn.ipcc, decisive: true };
  }
  // 全部 CN，取首个
  return { ok: true, region: decisive[0].region, ipcc: decisive[0].ipcc, decisive: true };
}

/**
 * 大陆 IP 检查
 *
 * 锁定国区 (lock=true) 时，**多源保守并用**——绝不能让单源说了算：
 *   - bingRegionCheck：双站 cn.bing.com + www.bing.com 并发（识别「同分流下不同站点
 *     走不同通道」的盲区，例如 Clash TUN 规则命中 GEOIP,CN,DIRECT 仅放行 cn.bing.com）
 *   - 第三方 IP 服务（用户选定的 provider，auto 时按 ipsb→pconline→ipinfo→ipapi 链降级）
 *   - 锁定国区时**额外**强制探测一次 ipsb（境外 GeoIP，在分流规则下通常被路由到代理节点，
 *     是测出「实际任务出口」的关键探针，不会被国内分流规则一票直连放行）
 *   - 任一明确「非大陆」即判定为非大陆；全部失败 / 全部 undecidable 仍走「保守放行」
 *     （保留「不因服务抽风而误停任务」的原始设计）
 *
 * lock=false：纯信息展示，按用户选的 provider 单源降级，失败回落 Bing。
 * @returns {Promise<{ok: boolean, region: string, ipcc: string, reason?: string}>}
 */
async function mainlandCheck(ctx) {
  const cfg = ctx.config.get();
  const lock = !!(cfg.region && cfg.region.lock);
  const provider = (cfg.region && cfg.region.ipProvider) || "auto";

  if (lock) {
    // 并行：双站 Bing + 用户选定 provider + 强制 ipsb 交叉验证
    const [b, rUser, ipsb] = await Promise.all([
      bingRegionCheck(ctx),
      ipLookup.queryProvider(provider, ctx),  // "bing" 时会 null，回落到 bing
      ipLookup.queryProvider("ipsb", ctx),   // 强制必查：探测代理节点出口
    ]);

    const verdicts = [];
    if (b.decisive) {
      verdicts.push({ source: "bing", region: b.region, ipcc: b.ipcc, mainland: b.ipcc === "CN" });
    } else {
      verdicts.push({ source: "bing", mainland: null });
    }
    if (rUser) verdicts.push(rUser);
    if (ipsb) verdicts.push(ipsb);

    return judgeMainland(verdicts, { lock: true });
  }

  // lock=false：单源信息展示（保留原行为）
  if (provider === "bing") {
    const b = await bingRegionCheck(ctx);
    return { ok: true, region: b.region, ipcc: b.ipcc };
  }

  const r = await ipLookup.lookupCountry(ctx, provider);
  if (r && r.mainland !== null) {
    const ipcc = r.countryCode || (r.mainland ? "CN" : "");
    logger.info(`区域检测(${r.source}): ip=${r.ip} 国家码=${ipcc || "未知"} ${r.detail || ""}`.trim());
    return { ok: true, region: "", ipcc };
  }

  if (r) logger.warn(`IP 服务 ${r.source} 未能确定国家码，回落 Bing 判定`);
  else logger.warn("所有第三方 IP 查询服务均不可用，回落 Bing 判定");
  const b = await bingRegionCheck(ctx);
  return { ok: true, region: b.region, ipcc: b.ipcc };
}

/**
 * 纯函数：多源判定汇聚（无 IO，可在自检中离线断言）。
 *
 * 任一探针 mainland === false 且 lock=true → 拦截；
 * 全部 inconclusive（mainland === null）→ 放行但记 warning（保留「保守放行」语义）；
 * 至少一个 mainland === true 且无 mainland === false → 放行。
 *
 * @param {Array<{source:string, mainland:boolean|null, ip?:string, countryCode?:string, region?:string, detail?:string}>} verdicts
 * @param {{lock: boolean}} opts
 * @returns {{ok:boolean, region:string, ipcc:string, reason?:string}}
 */
function judgeMainland(verdicts, opts = {}) {
  const lock = !!opts.lock;
  const log = (msgs) => { try { require("./logger").info(msgs); } catch (_) { /* offline 自检允许 logger 失败 */ } };

  for (const v of verdicts || []) {
    if (v && v.mainland !== null && v.mainland !== undefined) {
      const cc = v.countryCode || (v.mainland ? "CN" : "") || "未知";
      log(`区域检测(${v.source}): ip=${v.ip || ""} 国家码=${cc} ${v.detail || ""}`.trim());
    }
  }

  if (lock) {
    const nonCn = (verdicts || []).find((v) => v && v.mainland === false);
    if (nonCn) {
      const reason = `检测到非${LOCK_REGION_LABEL}区域（由 ${nonCn.source} 判定），本次任务已取消执行`;
      return {
        ok: false,
        region: nonCn.region || "",
        ipcc: nonCn.countryCode || nonCn.ipcc || "",
        ip: nonCn.ip || ((verdicts.map((v) => v && v.ip).find(Boolean)) || ""),
        // 归属地优先取触发拦截的探针（多源冲突时展示的就是拦下的那个出口）
        geo: ipLookup.geoLabel([nonCn].concat(verdicts)),
        // 运营商：某个探针可能拿不到（ip-api 未请求该字段时会是空），
        // 所以从**所有**探针里捞第一个非空的 —— 空则整段省略，不显示「未知」。
        isp:
          ipLookup.normIsp(
            (([nonCn].concat(verdicts)).map((v) => v && v.isp).find(Boolean)) || ""
          ) || "",
        reason,
      };
    }
    const allInconclusive = verdicts.every((v) => !v || v.mainland === null || v.mainland === undefined);
    if (allInconclusive) {
      log("区域检测: 所有探针均无明确结论，按保守放行；锁定国区用户请检查网络/代理设置。");
    }
  }

  // 至少一个 mainland=true → 放行；否则空放行（兼容旧调用方）
  const cn = (verdicts || []).find((v) => v && v.mainland === true);
  return { ok: true, region: cn && cn.region ? cn.region : "", ipcc: cn && cn.countryCode ? cn.countryCode : "" };
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
 * 在文本中查找某扁平 key 对应的数字值（如 "balance":582 / "availablePoints":583）
 * 兼容 RSC 数据中的 \" 转义形态。优先精确匹配 `"key":数字`，找不到时退化为宽松匹配。
 * @param {string} text
 * @param {string} keyName 形如 "balance" 或 "availablePoints"（不含引号）
 * @returns {number|null} 找到返回数字，否则 null
 */
function findFlatNumber(text, keyName) {
  if (!text) return null;
  const candidates = [text];
  if (text.includes('\\"')) candidates.push(text.split('\\"').join('"'));
  const re = new RegExp('"' + keyName + '":\\s*(\\d+)');
  for (const cand of candidates) {
    const m = cand.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return n;
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
    pc: { progress: 0, max: 0, explicitMax: false },
    m: { progress: 0, max: 0, explicitMax: false },
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
  if (!obj || typeof obj !== "object") return { progress: 0, max: 0, explicitMax: false };
  const pp = obj.pointProgress && typeof obj.pointProgress === "object" ? obj.pointProgress : null;
  const src = pp || obj;
  // ⚠️ 2026-11-24：必须保留「服务器是否明确给了 max」这个信息。
  // max=0（月度计划拿满后当日额度被压成 0）与「字段缺失」是两回事：
  // 前者是法定额度 0，不能回落到 DEFAULT_PC_SEARCH_MAX=15 去白跑。
  const explicitMax =
    src.max !== undefined || src.originalMax !== undefined || src.pointProgressMax !== undefined;
  const maxRaw = src.max !== undefined
    ? src.max
    : src.originalMax !== undefined
      ? src.originalMax
      : src.pointProgressMax;
  const progressRaw = src.progress !== undefined ? src.progress : src.pointProgress;
  return { progress: num(progressRaw), max: num(maxRaw), explicitMax };
}

/**
 * 获取 Rewards 账户积分信息
 *
 * 新版 earn 页 pointsCounters 结构（2026-08 改版后）：
 *   { "dailyOffer": 115, "pc": {"max":15,"progress":0,"originalMax":15},
 *     "totalPoints": 115, "boostActivated": false }
 * 其中 dailyOffer 已由对象变为数字（= 今日已得积分），旧版的 todayTotal /
 * pointProgress / mobileSearch 字段均已不存在 —— **earn 页只下发 PC 节点**。
 * ⚠️ 2026-11-25 手机真机抓包定案：earn 页看不到 mobile 节点是**正常的**，
 * 因为国区（Level3 金牌）只有一个「统一搜索池」：手机 Bing App 的 dapi/me
 * `promotions[]` 里仅一张 `WW_NewLevel3_search_PC`（max=60/progress=51），
 * 与同一时刻 earn 页 `PC搜索=51/60` 完全一致，两者是同一个额度。
 * 旧版按 MRS助手 PC 脚本去 `/api/getuserinfo` 补拉 `counters.mobileSearch[]`
 * 是别的区服的两池结构，张冠李戴，已移除（详见 mobile-quota.js 真机证据）。
 * ⇒ `m` 恒 0/0 是正确值；earn 页 pc 节点解析失败时才用 dapi/me 搜索卡兜底。
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

  // 真实“总积分/可用积分”：优先取 earn 页里的独立字段 "balance" 或 "availablePoints"
  // （实测 earn 页 RSC 数据为 "balance":582，而 pointsCounters.totalPoints=82 仅是“今日积分”）。
  // 参考脚本（修改版.js）即采用该取法：balance = "balance":(\d+) || "availablePoints":(\d+)
  const pageBalance = findFlatNumber(res.text, "balance");
  const pageAvailable = findFlatNumber(res.text, "availablePoints");
  const realBalance = pageBalance != null ? pageBalance : pageAvailable;

  // dailyOffer：新版为数字（今日已得积分）；旧版为对象 {dailyPoint, todayTotal}
  const dailyOfferIsNum = typeof pc.dailyOffer === "number";
  const dailyOffer = !dailyOfferIsNum && pc.dailyOffer && typeof pc.dailyOffer === "object" ? pc.dailyOffer : {};

  const pcNode = pc.pcSearch !== undefined ? pc.pcSearch : pc.pc;
  const mNode = pc.mobileSearch !== undefined ? pc.mobileSearch : pc.mobile;

  // earn 页的 pc 上限本来就是动态的（Level2=30 / Level3=60 / 月末被压缩时更小）。
  // 只有「字段缺失 / 解析失败」才用 getReadPro 顺手缓存的 dapi/me 搜索卡兜底；
  // 服务器**明确给 0**（封顶）必须原样保留，不能被旧缓存覆盖成非 0（会漏掉保活）。
  let pcProgress = normProgress(pcNode);
  let pcSource = pcProgress.explicitMax ? "earn" : "unavailable";
  if (!pcProgress.explicitMax) {
    const cached = searchQuota.readSearchQuota(ctx);
    if (cached && cached.ok && cached.max > 0) {
      pcProgress = { progress: cached.progress, max: cached.max, explicitMax: true };
      pcSource = "dapi/me";
    }
  }

  // 2026-11-25 真机实证：国区是统一搜索池，不存在独立的「手机端每日 60 分」。
  // 不再补拉任何外部接口 —— 一旦给出非 0 的 m.max，taskSearch 会把搜索切到
  // 从未验证过的移动 UA 路径，重复计同一个池甚至触发风控。
  // 别的用户/区服若真有两池结构，earn 页会直接下发 mobile 节点，这里照常采信。
  let mobileProgress = normProgress(mNode);
  let mobileSource = mobileProgress.explicitMax ? "earn" : "unified-pool";
  if (!mobileProgress.explicitMax) {
    mobileProgress = { progress: 0, max: 0, explicitMax: true };
  }

  // 今日已得积分：
  // - 新版 pointsCounters.totalPoints = 今日积分（dailyOffer + pc 进度），实测 = 82
  // - 旧版取 dailyOffer.todayTotal / pc.todayTotal
  let todayTotal = 0;
  if (pc.totalPoints !== undefined) todayTotal = num(pc.totalPoints);
  else if (dailyOfferIsNum) todayTotal = num(pc.dailyOffer);
  else if (dailyOffer.todayTotal !== undefined) todayTotal = num(dailyOffer.todayTotal);

  const history = parsePointsHistory(res.text);
  const monthEarn = history && history.thisMonth ? num(history.thisMonth.earn) : 0;

  const info = {
    ok: true,
    // 总积分优先用页面独立字段（真实可用积分），找不到再回退 pointsCounters.totalPoints
    balance: realBalance != null ? realBalance : num(pc.totalPoints !== undefined ? pc.totalPoints : pc.balance),
    pc: pcProgress,
    m: mobileProgress,
    dailyPoint: dailyOfferIsNum ? 0 : num(dailyOffer.dailyPoint !== undefined ? dailyOffer.dailyPoint : pc.dailyPoint),
    todayTotal,
    monthEarn,
    boostActivated: !!pc.boostActivated,
    // 风控信号：earn 页 RSC 里可能带 serpbotscore / userWarnings。
    // 复用这次已拉到的 HTML 顺手解析，不为检查风控额外发一次请求（2026-11-17）。
    risk: riskSignals.parseRiskSignals(res.text),
  };
  logger.info(
    `积分信息: 总积分=${info.balance}, PC搜索=${info.pc.progress}/${info.pc.max}（来源 ${pcSource}）, 移动搜索=${info.m.progress}/${info.m.max}（${mobileSource === "unified-pool" ? "统一搜索池，无独立移动额度" : "来源 " + mobileSource}）, 今日已得=${info.todayTotal}, 本月累计=${info.monthEarn}${info.boostActivated ? ", 2倍搜索已激活" : ""}`
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
  const fail = { ok: false, progress: -1, max: 30, articlesDone: 0, articlesTotal: 10, articlesLeft: 10, capped: false, explicitMax: false, source: "unavailable" };
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
    // 同一个 dapi/me 响应里就有搜索任务卡（2026-11-25 真机实证）：顺手解析成
    // 「统一搜索池」真值并缓存，供 getRewardsInfo 在 earn 页解析失败时兜底，
    // 不多发一次请求，也不改变阅读逻辑。
    const sq = searchQuota.parseSearchCards(data);
    if (sq.ok) {
      searchQuota.noteSearchQuota(ctx, sq);
      logger.info(
        `统一搜索池(dapi/me): ${sq.progress}/${sq.max} 分（${sq.unifiedPool ? "无独立移动端额度" : "存在独立移动端卡"}，卡 ${sq.cardNames.join(",")}）`
      );
    }
    const promos = (data.response && data.response.promotions) || [];
    const readTask = promos.find((x) => x.attributes && x.attributes.offerid === READ_OFFER_ID);
    if (!readTask) {
      logger.warn("未在 dapi/me 中找到阅读任务节点");
      return fail;
    }
    // 2026-11-24：篇数一律由服务器返回的 max/progress 换算，不再 `|| 30` 写死。
    // 服务器明确给 0 时 articlesTotal/Left 都是 0，任务侧据此跳过，不再白跑 10 篇。
    const q = dailyQuota.normalizeReadQuota(readTask.attributes, {
      fallbackMax: dailyQuota.FALLBACK_READ_MAX,
      pointsPerArticle: POINTS_PER_ARTICLE,
    });
    logger.info(
      `阅读进度: ${q.progressPoints}/${q.maxPoints} 分（已读 ${q.articlesDone}/${q.articlesTotal} 篇，还需 ${q.articlesLeft} 篇，来源 ${q.source}${q.capped ? "，今日额度为 0" : ""}${q.compressed ? "，额度已被压缩" : ""}）`
    );
    return {
      ok: true,
      progress: q.progressPoints,
      max: q.maxPoints,
      articlesDone: q.articlesDone,
      articlesTotal: q.articlesTotal,
      articlesLeft: q.articlesLeft,
      capped: q.capped,
      compressed: q.compressed,
      explicitMax: q.explicit,
      source: q.source,
    };
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
  LOCK_REGION_LABEL,
  resolveHost,
  mainlandCheck,
  bingRegionCheck,
  judgeMainland,
  probeBingHost,
  getRewardsInfo,
  getReadPro,
  parsePointsCounters,
  parsePointsHistory,
};
