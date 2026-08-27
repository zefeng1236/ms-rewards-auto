const logger = require("./logger");

const DEFAULT_TIMEOUT = 15000;

/**
 * 通用 HTTP 请求封装（基于 fetch，自动携带指定账户的 Cookie）
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.method="GET"]
 * @param {object} [options.headers]
 * @param {string|object} [options.data] 请求体（string 或普通对象，自动 JSON）
 * @param {number} [options.timeout=15000]
 * @param {"follow"|"manual"|"error"} [options.redirect="follow"]
 * @param {object} [options.ctx] 账户上下文（用于自动拼接该账户 Cookie）
 * @param {string} [options.cookie] 直接指定 Cookie（优先于 ctx）
 * @param {string[]} [options.cookieExcludes]
 * @param {boolean} [options.dontLog]
 */
async function httpRequest(options) {
  const {
    url,
    method = "GET",
    headers = {},
    data,
    timeout = DEFAULT_TIMEOUT,
    redirect = "follow",
    ctx,
    cookie,
    cookieExcludes,
    dontLog = false,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let cookieHeader = cookie;
  if (cookieHeader === undefined && ctx && ctx.state) {
    cookieHeader = ctx.state.buildCookieHeader(new URL(url).hostname, cookieExcludes);
  }

  const mergedHeaders = { ...headers };
  if (cookieHeader) mergedHeaders.Cookie = cookieHeader;
  if (data !== undefined && typeof data === "object") {
    mergedHeaders["Content-Type"] = "application/json";
  }

  if (!dontLog) logger.log("HTTP", `${method} ${url}`);

  try {
    const res = await fetch(url, {
      method,
      headers: mergedHeaders,
      body: data !== undefined ? (typeof data === "object" ? JSON.stringify(data) : data) : undefined,
      redirect,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!dontLog) logger.log("HTTP", `${method} ${url} -> ${res.status} ${String(text).slice(0, 120)}`);
    return { status: res.status, headers: res.headers, body: text, text, finalUrl: res.url, url: res.url };
  } catch (e) {
    const msg = e.name === "AbortError" ? `请求超时(${timeout}ms)` : e.message;
    if (!dontLog) logger.warn(`HTTP ${method} ${url} 失败: ${msg}`);
    return { status: 0, headers: null, body: "", text: "", finalUrl: url, url, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { httpRequest };
