import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { GlassButton, GlassSurface } from "@ttqtt/liquid-glass-react";
import { toast } from "./liquidGlassCompat";
import { api, IS_WEB } from "../api/ipc";
import { webLogout } from "../api/web";
import { DISPLAY_VERSION } from "../version";
import { useAppState } from "../hooks/useAppState";
import type { ViewKey } from "../App";
import type { InstallProgress } from "../types";

/* 线性图标（24 viewBox / stroke currentColor），随文字颜色联动 */
const ICON_PROPS = {
  viewBox: "0 0 24 24",
  width: 16,
  height: 16,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};
const ICONS: Record<string, React.ReactNode> = {
  dashboard: (
    <svg {...ICON_PROPS}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  account: (
    <svg {...ICON_PROPS}>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  ),
  settings: (
    <svg {...ICON_PROPS}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      <path d="M9 7h7" />
      <path d="M9 11h7" />
      <path d="M9 15h4" />
    </svg>
  ),
  software: (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  /* —— 软件设置页的分类选项卡图标 —— */
  personalize: (
    <svg {...ICON_PROPS}>
      <path d="M12 2.5s6.5 6.9 6.5 11.4a6.5 6.5 0 0 1-13 0C5.5 9.4 12 2.5 12 2.5z" />
    </svg>
  ),
  launch: (
    <svg {...ICON_PROPS}>
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <path d="M12 2v10" />
    </svg>
  ),
  browser: (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  ),
  security: (
    <svg {...ICON_PROPS}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  ),
  back: (
    <svg {...ICON_PROPS}>
      <path d="M19 12H5" />
      <path d="M12 19l-7-7 7-7" />
    </svg>
  ),
  about: (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  ),
};

type NavEntry = { key: ViewKey; label: string; icon: React.ReactNode };
const NAV_GROUPS: { label: string; items: NavEntry[] }[] = [
  {
    label: "工作台",
    items: [
      { key: "dashboard", label: "仪表盘", icon: ICONS.dashboard },
      { key: "account", label: "账户详情", icon: ICONS.account },
      { key: "settings", label: "任务全局设置", icon: ICONS.settings },
      { key: "software", label: "软件设置", icon: ICONS.software },
    ],
  },
  { label: "其它", items: [{ key: "about", label: "关于", icon: ICONS.about }] },
];

/**
 * 软件设置页的左侧分类选项卡。
 *
 * 进入「软件设置」后整个侧边栏切换成这份列表：点击平滑滚动定位到对应分区，
 * 右侧滚动时由 SoftwareSettingsView 的 scroll-spy 反过来更新高亮；
 * 列表底部（nav-foot）另有「返回」回到仪表盘。
 */
const SW_TABS: { key: string; label: string; icon: React.ReactNode }[] = IS_WEB
  ? [
      { key: "personalize", label: "个性化", icon: ICONS.personalize },
      { key: "browser", label: "浏览器", icon: ICONS.browser },
      { key: "security", label: "安全", icon: ICONS.security },
    ]
  : [
      { key: "personalize", label: "个性化", icon: ICONS.personalize },
      { key: "launch", label: "启动与托盘", icon: ICONS.launch },
      { key: "browser", label: "浏览器", icon: ICONS.browser },
      { key: "security", label: "安全", icon: ICONS.security },
    ];

export function Sidebar({
  view,
  onViewChange,
  swSection,
  onSwSectionClick,
}: {
  view: ViewKey;
  onViewChange: (v: ViewKey) => void;
  /** 当前处于软件设置页时传当前分类 key，其它页面传 null */
  swSection?: string | null;
  onSwSectionClick?: (key: string) => void;
}) {
  const { chromium, logOpen, setLogOpen, accounts } = useAppState();
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<InstallProgress | null>(null);

  /* 滑动高亮胶囊：量取当前项在列表里的位置，transform 过去（首帧不播动画） */
  const listRef = useRef<HTMLElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const [ind, setInd] = useState({ y: 0, h: 38, ready: false });

  // 软件设置页里胶囊跟随分类选项卡，其余页面跟随主导航
  const inSwMode = view === "software" && !!swSection;
  const activeKey = inSwMode ? `sw-${swSection}` : view;

  /**
   * 侧栏列表的进出场动画：主导航 ⇄ 软件设置分类选项卡。
   *
   * 直接按 inSwMode 条件渲染会瞬间换掉整列（观感很硬）。这里拆成两步：
   * 先给当前列表挂 is-out 播 150ms 离场，再挂载新列表播入场（见 global.css 的
   * .nav-switch / navSwitchIn）。胶囊在离场期间淡出（is-hidden）—— 它的位置跳变
   * 必须发生在不可见时，否则会从「软件设置」那一行硬瞬移到分类第一行。
   */
  const targetMode: "main" | "sw" = inSwMode ? "sw" : "main";
  const [navMode, setNavMode] = useState<"main" | "sw">(targetMode);
  const [switching, setSwitching] = useState(false);
  const [indHidden, setIndHidden] = useState(false);

  useEffect(() => {
    if (targetMode === navMode) {
      // 离场途中又切回来（快速点进再返回）：立刻取消，别让列表卡在淡出态
      if (switching) setSwitching(false);
      if (indHidden) setIndHidden(false);
      return;
    }
    setSwitching(true);
    setIndHidden(true);
    const t = setTimeout(() => {
      setNavMode(targetMode);
      setSwitching(false);
    }, 150);
    return () => clearTimeout(t);
  }, [targetMode, navMode, switching, indHidden]);

  // 新列表挂载完（胶囊已在新位置且仍不可见）再放开，让它淡入而不是瞬移。
  // 依赖只放 navMode：否则上面刚置 true 就会被这里立刻清掉，离场途中胶囊提前显形。
  useEffect(() => {
    if (!indHidden) return;
    const raf = requestAnimationFrame(() => setIndHidden(false));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navMode]);

  const measure = useCallback(() => {
    const btn = itemRefs.current.get(activeKey);
    if (!btn) return;
    setInd((prev) => {
      const y = btn.offsetTop;
      const h = btn.offsetHeight;
      return prev.y === y && prev.h === h && prev.ready ? prev : { y, h, ready: true };
    });
    // navMode 也要进依赖：列表整列换掉后按钮是新挂载的，位置得重新量
  }, [activeKey, navMode]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // 字体加载 / 侧栏滚动容器尺寸变化都会改变条目位置，跟着重量
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measure()) : null;
    if (ro) ro.observe(list);
    window.addEventListener("resize", measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  // 订阅安装进度
  useEffect(() => {
    if (IS_WEB) return;
    const off = (api as any).onInstallProgress?.((p: InstallProgress) => setProgress(p));
    return () => { if (off) off(); };
  }, []);

  const onInstall = async () => {
    setInstalling(true);
    setProgress({ pct: 0 });
    try {
      const r = await api.installBrowser();
      if (r.ok) {
        toast.success("Chromium 安装完成");
        setProgress(null);
      } else {
        toast.error(r.error || "Chromium 安装失败");
        setProgress(null);
      }
    } finally {
      setInstalling(false);
    }
  };

  return (
    <GlassSurface className="sidenav" radius={0}>
      <div className="nav-brand">
        <img className="nav-logo-img" src="./icon.png" alt="" draggable={false} />
        <div style={{ minWidth: 0 }}>
          <div className="nav-title">Rewards Auto</div>
          <div className="nav-sub">Microsoft Rewards</div>
        </div>
      </div>

      <nav
        className="nav-list"
        aria-label="主导航"
        ref={listRef}
      >
        {/* 整列切换的进出场动画容器：胶囊放进内部，与列表共用同一个定位基准，
            滑入时胶囊跟着列表一起进来（放在 nav 上会与列表脱节、且定位基准不同） */}
        <div className={"nav-switch" + (switching ? " is-out" : "")} key={navMode}>
          <div
            className={
              "nav-indicator" + (ind.ready ? " is-ready" : "") + (indHidden ? " is-hidden" : "")
            }
            style={{ transform: `translateY(${ind.y}px)`, height: ind.h }}
            aria-hidden
          />
          {navMode === "sw" ? (
            <div className="nav-group">
              <div className="nav-group-label">软件设置</div>
              {SW_TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  ref={(el) => {
                    if (el) itemRefs.current.set(`sw-${t.key}`, el);
                    else itemRefs.current.delete(`sw-${t.key}`);
                  }}
                  className={"nav-item" + (swSection === t.key ? " is-active" : "")}
                  aria-current={swSection === t.key ? "true" : undefined}
                  onClick={() => onSwSectionClick?.(t.key)}
                >
                  <span className="nav-item-icon">{t.icon}</span>
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          ) : (
            NAV_GROUPS.map((group) => (
              <div key={group.label} className="nav-group">
                <div className="nav-group-label">{group.label}</div>
                {group.items.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    ref={(el) => {
                      if (el) itemRefs.current.set(item.key, el);
                      else itemRefs.current.delete(item.key);
                    }}
                    className={"nav-item" + (view === item.key ? " is-active" : "")}
                    aria-current={view === item.key ? "page" : undefined}
                    onClick={() => onViewChange(item.key)}
                  >
                    <span className="nav-item-icon">{item.icon}</span>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </nav>

      <div className="nav-foot">
        <span className={`badge ${chromium?.ready ? "ok" : "warn"}`}>
          {chromium ? (chromium.ready ? "● Chromium 就绪" : "▲ 缺失 Chromium") : "检查中…"}
        </span>

        {chromium && !chromium.ready && (
          <div className="nav-install-wrap">
            <GlassButton
              variant="plain"
              controlSize="small"
              onClick={onInstall}
              loading={installing && !progress}
              disabled={installing && !progress}
              className={
                "nav-install-btn" +
                (progress
                  ? progress.pct != null && progress.pct >= 100
                    ? " is-done"
                    : " is-progress"
                  : "")
              }
              style={
                progress && progress.pct != null && progress.total
                  ? ({
                      "--install-pct": `${Math.min(99, progress.pct)}%`,
                    } as React.CSSProperties)
                  : undefined
              }
            >
              {progress
                ? progress.pct != null && progress.pct >= 100
                  ? "✓ 安装完成"
                  : `正在下载 ${progress.pct ?? 0}%`
                : "安装 Chromium"}
            </GlassButton>
            {progress && progress.pct != null && progress.pct < 100 && (
              <div className="nav-install-meta" title="下载进度（主进程实时推送）">
                <div className="nav-install-track">
                  <div
                    className="nav-install-fill"
                    style={{ width: `${Math.min(99, progress.pct)}%` }}
                  />
                </div>
                {progress.speed != null && progress.speed > 0 && (
                  <span className="nav-install-speed">
                    {formatBytes(progress.speed)}/s
                    {progress.eta != null && progress.eta > 0 ? ` · ETA ${Math.round(progress.eta)}s` : ""}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        <GlassButton variant="glass" controlSize="small" onClick={() => setLogOpen(!logOpen)}>
          ▤ 运行日志
        </GlassButton>

        {IS_WEB && (
          <GlassButton variant="glass" controlSize="small"
            title="打开 noVNC 远程桌面（查看服务器浏览器授权窗口）"
            onClick={() => {
              const novncUrl = `${location.protocol}//${location.hostname}:6080/vnc.html`;
              window.open(novncUrl, "_blank");
            }}
          >
            🖥 远程桌面
          </GlassButton>
        )}

        {IS_WEB && (
          <GlassButton variant="plain" controlSize="small"
            title="仅退出当前浏览器的登录，后台定时任务继续运行"
            onClick={async () => {
              await webLogout();
              window.location.reload();
            }}
          >
            ⏏ 退出登录
          </GlassButton>
        )}

        <div className="hint">共 {accounts.length} 个账户</div>

        {/* 软件设置页：底部「返回」退出分类模式 */}
        {inSwMode && (
          <button
            type="button"
            className="nav-item nav-back"
            onClick={() => onViewChange("dashboard")}
            title="返回仪表盘"
          >
            <span className="nav-item-icon">{ICONS.back}</span>
            <span>返回</span>
          </button>
        )}

        {/* 左下角版本号（v 主版本.交付号，与安装包文件名一致） */}
        <div className="nav-version hint" title="当前软件版本">
          v{DISPLAY_VERSION}
        </div>
      </div>
    </GlassSurface>
  );
}

function formatBytes(n: number): string {
  if (!n || n < 0) return "--";
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  return (n / 1024 / 1024).toFixed(1) + "MB";
}
