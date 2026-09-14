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

/** 有效配置（已按「全局 → 账户覆盖」合并后的结果） */
export interface AppConfig {
  /** 仅账户级配置才有：true 表示完全跟随全局 */
  useGlobal?: boolean;
  tasks: {
    sign: boolean;
    read: boolean;
    promos: boolean;
    search: boolean;
  };
  region: {
    lock: boolean;
  };
  search: {
    span: number;
    api: SearchApi;
  };
  schedule: {
    enable: boolean;
    mode: ScheduleMode;
    intervalMinutes: number;
    stopWhenDone: boolean;
    maxRounds: number;
    time: string;
    windows: ScheduleWindow[];
  };
  notice: {
    wework: string;
    dingding: string;
    dingdingKeyword: string;
    feishu: string;
    pushme: string;
    bark: string;
  };
  goals: {
    enable: boolean;
    items: GoalItem[];
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

export type BgType = "none" | "bing" | "url" | "file" | "uapi" | "qy98" | "unsplash";

export type BgCategory =
  | "acg"
  | "furry"
  | "landscape"
  | "pc_wallpaper"
  | "anime"
  | "ai_drawing";

export interface Appearance {
  preset: AppearancePreset;
  mode: ThemeMode;
  /** 0.30 – 1.00 */
  opacity: number;
  accent: string;
  glow: boolean;
  bgType: BgType;
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

export interface BgSrcResult {
  /** 当前背景图地址（远程随机图源为本地缓存的 file:// 路径，保证各处看到同一张） */
  src: string;
  /** 壁纸平均亮度 0–1；取不到时为 null（autoTheme 此时退回手动模式） */
  luma: number | null;
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

/** 运行类操作的统一返回 */
export interface RunResult {
  ok: boolean;
  error?: string;
  aborted?: boolean;
  result?: RunTaskResult;
  results?: RunTaskResult[];
  loggedIn?: boolean;
}

export interface InstallBrowserResult {
  ok: boolean;
  method?: string;
  error?: string;
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
