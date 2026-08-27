const path = require("path");
const fs = require("fs");
const sp = require("./storage-path");

// 日志跟 storage 放在一起（打包后落在 userData 下，见 storage-path.js）
const LOG_DIR = path.join(sp.storageRoot, "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "app.log");

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

let currentTag = "";
const listeners = [];

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function write(level, color, msg) {
  const tag = currentTag ? ` ${currentTag}` : "";
  const line = `[${timestamp()}] [${level}]${tag} ${msg}`;
  if (process.stdout && process.stdout.isTTY) {
    console.log(`${color}${line}\x1b[0m`);
  } else {
    console.log(line);
  }
  try {
    fs.appendFileSync(LOG_FILE, line + "\n", "utf-8");
  } catch {}
  for (const cb of listeners) {
    try { cb(line); } catch {}
  }
}

const logger = {
  info: (msg) => write("INFO", "\x1b[36m", msg),
  log: (level, msg) => write(String(level).toUpperCase(), "\x1b[36m", msg),
  ok: (msg) => write("OK", "\x1b[32m", msg),
  success: (msg) => write("OK", "\x1b[32m", msg),
  warn: (msg) => write("WARN", "\x1b[33m", msg),
  error: (msg) => write("ERROR", "\x1b[31m", msg),
  /** 原始输出（不附加时间戳/标签，用于菜单等） */
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
  /** 订阅日志行（GUI 实时推送） */
  onLog: (cb) => { listeners.push(cb); return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; },
  getLogFile: () => LOG_FILE,
};

module.exports = logger;
