/**
 * 业务数据类型定义
 *
 * 全部字段对照主进程真实返回值书写：
 *   Account  ← src/account.js  describe()
 *   AppConfig ← src/config.js  DEFAULTS + src/global-config.js GLOBAL_DEFAULTS
 *   Appearance ← src/appearance.js DEFAULTS
 */

// ============ 配置项 ============

/** 自动运行模式 */
export type ScheduleMode = "interval" | "windows" | "daily";

/** 搜索词来源 */
export type SearchApi =
  | "offline"
  | "hot.nntool.cc"
  | "hot.baiwumm.com"
  | "hot.cnxiaobai.com";

/** 出口 IP / 归属地查询服务（auto 时按 ip.sb→太平洋→ipinfo→ip-api 降级，全挂再由 Bing 兜底） */
export type IpProvider = "auto" | "ipsb" | "pconline" | "ipinfo" | "ipapi" | "bing";

export interface ScheduleWindow {
  start: string; // "HH:mm"
  end: string; //   "HH:mm"
}

export interface GoalItem {
  name: string;
  scope: "balance";
  target: number;
  rewardName?: string;
  showDashboard?: boolean;
}

/** 任务结果（runner 返回，结构较松散，只取 GUI 需要的部分） */
export interface RunTaskResult {
  ok?: boolean;
  reason?: string;
  [k: string]: unknown;
}

/**
 * 「运行全部」的可选参数
 */
export interface RunAllOptions {
  /**
   * true = 一次性完成模式：忽略每个任务的「单次执行数量」限制
   * （即按 limits.read / limits.promos = 0 处理），一轮把当天任务全部做完。
   * 仅对本次运行生效，不会改用户的配置。
   */
  force?: boolean;
}

/**
 * 每日一言（接口 https://v1.hitokoto.cn）。
 * 后端按天缓存到 storage/hitokoto.json，界面与推送共用同一句 ——
 * 前端不要自己去 fetch 公益接口，否则 QPS 翻倍且两边句子不一致。
 */
export interface Hitokoto {
  text: string;
  /** 出处（作品名） */
  from: string;
  /** 作者 */
  fromWho: string;
  uuid: string;
  /** 缓存日期 YYYY-MM-DD */
  date: string;
}

/**
 * 每日一言在界面上的显示位置。
 * 取值必须与 src/hitokoto.js 的 POSITIONS.key 严格一一对应（selfcheck 有跨文件守卫）。
 */
export type HitokotoPosition = "sidebar" | "bottomRight" | "topbar";

/** 有效配置（已按「全局 → 账户覆盖」合并后的结果） */
export interface AppConfig {
  /** 仅账户级配置才有：true 表示完全跟随全局 */
  useGlobal?: boolean;
  tasks: {
    sign: boolean;
    read: boolean;
    /** 每日活动（dashboard dailySet），默认关闭 */
    daily: boolean;
    /** 积分活动（earn 页更多活动） */
    promos: boolean;
    /** 定期收取积分（每周自动点「领取」），默认关闭 */
    claim: boolean;
    search: boolean;
  };
  region: {
    lock: boolean;
    /** 出口 IP / 归属地查询服务 */
    ipProvider: IpProvider;
  };
  search: {
    span: number;
    api: SearchApi;
  };
  /**
   * 单次执行数量上限（把当天任务摊到多轮里做）
   *
   * read / promos 为 0 表示不限制（一次做完）。
   * random 打开后在设定值上随机 ±2–4：不会一次做完、也不会变成 0 个，
   * 命中保护条件时放弃随机并保持设定值。
   */
  limits: {
    random: boolean;
    /** 阅读文章每次最多几篇，0 = 不限制（默认 6） */
    read: number;
    /** 积分活动每次最多几个，0 = 不限制（默认 0） */
    promos: number;
    /** 搜索每次每轮的次数，0 = 沿用内置随机节奏（4–7，一次性完成模式 6–9）；默认 6 */
    search: number;
  };
  schedule: {
    enable: boolean;
    mode: ScheduleMode;
    intervalMinutes: number;
    stopWhenDone: boolean;
    maxRounds: number;
    time: string;
    windows: ScheduleWindow[];
    /** 定时触发后先随机延迟再开始（规避固定时刻特征） */
    randomDelay: boolean;
    /** 随机延迟下限（秒） */
    randomDelayMin: number;
    /** 随机延迟上限（秒） */
    randomDelayMax: number;
  };
  notice: {
    wework: string;
    dingding: string;
    dingdingKeyword: string;
    feishu: string;
    pushme: string;
    bark: string;
    /** 推送中附加每日一言，默认开启 */
    hitokoto: boolean;
    /**
     * 一言在界面上的显示位置：
     *   sidebar     —— 左下角侧边栏、贴窗口底部（默认）
     *   bottomRight —— 右下角、贴窗口底部
     *   topbar      —— 窗口原生标题栏（拼在「MS Rewards 自动任务 vX · 」之后）
     */
    hitokotoPosition: HitokotoPosition;
  };
  logging: {
    /** 历史日志保留天数，默认 7，范围 1–365 */
    retentionDays: number;
  };
  goals: {
    enable: boolean;
    items: GoalItem[];
  };
  /** 浏览器（登录授权 / 领取奖品要走真实页面） */
  browser: {
    /**
     * 指纹浏览器（可选增强，需在设置页单独下载约 181MB）。
     * 未启用或未安装时自动回落普通 Chromium。
     */
    fingerprint: {
      enable: boolean;
      /** 指纹种子（32 位整数）；0 = 按账户 ID 自动派生，保证同账号长期稳定 */
      seed: number;
      /** UA / Client Hints 声明的品牌 */
      brand: string;
      /** CPU 核数；0 = 由指纹种子生成 */
      hardwareConcurrency: number;
      /** 声明给网站的操作系统：windows | macos | linux（默认 windows）。
       *  为什么不跟 process.platform：Docker 容器里真实平台恒为 Linux，
       *  照实声明会让登录设备显示为 Linux，既不像是「有图形界面的正常桌面
       *  浏览器」，也与 HTTP 层声明的 Windows UA 自相矛盾。 */
      platform: string;
      /** 下载镜像源：auto=按顺序尝试全部，也可指定单个节点或 direct 直连 GitHub */
      mirror: string;
    };
  };
}

/** 补丁写入用的深层可选类型 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

// ============ 账户 ============

export interface SchedInfo {
  dayDone: boolean;
  rounds: number;
  /** 尚未完成的任务名 */
  pending: string[];
  mode: ScheduleMode;
  enable: boolean;
  intervalMinutes: number;
  /** 下次预计运行时间，如 "08-31 14:20"，无则空串 */
  nextRunText: string;
}

export interface AccountState {
  loggedIn: boolean;
  hasRefreshToken: boolean;
  todayPoints: number;
  lastBalance: number;
  lastResult: string;
  /** YYYYMMDD 数字，0 表示从未运行 */
  lastRunDate: number;
  signDone: boolean;
  readDone: boolean;
  /** 是否开启「每日活动」任务（关闭时详情页不显示该卡片） */
  dailyEnabled?: boolean;
  dailyDone?: boolean;
  dailyPoint?: number;
  promosDone: boolean;
  searchDone: boolean;
  signPoint?: number;
  readPoint?: number;
  promosPoint?: number;
  searchPoint?: number;
  /** 形如 "12/15 · M:3/10" */
  searchProgress: string;
  /** 形如 "7/10 篇" */
  readProgress: string;
  readArticlesDone: number;
  readArticlesTotal: number;
  restrictedTimes: number;
  cookiesCount: number;
  sched: SchedInfo;
  /** 单个账户数据损坏时的提示 */
  broken?: string;
}

export interface Account {
  id: string;
  name: string;
  createdAt: number;
  enabled: boolean;
  config: AppConfig;
  useGlobal: boolean;
  state: AccountState;
}

/** accounts:create 返回的纯元数据 */
export interface AccountMeta {
  id: string;
  name: string;
  createdAt: number;
  enabled: boolean;
  error?: string;
}

// ============ 仪表盘 ============

export interface OverviewStats {
  total: number;
  enabled: number;
  loggedIn: number;
  todayPoints: number;
  balance: number;
  dayDone: number;
  pendingAccounts: number;
}

export interface Overview {
  accounts: Account[];
  stats: OverviewStats;
}

// ============ 外观 ============

export type AppearancePreset = "normal" | "opaque";

export type ThemeMode = "dark" | "light" | "system";

/**
 * 主界面壁纸主分类（一级）：
 *   - none：关闭
 *   - bing：必应每日一图
 *   - upx8 / qy98 / unsplash：第三方壁纸源，被选中时展示壁纸类别（二级分类 bgCategory）
 *   - url / file：图片直链/API 或本地图片
 * UAPI 的随机壁纸来源已移除（只保留其必应每日壁纸）；
 * flow 不属于主界面壁纸（那是登录页/向导的 authBg），故不在本联合内。
 */
export type BgType = "none" | "bing" | "upx8" | "qy98" | "unsplash" | "url" | "file";

/**
 * 登录页 / 初始化向导的背景（独立于主界面的 bgType）：
 *   - flow：内置 Canvas 流场粒子动画（默认，无网络请求）
 *   - bing：必应每日一图
 * 主界面软件里不渲染流场——这是用户明确要求的分工。
 */
export type AuthBgType = "flow" | "bing";

/** upx8 壁纸 API 的二级分类（category 参数，random = 不限分类随机） */
export type Upx8Category =
  | "random"
  | "nature"
  | "anime"
  | "game"
  | "animal"
  | "city"
  | "abstract"
  | "space"
  | "car"
  | "girl"
  | "sport";

/** 98qy 壁纸的二级分类（lx 参数） */
export type Qy98Category = "suiji" | "fengjing" | "dongman" | "meizi";

/** Unsplash 的二级分类（映射为官方 API 的 query 关键词，random = 不限主题） */
export type UnsplashCategory =
  | "random"
  | "nature"
  | "animals"
  | "architecture"
  | "travel"
  | "city"
  | "ocean"
  | "space"
  | "food"
  | "flowers";

/** 壁纸二级分类（仅 upx8/qy98/unsplash 主分类生效），与后端 wallpapers.SOURCES 对齐 */
export type BgCategory = Upx8Category | Qy98Category | UnsplashCategory;

export interface Appearance {
  preset: AppearancePreset;
  mode: ThemeMode;
  /** 0.20 – 1.00 */
  opacity: number;
  accent: string;
  glow: boolean;
  bgType: BgType;
  /** 登录页 / 向导背景（与主界面 bgType 相互独立） */
  authBg: AuthBgType;
  bgUrl: string;
  bgFile: string;
  bgCategory: BgCategory;
  bgUnsplashKey: string;
  /** 轮换间隔秒数，0 = 不轮换 */
  bgRotate: number;
  /** 背景模糊 0–40 */
  bgBlur: number;
  /** 背景暗化 0–0.85 */
  bgDim: number;
  /** 液态玻璃表面开关 */
  glass: boolean;
  /** 鼠标指针光晕开关（需配合 glass 才有视觉意义） */
  pointerHalo: boolean;
  /** 跟随壁纸亮度自动反色（亮壁纸→浅色主题，暗壁纸→深色主题） */
  autoTheme: boolean;
  /** Bing 每日图解析缓存 */
  bgResolved: { date: string; url: string } | null;
}

// ============ 其他 IPC 返回 ============

export interface ChromiumStatus {
  ready: boolean;
  executable: string | null;
}

/** 指纹浏览器状态（可选增强，见 src/fingerprint-browser.js） */
export interface FingerprintStatus {
  /** 当前平台是否提供指纹浏览器（macOS 暂不支持） */
  supported: boolean;
  platform: string;
  /** 是否已安装且可执行文件可定位 */
  ready: boolean;
  executable: string | null;
  /** 已安装版本，未安装为 null */
  version: string | null;
  /** 本项目钉死的版本 */
  pinned: string;
  installDir: string;
  /** 是否由**镜像内置预装**（Docker 版：/opt/fingerprint-chromium）。
   *  为 true 时界面隐藏「下载/重新下载/删除」——那些动作在容器里要么无意义
   *  （已在镜像层），要么会造成一次多余的大体积运行时下载。 */
  preinstalled?: boolean;
  downloadUrl: string | null;
  /** 可选下载镜像源（供界面渲染下拉，由主进程下发，避免前后端各写一份）；
   *  label 已带实测延迟后缀，latencyMs 供需要单独渲染延迟的界面用 */
  mirrors?: { value: string; label: string; latencyMs?: number | null }[];
}

/** 「检查更新」的查询结果（只查不下载，0.9.4.18 起与安装动作分离） */
export interface CheckFingerprintUpdateResult {
  ok: boolean;
  /** 上游最新 tag；查询失败为 null */
  latest: string | null;
  /** 已安装版本；未安装为 null */
  installed: string | null;
  /** 本项目钉死的版本 */
  pinned: string;
  /** 上游有比钉死版本更新的 tag（仅提示，不自动跟） */
  updateAvailable: boolean;
  /** 已安装版本与钉死版本不一致（含未安装），点「重新安装」可对齐 */
  reinstallAvailable: boolean;
  error?: string;
}

/** 应用本身的更新检查结果（查询 GitHub Releases 最新正式版，只查不下载） */
export interface CheckAppUpdateResult {
  ok: boolean;
  /** 有比当前版本更新的正式版可用 */
  updateAvailable: boolean;
  /** 当前运行版本 */
  currentVersion: string;
  /** 上游最新正式版 tag（不含 v 前缀，如 "0.11.0"） */
  latestVersion: string;
  /** Release 资产直链（走 gh-proxy 加速的原始 GitHub URL，实际下载在浏览器里由用户完成） */
  downloadUrl: string;
  /** 资产文件名，如 MS-Rewards-Auto-Setup-0.11.0.exe */
  assetName: string;
  /** Release 页面地址（立即更新按钮默认打开这里） */
  pageUrl: string;
  /** Release 正文（Markdown 原文，界面自行按纯文本渲染） */
  releaseNotes: string;
  /** ISO 时间戳 */
  publishedAt: string;
  error?: string;
}

export interface InstallFingerprintResult {
  ok: boolean;
  error?: string;
  version?: string;
  executable?: string;
  /** 解压方式：tar / powershell */
  method?: string;
  /** 已是目标版本、跳过下载 */
  skipped?: boolean;
  /** 用户主动取消下载 */
  canceled?: boolean;
}

export interface BgSrcResult {
  /** 当前背景图地址（远程随机图源为本地缓存的 file:// 路径，保证各处看到同一张） */
  src: string;
  /** 壁纸平均亮度 0–1；取不到时为 null（autoTheme 此时退回手动模式） */
  luma: number | null;
}

/** 壁纸下载进度推送（用于「正在切换壁纸，已下载 xx%」气泡） */
export interface BgProgress {
  /** 已下载字节 */
  loaded?: number;
  /** 总字节（取不到 Content-Length 时为 0） */
  total?: number;
  /** 进度百分比 0–100 */
  pct?: number;
  /** 下载结束（成功或失败）时为 true */
  done?: boolean;
}

export interface TestUrlResult {
  ok: boolean;
  status?: number;
  contentType?: string;
  finalUrl?: string;
  error?: string;
}

export interface DownloadResult {
  ok: boolean;
  path?: string;
  bytes?: number;
  error?: string;
  canceled?: boolean;
}

/** 保存文本文件（如恢复密钥 txt）的结果 */
export interface SaveTextResult {
  ok: boolean;
  path?: string;
  error?: string;
  /** 用户在保存对话框点了取消 */
  canceled?: boolean;
}

export interface AppearanceSetResult {
  ok: boolean;
  appearance: Appearance;
  restartNeeded: boolean;
}

/** 点击 × 关闭主窗口的行为 */
export type CloseAction = "ask" | "tray" | "exit";

/** 启动与托盘设置（对应主进程 launch.json） */
export interface LaunchConfig {
  /** 开机自动启动：注册到系统登录项 */
  autoLaunch: boolean;
  /** 开机自启后驻留托盘：启动后不弹主窗口，后台静默运行 */
  launchToTray: boolean;
  /** 开机启动延迟（秒），仅 autoLaunch 时生效；默认 10 */
  launchDelay: number;
  /** 关闭主窗口的行为：ask=每次询问 / tray=退出到托盘 / exit=完全退出 */
  closeAction: CloseAction;
}

/** 首次启动向导状态（对应主进程 setup.json） */
export interface SetupState {
  /** 向导是否已完成；true 后不再弹出 */
  done: boolean;
  /** 界面语言。当前只有 zh-CN 可用，其余语种尚未开发 */
  lang: string;
  /** 是否已勾选「已阅读并同意」协议 */
  agreed: boolean;
  /** 初始是否启用液态玻璃效果 */
  liquidGlass: boolean;
  /** 初始是否开机自启 */
  autoLaunch: boolean;
  /** 开机自启时是否隐藏到托盘 */
  launchToTray: boolean;
}

/**
 * 保险库状态（账户登录态的加密存储）
 *
 * 未配置时登录态按旧版明文存储；一旦配置，Cookie 与 token 只以密文落盘，
 * 且未解锁前一律无法读取、也无法覆写。
 */
export interface VaultStatus {
  /** 是否已配置保险库 */
  configured: boolean;
  /** 当前是否已解锁（未解锁则所有需要登录态的操作被挡住） */
  unlocked: boolean;
  /** 系统钥匙串是否可用：不可用时每次启动都要手动输密码 */
  keychain: boolean;
  /** 密码提示（明文保存，仅帮助用户回忆，不参与加密） */
  hint: string;
  /** 本次是否由环境变量解锁（无桌面/Docker 场景） */
  byEnv: boolean;
}

/** 保险库操作返回值 */
export interface VaultResult {
  ok: boolean;
  error?: string;
  /** 建库或取回时下发的恢复密钥（忘记密码时的唯一退路） */
  recoveryKey?: string;
}

/** 「清空账号数据」的执行结果（返回实际清掉了多少东西，便于界面反馈） */
export interface WipeResult {
  ok: boolean;
  error?: string;
  /** 被清空的账户数量 */
  accounts: number;
  /** 被清空的历史日志份数（按账号目录计） */
  logs: number;
  /** 保险库是否已随之移除（密码与密钥都丢失时它已无法解开） */
  vault: boolean;
  /** 是否清掉了壁纸 API 密钥（个性化设置里的第三方凭据） */
  wallpaperKey: boolean;
  /** 向导状态是否被重置（账号与保险库都没了，下次启动重新进入首次启动向导） */
  wizardReset: boolean;
}

/** 运行类操作的统一返回 */
export interface RunResult {
  ok: boolean;
  error?: string;
  aborted?: boolean;
  result?: RunTaskResult;
  results?: RunTaskResult[];
  loggedIn?: boolean;
  /** login/sync 的结果说明文案（主进程 account:login / account:sync 返回） */
  message?: string;
}

export interface InstallBrowserResult {
  ok: boolean;
  method?: string;
  error?: string;
  canceled?: boolean;
}

/** Chromium 自动安装进度（主进程 ensureDeps.onProgress 通过 ipc "install-progress" 推送） */
export interface InstallProgress {
  /** 进度阶段：playwright/镜像、playwright/官方、choco 等 */
  stage?: string;
  /** 阶段说明文本（与日志同步） */
  message?: string;
  /** 0-100，已 clamp；没有 total 时只是计数 */
  pct?: number;
  /** 字节/秒 */
  speed?: number;
  /** 剩余秒数 */
  eta?: number;
  /** 已写入字节 */
  loaded?: number;
  /** 总字节（HEAD 探测到时才有） */
  total?: number;
  /** 当前下载文件路径（调试用） */
  url?: string;
}

/** 推送测试返回（notify.testPush，字段不固定） */
export interface PushTestResult {
  ok?: boolean;
  error?: string;
  [k: string]: unknown;
}

/**
 * 单个账号的运行态（仪表盘徽标 / 详情页停止按钮用）。
 * running 正在工作（转圈）| waiting 排队等待 | warning 需要注意（橙感叹号）
 * | error 发生错误（红色）| idle 空闲（不显示任何标记）
 */
export type AccountRunStatusValue = "running" | "waiting" | "warning" | "error" | "idle";

export interface AccountRunStatus {
  status: AccountRunStatusValue;
  /** 状态说明（橙/红标记的提示文案） */
  reason?: string;
  /** 进入该状态的时间戳（毫秒） */
  at?: number;
}

/** id -> 运行态（app:getRunStatus 的返回） */
export type AccountRunStatusMap = Record<string, AccountRunStatus>;

/** 单账号日志条目（结构化，来自主进程 logger 缓冲 / account-log 推送） */
export interface AccountLogEntry {
  time: string;
  level: string;
  msg: string;
  /** 已拼好时间戳/级别/账号前缀的整行，可直接展示 */
  line: string;
  accountId: string | null;
  accountName: string | null;
}

/* ------------------------------------------------------------------ *
 * 日历 / 签到勋章（history.json）
 * ------------------------------------------------------------------ */

/**
 * 每日状态四档。
 * done    全部启用任务完成 —— 只有这一档计入「连续签到」
 * partial 完成一部分      idle 当天未运行      error 运行出错无进度
 */
export type DayStatus = "done" | "partial" | "idle" | "error";

/** 日历中的一格 */
export interface CalendarDay {
  /** 1-31 */
  day: number;
  /** YYYY-MM-DD */
  key: string;
  status: DayStatus;
  /** 已完成 / 启用的任务数 */
  done: number;
  total: number;
  /** 当日积分 */
  points: number;
  /** 是否有真实记录（false 表示这天从没跑过，颜色按 idle 画但提示不同） */
  hasRecord: boolean;
  /** 是否周末（周六/周日）→ 蓝数字 */
  weekend?: boolean;
  /** 农历日名（如「十五」；初一是该农历月起点，显示月份名如「八月」） */
  lunar?: string;
  /** 传统节日短名（如「中秋」「七夕」，单日） */
  festival?: string;
  /** 法定节假日短名（如「中秋」「国庆」，来自网络，含多日假期与调休） */
  holidayName?: string;
  /** 法定放假日（蓝「休」角标） */
  rest?: boolean;
  /** 调休上班日（橙「班」角标） */
  workday?: boolean;
  /** 单元格小字的最终显示（法定休节名 > 传统节日 > 农历） */
  label?: string;
}

/** 一个月的数据 */
export interface CalendarMonth {
  year: number;
  month: number;
  days: CalendarDay[];
  /** 整月每一天都完成 */
  perfect: boolean;
  doneDays: number;
}

/** 勋章获得记录：累计次数 + 最近获得日期 */
export interface BadgeRecord {
  count: number;
  last: string;
  /** 仅月全勤勋章使用：YYYY-MM，用于同月去重 */
  month?: string;
}

/** 历史汇总统计 */
export interface HistoryStats {
  /** 首次记录的日期 */
  first: string;
  trackedDays: number;
  doneDays: number;
  partialDays: number;
  errorDays: number;
  totalPoints: number;
  /** 当前连续签到天数 */
  streak: number;
  /** 历史最长连续 */
  bestStreak: number;
  /** 获得过的勋章种类数 */
  badgeCount: number;
  /** 获得勋章总次数 */
  badgeTotal: number;
}

/** getHistory 的完整返回 */
export interface HistorySnapshot {
  month: CalendarMonth;
  streak: number;
  badges: Record<string, BadgeRecord>;
  stats: HistoryStats | null;
  /** 有记录的年份（新在前），用于快速跳转 */
  years: number[];
  /** 今天 YYYY-MM-DD */
  today: string;
}
