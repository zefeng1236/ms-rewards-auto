const path = require("path");
const fs = require("fs");
const sp = require("./storage-path");

// 日志跟 storage 放在一起（打包后落在 userData 下，见 storage-path.js）
const LOG_DIR = path.join(sp.storageRoot, "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "app.log");

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

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

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function write(level, color, msg) {
  const tag = currentTag ? ` ${currentTag}` : "";
  const time = timestamp();
  const line = `[${time}] [${level}]${tag} ${msg}`;
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
    buf.push({ time, level, msg, line, accountId, accountName });
    if (buf.length > PER_ACCOUNT_MAX) buf.splice(0, buf.length - PER_ACCOUNT_MAX);
  }

  for (const cb of listeners) {
    try { cb(line); } catch {}
  }
  const entry = { time, level, msg, line, accountId, accountName };
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
    if (process.stdout && process.stdout.isTTY) {
      console.log(msg);
    } else {
      console.log(msg);
    }
    for (const cb of listeners) {
      try { cb(String(msg)); } catch {}
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
  /** 清空某账号的缓冲（默认在该账号新一轮运行前调用，避免残留上次运行） */
  clearAccountLogs: (id) => {
    if (id == null) return;
    accountBuffers.delete(String(id));
  },
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
