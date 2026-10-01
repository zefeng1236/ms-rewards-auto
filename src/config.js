const path = require("path");
const fs = require("fs");
const globalConfig = require("./global-config");
const sp = require("./storage-path");

// 存储根（打包环境指向 userData/storage，见 storage-path.js）
const ROOT = sp.storageRoot;

const DEFAULTS = {
  // 是否遵循全局设置。
  // true  -> 忽略本账户 config.json 里的业务字段，直接用 storage/global-config.json
  // false -> 用本账户自己的覆盖值（在全局值基础上叠加）
  useGlobal: true,
  // 任务开关
  tasks: {
    sign: true,    // 每日签入
    read: true,    // 阅读文章
    promos: true,  // 积分活动（earn 页更多活动）
    daily: true,   // 每日活动（dashboard dailySet，每日三格）
    claim: false,  // 定期收取积分（每周一次自动点「领取」），默认关闭
    search: true,  // 搜索积分
  },
  // 区域设置
  region: {
    lock: true, // 锁定国区（IP 非中国大陆则停止）
    // 出口 IP / 归属地查询服务：bing（默认，用 Bing 首页 RevIpCC，与MS Rewards 同源）| ipsb | pconline | ipinfo | ipapi | auto
    // 设为 auto 时按 ip.sb → 太平洋 → ipinfo → ip-api 依次降级，全挂再由 Bing 兜底
    ipProvider: "bing",
  },
  // 搜索设置
  search: {
    span: 30,   // 搜索间隔（秒），实际会在 ±15 秒随机
    api: "hot.nntool.cc", // 搜索词来源: hot.nntool.cc | hot.baiwumm.com | hot.cnxiaobai.com | offline
  },
  // 单次执行数量上限（把当天任务摊到多轮里做，避免一轮清空）
  //
  //   read / promos 为 0 表示不限制（一次做完），保持旧行为。
  //   random 打开后，在设定值上随机 ±2–4，但绝不会一次做完、也不会变成 0 个，
  //   命中保护条件时直接放弃这次随机、保持设定值。规则见 src/task-limit.js。
  limits: {
    random: false,
    read: 6,
    promos: 0,
    // 搜索每轮次数：0 = 沿用内置随机节奏（普通模式 4–7，一次性完成模式 6–9）；
    // >0 = 固定每轮搜这么多次，不再随机。这样用户既能控制节奏，
    // 又不用为「不想动脑」被迫接受默认随机值。默认 6。
    search: 6,
  },
  // 自动运行（本地调度，按账户独立）
  //
  // 三种模式：
  //   interval —— 默认。每 intervalMinutes 分钟跑一轮，当天任务全部完成后
  //               标记「今日已完成」并停止本日循环（次日 0 点自动解锁）。
  //   windows  —— 只在指定时间段内按 intervalMinutes 循环，段外不跑。
  //   daily    —— 旧行为：每天在 time 这个时刻只跑一次。
  schedule: {
    enable: true,
    mode: "interval",       // interval | windows | daily
    intervalMinutes: 45,    // 循环间隔（分钟）
    stopWhenDone: true,     // 当天全部任务完成后退出循环
    maxRounds: 0,           // 每天最多自动运行轮数，0 = 不限
    time: "08:00",          // daily 模式的触发时刻（24 小时制 HH:mm）
    windows: [              // windows 模式的时间段，可多段
      { start: "09:00", end: "23:00" },
    ],
    // 随机启动延迟：定时触发后先随机等一段时间再真正开跑，
    // 避免每次都在「整点/固定间隔」上精确启动，弱化定时器特征。
    randomDelay: true,
    randomDelayMin: 20,     // 秒
    randomDelayMax: 300,    // 秒（5 分钟）
  },
  // 推送通知（留空则不启用）
  notice: {
    wework: "",
    dingding: "",
    dingdingKeyword: "",
    feishu: "",
    pushme: "",
    bark: "",
    hitokoto: true,
    // 一言在界面上的显示位置：sidebar 左下角侧边栏贴底（默认）| bottomRight 右下角贴底 | topbar 窗口原生标题栏
    hitokotoPosition: "sidebar",
    // 一言句子类型（接口 c 参数）：字母数组，空数组 = 不限类型（官方默认，全类型随机）
    // 取值见 src/hitokoto.js 的 TYPES（a 动画 … l 抖机灵）
    hitokotoTypes: [],
  },
  // 日志保留策略（仅全局设置生效；账户独立设置保持同一结构便于表单复用）
  logging: {
    retentionDays: 7,
  },
  // 浏览器（登录授权 / 领取奖品要走真实页面）
  //
  // fingerprint 一节只在设置里下载过指纹浏览器之后才有意义；
  // 没下载 / 没启用时自动回落到 Playwright 自带 Chromium，行为与以前完全一致。
  // ⚠️ 必须与 global-config.js 的 GLOBAL_DEFAULTS.browser 逐字段对齐。
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
  goals: {
    enable: true,
    items: [
      // { name: "积分目标", scope: "balance", target: 300, rewardName: "", showDashboard: true }
    ],
  },
};

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const k of Object.keys(extra)) {
      if (extra[k] && typeof extra[k] === "object" && !Array.isArray(extra[k]) && out[k] && typeof out[k] === "object") {
        out[k] = deepMerge(out[k], extra[k]);
      } else {
        out[k] = extra[k];
      }
    }
  }
  return out;
}

/** 业务字段名单：判断一份老配置里是否真的存过设置 */
const BIZ_KEYS = ["tasks", "region", "search", "schedule", "notice", "logging"];

/**
 * 老配置迁移
 *
 * 引入全局设置之前，每个账户的 config.json 里都是一份完整配置。
 * 这些文件没有 useGlobal 字段，若直接按「遵循全局」处理，用户配好的
 * webhook、任务开关会被全局默认值顶掉 —— 属于静默丢数据。
 *
 * 策略：
 *   全局配置文件还不存在  -> 把这份账户配置提升为全局设置，账户转为遵循全局。
 *                            单账户场景下用户设置完整保留，且落到了正确的位置。
 *   全局配置文件已存在    -> 说明别的账户已经建过全局了，这份配置转为
 *                            账户独立覆盖（useGlobal: false），行为不变。
 *
 * @returns {object|null} 需要写回磁盘的配置，null 表示无需迁移
 */
function migrateLegacy(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(raw, "useGlobal")) return null;
  const hasBiz = BIZ_KEYS.some((k) => raw[k] && typeof raw[k] === "object");
  if (!hasBiz) {
    // 空壳配置，直接标记为遵循全局
    return { ...raw, useGlobal: true };
  }
  if (!fs.existsSync(globalConfig.GLOBAL_FILE)) {
    const seed = {};
    for (const k of BIZ_KEYS) if (raw[k]) seed[k] = raw[k];
    globalConfig.set(seed);
    return { useGlobal: true };
  }
  return { ...raw, useGlobal: false };
}

/**
 * 创建绑定到指定目录的配置实例
 *
 * 关键设计：`get()` 返回的是**有效配置**（effective config），已经把
 * 全局设置和账户覆盖解析完毕。这样 tasks/rewards/runner/notify 里
 * 十几处 `ctx.config.get()` 全都不用改，继承逻辑收口在这一层。
 *
 * 三层叠加顺序：DEFAULTS -> 全局设置 -> 账户覆盖（仅当 useGlobal 为 false）
 *
 * @param {string} dir 账户目录
 */
function createConfig(dir) {
  const CONFIG_FILE = path.join(dir, "config.json");
  let rawCache = null;      // 磁盘上的原始内容（账户自己的覆盖值）
  let effectiveCache = null; // 解析继承后的有效配置

  function ensureFile() {
    if (fs.existsSync(CONFIG_FILE)) return;
    fs.mkdirSync(dir, { recursive: true });
    // 新账户默认遵循全局设置，只写这一个标志，避免把当时的全局值"快照"进去
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ useGlobal: true }, null, 2), "utf-8");
  }

  /** 读取账户自己的原始配置（不做继承解析），顺带做一次老配置迁移 */
  function loadRaw() {
    ensureFile();
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) || {};
    } catch {
      raw = { useGlobal: true };
    }
    const migrated = migrateLegacy(raw);
    if (migrated) {
      raw = migrated;
      try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2), "utf-8");
      } catch {}
    }
    rawCache = raw;
    return rawCache;
  }

  /** 解析出有效配置 */
  function resolve() {
    const raw = loadRaw();
    const useGlobal = raw.useGlobal !== false;
    // 先铺默认值，再盖全局设置
    let out = deepMerge(DEFAULTS, globalConfig.get());
    if (!useGlobal) {
      // 独立模式：把账户覆盖值叠上去。useGlobal 本身不参与业务合并。
      const override = { ...raw };
      delete override.useGlobal;
      out = deepMerge(out, override);
    }
    out.useGlobal = useGlobal;
    effectiveCache = out;
    return out;
  }

  function load() {
    // 全局设置可能被别处改过，这里强制重新解析
    globalConfig.invalidate();
    return resolve();
  }

  function get() {
    return effectiveCache || resolve();
  }

  /**
   * 写入账户级配置
   *
   * 注意：只写进账户自己的 config.json。若该账户正遵循全局设置，
   * 这些值暂时不生效，但会保留下来 —— 用户关掉「遵循全局」开关后，
   * 之前调过的独立设置能立刻恢复，不会丢。
   */
  function set(patch) {
    const raw = loadRaw();
    const merged = deepMerge(raw, patch || {});
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf-8");
    rawCache = merged;
    return resolve();
  }

  /** 账户自己的原始覆盖值（供 GUI 渲染独立设置表单用） */
  function getRaw() {
    return loadRaw();
  }

  /**
   * 独立设置表单要显示的值
   *
   * 账户没设过的字段回落到全局值，这样切到独立模式时表单不是空的，
   * 而是以当前全局值为起点，用户改哪项改哪项。
   */
  function getOverrides() {
    const raw = loadRaw();
    const base = deepMerge(DEFAULTS, globalConfig.get());
    const override = { ...raw };
    delete override.useGlobal;
    const out = deepMerge(base, override);
    out.useGlobal = raw.useGlobal !== false;
    return out;
  }

  /** 切换是否遵循全局设置 */
  function setUseGlobal(v) {
    return set({ useGlobal: !!v });
  }

  return {
    load,
    get,
    set,
    getRaw,
    getOverrides,
    setUseGlobal,
    getConfigFile: () => CONFIG_FILE,
  };
}

module.exports = { createConfig, DEFAULTS, ROOT, deepMerge };

