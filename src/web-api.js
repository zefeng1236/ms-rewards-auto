/**
 * Web 版业务分发层（Docker / 无桌面场景）
 *
 * 与 electron-main.js 的 registerIpc() 一一对应：同一批业务模块，
 * 同一批方法名（刻意与 src-renderer/src/types/electron.d.ts 的 ElectronApi
 * 完全同名），这样前端那份 React 界面不用改一行就能同时跑在两端。
 *
 * 两版的差异只在「外壳」：
 *   Electron：ipcMain.handle  ←→  webContents.send
 *   Web     ：POST /api/rpc   ←→  SSE /api/events
 * 因此在 Electron 里依赖对话框 / 托盘 / nativeImage 的几处做了 Web 化：
 *   - pickImage / saveTextFile / downloadWallpaper → 交给浏览器（见前端 web.ts）
 *   - sampleLuminance → 交由前端 canvas 采样（同源图片不会污染画布）
 *   - backgroundSrc  → 返回 HTTP 地址而非 file://，否则浏览器加载不了
 *   - launch / closeChoice → 无桌面语义，保留读写但不注册登录项
 *
 * 纯 Node，不依赖 Electron。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const accounts = require("./account");
const globalConfig = require("./global-config");
const appearance = require("./appearance");
const launch = require("./launch");
const setup = require("./setup");
const vault = require("./vault");
const wipe = require("./wipe");
const browser = require("./browser");
const logger = require("./logger");
const notify = require("./notify");
const uapi = require("./uapi");
const core = require("./app-core");

/** 壁纸本地缓存目录（与 electron-main 保持一致：storage/cache） */
const BG_CACHE_DIR = path.join(path.dirname(appearance.FILE), "cache");
/** Web 上传的背景图目录（storage/uploads） */
const UPLOAD_DIR = path.join(path.dirname(appearance.FILE), "uploads");

/* ============================== 工具 ============================== */

/** 下载图片（跟随重定向），支持流式进度推送。destFile 为 null 时只探测不落盘 */
async function downloadImage(url, destFile, opts = {}) {
  const { maxBytes = 60 * 1024 * 1024, headOnly = false, onProgress } = opts;
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20000) });
  const ct = res.headers.get("content-type") || "";
  const isImage = /^image\//.test(ct);
  if (!res.ok) return { ok: false, status: res.status, contentType: ct, finalUrl: res.url, error: `HTTP ${res.status}` };
  if (!isImage) return { ok: false, status: res.status, contentType: ct, finalUrl: res.url, error: `返回类型不是图片（${ct || "未知"}）` };
  if (headOnly) {
    try { res.body.cancel(); } catch {}
    return { ok: true, status: res.status, contentType: ct, finalUrl: res.url };
  }
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
      const pct = Math.round((loaded / total) * 100);
      if (pct !== lastReport) {
        lastReport = pct;
        onProgress({ loaded, total, pct });
      }
    }
  }
  const buf = Buffer.concat(chunks);
  if (buf.length > maxBytes) return { ok: false, status: res.status, contentType: ct, finalUrl: res.url, error: "图片过大" };
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, buf);
  return { ok: true, status: res.status, contentType: ct, finalUrl: res.url, bytes: buf.length };
}

/** 当前背景下应请求的原始远程/本地地址（不含缓存逻辑） */
async function rawBackgroundSrc(cfg) {
  switch (cfg.bgType) {
    case "bing":
      return uapi.resolveBingDailyUrl();
    case "uapi":
      return uapi.randomImageUrl(cfg.bgCategory);
    case "qy98":
      return uapi.qy98WallpaperUrl();
    case "unsplash": {
      const key = (process.env.UNSPLASH_ACCESS_KEY || cfg.bgUnsplashKey || "").trim();
      return uapi.unsplashRandom(key);
    }
    default:
      return appearance.backgroundSrc();
  }
}

/** file:// 或本地绝对路径 → 本地文件系统路径；已是 http(s)/data 时返回空 */
function localPathFromSrc(src) {
  const s = String(src || "");
  if (/^https?:/i.test(s) || /^data:/i.test(s)) return "";
  if (/^file:/i.test(s)) {
    try { return require("url").fileURLToPath(s); } catch { return ""; }
  }
  return s;
}

/**
 * 当前背景应显示的图片地址（Web 版）。
 * 随机图源先缓存到本地（保证各处看到同一张），再返回可被浏览器加载的 HTTP 地址。
 * emitFn 可选：传入时下载过程会推送 bg-progress 事件给 SSE。
 */
async function bgSrc(opts = {}, emitFn) {
  const { fresh = false } = opts || {};
  const cfg = appearance.get();
  const url = await rawBackgroundSrc(cfg);
  if (!url) return "";
  if (/^data:/i.test(url)) return url;

  // 远程图源：缓存到本地固定一份
  if (/^https?:/i.test(url)) {
    const key = crypto.createHash("md5").update(`${cfg.bgType}|${cfg.bgCategory}|${url}`).digest("hex").slice(0, 16);
    const cacheName = `bg-${key}.img`;
    const cacheFile = path.join(BG_CACHE_DIR, cacheName);
    if (fresh || !fs.existsSync(cacheFile)) {
      try {
        fs.mkdirSync(BG_CACHE_DIR, { recursive: true });
        const r = await downloadImage(url, cacheFile, {
          onProgress: emitFn ? (info) => emitFn("bg-progress", info) : undefined,
        });
        if (!r.ok) logger.warn(`壁纸缓存失败: ${r.error || "未知错误"}`);
      } catch (e) {
        logger.warn(`壁纸缓存失败: ${e.message}`);
      } finally {
        if (emitFn) emitFn("bg-progress", { done: true });
      }
    }
    if (fs.existsSync(cacheFile)) return `/api/bg/cache?f=${encodeURIComponent(cacheName)}`;
    return url; // 缓存失败：直接把远程地址交给浏览器（可能受 CORS / 防盗链限制）
  }

  // 本地文件 / 上传文件：交给 /api/bg/local 流式返回
  const p = localPathFromSrc(url);
  if (!p) return "";
  return `/api/bg/local?p=${encodeURIComponent(p)}`;
}

/* ============================== 分发层 ============================== */

/**
 * @param {object} deps
 * @param {(type:string, payload:any)=>void} deps.emit  事件出口（SSE 广播）
 */
function createApi({ emit }) {
  const pushAccounts = () => core.pushAccounts();
  const pushChromiumStatus = () => core.pushChromiumStatus();

  /* ---- 把 app-core 与 logger 的事件转到 SSE ---- */
  core.on("running", (v) => emit("running", v));
  core.on("accounts", (list) => emit("accounts", list));
  core.on("account-status", (v) => emit("account-status", v));
  core.on("chromium-status", (v) => emit("chromium-status", v));
  logger.onLog((line) => emit("log", line));
  logger.onEntry((entry) => {
    if (entry && entry.accountId != null) emit("account-log", entry);
  });

  /** 周期性推送账户数据：运行中每 3 秒、空闲时每 9 秒（与桌面版一致） */
  let timer = null;
  let tick = 0;
  function startAutoPush() {
    if (timer) return;
    timer = setInterval(() => {
      tick++;
      if (core.isRunning() || tick % 3 === 0) pushAccounts();
    }, 3000);
    timer.unref?.();
  }

  /** 事件订阅者可直接调用的方法表 */
  const methods = {
    /* ---------------------------- 账户 ---------------------------- */
    listAccounts() {
      try { return accounts.describeAll(); } catch (e) { logger.error(`读取账户列表失败: ${e.message}`); return []; }
    },
    createAccount(name) {
      try {
        const meta = accounts.create(name);
        logger.info(`已创建账户「${meta.name}」`);
        pushAccounts();
        return meta;
      } catch (e) {
        logger.error(`创建账户失败: ${e.message}`);
        return { error: e.message };
      }
    },
    removeAccount(id) {
      logger.clearAccountHistory(id);
      accounts.remove(id);
      pushAccounts();
      return true;
    },
    clearAccountData(id) {
      if (core.isRunning()) return { ok: false, error: "任务运行中，暂时不能清除账号数据" };
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
    },
    renameAccount(id, name) {
      accounts.rename(id, name);
      pushAccounts();
      return true;
    },
    setAccountEnabled(id, enabled) {
      accounts.setEnabled(id, enabled);
      pushAccounts();
      return true;
    },

    /* ---------------------------- 配置 ---------------------------- */
    getConfig(id) {
      const acc = accounts.get(id);
      if (!acc) throw new Error("账户不存在");
      return accounts.context(id).config.get();
    },
    setConfig(id, patch) {
      const acc = accounts.get(id);
      if (!acc) throw new Error("账户不存在");
      const r = accounts.context(id).config.set(patch);
      pushAccounts();
      return r;
    },
    getOverrides(id) {
      const acc = accounts.get(id);
      if (!acc) throw new Error("账户不存在");
      return accounts.context(id).config.getOverrides();
    },
    setUseGlobal(id, v) {
      const acc = accounts.get(id);
      const r = accounts.context(id).config.setUseGlobal(v);
      logger.info(`账户「${acc ? acc.name : id}」已切换为${v ? "遵循全局设置" : "独立设置"}`);
      pushAccounts();
      return r;
    },
    getGlobalConfig() {
      return globalConfig.get();
    },
    setGlobalConfig(patch) {
      const r = globalConfig.set(patch);
      if (patch && patch.logging) logger.cleanupHistory(r.logging?.retentionDays || 7);
      pushAccounts();
      return r;
    },

    /* --------------------------- 仪表盘 --------------------------- */
    overview() {
      try { return accounts.overview(); } catch (e) {
        logger.error(`读取概览数据失败: ${e.message}`);
        return { accounts: [], stats: {} };
      }
    },

    /* ---------------------------- 外观 ---------------------------- */
    getAppearance() {
      return appearance.get();
    },
    setAppearance(patch) {
      const next = appearance.set(patch || {});
      emit("appearance", next);
      return { ok: true, appearance: next, restartNeeded: false };
    },
    async getBgSrc(opts) {
      try {
        const src = await bgSrc(opts, emit);
        // luma 由前端 canvas 采样（同源图片不污染画布），服务端不重复解码
        return { src, luma: null };
      } catch (e) {
        logger.warn(`背景图解析失败: ${e.message}`);
        return { src: "", luma: null };
      }
    },
    /** 保存前端上传的背景图，返回落盘绝对路径（由前端写入 bgFile） */
    saveUploadedImage(name, base64) {
      const buf = Buffer.from(String(base64 || ""), "base64");
      if (!buf.length) return { ok: false, error: "空文件" };
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const safe = String(name || "bg").replace(/[^\w.\-]/g, "_").slice(-40) || "bg";
      const file = path.join(UPLOAD_DIR, `${Date.now()}-${safe}`);
      fs.writeFileSync(file, buf);
      logger.info(`背景图已上传: ${safe}（${(buf.length / 1024).toFixed(0)}KB）`);
      const next = appearance.set({ bgType: "file", bgFile: file });
      emit("appearance", next);
      return { ok: true, path: file, appearance: next };
    },
    async testBgUrl(url) {
      try {
        const r = await downloadImage(url, null, { maxBytes: 2 * 1024 * 1024, headOnly: true });
        return { ok: r.ok, status: r.status, contentType: r.contentType, finalUrl: r.finalUrl, error: r.error };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    /* --------------------------- 启动托盘 --------------------------- */
    getLaunch() {
      return launch.get();
    },
    setLaunch(patch) {
      // 无桌面环境：只持久化偏好，不注册系统登录项
      return launch.set(patch || {});
    },
    closeChoice() {
      return { ok: true, note: "Web 版无窗口关闭语义，已忽略" };
    },

    /* --------------------------- 首次向导 --------------------------- */
    getSetup() {
      return setup.get();
    },
    setSetup(patch) {
      const p = patch || {};
      const next = setup.set(p);
      // 向导里的液态玻璃选择要立刻落到外观，界面才看得到效果
      if (p.liquidGlass !== undefined) {
        const ap = appearance.set({ glass: next.liquidGlass });
        emit("appearance", ap);
      }
      return next;
    },

    /* ---------------------------- 保险库 ---------------------------- */
    getVaultStatus() {
      const st = vault.status();
      // Web 语义：会话还在才叫「已解锁」—— 保险库密钥是进程级的，
      // 但每个浏览器仍要各自登录一次，否则刷新页面就等于免密进入。
      return { ...st, unlocked: st.configured ? hasSession() : st.unlocked };
    },
    vaultLock() {
      vault.lock();
      pushAccounts();
      return vault.status();
    },
    vaultChangePassword(cur, next, hint) {
      return vault.changePassword(cur, next, hint);
    },
    vaultRecoveryKey() {
      return vault.getRecoveryKey();
    },
    // 忘记密码：用恢复密钥重置密码（无需原密码）
    vaultResetPasswordWithRecovery(key, next, hint) {
      const r = vault.resetPasswordWithRecovery(key, next, hint);
      if (r.ok) {
        vaultMigrate.migrateAll();
        pushAccounts();
      }
      return r;
    },
    // 忘记密码且密钥也丢失：清空账号数据（含保险库），保留个性化设置
    wipeAccountData() {
      const r = wipe.wipeAccountData();
      if (r.ok) pushAccounts();
      return r;
    },

    /* ---------------------------- 通知 ---------------------------- */
    async testPush(notice) {
      try {
        return await notify.testPush(notice || {}, "界面");
      } catch (e) {
        logger.error(`推送测试失败: ${e.message}`);
        return { ok: false, error: e.message };
      }
    },

    /* ---------------------------- 任务 ---------------------------- */
    login(id) { return core.loginInteractive(id); },
    run(id) { return core.runOne(id); },
    runAll() { return core.runAllEnabled(); },
    runSelected(ids) { return core.runSelected(ids); },
    sync(id) { return core.syncAccount(id); },
    stop() { return core.stopAll(); },
    stopAccount(id) { return core.stopAccount(id); },
    isRunning() { return core.isRunning(); },
    getRunStatus() { return core.runStatusSnapshot(); },

    /* --------------------------- 日志环境 --------------------------- */
    getLogs() {
      try {
        const file = logger.getLogFile();
        const content = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
        return content.split("\n").filter(Boolean).slice(-500).map((line) => logger.sanitizeText(line));
      } catch {
        return [];
      }
    },
    getAccountLogs(id) {
      try { return logger.getAccountLogs(id); } catch { return []; }
    },
    getAccountLogDays(id) {
      try {
        const retentionDays = globalConfig.get()?.logging?.retentionDays || 7;
        return logger.listAccountLogDays(id, retentionDays);
      } catch { return []; }
    },
    getAccountLogHistory(id, day) {
      try {
        const retentionDays = globalConfig.get()?.logging?.retentionDays || 7;
        return logger.getAccountHistory(id, day, retentionDays);
      } catch { return []; }
    },
    chromiumStatus() {
      return { ready: browser.isChromiumReady(), executable: browser.chromiumExecutablePath() };
    },
    installBrowser() {
      // 容器内 Chromium 由镜像 apt 安装，无需再下载
      return { ok: browser.isChromiumReady(), method: "preinstalled", executable: browser.chromiumExecutablePath() };
    },

    /* --------------------------- Web 专属 --------------------------- */
    /** 登出：只销毁本浏览器会话，保险库保持解锁，后台任务不受影响 */
    logout() {
      return { ok: true, note: "会话已销毁，保险库仍保持解锁，后台任务不受影响" };
    },
  };

  /** 方法名白名单：防止前端拼错方法名时静默成功 */
  const KNOWN = new Set(Object.keys(methods));

  async function dispatch(m, a) {
    if (!KNOWN.has(m)) throw new Error(`未知方法: ${m}`);
    const args = Array.isArray(a) ? a : [];
    return methods[m](...args);
  }

  return { dispatch, methods, KNOWN, startAutoPush, pushAccounts, pushChromiumStatus, bgSrc };
}

module.exports = { createApi, BG_CACHE_DIR, UPLOAD_DIR, downloadImage };
