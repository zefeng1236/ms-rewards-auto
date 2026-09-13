const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");
const logger = require("./logger");
const sp = require("./storage-path");

const ROOT = path.join(__dirname, "..");

// 认证 Cookie 名称集合（命中任一即认为已登录）
// 注意：不要加入 ANON / SRCHUSR / MUID —— 匿名访问时它们也存在，会造成误判
const AUTH_COOKIE_NAMES = [
  "_U",                  // bing.com 主认证票据
  ".MSA.Auth",
  "_C_Auth",
  "_M",
  "KievRPSSecAuth",      // login.live.com RPS 票据
  "RPSSecAuth",
  "ESTSAUTH",
  "ESTSAUTHPERSISTENT",
  "WLSSC",
];

function hasAuthCookies(cookies) {
  return (
    Array.isArray(cookies) &&
    cookies.some((c) => AUTH_COOKIE_NAMES.includes(c.name) && String(c.value || "").length > 0)
  );
}

/**
 * Playwright 自带 Chromium 的可执行路径（与系统 Edge/Chrome 完全隔离）
 * 未安装时返回 null
 */
function chromiumExecutablePath() {
  try {
    const p = chromium.executablePath();
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** Chromium 是否已就绪 */
function isChromiumReady() {
  return !!chromiumExecutablePath();
}

/**
 * 打开浏览器上下文：临时 profile + 注入 Cookie
 *
 * ⚠️ 这里不再使用 accounts/<id>/profile 那个持久化目录，原因很关键：
 * 持久化 profile 会让 Chromium 把登录 Cookie 明文写进磁盘（SQLite），
 * 那份明文不受本项目加密存储保护 —— 只加密 state.json 等于做了个假加密。
 *
 * 现在的做法：每次开一个临时目录，用保险库里解出的 Cookie 注入登录态，
 * 用完连目录一起删掉。这样磁盘上唯一的会话副本就是 state.json 里的密文。
 *
 * @param {object} ctx 账户上下文
 * @param {boolean} headless
 * @param {{cookies?: object[]}} [opts] 要注入的登录 Cookie（来自加密存储）
 */
async function openContext(ctx, headless, opts) {
  const executable = chromiumExecutablePath();
  if (!executable) {
    throw new Error(
      "未检测到 Playwright Chromium。请先运行: npx playwright install chromium（或在 GUI 中点击「安装 Chromium」）。"
    );
  }
  const tempDir = fs.mkdtempSync(path.join(sp.resolve("tmp"), "prof-"));
  logger.info(`使用 Chromium: ${executable} (headless=${headless})`);
  const context = await chromium.launchPersistentContext(tempDir, {
    headless,
    viewport: { width: 1366, height: 768 },
    locale: "zh-CN",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--disable-default-apps",
      "--no-default-browser-check",
      "--disable-sync",
    ],
  });

  const cookies = (opts && opts.cookies) || [];
  if (cookies.length) {
    const safe = sanitizeCookies(cookies);
    if (safe.length) {
      try {
        await context.addCookies(safe);
        logger.info(`已注入 ${safe.length} 个登录 Cookie（临时会话，退出即销毁）`);
      } catch (e) {
        logger.warn(`注入 Cookie 失败: ${e.message}`);
      }
    }
  }
  return { context, executable, headless, tempDir };
}

/**
 * 收敛 Cookie 字段，让 addCookies 能接受。
 *
 * 两个坑：
 *   1. 会话 Cookie 的 expires 是 -1，直接喂回去会被当成"已过期"而丢弃，
 *      因此只保留正数过期时间，其余按会话 Cookie 处理。
 *   2. domain 与 url 同时给会报错，有 domain 时就不带 url。
 */
function sanitizeCookies(cookies) {
  const out = [];
  for (const c of cookies || []) {
    if (!c || !c.name || c.value === undefined) continue;
    if (!c.domain && !c.url) continue;
    const o = { name: c.name, value: String(c.value), path: c.path || "/" };
    if (c.domain) o.domain = c.domain;
    else o.url = c.url;
    if (typeof c.expires === "number" && c.expires > 0) o.expires = c.expires;
    if (c.httpOnly !== undefined) o.httpOnly = !!c.httpOnly;
    if (c.secure !== undefined) o.secure = !!c.secure;
    if (c.sameSite === "Strict" || c.sameSite === "Lax" || c.sameSite === "None") {
      o.sameSite = c.sameSite;
    }
    out.push(o);
  }
  return out;
}

/** 关闭上下文并删除临时 profile（磁盘上不留会话痕迹） */
async function closeContext(handle) {
  if (!handle) return;
  try {
    await handle.context.close();
  } catch {}
  if (handle.tempDir) {
    try {
      fs.rmSync(handle.tempDir, { recursive: true, force: true });
    } catch (e) {
      logger.warn(`清理临时浏览器目录失败: ${e.message}`);
    }
  }
}

/**
 * 判断是否已登录：
 * 1. 存在认证 Cookie -> 已登录（最可靠，优先于 URL 判断）
 * 2. 页面 HTML 中出现积分数据特征 -> 已登录
 * 3. 页面停留在登录域且无上述特征 -> 未登录
 */
function checkLoggedIn(url, cookies, html) {
  // Cookie 是最可靠的依据，优先判断。
  // 注意：不能因为 URL 在 login.live.com 就直接判未登录 ——
  // 授权流程结束时页面常停留在 oauth20_desktop.srf，此时 Cookie 其实已有效。
  if (hasAuthCookies(cookies)) return true;
  if (html && (html.includes("pointsCounters") || html.includes('"balance"') || html.includes('"availablePoints"'))) return true;
  if (/login\.live\.com|account\.microsoft\.com/.test(url || "")) return false;
  return false;
}

/**
 * 无头模式打开 rewards.bing.com 刷新会话 Cookie 并快照到该账户 state
 * 如果未登录，返回 loggedIn=false
 */
async function syncCookies(ctx) {
  // 注入加密库里解出的 Cookie，这样本次访问才是「已登录」状态
  const handle = await openContext(ctx, true, { cookies: ctx.state.getCookies() });
  const { context } = handle;
  try {
    const pages = context.pages();
    const page = pages[0] || (await context.newPage());
    // 同样先过 bing.com 触发 SSO，再读 rewards 页
    for (const target of ["https://cn.bing.com/", "https://rewards.bing.com/earn"]) {
      try {
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(1500);
      } catch (e) {
        logger.warn(`打开 ${target} 失败: ${e.message}`);
      }
    }
    const url = page.url();
    let html = "";
    try {
      html = await page.content();
    } catch {}
    const cookies = await context.cookies();
    const loggedIn = checkLoggedIn(url, cookies, html);
    const prev = ctx.state.getCookies();

    if (loggedIn) {
      // 已登录：更新 Cookie
      ctx.state.setCookies(cookies);
    } else if (!hasAuthCookies(prev)) {
      // 未登录且之前也没有有效会话：记录当前（匿名）Cookie
      ctx.state.setCookies(cookies);
    } else {
      // 未登录但此前有有效会话：保留原 Cookie，避免瞬时跳转登录页破坏会话
      logger.warn("本次同步未检测到登录态，保留原有会话 Cookie 以免误覆盖。");
    }
    const hit = cookies.filter((c) => AUTH_COOKIE_NAMES.includes(c.name)).map((c) => c.name);
    logger.info(
      `已同步 ${cookies.length} 个 Cookie，命中认证票据: ${hit.length ? hit.join(", ") : "无"}，登录状态: ${loggedIn ? "已登录" : "未登录"}`
    );
    return { loggedIn, cookies, url };
  } finally {
    await closeContext(handle);
  }
}

/**
 * 交互式登录：弹出浏览器（该账户独立 profile），用户登录后自动捕获 OAuth code，
 * 并同步 rewards.bing.com 的 Cookie。
 * @returns {Promise<{code: string|null, loggedIn: boolean}>}
 */
async function loginInteractive(ctx) {
  // 登录是一次全新授权，不需要注入旧 Cookie
  const handle = await openContext(ctx, false);
  const { context } = handle;
  try {
    const pages = context.pages();
    const page = pages[0] || (await context.newPage());

    const authUrl =
      "https://login.live.com/oauth20_authorize.srf" +
      "?client_id=0000000040170455" +
      "&response_type=code" +
      "&scope=service::prod.rewardsplatform.microsoft.com::MBI_SSL" +
      "&redirect_uri=https://login.live.com/oauth20_desktop.srf";

    logger.info("正在打开浏览器，请在浏览器中完成登录（登录后将自动跳转授权）...");
    await page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => {
      logger.warn(`打开授权页失败: ${e.message}`);
    });

    // 轮询等待授权回调地址中的 code 参数（最多 5 分钟）
    let code = null;
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      const u = page.url();
      try {
        const pu = new URL(u);
        if (pu.hostname === "login.live.com" && pu.pathname.includes("oauth20_desktop")) {
          code = pu.searchParams.get("code");
          if (code) break;
        }
      } catch {}
      // 用户可能直接关闭了浏览器
      if (context.pages().length === 0) break;
      await page.waitForTimeout(600);
    }

    if (!code) {
      logger.warn("未在浏览器中捕获到授权码（可能超时或未完成登录）。");
      return { code: null, loggedIn: false };
    }

    // 登录成功后，依次访问 bing.com 与 rewards.bing.com 完成 SSO 并同步 Cookie。
    // 必须先过一次 bing.com：授权页所在的 login.live.com 域拿不到 bing 的 _U 票据，
    // 只有实际访问过 bing 才会通过 SSO 下发，否则会一直显示「Cookie 待同步」。
    for (const target of ["https://cn.bing.com/", "https://rewards.bing.com/earn"]) {
      try {
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(2500);
      } catch (e) {
        logger.warn(`访问 ${target} 失败: ${e.message}`);
      }
    }
    const url = page.url();
    let html = "";
    try {
      html = await page.content();
    } catch {}
    const cookies = await context.cookies();
    ctx.state.setCookies(cookies);
    const loggedIn = checkLoggedIn(url, cookies, html);
    const hit = cookies.filter((c) => AUTH_COOKIE_NAMES.includes(c.name)).map((c) => c.name);
    logger.info(
      `已同步 ${cookies.length} 个 Cookie，命中认证票据: ${hit.length ? hit.join(", ") : "无"}，登录状态: ${loggedIn ? "已登录" : "未登录"}`
    );
    return { code, loggedIn };
  } finally {
    await closeContext(handle);
  }
}

/**
 * 清理浏览器 HTTP 缓存。
 *
 * 改成「每次新建临时 profile」之后本函数已无意义 —— 临时目录每次都是干净的，
 * 不存在可累积的缓存。保留空实现是为了兼容 runner.js 的调用，避免到处改。
 */
async function clearBrowserCache(ctx) {
  return true;
}

module.exports = {
  ROOT,
  AUTH_COOKIE_NAMES,
  hasAuthCookies,
  chromiumExecutablePath,
  isChromiumReady,
  clearBrowserCache,
  openContext,
  closeContext,
  sanitizeCookies,
  syncCookies,
  loginInteractive,
  checkLoggedIn,
};
