import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { GlassButton, GlassSurface } from "@ttqtt/liquid-glass-react";
import { toast } from "./liquidGlassCompat";
import { UpdateDialog } from "./UpdateDialog";
import { api, IS_WEB } from "../api/ipc";
import { webLogout } from "../api/web";
import { DISPLAY_VERSION } from "../version";
import { useAppState } from "../hooks/useAppState";
import type { ViewKey } from "../App";
import type { CheckAppUpdateResult, FingerprintStatus, InstallProgress } from "../types";

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
  achievements: (
    <svg {...ICON_PROPS}>
      <path d="M7 4h10v5a5 5 0 0 1-10 0V4z" />
      <path d="M17 5h3v1.5a3 3 0 0 1-3 3" />
      <path d="M7 5H4v1.5a3 3 0 0 0 3 3" />
      <path d="M12 14v3" />
      <path d="M8 21h8" />
      <path d="M9 21a3 3 0 0 1 6 0" />
    </svg>
  ),
  update: (
    <svg {...ICON_PROPS}>
      <path d="M21 12a9 9 0 0 1-15.5 6.3" />
      <path d="M3 12a9 9 0 0 1 15.5-6.3" />
      <path d="M21 4v6h-6" />
      <path d="M3 20v-6h6" />
    </svg>
  ),
};

type NavEntry = { key: ViewKey; label: string; icon: React.ReactNode };
/**
 * 主导航分组（2026-10-03 用户调整了顺序与归属）：
 *   - 「成就与统计」移到「任务全局设置」**下面**（原来在仪表盘下面）
 *   - 「软件设置」移到「其它」分组，且放在「关于」**上面**
 * 顺序是有语义的：工作台里放「日常操作」，其它里放「低频 / 关于本软件」。
 */
const NAV_GROUPS: { label: string; items: NavEntry[] }[] = [
  {
    label: "工作台",
    items: [
      { key: "dashboard", label: "仪表盘", icon: ICONS.dashboard },
      { key: "account", label: "账户详情", icon: ICONS.account },
      { key: "settings", label: "任务全局设置", icon: ICONS.settings },
      { key: "achievements", label: "成就与统计", icon: ICONS.achievements },
    ],
  },
  {
    label: "其它",
    items: [
      { key: "software", label: "软件设置", icon: ICONS.software },
      { key: "about", label: "关于", icon: ICONS.about },
    ],
  },
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
      { key: "update", label: "更新", icon: ICONS.update },
    ]
  : [
      { key: "personalize", label: "个性化", icon: ICONS.personalize },
      { key: "launch", label: "启动与托盘", icon: ICONS.launch },
      { key: "browser", label: "浏览器", icon: ICONS.browser },
      { key: "security", label: "安全", icon: ICONS.security },
      { key: "update", label: "更新", icon: ICONS.update },
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
  const { chromium, logOpen, setLogOpen, accounts, hitokoto, hitokotoPosition } = useAppState();

  /** 点击一言复制到剪切板 */
  const copyHitokoto = () => {
    if (!hitokoto) return;
    navigator.clipboard?.writeText(hitokoto).then(
      () => toast.success("一言已复制"),
      () => {}
    );
  };
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  // 环境拟真浏览器（可选增强）状态：就绪与否 + 正在下载时的实时进度。
  // 与 Chromium 的进度分开存 —— 两者共用同一条 install-progress 通道，
  // 靠 payload.stage 区分（环境特征 = "fingerprint"），混在一起会让徽章串台。
  const [fp, setFp] = useState<FingerprintStatus | null>(null);
  const [fpProg, setFpProg] = useState<InstallProgress | null>(null);

  /* 应用更新检查：启动后查一次 GitHub Releases（主进程/Web 端自动走 gh-proxy 加速）。
     查到更新 → logo 右上角亮 NEW 徽标；点徽标弹更新日志（可滚动）+ 立即更新/取消。
     查询失败（离线 / 仓库未开源）一律静默，不弹错误骚扰用户。 */
  const [updateInfo, setUpdateInfo] = useState<CheckAppUpdateResult | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .checkAppUpdate()
      .then((r) => {
        if (alive && r && r.ok && r.updateAvailable) setUpdateInfo(r);
      })
      .catch(() => {
        /* 静默：检查更新失败不影响主功能 */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Web 版的「退出登录」只在真的存在登录态时才有意义。
  // 保险库没设密码时服务端 needLogin=false、根本不下发会话，此时点按钮
  // 只会把页面刷新一下 —— 看上去就是「点了没反应」。与其让它无效，不如不显示。
  const [webLoggedIn, setWebLoggedIn] = useState(false);
  useEffect(() => {
    if (!IS_WEB) return;
    let alive = true;
    api
      .getVaultStatus()
      .then((s) => {
        if (alive) setWebLoggedIn(!!s && !!s.configured);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

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

  // 订阅安装进度（Chromium 与环境拟真浏览器共用一条通道，按 stage 分流）
  useEffect(() => {
    if (IS_WEB) return;
    const off = (api as any).onInstallProgress?.((p: InstallProgress) => {
      if (p.stage === "fingerprint" || p.stage === "fingerprint/download") setFpProg(p);
      else setProgress(p);
    });
    return () => { if (off) off(); };
  }, []);

  // 环境拟真浏览器状态：首帧拉一次 + 订阅主进程推送（安装/卸载后会自动刷新）
  useEffect(() => {
    let alive = true;
    (api as any).fingerprintStatus?.()
      .then((v: FingerprintStatus) => { if (alive) setFp(v); })
      .catch(() => { /* 读不到就不显示该徽章 */ });
    const off = (api as any).onFingerprintStatus?.((v: FingerprintStatus) => setFp(v));
    return () => {
      alive = false;
      if (typeof off === "function") off();
    };
  }, []);

  // 下载中（stage=fingerprint 且未到 100%）才显示进度态
  const fpDownloading = !!fpProg && !(typeof fpProg.pct === "number" && fpProg.pct >= 100);

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
          <div className="nav-sub">MS Rewards</div>
        </div>
        {updateInfo && (
          <button
            type="button"
            className="nav-update-badge"
            aria-label={`发现新版本 ${updateInfo.latestVersion}，点击查看更新日志`}
            title={`发现新版本 ${updateInfo.latestVersion}`}
            onClick={() => setUpdateOpen(true)}
          >
            <span>NEW</span>
          </button>
        )}
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

        {/* 环境拟真浏览器（可选增强）状态：下载中显示百分比 + 进度条，其余显示就绪/未安装 */}
        {(fpDownloading || (fp && fp.supported)) && (
          <>
            <span className={`badge ${fpDownloading ? "warn" : fp?.ready ? "ok" : "warn"}`}>
              {fpDownloading
                ? `▼ 环境拟真浏览器 ${typeof fpProg?.pct === "number" ? Math.min(99, fpProg.pct) : 0}%`
                : fp?.ready
                  ? "● 环境拟真浏览器就绪"
                  : "○ 环境拟真浏览器未安装"}
            </span>
            {fpDownloading && (
              <div className="nav-install-meta" title={fpProg?.message || "环境拟真浏览器下载进度"}>
                <div className="nav-install-track">
                  <div
                    className="nav-install-fill"
                    style={{ width: `${typeof fpProg?.pct === "number" ? Math.min(99, fpProg.pct) : 0}%` }}
                  />
                </div>
                {fpProg?.speed != null && fpProg.speed > 0 && (
                  <span className="nav-install-speed">{formatBytes(fpProg.speed)}/s</span>
                )}
              </div>
            )}
          </>
        )}

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

        {IS_WEB && webLoggedIn && (
          <GlassButton variant="plain" controlSize="small"
            title="仅退出当前浏览器的登录，后台定时任务继续运行"
            onClick={async () => {
              await webLogout();
              toast.success("已退出登录，正在返回登录页…");
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

        {/* 一言（左下角位置，默认）：贴在侧边栏最底部、版本号正上方。
            多行显示不截断 —— 侧栏宽度有限但纵向空间富余，小字折行比一排省略号更好读 */}
        {hitokoto && hitokotoPosition === "sidebar" && (
          <div className="nav-hitokoto hk-clickable" title="点击复制" onClick={copyHitokoto}>
            {hitokoto}
          </div>
        )}

        {/* 左下角版本号（v 主版本.交付号，与安装包文件名一致）；点击也可打开自动更新弹窗
            DISPLAY_VERSION 自带完整展示文案（见 src/version.ts），UI 不再硬拼前缀 v——
            否则一旦上游接口漏剥前导 v，UI 会拼出 "VV0.13.15" 这种双 V bug（2026-10-03
            用户反馈，selfcheck 守卫不准 UI 拼 v）。 */}
        <button
          type="button"
          className="nav-version hint nav-version-btn"
          title="当前软件版本 · 点击检查更新"
          onClick={() => setUpdateOpen(true)}
        >
          {DISPLAY_VERSION}
        </button>
      </div>

      <UpdateDialog open={updateOpen} onOpenChange={setUpdateOpen} />
    </GlassSurface>
  );
}

function formatBytes(n: number): string {
  if (!n || n < 0) return "--";
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  return (n / 1024 / 1024).toFixed(1) + "MB";
}
