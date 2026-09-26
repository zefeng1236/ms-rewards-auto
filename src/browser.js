const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");
const logger = require("./logger");
const sp = require("./storage-path");
const stealth = require("./stealth");
const globalConfig = require("./global-config");
const fpBrowser = require("./fingerprint-browser");
const cancel = require("./cancel");

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

// Bing 侧（bing.com 域下发）的认证票据。注意与 login.live.com 的 MSA 票据区分：
// ESTSAUTH / WLSSC / KievRPSSecAuth 等只能证明「微软账号在线」，
// 不代表 bing.com 已登录 —— 正是漏掉这一层区分，导致部分用户同步后
// Bing 首页仍显示「登录」、积分页被重定向到登录页（2026-09 用户反馈）。
const BING_AUTH_COOKIE_NAMES = ["_U", ".MSA.Auth", "_C_Auth", "_M"];

function hasAuthCookies(cookies) {
  return (
    Array.isArray(cookies) &&
    cookies.some((c) => AUTH_COOKIE_NAMES.includes(c.name) && String(c.value || "").length > 0)
  );
}

/** 是否拿到了 Bing 侧（bing.com 域）的认证票据 */
function hasBingAuthCookies(cookies) {
  return (
    Array.isArray(cookies) &&
    cookies.some((c) => BING_AUTH_COOKIE_NAMES.includes(c.name) && String(c.value || "").length > 0)
  );
}

/**
 * 运维显式指定的 Chromium（最高优先级）。
 *
 * ⚠️ 一旦设了它，指纹浏览器就**永远不会被选中**。Docker 镜像早期版本正是这么配的
 * （直接把容器里的 apt Chromium 钉死），导致指纹浏览器下载完也用不上。
 * 容器场景请改用 MS_REWARDS_CHROMIUM_FALLBACK —— 那个只在指纹浏览器不可用时兜底。
 */
function overrideChromiumPath() {
  const p = (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "").trim();
  return p && fs.existsSync(p) ? p : null;
}

/**
 * 兜底 Chromium（**指纹浏览器不可用时**才用）。
 *
 * 为什么需要这个中间档：Docker 镜像用 apt 装了系统 Chromium，又用
 * `npm ci --ignore-scripts` 跳过了 playwright 的浏览器下载（镜像里根本没有
 * Playwright 自带 Chromium）。若直接去掉 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH，
 * 未启用指纹浏览器时就会落到「一个可执行文件都找不到」。
 *
 * 桌面版不设这个变量，行为完全不变。
 */
function fallbackChromiumPath() {
  const p = (process.env.MS_REWARDS_CHROMIUM_FALLBACK || "").trim();
  return p && fs.existsSync(p) ? p : null;
}

/** 当前可用的 Chromium：运维指定 > 系统兜底 > Playwright 自带 */
function chromiumExecutablePath() {
  return overrideChromiumPath() || fallbackChromiumPath() || bundledChromiumPath();
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
    // 声明给网站的「操作系统」：默认 windows。为什么不是跟 process.platform：
    // Docker 容器里 process.platform 恒为 linux，若照实声明，UA/navigator.platform
    // 会报 Linux，而本项目 HTTP 层 UA（rewards.UA_PC）声明的是 Windows NT ——
    // 登录设备列表里就显示成「Linux」这台一眼假的设备。统一声明 windows，
    // 让指纹源码层与 HTTP 层对齐，观感是「一台正常的 Windows 桌面浏览器」。
    platform:
      typeof fp.platform === "string" && fp.platform ? fp.platform.toLowerCase() : "windows",
  };
}

/**
 * 决定本次用哪个浏览器。
 *
 * 优先级：
 *   1. PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH —— 运维强指定（调试用；设了就再不会用指纹浏览器）
 *   2. 指纹浏览器 —— 设置里启用且已安装（src/fingerprint-browser.js）
 *   3. MS_REWARDS_CHROMIUM_FALLBACK —— 系统兜底（Docker 的 apt Chromium；仅在上一步不可用时）
 *   4. Playwright 自带 Chromium —— 桌面版默认行为
 *
 * 指纹浏览器没装好时是**静默回落**而不是报错：它是可选增强，不该因为没下载
 * 就把登录流程整个打断。
 *
 * @param {object} [ctx] 账户上下文（用于读配置与派生种子）
 * @returns {{kind: "override"|"fingerprint"|"chromium", executable: string|null, cfg?: object}}
 */
function resolveBrowserSource(ctx) {
  const override = overrideChromiumPath();
  if (override) return { kind: "override", executable: override };

  const cfg = fingerprintCfg(ctx);
  // 镜像内置（Docker）：指纹浏览器是容器里**唯一**的浏览器（apt Chromium 已移除、
  // Playwright 自带 Chromium 也没下），所以预装存在时强制启用 —— 否则配置里
  // enable=false（默认值）会一路走到「未检测到可用的浏览器」直接把任务打断。
  const forced = !!fpBrowser.preinstalledDir();
  if (forced || cfg.enable) {
    const exe = fpBrowser.executablePath();
    if (exe) return { kind: "fingerprint", executable: exe, cfg: { ...cfg, enable: true } };
    logger.warn(
      forced
        ? "镜像内置指纹浏览器不可用（预装目录损坏？），且容器内没有其他浏览器"
        : "已启用指纹浏览器但不可用（未安装或主程序损坏），本轮回落到普通 Chromium（可在设置页重新下载）"
    );
  }
  // 系统兜底（Docker 曾用 apt Chromium）：必须排在指纹浏览器之后，
  // 否则容器里指纹浏览器下载完也永远轮不到它。
  const fb = fallbackChromiumPath();
  if (fb) return { kind: "chromium", executable: fb, cfg };
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
  // Docker 式纯指纹浏览器场景：镜像里没有 apt chromium / Playwright 自带 Chromium，
  // 只有预装的指纹浏览器。此时只有指纹浏览器可用，它也是唯一浏览器，返回 true。
  if (fpBrowser.isReady()) return true;
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

  // 视口策略分两档（踩过坑的地方）：
  //   headless  → 固定 1366x768，任务流程依赖稳定的窗口尺寸。
  //   headful   → 不限制视口 + 窗口最大化，跟随虚拟桌面大小。
  // 以前 headful 也写死 1366x768，而容器虚拟桌面只有 1280x800，窗口两个维度
  // 都超出桌面 —— noVNC 里只看得到中间一小块，MS登录页的按钮落在视口外，
  // 表现为「输入了密码但点登录没反应」（其实是按钮根本点不到）。
  const launchOpts = {
    headless,
    // 信任自签证书：Docker 下 /login-done 及后续 https 回跳走的是 entrypoint 生成的
    // 自签 TLS（10 年期，SAN 只覆盖 localhost），不忽略会报 ERR_CERT_AUTHORITY_INVALID。
    // 桌面版不在本机起 TLS，此开关无副作用。
    ignoreHTTPSErrors: true,
    viewport: headless ? { width: 1366, height: 768 } : null,
    locale: "zh-CN",
    args: [
      "--disable-blink-features=AutomationControlled",
      ...stealth.EXTRA_ARGS,
      "--no-first-run",
      "--disable-default-apps",
      "--no-default-browser-check",
      "--disable-sync",
      ...extraChromiumArgs(),
      // 有头模式（noVNC 手动登录）：窗口撑满虚拟桌面
      ...(headless ? [] : ["--start-maximized"]),
    ],
  };
  if (isFp) {
    // GPU 进程在容器里起不来时 WebGL 会整个不可用（GL_VENDOR = Disabled /
    // BindToCurrentSequence failed），而"桌面浏览器没有 WebGL"是最顶级的机器人特征：
    // bot.sannysoft.com 会直接把 WebGL Vendor / Renderer 两项判红，指纹浏览器也因此
    // 没机会伪造 GPU。实测补上 --disable-gpu-sandbox 后 GPU 进程正常启动，WebGL 恢复，
    // 并如实上报种子生成的 Windows GPU（ANGLE (Intel, Intel(R) Arc(TM) ... D3D11)）。
    if (process.platform === "linux" && !launchOpts.args.includes("--disable-gpu-sandbox")) {
      launchOpts.args.push("--disable-gpu-sandbox");
    }
    // --disable-gpu 与上面正好相反：它会让 WebGL 永久不可用。容器镜像历史上带过这个
    // 参数，用户自改 MS_REWARDS_CHROMIUM_ARGS 时也可能带上，所以显式提醒一句。
    if (launchOpts.args.includes("--disable-gpu")) {
      logger.warn("启动参数含 --disable-gpu：WebGL 将被禁用（bot 检测会判失败），建议移除");
    }
    // 指纹浏览器：由种子统一生成 UA / userAgentData / Client Hints / 插件 / CPU / 内存
    launchOpts.args.push(
      ...fpBrowser.buildArgs({
        seed: fpSeed,
        brand: source.cfg ? source.cfg.brand : "Chrome",
        platform: source.cfg ? source.cfg.platform : "windows",
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

  // 去自动化补丁：**只在普通 Chromium 回落路径注入；指纹浏览器模式一次都不注入**。
  //
  // 为什么指纹模式要"少即是多"（2026-09-26 在容器内实测，fingerprint-chromium 148）：
  //   · navigator.webdriver 原生就是 false，且 getter 是 `function get webdriver()
  //     { [native code] }` —— 我们原来的 getter 打成箭头函数，toString 后是
  //     `() => false`，等于主动告诉检测方"这里被改过"；
  //   · plugins / languages / platform / hardwareConcurrency / WebGL 全由 --fingerprint
  //     种子统一生成且互相自洽，我们再盖一层只会造出互相矛盾的指纹；
  //   · 最关键：Playwright 的 addInitScript 底层是 CDP 的
  //     Page.addScriptToEvaluateOnNewDocument，**只要调用一次就会被 BrowserScan 的
  //     Navigator 项识破** —— 对照实验里注入一句 `/* noop */` 注释，verdict 就从
  //     Normal 掉到 Robot（WebDriver / User-Agent / CDP 三项仍然全过）。
  //
  // 结论：指纹浏览器已经做对了每一件事，补丁只在它缺席（回落普通 Chromium）时才有价值。
  try {
    if (!isFp) {
      await context.addInitScript({ content: stealth.STEALTH_INIT });
      await context.setExtraHTTPHeaders(stealth.EXTRA_HTTP_HEADERS);
    }
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
 * 1. 存在 Bing 侧认证 Cookie（_U 等，bing.com 域下发）-> 已登录（最可靠，优先判断）
 * 2. 页面 HTML 中出现积分数据特征 -> 已登录
 * 3. 仅存在 login.live.com 的 MSA 票据（ESTSAUTH/WLSSC 等）-> 不算已登录：
 *    那只说明微软账号在线，bing.com 本身仍可能显示「登录」。
 *    调用方（syncCookies / waitForRewardsSession）会据此走静默 SSO 补票。
 */
function checkLoggedIn(url, cookies, html) {
  if (hasBingAuthCookies(cookies)) return true;
  if (html && (html.includes("pointsCounters") || html.includes('"balance"') || html.includes('"availablePoints"'))) return true;
  return false;
}

/**
 * 静默 SSO：MSA 在线（login.live.com 有票据）但 Bing 侧没有 _U 时，
 * 走一次 Bing 的登录入口 fd/auth/signin —— 它会跳到 login.live.com 的
 * OAuth 授权页，MSA 会话有效时全程静默，回跳后由 bing 下发 _U 票据。
 * （实测仅访问 bing 首页不会触发这条 SSO，这是「部分用户 Bing 不自动登录」的根因。）
 * @returns {Promise<{cookies: object[], url: string, html: string, ssoDone: boolean}>}
 */
async function ensureBingSSO(page, context) {
  const ssoUrl =
    "https://www.bing.com/fd/auth/signin" +
    "?action=interactive&provider=windows_live_id" +
    "&return_url=" + encodeURIComponent("https://www.bing.com/");
  const out = { cookies: [], url: "", html: "", ssoDone: false };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(ssoUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
      await page.waitForTimeout(4500);
    } catch (e) {
      logger.warn(`Bing 静默 SSO 跳转失败: ${e.message}`);
    }
    const url = page.url();
    let html = "";
    try {
      html = await page.content();
    } catch {}
    const cookies = await context.cookies();
    out.cookies = cookies;
    out.url = url;
    out.html = html;
    out.ssoDone = true;
    // 登录页仍要求输入账号 = MSA 会话已失效，重试也不会有结果
    if (hasBingAuthCookies(cookies) || /login\.live\.com\/.*oauth20_login/i.test(url)) break;
  }
  return out;
}

/**
 * 点按钮兜底：Bing 首页点击「登录」按钮，并自动走完微软确认流程。
 *
 * 这是静默 SSO 之后的更「强」兜底：静默授权在部分账号会卡在「选择账户 /
 * 隐私政策确认 / 需要点『是』继续」等中间态，此时像真人一样点一下 Bing
 * 右上角登录按钮，进入 login.live.com 后自动点确认、选择已登录账户，
 * 从而真正把 _U 票据补上。
 *
 * 按钮标识采用微软账号登录页多年不变的稳定 ID：
 *   - Bing 首页登录入口：#id_l（或 aria-label 含「登录」）
 *   - 确认/下一步主按钮：#idSIButton9
 *   - 已登录账户瓦片：#tilesHolder .tile（另有 .tile-container 兜底）
 *
 * @returns {Promise<{cookies: object[], url: string, html: string, done: boolean}>}
 */
async function ensureBingLoginByClick(page, context) {
  const out = { cookies: [], url: "", html: "", done: false };
  try {
    await page.goto("https://www.bing.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2500);
  } catch (e) {
    logger.warn(`点按钮兜底：打开 Bing 首页失败: ${e.message}`);
    return out;
  }

  // 点登录入口（Bing 首页右上角）
  let clicked = false;
  for (const sel of ["#id_l", 'a[aria-label="登录"]', "#id_a", "a#id_l"]) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        await el.click({ timeout: 5000 }).catch(() => el.click({ force: true, timeout: 5000 }).catch(() => {}));
        clicked = true;
        logger.info(`点按钮兜底：已点击 Bing 登录入口（${sel}）`);
        break;
      }
    } catch {}
  }
  if (!clicked) {
    logger.warn("点按钮兜底：未找到 Bing 登录按钮，跳过。");
    return out;
  }

  // 等待弹窗/跳转到 login.live.com，并循环处理确认页 / 账户选择（最多 ~30s）
  const deadline = Date.now() + 30 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2500);
    const url = page.url();
    const cookies = await context.cookies();
    // 补上票就收工
    if (hasBingAuthCookies(cookies)) {
      out.cookies = cookies;
      out.url = url;
      out.html = await page.content().catch(() => "");
      out.done = true;
      break;
    }
    if (/login\.live\.com|login\.microsoftonline\.com|account\.microsoft\.com/.test(url) || /login\.live\.com/.test(url)) {
      // 若停在 login.live.com，尝试点确认主按钮（「是 / 下一步 / 登录」）
      const confirmed = await clickFirst(page, [
        "#idSIButton9",
        'input[type="submit"]#idSIButton9',
        "button[type=submit]",
      ]);
      if (confirmed) continue;
      // 账户选择：点第一个已登录账户瓦片
      const tile = await clickFirst(page, [
        "#tilesHolder .tile",
        ".tile-container .tile",
        "[data-testid='tile']",
      ]);
      if (tile) continue;
    }
    // 弹窗可能关掉回到 bing，再点一次登录入口
    if (/bing\.com/.test(url) && !hasBingAuthCookies(cookies)) {
      for (const sel of ["#id_l", 'a[aria-label="登录"]', "#id_a"]) {
        try {
          const el = page.locator(sel).first();
          if (await el.count() > 0 && await el.isVisible({ timeout: 1500 }).catch(() => false)) {
            await el.click({ timeout: 4000 }).catch(() => {});
            break;
          }
        } catch {}
      }
    }
  }
  if (!out.done) {
    try { out.cookies = await context.cookies(); out.url = page.url(); out.html = await page.content(); } catch {}
  }
  return out;
}

/** 依次尝试多个选择器，点中第一个可见元素；返回是否点到了 */
async function clickFirst(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        await el.click({ timeout: 4000 }).catch(() => el.click({ force: true, timeout: 4000 }).catch(() => {}));
        return true;
      }
    } catch {}
  }
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
    // 先过 bing.com 触发 SSO，再读 rewards 页。
    // cn / www 都要过：_U 票据可能只落在其中一个域上。
    for (const target of ["https://cn.bing.com/", "https://www.bing.com/", "https://rewards.bing.com/earn"]) {
      try {
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(3000);
      } catch (e) {
        logger.warn(`打开 ${target} 失败: ${e.message}`);
      }
    }
    const url = page.url();
    let html = "";
    try {
      html = await page.content();
    } catch {}
    let cookies = await context.cookies();
    let loggedIn = checkLoggedIn(url, cookies, html);

    // MSA 在线但 Bing 侧没有 _U：仅访问首页不会触发 SSO，显式补一次静默登录。
    // 这是「部分用户 Bing 不会自动登录」的修复点 —— 以前会误判成已登录并原样存回。
    if (!hasBingAuthCookies(cookies) && hasAuthCookies(cookies)) {
      logger.info("微软账号在线但 Bing 侧缺少登录票据，尝试静默 SSO 补登 Bing…");
      const sso = await ensureBingSSO(page, context);
      if (sso.ssoDone) {
        // 补票后再回一次 rewards 页，让 rewards 会话也吃 Bing 登录态
        try {
          await page.goto("https://rewards.bing.com/earn", { waitUntil: "domcontentloaded", timeout: 60000 });
          await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(3000);
        } catch {}
        cookies = await context.cookies();
        let html2 = "";
        try {
          html2 = await page.content();
        } catch {}
        loggedIn = checkLoggedIn(page.url(), cookies, html2);
        if (sso.cookies.some((c) => BING_AUTH_COOKIE_NAMES.includes(c.name))) {
          logger.info("Bing 静默 SSO 成功，已补齐登录票据。");
        } else if (!hasBingAuthCookies(cookies)) {
          // 静默 SSO 没补上（可能卡在账户选择/隐私确认/需点「是」），
          // 再像真人一样去 Bing 首页点「登录」按钮并自动确认。
          logger.warn("静默 SSO 未补齐票据，回退到模拟点登录按钮…");
          const byClick = await ensureBingLoginByClick(page, context);
          if (byClick.done) {
            try {
              await page.goto("https://rewards.bing.com/earn", { waitUntil: "domcontentloaded", timeout: 60000 });
              await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
              await page.waitForTimeout(3000);
            } catch {}
            cookies = await context.cookies();
            let html3 = "";
            try { html3 = await page.content(); } catch {}
            loggedIn = checkLoggedIn(page.url(), cookies, html3);
          }
          if (hasBingAuthCookies(cookies)) {
            logger.info("点登录按钮兜底成功，已补齐 Bing 登录票据。");
          } else {
            logger.warn("点登录按钮兜底仍未拿到票据（MSA 会话可能已失效），如持续出现请重新授权登录。");
          }
        }
      }
    }

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
async function waitForRewardsSession(page, context) {
  const targets = ["https://cn.bing.com/", "https://www.bing.com/", "https://rewards.bing.com/earn"];
  const deadline = Date.now() + 90 * 1000;
  let last = { loggedIn: false, cookies: [], url: page.url(), html: "" };
  let ssoTried = false;
  while (Date.now() < deadline) {
    // 响应「停止任务」：授权完成后抓会话也是个长等待，用户点停止必须能中断
    try {
      cancel.throwIfAborted();
    } catch (e) {
      if (e && e.isAbort) throw e;
      throw e;
    }
    for (const target of targets) {
      try {
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
        await page.waitForTimeout(4500);
      } catch (e) {
        logger.warn(`访问 ${target} 失败: ${e.message}`);
      }
      const url = page.url();
      let html = "";
      try {
        html = await page.content();
      } catch {}
      const cookies = await context.cookies();
      const loggedIn = checkLoggedIn(url, cookies, html);
      last = { loggedIn, cookies, url, html };
      if (loggedIn) return last;
    }
    // 授权刚完成时通常只有 MSA 票据；仅访问 bing 首页不会触发 SSO，
    // 必须显式走一次 fd/auth/signin 才能拿到 bing 的 _U（否则部分用户
    // 登录完成后 Bing 仍是「登录」状态，搜索不计分）。
    if (!ssoTried && !hasBingAuthCookies(last.cookies) && hasAuthCookies(last.cookies)) {
      ssoTried = true;
      logger.info("微软账号已授权，正在静默 SSO 补登 Bing…");
      const sso = await ensureBingSSO(page, context);
      const loggedIn = checkLoggedIn(sso.url, sso.cookies, sso.html);
      last = { loggedIn, cookies: sso.cookies, url: sso.url, html: sso.html };
      if (loggedIn) return last;

      // 静默 SSO 没成，回退到模拟点登录按钮 + 自动确认隐私政策/账户
      if (!hasBingAuthCookies(sso.cookies)) {
        logger.info("静默 SSO 未成，回退到模拟点 Bing 登录按钮…");
        const byClick = await ensureBingLoginByClick(page, context);
        const loggedIn2 = checkLoggedIn(byClick.url, byClick.cookies, byClick.html);
        last = { loggedIn: loggedIn2, cookies: byClick.cookies, url: byClick.url, html: byClick.html };
        if (loggedIn2) return last;
      }
    }
    logger.info("尚未抓齐 Bing / Rewards 登录信息，等待用户确认隐私政策或页面继续跳转…");
  }
  return last;
}

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
      // 响应「停止任务」：登录是长等待（最长 5 分钟），用户点停止必须立刻中断，
      // 否则 WebUI 上点终止毫无反应、要干等轮询超时。
      try {
        cancel.throwIfAborted();
      } catch (e) {
        if (e && e.isAbort) {
          logger.warn("登录已被手动停止");
          throw e;
        }
        throw e;
      }
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
    // Microsoft 偶尔会在这里弹隐私政策更新确认，用户点「是」之后才会继续下发必要票据；
    // 因此关闭浏览器前必须确认认证 Cookie / Rewards 页面特征已抓到，没抓齐就继续等一会儿。
    const session = await waitForRewardsSession(page, context);
    const { url, cookies, html, loggedIn } = session;
    ctx.state.setCookies(cookies);
    const hit = cookies.filter((c) => AUTH_COOKIE_NAMES.includes(c.name)).map((c) => c.name);
    logger.info(
      `已同步 ${cookies.length} 个 Cookie，命中认证票据: ${hit.length ? hit.join(", ") : "无"}，登录状态: ${loggedIn ? "已登录" : "未登录"}`
    );
    // 登录完成后导航到完成页，noVNC 里会显示大字提示用户返回控制台。
    // 只有 Web/Docker 模式（src/server.js listen 成功后才设 MS_REWARDS_HTTP_LISTENING）
    // 才需要这一步；桌面版不启 server，跳了反而触发 ECONNREFUSED 噪声 warn。
    if (loggedIn && process.env.MS_REWARDS_HTTP_LISTENING) {
      const port = process.env.MS_REWARDS_PORT || "25560";
      // 协议必须跟 server 实际监听的一致：TLS 打开时只有 https 能通（http 会被
      // 302 跳 https），关闭时只有 http 能通。所以先按 TLS 环境变量选主协议，
      // 失败再试另一种兜底 —— 这样无论用户有没有配证书都不会再刷证书/连接错误。
      // 上下文已 ignoreHTTPSErrors: true（见 openContext），自签证书不再触发
      // net::ERR_CERT_AUTHORITY_INVALID。
      const primary = process.env.MS_REWARDS_TLS_CERT ? "https" : "http";
      const fallback = primary === "https" ? "http" : "https";
      let navigated = false;
      let lastErr = null;
      for (const scheme of [primary, fallback]) {
        try {
          await page.goto(`${scheme}://localhost:${port}/login-done`, {
            waitUntil: "domcontentloaded",
            timeout: 8000,
          });
          navigated = true;
          break;
        } catch (e) {
          if (e && e.isAbort) throw e;
          lastErr = e;
        }
      }
      if (!navigated) logger.warn(`导航到登录完成页失败: ${lastErr ? lastErr.message : "未知原因"}`);
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
  BING_AUTH_COOKIE_NAMES,
  hasAuthCookies,
  hasBingAuthCookies,
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
  ensureBingSSO,
  ensureBingLoginByClick,
};
