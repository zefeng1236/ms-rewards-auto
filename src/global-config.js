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
  /**
   * 定期收取积分的节奏（2026-10-06）。
   * ⚠️ 必须与 src/config.js 的 DEFAULTS.claimSchedule、types/index.ts 的
   * AppConfig.claimSchedule、api/mock.ts 逐字段对齐（铁律：四处缺一 → 白屏）。
   *
   * 独立成段而不塞进 tasks.claim：那个是 boolean 开关，改成对象会破坏存量配置。
   */
  claimSchedule: {
    mode: "interval", // interval=每隔 everyDays 天 | daily=每天到 dailyAt
    everyDays: 7,     // interval 模式：1~30，默认 7（与旧行为一致）
    dailyAt: "09:00", // daily 模式：本地时区 HH:MM
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
  // 默认把当天任务摊到多轮：阅读每轮 6 篇、搜索每轮 6 次；积分活动仍不限制（一次做完）。
  limits: {
    random: false,
    read: 6,
    promos: 0,
    // 搜索每轮次数：0 = 沿用内置随机节奏（4–7，force 模式 6–9）；>0 = 固定值
    search: 6,
    // 允许执行数量超过剩余任务总数（默认关闭）
    allowExceed: false,
  },
  schedule: {
    enable: true,
    mode: "interval",
    intervalMinutes: 45,
    stopWhenDone: true,
    maxRounds: 0,
    time: "08:00",
    startTime: "09:00",
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
    // 企业微信是否用 markdown 排版（关掉 → 纯文本，转发到微信时不会显示标记）。
    // ⚠️ 必须与 src/config.js 的 DEFAULTS.notice 逐字段对齐。
    weworkMarkdown: true,
    // 推送是否附加一言：与界面显示开关（appearance 段的 hitokoto）拆开。
    // 此前 `hitokoto` 一个开关同时管「界面 + 推送」，但「界面位置/句子类型」属于外观，
    // 已迁去个性化菜单（与 src/config.js 的 DEFAULTS.appearance.hitokoto 同源），
    // 这里只留推送侧的开关。
    // 旧配置只有 hitokoto=true 没 hitokotoInPush 时，normalize 会按 hitokoto 同值兜底（保持旧意图）。
    hitokotoInPush: true,
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
      enable: true,    // 启用环境拟真浏览器（未安装则自动回落普通 Chromium；默认开启，首次运行自动下载）
      // 环境拟真内核（2026-10-06 起两个内核并存，用户可自选）：
      //   chromix = Chromix 154（默认，稳定）
      //   fp150  = adryfish/fingerprint-chromium 150（备用，**当前不可选**：
      //             有 canvas 读像素崩溃缺陷，上游 issue #94 暂无补丁）
      // 保留 fp150 是为了等上游修好后能直接放开选择，不用重新写一遍适配。
      // 非法值一律回落 chromix（normalizeEngine 负责）。
      engine: "chromix",
      // **只保留单个内核**（默认开）。开启时切换内核会自动卸载上一个，
      // 避免两个内核各占 ~500MB 常驻磁盘。关掉才能两个同时留着、随时切换。
      singleEngineOnly: true,
      seed: 0,         // 拟真种子（32 位整数）；0 = 按账户 ID 自动派生，保证同账号长期稳定
      brand: "Chrome", // UA / Client Hints 声明的品牌：Chrome | Edge | Opera | Vivaldi
      hardwareConcurrency: 0, // CPU 核数；0 = 由拟真种子生成
      platform: "windows", // 声明给网站的操作系统：windows | macos | linux（Docker 里避免暴露 Linux）
      mirror: "cdn.gh-proxy.org", // 下载镜像源：默认 cdn.gh-proxy.org；也可指定单个节点、auto 自动测速或 direct 直连
    },
  },
  /**
   * 软件本体更新（0.14.5 起）。
   *
   * ⚠️ 必须与 src/config.js 的 DEFAULTS.update、src-renderer/src/types/index.ts 的
   * GlobalConfig.update、src-renderer/src/api/mock.ts 的 browser 同级 update 段
   * **逐字段对齐** —— 旧配置缺新字段会导致渲染层白屏（0.13.x 踩过）。
   */
  update: {
    // 后台静默下载新版本安装包。默认关闭：不未经允许就在后台拉 100MB+。
    silentDownload: false,
    // 当天是否已弹过更新提示（YYYY-MM-DD）。用户点叉后当天不再弹。
    lastPromptDate: "",
    // 已静默下载完成、待安装的版本号（空 = 没有待装包）
    readyVersion: "",
    // 待装安装包的落盘路径（相对或绝对；空 = 无）
    readyFile: "",
    // 待装包下载时的字节数与 sha256（安装前复核用；GitHub 不提供官方 digest，
    // 这是我们自己留存的基准，用于发现文件损坏/被动过）
    readyBytes: 0,
    readySha256: "",
    // 已忽略的版本号（用户点叉的那个版本，避免同版本反复弹）
    dismissedVersion: "",
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
    cache = migrateNoticeHitokoto(deepMerge(GLOBAL_DEFAULTS, raw));
  } catch {
    // 文件损坏时退回默认值，不要让整个程序起不来
    cache = JSON.parse(JSON.stringify(GLOBAL_DEFAULTS));
  }
  return cache;
}

/**
 * 一次性迁移：老配置只在 notice 里写 hitokoto（同时管界面 + 推送），
 * 0.14.14 拆成 appearance.hitokoto（界面）+ notice.hitokotoInPush（推送）。
 * 旧字段还在、但新字段没写时，按旧意图兜底，避免一次升级就把用户的"关闭推送一言"配置丢了。
 *
 * 边界：
 *   - 老 notice.hitokoto=true + 没有 hitokotoInPush → 推送仍开（true）
 *   - 老 notice.hitokoto=false + 没有 hitokotoInPush → 推送关（false）
 *   - 老 notice.hitokoto=true + 新 hitokotoInPush=false → 用户已显式覆盖，**以新为准**（不再回填）
 *   - 全新配置 → 不动（已用默认值）
 */
function migrateNoticeHitokoto(cfg) {
  const notice = cfg && cfg.notice;
  if (!notice || typeof notice !== "object") return cfg;
  if ("hitokotoInPush" in notice) return cfg; // 新字段已显式写过 → 用户意图明确，不动
  if ("hitokoto" in notice) notice.hitokotoInPush = notice.hitokoto === true;
  return cfg;
}

/** 读取全局设置（带缓存） */
function get() {
  return cache || load();
}

/** 写入全局设置补丁，返回合并后的完整配置 */
function set(patch) {
  const merged = migrateNoticeHitokoto(deepMerge(load(), patch || {}));
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
  migrateNoticeHitokoto,
};
