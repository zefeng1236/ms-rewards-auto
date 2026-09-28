const { app, BrowserWindow, ipcMain, shell, Menu, Tray, dialog, nativeImage, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL, fileURLToPath } = require("url");
const { spawn } = require("child_process");

// ⚠️ 必须在 require 任何业务模块之前确定存储目录。
// 打包后安装目录（Program Files）没有写权限，数据必须落在 userData 下；
// account/config/global-config/state 都在 require 时就读这个环境变量算路径。
if (!process.env.MS_REWARDS_STORAGE_DIR && app.isPackaged) {
  process.env.MS_REWARDS_STORAGE_DIR = path.join(app.getPath("userData"), "storage");
}

const accounts = require("./account");
const globalConfig = require("./global-config");
const browser = require("./browser");
const auth = require("./auth");
const runner = require("./runner");
const rewards = require("./rewards");
const logger = require("./logger");
const notify = require("./notify");
const hitokoto = require("./hitokoto");
const bgLimit = require("./wallpaper-limit");
const cancel = require("./cancel");
const ensureDeps = require("./ensure-deps");
const fpBrowser = require("./fingerprint-browser");
const appUpdate = require("./app-update");
const appearance = require("./appearance");
const uapi = require("./uapi");
const wallpapers = require("./wallpapers");
const launch = require("./launch");
const setup = require("./setup");
const sp = require("./storage-path");
const vault = require("./vault");
const { displayVersion } = require("./version");
const vaultMigrate = require("./vault/migrate");
const wipe = require("./wipe");

const ROOT = path.join(__dirname, "..");
const IS_SMOKE = process.argv.includes("--smoke");
const DEV_SERVER = "http://localhost:5173/";
let mainWindow = null;
let running = false;
let daemonStop = null;
let tray = null;
/** 托盘「退出」时置位，允许窗口真正关闭（否则会被 close 拦截到托盘） */
let forceQuit = false;
/** 后台工作（守护/自动推送/Chromium 安装）是否已启动，避免重复启动 */
let backgroundStarted = false;

// 单实例锁：避免「开机自启已在托盘驻留 + 又双击图标」时出现多进程
// （否则会有多个托盘图标、多个守护进程重复跑任务）。--smoke 冒烟测试豁免，
// 以免被机器上残留的实例干扰导致直接退出。
if (!IS_SMOKE) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on("second-instance", () => {
      // 第二实例尝试启动：把已在托盘驻留的主窗口唤到前台
      forceQuit = false;
      activateApp(false);
    });
  }
}

/** 探测 Vite dev server 是否已就绪（短超时，避免拖慢启动） */
function devServerReady() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const req = require("http").get(DEV_SERVER, (res) => {
        res.resume();
        done(res.statusCode < 500);
      });
      req.setTimeout(800, () => {
        req.destroy();
        done(false);
      });
      req.on("error", () => done(false));
    } catch {
      done(false);
    }
  });
}

/**
 * 选择渲染进程入口：
 *   打包后     -> gui-react/index.html
 *   开发且 Vite 在跑 -> dev server（热更新）
 *   开发但 Vite 没跑 -> 回落到已构建产物，避免 ERR_CONNECTION_REFUSED 白屏
 */
async function loadRenderer() {
  const prod = path.join(__dirname, "..", "gui-react", "index.html");
  const legacy = path.join(__dirname, "..", "gui", "index.html");

  if (app.isPackaged) {
    mainWindow.loadFile(prod);
    return;
  }

  if (await devServerReady()) {
    mainWindow.loadURL(DEV_SERVER);
    return;
  }

  // dev server 没起，优先用构建产物，其次退回旧版原生界面
  if (fs.existsSync(prod)) {
    logger.warn(
      "Vite dev server 未运行，已加载构建产物 gui-react/；改 src-renderer/ 后需 npm run build:web 才生效（或 npm run dev 同时启动两者）"
    );
    mainWindow.loadFile(prod);
  } else if (fs.existsSync(legacy)) {
    logger.warn("Vite dev server 未运行，且 gui-react/ 不存在，已回退到旧版原生界面");
    mainWindow.loadFile(legacy);
  } else {
    logger.error("既没有 Vite dev server，也没有可用的构建产物");
    mainWindow.loadFile(prod);
  }
}

/**
 * 下载图片（跟随 302 重定向），支持流式进度推送。
 * destFile 为 null 时只探测不落盘；否则写入该路径。返回状态/类型/大小。
 *
 * onProgress 回调在能取到 Content-Length 时周期性触发 { loaded, total, pct }，
 * 用于渲染端「正在切换壁纸，已下载 xx%」气泡；取不到总长度时不回调。
 */
async function downloadImage(url, destFile, opts = {}) {
  const { maxBytes = 60 * 1024 * 1024, headOnly = false, onProgress } = opts;
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20000) });
  const ct = res.headers.get("content-type") || "";
  const isImage = /^image\//.test(ct);
  if (!res.ok) return { ok: false, status: res.status, contentType: ct, finalUrl: res.url, error: `HTTP ${res.status}` };
  if (!isImage) return { ok: false, status: res.status, contentType: ct, finalUrl: res.url, error: `返回类型不是图片（${ct || "未知"}）` };
  if (headOnly) { res.body.cancel(); return { ok: true, status: res.status, contentType: ct, finalUrl: res.url }; }

  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (onProgress && total > 0) {
      // 每 5% 或每 50KB 至少报一次，避免高频回调卡渲染进程
      const pct = Math.round((loaded / total) * 100);
      if (pct !== lastReport) {
        lastReport = pct;
        onProgress({ loaded, total, pct });
      }
    }
  }
  const buf = Buffer.concat(chunks);
  if (buf.length > maxBytes) return { ok: false, status: res.status, contentType: ct, finalUrl: res.url, error: "图片过大" };
  fs.writeFileSync(destFile, buf);
  return { ok: true, status: res.status, contentType: ct, finalUrl: res.url, bytes: buf.length };
}

/** 当前背景下应请求的原始远程/本地地址（不含缓存逻辑） */
async function rawBackgroundSrc(cfg) {
  switch (cfg.bgType) {
    case "bing":
      return uapi.resolveBingDailyUrl();
    case "upx8":
      return wallpapers.upx8Url(cfg.bgCategory);
    case "qy98":
      return wallpapers.qy98Url(cfg.bgCategory);
    case "unsplash": {
      const key = (process.env.UNSPLASH_ACCESS_KEY || cfg.bgUnsplashKey || "").trim();
      return wallpapers.unsplashRandom(key, cfg.bgCategory); // 无 key / 失败时抛错，由 IPC 兜底为 ""
    }
    default:
      return appearance.backgroundSrc();
  }
}

/** 壁纸本地缓存目录（storage/cache），用于固定「当前这一张」 */
const BG_CACHE_DIR = path.join(path.dirname(appearance.FILE), "cache");

/**
 * 当前背景应显示的图片地址。
 *
 * 随机图源（upx8/qy98/unsplash）每次请求都会返回不同的图，若直接把接口地址
 * 丢给渲染端，背景层、缩略图、预览弹窗会各自请求一次，看到的是三张不同的图。
 * 所以远程图源一律先下载到本地缓存，再返回稳定的 file:// 地址；
 * 只有明确要求 fresh（换一张 / 自动轮换到期）时才重新下载。
 */
async function backgroundSrc(opts = {}) {
  const { fresh = false, auth = false } = opts || {};
  const cfg0 = appearance.get();
  // auth=true：登录页/向导背景解析（与主界面 bgType 无关）——
  //   authBg=flow 返回空地址（渲染端播 Canvas 流场动画）；
  //   authBg=bing 临时按 bing 类型解析必应每日一图（复用下方缓存链路）。
  const cfg = auth
    ? { ...cfg0, bgType: cfg0.authBg === "bing" ? "bing" : "none" }
    : cfg0;
  const url = await rawBackgroundSrc(cfg);
  if (!url) return "";
  // 本地文件 / data: 本身就是稳定的，原样返回
  if (!/^https?:/i.test(url)) return url;

  const key = crypto
    .createHash("md5")
    .update(`${cfg.bgType}|${cfg.bgCategory}|${url}`)
    .digest("hex")
    .slice(0, 16);
  const cacheFile = path.join(BG_CACHE_DIR, `bg-${key}.img`);

  if (!fresh && fs.existsSync(cacheFile)) return pathToFileURL(cacheFile).href;

  // 每 IP 每分钟最多 60 次（桌面端算作单一本机来源）。
  // 只有「真的要打第三方接口」这一步才消耗配额 —— 命中缓存不算请求。
  // 超限时回落到上一张缓存图，而不是让背景突然空掉。
  if (!bgLimit.takeLocal()) {
    logger.warn(`壁纸请求已达每分钟上限（${bgLimit.MAX_PER_MIN} 次），本轮换图延后`);
    if (fs.existsSync(cacheFile)) return pathToFileURL(cacheFile).href;
    return "";
  }

  // 推送壁纸下载进度给渲染端，用于「正在切换壁纸，已下载 xx%」气泡
  const onProgress = (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("bg-progress", info);
    }
  };

  try {
    fs.mkdirSync(BG_CACHE_DIR, { recursive: true });
    const r = await downloadImage(url, cacheFile, { onProgress });
    if (r.ok) return pathToFileURL(cacheFile).href;
    logger.warn(`壁纸缓存失败: ${r.error || "未知错误"}`);
  } catch (e) {
    logger.warn(`壁纸缓存失败: ${e.message}`);
  } finally {
    // 无论成功失败都通知渲染端结束气泡
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("bg-progress", { done: true });
    }
  }

  // 下载失败但有旧缓存就继续用旧的，避免整块背景突然消失
  if (fs.existsSync(cacheFile)) return pathToFileURL(cacheFile).href;
  return url;
}

/**
 * 用主进程 nativeImage 采样壁纸平均亮度（0 全黑 – 1 全白）。
 *
 * 放在主进程而不是渲染端 canvas，是因为 canvas 对跨域图片与本地 file://
 * 会被污染（getImageData 抛 SecurityError），而主进程拿到的要么是已下载到
 * 本地的缓存文件、要么是能直接 fetch 的远程地址，不存在跨域限制。
 * 远程地址会额外发一次请求取字节（已加 15s 超时），失败仅返回 null，
 * 不影响背景显示。
 */
async function sampleLuminance(src) {
  try {
    const s = String(src || "");
    let img;
    if (/^https?:/i.test(s)) {
      const res = await fetch(s, { redirect: "follow", signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
    } else if (/^data:/i.test(s)) {
      img = nativeImage.createFromDataURL(s);
    } else {
      img = nativeImage.createFromPath(s.replace(/^file:\/\//i, ""));
    }
    if (img.isEmpty()) return null;
    // 缩到 32px 再取像素，开销可忽略
    const bmp = img.resize({ width: 32 }).toBitmap();
    // Windows 下 toBitmap() 返回 BGRA，macOS/Linux 通常为 RGBA，
    // 加权亮度对 R/B 权重不同，必须按平台取对通道，否则采样会偏。
    const isWin = process.platform === "win32";
    let total = 0;
    let n = 0;
    for (let i = 0; i < bmp.length; i += 4) {
      const r = isWin ? bmp[i + 2] : bmp[i];
      const g = bmp[i + 1];
      const b = isWin ? bmp[i] : bmp[i + 2];
      total += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      n += 1;
    }
    return n ? total / n / 255 : null;
  } catch {
    return null;
  }
}

/** 向渲染进程广播运行状态，用于切换「停止任务」按钮显隐 */
function setRunning(v) {
  running = v;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("running", v);
  }
  // 运行状态变化时立即推一次数据，让卡片及时反映最新结果
  pushAccounts();
}

/* ============ 每账号运行态（转圈 / 排队 / 橙感叹号 / 红错误） ============ */

/**
 * 账号 id -> { status, reason, at }
 * status: "running" 正在工作 | "waiting" 排队等待 | "warning" 需要注意 | "error" 发生错误
 * 空闲账号不在 Map 中（前端不显示任何标记）。
 */
const runStatus = new Map();
let fingerprintInstallController = null;
/** 批次运行中、用户在排队阶段就要求「停止此账号」的 id 集合（轮到时直接跳过） */
const batchSkip = new Set();

/** 设置/清除某账号运行态并广播；status 传 "idle" 表示清除（不显示标记） */
function setAccountStatus(id, status, reason) {
  const key = String(id);
  if (status === "idle" || !status) {
    runStatus.delete(key);
  } else {
    runStatus.set(key, { status, reason: reason || "", at: Date.now() });
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("account-status", {
      id: key,
      status: status === "idle" || !status ? "idle" : status,
      reason: reason || "",
    });
  }
}

/**
 * 根据 runner 批次/单账号的结束信息判定终态。
 * @returns {{status:"warning"|"error", reason:string}|null} null 表示回到空闲（不标记）
 */
function classifyOutcome(info) {
  if (!info) return null;
  // 用户主动停止（整批 / 单个 / 排队中跳过）不算错误，回到无标记
  if (info.aborted || info.abortAll || info.skipped) return null;
  // 业务阻断但拿到了 result（如 IP 非大陆）→ 橙色「需要注意」
  if (info.ok === false) {
    if (info.error && !info.result) return { status: "error", reason: info.reason || info.error || "运行失败" };
    return { status: "warning", reason: info.reason || "需要注意" };
  }
  // 任务级状态：真正报错 → 红；需要人工介入（未授权/收入受限/需重试）→ 橙
  const tasks = (info.result && info.result.tasks) || {};
  for (const k of Object.keys(tasks)) {
    const t = tasks[k];
    if (t && t.status === "error") {
      return { status: "error", reason: t.error || "任务执行出错" };
    }
  }
  for (const k of Object.keys(tasks)) {
    const t = tasks[k];
    if (!t) continue;
    if (t.unauthorized) return { status: "warning", reason: "未授权，请重新登录后再运行" };
    if (t.status === "restricted") return { status: "warning", reason: "搜索任务收入受限" };
    if (t.status === "retry") return { status: "warning", reason: "部分任务未完成，稍后会自动重试" };
  }
  return null;
}

/** 把 runner 的 end 信息落到账号状态上 */
function applyOutcome(id, info) {
  const verdict = classifyOutcome(info);
  setAccountStatus(id, verdict ? verdict.status : "idle", verdict ? verdict.reason : "");
}

/**
 * 串行运行一批账号（账号间随机 20–60 秒），统一维护每账号状态。
 * 调用方需自行做 running 全局锁判断。
 */
async function runIds(ids, interactive, opts = {}) {
  const valid = [];
  for (const rawId of ids || []) {
    const id = String(rawId);
    if (accounts.get(id)) valid.push(id);
  }
  if (valid.length === 0) return { ok: false, error: "请先选择要运行的账户" };

  cancel.reset();
  batchSkip.clear();
  // 预置：第一个立即工作，其余排队（轮到时 start 回调改为 working）
  valid.forEach((id, i) => setAccountStatus(id, i === 0 ? "running" : "waiting"));
  setRunning(true);
  try {
    const results = await runner.runBatch(valid, {
      interactive,
      minGap: 20,
      maxGap: 60,
      // force：「立即一次性完成全部任务」忽略单次数量限制（limits.read/promos）
      force: opts.force === true,
      shouldSkip: (id) => batchSkip.has(String(id)),
      onPhase: (id, _name, phase, info) => {
        if (phase === "start") {
          batchSkip.delete(String(id));
          setAccountStatus(id, "running");
        } else if (phase === "end") {
          applyOutcome(id, info || {});
        }
        // phase === "waiting" 时其余账号保持 waiting，无需处理
      },
    });
    return { ok: true, results };
  } catch (e) {
    if (e && e.isAbort) {
      logger.warn("任务已被手动停止");
      return { ok: false, aborted: true, error: "任务已停止" };
    }
    logger.error(`运行失败: ${e.message}`);
    return { ok: false, error: e.message };
  } finally {
    // 兜底：批次结束后仍停留在 running/waiting 的账号复位（正常不会走到）
    for (const id of valid) {
      const s = runStatus.get(id);
      if (s && (s.status === "running" || s.status === "waiting")) setAccountStatus(id, "idle");
    }
    setRunning(false);
  }
}

/**
 * 主动把最新账户数据推给渲染进程
 *
 * 之前卡片只在用户点按钮后才刷新（renderer 主动 listAccounts），
 * 任务在后台跑时界面完全不动，看起来像「不自动刷新」。
 */
function pushAccounts() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("accounts", accounts.describeAll());
  } catch (e) {
    logger.warn(`推送账户数据失败: ${e.message}`);
  }
}

/** 推送 Chromium 就绪状态，让侧边栏徽标在安装完成后自动刷新 */
function pushChromiumStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("chromium-status", {
      ready: browser.isChromiumReady(),
      executable: browser.chromiumExecutablePath(),
    });
  } catch (e) {
    logger.warn(`推送 Chromium 状态失败: ${e.message}`);
  }
}

/** 推送指纹浏览器状态（可选组件，未安装时 ready=false） */
function pushFingerprintStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // status() 现在是 async（镜像下拉要带实测延迟）；状态推送本来就是通知性质，失败忽略
  Promise.resolve(fpBrowser.status())
    .then((s) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("fingerprint-status", s);
      }
    })
    .catch((e) => logger.warn(`推送指纹浏览器状态失败: ${e.message}`));
}

/** 启动周期性推送：任务运行中 3 秒一次，空闲时 10 秒一次 */
let pushTimer = null;
let pushTick = 0;
function startAutoPush() {
  if (pushTimer) clearInterval(pushTimer);
  pushTick = 0;
  pushTimer = setInterval(() => {
    pushTick++;
    // 运行中每 3 秒推；空闲时每 9 秒推一次（降低无谓 IO）
    if (running || pushTick % 3 === 0) pushAccounts();
  }, 3000);
}

function stopAutoPush() {
  if (pushTimer) clearInterval(pushTimer);
  pushTimer = null;
}

function createWindow(show = true) {
  // 尽量一次展示完整账户表和更多内容；小屏不超出工作区，仍可手动缩小。
  const { width: workWidth, height: workHeight } = screen.getPrimaryDisplay().workAreaSize;
  const opts = {
    width: Math.min(1440, workWidth),
    height: Math.min(900, workHeight),
    minWidth: Math.min(940, workWidth),
    minHeight: Math.min(600, workHeight),
    title: `MS Rewards 自动任务 v${displayVersion()}`,
    backgroundColor: "#11141a",
    show,
    webPreferences: {
      preload: path.join(__dirname, "electron-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  // 显式给窗口/任务栏图标（signAndEditExecutable:false 时不能指望 exe 内嵌图标）
  const winIcon = loadAppIcon();
  if (winIcon) opts.icon = winIcon;

  mainWindow = new BrowserWindow(opts);

  // 标题栏带版本号，由主进程统一管；页面自己的 <title> 不再覆盖窗口标题
  mainWindow.on("page-title-updated", (e) => e.preventDefault());

  // 去掉 File/Edit/View/Window/Help 默认菜单栏
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAutoHideMenuBar(true);

  // 关闭窗口：按「关闭行为」分派——exit 放行真正退出；tray 隐藏驻留托盘；
  // ask 拦截后让前端弹选项卡（记住选择 / 退出到托盘 / 完全退出）。
  // forceQuit 置位（托盘「退出」或选项卡「完全退出」）时放行，允许真正关闭。
  mainWindow.on("close", (e) => {
    if (forceQuit) return;
    const action = launch.get().closeAction;
    if (action === "exit") return;
    e.preventDefault();
    if (action === "tray") {
      mainWindow.hide();
      return;
    }
    // 渲染层还没起来时收不到询问事件，先当驻留处理，避免启动瞬间点 × 直接丢进程
    if (mainWindow.webContents.isLoading()) {
      mainWindow.hide();
      return;
    }
    mainWindow.webContents.send("app:close-prompt");
  });

  // 开发模式优先走 Vite dev server（热更新），未运行时自动回落到构建产物
  void loadRenderer();
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  // 外链用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // 冒烟测试模式：加载完成后等待 init() 异步渲染，再探查关键 DOM
  if (IS_SMOKE) {
    mainWindow.webContents.on("did-finish-load", () => {
      console.log("GUI_LOADED_OK");
      // 2.5s 等待 refreshOverview / switchView 渲染完成
      setTimeout(async () => {
        try {
          const probe = await mainWindow.webContents.executeJavaScript(`(async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const r = {};
            // 仪表盘表格行数（有账户时 >0）
            const tbody = document.querySelector("#d-tbody");
            r.dRows = tbody ? tbody.children.length : -1;
            // 当前激活导航
            const act = document.querySelector(".nav-item.active");
            r.activeNav = act ? act.dataset.view : null;
            // 切到全局设置：表单工厂应注入完整表单
            document.querySelector('.nav-item[data-view="settings"]').click();
            await sleep(400);
            r.globalForm = !!document.querySelector("#g-search-api");
            r.gViewVisible = !document.getElementById("view-settings").hidden;
            // 切到账户详情：下拉、状态条、use-global 开关就位
            document.querySelector('.nav-item[data-view="account"]').click();
            await sleep(600);
            const sel = document.getElementById("acc-select");
            r.accOptions = sel ? sel.options.length : 0;
            r.ugSwitch = !!document.getElementById("use-global");
            r.ugChecked = (() => { const el = document.getElementById("use-global"); return el ? el.checked : null; })();
            r.aViewVisible = !document.getElementById("view-account").hidden;
            // 模拟关闭「遵循全局设置」：独立设置表单应注入并显示
            const ug = document.getElementById("use-global");
            if (ug) {
              ug.checked = false;
              ug.dispatchEvent(new Event("change", { bubbles: true }));
              await sleep(700);
              r.aFormShown = !document.getElementById("acc-settings").hidden;
              r.aFormInjected = !!document.querySelector("#a-search-api");
              // 恢复为遵循全局，避免污染真实配置
              ug.checked = true;
              ug.dispatchEvent(new Event("change", { bubbles: true }));
              await sleep(300);
              r.restored = document.getElementById("acc-settings").hidden === true;
            }
            // 切回仪表盘收尾
            document.querySelector('.nav-item[data-view="dashboard"]').click();
            await sleep(200);

            // ===== 次要功能探查（不写真实数据）=====

            // 表格搜索框存在 + 输入后过滤（不验证行数变化，只验证不报错）
            const search = document.getElementById("acc-search");
            r.searchBox = !!search;
            if (search) {
              search.value = "__nomatch__";
              search.dispatchEvent(new Event("input", { bubbles: true }));
              await sleep(50);
              r.searchFiltered = document.querySelectorAll("#d-tbody tr").length;
              search.value = "";
              search.dispatchEvent(new Event("input", { bubbles: true }));
              await sleep(50);
            }

            // 顶部按钮全在
            r.btnRefresh = !!document.getElementById("btn-refresh");
            r.btnRunAll = !!document.getElementById("btn-run-all");
            r.btnStop = !!document.getElementById("btn-stop");

            // 日志面板：开关 + resizer + console 容器
            r.logResizer = !!document.getElementById("log-resizer");
            r.logConsole = !!document.querySelector(".log-console");
            r.btnToggleLog = !!document.getElementById("btn-toggle-log");
            r.btnClearLog = !!document.getElementById("btn-clear-log");
            // 点一下开关日志，验证显隐切换不报错 + collapsed class 翻转
            const tl = document.getElementById("btn-toggle-log");
            if (tl) {
              const consoleEl = document.querySelector(".log-console");
              const beforeCollapsed = consoleEl ? consoleEl.classList.contains("collapsed") : null;
              tl.click();
              await sleep(100);
              const afterCollapsed = consoleEl ? consoleEl.classList.contains("collapsed") : null;
              r.logToggled = beforeCollapsed !== afterCollapsed;
              // 再点回去恢复初始状态
              tl.click();
              await sleep(50);
            }

            // 自动缩放：--fs-base 已设
            r.fsBase = getComputedStyle(document.documentElement).getPropertyValue("--fs-base").trim();

            // 新增账号 modal：点按钮 → askText 弹 modal → 点取消（不创建）
            const btnAdd = document.getElementById("btn-add");
            if (btnAdd) {
              btnAdd.click();
              await sleep(250);
              r.addModalShown = !document.getElementById("modal-mask").hidden;
              r.addModalTitle = document.getElementById("modal-title").textContent;
              r.addModalInputVisible = !document.getElementById("modal-input").hidden;
              // 点取消关闭
              document.getElementById("modal-cancel").click();
              await sleep(150);
              r.addModalClosed = document.getElementById("modal-mask").hidden;
            }

            // 账户详情页按钮全在
            document.querySelector('.nav-item[data-view="account"]').click();
            await sleep(200);
            r.btnLogin = !!document.getElementById("btn-login");
            r.btnSync = !!document.getElementById("btn-sync");
            r.btnRun = !!document.getElementById("btn-run");
            r.btnDelete = !!document.getElementById("btn-delete");

            return r;
          })()`);

          console.log("SMOKE_PROBE " + JSON.stringify(probe));
          const bad = !probe.activeNav || probe.dRows < 0 || !probe.globalForm
            || !probe.gViewVisible || probe.accOptions < 0 || !probe.ugSwitch
            || probe.ugChecked === null || !probe.aViewVisible
            || probe.aFormShown !== true || probe.aFormInjected !== true
            || probe.restored !== true
            || !probe.searchBox || probe.searchFiltered === undefined
            || !probe.btnRefresh || !probe.btnRunAll || !probe.btnStop
            || !probe.logResizer || !probe.logConsole || !probe.btnToggleLog
            || !probe.btnClearLog || !probe.logToggled || !probe.fsBase
            || !probe.addModalShown || probe.addModalTitle !== "新增账号"
            || !probe.addModalInputVisible || !probe.addModalClosed
            || !probe.btnLogin || !probe.btnSync || !probe.btnRun || !probe.btnDelete;
          app.exit(bad ? 2 : 0);
        } catch (e) {
          console.error("SMOKE_PROBE_FAIL " + e.message);
          app.exit(3);
        }
      }, 2500);
    });
    mainWindow.webContents.on("did-fail-load", (_e, code, desc) => {
      console.error(`GUI_LOAD_FAIL ${code} ${desc}`);
      app.exit(1);
    });
    mainWindow.webContents.on("render-process-gone", (_e, details) => {
      console.error("RENDER_PROCESS_GONE " + JSON.stringify(details));
      app.exit(1);
    });
    mainWindow.webContents.on("console-message", (_e, level, message) => {
      if (level >= 2) {
        console.error(`RENDER_CONSOLE_${level}: ${message}`);
        app.exit(1);
      }
    });
  }
}

/**
 * 确保主窗口存在（已存在则直接返回，避免重复创建）。
 * @param {boolean} show 创建时是否立即显示（驻留托盘场景传 false）
 */
function ensureWindow(show = true) {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  createWindow(show);
  return mainWindow;
}

/** 把已隐藏/最小化的窗口恢复到前台 */
function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * 启动后台工作：自动运行守护、卡片周期推送、Chromium 缺失时后台安装。
 * 只在首次激活时执行一次（backgroundStarted 守卫），避免重复启动定时器。
 */
function startBackgroundWork() {
  if (backgroundStarted) return;

  // 保险库锁着时不要启动自动任务：登录态解不出来，跑了也是白跑，
  // 反而可能把「未登录」的结果写回去。这里刻意不置 backgroundStarted，
  // 解锁后由 vault:unlock / vault:setup 再次调用本函数补启动。
  if (vault.isConfigured() && !vault.isUnlocked()) {
    logger.warn("保险库未解锁，自动任务守护暂不启动");
    return;
  }

  backgroundStarted = true;

  // 启动自动运行守护（按各账户 schedule 模式循环触发）
  daemonStop = runner.startDaemon({
    isBusy: () => running,
    onRunStart: (acc) => {
      if (acc) setAccountStatus(acc.id, "running");
      setRunning(true);
    },
    onRunEnd: (acc, gr) => {
      if (acc) {
        const info = gr && gr.result
          ? { ok: gr.result.ok !== false, result: gr.result, reason: gr.result.reason || "", aborted: false }
          : { ok: false, aborted: !!(gr && gr.aborted), abortAll: !!(gr && gr.abortAll), error: (gr && gr.error) || "运行失败" };
        applyOutcome(acc.id, info);
      }
      setRunning(false);
    },
  });

  // 启动账户数据周期推送（卡片自动刷新，无需手动点按钮）
  if (!IS_SMOKE) startAutoPush();

  // 启动时自动检测 Chromium，未就绪则后台安装（不阻塞 UI）
  if (!IS_SMOKE && !browser.isChromiumReady()) {
    logger.info("检测到 Chromium 未安装，后台开始自动安装…");
    ensureDeps.onProgress((p) => {
      try { mainWindow?.webContents?.send("install-progress", p); } catch {}
    });
    ensureDeps.ensureChromium(browser)
      .then((r) => {
        logger.info(`后台 Chromium 安装结果: method=${r.method}, ready=${r.ready}`);
        // 安装完推送一次 Chromium 状态 + 账户数据，让侧边栏徽标刷新
        pushChromiumStatus();
        pushAccounts();
      })
      .catch((e) => logger.error(`后台 Chromium 安装失败: ${e.message}`));
  }

  // 首次运行自动下载指纹浏览器（默认已启用；未安装时后台下载约 181MB，不阻塞 UI）
  if (!IS_SMOKE && globalConfig.get()?.browser?.fingerprint?.enable && !fpBrowser.isReady() && !fingerprintInstallController) {
    logger.info("检测到指纹浏览器未安装且已默认启用，后台开始自动下载…");
    fingerprintInstallController = new AbortController();
    fpBrowser.install({
      mirror: globalConfig.get()?.browser?.fingerprint?.mirror,
      signal: fingerprintInstallController.signal,
      onProgress: (p) => {
        try { mainWindow?.webContents?.send("install-progress", p); } catch {}
      },
    })
      .then((r) => {
        logger.info(`后台指纹浏览器安装结果: ok=${r.ok}, skipped=${r.skipped || false}, canceled=${r.canceled || false}`);
        pushFingerprintStatus();
      })
      .catch((e) => logger.error(`后台指纹浏览器安装失败: ${e && e.message ? e.message : e}`))
      .finally(() => {
        fingerprintInstallController = null;
      });
  }
}

/**
 * 激活应用：建窗 + 显示（除非要求隐藏）+ 启动后台工作。
 * @param {boolean} startHidden 是否以隐藏方式启动（驻留托盘场景）
 */
function activateApp(startHidden) {
  ensureWindow(!startHidden);
  if (!startHidden) showWindow();
  startBackgroundWork();
}

/** 构建托盘右键菜单 */
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: "显示主窗口", click: () => activateApp(false) },
    { type: "separator" },
    { label: "退出", click: () => { forceQuit = true; app.quit(); } },
  ]);
}

/** 托盘/窗口图标路径候选：打包后取 resources 下经 extraResources 释放的 ico，
 *  开发时回落项目 build/icon.ico。返回第一个存在且非空的图标。 */
function loadAppIcon() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "icon.ico")]
    : [path.join(ROOT, "build", "icon.ico")];
  for (const p of candidates) {
    try {
      const img = nativeImage.createFromPath(p);
      if (img && !img.isEmpty()) return img;
    } catch {
      /* 试下一个 */
    }
  }
  return undefined;
}

/** 创建系统托盘（带图标与菜单）。图标缺失时跳过，返回 null */
function createTray() {
  if (tray) return tray;
  const icon = loadAppIcon();
  if (!icon) {
    logger.warn("托盘图标缺失，跳过托盘创建");
    return null;
  }
  tray = new Tray(icon);
  tray.setToolTip("MS Rewards 自动任务");
  tray.setContextMenu(buildTrayMenu());
  // 左键点击：窗口可见则收起到托盘，否则唤出（与多数桌面软件一致）
  tray.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      activateApp(false);
    }
  });
  return tray;
}

/* ---------------- IPC ---------------- */

/**
 * 保险库闸门。
 *
 * 已启用加密但未解锁时，任何「要动登录态」的操作都必须挡住：
 * 解不出 Cookie 就跑任务，只会被判定为未登录，甚至把空结果写回去冲掉会话。
 * @returns {{ok:false,error:string}|null} null 表示放行
 */
function vaultGuard() {
  if (!vault.isConfigured()) return null;
  if (vault.isUnlocked()) return null;
  return { ok: false, error: "保险库已锁定，请先解锁后再执行该操作" };
}

function registerIpc() {
  ipcMain.handle("accounts:list", () => {
    try {
      return accounts.describeAll();
    } catch (e) {
      logger.error(`读取账户列表失败: ${e.message}`);
      return [];
    }
  });

  ipcMain.handle("accounts:create", (_e, name) => {
    try {
      const meta = accounts.create(name);
      logger.info(`已创建账户「${meta.name}」`);
      return meta;
    } catch (e) {
      logger.error(`创建账户失败: ${e.message}`);
      return { error: e.message };
    }
  });
  ipcMain.handle("accounts:remove", (_e, id) => {
    logger.clearAccountHistory(id);
    accounts.remove(id);
    return true;
  });
  ipcMain.handle("account:clearData", (_e, id) => {
    if (running) return { ok: false, error: "任务运行中，暂时不能清除账号数据" };
    const acc = accounts.get(id);
    if (!acc) return { ok: false, error: "账户不存在" };
    try {
      logger.clearAccountHistory(id);
      accounts.clearData(id);
      logger.info(`账户「${acc.name}」的用户数据已清除`);
      pushAccounts();
      return { ok: true };
    } catch (e) {
      logger.error(`清除账户「${acc.name}」数据失败: ${e.message}`);
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle("accounts:rename", (_e, id, name) => {
    accounts.rename(id, name);
    return true;
  });
  ipcMain.handle("accounts:setEnabled", (_e, id, enabled) => {
    accounts.setEnabled(id, enabled);
    return true;
  });

  ipcMain.handle("account:getConfig", (_e, id) => accounts.context(id).config.get());
  ipcMain.handle("account:setConfig", (_e, id, patch) => accounts.context(id).config.set(patch));
  ipcMain.handle("account:getOverrides", (_e, id) => accounts.context(id).config.getOverrides());
  ipcMain.handle("account:setUseGlobal", (_e, id, v) => {
    const acc = accounts.get(id);
    const r = accounts.context(id).config.setUseGlobal(v);
    logger.info(`账户「${acc ? acc.name : id}」已切换为${v ? "遵循全局设置" : "独立设置"}`);
    pushAccounts();
    return r;
  });

  // ---- 全局设置 ----
  ipcMain.handle("global:getConfig", () => globalConfig.get());
  ipcMain.handle("global:setConfig", (_e, patch) => {
    const r = globalConfig.set(patch);
    if (patch && patch.logging) logger.cleanupHistory(r.logging?.retentionDays || 7);
    // 全局值变了，遵循全局的账户其有效配置随之改变，立刻推一次让界面同步
    pushAccounts();
    return r;
  });

  // ---- 仪表盘聚合 ----
  ipcMain.handle("app:overview", () => {
    try {
      return accounts.overview();
    } catch (e) {
      logger.error(`读取概览数据失败: ${e.message}`);
      return { accounts: [], stats: {} };
    }
  });


  ipcMain.handle("account:login", async (_e, id) => {
    const vg = vaultGuard();
    if (vg) return vg;
    if (running) return { ok: false, error: "已有任务正在运行，请稍候" };
    const acc = accounts.get(id);
    if (!acc) return { ok: false, error: "账户不存在" };
    setRunning(true);
    // 授权登录的日志同样归属到该账号（详情页「运行日志」可见）
    logger.setContext(id, acc.name);
    logger.info(`开始为「${acc.name}」授权登录（弹出独立干净浏览器）...`);
    try {
      const { code, loggedIn } = await browser.loginInteractive(accounts.context(id));
      if (code) {
        const token = await auth.exchangeCode(accounts.context(id), code);
        return {
          ok: !!token,
          loggedIn,
          message: token
            ? loggedIn
              ? "授权成功，登录状态已同步"
              : "授权成功，但未捕获到 bing 认证 Cookie，可点「⟳ 刷新状态」重试"
            : "授权码换取 token 失败",
        };
      }
      return { ok: false, loggedIn, message: "未捕获授权码" };
    } catch (e) {
      logger.error(`登录失败: ${e.message}`);
      return { ok: false, error: e.message };
    } finally {
      logger.clearContext();
      setRunning(false);
    }
  });

  // 手动刷新登录状态（重新读取浏览器 Cookie）
  ipcMain.handle("account:sync", async (_e, id) => {
    const vg = vaultGuard();
    if (vg) return vg;
    if (running) return { ok: false, error: "已有任务正在运行，请稍候" };
    const acc = accounts.get(id);
    if (!acc) return { ok: false, error: "账户不存在" };
    setRunning(true);
    setAccountStatus(id, "running");
    // 设置账号日志上下文：刷新过程的日志归属到该账号，
    // 详情页「运行日志」才会显示（环形缓冲 + account-log 实时推送）
    logger.setContext(id, acc.name);
    logger.info(`正在刷新「${acc.name}」的登录状态...`);
    try {
      const ctx = accounts.context(id);
      const r = await browser.syncCookies(ctx);
      // 登录态正常时顺便拉取一次积分余额与今日合计，刷新卡片数据
      if (r.loggedIn) {
        try {
          // 跨天先清零昨日累计，避免旧数据混入今日合计
          if (ctx.state.resetIfNewDay()) {
            logger.info("检测到新的一天，已重置每日积分累计");
          }
          const info = await rewards.getRewardsInfo(ctx);
          if (info && info.ok) {
            const st = ctx.state.get();
            if (info.balance > 0) st.lastBalance = info.balance;
            if (Number.isFinite(info.todayTotal)) {
              st.todayPointsServer = info.todayTotal;
              st.todayPoints = info.todayTotal;
            }
            // 搜索进度：无条件写入（国区 m.max 为 0，用 >0 判断会导致永不更新）
            if (info.pc) st.pc = { progress: info.pc.progress, max: info.pc.max };
            if (info.m) st.m = { progress: info.m.progress, max: info.m.max };
            // describe() 只在 lastRunDate === 今天 时才采信服务器值，
            // 这里同步成功即视为今日已有数据，否则刚拉到的值会被忽略
            st.lastRunDate = ctx.state.getDateNum();
            ctx.state.save();
            logger.success(
              `积分已刷新：总积分 ${info.balance}，今日已得 ${info.todayTotal}，PC搜索 ${info.pc.progress}/${info.pc.max}`
            );
          } else {
            logger.warn("积分信息获取失败，卡片数据未更新");
          }

          // 顺便刷新阅读进度（需要 access token，失败不影响主流程）
          try {
            const token = await auth.ensureAccessToken(ctx, false);
            if (token) {
              const rp = await rewards.getReadPro(ctx, token);
              if (rp && rp.ok) {
                const st2 = ctx.state.get();
                st2.readPoint = rp.progress;
                st2.readArticles = { done: rp.articlesDone, total: rp.articlesTotal };
                ctx.state.save();
                logger.success(`阅读进度已刷新：${rp.articlesDone}/${rp.articlesTotal} 篇（${rp.progress}/${rp.max} 分）`);
              }
            }
          } catch (e) {
            logger.warn(`刷新阅读进度失败: ${e.message}`);
          }
        } catch (e) {
          logger.warn(`刷新积分余额失败: ${e.message}`);
        }
      }
      setAccountStatus(id, r.loggedIn ? "idle" : "warning", r.loggedIn ? "" : "未检测到登录态");
      return {
        ok: true,
        loggedIn: r.loggedIn,
        message: r.loggedIn ? "登录状态已同步：已登录" : "未检测到登录态，请点「授权登录」重新登录",
      };
    } catch (e) {
      logger.error(`刷新状态失败: ${e.message}`);
      setAccountStatus(id, "error", e.message || "刷新状态失败");
      return { ok: false, error: e.message };
    } finally {
      const s = runStatus.get(String(id));
      if (s && s.status === "running") setAccountStatus(id, "idle");
      logger.clearContext();
      setRunning(false);
    }
  });

  // 运行单个账号（走统一的串行/状态编排，单账号无账号间等待）
  // opts.force = true 时忽略「单次执行数量」限制，一轮把当天任务全部做完
  ipcMain.handle("account:run", async (_e, id, opts) => {
    const vg = vaultGuard();
    if (vg) return vg;
    if (running) return { ok: false, error: "已有任务正在运行，请稍候" };
    const acc = accounts.get(id);
    if (!acc) return { ok: false, error: "账户不存在" };
    const r = await runIds([id], true, opts || {});
    const single = (r.results || [])[0];
    if (r.ok && single) return { ok: single.ok !== false, result: single, aborted: single.reason === "已手动停止" || single.reason === "此账号任务已被手动停止" };
    return r;
  });

  // 运行全部已启用账号（串行 + 随机 20–60 秒）
  // opts.force = true 时忽略「单次执行数量」限制，一轮把当天任务全部做完
  ipcMain.handle("app:runAll", async (_e, opts) => {
    const vg = vaultGuard();
    if (vg) return vg;
    if (running) return { ok: false, error: "已有任务正在运行，请稍候" };
    const ids = accounts.list().filter((a) => a.enabled).map((a) => a.id);
    if (ids.length === 0) return { ok: false, error: "没有已启用的账户" };
    return runIds(ids, true, opts || {});
  });

  // 运行选中的账号（复选框批量；串行 + 随机 20–60 秒）
  ipcMain.handle("app:runSelected", async (_e, ids) => {
    const vg = vaultGuard();
    if (vg) return vg;
    if (running) return { ok: false, error: "已有任务正在运行，请稍候" };
    if (!Array.isArray(ids) || ids.length === 0) return { ok: false, error: "请先勾选要运行的账户" };
    return runIds(ids, true);
  });

  // 停止当前任务（全部）
  ipcMain.handle("app:stop", () => {
    if (!running) return { ok: false, error: "当前没有正在运行的任务" };
    logger.warn("收到停止指令，正在中断当前任务...");
    cancel.abort();
    return { ok: true };
  });

  // 只停止单个账号：正在执行则中断该账号作用域；仍在排队则标记轮到时跳过
  ipcMain.handle("account:stop", (_e, id) => {
    const key = String(id);
    const acc = accounts.get(key);
    if (!acc) return { ok: false, error: "账户不存在" };
    const st = runStatus.get(key);
    if (!st) return { ok: false, error: "该账号当前没有在执行的任务" };
    if (st.status === "running") {
      cancel.abortScope(key);
      logger.warn(`正在停止账户「${acc.name}」的任务…`);
    } else if (st.status === "waiting") {
      batchSkip.add(key);
      setAccountStatus(key, "idle");
      logger.info(`账户「${acc.name}」已从排队中移除。`);
    } else {
      return { ok: false, error: "该账号当前没有在执行的任务" };
    }
    return { ok: true };
  });

  ipcMain.handle("app:isRunning", () => running);

  // 每账号运行态（渲染端打开界面时拉一次做初始化）
  ipcMain.handle("app:getRunStatus", () => {
    const out = {};
    for (const [id, s] of runStatus.entries()) out[id] = s;
    return out;
  });

  // 取某账号的最近日志（详情页只显示该账号）
  ipcMain.handle("app:getAccountLogs", (_e, id) => {
    try {
      return logger.getAccountLogs(id);
    } catch {
      return [];
    }
  });

  ipcMain.handle("app:getAccountLogDays", (_e, id) => {
    try {
      const retentionDays = globalConfig.get()?.logging?.retentionDays || 7;
      return logger.listAccountLogDays(id, retentionDays);
    } catch {
      return [];
    }
  });

  ipcMain.handle("app:getAccountLogHistory", (_e, id, day) => {
    try {
      const retentionDays = globalConfig.get()?.logging?.retentionDays || 7;
      return logger.getAccountHistory(id, day, retentionDays);
    } catch {
      return [];
    }
  });

  ipcMain.handle("app:getLogs", () => {
    try {
      const file = logger.getLogFile();
      const content = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
      return content.split("\n").filter(Boolean).slice(-500).map((line) => logger.sanitizeText(line));
    } catch {
      return [];
    }
  });

  ipcMain.handle("app:chromiumStatus", () => ({
    ready: browser.isChromiumReady(),
    executable: browser.chromiumExecutablePath(),
  }));

  // ---- 指纹浏览器（可选增强，见 src/fingerprint-browser.js）----
  ipcMain.handle("app:fingerprintStatus", () => fpBrowser.status());
  ipcMain.handle("app:installFingerprint", async (_e, opts) => {
    if (running) return { ok: false, error: "已有任务正在运行，请稍候" };
    if (fingerprintInstallController) return { ok: false, error: "指纹浏览器正在下载，请稍候" };
    fingerprintInstallController = new AbortController();
    setRunning(true);
    try {
      const result = await fpBrowser.install({
        force: !!(opts && opts.force),
        // 镜像源由全局配置决定（设置页可改），IPC 层不单独传，避免两处口径不一致
        mirror: globalConfig.get()?.browser?.fingerprint?.mirror,
        signal: fingerprintInstallController.signal,
        onProgress: (p) => {
          try {
            mainWindow?.webContents?.send("install-progress", p);
          } catch {}
        },
      });
      pushFingerprintStatus();
      return result;
    } catch (e) {
      const canceled = !!(e && e.canceled);
      if (!canceled) logger.error(`指纹浏览器安装失败: ${e.message}`);
      pushFingerprintStatus();
      return { ok: false, canceled, error: canceled ? "下载已取消" : e.message };
    } finally {
      fingerprintInstallController = null;
      setRunning(false);
    }
  });

  ipcMain.handle("app:cancelFingerprintInstall", () => {
    if (!fingerprintInstallController) return { ok: false, error: "当前没有正在下载的指纹浏览器" };
    fingerprintInstallController.abort();
    return { ok: true };
  });

  ipcMain.handle("app:uninstallFingerprint", () => {
    const r = fpBrowser.uninstall();
    pushFingerprintStatus();
    return r;
  });

  // 「检查更新」只查询不下载（0.9.4.18 修：此前按钮直连 install(force) 会重下 181MB）
  ipcMain.handle("app:checkFingerprintUpdate", () => fpBrowser.checkUpdate());

  // 应用本身更新检查：查询 GitHub Releases 最新正式版（自动走 gh-proxy 加速）。
  // 「立即更新」当前只打开 Release 页，不在主进程内下载/替换本体。
  ipcMain.handle("app:checkAppUpdate", () => appUpdate.checkAppUpdate(displayVersion()));

  // ---- 外观个性化 ----
  ipcMain.handle("appearance:get", () => appearance.get());

  // 当前背景图地址（bing 类型内部按天解析并缓存）。返回 { src, luma }，
  // luma 为壁纸平均亮度（0–1），渲染端 autoTheme 据此模拟两套主题色合成后的
  // 文字对比度，自动选深/浅主题保证文字可读。
  ipcMain.handle("appearance:bg-src", async (_e, opts) => {
    try {
      // opts: { fresh } —— 换一张/轮换到期时强制重新拉取随机图
      const src = await backgroundSrc(opts);
      let luma = null;
      if (src) {
        try {
          luma = await sampleLuminance(src);
        } catch {
          luma = null;
        }
      }
      return { src, luma };
    } catch (e) {
      logger.warn(`背景图解析失败: ${e.message}`);
      return { src: "", luma: null };
    }
  });

  // 选择本地图片：弹原生文件框，选中后直接设为背景
  ipcMain.handle("appearance:pickImage", async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: "选择背景图片",
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "gif", "avif"] }],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const next = appearance.set({ bgType: "file", bgFile: r.filePaths[0] });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("appearance", next);
    return { ok: true, appearance: next };
  });

  // 测试自定义图片地址：跟随重定向，返回最终状态与类型
  ipcMain.handle("appearance:testUrl", async (_e, url) => {
    try {
      const r = await downloadImage(url, null, { maxBytes: 2 * 1024 * 1024, headOnly: true });
      return { ok: r.ok, status: r.status, contentType: r.contentType, finalUrl: r.finalUrl, error: r.error };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 下载当前壁纸到本地（弹保存位置对话框）
  ipcMain.handle("appearance:downloadWallpaper", async (_e, url) => {
    if (!url) return { ok: false, error: "当前没有可下载的背景" };
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const r0 = await dialog.showSaveDialog(mainWindow, {
      title: "保存壁纸",
      defaultPath: path.join(app.getPath("downloads") || app.getPath("home"), `wallpaper-${stamp}.jpg`),
      filters: [
        { name: "JPEG 图片", extensions: ["jpg", "jpeg"] },
        { name: "PNG 图片", extensions: ["png"] },
        { name: "WebP 图片", extensions: ["webp"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (r0.canceled || !r0.filePath) return { ok: false, canceled: true };
    try {
      // 远端图源已被缓存成本地文件（见 backgroundSrc），此时直接复制即可
      if (/^file:/i.test(url)) {
        const srcPath = fileURLToPath(url);
        if (!fs.existsSync(srcPath)) return { ok: false, error: "缓存文件已丢失，请重新加载壁纸" };
        fs.copyFileSync(srcPath, r0.filePath);
        return { ok: true, path: r0.filePath, bytes: fs.statSync(srcPath).size };
      }
      const r = await downloadImage(url, r0.filePath);
      if (!r.ok) return { ok: false, error: r.error || `HTTP ${r.status}` };
      return { ok: true, path: r0.filePath, bytes: r.bytes };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 把一段文本（如恢复密钥）存成 txt：弹出保存位置对话框，由用户决定存哪
  ipcMain.handle("app:saveTextFile", async (_e, text, defaultName) => {
    if (typeof text !== "string" || !text) return { ok: false, error: "没有可保存的内容" };
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const name = typeof defaultName === "string" && defaultName ? defaultName : `recovery-key-${stamp}`;
    const r0 = await dialog.showSaveDialog(mainWindow, {
      title: "保存为 txt 文件",
      defaultPath: path.join(app.getPath("downloads") || app.getPath("home"), `${name}.txt`),
      filters: [
        { name: "文本文件", extensions: ["txt"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (r0.canceled || !r0.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(r0.filePath, text, "utf-8");
      return { ok: true, path: r0.filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("appearance:set", (_e, patch) => {
    // 切背景源后旧的 bing 缓存仍可复用（同一天），不必清
    const next = appearance.set(patch || {});
    // 所有外观项（预设/主题色/深浅模式/透明度/氛围光/背景图）都是 CSS 层
    // 的变化，直接把最新外观推给渲染进程让它重画，热切换无需重启。
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("appearance", next);
    }
    return { ok: true, appearance: next, restartNeeded: false };
  });

  // ---- 启动与托盘 ----
  ipcMain.handle("launch:get", () => launch.get());

  ipcMain.handle("launch:set", (_e, patch) => {
    const next = launch.set(patch || {});
    // 立即把设置同步到系统登录项（注册/取消开机自启）
    launch.syncLoginItems(app, next);
    return next;
  });

  // ---- 关闭主窗口的「每次询问」选项卡 ----
  // choice: tray=隐藏到托盘 / exit=真正退出；remember=true 时把该选择存为默认关闭行为
  ipcMain.handle("app:close-choice", (_e, choice, remember) => {
    const v = choice === "exit" ? "exit" : "tray";
    if (remember === true) launch.set({ closeAction: v });
    if (v === "exit") {
      forceQuit = true;
      app.quit();
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
    return { ok: true };
  });

  // ---- 首次启动向导 ----
  ipcMain.handle("setup:get", () => setup.get());

  ipcMain.handle("setup:set", (_e, patch) => {
    const p = patch || {};
    const next = setup.set(p);
    // 向导里的初始选择要立刻落到对应子系统，而不是只记下来：
    // 液态玻璃写进外观（并推给渲染端重画），开机自启/隐藏到托盘同步到系统登录项。
    if (p.liquidGlass !== undefined) {
      const ap = appearance.set({ glass: next.liquidGlass });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("appearance", ap);
      }
    }
    if (p.autoLaunch !== undefined || p.launchToTray !== undefined) {
      launch.syncLoginItems(app, launch.set({
        autoLaunch: next.autoLaunch,
        launchToTray: next.launchToTray,
      }));
    }
    return next;
  });

  // ---- 保险库：登录态加密存储 ----
  // 未配置保险库时整体不启用加密（保持旧版明文行为），
  // 一旦配置，登录态只以密文落盘，且未解锁前一律禁止读写会话。
  ipcMain.handle("vault:status", () => vault.status());

  ipcMain.handle("vault:setup", (_e, password, hint) => {
    const r = vault.setup(password, hint);
    if (r.ok) {
      // 建库后立刻把存量明文登录态搬进保险库，并清掉遗留的明文 profile
      vaultMigrate.migrateAll();
      startBackgroundWork();
      pushAccounts();
    }
    return r;
  });

  ipcMain.handle("vault:unlock", (_e, password) => {
    const r = vault.unlock(password);
    if (r.ok) {
      // 上次锁着没能迁移的数据，这次补上
      vaultMigrate.migrateAll();
      startBackgroundWork();
      pushAccounts();
    }
    return r;
  });

  ipcMain.handle("vault:unlockRecovery", (_e, key) => {
    const r = vault.unlockWithRecovery(key);
    if (r.ok) {
      vaultMigrate.migrateAll();
      startBackgroundWork();
      pushAccounts();
    }
    return r;
  });

  ipcMain.handle("vault:lock", () => {
    vault.lock();
    pushAccounts();
    return vault.status();
  });

  ipcMain.handle("vault:changePassword", (_e, cur, next, hint) =>
    vault.changePassword(cur, next, hint)
  );

  /** 取恢复密钥：仅限已解锁时，避免成为绕过密码的后门（内部会轮换一把新的） */
  ipcMain.handle("vault:recoveryKey", () => vault.getRecoveryKey());

  /**
   * 忘记密码时的退路之一：有恢复密钥 → 直接重置密码（无需原密码）。
   * 重置成功后主密钥不变，已加密的账户数据无需重写。
   */
  ipcMain.handle("vault:resetPasswordWithRecovery", (_e, key, next, hint) => {
    const r = vault.resetPasswordWithRecovery(key, next, hint);
    if (r.ok) {
      // 重置后保险库处于解锁态，补一次迁移并恢复后台工作
      vaultMigrate.migrateAll();
      startBackgroundWork();
      pushAccounts();
    }
    return r;
  });

  /**
   * 忘记密码时的退路之二：密钥也没了 → 清空账号数据回到可用状态。
   * 会连保险库一起删除（密码与密钥都丢了，它已经解不开），但保留个性化设置。
   */
  ipcMain.handle("app:wipeAccountData", () => {
    if (running) return { ok: false, error: "任务运行中，请先停止任务再清空数据" };
    const r = wipe.wipeAccountData();
    if (r.ok) {
      pushAccounts();
      // 保险库已删除 → 让渲染端重新拉一次状态（锁屏自然消失）
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("vault-status", vault.status());
      }
    }
    return r;
  });

  // ---- 每日一言（界面取当天那一句，与推送共用同一份按天缓存）----
  ipcMain.handle("hitokoto:get", async () => {
    try {
      return await hitokoto.get();
    } catch {
      return null;
    }
  });

  // ---- 推送测试 ----
  ipcMain.handle("notify:test", async (_e, notice) => {
    try {
      return await notify.testPush(notice || {}, "界面");
    } catch (e) {
      logger.error(`推送测试失败: ${e.message}`);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("app:installBrowser", async () => {
    if (running) return { ok: false, error: "已有任务正在运行，请稍候" };
    setRunning(true);
    // 把安装进度实时推到渲染进程
    ensureDeps.onProgress((p) => {
      try { mainWindow?.webContents?.send("install-progress", p); } catch {}
    });
    try {
      const result = await ensureDeps.ensureChromium(browser);
      logger.info(`Chromium 安装完成: method=${result.method}, ready=${result.ready}`);
      pushChromiumStatus();
      return { ok: result.ready, method: result.method, error: result.error };
    } catch (e) {
      logger.error(`Chromium 安装失败: ${e.message}`);
      pushChromiumStatus();
      return { ok: false, error: e.message };
    } finally {
      setRunning(false);
    }
  });
}

/* ---------------- 生命周期 ---------------- */
app.whenReady().then(() => {
  // 彻底移除 File/Edit/View/Window/Help 菜单栏。
  // setMenuBarVisibility(false) 只是隐藏，Alt 键仍能唤出；
  // 把应用菜单整个置空才是真的没有。
  Menu.setApplicationMenu(null);

  registerIpc();

  // 保险库自动解锁：先试系统钥匙串（日常免密），再试环境变量（Docker 场景）。
  // 都失败就保持锁定，等用户在界面输密码后再启动自动任务。
  vault.tryAutoUnlock();
  if (vault.isUnlocked()) vaultMigrate.migrateAll();

  const launchCfg = launch.get();
  // 确保系统登录项与保存的设置一致（例如被其它方式改过注册表）
  launch.syncLoginItems(app, launchCfg);

  // 全局日志实时推送到渲染进程（外部全局日志面板）
  logger.onLog((line) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("log", line);
    }
  });

  // 结构化日志（携带 accountId）推给渲染进程，详情页按账号过滤显示各自日志
  logger.onEntry((entry) => {
    if (mainWindow && !mainWindow.isDestroyed() && entry.accountId != null) {
      mainWindow.webContents.send("account-log", entry);
    }
  });

  // 托盘：常驻，提供「显示主窗口 / 退出」入口；配合关闭到托盘实现驻留
  createTray();

  // 判断本次启动来源：是否由系统登录项触发
  const loginInfo = app.getLoginItemSettings();
  const launchedAtLogin = loginInfo.wasOpenedAtLogin;
  // 以下任一为真则本次以隐藏方式启动（驻留托盘）：
  //   1) 由登录项触发且配置了「开机后驻留托盘」
  //   2) 系统判定为「以隐藏方式启动」（macOS openAsHidden）
  //   3) 启动参数带 --hidden（Windows 下 openAsHidden 不生效时的兜底）
  const startedHidden =
    (launchedAtLogin && launchCfg.launchToTray) ||
    loginInfo.wasOpenedAsHidden ||
    process.argv.includes("--hidden");

  if (launchedAtLogin && launchCfg.launchDelay > 0) {
    // 随系统启动：延迟 launchDelay 秒再激活，错峰避免抢开机资源
    logger.info(`随系统启动：延迟 ${launchCfg.launchDelay}s 后激活（驻留托盘=${launchCfg.launchToTray}）`);
    setTimeout(() => activateApp(startedHidden), launchCfg.launchDelay * 1000);
  } else {
    activateApp(startedHidden);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) activateApp(false);
  });
});

app.on("window-all-closed", () => {
  if (daemonStop) { daemonStop(); daemonStop = null; }
  stopAutoPush();
  app.quit();
});
