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
    daily: true,
    claim: false,
    search: true,
  },
  region: {
    lock: true,
    ipProvider: "bing",
  },
  search: {
    span: 30,
    api: "hot.nntool.cc",
  },
  // 单次执行数量上限：0 = 不限制（一次做完）；random 打开后随机 ±2–4，见 src/task-limit.js
  limits: {
    random: false,
    read: 0,
    promos: 0,
    // 搜索每轮次数：0 = 沿用内置随机节奏（4–7，force 模式 6–9）；>0 = 固定值
    search: 0,
  },
  schedule: {
    enable: true,
    mode: "interval",
    intervalMinutes: 45,
    stopWhenDone: true,
    maxRounds: 0,
    time: "08:00",
    windows: [{ start: "09:00", end: "23:00" }],
    // 定时触发后随机延迟再开始（秒），弱化固定时刻特征
    randomDelay: true,
    randomDelayMin: 20,
    randomDelayMax: 300,
  },
  notice: {
    wework: "",
    dingding: "",
    dingdingKeyword: "",
    feishu: "",
    pushme: "",
    bark: "",
    hitokoto: true,
    // 一言在界面上的显示位置：sidebar 左下角侧边栏贴底（默认）| bottomRight 右下角贴底 | topbar 标题栏一行
    // ⚠️ 必须与 src/config.js 的 DEFAULTS.notice 逐字段对齐（详见文件顶部说明）
    hitokotoPosition: "sidebar",
  },
  // 日志设置（应用级）：历史日志按账号、按天保留
  logging: {
    retentionDays: 7,
  },
  // 浏览器（登录授权 / 领取奖品要走真实页面）
  // ⚠️ 必须与 src/config.js 的 DEFAULTS.browser 逐字段对齐（含嵌套的 fingerprint），
  // 否则跨版本升级后旧 global-config.json 缺字段会在渲染层抛 TypeError → 白屏。
  browser: {
    fingerprint: {
      enable: true,    // 启用指纹浏览器（未安装则自动回落普通 Chromium；默认开启，首次运行自动下载）
      seed: 0,         // 指纹种子（32 位整数）；0 = 按账户 ID 自动派生，保证同账号长期稳定
      brand: "Chrome", // UA / Client Hints 声明的品牌：Chrome | Edge | Opera | Vivaldi
      hardwareConcurrency: 0, // CPU 核数；0 = 由指纹种子生成
      platform: "windows", // 声明给网站的操作系统：windows | macos | linux（Docker 里避免暴露 Linux）
      mirror: "cdn.gh-proxy.org", // 下载镜像源：默认 cdn.gh-proxy.org；也可指定单个节点、auto 自动测速或 direct 直连
    },
  },
  // 积分目标。可配多个，按账户总积分余额判断，可选设置奖品与详情页显示。
  // 达成判定：当前余额 >= target；奖品数量按 floor(余额 / target) 计算。
  // ⚠️ 必须与 src/config.js 的 DEFAULTS.goals 对齐（含 items: []）。
  // 历史版本这里漏了 goals，跨版本升级后的旧 global-config.json 只有
  // { enable: true } 而没有 items，全局设置页读 value.goals.items 抛 TypeError
  // → React 卸载整棵树 → 白屏（0.9.4 生产事故）。deepMerge 只对「整体缺失」兜底，
  // 必须把 items: [] 写进默认值才能对「有 enable 缺 items」的旧文件补回空数组。
  goals: {
    enable: true,
    items: [
      // { name: "积分目标", scope: "balance", target: 300, rewardName: "", showDashboard: true }
    ],
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
