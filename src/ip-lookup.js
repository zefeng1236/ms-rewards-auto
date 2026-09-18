/**
 * 出口 IP / 归属地查询
 *
 * 统一封装多家公开的 IP 归属地服务，返回归一化结构：
 *   { ip, countryCode, mainland, source, detail }
 *     - countryCode: ISO 3166-1 alpha-2 大写（"CN"），无法确定时为 ""
 *     - mainland:    三元 —— true 确定在中国大陆 / false 确定不在 / null 无法判定
 *     - source:      实际命中的服务 id
 *
 * 选择原则（默认 auto）：优先「国内大厂/老牌、不被墙」的太平洋 IP 库，
 * 失败再依次降级到 ip.sb、ipinfo.io、ip-api.com；调用方（rewards.mainlandCheck）
 * 在这些都不可用时还会回落到 Bing 首页的 RevIpCC，保证不会因为第三方抽风而误停任务。
 *
 * 注意：太平洋接口返回 GBK 编码，但国区判定只依赖 ASCII 字段（proCode / err / ip），
 * GBK 下这些字符仍是单字节 ASCII，JSON 可正常解析；中文 addr 可能乱码，不参与判定。
 */
const { httpRequest } = require("./http");
const logger = require("./logger");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** 可供用户选择的服务（id -> 展示名）。auto 不在此列，由 UI 单独提供。 */
const PROVIDERS = [
  { id: "ipsb", label: "ip.sb（自动模式首选）" },
  { id: "pconline", label: "太平洋 IP 库（国内）" },
  { id: "ipinfo", label: "ipinfo.io" },
  { id: "ipapi", label: "ip-api.com" },
  { id: "bing", label: "Bing 首页判定（旧方式）" },
];

/** auto 模式下第三方服务的尝试顺序（Bing 回落由 rewards 层负责）。
 *  ip.sb 优先：境内可达 + 标准国家码；其后用国内太平洋兜底，再到国际服务。 */
const AUTO_ORDER = ["ipsb", "pconline", "ipinfo", "ipapi"];

function norm(id, ip, countryCode, mainland, detail) {
  return { ip: ip || "", countryCode: countryCode || "", mainland: mainland === undefined ? null : mainland, source: id, detail: detail || "" };
}

/** 各家服务的「请求 + 解析」实现。失败时抛出，由上层捕获降级。 */
/* ---- 各家响应的纯解析函数（无网络，便于自检离线断言） ---- */

// 太平洋网络（国内老牌，whois.pconline.com.cn），境内直连稳定、不被墙。
// 境内：proCode 为 6 位行政区划码（如 320000）、err 为空；
// 境外：proCode 固定 "999999"、err="noprovince"。
function parsePconline(text) {
  if (!text) throw new Error("pconline 空响应");
  const j = JSON.parse(text.trim());
  const code = String(j.proCode || "");
  const isMainland = /^\d{6}$/.test(code) && code !== "999999";
  return norm("pconline", j.ip, isMainland ? "CN" : "", isMainland, j.addr || "");
}

// ip.sb：全球 CDN，返回标准 ISO 国家码（country_code）
function parseIpsb(text) {
  if (!text) throw new Error("ip.sb 空响应");
  const j = JSON.parse(text);
  const cc = String(j.country_code || "").toUpperCase();
  return norm("ipsb", j.ip, cc, cc ? cc === "CN" : null, j.organization || j.isp || "");
}

// ipinfo.io：返回 country 为 ISO 码
function parseIpinfo(text) {
  if (!text) throw new Error("ipinfo 空响应");
  const j = JSON.parse(text);
  const cc = String(j.country || "").toUpperCase();
  return norm("ipinfo", j.ip, cc, cc ? cc === "CN" : null, j.org || j.region || "");
}

// ip-api.com：免费版仅 http，国内连通性一般，作为可选项/降级项
function parseIpapi(text) {
  if (!text) throw new Error("ip-api 空响应");
  const j = JSON.parse(text);
  if (j.status !== "success") throw new Error(`ip-api ${j.message || "失败"}`);
  const cc = String(j.countryCode || "").toUpperCase();
  return norm("ipapi", j.query, cc, cc ? cc === "CN" : null, "");
}

const QUERY = {
  async pconline(ctx) {
    const r = await httpRequest({
      url: "https://whois.pconline.com.cn/ipJson.jsp?json=true",
      headers: { "user-agent": UA },
      timeout: 8000,
      ctx,
      dontLog: true,
    });
    return parsePconline(r.text);
  },
  async ipsb(ctx) {
    const r = await httpRequest({
      url: "https://api.ip.sb/geoip",
      headers: { "user-agent": UA },
      timeout: 8000,
      ctx,
      dontLog: true,
    });
    return parseIpsb(r.text);
  },
  async ipinfo(ctx) {
    const r = await httpRequest({
      url: "https://ipinfo.io/json",
      headers: { "user-agent": UA, accept: "application/json" },
      timeout: 8000,
      ctx,
      dontLog: true,
    });
    return parseIpinfo(r.text);
  },
  async ipapi(ctx) {
    const r = await httpRequest({
      url: "http://ip-api.com/json/?fields=status,message,countryCode,query&lang=zh-CN",
      headers: { "user-agent": UA },
      timeout: 8000,
      ctx,
      dontLog: true,
    });
    return parseIpapi(r.text);
  },
};

/** 查询单个服务（不做降级），失败返回 null */
async function queryProvider(id, ctx) {
  const fn = QUERY[id];
  if (!fn) return null;
  try {
    return await fn(ctx);
  } catch (e) {
    logger.warn(`IP 查询服务 ${id} 失败：${e.message}`);
    return null;
  }
}

/**
 * 按用户配置查询出口 IP 归属地。
 *
 * @param {object} ctx 账户上下文
 * @param {string} [preferred="auto"] 服务 id；auto / 未知值按 AUTO_ORDER 依次降级
 * @returns {Promise<null|{ip:string,countryCode:string,mainland:boolean|null,source:string,detail:string}>}
 *          全部服务都不可用时返回 null（调用方据此走 Bing 回落 / 保守放行）
 */
async function lookupCountry(ctx, preferred) {
  const want = String(preferred || "auto");
  const tried = new Set();
  if (want !== "auto" && want !== "bing") {
    tried.add(want);
    const one = await queryProvider(want, ctx);
    if (one) return one;
    // 用户指定的服务挂了：auto 降级，避免单点失败直接拦任务
    logger.warn(`指定的 IP 查询服务「${want}」不可用，改用自动降级`);
  }
  for (const id of AUTO_ORDER) {
    if (tried.has(id)) continue; // 指定服务刚试过且失败，不重复请求
    const r = await queryProvider(id, ctx);
    if (r) return r;
  }
  return null;
}

module.exports = {
  PROVIDERS,
  AUTO_ORDER,
  lookupCountry,
  queryProvider,
  parsePconline,
  parseIpsb,
  parseIpinfo,
  parseIpapi,
};
