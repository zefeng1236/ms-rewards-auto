import type {
  Account,
  AccountLogEntry,
  AccountRunStatusMap,
  AccountRunStatusValue,
  AppConfig,
  Appearance,
  Overview,
  SetupState,
} from "../types";
import type { ElectronApi } from "../types/electron";

/**
 * 浏览器直开（非 Electron）时使用的假后端。
 *
 * 目的：让 `vite dev` 能脱离 Electron 单独预览 UI —— 玻璃效果、布局、
 * 交互都能在浏览器里直接看，不必每次都打包启动客户端。
 * window.api 存在时（真实 Electron 环境）完全不会走到这里。
 */

const DEFAULT_CONFIG: AppConfig = {
  useGlobal: true,
  tasks: { sign: true, read: true, promos: true, search: true },
  region: { lock: true },
  search: { span: 30, api: "offline" },
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
  goals: {
    enable: true,
    items: [{ name: "积分目标", scope: "balance", target: 300, rewardName: "", showDashboard: true }],
  },
};

const DEFAULT_APPEARANCE: Appearance = {
  preset: "normal",
  mode: "dark",
  opacity: 1,
  accent: "#3b82f6",
  glow: true,
  bgType: "bing",
  bgUrl: "",
  bgFile: "",
  bgCategory: "landscape",
  bgUnsplashKey: "",
  bgRotate: 0,
  bgBlur: 4,
  bgDim: 0.25,
  glass: true,
  autoTheme: false,
  bgResolved: null,
};

/**
 * 浏览器预览用的模拟壁纸（内联 SVG data URI）。
 * 玻璃效果必须衬在有色背景上才看得出来，纯色底下什么都看不出。
 */
const MOCK_WALLPAPER =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1e3a8a"/>
          <stop offset="42%" stop-color="#6d28d9"/>
          <stop offset="68%" stop-color="#db2777"/>
          <stop offset="100%" stop-color="#f59e0b"/>
        </linearGradient>
      </defs>
      <rect width="1600" height="900" fill="url(#sky)"/>
      <circle cx="1180" cy="250" r="95" fill="#fef3c7" opacity="0.95"/>
      <path d="M0 720 L320 470 L560 680 L820 400 L1120 720 Z" fill="#1f2937" opacity="0.8"/>
      <path d="M660 740 L980 500 L1260 700 L1600 540 L1600 900 L0 900 Z" fill="#0b1120" opacity="0.92"/>
    </svg>`
  );

function mkState(over: Partial<Account["state"]> = {}): Account["state"] {
  return {
    loggedIn: true,
    hasRefreshToken: true,
    todayPoints: 0,
    lastBalance: 0,
    lastResult: "",
    lastRunDate: 0,
    signDone: false,
    readDone: false,
    promosDone: false,
    searchDone: false,
    searchProgress: "",
    readProgress: "",
    readArticlesDone: 0,
    readArticlesTotal: 10,
    restrictedTimes: 0,
    cookiesCount: 0,
    sched: {
      dayDone: false,
      rounds: 0,
      pending: [],
      mode: "interval",
      enable: true,
      intervalMinutes: 45,
      nextRunText: "",
    },
    ...over,
  };
}

const today = Number(
  `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, "0")}${String(
    new Date().getDate()
  ).padStart(2, "0")}`
);

let mockAccounts: Account[] = [
  {
    id: "mock-1",
    name: "示例账户 A",
    createdAt: Date.now() - 86400000 * 12,
    enabled: true,
    config: { ...DEFAULT_CONFIG },
    useGlobal: true,
    state: mkState({
      loggedIn: true,
      todayPoints: 168,
      lastBalance: 24891,
      lastRunDate: today,
      signDone: true,
      readDone: true,
      promosDone: false,
      searchDone: true,
      signPoint: 15,
      readPoint: 30,
      promosPoint: 50,
      searchProgress: "15/15 · M:8/10",
      readProgress: "10/10 篇",
      readArticlesDone: 10,
      cookiesCount: 42,
      sched: {
        dayDone: false,
        rounds: 3,
        pending: ["promos"],
        mode: "interval",
        enable: true,
        intervalMinutes: 45,
        nextRunText: "08-31 14:20",
      },
    }),
  },
  {
    id: "mock-2",
    name: "示例账户 B",
    createdAt: Date.now() - 86400000 * 3,
    enabled: true,
    config: { ...DEFAULT_CONFIG, useGlobal: false },
    useGlobal: false,
    state: mkState({
      loggedIn: true,
      todayPoints: 302,
      lastBalance: 15720,
      lastRunDate: today,
      signDone: true,
      readDone: true,
      promosDone: true,
      searchDone: true,
      signPoint: 15,
      readPoint: 30,
      promosPoint: 115,
      searchProgress: "15/15 · M:10/10",
      readProgress: "10/10 篇",
      readArticlesDone: 10,
      cookiesCount: 38,
      sched: {
        dayDone: true,
        rounds: 5,
        pending: [],
        mode: "interval",
        enable: true,
        intervalMinutes: 45,
        nextRunText: "",
      },
    }),
  },
  {
    id: "mock-3",
    name: "未登录账户 C",
    createdAt: Date.now() - 3600000,
    enabled: false,
    config: { ...DEFAULT_CONFIG },
    useGlobal: true,
    state: mkState({ loggedIn: false, hasRefreshToken: false }),
  },
];

let mockAppearance: Appearance = { ...DEFAULT_APPEARANCE };

const DEFAULT_LAUNCH = {
  autoLaunch: false,
  launchToTray: false,
  launchDelay: 10,
  minimizeToTray: true,
};

let mockLaunch = { ...DEFAULT_LAUNCH };
// 预览模式默认「已完成向导」，不挡主界面；
// 想单独调试向导时访问 index.html?wizard 即可强制重新弹出。
let mockSetup: SetupState = {
  done: !/\bwizard\b/.test(typeof location === "undefined" ? "" : location.search),
  lang: "zh-CN",
  agreed: false,
  liquidGlass: true,
  autoLaunch: false,
};

const mockLogs = [
  "[2026-08-31 09:12:03] [INFO] 启动应用",
  "[2026-08-31 09:12:04] [INFO] 已加载 3 个账户",
  "[2026-08-31 09:12:10] [OK] 示例账户 A：签入完成 +15",
  "[2026-08-31 09:12:31] [OK] 示例账户 A：阅读 10/10 篇 +30",
  "[2026-08-31 09:13:02] [WARN] 示例账户 A：活动交卷超时，下轮重试",
  "[2026-08-31 09:14:44] [OK] 示例账户 B：今日任务全部完成",
];

const noop = () => undefined;

// 浏览器预览用的假运行态与订阅者（模拟串行执行，方便直接看转圈/排队徽标）
let mockRunStatus: AccountRunStatusMap = {};
const statusCbs = new Set<(v: { id: string; status: AccountRunStatusValue; reason?: string }) => void>();
const logCbs = new Set<(e: AccountLogEntry) => void>();

function emitStatus(id: string, status: AccountRunStatusValue, reason = "") {
  if (status === "idle") delete mockRunStatus[id];
  else mockRunStatus[id] = { status, reason, at: Date.now() };
  statusCbs.forEach((cb) => {
    try { cb({ id, status, reason }); } catch { /* ignore */ }
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createMockApi(): ElectronApi {
  return {
    listAccounts: async () => mockAccounts,
    createAccount: async (name) => {
      const a: Account = {
        id: `mock-${Date.now()}`,
        name,
        createdAt: Date.now(),
        enabled: true,
        config: { ...DEFAULT_CONFIG },
        useGlobal: true,
        state: mkState({ loggedIn: false, hasRefreshToken: false }),
      };
      mockAccounts = [...mockAccounts, a];
      return { id: a.id, name: a.name, createdAt: a.createdAt, enabled: true };
    },
    removeAccount: async (id) => {
      mockAccounts = mockAccounts.filter((a) => a.id !== id);
      return true;
    },
    renameAccount: async (id, name) => {
      mockAccounts = mockAccounts.map((a) => (a.id === id ? { ...a, name } : a));
      return true;
    },
    setAccountEnabled: async (id, enabled) => {
      mockAccounts = mockAccounts.map((a) => (a.id === id ? { ...a, enabled } : a));
      return true;
    },

    getConfig: async () => ({ ...DEFAULT_CONFIG }),
    setConfig: async (_id, patch) => ({ ...DEFAULT_CONFIG, ...patch }) as AppConfig,
    getOverrides: async () => ({}),
    setUseGlobal: async () => true,

    getGlobalConfig: async () => ({ ...DEFAULT_CONFIG }),
    setGlobalConfig: async (patch) => ({ ...DEFAULT_CONFIG, ...patch }) as AppConfig,

    overview: async () => {
      const stats: Overview["stats"] = {
        total: mockAccounts.length,
        enabled: mockAccounts.filter((a) => a.enabled).length,
        loggedIn: mockAccounts.filter((a) => a.state.loggedIn).length,
        todayPoints: mockAccounts.reduce((s, a) => s + a.state.todayPoints, 0),
        balance: mockAccounts.reduce((s, a) => s + a.state.lastBalance, 0),
        dayDone: mockAccounts.filter((a) => a.state.sched.dayDone).length,
        pendingAccounts: mockAccounts.filter((a) => a.enabled && !a.state.sched.dayDone).length,
      };
      return { accounts: mockAccounts, stats };
    },

    getAppearance: async () => mockAppearance,
    setAppearance: async (patch) => {
      mockAppearance = { ...mockAppearance, ...patch };
      return { ok: true, appearance: mockAppearance, restartNeeded: false };
    },
    getBgSrc: async () => ({ src: mockAppearance.bgType === "none" ? "" : MOCK_WALLPAPER, luma: null }),
    pickImage: async () => null,
    testBgUrl: async () => ({ ok: false, error: "浏览器预览模式不支持探测" }),
    downloadWallpaper: async () => ({ ok: false, error: "浏览器预览模式不支持下载" }),

    getLaunch: async () => mockLaunch,
    setLaunch: async (patch) => {
      mockLaunch = { ...mockLaunch, ...patch };
      return mockLaunch;
    },

    // 浏览器预览模式直接视为已完成，避免向导挡住整页 UI 调试
    getSetup: async () => mockSetup,
    setSetup: async (patch) => {
      mockSetup = { ...mockSetup, ...patch };
      return mockSetup;
    },

    testPush: async () => ({ ok: false, error: "浏览器预览模式不支持推送" }),

    login: async () => ({ ok: false, error: "浏览器预览模式不支持登录" }),
    run: async (id) => {
      const acc = mockAccounts.find((a) => a.id === id);
      emitStatus(id, "running");
      await sleep(1500);
      emitStatus(id, "idle");
      return { ok: true, result: { account: { id, name: acc?.name || id }, tasks: {}, ok: true, reason: "" } as never };
    },
    runAll: async () => {
      const ids = mockAccounts.filter((a) => a.enabled).map((a) => a.id);
      ids.forEach((id, i) => emitStatus(id, i === 0 ? "running" : "waiting"));
      for (const id of ids) {
        emitStatus(id, "running");
        await sleep(1200);
        emitStatus(id, "idle");
      }
      return { ok: true };
    },
    runSelected: async (ids) => {
      ids.forEach((id, i) => emitStatus(id, i === 0 ? "running" : "waiting"));
      for (const id of ids) {
        emitStatus(id, "running");
        await sleep(1200);
        emitStatus(id, "idle");
      }
      return { ok: true };
    },
    sync: async () => ({ ok: false, error: "浏览器预览模式不支持同步" }),
    stop: async () => {
      Object.keys(mockRunStatus).forEach((id) => emitStatus(id, "idle"));
      return { ok: true };
    },
    stopAccount: async (id) => {
      emitStatus(id, "idle");
      return { ok: true };
    },
    isRunning: async () => Object.keys(mockRunStatus).length > 0,
    getRunStatus: async () => mockRunStatus as never,

    getLogs: async () => mockLogs,
    getAccountLogs: async (id) => {
      const acc = mockAccounts.find((a) => a.id === id);
      const name = acc?.name || id;
      const mk = (time: string, level: string, msg: string) => ({
        time, level, msg, accountId: id, accountName: name,
        line: `[${time}] [${level}] [${name}] ${msg}`,
      });
      return [
        mk("2026-08-31 09:12:10", "INFO", `===== 开始运行账户「${name}」 =====`),
        mk("2026-08-31 09:12:12", "OK", "签入完成 +15 分"),
        mk("2026-08-31 09:12:40", "OK", "阅读 10/10 篇 +30 分"),
        mk("2026-08-31 09:13:02", "WARN", "活动交卷超时，下轮重试"),
      ];
    },
    chromiumStatus: async () => ({ ready: true, executable: null }),
    installBrowser: async () => ({ ok: true, method: "mock" }),

    onRunning: noop,
    onLog: noop,
    onAccounts: noop,
    onAppearance: noop,
    onAccountStatus: (cb) => {
      statusCbs.add(cb);
      return () => statusCbs.delete(cb);
    },
    onAccountLog: (cb) => {
      logCbs.add(cb);
      return () => logCbs.delete(cb);
    },
  };
}
