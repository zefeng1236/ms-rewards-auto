import type {
  Account,
  AccountLogEntry,
  AccountRunStatusMap,
  AccountRunStatusValue,
  AppConfig,
  Appearance,
  InstallProgress,
  LaunchConfig,
  Overview,
  RunAllOptions,
  SetupState,
  VaultResult,
  VaultStatus,
} from "../types";
import type { ElectronApi } from "../types/electron";
import { DISPLAY_VERSION } from "../version";
import { mergeDeep } from "../utils";

/**
 * 浏览器直开（非 Electron）时使用的假后端。
 *
 * 目的：让 `vite dev` 能脱离 Electron 单独预览 UI —— 玻璃效果、布局、
 * 交互都能在浏览器里直接看，不必每次都打包启动客户端。
 * window.api 存在时（真实 Electron 环境）完全不会走到这里。
 */

const DEFAULT_CONFIG: AppConfig = {
  useGlobal: true,
  tasks: { sign: true, read: true, daily: true, promos: true, claim: false, search: true },
  region: { lock: true, ipProvider: "bing" },
  search: { span: 30, api: "offline" },
  limits: { random: false, read: 6, promos: 0, search: 6 },
  schedule: {
    enable: true,
    mode: "interval",
    intervalMinutes: 45,
    stopWhenDone: true,
    maxRounds: 0,
    time: "08:00",
    windows: [{ start: "09:00", end: "23:00" }],
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
    hitokotoPosition: "sidebar",
  },
  logging: { retentionDays: 7 },
  goals: {
    enable: true,
    items: [{ name: "积分目标", scope: "balance", target: 300, rewardName: "", showDashboard: true }],
  },
  browser: {
    // mirror 默认值必须与 src/config.js / src/global-config.js 一致（selfcheck 有跨文件守卫）
    fingerprint: { enable: true, seed: 0, brand: "Chrome", hardwareConcurrency: 0, platform: "windows", mirror: "cdn.gh-proxy.org" },
  },
};

/**
 * 全局配置的**可变副本**（仅 mock 用）。
 *
 * 预览环境需要「改了就是改了」：若 getGlobalConfig 每次都返回常量，设置页改完
 * 立刻被 refreshGlobalConfig 冲回默认值 —— 一言「显示位置」这类全局项在浏览器
 * 预览里根本切不动，容易被误判成功能坏了（2026-10-01 排查标题栏一言时踩到）。
 * 账户级仍用只读的 DEFAULT_CONFIG，避免污染各账户初始值。
 */
let defaultConfig: AppConfig = mergeDeep({} as AppConfig, DEFAULT_CONFIG) as AppConfig;

const DEFAULT_APPEARANCE: Appearance = {
  preset: "normal",
  mode: "dark",
  opacity: 1,
  accent: "#3b82f6",
  glow: true,
  bgType: "bing",
  authBg: "flow",
  bgUrl: "",
  bgFile: "",
  bgCategory: "random",
  bgUnsplashKey: "",
  bgRotate: 0,
  bgBlur: 4,
  bgDim: 0.25,
  glass: true,
  pointerHalo: true,
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

/**
 * 浏览器预览用的模拟一言。
 * 走真实接口的话，调样式时会把公益 API 打一遍；预览只需看到排版效果。
 */
function MOCK_HITOKOTO() {
  return {
    text: "世界上只有一种真正的英雄主义，那就是认清生活的真相后依然热爱它。",
    from: "米开朗基罗传",
    fromWho: "罗曼·罗兰",
    uuid: "preview-mode",
    date: new Date().toISOString().slice(0, 10),
  };
}

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
  closeAction: "ask" as const,
};

let mockLaunch: LaunchConfig = { ...DEFAULT_LAUNCH };
// 预览模式默认「已完成向导」，不挡主界面；
// 想单独调试向导时访问 index.html?wizard 即可强制重新弹出。
let mockSetup: SetupState = {
  done: !/\bwizard\b/.test(typeof location === "undefined" ? "" : location.search),
  lang: "zh-CN",
  agreed: false,
  liquidGlass: true,
  autoLaunch: false,
  launchToTray: false,
};

// 保险库：预览模式只模拟状态流转，不做任何真实加密
let mockVault: VaultStatus = {
  configured: false,
  unlocked: false,
  keychain: true,
  hint: "",
  byEnv: false,
};
const MOCK_RECOVERY = "cHJldmlldy1tb2RlLWRlbW8ta2V5（预览模式示例）";
let mockVaultPw = "";

// ?lock 强制「已建库但未解锁」状态，用于登录页（VaultLock）调试
if (typeof location !== "undefined" && /\block\b/.test(location.search)) {
  mockVault = { ...mockVault, configured: true };
}

const mockLogs = [
  "[2026-08-31 09:12:03] [INFO] 启动应用",
  "[2026-08-31 09:12:04] [INFO] 已加载 3 个账户",
  "[2026-08-31 09:12:10] [OK] 示例账户 A：签入完成 +15",
  "[2026-08-31 09:12:31] [OK] 示例账户 A：阅读 10/10 篇 +30",
  "[2026-08-31 09:13:02] [WARN] 示例账户 A：积分活动超时，下轮重试",
  "[2026-08-31 09:14:44] [OK] 示例账户 B：今日任务全部完成",
];

const noop = () => undefined;

// 浏览器预览用的假运行态与订阅者（模拟串行执行，方便直接看转圈/排队徽标）
let mockRunStatus: AccountRunStatusMap = {};
const statusCbs = new Set<(v: { id: string; status: AccountRunStatusValue; reason?: string }) => void>();
const logCbs = new Set<(e: AccountLogEntry) => void>();
// 指纹浏览器「下载进度」订阅者：预览模式没有真实下载，这里伪造一条进度流，
// 好在浏览器里直接调进度条样式与文案（向导第 6 页 / 设置页面板都用它）。
const fpProgressCbs = new Set<(p: InstallProgress) => void>();

function emitFpProgress(p: InstallProgress) {
  fpProgressCbs.forEach((cb) => {
    try { cb(p); } catch { /* ignore */ }
  });
}

/** 预览模式下的「指纹浏览器是否已安装」，由 installFingerprint 置真 */
let mockFpReady = false;
let mockFpCancel = false;

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
    clearAccountData: async (id) => {
      mockAccounts = mockAccounts.map((a) =>
        a.id === id
          ? { ...a, useGlobal: true, config: { ...DEFAULT_CONFIG }, state: mkState({ loggedIn: false, hasRefreshToken: false }) }
          : a
      );
      return { ok: true };
    },
    renameAccount: async (id, name) => {
      mockAccounts = mockAccounts.map((a) => (a.id === id ? { ...a, name } : a));
      return true;
    },
    setAccountEnabled: async (id, enabled) => {
      mockAccounts = mockAccounts.map((a) => (a.id === id ? { ...a, enabled } : a));
      return true;
    },

    getConfig: async () => ({ ...defaultConfig }),
    setConfig: async (_id, patch) => ({ ...defaultConfig, ...patch }) as AppConfig,
    getOverrides: async () => ({}),
    setUseGlobal: async () => true,

    // 预览环境保留写入（否则设置页改完立刻被 refreshGlobalConfig 冲回默认值，
    // 一言「显示位置」这类全局项在浏览器预览里根本切不动，容易误判成功能失效）
    getGlobalConfig: async () => ({ ...defaultConfig }),
    setGlobalConfig: async (patch) => {
      defaultConfig = mergeDeep(defaultConfig, patch) as AppConfig;
      return { ...defaultConfig };
    },

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
    getBgSrc: async (opts) => {
      // auth=true：登录页/向导背景 —— authBg=bing 给示例壁纸，flow 返回空（渲染端播流场）
      if (opts?.auth) {
        return { src: mockAppearance.authBg === "bing" ? MOCK_WALLPAPER : "", luma: null };
      }
      return { src: mockAppearance.bgType === "none" ? "" : MOCK_WALLPAPER, luma: null };
    },
    pickImage: async () => null,
    testBgUrl: async () => ({ ok: false, error: "浏览器预览模式不支持探测" }),
    downloadWallpaper: async () => ({ ok: false, error: "浏览器预览模式不支持下载" }),
    saveTextFile: async () => ({ ok: false, error: "浏览器预览模式不支持保存文件" }),

    getLaunch: async () => mockLaunch,
    setLaunch: async (patch) => {
      mockLaunch = { ...mockLaunch, ...patch };
      return mockLaunch;
    },
    // 预览模式：选择不上报，弹窗组件自己负责收尾
    closeChoice: async () => ({ ok: true }),
    onClosePrompt: () => () => {},

    // 浏览器预览模式直接视为已完成，避免向导挡住整页 UI 调试
    getSetup: async () => mockSetup,
    setSetup: async (patch) => {
      mockSetup = { ...mockSetup, ...patch };
      return mockSetup;
    },

    // 保险库：预览模式只模拟状态流转，不做任何真实加密
    getVaultStatus: async () => mockVault,
    vaultSetup: async (password, hint) => {
      if (mockVault.configured) return { ok: false, error: "保险库已配置，请勿重复设置" };
      if (!password || password.length < 6) return { ok: false, error: "密码至少 6 位" };
      mockVaultPw = password;
      mockVault = { ...mockVault, configured: true, unlocked: true, hint: hint || "" };
      return { ok: true, recoveryKey: MOCK_RECOVERY };
    },
    vaultUnlock: async (password, _remember) => {
      if (!mockVault.configured) return { ok: false, error: "尚未配置保险库" };
      if (password !== mockVaultPw) return { ok: false, error: "密码错误，请重试" };
      mockVault = { ...mockVault, unlocked: true };
      return { ok: true };
    },
    vaultUnlockRecovery: async (key, _remember) => {
      if (key !== MOCK_RECOVERY) return { ok: false, error: "恢复密钥不正确" };
      mockVault = { ...mockVault, unlocked: true };
      return { ok: true };
    },
    vaultLock: async () => {
      mockVault = { ...mockVault, unlocked: false };
      return mockVault;
    },
    vaultChangePassword: async (cur, next) => {
      if (cur !== mockVaultPw) return { ok: false, error: "当前密码不正确" };
      if (!next || next.length < 6) return { ok: false, error: "新密码至少 6 位" };
      mockVaultPw = next;
      return { ok: true };
    },
    vaultRecoveryKey: async (): Promise<VaultResult> => ({ ok: true, recoveryKey: MOCK_RECOVERY }),
    vaultResetPasswordWithRecovery: async (key, next) => {
      if (key !== MOCK_RECOVERY) return { ok: false, error: "恢复密钥不正确" };
      if (!next || next.length < 6) return { ok: false, error: "新密码至少 6 位" };
      mockVaultPw = next;
      mockVault = { ...mockVault, unlocked: true };
      return { ok: true };
    },
    wipeAccountData: async () => {
      const n = mockAccounts.length;
      mockAccounts.length = 0;
      mockVault = { configured: false, unlocked: true, keychain: false, hint: "", byEnv: false };
      mockVaultPw = "";
      return { ok: true, accounts: n, logs: n, vault: true, wallpaperKey: true, wizardReset: true };
    },
    passkeyRemove: async () => ({ ok: false, error: "浏览器预览模式不支持通行密钥" }),

    getHitokoto: async () => MOCK_HITOKOTO(),
    // 预览模式没有原生窗口标题栏，仅同步一份到 document.title 方便肉眼验证
    setWindowSubtitle: async (text: string) => {
      if (typeof document !== "undefined") {
        const base = `MS Rewards 自动任务 v${DISPLAY_VERSION}`;
        document.title = text && text.trim() ? `${base} · ${text.trim()}` : base;
      }
      return true;
    },

    testPush: async () => ({ ok: false, error: "浏览器预览模式不支持推送" }),

    login: async () => ({ ok: false, error: "浏览器预览模式不支持登录" }),
    run: async (id: string, _opts?: RunAllOptions) => {
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
        mk("2026-08-31 09:13:02", "WARN", "积分活动超时，下轮重试"),
      ];
    },
    getAccountLogDays: async () => ["2026-08-31", "2026-08-30"],
    // 日历假数据：造一整月有绿/橙/灰/红四态 + 若干勋章，方便脱机调样式
    getHistory: async (_id, year, month) => {
      const now = new Date();
      const y = year || now.getFullYear();
      const m = month || now.getMonth() + 1;
      const total = new Date(y, m, 0).getDate();
      const pad = (n: number) => String(n).padStart(2, "0");
      // 假农历日名（dev 预览用，非精确农历；真实数据由后端 lunar.js 算）
      const LUNAR_DAYS = [
        "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
        "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
        "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十",
      ];
      // 2026 中秋/国庆 休班样例，方便预览「休/班」角标效果
      const holidayMap: Record<string, { name: string; rest: boolean }> = {
        "2026-09-25": { name: "中秋", rest: true },
        "2026-09-26": { name: "中秋", rest: true },
        "2026-09-27": { name: "中秋", rest: true },
        "2026-10-01": { name: "国庆", rest: true },
        "2026-10-02": { name: "国庆", rest: true },
        "2026-10-03": { name: "国庆", rest: true },
        "2026-10-04": { name: "国庆", rest: true },
        "2026-10-05": { name: "国庆", rest: true },
        "2026-10-06": { name: "国庆", rest: true },
        "2026-10-07": { name: "国庆", rest: true },
        "2026-10-10": { name: "国庆", rest: false },
      };
      const festMap: Record<string, string> = {
        "2026-09-25": "中秋", // 农历八月十五
        "2026-10-01": "国庆",
        "2026-10-31": "万圣",
      };
      // 用日期做伪随机，保证每次渲染同一天颜色不变
      const days = Array.from({ length: total }, (_, i) => {
        const d = i + 1;
        const key = `${y}-${pad(m)}-${pad(d)}`;
        const seed = (y * 10000 + m * 100 + d) % 10;
        const status = seed < 6 ? "done" : seed < 8 ? "partial" : seed === 8 ? "error" : "idle";
        const wd = new Date(y, m - 1, d).getDay();
        const weekend = wd === 0 || wd === 6;
        const holi = holidayMap[key];
        const rest = !!holi && holi.rest;
        const workday = !!holi && !holi.rest;
        const fest = festMap[key] || "";
        const lunar = LUNAR_DAYS[(d - 1) % 30];
        return {
          day: d,
          key,
          status: status as "done" | "partial" | "idle" | "error",
          done: status === "done" ? 5 : status === "partial" ? 3 : 0,
          total: 5,
          points: status === "done" ? 82 : status === "partial" ? 45 : 0,
          hasRecord: status !== "idle",
          weekend,
          lunar,
          festival: fest,
          holidayName: holi ? holi.name : "",
          rest,
          workday,
          label: fest || lunar,
        };
      });
      return {
        month: { year: y, month: m, days, perfect: false, doneDays: days.filter((x) => x.status === "done").length },
        streak: 4,
        badges: {
          streak3: { count: 3, last: `${y}-${pad(m)}-04` },
          streak7: { count: 1, last: `${y}-${pad(m)}-07` },
          midautumn: { count: 1, last: "2026-09-25" },
          halloween: { count: 1, last: "2026-10-31" },
          perfectMonth: { count: 1, last: "2026-01-31", month: "2026-01" },
        },
        stats: {
          first: "2026-08-01", trackedDays: total, doneDays: days.filter((x) => x.status === "done").length,
          partialDays: days.filter((x) => x.status === "partial").length,
          errorDays: days.filter((x) => x.status === "error").length,
          totalPoints: days.reduce((s, x) => s + x.points, 0),
          streak: 4, bestStreak: 12, badgeCount: 5, badgeTotal: 7,
        },
        years: [y],
        today: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      };
    },
    getAccountLogHistory: async (id, day) => {
      const acc = mockAccounts.find((a) => a.id === id);
      const name = acc?.name || id;
      return [{
        time: `${day} 08:00:00`, level: "INFO", msg: "历史日志示例", accountId: id, accountName: name,
        line: `[${day} 08:00:00] [INFO] [${name}] 历史日志示例`,
      }];
    },
    chromiumStatus: async () => ({ ready: true, executable: null }),
    installBrowser: async () => ({ ok: true, method: "mock" }),
    fingerprintStatus: async () => ({
      supported: true,
      platform: "win32",
      ready: mockFpReady,
      executable: null,
      version: mockFpReady ? "148.0.7778.215" : null,
      pinned: "148.0.7778.215",
      installDir: "<storage>/fingerprint-chromium",
      // 预览模式按桌面版（运行时下载）呈现；Docker 版由真实后端返回 preinstalled: true
      preinstalled: false,
      downloadUrl: null,
      mirrors: [
        { value: "auto", label: "自动（按顺序尝试全部）", latencyMs: null },
        { value: "gh-proxy.com", label: "gh-proxy.com（实测最快） · 128ms", latencyMs: 128 },
        { value: "v4.gh-proxy.org", label: "v4.gh-proxy.org（官方推荐） · 203ms", latencyMs: 203 },
        { value: "cdn.gh-proxy.org", label: "cdn.gh-proxy.org（Fastly） · 356ms", latencyMs: 356 },
        { value: "gh-proxy.org", label: "gh-proxy.org · 412ms", latencyMs: 412 },
        { value: "axisnow.gh-proxy.org", label: "axisnow.gh-proxy.org · 780ms", latencyMs: 780 },
        { value: "v6.gh-proxy.org", label: "v6.gh-proxy.org（IPv6 线路） · 超时", latencyMs: null },
        { value: "direct", label: "直连 GitHub · 超时", latencyMs: null },
      ],
    }),
    installFingerprint: async () => {
      mockFpCancel = false;
      // 预览模式：伪造一条下载进度流（约 5 秒走完），好在浏览器里直接调进度条样式与文案
      const steps: Array<[number, string]> = [
        [0, "准备下载指纹浏览器 148.0.7778.215（约 181MB，走 gh-proxy 镜像链）"],
        [9, "gh-proxy.com · 6.26 MB/s · 剩余约 28s"],
        [31, "gh-proxy.com · 5.80 MB/s · 剩余约 21s"],
        [58, "gh-proxy.com · 6.02 MB/s · 剩余约 13s"],
        [82, "校验下载完整性（308,093,440 字节）"],
      ];
      for (const [pct, message] of steps) {
        if (mockFpCancel) {
          emitFpProgress({ stage: "fingerprint", pct, message: "下载已取消" });
          return { ok: false, canceled: true, error: "下载已取消" };
        }
        // stage 必须带：侧边栏靠它把指纹进度与 Chromium 进度分开显示
        emitFpProgress({ stage: "fingerprint", pct, message });
        await sleep(950);
      }
      mockFpReady = true;
      return { ok: true, version: "148.0.7778.215", method: "mock" };
    },
    cancelFingerprintInstall: async () => {
      mockFpCancel = true;
      return { ok: true };
    },
    uninstallFingerprint: async () => ({ ok: true }),
    checkFingerprintUpdate: async () => ({
      ok: true,
      latest: "148.0.7778.215",
      installed: null,
      pinned: "148.0.7778.215",
      updateAvailable: false,
      reinstallAvailable: true,
    }),
    // 预览模式：伪造一个比当前版本新的正式版，方便直接看到 NEW 徽标与更新弹窗样式。
    // 加 900ms 延迟模拟真实网络往返，让「检查中」转圈态在预览里也能看到（真实环境本就有时延）。
    checkAppUpdate: async () => {
      await sleep(900);
      return {
        ok: true,
        updateAvailable: true,
        currentVersion: "0.13.12",
        latestVersion: "0.14.0",
        downloadUrl: "https://github.com/zefeng1236/ms-rewards-auto/releases/download/v0.14.0/MS-Rewards-Auto-Setup-0.14.0.exe",
        assetName: "MS-Rewards-Auto-Setup-0.14.0.exe",
        pageUrl: "https://github.com/zefeng1236/ms-rewards-auto/releases/tag/v0.14.0",
        releaseNotes:
          "## What's Changed\n\n- Web/Docker 登录页重做为 1Panel 风格：左侧品牌插画 + 右侧表单，主登录方式为 Passkey（WebAuthn）\n- 容器自签 HTTPS：入口自动生成证书（SAN 含 localhost），Passkey 所需安全上下文开箱即用\n- 保险库自动解锁：重启后守护自动解锁并照常执行定时任务\n\n### Improvements\n\n- /api/health 新增 tls 与 passkey 状态字段\n- 设置页新增 Passkey 注册/删除与「重启后自动解锁」开关",
        publishedAt: new Date().toISOString(),
      };
    },

    onRunning: noop,
    onLog: noop,
    onAccounts: noop,
    onAppearance: noop,
    onBgProgress: () => () => {},
    onChromiumStatus: noop,
    onFingerprintStatus: noop,
    // 预览模式：安装一次后状态翻成「就绪」，方便看放行后的界面
    onInstallProgress: (cb) => {
      fpProgressCbs.add(cb);
      return () => fpProgressCbs.delete(cb);
    },
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
