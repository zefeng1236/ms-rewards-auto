const path = require("path");
const fs = require("fs");
const sp = require("./storage-path");

// 日志跟 storage 放在一起（打包后落在 userData 下，见 storage-path.js）
const LOG_DIR = path.join(sp.storageRoot, "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "app.log");
const ACCOUNT_LOG_DIR = path.join(LOG_DIR, "accounts");
const DEFAULT_RETENTION_DAYS = 7;

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(ACCOUNT_LOG_DIR)) fs.mkdirSync(ACCOUNT_LOG_DIR, { recursive: true });

// 每个账号在内存里保留的最近日志条数（环形缓冲）
const PER_ACCOUNT_MAX = 1000;

let currentTag = "";
/** 当前日志归属的账号上下文：{ id, name } 或 null（全局/调度日志） */
let currentAccount = null;
/** 账号 id -> 日志条目数组（环形） */
const accountBuffers = new Map();
/** 旧版行订阅（全局日志面板，收到的是拼好的整行字符串） */
const listeners = [];
/** 结构化订阅（主进程广播用），收到 { line, level, msg, time, accountId, accountName } */
const entryListeners = [];
let lastCleanupDay = "";

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 移除 Playwright/终端错误中的 ANSI 转义序列与不可见控制字符，保留换行和制表符。 */
function sanitizeText(value) {
  return String(value == null ? "" : value)
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function dateKey(time = timestamp()) {
  return String(time).slice(0, 10);
}

function safeAccountId(id) {
  return String(id == null ? "" : id).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function accountLogFile(id, day) {
  return path.join(ACCOUNT_LOG_DIR, safeAccountId(id), `${day}.jsonl`);
}

function appendAccountHistory(entry) {
  if (entry.accountId == null) return;
  try {
    const day = dateKey(entry.time);
    if (lastCleanupDay !== day) {
      lastCleanupDay = day;
      let retentionDays = DEFAULT_RETENTION_DAYS;
      try {
        retentionDays = require("./global-config").get()?.logging?.retentionDays || DEFAULT_RETENTION_DAYS;
      } catch {}
      cleanupHistory(retentionDays);
    }
    const file = accountLogFile(entry.accountId, day);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
  } catch {}
}

function normalizeRetentionDays(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : DEFAULT_RETENTION_DAYS;
}

function cleanupHistory(retentionDays = DEFAULT_RETENTION_DAYS) {
  const keep = normalizeRetentionDays(retentionDays);
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - keep + 1);
  try {
    for (const accountDir of fs.readdirSync(ACCOUNT_LOG_DIR, { withFileTypes: true })) {
      if (!accountDir.isDirectory()) continue;
      const dir = path.join(ACCOUNT_LOG_DIR, accountDir.name);
      for (const file of fs.readdirSync(dir)) {
        const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
        if (!m) continue;
        const day = new Date(`${m[1]}T00:00:00`);
        if (!Number.isNaN(day.getTime()) && day < cutoff) {
          fs.rmSync(path.join(dir, file), { force: true });
        }
      }
    }
  } catch {}
}

function write(level, color, msg) {
  const tag = currentTag ? ` ${currentTag}` : "";
  const time = timestamp();
  const cleanMsg = sanitizeText(msg);
  const cleanLevel = sanitizeText(level);
  const line = `[${time}] [${cleanLevel}]${tag} ${cleanMsg}`;
  if (process.stdout && process.stdout.isTTY) {
    console.log(`${color}${line}\x1b[0m`);
  } else {
    console.log(line);
  }
  try {
    fs.appendFileSync(LOG_FILE, line + "\n", "utf-8");
  } catch {}

  const accountId = currentAccount ? currentAccount.id : null;
  const accountName = currentAccount ? currentAccount.name : null;

  // 归属到具体账号的环形缓冲（全局日志不进任何账号缓冲）
  if (accountId != null) {
    let buf = accountBuffers.get(accountId);
    if (!buf) {
      buf = [];
      accountBuffers.set(accountId, buf);
    }
    buf.push({ time, level: cleanLevel, msg: cleanMsg, line, accountId, accountName });
    if (buf.length > PER_ACCOUNT_MAX) buf.splice(0, buf.length - PER_ACCOUNT_MAX);
  }

  const entry = { time, level: cleanLevel, msg: cleanMsg, line, accountId, accountName };
  appendAccountHistory(entry);

  for (const cb of listeners) {
    try { cb(line); } catch {}
  }
  for (const cb of entryListeners) {
    try { cb(entry); } catch {}
  }
}

const logger = {
  info: (msg) => write("INFO", "\x1b[36m", msg),
  log: (level, msg) => write(String(level).toUpperCase(), "\x1b[36m", msg),
  ok: (msg) => write("OK", "\x1b[32m", msg),
  success: (msg) => write("OK", "\x1b[32m", msg),
  warn: (msg) => write("WARN", "\x1b[33m", msg),
  error: (msg) => write("ERROR", "\x1b[31m", msg),
  /** 原始输出（不附加时间戳/标签，用于菜单等），不归属账号 */
  plain: (msg) => {
    const clean = sanitizeText(msg);
    console.log(clean);
    for (const cb of listeners) {
      try { cb(clean); } catch {}
    }
  },
  /** 为当前运行账户设置日志前缀标签（顺序执行时使用） */
  setTag: (tag) => { currentTag = tag ? String(tag) : ""; },
  /**
   * 设置当前日志归属的账号上下文（runner 在执行某账号前调用）。
   * 同时把行前缀标签设为 [账号名]，与旧行为保持一致。
   * @param {string|number|null} id
   * @param {string} [name]
   */
  setContext: (id, name) => {
    if (id == null) {
      currentAccount = null;
      currentTag = "";
      return;
    }
    const accName = name != null ? String(name) : "";
    currentAccount = { id: String(id), name: accName };
    currentTag = accName ? `[${accName}]` : "";
    if (!accountBuffers.has(String(id))) accountBuffers.set(String(id), []);
  },
  /** 清除账号上下文（账号间等待 / 批处理结束时调用） */
  clearContext: () => {
    currentAccount = null;
    currentTag = "";
  },
  /** 取某账号的最近日志（结构化条目副本），无记录返回空数组 */
  getAccountLogs: (id) => {
    const buf = accountBuffers.get(String(id));
    return buf ? buf.slice() : [];
  },
  /** 清空某账号的内存缓冲（历史文件保留）。 */
  clearAccountLogs: (id) => {
    if (id == null) return;
    accountBuffers.delete(String(id));
  },
  /** 列出某账号已有历史日志日期（新日期在前）。 */
  listAccountLogDays: (id, retentionDays = DEFAULT_RETENTION_DAYS) => {
    cleanupHistory(retentionDays);
    const dir = path.join(ACCOUNT_LOG_DIR, safeAccountId(id));
    try {
      return fs.readdirSync(dir)
        .map((name) => (/^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name) || [])[1])
        .filter(Boolean)
        .sort((a, b) => b.localeCompare(a));
    } catch {
      return [];
    }
  },
  /** 读取某账号指定日期的历史日志。 */
  getAccountHistory: (id, day, retentionDays = DEFAULT_RETENTION_DAYS) => {
    cleanupHistory(retentionDays);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ""))) return [];
    const file = accountLogFile(id, day);
    try {
      return fs.readFileSync(file, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            const entry = JSON.parse(line);
            return {
              ...entry,
              msg: sanitizeText(entry.msg),
              line: sanitizeText(entry.line),
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .slice(-PER_ACCOUNT_MAX);
    } catch {
      return [];
    }
  },
  /** 删除某账号的内存与磁盘历史日志。 */
  clearAccountHistory: (id) => {
    if (id == null) return;
    accountBuffers.delete(String(id));
    try { fs.rmSync(path.join(ACCOUNT_LOG_DIR, safeAccountId(id)), { recursive: true, force: true }); } catch {}
  },
  cleanupHistory,
  sanitizeText,
  /** 订阅日志行（GUI 全局日志实时推送） */
  onLog: (cb) => { listeners.push(cb); return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; },
  /**
   * 订阅结构化日志条目（携带 accountId，主进程广播 account-log 用）
   * @returns {() => void} 退订函数
   */
  onEntry: (cb) => { entryListeners.push(cb); return () => { const i = entryListeners.indexOf(cb); if (i >= 0) entryListeners.splice(i, 1); }; },
  getLogFile: () => LOG_FILE,
};

module.exports = logger;
