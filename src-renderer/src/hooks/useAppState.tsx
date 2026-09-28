import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../api/ipc";
import { formatQuote } from "../utils";
import type {
  Account,
  AccountRunStatus,
  AccountRunStatusMap,
  Appearance,
  AppConfig,
  ChromiumStatus,
  HitokotoPosition,
  OverviewStats,
} from "../types";

/** 日志最大保留行数（主进程侧返回最近 500 行，这里保持一致） */
const MAX_LOGS = 500;
/** 日志批量刷新的节流间隔 */
const LOG_FLUSH_MS = 200;

/** 合法的一言显示位置；取值与 src/hitokoto.js 的 POSITIONS.key 严格对应 */
const HITOKOTO_POSITIONS: HitokotoPosition[] = ["sidebar", "bottomRight", "topbar"];
/** 位置归一化：旧配置缺字段 / 值被改坏时回落到左下角侧边栏 */
function normalizePosition(v: unknown): HitokotoPosition {
  return HITOKOTO_POSITIONS.includes(v as HitokotoPosition) ? (v as HitokotoPosition) : "sidebar";
}

interface AppStateValue {
  accounts: Account[];
  stats: OverviewStats | null;
  appearance: Appearance | null;
  /**
   * 全局配置（含 notice.hitokoto / notice.hitokotoPosition）。
   * 一言的开关与显示位置属于它，所以界面要能读到 —— 这也是唯一需要
   * 脱离账户单独读取配置的地方（外观同理，但外观走独立的 appearance 接口）。
   */
  globalConfig: AppConfig | null;
  /**
   * 每日一言的展示文本（已含作者后缀）。
   * 未启用一言、或公益接口取不到时为 "" —— 界面据此整块隐藏，不留空白占位。
   */
  hitokoto: string;
  /** 一言在界面上的显示位置（已归一化，非法值回落 sidebar） */
  hitokotoPosition: HitokotoPosition;
  logs: string[];
  running: boolean;
  chromium: ChromiumStatus | null;
  /** 每账号运行态：running 转圈 / waiting 排队 / warning 橙感叹号 / error 红错误；空闲无键 */
  runStatus: AccountRunStatusMap;
  /** 取某账号运行态，空闲返回 null（不显示任何标记） */
  getAccountStatus: (id: string) => AccountRunStatus | null;
  /** 首次数据加载完成前为 true，用于避免闪烁 */
  loading: boolean;
  /** 日志面板开合（持久化到 localStorage） */
  logOpen: boolean;
  setLogOpen: (v: boolean) => void;

  refreshAccounts: () => Promise<void>;
  refreshLogs: () => Promise<void>;
  /** 全局配置变更（如一言开关/位置）后重拉，让生效结果即时可见 */
  refreshGlobalConfig: () => Promise<void>;
  clearLogs: () => void;
  patchAppearance: (patch: Partial<Appearance>) => Promise<void>;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [appearance, setAppearance] = useState<Appearance | null>(null);
  const [globalConfig, setGlobalConfig] = useState<AppConfig | null>(null);
  const [hitokoto, setHitokoto] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState<AccountRunStatusMap>({});
  const [chromium, setChromium] = useState<ChromiumStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [logOpen, setLogOpenState] = useState(
    () => localStorage.getItem("msr-log-open") === "1"
  );

  const setLogOpen = useCallback((v: boolean) => {
    setLogOpenState(v);
    localStorage.setItem("msr-log-open", v ? "1" : "0");
  }, []);

  // 日志写盘很频繁，直接 setState 会造成大量重渲染。
  // 先攒进 buffer，再按固定间隔批量合并 —— 沿用原版 renderer 的做法。
  const logBuffer = useRef<string[]>([]);

  const refreshAccounts = useCallback(async () => {
    try {
      const ov = await api.overview();
      setAccounts(ov.accounts || []);
      setStats(ov.stats || null);
    } catch {
      // 读取失败时保留旧数据，不让界面整个空掉
    }
  }, []);

  const refreshLogs = useCallback(async () => {
    try {
      const list = await api.getLogs();
      setLogs(list.slice(-MAX_LOGS));
    } catch {
      /* 忽略 */
    }
  }, []);

  const refreshGlobalConfig = useCallback(async () => {
    try {
      const cfg = await api.getGlobalConfig();
      setGlobalConfig(cfg || null);
    } catch {
      // 读不到就保持旧值；一言不会因此崩掉整页
    }
  }, []);

  const clearLogs = useCallback(() => {
    logBuffer.current = [];
    setLogs([]);
  }, []);

  const patchAppearance = useCallback(async (patch: Partial<Appearance>) => {
    const r = await api.setAppearance(patch);
    if (r?.appearance) setAppearance(r.appearance);
  }, []);

  // ---- 每日一言 ----
  // 开关默认开启（缺字段当作开）。后端 30 秒 TTL 缓存，前端每 30 秒轮询一次。
  // 窗口隐藏（最小化/切到后台）时暂停轮询，切回来时立即刷新一次再恢复 ——
  // 既省请求（公益接口 QPS 2），又不会让界面停在过时的一句话上。
  const hitokotoEnabled = globalConfig?.notice?.hitokoto !== false;
  useEffect(() => {
    if (!hitokotoEnabled) {
      setHitokoto("");
      return;
    }
    let alive = true;
    const TICK_MS = 30_000;

    const fetchQuote = () => {
      api
        .getHitokoto()
        .then((q) => {
          if (alive) setHitokoto(formatQuote(q));
        })
        .catch(() => {});
    };

    fetchQuote();

    let timer: number | null = null;
    const start = () => {
      if (timer == null) timer = window.setInterval(fetchQuote, TICK_MS);
    };
    const stop = () => {
      if (timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        // 从后台切回来：可能已经过了很久，立即刷新一次
        fetchQuote();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      alive = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [hitokotoEnabled, globalConfig]);

  const getAccountStatus = useCallback(
    (id: string): AccountRunStatus | null => {
      const s = runStatus[String(id)];
      if (!s || s.status === "idle") return null;
      return s;
    },
    [runStatus]
  );

  // ---- 首次加载 ----
  useEffect(() => {
    let alive = true;
    (async () => {
      const [ap, cr, run, statusMap] = await Promise.all([
        api.getAppearance().catch(() => null),
        api.chromiumStatus().catch(() => null),
        api.isRunning().catch(() => false),
        api.getRunStatus().catch(() => ({})),
      ]);
      if (!alive) return;
      if (ap) setAppearance(ap);
      if (cr) setChromium(cr);
      setRunning(!!run);
      setRunStatus(statusMap || {});
      await Promise.all([refreshAccounts(), refreshLogs(), refreshGlobalConfig()]);
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [refreshAccounts, refreshLogs, refreshGlobalConfig]);

  // ---- 主进程推送订阅 ----
  useEffect(() => {
    api.onAccounts((list) => {
      setAccounts(list || []);
      // 账户数据变了，概览统计也要跟着更新
      api.overview().then((ov) => setStats(ov.stats || null)).catch(() => {});
    });
    api.onAppearance((v) => setAppearance(v));
    api.onRunning((v) => setRunning(!!v));
    api.onChromiumStatus((v) => setChromium(v));
    api.onLog((line) => {
      logBuffer.current.push(line);
    });
    // 每账号运行态：running/waiting/warning/error/idle 单条增量更新
    const offStatus = api.onAccountStatus((v) => {
      if (!v || v.id == null) return;
      const id = String(v.id);
      setRunStatus((prev) => {
        const next = { ...prev };
        if (v.status === "idle") delete next[id];
        else next[id] = { status: v.status, reason: v.reason || "", at: Date.now() };
        return next;
      });
    });
    return () => {
      if (typeof offStatus === "function") offStatus();
    };
  }, []);

  // ---- 日志缓冲定期落盘到 state ----
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (logBuffer.current.length === 0) return;
      const incoming = logBuffer.current;
      logBuffer.current = [];
      setLogs((prev) => {
        const next = prev.concat(incoming);
        return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
      });
    }, LOG_FLUSH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const value = useMemo<AppStateValue>(
    () => ({
      accounts,
      stats,
      appearance,
      globalConfig,
      hitokoto,
      hitokotoPosition: normalizePosition(globalConfig?.notice?.hitokotoPosition),
      logs,
      running,
      chromium,
      runStatus,
      getAccountStatus,
      loading,
      logOpen,
      setLogOpen,
      refreshAccounts,
      refreshLogs,
      refreshGlobalConfig,
      clearLogs,
      patchAppearance,
    }),
    [
      accounts,
      stats,
      appearance,
      globalConfig,
      hitokoto,
      logs,
      running,
      chromium,
      runStatus,
      getAccountStatus,
      loading,
      logOpen,
      setLogOpen,
      refreshAccounts,
      refreshLogs,
      refreshGlobalConfig,
      clearLogs,
      patchAppearance,
    ]
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState 必须在 AppStateProvider 内使用");
  return ctx;
}
