const logger = require("./logger");
const browser = require("./browser");

const CLIENT_ID = "0000000040170455";
const SCOPE = "service::prod.rewardsplatform.microsoft.com::MBI_SSL";
const TOKEN_URL = "https://login.live.com/oauth20_token.srf";
const ACCESS_TOKEN_TTL = 20 * 60 * 1000; // 20 分钟

/**
 * 通过 refresh_token 刷新 access_token（不弹浏览器）
 * @returns {Promise<string|null>} access_token，失败返回 null
 */
async function refreshAccessToken(ctx) {
  const refreshToken = ctx.state.getRefreshToken();
  if (!refreshToken) {
    logger.warn("无 refreshToken，无法静默刷新（需交互登录一次）。");
    return null;
  }
  const url = `${TOKEN_URL}?client_id=${CLIENT_ID}&refresh_token=${encodeURIComponent(refreshToken)}&scope=${encodeURIComponent(SCOPE)}&grant_type=REFRESH_TOKEN`;
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    if (res.status !== 200) {
      logger.warn(`刷新 token 失败: HTTP ${res.status} ${text.slice(0, 200)}`);
      return null;
    }
    const data = JSON.parse(text);
    const accessToken = data.access_token;
    if (!accessToken) {
      logger.warn("刷新 token 响应缺少 access_token");
      return null;
    }
    // refresh_token 通常只在首次授权时返回；若响应带新 refresh_token 则更新
    if (data.refresh_token) {
      ctx.state.setTokens(data.refresh_token, accessToken);
    } else {
      ctx.state.setTokens(refreshToken, accessToken);
    }
    logger.ok("刷新 access_token 成功");
    return accessToken;
  } catch (e) {
    logger.warn(`刷新 token 请求失败: ${e.message}`);
    return null;
  }
}

/**
 * 用授权码换取 token（交互登录回调后的 code）
 * @returns {Promise<string|null>} access_token
 */
async function exchangeCode(ctx, code) {
  const url = `${TOKEN_URL}?client_id=${CLIENT_ID}&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent("https://login.live.com/oauth20_desktop.srf")}&grant_type=authorization_code`;
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    if (res.status !== 200) {
      logger.warn(`授权码换取 token 失败: HTTP ${res.status} ${text.slice(0, 200)}`);
      return null;
    }
    const data = JSON.parse(text);
    if (!data.access_token) {
      logger.warn("换取 token 响应缺少 access_token");
      return null;
    }
    ctx.state.setTokens(data.refresh_token || "", data.access_token);
    logger.ok("授权成功，已保存 token");
    return data.access_token;
  } catch (e) {
    logger.warn(`换取 token 请求失败: ${e.message}`);
    return null;
  }
}

/**
 * 获取可用的 access_token：
 * 1. 缓存有效（20 分钟内）直接复用
 * 2. 否则尝试 refresh_token 静默刷新
 * 3. 仍失败且 interactive=true 时弹出浏览器交互登录
 * @param {boolean} [interactive=false] 允许弹出浏览器
 * @returns {Promise<string|null>}
 */
async function ensureAccessToken(ctx, interactive = false) {
  const cached = ctx.state.getAccessToken();
  if (cached && Date.now() - (ctx.state.get().accessTokenAt || 0) < ACCESS_TOKEN_TTL) {
    return cached;
  }
  const refreshed = await refreshAccessToken(ctx);
  if (refreshed) return refreshed;

  if (interactive) {
    logger.info("静默刷新失败，需要交互登录。");
    const { code, loggedIn } = await browser.loginInteractive(ctx);
    if (!code) {
      logger.warn("交互登录未捕获授权码，未获取 token。");
      return null;
    }
    const token = await exchangeCode(ctx, code);
    if (!token) return null;
    if (!loggedIn) {
      logger.warn("已获取 token，但 rewards.bing.com 登录态同步失败（可稍后重试）。");
    }
    return token;
  }
  return null;
}

module.exports = { refreshAccessToken, exchangeCode, ensureAccessToken };
