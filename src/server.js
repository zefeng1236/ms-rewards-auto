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
 *   MS_REWARDS_PORT                     监听端口（默认 25560）
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 外部 Chromium 路径（apt 安装时用）
 *   MS_REWARDS_CHROMIUM_ARGS            额外 Chromium 启动参数
 */

// ① 存储目录必须在业务模块 require 之前确定
if (!process.env.MS_REWARDS_STORAGE_DIR) {
  process.env.MS_REWARDS_STORAGE_DIR = "/data/storage";
}

const net = require("net");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const browser = require("./browser");
const cancel = require("./cancel");
const setup = require("./setup");
const vault = require("./vault");
const vaultMigrate = require("./vault/migrate");
const passkey = require("./passkey");
const wipe = require("./wipe");
const logger = require("./logger");
const core = require("./app-core");
const runner = require("./runner");
const webApi = require("./web-api");

const PORT = Number(process.env.MS_REWARDS_PORT) || 25560;
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

/**
 * 本地凭据文件自动解锁（Docker 无人值守场景）。
 *
 * 语义（用户确认）：Docker 版的意义是常年不断电自动跑任务，锁定的价值在于
 * 「防止他人改设置 / 加账号」，而不是「防重启后任务停摆」。所以重启后守护
 * 进程用 storage/vault-autounlock.key（600 权限，存恢复密钥）自己解锁开跑；
 * 管理面（设置/账号增删）仍受会话保护。
 *
 * 安全边界：该文件与 vault.json 同目录 —— 能偷到数据目录的攻击者本来就能
 * 拿到恢复密钥，所以这不新增攻击面，只是把「重启即停摆」换成「重启即续跑」。
 * 文件只在 MS_REWARDS_VAULT_AUTOUNLOCK_FILE=1 时读取（compose 显式开启），
 * 桌面版不 require server.js，天然不受影响。
 */
const AUTOUNLOCK_FILE = () => path.join(process.env.MS_REWARDS_STORAGE_DIR || path.join(__dirname, "..", "storage"), "vault-autounlock.key");

function tryFileAutoUnlock() {
  if (process.env.MS_REWARDS_VAULT_AUTOUNLOCK_FILE !== "1") return false;
  const f = AUTOUNLOCK_FILE();
  if (!fs.existsSync(f)) return false;
  try {
    const b64 = fs.readFileSync(f, "utf8").trim();
    if (!b64) return false;
    const r = vault.unlockWithVkB64(b64);
    return !!(r && r.ok);
  } catch (e) {
    logger.warn(`本地凭据文件自动解锁失败: ${e.message}`);
    return false;
  }
}

/** 解锁成功后写回自动解锁凭据（仅 Docker 显式开启时）。
 *  存的是 vk（解锁密钥）而非恢复密钥：任何解锁路径（密码/恢复密钥/Passkey）
 *  之后都能写回，不必依赖建库时的一次性恢复密钥。权限 600，与 vault.json 同信任级。 */
function writeAutoUnlockFile() {
  if (process.env.MS_REWARDS_VAULT_AUTOUNLOCK_FILE !== "1") return;
  try {
    const b64 = vault.exportVkB64();
    if (!b64) return;
    const f = AUTOUNLOCK_FILE();
    fs.writeFileSync(f, b64 + "\n", { mode: 0o600 });
    try { fs.chmodSync(f, 0o600); } catch {}
  } catch (e) {
    logger.warn(`写入自动解锁凭据失败: ${e.message}`);
  }
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

/** 登录完成页：Chromium 登录成功后导航到这里，noVNC 里显示大字提示 */
const LOGIN_DONE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录已完成</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0f1923; color: #e0f0e8;
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    text-align: center;
  }
  .card { padding: 48px 64px; }
  .icon { font-size: 96px; margin-bottom: 24px; }
  h1 { font-size: 48px; font-weight: 700; margin-bottom: 16px; color: #5eeaad; }
  p { font-size: 24px; color: #8fa8a0; line-height: 1.6; }
</style>
</head>
<body>
<div class="card">
  <div class="icon">✅</div>
  <h1>登录已完成</h1>
  <p>请返回控制台继续操作</p>
</div>
</body>
</html>`;

function serveLoginDone(res) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(LOGIN_DONE_HTML);
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
    if (method === "GET" && p === "/login-done") return serveLoginDone(res);

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
        version: require("./version").displayVersion(),
        chromium: browser.isChromiumReady(),
        vaultConfigured: vault.isConfigured(),
        vaultUnlocked: vault.isUnlocked(),
        daemon: backgroundStarted,
        tls: !!(process.env.MS_REWARDS_TLS_CERT && fs.existsSync(process.env.MS_REWARDS_TLS_CERT)),
        passkey: passkey.hasCredentials(),
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
        version: require("./version").displayVersion(),
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
        writeAutoUnlockFile();
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
        writeAutoUnlockFile();
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
        writeAutoUnlockFile();
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
        try { fs.rmSync(AUTOUNLOCK_FILE(), { force: true }); } catch {}
        core.pushAccounts();
      }
      return json(res, r.ok ? 200 : 400, r);
    }

    /* ---------- Passkey（WebAuthn）：注册要会话，登录不要 ---------- */
    if (p === "/api/passkey/status") {
      return json(res, 200, { ok: true, data: passkey.status() });
    }
    if (p === "/api/passkey/auth-options" && method === "POST") {
      return json(res, 200, passkey.authOptions(req));
    }
    if (p === "/api/passkey/auth" && method === "POST") {
      const r = passkey.auth(req, await readBody(req));
      if (r.ok) {
        newSession(res);
        startBackgroundWork();
        writeAutoUnlockFile();
        core.pushAccounts();
      }
      return json(res, r.ok ? 200 : 400, r);
    }
    if (p === "/api/passkey/register-options" && method === "POST") {
      if (needLogin(req)) return json(res, 401, { ok: false, error: "未登录", needLogin: true });
      return json(res, 200, passkey.registerOptions(req));
    }
    if (p === "/api/passkey/register" && method === "POST") {
      if (needLogin(req)) return json(res, 401, { ok: false, error: "未登录", needLogin: true });
      return json(res, 200, passkey.register(req, await readBody(req)));
    }
    if (p === "/api/passkey/remove" && method === "POST") {
      if (needLogin(req)) return json(res, 401, { ok: false, error: "未登录", needLogin: true });
      const { id } = await readBody(req);
      return json(res, 200, passkey.removeCredential(id));
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
        "fingerprintStatus",
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
          data: {
            ...st,
            unlocked: st.configured ? hasSession(req) : st.unlocked,
            passkey: passkey.status(),
            tls: !!(process.env.MS_REWARDS_TLS_CERT && fs.existsSync(process.env.MS_REWARDS_TLS_CERT)),
          },
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
    } else if (tryFileAutoUnlock()) {
      logger.ok("保险库已通过本地凭据文件自动解锁（重启后任务照常运行）");
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

  // TLS：MS_REWARDS_TLS_CERT/KEY 指向证书与私钥时走 https（Docker 自签场景，
  // Passkey/WebAuthn 要求安全上下文）。两者缺一或未设置 → 明文 http（本地开发）。
  //
  // 同端口协议分流：TLS 打开时，同一个 25560 端口既要服务 HTTPS，又要把误用
  // http:// 访问的旧链接 302 跳转到 https —— 否则浏览器会看到 ERR_EMPTY_RESPONSE。
  // 做法：起一个裸 net.Server 先窥探每个连接的首字节（TLS 握手记录头恒为 0x16），
  // 是 TLS 就交给 https.Server，否则交给一个只回 302 的 http.Server。
  const tlsCert = process.env.MS_REWARDS_TLS_CERT || "";
  const tlsKey = process.env.MS_REWARDS_TLS_KEY || "";
  const tlsReady = !!(tlsCert && tlsKey && fs.existsSync(tlsCert) && fs.existsSync(tlsKey));
  let server;
  if (tlsReady) {
    // 明文 HTTP 重定向：302 到同主机同路径的 https 地址
    const redirectApp = http.createServer((req, res) => {
      const host = req.headers.host || "localhost";
      res.writeHead(302, { Location: `https://${host}${req.url}` });
      res.end();
    });
    const httpsApp = https.createServer(
      { cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) },
      handle
    );
    const tcp = net.createServer((socket) => {
      const route = () => {
        const first = socket.read(1);
        if (!first) {
          socket.once("readable", route);
          return;
        }
        socket.unshift(first);
        // TLS 握手记录 ContentType 固定为 0x16；明文 HTTP 首字节是 GET/POST 等 ASCII
        if (first[0] === 0x16) httpsApp.emit("connection", socket);
        else redirectApp.emit("connection", socket);
      };
      socket.once("readable", route);
      socket.on("error", () => {});
    });
    tcp.listen(PORT, "0.0.0.0", () => {
      process.env.MS_REWARDS_HTTP_LISTENING = String(PORT);
      logger.ok(`服务已启动: https://0.0.0.0:${PORT}（http 访问自动 302 跳转 https）`);
    });
    server = tcp;
  } else {
    if (tlsCert || tlsKey) logger.warn("TLS 证书/私钥路径不完整或文件缺失，回退明文 HTTP");
    server = http.createServer(handle);
    server.listen(PORT, "0.0.0.0", () => {
      // 监听成功后打 sentinel，供 browser.js 判别「这个进程是不是 Web/Docker server」——
      // 桌面版（electron-main）不 require ./server，25560 不会起，goto /login-done 必 ECONNREFUSED，
      // 跳过即可。
      process.env.MS_REWARDS_HTTP_LISTENING = String(PORT);
      logger.ok(`服务已启动: http://0.0.0.0:${PORT}`);
    });
  }

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
