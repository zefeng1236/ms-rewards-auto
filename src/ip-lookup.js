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

function norm(id, ip, countryCode, mainland, detail, extra) {
  const v = { ip: ip || "", countryCode: countryCode || "", mainland: mainland === undefined ? null : mainland, source: id, detail: detail || "" };
  // extra：地理名称字段（cityEn/cityCn/countryEn/countryCn），供拦截推送展示归属地；
  // 另有 isp（运营商/出口组织），随 geo 一起进拦截推送，帮助用户判断
  // 「是代理节点换了，还是家里宽带出口变了」。
  return extra ? Object.assign(v, extra) : v;
}

/**
 * 运营商（ISP）名归一化。
 *
 * 各家返回的东西形态很杂：
 *   - ip.sb    organization = "China Telecom" / "Amazon.com, Inc."
 *   - ipinfo   org          = "AS4134 CHINANET-BACKBONE"  ← 前面带 AS 号，要剥
 *   - 太平洋   addr         = "广东省深圳市 电信"          ← 混在地址里，要挑出来
 *   - ip-api   isp          = "China Telecom Jiangsu"
 * 统一成「人能认的短名」：剥 AS 号 / 去多余空格。
 *
 * 「过长就截断」已在 2026-10-17 移除：拦截推送里 IP / 归属地 / 运营商**各占一行**
 * （见 runner.pushRegionBlocked），运营商独享整行宽度，早先「与 geo 挤在同一行」
 * 才需要的 28 字符额度已无意义 —— 旧上限会把 "Hytron Network Services Limited"
 * 砍成 "Hytron Network Services Limi…"，运营商名显示不全。
 * 这里**不再做长度截断**，完整交回调用方。
 *
 * @param {string} s
 * @returns {string} 取不到时返回空串（推送里会整段省略，不显示"未知"）
 */
function normIsp(s) {
  let v = String(s == null ? "" : s).trim();
  if (!v) return "";
  // 剥掉开头的 AS 号（ipinfo 的 "AS4134 CHINANET-BACKBONE" → "CHINANET-BACKBONE"）
  v = v.replace(/^AS\d+\s+/i, "").trim();
  // 多值取第一个（有的服务返回 "Org (ASN)" 或 "A, B"）
  v = v.split(/[,(]/)[0].trim();
  return v;
}

/**
 * 从太平洋返回的中文 addr 里挑出运营商。
 * addr 形如「广东省深圳市 电信」「中国 江苏 南京 联通」，运营商通常在末段。
 * 认不出来就返回空串 —— 宁缺勿错，别把地名当运营商显示。
 */
const ISP_CN_KEYWORDS = [
  "电信", "联通", "移动", "铁通", "广电", "教育网", "科技网", "长城宽带", "鹏博士",
  "阿里云", "腾讯云", "华为云", "百度云", "火山引擎", "京东云", "UCloud", "青云",
];
function ispFromCnAddr(addr) {
  const s = String(addr == null ? "" : addr);
  for (const k of ISP_CN_KEYWORDS) if (s.includes(k)) return k;
  return "";
}

/** 各家服务的「请求 + 解析」实现。失败时抛出，由上层捕获降级。 */
/* ---- 各家响应的纯解析函数（无网络，便于自检离线断言） ---- */

/**
 * 把 httpRequest 的结果转成「可解析的正文」，失败时抛出**真实原因**。
 *
 * ⚠️ 为什么必须走这一层（2026-11-04 用户报「IP 查询服务 ipsb 失败：ip.sb 空响应」）：
 *   `src/http.js` 的 httpRequest **不抛异常** —— 出错时返回 `{status:0, text:"", error:msg}`。
 *   而各家的 parse 函数只判 `if (!text) throw "xxx 空响应"`，
 *   于是超时 / DNS 失败 / TLS 失败 / 被墙 / 5xx 全被统一说成「空响应」。
 *   这句话把人往「接口返回了空数据」的方向带，而真实原因（比如请求根本没发出去）
 *   恰恰是最需要看见的那条信息 —— 排查时会白绕一圈。
 *
 * @param {{status:number, text:string, error?:string, headers?:any}} r
 * @param {string} label 服务名（用于报错文案）
 * @returns {string} 非空正文
 */
function bodyOf(r, label) {
  // ① 传输层失败优先：这才是根因，不能被后面的「空正文」掩盖
  if (r && r.error) throw new Error(`${label} 请求失败：${r.error}`);
  // ② HTTP 错误码：401/403/429/5xx 的正文常常是错误页 HTML，直接解析会得到莫名其妙的 JSON 报错
  const status = r && r.status;
  if (typeof status === "number" && status >= 400) {
    const snippet = String((r && r.text) || "").replace(/\s+/g, " ").slice(0, 60);
    throw new Error(`${label} 返回 HTTP ${status}${snippet ? `：${snippet}` : ""}`);
  }
  // ③ 到这一步才是真的「请求成功但正文为空」
  const text = r && r.text;
  if (!text) throw new Error(`${label} 空响应（HTTP ${status || "?"}，无正文）`);
  return text;
}

/**
 * 安全解析 JSON：失败时给出**能看出发生了什么**的报错。
 *
 * 默认的 `JSON.parse` 抛的是 `Unexpected token '<'...` ——
 * 那个 `<` 其实是 HTML 错误页/被劫持页的首字符，但报错本身完全不提这层意思，
 * 排查时容易误以为是代码 bug。
 */
function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    const head = String(text || "").replace(/\s+/g, " ").slice(0, 70);
    // 首字符是 < → 几乎可以断定拿到的是 HTML 页（运营商劫持 / 网关拦截 / 错误页）
    const hint = /^\s*</.test(String(text || "")) ? "（返回的是 HTML 页面，可能被劫持或网关拦截）" : "";
    throw new Error(`${label} 返回的不是 JSON${hint}：${head}`);
  }
}

// 太平洋网络（国内老牌，whois.pconline.com.cn），境内直连稳定、不被墙。
// 境内：proCode 为 6 位行政区划码（如 320000）、err 为空；
// 境外：proCode 固定 "999999"、err="noprovince"。
function parsePconline(text) {
  if (!text) throw new Error("pconline 空响应");
  const j = parseJson(text.trim(), "pconline");
  const code = String(j.proCode || "");
  const isMainland = /^\d{6}$/.test(code) && code !== "999999";
  return norm("pconline", j.ip, isMainland ? "CN" : "", isMainland, j.addr || "", {
    cityCn: String(j.city || ""),
    isp: ispFromCnAddr(j.addr),
  });
}

// ip.sb：全球 CDN，返回标准 ISO 国家码（country_code），city/country 为英文名
function parseIpsb(text) {
  if (!text) throw new Error("ip.sb 空响应");
  const j = parseJson(text, "ip.sb");
  const cc = String(j.country_code || "").toUpperCase();
  return norm("ipsb", j.ip, cc, cc ? cc === "CN" : null, j.organization || j.isp || "",
    {
      cityEn: String(j.city || ""),
      countryEn: String(j.country || ""),
      isp: normIsp(j.isp || j.organization || j.asn_organization || ""),
    });
}

// ipinfo.io：返回 country 为 ISO 码，city 为英文名
function parseIpinfo(text) {
  if (!text) throw new Error("ipinfo 空响应");
  const j = parseJson(text, "ipinfo");
  const cc = String(j.country || "").toUpperCase();
  return norm("ipinfo", j.ip, cc, cc ? cc === "CN" : null, j.org || j.region || "",
    {
      cityEn: String(j.city || ""),
      // ipinfo 的 org 形如 "AS4134 CHINANET-BACKBONE"，normIsp 会剥掉 AS 号
      isp: normIsp(j.org || ""),
    });
}

// ip-api.com：免费版仅 http，国内连通性一般，作为可选项/降级项。
// 请求带 lang=zh-CN，country/city 直接是中文名（如 日本/东京）。
function parseIpapi(text) {
  if (!text) throw new Error("ip-api 空响应");
  const j = parseJson(text, "ip-api");
  if (j.status !== "success") throw new Error(`ip-api ${j.message || "失败"}`);
  const cc = String(j.countryCode || "").toUpperCase();
  return norm("ipapi", j.query, cc, cc ? cc === "CN" : null, "",
    {
      cityCn: String(j.city || ""),
      countryCn: String(j.country || ""),
      isp: normIsp(j.isp || ""),
    });
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
    return parsePconline(bodyOf(r, "pconline"));
  },
  async ipsb(ctx) {
    const r = await httpRequest({
      url: "https://api.ip.sb/geoip",
      headers: { "user-agent": UA },
      timeout: 8000,
      ctx,
      dontLog: true,
    });
    return parseIpsb(bodyOf(r, "ip.sb"));
  },
  async ipinfo(ctx) {
    const r = await httpRequest({
      url: "https://ipinfo.io/json",
      headers: { "user-agent": UA, accept: "application/json" },
      timeout: 8000,
      ctx,
      dontLog: true,
    });
    return parseIpinfo(bodyOf(r, "ipinfo"));
  },
  async ipapi(ctx) {
    const r = await httpRequest({
      // isp 字段必须显式请求：ip-api 默认只返回基础字段，不写就拿不到运营商
      url: "http://ip-api.com/json/?fields=status,message,countryCode,query,isp&lang=zh-CN",
      headers: { "user-agent": UA },
      timeout: 8000,
      ctx,
      dontLog: true,
    });
    return parseIpapi(bodyOf(r, "ip-api"));
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

/** 常见国家/地区代码 → 中文名（拦截推送展示用；未收录时回落英文名/代码） */
const COUNTRY_CN = {
  CN: "中国大陆", HK: "中国香港", MO: "中国澳门", TW: "中国台湾",
  JP: "日本", KR: "韩国", SG: "新加坡", MY: "马来西亚", TH: "泰国", VN: "越南",
  PH: "菲律宾", ID: "印度尼西亚", IN: "印度", US: "美国", CA: "加拿大",
  GB: "英国", DE: "德国", FR: "法国", NL: "荷兰", RU: "俄罗斯", AU: "澳大利亚",
  NZ: "新西兰", BR: "巴西", AE: "阿联酋", TR: "土耳其", UA: "乌克兰", PL: "波兰",
};

/** 常见代理节点城市 英文 → 中文（未收录时回落英文名） */
const CITY_EN2CN = {
  Tokyo: "东京", Osaka: "大阪", Seoul: "首尔", Singapore: "新加坡",
  "Hong Kong": "香港", Taipei: "台北", "Los Angeles": "洛杉矶", "San Jose": "圣何塞",
  Seattle: "西雅图", "New York": "纽约", London: "伦敦", Frankfurt: "法兰克福",
  Amsterdam: "阿姆斯特丹", Paris: "巴黎", Bangkok: "曼谷", "Kuala Lumpur": "吉隆坡",
  Jakarta: "雅加达", Mumbai: "孟买", Dubai: "迪拜", Moscow: "莫斯科", Sydney: "悉尼",
  Warsaw: "华沙", Stockholm: "斯德哥尔摩",
};

/**
 * 汇聚多源判定里的地理字段，拼出「城市/国家码(中文城市/中文国名)」展示串。
 * 例：Tokyo/JP(东京/日本)。字段可缺，缺哪段省哪段，全缺返回 "未知"。
 *
 * @param {Array<object>} verdicts 判定数组（兼容 countryCode/ipcc 两种字段名）
 * @returns {string}
 */
function geoLabel(verdicts) {
  const list = (verdicts || []).filter(Boolean);
  const pick = (k) => {
    for (const v of list) if (v[k]) return String(v[k]);
    return "";
  };
  const cc = (pick("countryCode") || pick("ipcc")).toUpperCase();
  const cityEn = pick("cityEn");
  const cityCn = pick("cityCn") || (cityEn ? CITY_EN2CN[cityEn] || "" : "");
  const countryCn = pick("countryCn") || (cc ? COUNTRY_CN[cc] || "" : "");
  const left = cityEn ? `${cityEn}/${cc}` : cc;
  const right = [cityCn, countryCn].filter(Boolean).join("/");
  let label = "";
  if (left && right) label = `${left}(${right})`;
  else label = left || right || "未知";
  // 归属地前面挂国旗（2026-10-09 用户要求）：推送里一眼扫到国家，
  // 不用去读括号里的文字。认不出国家码时就不加，别留个空前缀。
  const flag = flagEmoji(cc);
  return flag ? `${flag} ${label}` : label;
}

/**
 * ISO 3166-1 alpha-2 国家/地区码 → 国旗 emoji。
 *
 * 原理：国旗 emoji 是两个「区域指示符」字母拼成的，
 *   码点 = 0x1F1E6(A) + (字母序号)。如 JP → 🇯 + 🇵 → 🇯🇵
 *
 * ⚠️ 香港 / 澳门 / 台湾是**中国**的一部分，不是独立国家 ——
 *    这三者统一使用中国国旗 🇨🇳，与 COUNTRY_CN 里「中国香港 / 中国澳门 /
 *    中国台湾」的中文口径保持一致（不用各自的地区旗）。
 *
 * @param {string} cc 两位字母码，非法返回空串
 * @returns {string}
 */
function flagEmoji(cc) {
  const s = String(cc || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) return "";
  const eff = s === "HK" || s === "MO" || s === "TW" ? "CN" : s;
  const A = 65; // 'A'
  const REGIONAL_INDICATOR_A = 0x1f1e6;
  return String.fromCodePoint(
    ...[...eff].map((ch) => REGIONAL_INDICATOR_A + (ch.charCodeAt(0) - A))
  );
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
  // 供自检离线断言：错误文案必须区分「请求失败 / HTTP 错误 / 真的空正文」
  bodyOf,
  parseJson,
  normIsp,
  ispFromCnAddr,
  geoLabel,
  flagEmoji,
  COUNTRY_CN,
  CITY_EN2CN,
};
