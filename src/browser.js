const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");
const logger = require("./logger");
const sp = require("./storage-path");
const stealth = require("./stealth");
const globalConfig = require("./global-config");
const fpBrowser = require("./fingerprint-browser");

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
 *
 * Docker 场景：镜像内没有 Playwright 下载的 Chromium（官方 CDN 在国内常不可用），
 * 改为 apt 安装系统 Chromium，用 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 指过来。
 * 桌面版不设该变量，行为与以前完全一致。
 */
function chromiumExecutablePath() {
  const override = (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "").trim();
  if (override && fs.existsSync(override)) return override;
  try {
    const p = chromium.executablePath();
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** Playwright 自带 Chromium 的路径（不含环境变量覆盖），供来源优先级排序用 */
function bundledChromiumPath() {
  try {
    const p = chromium.executablePath();
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** 读取浏览器指纹配置：优先账户有效配置，取不到再退回全局设置 */
function fingerprintCfg(ctx) {
  let b = null;
  try {
    if (ctx && ctx.config && typeof ctx.config.get === "function") b = ctx.config.get().browser;
  } catch {}
  if (!b || typeof b !== "object") {
    try {
      b = globalConfig.get().browser;
    } catch {}
  }
  const fp = (b && b.fingerprint) || {};
  return {
    enable: fp.enable === true,
    seed: Number(fp.seed) || 0,
    brand: typeof fp.brand === "string" && fp.brand ? fp.brand : "Chrome",
    hardwareConcurrency: Number(fp.hardwareConcurrency) || 0,
  };
}

/**
 * 决定本次用哪个浏览器。
 *
 * 优先级：
 *   1. PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH —— 运维显式指定的永远最高（Docker / 调试）
 *   2. 指纹浏览器 —— 设置里启用且已安装（src/fingerprint-browser.js）
 *   3. Playwright 自带 Chromium —— 默认行为
 *
 * 指纹浏览器没装好时是**静默回落**而不是报错：它是可选增强，不该因为没下载
 * 就把登录流程整个打断。
 *
 * @param {object} [ctx] 账户上下文（用于读配置与派生种子）
 * @returns {{kind: "override"|"fingerprint"|"chromium", executable: string|null, cfg?: object}}
 */
function resolveBrowserSource(ctx) {
  const override = (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "").trim();
  if (override && fs.existsSync(override)) return { kind: "override", executable: override };

  const cfg = fingerprintCfg(ctx);
  if (cfg.enable) {
    const exe = fpBrowser.executablePath();
    if (exe) return { kind: "fingerprint", executable: exe, cfg };
    logger.warn("已启用指纹浏览器但尚未安装，本轮回落到普通 Chromium（可在设置页下载）");
  }
  return { kind: "chromium", executable: bundledChromiumPath(), cfg };
}

/** 额外的 Chromium 启动参数（逗号分隔，Docker 下需要 --no-sandbox） */
function extraChromiumArgs() {
  return (process.env.MS_REWARDS_CHROMIUM_ARGS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
  const source = resolveBrowserSource(ctx);
  const executable = source.executable;
  if (!executable) {
    throw new Error(
      "未检测到可用的浏览器。请先运行: npx playwright install chromium（或在 GUI 中点击「安装 Chromium」）。"
    );
  }
  const isFp = source.kind === "fingerprint";
  // 指纹模式下算一次种子：配置里没指定就按账户 ID 派生，保证同账号长期稳定
  const fpSeed = isFp
    ? (source.cfg && source.cfg.seed) || fpBrowser.seedFor((ctx && ctx.id) || "")
    : 0;
  // storage/tmp 可能还不存在（全新安装 / 容器首次运行），mkdtemp 不会自动建父目录
  const tmpRoot = sp.resolve("tmp");
  if (!fs.existsSync(tmpRoot)) fs.mkdirSync(tmpRoot, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(tmpRoot, "prof-"));
  logger.info(
    `使用 ${isFp ? "指纹浏览器" : "Chromium"}: ${executable} (headless=${headless}${isFp ? `, seed=${fpSeed}` : ""})`
  );

  const launchOpts = {
    headless,
    viewport: { width: 1366, height: 768 },
    locale: "zh-CN",
    args: [
      "--disable-blink-features=AutomationControlled",
      ...stealth.EXTRA_ARGS,
      "--no-first-run",
      "--disable-default-apps",
      "--no-default-browser-check",
      "--disable-sync",
      ...extraChromiumArgs(),
    ],
  };
  if (isFp) {
    // 指纹浏览器：由种子统一生成 UA / userAgentData / Client Hints / 插件 / CPU / 内存
    launchOpts.args.push(
      ...fpBrowser.buildArgs({
        seed: fpSeed,
        brand: source.cfg ? source.cfg.brand : "Chrome",
        hardwareConcurrency: source.cfg ? source.cfg.hardwareConcurrency : 0,
      })
    );
    // ⚠️ 刻意不设 userAgent。
    // 实测证明 sec-ch-ua 请求头改不动（setExtraHTTPHeaders / page.route 都无效），
    // 它是浏览器如实生成的。若这里再硬改 UA，就会回到「UA 自称 X、CH 说 Y」的
    // 自相矛盾状态 —— 那正是引入指纹浏览器要解决的问题。
  } else {
    // headless Chromium 默认 UA 带 "HeadlessChrome" 字样，是最直白的自曝；
    // 统一改成与 HTTP 请求一致的桌面 Edge UA
    launchOpts.userAgent = stealth.STEALTH_USER_AGENT;
  }
  // 显式指定可执行文件：
  //   - 环境变量指了外部 Chromium（Docker/apt 场景）→ 用它
  //   - 否则用 Playwright 自带的（桌面版默认行为）
  // 注意不能依赖 playwright 自己解析环境变量，它不认 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  launchOpts.executablePath = executable;

  const context = await chromium.launchPersistentContext(tempDir, launchOpts);

  // 在所有页面脚本之前注入去自动化补丁（抹掉 webdriver / 补全 chrome 对象与插件等指纹）
  try {
    // 指纹模式下置位 __MSR_FP：stealth.js 会据此让出 languages / plugins / CPU 核数等
    // 它由种子生成的维度，避免两套补丁叠加出矛盾指纹
    const initSrc = isFp ? "window.__MSR_FP = true;\n" + stealth.STEALTH_INIT : stealth.STEALTH_INIT;
    await context.addInitScript({ content: initSrc });
    // 指纹模式下也不盖 accept-language：--accept-lang 已经由上游统一处理
    if (!isFp) await context.setExtraHTTPHeaders(stealth.EXTRA_HTTP_HEADERS);
  } catch (e) {
    logger.warn(`注入去自动化补丁失败（不影响主流程）: ${e.message}`);
  }

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
    // 登录完成后导航到完成页，noVNC 里会显示大字提示用户返回控制台。
    // 只有 Web/Docker 模式（src/server.js listen 成功后才设 MS_REWARDS_HTTP_LISTENING）
    // 才需要这一步；桌面版不启 server，跳了反而触发 ECONNREFUSED 噪声 warn。
    if (loggedIn && process.env.MS_REWARDS_HTTP_LISTENING) {
      const port = process.env.MS_REWARDS_PORT || "25560";
      try {
        await page.goto(`http://localhost:${port}/login-done`, { waitUntil: "domcontentloaded", timeout: 10000 });
      } catch (e) {
        logger.warn(`导航到登录完成页失败: ${e.message}`);
      }
    }
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
  bundledChromiumPath,
  fingerprintCfg,
  resolveBrowserSource,
  extraChromiumArgs,
  isChromiumReady,
  clearBrowserCache,
  openContext,
  closeContext,
  sanitizeCookies,
  syncCookies,
  loginInteractive,
  checkLoggedIn,
};
