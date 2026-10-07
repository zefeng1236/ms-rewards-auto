import type { ElectronApi } from "../types/electron";
import { DISPLAY_VERSION } from "../version";
import type {
  Account,
  AccountLogEntry,
  AccountRunStatusMap,
  Appearance,
  AppConfig,
  AppearanceSetResult,
  BgSrcResult,
  CheckAppUpdateResult,
  CheckFingerprintUpdateResult,
  ChromiumStatus,
  CloseAction,
  DeepPartial,
  DownloadResult,
  FingerprintStatus,
  ReleaseNotesResult,
  HistorySnapshot,
  Hitokoto,
  InstallBrowserResult,
  InstallFingerprintResult,
  LaunchConfig,
  Overview,
  PushTestResult,
  RunAllOptions,
  RunResult,
  SaveTextResult,
  SetupState,
  TestUrlResult,
  VaultResult,
  VaultStatus,
  WipeResult,
} from "../types";

/**
 * 浏览器（Docker / 无桌面）版的 API 适配器。
 *
 * 目标：让 src-renderer 那套 React 界面**一行都不用改**就能跑在 Web 上。
 * 做法是完整实现 ElectronApi 这套接口，只把传输层换成 HTTP + SSE：
 *   ipcRenderer.invoke(channel, ...args)  →  POST /api/rpc { m, a }
 *   ipcRenderer.on(channel, cb)           →  GET  /api/events（SSE）
 *
 * 少数 Electron 独有的能力在浏览器里没有对应物，做等价替换：
 *   pickImage          → <input type=file> + 上传到服务端，返回落盘路径
 *   saveTextFile       → Blob 触发浏览器下载
 *   downloadWallpaper  → 同上
 *   getBgSrc 的 luma   → 交给 canvas 采样（同源图片不会污染画布）
 *   onClosePrompt      → 无窗口关闭语义，返回空的退订函数
 */

/* ============================== 传输层 ============================== */

class NotLoggedInError extends Error {
  constructor() {
    super("未登录或会话已过期");
    this.name = "NotLoggedInError";
  }
}

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new NotLoggedInError();
  if (!res.ok) {
    // 保险库类接口（/api/vault/*）失败时返回 4xx + { ok:false, error }，
    // 错误文案要原样带给界面（如「密码不正确」），不能只报 HTTP 状态码
    try {
      const parsed = (await res.json()) as { ok?: boolean; error?: string } | null;
      if (parsed && typeof parsed === "object" && parsed.ok === false) return parsed as T;
    } catch { /* 非 JSON 响应体，落到下面抛状态码 */ }
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** 统一 RPC：服务端固定返回 { ok, data } | { ok:false, error } */
async function rpc<T>(m: string, ...a: unknown[]): Promise<T> {
  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ m, a }),
  });
  if (res.status === 401) throw new NotLoggedInError();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { ok: boolean; data?: T; error?: string };
  if (!body.ok) throw new Error(body.error || "请求失败");
  return body.data as T;
}

/* ============================== 事件流 ============================== */

type EventType =
  | "running"
  | "log"
  | "accounts"
  | "appearance"
  | "chromium-status"
  | "fingerprint-status"
  | "account-status"
  | "account-log"
  | "bg-progress"
  | "install-progress";

const listeners: Record<string, Set<(v: unknown) => void>> = {};

function subscribe(type: EventType, cb: (v: never) => void): () => void {
  const set = (listeners[type] ||= new Set());
  set.add(cb as (v: unknown) => void);
  return () => set.delete(cb as (v: unknown) => void);
}

let es: EventSource | null = null;
let streamOpened = false;

/** 打开 SSE。SSE 是长连接，必须带 Cookie，因此未登录时不要开 */
function openStream() {
  if (typeof EventSource === "undefined") return;
  if (streamOpened) return;
  streamOpened = true;
  const connect = () => {
    es = new EventSource("/api/events", { withCredentials: true });
    es.onmessage = (ev) => {
      try {
        const { type, payload } = JSON.parse(ev.data) as { type: EventType; payload: unknown };
        const set = listeners[type];
        if (!set) return;
        for (const cb of set) {
          try { cb(payload); } catch { /* 单个订阅者出错不影响其余 */ }
        }
      } catch { /* 忽略无法解析的心跳/噪声 */ }
    };
    es.onerror = () => {
      // EventSource 自带重连；服务端重启后会自动恢复
    };
  };
  connect();
}

/** 页面从后台恢复时补一次全量拉取（长时间挂起后 SSE 可能已断） */
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && es && es.readyState === EventSource.CLOSED) {
      es.close();
      es = null;
      streamOpened = false;
      openStream();
    }
  });
}

/* ============================== 浏览器专属能力 ============================== */

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function timestampName(ext: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  return `wallpaper-${stamp}.${ext}`;
}

/** 选择本地图片：浏览器文件框 → 上传到服务端 → 返回落盘绝对路径 */
function pickImageFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    // 不挂到 DOM 上也能触发（Safari 需要挂载，这里统一下挂一下）
    input.style.display = "none";
    document.body.appendChild(input);
    input.onchange = async () => {
      const f = input.files && input.files[0];
      input.remove();
      if (!f) return resolve(null);
      try {
        const b64 = toBase64(await f.arrayBuffer());
        const r = await rpc<{ ok: boolean; path?: string }>("saveUploadedImage", f.name, b64);
        resolve(r.ok && r.path ? r.path : null);
      } catch {
        resolve(null);
      }
    };
    // 用户取消时不会触发 change，挂个焦点回来看一眼
    window.addEventListener(
      "focus",
      () => setTimeout(() => { input.remove(); resolve(null); }, 800),
      { once: true }
    );
    input.click();
  });
}

/** 用 canvas 采样壁纸平均亮度（0–1）。同源图片不会污染画布，跨域时静默返回 null */
function sampleLuminance(src: string): Promise<number | null> {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => {
      try {
        const w = 32;
        const h = Math.max(1, Math.round((32 * img.naturalHeight) / (img.naturalWidth || 1)));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        let total = 0;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
          total += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          n += 1;
        }
        resolve(n ? total / n / 255 : null);
      } catch {
        resolve(null); // 画布被跨域污染
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** 从当前地址猜扩展名（用于下载壁纸时给出合理文件名） */
function guessExt(src: string, contentType?: string): string {
  if (contentType) {
    if (/png/i.test(contentType)) return "png";
    if (/webp/i.test(contentType)) return "webp";
    if (/avif/i.test(contentType)) return "avif";
    if (/gif/i.test(contentType)) return "gif";
    if (/jpe?g/i.test(contentType)) return "jpg";
  }
  const m = /\.(jpe?g|png|webp|gif|avif|img)(\?|$)/i.exec(src);
  return m ? (m[1] === "img" ? "jpg" : m[1].toLowerCase()) : "jpg";
}

/* ============================== 适配器实现 ============================== */

export function createWebApi(): ElectronApi {
  // 先探一次会话状态：已登录就直接把事件流接上（未登录时 SSE 会被 401 挡掉）
  void fetch("/api/bootstrap", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((b) => { if (b && (b.hasSession || !b.vault?.configured)) openStream(); })
    .catch(() => {});

  return {
    /* ---------------- 账户 ---------------- */
    listAccounts: () => rpc<Account[]>("listAccounts"),
    createAccount: (name) => rpc("createAccount", name),
    removeAccount: (id) => rpc("removeAccount", id),
    clearAccountData: (id) => rpc("clearAccountData", id),
    renameAccount: (id, name) => rpc("renameAccount", id, name),
    setAccountEnabled: (id, enabled) => rpc("setAccountEnabled", id, enabled),

    /* ---------------- 账户配置 ---------------- */
    getConfig: (id) => rpc<AppConfig>("getConfig", id),
    setConfig: (id, patch) => rpc<AppConfig>("setConfig", id, patch),
    getOverrides: (id) => rpc<DeepPartial<AppConfig>>("getOverrides", id),
    setUseGlobal: (id, v) => rpc("setUseGlobal", id, v),

    /* ---------------- 全局配置 ---------------- */
    getGlobalConfig: () => rpc<AppConfig>("getGlobalConfig"),
    setGlobalConfig: (patch) => rpc<AppConfig>("setGlobalConfig", patch),

    /* ---------------- 仪表盘 ---------------- */
    overview: () => rpc<Overview>("overview"),

    /* ---------------- 外观 ---------------- */
    getAppearance: () => rpc<Appearance>("getAppearance"),
    setAppearance: (patch) => rpc<AppearanceSetResult>("setAppearance", patch),
    getBgSrc: async (opts) => {
      const r = await rpc<BgSrcResult>("getBgSrc", opts || {});
      const luma = await sampleLuminance(r?.src || "");
      return { src: r?.src || "", luma };
    },
    pickImage: () => pickImageFile(),
    testBgUrl: (url) => rpc<TestUrlResult>("testBgUrl", url),
    downloadWallpaper: async (url): Promise<DownloadResult> => {
      if (!url) return { ok: false, error: "当前没有可下载的背景" };
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const blob = await res.blob();
        const name = timestampName(guessExt(url, blob.type));
        triggerDownload(blob, name);
        return { ok: true, path: name, bytes: blob.size };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    saveTextFile: async (text, defaultName): Promise<SaveTextResult> => {
      if (typeof text !== "string" || !text) return { ok: false, error: "没有可保存的内容" };
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
      const base = typeof defaultName === "string" && defaultName ? defaultName : `recovery-key-${stamp}`;
      const name = `${base}.txt`;
      try {
        triggerDownload(new Blob([text], { type: "text/plain;charset=utf-8" }), name);
        return { ok: true, path: name };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },

    /* ---------------- 每日一言 ---------------- */
    getHitokoto: () => rpc<Hitokoto | null>("getHitokoto"),
    // 浏览器版把一言同步到标签页标题（等价于桌面版的原生窗口标题栏）
    setWindowSubtitle: async (text: string) => {
      if (typeof document !== "undefined") {
        const base = `MS Rewards 自动任务 v${DISPLAY_VERSION}`;
        document.title = text && text.trim() ? `${base} · ${text.trim()}` : base;
      }
      return true;
    },

    /* ---------------- 启动与托盘 ---------------- */
    getLaunch: () => rpc<LaunchConfig>("getLaunch"),
    setLaunch: (patch) => rpc<LaunchConfig>("setLaunch", patch),
    closeChoice: (_choice: Exclude<CloseAction, "ask">, _remember: boolean) =>
      rpc<{ ok: boolean }>("closeChoice"),
    onClosePrompt: () => () => { /* Web 无窗口关闭语义 */ },

    /* ---------------- 首次向导 ---------------- */
    getSetup: () => rpc<SetupState>("getSetup"),
    setSetup: (patch) => rpc<SetupState>("setSetup", patch),

    /* ---------------- 保险库 ---------------- */
    getVaultStatus: () => rpc<VaultStatus>("getVaultStatus"),
    vaultSetup: async (password, hint) => {
      const r = await postJSON<VaultResult>("/api/vault/setup", { password, hint });
      if (r.ok) openStream(); // 建库即登录，可以把事件流接上了
      return r;
    },
    vaultUnlock: async (password, remember) => {
      const r = await postJSON<VaultResult>("/api/vault/unlock", { password, remember: !!remember });
      if (r.ok) openStream(); // 解锁成功，可以把事件流接上了
      return r;
    },
    vaultUnlockRecovery: async (key, remember) => {
      const r = await postJSON<VaultResult>("/api/vault/unlock", { recoveryKey: key, remember: !!remember });
      if (r.ok) openStream();
      return r;
    },
    vaultLock: () => rpc<VaultStatus>("vaultLock"),
    vaultChangePassword: (current, next, hint) => rpc<VaultResult>("vaultChangePassword", current, next, hint),
    vaultRecoveryKey: () => rpc<VaultResult>("vaultRecoveryKey"),
    vaultResetPasswordWithRecovery: async (key, next, hint) => {
      // 服务端在重置成功后直接建立登录会话，因此这里走独立路由（与 unlock 一致）
      const r = await postJSON<VaultResult>("/api/vault/reset", {
        recoveryKey: key,
        next,
        hint,
      });
      if (r.ok) openStream();
      return r;
    },
    wipeAccountData: () => postJSON<WipeResult>("/api/vault/wipe", {}),
    passkeyRemove: (id) => rpc<{ ok: boolean; error?: string }>("passkeyRemove", id),

    /* ---------------- 推送测试 ---------------- */
    testPush: (notice) => rpc<PushTestResult>("testPush", notice),

    /* ---------------- 任务 ---------------- */
    login: (id) => rpc<RunResult>("login", id),
    run: (id: string, opts?: RunAllOptions) => rpc<RunResult>("run", id, opts || {}),
    runAll: (opts?: RunAllOptions) => rpc<RunResult>("runAll", opts || {}),
    runSelected: (ids) => rpc<RunResult>("runSelected", ids),
    sync: (id) => rpc<RunResult>("sync", id),
    stop: () => rpc<{ ok: boolean; error?: string }>("stop"),
    stopAccount: (id) => rpc<{ ok: boolean; error?: string }>("stopAccount", id),
    isRunning: () => rpc<boolean>("isRunning"),
    getRunStatus: () => rpc<AccountRunStatusMap>("getRunStatus"),

    /* ---------------- 日志与环境 ---------------- */
    getLogs: () => rpc<string[]>("getLogs"),
    getAccountLogs: (id) => rpc<AccountLogEntry[]>("getAccountLogs", id),
    getAccountLogDays: (id) => rpc<string[]>("getAccountLogDays", id),
    getAccountLogHistory: (id, day) => rpc<AccountLogEntry[]>("getAccountLogHistory", id, day),
    getHistory: (id, year, month) => rpc<HistorySnapshot>("getHistory", id, year, month),
    chromiumStatus: () => rpc<ChromiumStatus>("chromiumStatus"),
    installBrowser: () => rpc<InstallBrowserResult>("installBrowser"),
    fingerprintStatus: () => rpc<FingerprintStatus>("fingerprintStatus"),
    installFingerprint: (opts) => rpc<InstallFingerprintResult>("installFingerprint", opts),
    cancelFingerprintInstall: () => rpc<{ ok: boolean; error?: string }>("cancelFingerprintInstall"),
    uninstallFingerprint: () => rpc<{ ok: boolean; removed?: string[] }>("uninstallFingerprint"),
    // Web/Docker 版无法在运行时切换内核（预装在镜像层，切了也没法重下）
    setFingerprintEngine: async () => ({
      ok: false,
      error: "Web/Docker 版无法切换内核（如需更替请重建镜像）",
    }),
    checkFingerprintUpdate: () => rpc<CheckFingerprintUpdateResult>("checkFingerprintUpdate"),
    checkAppUpdate: () => rpc<CheckAppUpdateResult>("checkAppUpdate"),
    // Web/Docker 版无桌面安装包，更新走 `docker compose pull` 重建镜像，这里返回明确语义
    downloadUpdate: async () => ({ ok: false, error: "Web 版请通过 docker compose pull 更新镜像" }),
    cancelUpdateDownload: async () => ({ ok: true }),
    runUpdateInstaller: async () => ({ ok: false, error: "Web 版无桌面安装包" }),
    revealUpdateFile: async () => ({ ok: false, error: "Web 版无桌面安装包" }),
    releaseNotes: () => rpc<ReleaseNotesResult>("releaseNotes"),
    installUpdate: async () => ({ ok: false, error: "Web 版请通过 docker compose pull 更新镜像" }),
    dismissUpdatePrompt: async () => ({ ok: true }),
    checkUpdateNow: () => rpc<CheckAppUpdateResult>("checkAppUpdate"),
    getRuntimeVersion: () => rpc<{ version: string; base: string; buildNumber: string; electron: string }>("getRuntimeVersion"),
    onUpdatePrompt: () => () => {},
    onUpdateDownloadProgress: () => () => {},

    /* ---------------- 事件订阅 ---------------- */
    onRunning: (cb) => { subscribe("running", cb as (v: never) => void); },
    onLog: (cb) => { subscribe("log", cb as (v: never) => void); },
    onAccounts: (cb) => { subscribe("accounts", cb as (v: never) => void); },
    onAppearance: (cb) => { subscribe("appearance", cb as (v: never) => void); },
onBgProgress: (cb) => subscribe("bg-progress", cb as (v: never) => void),
  onChromiumStatus: (cb) => { subscribe("chromium-status", cb as (v: never) => void); },
  onFingerprintStatus: (cb) => { subscribe("fingerprint-status", cb as (v: never) => void); },
  onInstallProgress: (cb) => subscribe("install-progress", cb as (v: never) => void),
    onAccountStatus: (cb) => subscribe("account-status", cb as (v: never) => void),
    onAccountLog: (cb) => subscribe("account-log", cb as (v: never) => void),
  };
}

/** 登出：销毁本浏览器会话（服务端保留保险库解锁状态，后台任务不受影响） */
export async function webLogout(): Promise<void> {
  try {
    await postJSON("/api/logout", {});
  } catch { /* 忽略 */ }
  streamOpened = false;
  if (es) { es.close(); es = null; }
}

/* ============================== 登录便利：把恢复密钥存在本机 ============================== */

const SAVED_KEY = "msr-saved-recovery-key";

/** 把恢复密钥存进浏览器，下次可一键登录 */
export function saveRecoveryKeyToBrowser(key: string) {
  try { localStorage.setItem(SAVED_KEY, key); } catch { /* 隐私模式下可能失败 */ }
}

export function getSavedRecoveryKey(): string | null {
  try { return localStorage.getItem(SAVED_KEY); } catch { return null; }
}

export function clearSavedRecoveryKey() {
  try { localStorage.removeItem(SAVED_KEY); } catch { /* 忽略 */ }
}
