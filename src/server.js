#!/usr/bin/env node
/**
 * Docker / 无桌面场景的 Web 服务入口
 *
 * 与 electron-main.js 的关系：同一套业务逻辑的两个「外壳」。
 * 这里不引入任何 Electron API，业务全部走纯 Node 模块
 * （account / config / runner / tasks / rewards / vault / browser / app-core）。
 *
 * 前端就是桌面版那份 React 界面（src-renderer）构建出来的产物，
 * 通过 src-renderer/src/api/web.ts 把 window.api 换成 HTTP + SSE，
 * 因此两端 UI 完全一致、不再有两套界面要维护。
 *
 * 启动顺序很关键：
 *   1. 必须在 require 任何业务模块之前定好 MS_REWARDS_STORAGE_DIR
 *      —— vault/index.js 在模块加载时就把 vault.json 路径算死了
 *   2. 保险库默认「未解锁」，等用户在 Web 向导 / 登录页输入密码
 *      （也支持 MS_REWARDS_VAULT_PASSWORD / _KEY 环境变量注入，便于无人值守）
 *   3. 解锁后才启动自动任务守护（与桌面版同一闸门，防止空登录态覆盖真实会话）
 *
 * 环境变量：
 *   MS_REWARDS_STORAGE_DIR              存储根目录（容器内默认 /data/storage）
 *   MS_REWARDS_VAULT_PASSWORD           保险库密码（可选，注入后自动解锁）
 *   MS_REWARDS_VAULT_KEY                恢复密钥（可选，与密码二选一）
 *   MS_REWARDS_PORT                     监听端口（默认 3000）
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 外部 Chromium 路径（apt 安装时用）
 *   MS_REWARDS_CHROMIUM_ARGS            额外 Chromium 启动参数
 */

// ① 存储目录必须在业务模块 require 之前确定
if (!process.env.MS_REWARDS_STORAGE_DIR) {
  process.env.MS_REWARDS_STORAGE_DIR = "/data/storage";
}

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const browser = require("./browser");
const cancel = require("./cancel");
const setup = require("./setup");
const vault = require("./vault");
const vaultMigrate = require("./vault/migrate");
const wipe = require("./wipe");
const logger = require("./logger");
const core = require("./app-core");
const runner = require("./runner");
const webApi = require("./web-api");

const PORT = Number(process.env.MS_REWARDS_PORT) || 3000;
/** React 前端产物目录（vite.web.config.ts 的 outDir） */
const SPA_DIR = path.join(__dirname, "web", "dist");
/** 产物缺失时的兜底轻量页面（保留了纯 REST 用法） */
const FALLBACK_PAGE = path.join(__dirname, "web", "index.html");

/* ============================== 会话 ============================== */

/**
 * 浏览器会话。
 *
 * 保险库密钥是「进程级」的（解锁一次，后台任务就能跑），
 * 会话只决定「这个浏览器要不要再输一次密码」。
 * 因此登出（logout）只销毁会话、不锁保险库 —— 后台定时任务不受影响。
 */
const sessions = new Set();
const SESSION_COOKIE = "msr_session";
const SESSION_TTL = 7 * 24 * 3600 * 1000; // 7 天

function newSession(res) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.add(token);
  res.setHeader("Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
  return token;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function hasSession(req) {
  const c = parseCookies(req);
  return !!(c[SESSION_COOKIE] && sessions.has(c[SESSION_COOKIE]));
}

function clearSession(req, res) {
  const c = parseCookies(req);
  if (c[SESSION_COOKIE]) sessions.delete(c[SESSION_COOKIE]);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** 保险库还没建（首次安装）时不要求登录，让向导能跑完 */
function needLogin(req) {
  if (!vault.isConfigured()) return false;
  return !hasSession(req);
}

/* ============================== 事件总线 ============================== */

/** SSE 客户端（每个连接一个 send 函数） */
const sseClients = new Set();

function emit(type, payload) {
  const data = `data: ${JSON.stringify({ type, payload })}\n\n`;
  for (const send of sseClients) {
    try { send(data); } catch {}
  }
}

const api = webApi.createApi({ emit });

/* ============================== 后台守护 ============================== */

let daemonStop = null;
let backgroundStarted = false;

function startBackgroundWork() {
  if (backgroundStarted) return;
  if (vault.isConfigured() && !vault.isUnlocked()) {
    logger.warn("保险库未解锁，自动任务守护暂不启动");
    return;
  }
  backgroundStarted = true;
  daemonStop = runner.startDaemon({
    isBusy: () => core.isRunning(),
    onRunStart: () => core.setRunning(true),
    onRunEnd: () => core.setRunning(false),
  });
  logger.info("自动任务守护已启动");
}

/* ================================ 工具 ================================ */

function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > limit) { req.destroy(); reject(new Error("请求体过大")); }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function sendFile(res, file, extraHeaders = {}) {
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", ...extraHeaders });
  fs.createReadStream(file).pipe(res);
}

/** 静态资源：优先 SPA 构建产物，其次轻量兜底页 */
function serveStatic(res, urlPath) {
  if (urlPath === "/" || urlPath === "/index.html") {
    const spa = path.join(SPA_DIR, "index.html");
    if (fs.existsSync(spa)) { sendFile(res, spa); return true; }
    if (fs.existsSync(FALLBACK_PAGE)) { sendFile(res, FALLBACK_PAGE); return true; }
    return false;
  }
  const rel = urlPath.replace(/^\/+/, "");
  const file = path.join(SPA_DIR, rel);
  // 防目录穿越
  if (!file.startsWith(SPA_DIR)) return false;
  if (fs.existsSync(file) && fs.statSync(file).isFile()) { sendFile(res, file); return true; }
  return false;
}

/** 图片代理：缓存目录内的文件（壁纸固定缓存） */
function serveBgCache(res, url) {
  const name = url.searchParams.get("f") || "";
  const file = path.join(webApi.BG_CACHE_DIR, path.basename(name));
  if (!file.startsWith(webApi.BG_CACHE_DIR) || !fs.existsSync(file)) { json(res, 404, { error: "not found" }); return; }
  sendFile(res, file, { "Cache-Control": "public, max-age=86400" });
}

/** 图片代理：本地图片（用户上传 / 自选），限定在存储目录内 */
function serveBgLocal(res, url) {
  const p = url.searchParams.get("p") || "";
  const root = path.resolve(process.env.MS_REWARDS_STORAGE_DIR);
  const file = path.resolve(p);
  if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    json(res, 403, { error: "路径不在存储目录内或文件不存在" });
    return;
  }
  sendFile(res, file, { "Cache-Control": "public, max-age=3600" });
}

/* ================================ 路由 ================================ */

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  const method = req.method.toUpperCase();

  try {
    /* ---------- 静态与图片代理（无需登录） ---------- */
    if (method === "GET" && p === "/api/bg/cache") return serveBgCache(res, url);
    if (method === "GET" && p === "/api/bg/local") return serveBgLocal(res, url);

    if (method === "GET" && !p.startsWith("/api")) {
      if (serveStatic(res, p)) return;
      // SPA 前端路由（hash 模式用不到，但静态托管时兜底一下）
      const spa = path.join(SPA_DIR, "index.html");
      if (fs.existsSync(spa)) { sendFile(res, spa); return; }
      return json(res, 404, { error: "not found" });
    }

    /* ---------- 健康检查 ---------- */
    if (p === "/api/health") {
      return json(res, 200, {
        ok: true,
        version: require("../package.json").version,
        chromium: browser.isChromiumReady(),
        vaultConfigured: vault.isConfigured(),
        vaultUnlocked: vault.isUnlocked(),
        daemon: backgroundStarted,
        spa: fs.existsSync(path.join(SPA_DIR, "index.html")),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        time: new Date().toISOString(),
      });
    }

    /* ---------- 登录前状态 ---------- */
    if (p === "/api/bootstrap") {
      return json(res, 200, {
        setup: setup.get(),
        vault: { ...vault.status(), unlocked: vault.isConfigured() ? hasSession(req) : vault.isUnlocked() },
        hasSession: hasSession(req),
        daemon: backgroundStarted,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        storage: process.env.MS_REWARDS_STORAGE_DIR,
        chromium: browser.isChromiumReady(),
        version: require("../package.json").version,
      });
    }

    /* ---------- SSE 事件流 ---------- */
    if (p === "/api/events") {
      if (needLogin(req)) return json(res, 401, { error: "未登录", needLogin: true });
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 3000\n\n");
      const send = (data) => res.write(data);
      sseClients.add(send);
      // 心跳：避免反代 / 容器网络把长连接判死
      const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 20000);
      hb.unref?.();
      req.on("close", () => {
        clearInterval(hb);
        sseClients.delete(send);
      });
      return;
    }

    /* ---------- 登录 / 建库 / 登出 ---------- */
    if (p === "/api/logout" && method === "POST") {
      clearSession(req, res);
      return json(res, 200, { ok: true, note: "会话已销毁，保险库仍保持解锁，后台任务不受影响" });
    }

    if (p === "/api/vault/setup" && method === "POST") {
      const { password, hint } = await readBody(req);
      const r = vault.setup(password, hint);
      if (r.ok) {
        vaultMigrate.migrateAll();
        newSession(res);          // 建库即登录
        startBackgroundWork();
        core.pushAccounts();
      }
      return json(res, r.ok ? 200 : 400, r);
    }

    if (p === "/api/vault/unlock" && method === "POST") {
      const { password, recoveryKey } = await readBody(req);
      const r = recoveryKey ? vault.unlockWithRecovery(recoveryKey) : vault.unlock(password);
      if (r.ok) {
        vaultMigrate.migrateAll();
        newSession(res);
        startBackgroundWork();
        core.pushAccounts();
        return json(res, 200, { ok: true, byEnv: false });
      }
      return json(res, 400, r);
    }

    /* ---------- 忘记密码的两条退路（无需登录会话） ---------- */

    // ① 有恢复密钥：直接重置密码，成功后顺带建立登录会话
    if (p === "/api/vault/reset" && method === "POST") {
      const { recoveryKey, next, hint } = await readBody(req);
      const r = vault.resetPasswordWithRecovery(recoveryKey, next, hint);
      if (r.ok) {
        vaultMigrate.migrateAll();
        newSession(res);
        startBackgroundWork();
        core.pushAccounts();
        return json(res, 200, { ok: true });
      }
      return json(res, 400, r);
    }

    // ② 密钥也没有：清空账号数据（含保险库），保留个性化设置
    if (p === "/api/vault/wipe" && method === "POST") {
      const r = wipe.wipeAccountData();
      if (r.ok) {
        clearSession(req, res);
        core.pushAccounts();
      }
      return json(res, r.ok ? 200 : 400, r);
    }

    /* ---------- 统一 RPC ---------- */
    if (p === "/api/rpc" && method === "POST") {
      const body = await readBody(req);
      const m = body && body.m;
      const a = body && body.a;
      if (!m) return json(res, 400, { ok: false, error: "缺少方法名" });

      // 登录前放行的方法：向导、锁屏、公共外观、浏览器状态
      const PRE_AUTH = new Set([
        "getSetup", "setSetup", "getVaultStatus",
        "getAppearance", "getBgSrc", "chromiumStatus", "testBgUrl",
      ]);
      if (!PRE_AUTH.has(m) && needLogin(req)) {
        return json(res, 401, { ok: false, error: "未登录或会话已过期", needLogin: true });
      }

      // 两个需要读写 Cookie 的方法在路由层处理，业务层不感知会话
      if (m === "getVaultStatus") {
        const st = vault.status();
        // Web 语义：保险库密钥是进程级的，但每个浏览器仍要各自登录一次，
        // 所以「已解锁」= 进程已解锁 且 本浏览器持有会话。
        return json(res, 200, {
          ok: true,
          data: { ...st, unlocked: st.configured ? hasSession(req) : st.unlocked },
        });
      }
      if (m === "logout") {
        clearSession(req, res);
        return json(res, 200, { ok: true, data: { ok: true, note: "会话已销毁，保险库仍保持解锁" } });
      }

      try {
        const data = await api.dispatch(m, a);
        return json(res, 200, { ok: true, data });
      } catch (e) {
        logger.error(`RPC ${m} 出错: ${e.message}`);
        return json(res, 200, { ok: false, error: e.message });
      }
    }

    return json(res, 404, { error: "unknown endpoint", path: p });
  } catch (e) {
    logger.error(`API ${method} ${p} 出错: ${e.message}`);
    return json(res, 500, { error: e.message });
  }
}

/* ================================ 启动 ================================ */

function main() {
  logger.info(`存储目录: ${process.env.MS_REWARDS_STORAGE_DIR}`);
  logger.info(`时区: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  if (fs.existsSync(path.join(SPA_DIR, "index.html"))) {
    logger.ok("检测到 React 前端产物，将以完整界面提供服务");
  } else {
    logger.warn("未找到 src/web/dist（React 产物），将回退到轻量兜底页；请先执行 npm run build:web:docker");
  }

  if (vault.isConfigured()) {
    if (vault.tryAutoUnlock()) {
      logger.ok("保险库已通过环境变量自动解锁");
      try { vaultMigrate.migrateAll(); } catch (e) { logger.warn(`明文迁移失败: ${e.message}`); }
    } else {
      logger.info("保险库已配置但未解锁，等待用户在 Web 界面输入密码");
    }
  } else {
    logger.info("保险库尚未创建，首次访问 Web 界面将进入安装向导");
  }

  if (!browser.isChromiumReady()) {
    logger.warn("Chromium 未就绪：容器内应已 apt 安装，请检查 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH");
  }

  startBackgroundWork();
  api.startAutoPush();
  cancel.reset();

  const server = http.createServer(handle);
  server.listen(PORT, "0.0.0.0", () => {
    logger.ok(`服务已启动: http://0.0.0.0:${PORT}`);
  });

  const shutdown = () => {
    logger.info("收到退出信号，正在停止…");
    if (daemonStop) daemonStop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
