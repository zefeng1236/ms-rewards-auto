/**
 * 微软 Rewards 桌面应用驱动模块（外部进程）
 *
 * 【为什么需要这个模块】
 * Rewards 有一类活动（「桌面奖励应用每周专属任务」、万圣节/月度 punchcard、
 * Duolingo 联名活动等）标着「必须在本应用内完成」，用软件自带的 Chromium 去做
 * **一律不计分**。2026-10-31 实测定位到根因：
 *
 *   程序化导航（`open_in_app` 调用 / `page.goto` / 纯 HTTP 复刻）会被 Bing
 *   附加 `dmreload=1` 参数，Rewards 据此判定「非用户主动访问」，不给活动归因；
 *   而应用内对卡片 <a> 做**真实点击**触发的导航不带该参数，10~20 秒内即计入。
 *
 *   同一批 URL、只换触发方式：invoke 传参 → 不计；真实点击 → 计入。
 *   ⇒ 判定看的是「谁的点击」，不是「访问了什么」。
 *
 * 所以这里不能用项目里那套浏览器，只能驱动微软自己的桌面应用（MSIX + Tauri +
 * WebView2）。驱动方式是给它开 DevTools 协议端口，用 CDP 接管。
 *
 * 【为什么由我们启动它，而不是让用户手动开端口】
 * 端口靠环境变量 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 开启，而该变量只能在
 * 进程创建时注入。实测 `spawn(exe, [], { env })` 可以直接拉起 MSIX 应用并成功
 * 继承变量（2 秒内端口就绪），所以本模块自己启动/接管/断开，不写注册表，
 * 也不要求用户做任何手工配置。端口只在被我们拉起的那个实例上存在。
 *
 * ⚠️ 铁律：清理/点击只能走真实点击。任何「直接导航到任务 URL」的写法都会带上
 * `dmreload=1`，看起来一切正常但永远不计分——这是本项目踩过的最贵的坑。
 */

const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");
const logger = require("./logger");
const sp = require("./storage-path");

/**
 * 当天「点了但没到账」的项（按活动归因码 form 记）。
 *
 * 为什么需要：有些任务本身带冷却期，不是点一次就完成。例如 Duolingo 的
 * 「继续搜索」——「14 天中有 5 天使用 Bing 搜索，每次搜索必须间隔至少 24 小时」，
 * 进度 2/5 时今天这次已经算过，再点不会增加。但它在列表里始终显示「可做」，
 * 不加这一层就会每轮都先试它，白跑两分钟还触发一次应用重启。
 *
 * 只记当天，第二天自动失效（冷却过了就该再试）。
 */
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function skipFilePath() {
  try {
    return sp.resolve("desktop-app-skip.json");
  } catch {
    return "";
  }
}

function loadSkipToday() {
  const f = skipFilePath();
  if (!f) return new Set();
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (j && j.date === localToday() && Array.isArray(j.forms)) return new Set(j.forms);
  } catch {}
  return new Set();
}

function addSkipToday(forms) {
  const arr = (forms || []).filter(Boolean);
  if (!arr.length) return;
  const f = skipFilePath();
  if (!f) return;
  const cur = loadSkipToday();
  for (const x of arr) cur.add(x);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ date: localToday(), forms: [...cur] }, null, 2));
  } catch {}
}

// ===== 常量（selfcheck 会对这些做断言，改动需同步守卫）=====
const CDP_PORT = 9333;
const PACKAGE_NAME = "Microsoft.24183918CCDA"; // 包名不含 "Rewards"，别用 *Rewards* 去查
const EXE_NAME = "microsoft-rewards-desktop.exe";
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;
const BROWSER_ARG = `--remote-debugging-port=${CDP_PORT}`;
const EARN_URL = "https://rewards.bing.com/earn";

// RSC 页面渲染慢：实测 <10s 时卡片列表还没出来，会误判成「今天没有可做项」。
// 18s 是留够余量的值，别为了跑得快往下调。
const RENDER_WAIT_MS = 18000;
// 点击后到服务端记账的观察窗口（实测 10~20s，这里取 4s + 复查时页面自身等待）
const VERIFY_WAIT_MS = 4000;
const START_TIMEOUT_MS = 30000;

/**
 * 单轮最多做几项。
 *
 * 「一轮做完」的代价是每项都要重启一次应用（见 runDesktopApp 注释），
 * 一天通常 1~3 项，20 足够覆盖且不会失控；它同时充当循环上限的一部分。
 */
const MAX_ITEMS_PER_RUN = 20;

/**
 * 微软登录域。Rewards 桌面应用未登录时，主窗口会停在这些域上。
 *
 * 桌面应用有自己的登录态，与本项目 cookie 完全无关 —— 它没登录时我们什么都做不了，
 * 应当「跳过并通过通知说清楚原因」，而不是让它拖累本项目其它任务（用户 2026-11-02 定）。
 */
const LOGIN_URL_RE = /login\.(live|microsoft|microsoftonline)\.com/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** execFile 的 Promise 包装：失败也返回字符串，交由调用方判空（探测类操作不该抛） */
function run(file, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? "" : String(stdout || ""));
    });
  });
}

/**
 * 解析应用可执行文件路径。
 * 不能硬编码版本号（`Microsoft.24183918CCDA_1.12.0.0_x64__8wekyb3d8bbwe` 会随更新变化），
 * 也不能列举 `C:\Program Files\WindowsApps`（该目录 ACL 禁止 scandir，EPERM）。
 * 可靠路径只有两条：Appx 包信息（未运行也能查）、运行中进程的可执行路径（兜底）。
 */
async function resolveExePath() {
  const out = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(Get-AppxPackage -Name ${PACKAGE_NAME}).InstallLocation`,
  ]);
  const dir = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (dir) {
    const exe = path.join(dir, EXE_NAME);
    if (fs.existsSync(exe)) return exe;
  }
  // 兜底：应用已在运行时从进程模块拿路径
  const pids = await listPids();
  if (pids.length) {
    const ps = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pids[0]} -ErrorAction SilentlyContinue).Path`,
    ]);
    const p = ps.trim();
    if (p && fs.existsSync(p)) return p;
  }
  return "";
}

/** 列出应用进程 PID（tasklist 的 CSV 输出第二列） */
async function listPids() {
  const out = await run("tasklist", ["/FI", `IMAGENAME eq ${EXE_NAME}`, "/FO", "CSV", "/NH"]);
  const pids = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^"[^"]*","(\d+)"/);
    if (m) pids.push(Number(m[1]));
  }
  return pids;
}

/** DevTools 端口是否可用 */
async function isPortReady() {
  try {
    const res = await fetch(`${CDP_BASE}/json/version`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return false;
    const j = await res.json();
    return Boolean(j && j.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

/** 当前环境是否装了微软的桌面应用 */
async function detect() {
  const exePath = await resolveExePath();
  const pids = await listPids();
  const portReady = await isPortReady();
  return { installed: Boolean(exePath), exePath, running: pids.length > 0, pids, portReady };
}

/** 结束应用（仅在我们需要重启出端口时用） */
async function stop() {
  const pids = await listPids();
  if (!pids.length) return true;
  await run("taskkill", ["/F", "/PID", ...pids.map(String)], 10000);
  // 等进程真正退出，否则紧接着 spawn 会因单实例锁失败
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if ((await listPids()).length === 0) return true;
  }
  return false;
}

/**
 * 确保存在一个「带调试端口」的实例。
 *
 * 三种情形：
 *   ① 端口already通 → 直接用（可能是上一次运行留下的，也可能是用户自己开的）
 *   ② 应用在跑但没端口 → 必须重启（纯 spawn 会撞单实例锁，新实例直接把参数丢给旧实例）
 *   ③ 没在跑 → 带环境变量 spawn
 *
 * @param {{ allowRestart?: boolean }} opts allowRestart=false 时，情形②会返回失败而不动用户的应用
 * @returns {Promise<{ ok: boolean, reason?: string, restarted?: boolean }>}
 */
async function ensureStarted(opts = {}) {
  const { allowRestart = true } = opts;
  if (await isPortReady()) return { ok: true, restarted: false };

  const exePath = await resolveExePath();
  if (!exePath) return { ok: false, reason: "未安装微软 Rewards 桌面应用" };

  let restarted = false;
  if ((await listPids()).length > 0) {
    if (!allowRestart) return { ok: false, reason: "应用已在运行但未开启调试端口" };
    if (!(await stop())) return { ok: false, reason: "无法结束现有应用实例" };
    restarted = true;
  }

  /**
   * 刚杀掉的实例，调试端口会**短暂残留**（WebView2 子进程还没退干净）。
   *
   * 此时若直接往下走，isPortReady() 会返回 true，我们就把一个「正在退出」的实例
   * 当成可用的连上去 —— 页面随后被销毁，waitForTimeout 抛 Target page closed，
   * 整轮直接崩（2026-11-04 踩）。所以先等端口真正消失，再走后面的启动逻辑。
   */
  if (restarted) {
    for (let i = 0; i < 6; i++) {
      if (!(await isPortReady())) break;
      await sleep(500);
    }
  }

  const child = spawn(exePath, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--${BROWSER_ARG}` },
    detached: true,
    stdio: "ignore",
    // ⚠️ 绝对不要加 windowsHide:true（2026-11-01 踩）：
    // 它是 GUI 应用，隐藏窗口后 WebView2 的视口会塌成一条（实测 innerHeight=40），
    // 页面里的卡片全部落在视口外 → Playwright 判定不可点击 → 每项都 click 超时。
    // 端口照样能开、数据照样能读，只有「点」会失败，症状很容易被误判成选择器有问题。
  });
  child.on("error", (e) => logger.warn(`桌面应用启动失败: ${e.message}`));
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    if (await isPortReady()) return { ok: true, restarted };
  }
  return { ok: false, reason: "应用已启动但调试端口未就绪", restarted };
}

/**
 * 确保视口高度正常（2026-11-01 踩）。
 *
 * 应用窗口会被压成一条（实测 1101×41），此时 WebView2 的 innerHeight=40，
 * 页面卡片全部落在视口外 → Playwright 判定不可点击 → 每项都 10s 超时。
 * 端口、数据、跳转全都正常，只有「点」失败，极易被误判成选择器问题。
 *
 * 恢复走 CDP 的 Browser 域（不用 Win32，也不受本机 Add-Type 安全策略影响）：
 *   Browser.getWindowForTarget → getWindowBounds → setWindowBounds
 *
 * @returns {Promise<boolean>} 视口是否已可用
 */
async function ensureViewport(page) {
  const vh = await page.evaluate(() => window.innerHeight).catch(() => 0);
  if (vh >= 300) return true;

  let session;
  try {
    session = await page.context().newCDPSession(page);
    const { windowId } = await session.send("Browser.getWindowForTarget");
    const { bounds } = await session.send("Browser.getWindowBounds", { windowId });
    const left = Number.isFinite(bounds.left) ? bounds.left : 100;
    const top = Number.isFinite(bounds.top) ? bounds.top : 100;
    const width = Math.max(1100, Number(bounds.width) || 0);
    await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await session.send("Browser.setWindowBounds", { windowId, bounds: { left, top, width, height: 860 } });
    await page.waitForTimeout(1200);
    return (await page.evaluate(() => window.innerHeight).catch(() => 0)) >= 300;
  } catch {
    return false;
  } finally {
    if (session) await session.detach().catch(() => {});
  }
}

/** 把 RSC / 内联 JSON 的转义还原成可正则的明文 */
function decodePayload(text) {
  return String(text || "")
    .replace(/\\\\\\"/g, '"')
    .replace(/\\\\"/g, '"')
    .replace(/\\"/g, '"')
    .replace(/\\u0026/g, "&");
}

// 任务项结构：ariaLabel → href → isCompleted → isLocked
const ITEM_PATTERN = /"ariaLabel":"([^"]{0,90})"[\s\S]{0,400}?"href":"(https:[^"]{0,400})","edgeAction":[^,]{0,20},"isCompleted":(true|false),"isLocked":(true|false)/g;

/** 在页面上下文里 fetch（绕缓存），避免 CDN 返回旧的 punchcard 数据 */
async function fetchText(page, url) {
  return page.evaluate(async (u) => {
    const res = await fetch(u + (u.includes("?") ? "&" : "?") + "_cb=" + Date.now(), {
      cache: "no-store",
      credentials: "include",
    });
    return await res.text();
  }, url);
}

/**
 * 锁定「应用主窗口」。
 *
 * 非主窗口的 webview 上 open_in_app 会被 Tauri ACL 拒绝（报 `not allowed by ACL`），
 * 表现为点击成功但页面毫无反应 —— 所以不能按 URL 随便挑一个页面。
 */
async function pickMainPage(browser) {
  let pages = [];
  try {
    const ctxs = browser.contexts();
    pages = (ctxs && ctxs.length && ctxs[0].pages()) || [];
  } catch {
    // 浏览器/context 已关闭（应用正在退出），当作没有可用页面
    return null;
  }
  for (const p of pages) {
    if (await p.evaluate(() => window.__msRewardsIsMainWindow === true).catch(() => false)) return p;
  }
  return pages.find((p) => p.url().includes("rewards.bing.com")) || pages[0] || null;
}

/**
 * 等主窗口真正可用。
 *
 * 端口就绪 ≠ 应用可用：WebView 还要几秒才把主窗口渲染出来，
 * 太早导航会直接拿到 net::ERR_ABORTED。
 *
 * @returns {Promise<true|"login"|false>} true=可用；"login"=停在登录页（别再等了）；false=超时
 */
async function waitPageReady(page, tries = 16) {
  for (let i = 0; i < tries; i++) {
    let st = null;
    try {
      st = await page.evaluate(() => ({ ready: document.readyState !== "loading", url: location.href }));
    } catch {
      // 页面已销毁 = 连到了正在退出的实例（重启竞态），交给上层重连。
      // 不接住会直接抛 Target page closed，把整轮打断（2026-11-04 踩）。
      return false;
    }
    // 未登录：应用停在 login.live.com 之类，再等 24 秒也不会变成 rewards 页，立即返回
    if (st && LOGIN_URL_RE.test(st.url)) return "login";
    if (st && st.ready && st.url.includes("rewards.bing.com")) return true;
    try {
      await page.waitForTimeout(1500);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 判定桌面应用是否已登录，并给出**可直接写进通知**的具体信息。
 *
 * 判据（任一成立即判未登录）：
 *   1. 主窗口停在微软登录域；
 *   2. 页面既没有「积分 / 赚取奖励」这类已登录特征，又出现「登录 / Sign in」字样。
 * detail 里带当前 URL 与页面开头，出问题时用户不用自己开应用去找原因。
 */
async function detectSignIn(page) {
  const snap = await page
    .evaluate(() => ({
      url: location.href,
      text: (document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 160),
    }))
    .catch(() => ({ url: page.url(), text: "" }));
  const detail = `当前页面 ${String(snap.url).slice(0, 100)}${snap.text ? ` ｜ 内容: ${snap.text.slice(0, 90)}` : ""}`;
  if (LOGIN_URL_RE.test(snap.url)) return { signedIn: false, detail };
  // 已登录特征要用「只有登录后才有的词」：今日积分 / 积分明细 / 赚取奖励 / 兑换。
  // ⚠️ 不能用泛化的「积分」——登录引导页的「登录以开始赚取积分」里也有这两个字，
  //    会把它判成已登录（2026-11-02 实测踩到）。
  const looksSignedIn = /赚取奖励|今日积分|积分明细|兑换奖励/.test(snap.text);
  if (!looksSignedIn && /登录|sign\s*in/i.test(snap.text)) return { signedIn: false, detail };
  return { signedIn: true, detail };
}

/** 发现当前账户下所有 punchcard id（应用刚重启时常有首次导航被 abort，多试几次） */
async function discoverQuests(page) {
  let lastErr = null;
  let navigated = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // 超时给短一点：快速失败 + 间隔重试，比一次等 60 秒更有效。
      // waitUntil 用 commit：应用刚重启时它自己的首次导航还在跑，等 domcontentloaded
      // 会被那次导航打断 → net::ERR_ABORTED（2026-11-02 踩，重试 3 次仍失败）。
      await page.goto(EARN_URL, { waitUntil: "commit", timeout: 30000 });
      navigated = true;
      await page.waitForTimeout(9000);
      const ids = await page.evaluate(() => {
        const set = new Set();
        document.querySelectorAll('a[href*="/earn/quest/"]').forEach((a) => {
          const m = (a.getAttribute("href") || "").match(/\/earn\/quest\/([A-Za-z0-9_]+)/);
          if (m) set.add(m[1]);
        });
        return [...set];
      });
      if (ids.length) return ids;
      lastErr = new Error("/earn 页面没有发现任何 punchcard");
    } catch (e) {
      lastErr = e;
    }
    // 间隔递增：应用重启后的首次导航失败往往要 10s 以上才恢复，
    // 固定 5s 连试 3 次等于白跑（实测）。
    if (attempt < 3) await page.waitForTimeout(attempt * 5000);
  }
  logger.warn(`发现 punchcard 失败: ${String((lastErr && lastErr.message) || lastErr).slice(0, 100)}`);
  // navigated=false 表示导航压根没成功（应用未就绪）→ 调用方该重试而不是判「今天没任务」
  return navigated ? [] : null;
}

/** 解析单个 punchcard：返回进度与任务项 */
async function readQuest(page, questId) {
  const url = `https://rewards.bing.com/earn/quest/${questId}`;
  const raw = await fetchText(page, url);
  const text = decodePayload(raw);
  const prog = text.match(/>(\d)\/(\d{1,2}) 个任务</);
  const items = [...text.matchAll(ITEM_PATTERN)].map((m) => ({
    aria: m[1],
    href: decodeURIComponent(m[2]),
    completed: m[3] === "true",
    locked: m[4] === "true",
  }));
  return {
    questId,
    url,
    done: prog ? Number(prog[1]) : 0,
    total: prog ? Number(prog[2]) : items.length,
    items,
  };
}

/** 从 URL 里取 Rewards 的活动归因码（form=ML2Yxx），后用它定位卡片 */
function formOf(href) {
  const m = String(href || "").match(/[?&]form=([A-Za-z0-9]+)/);
  return m ? m[1] : "";
}

/**
 * 对指定 punchcard 的可做项逐个「真实点击」。
 * 返回 { done, total, clicked: [...] }
 */
async function executeQuest(page, quest, opts = {}) {
  const {
    maxItems = 10,
    onLog = () => {},
    skipForms = new Set(),
    renderWaitMs = RENDER_WAIT_MS,
    onlyForm = null,
  } = opts;
  // skipForms：今天已点过但没到账的项（冷却期任务），本轮不再浪费时间去点
  // onlyForm：外层已经选定了具体某一项，内层必须照着做，不能自己挑 --
  //   否则「外层判断可做 A、内层实际做了 B」会让人对着日志查不出问题。
  const todo = quest.items.filter(
    (i) =>
      !i.completed &&
      !i.locked &&
      !skipForms.has(formOf(i.href)) &&
      (!onlyForm || formOf(i.href) === onlyForm)
  );
  if (!todo.length) return { done: 0, total: quest.total, clicked: [] };

  const clicked = [];
  // 连续渲染失败计数：应用跑久了会进入「详情页只渲染外壳」的坏状态，
  // 重载救不回来但重启应用可以。连续 2 次就抛信号，交给上层重启重试。
  let renderFails = 0;
  for (const item of todo.slice(0, maxItems)) {
    const form = formOf(item.href);
    if (!form) {
      onLog(`跳过（无法识别归因码）: ${item.aria}`);
      continue;
    }
    try {
      // 每项都从 /earn 重新进入（2026-11-01 实测）：连续 goto 不同 punchcard 详情页时，
      // 第二个开始经常水合失败（body 只剩导航，重载也救不回来）；绕一次 /earn 再进就正常。
      await page.goto(EARN_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(2500);
      await page.goto(quest.url, { waitUntil: "domcontentloaded", timeout: 90000 });
      // 必须提到前台：WebView2 在后台会节流渲染，固定等 18s 也可能一张卡片都没出
      await page.bringToFront().catch(() => {});
      await page.waitForTimeout(renderWaitMs);

      /**
       * 偶发「只渲染外壳」：body 只有导航+页脚（约 208 字符），主体为空，
       * 且 `?_rsc=` 请求根本没发出去 —— 表现为卡片永远不出现。
       * 实测重载/重启应用后可恢复，所以这里重试两次，别一次失败就判死。
       */
      const bodyLen = () => page.evaluate(() => (document.body.innerText || "").length).catch(() => 0);
      if ((await bodyLen()) < 300) {
        let ok = false;
        for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
          onLog(`页面主体未渲染，重载第 ${attempt} 次`);
          await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
          await page.waitForTimeout(renderWaitMs);
          ok = (await bodyLen()) >= 300;
        }
        if (!ok) {
          onLog(`跳过（页面渲染失败，非卡片问题）: ${item.aria}`);
          renderFails += 1;
          continue;
        }
      }
      await page.evaluate(() => window.scrollTo(0, 200));

      // 视口过小 = 窗口被压成一条：卡片全在视口外，click 必然 10s 超时。
      // 先恢复窗口尺寸，恢复不了就跳过 —— 别把「窗口问题」误判成「选择器问题」。
      const vh0 = await page.evaluate(() => window.innerHeight).catch(() => 0);
      if (vh0 < 300) {
        onLog(`窗口视口过小(${vh0}px)，恢复窗口尺寸`);
        if (!(await ensureViewport(page))) {
          onLog(`跳过（窗口不可用，视口 ${vh0}px）: ${item.aria}`);
          continue;
        }
        onLog(`窗口已恢复，视口 ${await page.evaluate(() => window.innerHeight).catch(() => 0)}px`);
      }

      // 轮询等卡片出现（最多 ~40s），期间轻微滚动触发懒加载。
      // ⚠️ 不要加 `:visible`（2026-11-01 实测）：加了之后会选中另一个同名节点，
      // 点击"成功"但应用毫无反应、也不计入；不加则命中真正的卡片。
      // 元素"看不见"的真实原因通常是窗口被压成一条（视口 40px），交给上面的
      // ensureViewport 解决，而不是靠选择器过滤。
      const card = page.locator(`a[href*="${form}"]`).first();
      let ready = false;
      for (let i = 0; i < 20; i++) {
        if (await card.count().catch(() => 0)) { ready = true; break; }
        await page.evaluate((y) => window.scrollTo(0, y), i % 2 ? 0 : 320).catch(() => {});
        await page.waitForTimeout(2000);
      }
      if (!ready) {
        onLog(`跳过（卡片未渲染）: ${item.aria}`);
        continue;
      }

      // ⚠️ 必须是 click：它会走 Tauri 的 <a target=_blank> 拦截路径，
      // 落地 URL 不带 dmreload=1；换成 goto/invoke 则一切正常但永不计分。
      const beforeUrls = new Set(page.context().pages().map((p) => p.url()));
      const beforeUrl = page.url();
      await card.click({ timeout: 10000 });
      onLog(`已点击: ${item.aria}`);

      /**
       * 找落地页必须比较「URL 集合」，不能比较页面对象（2026-11-01 修）。
       *
       * 应用有个预创建的 about:blank 窗口池，点击任务时**复用它**：
       *   about:blank → cn.bing.com/?form=ML2Y3O...
       * 页面对象始终是同一个、总数也不变，只有 URL 变了。
       * 之前用 `!beforePages.has(p)` 判新增，永远匹配不到 → 既不等待也不滚动 →
       * 落到「点了但不到账」。
       *
       * 另外 redirect 类任务会先落在 rewards.bing.com/redirect 再跳，所以不能按域名过滤。
       */
      let popup = null;
      for (let i = 0; i < 15 && !popup; i++) {
        await page.waitForTimeout(1000);
        popup = page.context().pages().find(
          (p) => p !== page && !beforeUrls.has(p.url()) && !p.url().includes("localhost")
        ) || null;
      }
      if (!popup && page.url() !== beforeUrl) popup = page; // 同窗口内导航

      // 等 redirect 中继跳完（URL 会再变一次）
      if (popup) {
        for (let i = 0; i < 6; i++) {
          if (!/rewards\.bing\.com\/redirect/i.test(popup.url())) break;
          await popup.waitForTimeout(1500);
        }
      }
      if (popup) {
        await popup.waitForLoadState("load", { timeout: 40000 }).catch(() => {});
        const landed = popup.url();
        // 落地 URL 一定要打出来：`dmreload=1` 是「不计分」的唯一可观测信号，
        // 不打日志就只能看到「点了但没到账」，排查时无从下手。
        const dirty = /[?&]dmreload=1/.test(landed);
        onLog(`落地${dirty ? "(含 dmreload，多半不计)" : ""}: ${decodeURIComponent(landed).slice(0, 110)}`);
        await popup.bringToFront().catch(() => {});
        for (let i = 0; i < 3; i++) {
          await popup.mouse.wheel(0, 300).catch(() => {});
          await popup.waitForTimeout(2500);
        }
        /**
         * ⚠️ 只能关「新开的窗口」。popup === page 说明是**主窗口自己导航过去**的
         * （兑换类任务 rewards.bing.com/redeem/sku/... 就是这样），关掉它等于把主窗口杀了，
         * 紧接着的 waitForTimeout 会抛 Target page closed，整项被判失败（2026-11-04 踩）。
         */
        if (popup !== page) await popup.close().catch(() => {});
      }
      await page.waitForTimeout(VERIFY_WAIT_MS).catch(() => {});
      clicked.push({ aria: item.aria, form });
    } catch (e) {
      if (e && e.code === "RENDER_BROKEN") throw e; // 交给上层重启重试，不当作单项失败
      onLog(`失败: ${item.aria} — ${String(e.message || e).slice(0, 100)}`);
    }
  }

  // 复查：完成的项会从 payload 消失
  let after = quest;
  try {
    after = await readQuest(page, quest.questId);
  } catch {}
  // gained 才是真正到账的项数（点到了 ≠ 计入了）。
  // 用「完成后数 - 点击前数」算，别用 clicked.length 充数 —— 那会把没到账的也算成得分。
  const gained = Math.max(0, (after.done || 0) - (quest.done || 0));
  // 点了但整体没涨 → 这些项大概率在冷却期（或该任务不重复计），交给上层当天拉黑
  const failedForms = gained === 0 && clicked.length > 0 ? clicked.map((c) => c.form) : [];
  return { done: after.done, total: after.total, gained, clicked, renderFails, failedForms };
}

/**
 * 任务入口（供 tasks.js 调用）。
 *
 * @param {object} ctx 账户上下文（含 config / state）
 * @param {{ onLog?: Function, dryRun?: boolean }} opts
 * @returns {Promise<{ status: string, done?: number, total?: number, points?: number, reason?: string }>}
 */
/**
 * 任务入口（供插件 / runner 调用）。
 *
 * ## 为什么「一次性完成」要靠反复重启
 *
 * 实测结论（2026-11-01 / 11-02）：同一个应用实例里连续进入第二个 punchcard 详情页时，
 * RSC 水合必失败 —— 页面只剩导航和页脚（body 约 208 字符），`?_rsc=` 请求根本不发，
 * 重载两次也救不回来，只有重启应用才恢复。
 *
 * 所以这里的做法是：**每做完一项就重启一次应用**，用重启换「每个详情页都是干净的首次访问」。
 * 单项成本 = 重启 2s + 就绪几秒 + 渲染 18s + 点击复查，约 40~60 秒；一天通常 1~3 项，
 * 一轮几分钟做完，比「一轮只做 1 项、靠多次调度铺开」更符合「一次性完成」的要求。
 *
 * ## 与本项目登录态的关系
 *
 * 完全无关 —— 用的是 Rewards 桌面应用自己的会话。因此未登录也照跑（runner 里已放行）。
 *
 * @param {object} ctx 账户上下文（含 config / state）
 * @param {{ onLog?: Function, dryRun?: boolean, maxItems?: number, rules?: object }} opts
 * @returns {Promise<{ status: string, done?: number, total?: number, points?: number,
 *   gained?: number, clicked?: number, reason?: string, quests?: Array, todo?: number }>}
 */
async function runDesktopApp(ctx, opts = {}) {
  const {
    onLog = (m) => logger.info(m),
    dryRun = false,
    maxItems = MAX_ITEMS_PER_RUN,
    rules = null,
  } = opts;
  // 规则可远程热更新（见 src/plugin-rules.js）：这里只取「行为参数」，代码路径不变
  const runtimeRule = (rules && rules.runtime) || {};
  const renderWaitMs = Number(runtimeRule.renderWaitMs) || RENDER_WAIT_MS;
  const cfg = ctx && ctx.config ? ctx.config.get() : {};
  const tasksCfg = (cfg && cfg.tasks) || {};
  if (!tasksCfg.desktopApp) return { status: "skip", disabled: true };
  // 发布闸门（2026-11-04）：功能暂缓上线。即使老用户的配置里 desktopApp 还是 true，
  // 这里也必须挡住 —— 否则「界面灰了但任务照跑」，用户看到的和实际发生的不一致。
  if (!require("./feature-gates").desktopAppGate().allowed) {
    return { status: "skip", reason: "功能暂缓上线", delayed: true };
  }

  const info = await detect();
  if (!info.installed) {
    return { status: "skip", reason: "未安装微软 Rewards 桌面应用", notInstalled: true };
  }

  const budget = Math.max(1, maxItems);
  const skipForms = loadSkipToday(); // 今日冷却期任务
  const giveUp = new Set(); // 本轮试过两次仍失败的项，防止死循环
  const attempts = new Map(); // form → 本轮尝试次数
  const acc = { gained: 0, clicked: 0, done: 0, total: 0, todo: 0 };
  let restarts = 0; // 已重启次数（0 = 复用现有实例，还没重启过）
  let navFails = 0; // 连续「应用未就绪」次数
  let pageFails = 0; // 连续「页面连上就死」次数（重启竞态），别无限重连
  let scan = null; // 最后一次扫描快照（dryRun / 异常时回传）

  // 安全上限：宁可少做几项，也不能因为某项一直失败而无限重启
  const maxIterations = budget * 3 + 3;

  for (let iter = 0; iter < maxIterations && acc.gained < budget; iter++) {
    // 第二次及以后都先重启：应用一坏全坏，只有重启能拿到干净实例
    if (restarts > 0) {
      await stop().catch(() => {});
      await sleep(1500);
    }

    const boot = await ensureStarted({ allowRestart: true });
    if (!boot.ok) {
      if (restarts === 0) return { status: "retry", reason: boot.reason || "无法启动桌面应用" };
      onLog(`重启后应用仍未就绪，结束本轮：${boot.reason || "未知原因"}`);
      break;
    }
    if (boot.restarted) onLog("已重启桌面应用以开启调试端口");

    let browser = null;
    try {
      browser = await chromium.connectOverCDP(CDP_BASE, { timeout: 20000 });
    } catch (e) {
      if (restarts === 0) {
        return { status: "retry", reason: `无法接管桌面应用: ${String(e.message || e).slice(0, 80)}` };
      }
      onLog(`重启后无法接管，结束本轮: ${String(e.message || e).slice(0, 60)}`);
      break;
    }

    try {
      const page = await pickMainPage(browser);
      if (!page) {
        restarts++;
        continue;
      }
      const ready = await waitPageReady(page);
      if (ready === "login") {
        // 桌面应用自己没登录 —— 本模块无能为力，直接跳过并带上可读原因，
        // 绝不因此影响本项目其它任务（它们用的是本项目浏览器，与这里无关）。
        const det = await detectSignIn(page);
        return {
          status: "skip",
          notLoggedIn: true,
          reason: "Rewards 桌面应用未登录",
          detail: det.detail,
        };
      }
      if (ready === false) {
        // 页面在等待中被销毁：连到了正在退出的实例，重连即可。
        // 但别无限重连 —— 连续 3 次说明应用本身起不来。
        pageFails++;
        if (pageFails >= 3) {
          onLog("桌面应用连续 3 次连上即失效，结束本轮");
          break;
        }
        onLog("桌面应用页面已失效，重新连接");
        restarts++;
        continue;
      }
      pageFails = 0;

      const questIds = await discoverQuests(page);
      if (questIds === null) {
        // null = 导航压根没成功（应用未就绪），不是「今天没任务」。
        // 把这两种情况混在一起，整轮会静默返回 done:0（2026-11-02 踩）。
        navFails++;
        if (navFails >= 2) {
          onLog("桌面应用连续未就绪，结束本轮");
          break;
        }
        onLog("桌面应用未就绪，重启后重试");
        restarts++;
        continue;
      }
      navFails = 0;
      onLog(`发现 ${questIds.length} 个 punchcard`);
      if (!questIds.length) {
        // 导航成功却一个 punchcard 都没有：先排除「未登录」（登录引导页也长这样）
        const det = await detectSignIn(page);
        if (!det.signedIn) {
          return {
            status: "skip",
            notLoggedIn: true,
            reason: "Rewards 桌面应用未登录",
            detail: det.detail,
          };
        }
        break;
      }

      const all = [];
      for (const id of questIds) {
        try {
          all.push(await readQuest(page, id));
        } catch (e) {
          onLog(`读取失败 ${id}: ${String(e.message || e).slice(0, 60)}`);
        }
      }
      scan = all;

      const isTodo = (i) => {
        const f = formOf(i.href);
        return !i.completed && !i.locked && !skipForms.has(f) && !giveUp.has(f);
      };
      // 每轮覆盖（不是累加）：done/total 是「当前总进度」，累加会虚高
      acc.done = all.reduce((n, q) => n + (q.done || 0), 0);
      acc.total = all.reduce((n, q) => n + (q.total || 0), 0);
      acc.todo = all.reduce((n, q) => n + q.items.filter(isTodo).length, 0);

      if (dryRun) {
        return { status: "skip", reason: "扫描模式", quests: all, todo: acc.todo };
      }

      // 选一项来做：按 quest 顺序，各取第一个可做项
      let target = null;
      for (const quest of all) {
        const item = quest.items.find(isTodo);
        if (item) {
          target = { quest, item };
          break;
        }
      }
      if (!target) break; // 没有可做项了

      const form = formOf(target.item.href);
      // 不写「x/y」进度：y（剩余可做数）每轮都会重算，跳过一项后会出现 [2/1] 这种怪显示
      onLog(`第 ${acc.gained + 1} 项: ${target.item.aria || form}`);

      const r = await executeQuest(page, target.quest, {
        onLog,
        maxItems: 1,
        skipForms,
        renderWaitMs,
        onlyForm: form,
      });

      if (r.gained > 0) {
        acc.gained += r.gained;
        acc.clicked += (r.clicked || []).length;
        restarts++; // 下一项需要干净实例
        continue;
      }

      if (r.clicked && r.clicked.length > 0) {
        // 点了但没到账（24h 冷却类任务）→ 记入今日跳过，换下一项继续
        acc.clicked += r.clicked.length;
        const forms = r.failedForms && r.failedForms.length ? r.failedForms : [form];
        addSkipToday(forms);
        forms.forEach((f) => skipForms.add(f));
        onLog(`记入今日跳过: ${forms.join(", ")}`);
        restarts++;
        continue;
      }

      // 压根没点成（渲染失败 / 卡片不存在）：重启后允许再试一次，两次都败就放弃该项
      const n = (attempts.get(form) || 0) + 1;
      attempts.set(form, n);
      if (n >= 2) {
        giveUp.add(form);
        onLog(`该项尝试 ${n} 次仍未点成，本轮放弃: ${target.item.aria || form}`);
      } else {
        onLog(`该项未点成，重启后重试: ${target.item.aria || form}`);
      }
      restarts++;
    } catch (e) {
      /**
       * 单轮异常不该让整轮归零：应用重启、页面销毁这类问题是过程性的，
       * 重启一次往往就好了。这里记日志后继续，靠 maxIterations 兜底。
       * （2026-11-04：Target page closed 直接把整轮打崩，什么都拿不到）
       */
      pageFails++;
      onLog(`本轮异常: ${String((e && e.message) || e).slice(0, 100)}`);
      if (pageFails >= 3) {
        onLog("连续异常 3 次，结束本轮");
        break;
      }
      restarts++;
    } finally {
      await browser.close().catch(() => {});
    }
  }

  if (dryRun) {
    // 走到这里说明第一轮就没拿到扫描结果（应用未就绪）
    return { status: "retry", reason: "桌面应用未就绪", quests: scan || [], todo: 0 };
  }

  // 每项 10 分是这类 punchcard 的固定值（weekly 70 分 = 7 项 × 10）。
  // 计分只用 gained（复查到的实际增量），不用 clicked —— 点了不到账的情况真实存在。
  const base = {
    status: "done",
    done: acc.done,
    total: acc.total,
    points: acc.gained * 10,
    gained: acc.gained,
    clicked: acc.clicked,
  };
  if (acc.gained === 0 && acc.clicked === 0) {
    return { ...base, reason: "今天没有可做的桌面任务" };
  }
  if (acc.gained === 0) {
    return { ...base, reason: "已点击但未到账（多在 24 小时冷却期）" };
  }
  return base;
}

module.exports = {
  // 常量（selfcheck 断言用）
  CDP_PORT,
  CDP_BASE,
  BROWSER_ARG,
  PACKAGE_NAME,
  EXE_NAME,
  // 探测与生命周期
  detect,
  resolveExePath,
  isPortReady,
  ensureStarted,
  stop,
  ensureViewport,
  // 扫描与执行
  discoverQuests,
  readQuest,
  executeQuest,
  runDesktopApp,
  // 登录态（便于单独验证判定逻辑）
  detectSignIn,
  waitPageReady,
  pickMainPage,
  // 内部工具的导出（便于单独验证解析逻辑）
  decodePayload,
  formOf,
};
