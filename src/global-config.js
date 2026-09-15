/**
 * 全局设置
 *
 * 所有账户默认共用这一份配置（storage/global-config.json）。
 * 账户可以在自己的设置里关掉「遵循全局设置」，此时才使用账户自己的
 * config.json 覆盖值 —— 具体的合并逻辑在 src/config.js 的 createConfig 里。
 *
 * 这一层只负责「读写全局那一份 JSON」，不掺和继承规则。
 */
const path = require("path");
const fs = require("fs");
const sp = require("./storage-path");

// 注意：electron-main.js 必须在 require 本模块之前设好
// process.env.MS_REWARDS_STORAGE_DIR（打包环境指向 userData），
// 否则这里算出来的就是项目根目录下的 storage/。
const STORAGE_DIR = sp.storageRoot;
const GLOBAL_FILE = sp.globalConfigFile;

// 全局设置的默认值。注意这里不包含 useGlobal —— 那是账户级的标志。
const GLOBAL_DEFAULTS = {
  tasks: {
    sign: true,
    read: true,
    promos: true,
    search: true,
  },
  region: {
    lock: true,
  },
  search: {
    span: 30,
    api: "hot.nntool.cc",
  },
  schedule: {
    enable: true,
    mode: "interval",
    intervalMinutes: 45,
    stopWhenDone: true,
    maxRounds: 0,
    time: "08:00",
    windows: [{ start: "09:00", end: "23:00" }],
  },
  notice: {
    wework: "",
    dingding: "",
    dingdingKeyword: "",
    feishu: "",
    pushme: "",
    bark: "",
  },
  // 日志设置（应用级）：历史日志按账号、按天保留
  logging: {
    retentionDays: 7,
  },
};

/**
 * 深合并。数组整体替换而不是逐项合并 ——
 * schedule.windows 是数组，逐项合并会把删掉的时间段又"复活"。
 */
function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const k of Object.keys(extra)) {
      const v = extra[k];
      if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
        out[k] = deepMerge(out[k], v);
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

let cache = null;

function ensureFile() {
  if (fs.existsSync(GLOBAL_FILE)) return;
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  fs.writeFileSync(GLOBAL_FILE, JSON.stringify(GLOBAL_DEFAULTS, null, 2), "utf-8");
}

function load() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(GLOBAL_FILE, "utf-8"));
    cache = deepMerge(GLOBAL_DEFAULTS, raw);
  } catch {
    // 文件损坏时退回默认值，不要让整个程序起不来
    cache = JSON.parse(JSON.stringify(GLOBAL_DEFAULTS));
  }
  return cache;
}

/** 读取全局设置（带缓存） */
function get() {
  return cache || load();
}

/** 写入全局设置补丁，返回合并后的完整配置 */
function set(patch) {
  const merged = deepMerge(load(), patch || {});
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  fs.writeFileSync(GLOBAL_FILE, JSON.stringify(merged, null, 2), "utf-8");
  cache = merged;
  return merged;
}

/** 丢弃缓存，下次 get() 重新读盘 */
function invalidate() {
  cache = null;
}

module.exports = {
  GLOBAL_DEFAULTS,
  GLOBAL_FILE,
  deepMerge,
  load,
  get,
  set,
  invalidate,
};
