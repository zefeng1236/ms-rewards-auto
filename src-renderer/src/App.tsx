import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { GlassButton, GlassSurface } from "@ttqtt/liquid-glass-react";
import { createTheme, LiquidGlassConfig, Toaster, toast } from "./components/liquidGlassCompat";
import { api } from "./api/ipc";
import { AppStateProvider, useAppState } from "./hooks/useAppState";
import { useBackground } from "./hooks/useBackground";
import { useTheme } from "./hooks/useTheme";
import { useLiquidGlassHalo } from "./hooks/useLiquidGlassHalo";
import { Sidebar } from "./components/Sidebar";
import { LogConsole } from "./components/LogConsole";
import { Dashboard } from "./views/Dashboard";
import { AccountDetail } from "./views/AccountDetail";
import { SettingsView } from "./views/SettingsView";
import { SoftwareSettingsView } from "./views/SoftwareSettingsView";
import { About } from "./views/About";
import { SetupWizard } from "./views/SetupWizard";
import { VaultLock } from "./views/VaultLock";
import { ClosePrompt } from "./components/ClosePrompt";
import { BgProgressBubble } from "./components/BgProgressBubble";
import type { SetupState, VaultStatus } from "./types";

export type ViewKey = "dashboard" | "account" | "settings" | "software" | "about";

const VIEW_META: Record<ViewKey, { title: string; desc: string }> = {
  dashboard: { title: "仪表盘", desc: "所有账户的运行概况与今日进度。" },
  account: { title: "账户详情", desc: "单个账户的任务进度与独立配置。" },
  settings: { title: "任务全局设置", desc: "与任务执行有关的全局配置，所有「遵循全局设置」的账号共用，改动立即生效。" },
  software: { title: "软件设置", desc: "外观个性化、启动与托盘、浏览器与安全等软件自身的行为设置。" },
  about: { title: "关于", desc: "版本信息、第三方开源组件与友情链接。" },
};

export default function App() {
  return (
    <AppStateProvider>
      <Shell />
    </AppStateProvider>
  );
}

function Shell() {
  const { appearance, loading } = useAppState();
  const { src: bgSrc, ambient, reload: shuffleBg, luma } = useBackground();
  // 修复玻璃库指针光晕不跟手的 bug（详见 hook 注释）
  // 指针光晕独立开关：与玻璃表面解耦（玻璃 fallback 面板同样带 .lg-surface，光晕仍可见）
  useLiquidGlassHalo(appearance?.pointerHalo === true);
  // 首次启动向导：setup.done 为 false 时挡在最前面，走完写入 done=true
  const [setup, setSetup] = useState<SetupState | null>(null);
  // 保险库状态：已启用加密但未解锁时，用锁屏挡住主界面
  const [vault, setVault] = useState<VaultStatus | null>(null);
  // 流场背景是深紫黑底，只有配深色主题（白字）才读得清。流场只出现在
  // 登录页/向导（authBg，见 AuthBackground），因此仅在「未走完向导或未解锁」
  // 的登录前分支强制深色；解锁进主界面后主题交还给用户设置。
  const preAuthFlow =
    appearance?.authBg !== "bing" && !(setup?.done === true && vault?.unlocked === true);
  const resolvedTheme = useTheme(
    preAuthFlow ? "dark" : appearance?.mode,
    preAuthFlow ? false : appearance?.autoTheme === true,
    luma,
    appearance?.bgDim
  );
  const [view, setView] = useState<ViewKey>("dashboard");
  // 软件设置页的当前分类：侧栏选项卡高亮与右侧 scroll-spy 共用
  const [swSec, setSwSec] = useState<string>("personalize");
  // 点击选项卡后的平滑滚动加锁时间戳：滚动期间 scroll-spy 的上报一律忽略，
  // 否则途经的分区会把胶囊来回拽（点击定位 → spy 抢高亮 → 视觉抖动）
  const swScrollLockRef = useRef(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 点 × 关闭且关闭行为为「每次询问」时，主进程推事件要求弹选项卡
  const [closePromptOpen, setClosePromptOpen] = useState(false);

  useEffect(() => {
    const off = api.onClosePrompt(() => setClosePromptOpen(true));
    return off;
  }, []);

  useEffect(() => {
    api
      .getSetup()
      .then(setSetup)
      // 取不到向导状态时不该把用户锁在门外，直接当作已完成
      .catch(() =>
        setSetup({ done: true, lang: "zh-CN", agreed: true, liquidGlass: true, autoLaunch: false, launchToTray: false })
      );
  }, []);

  useEffect(() => {
    api
      .getVaultStatus()
      .then(setVault)
      // 取不到就当作没启用加密，不拦截正常使用
      .catch(() =>
        setVault({ configured: false, unlocked: true, keychain: false, hint: "", byEnv: false })
      );
  }, []);

  // 有无壁纸会影响文字可读性（浅色主题下尤其明显），挂到 <html> 上供 CSS 微调
  useEffect(() => {
    if (bgSrc) document.documentElement.setAttribute("data-wallpaper", "1");
    else document.documentElement.removeAttribute("data-wallpaper");
  }, [bgSrc]);

  // 外观预设挂到 <html>：透明/亚克力/毛玻璃的 CSS 层即时反馈，opaque 强制实心
  useEffect(() => {
    const p = appearance?.preset;
    if (p) document.documentElement.setAttribute("data-preset", p);
    else document.documentElement.removeAttribute("data-preset");
  }, [appearance?.preset]);

  // 背景氛围光开关：这场开关此前没有任何消费方（拖动/切换都无反应）。
  // 挂到 <html> 上，由 CSS 关掉 body::before 的两团辉光。
  // 有壁纸时辉光被壁纸层盖住（本来就看不见），无壁纸时才真正影响画面。
  useEffect(() => {
    if (appearance?.glow === false) document.documentElement.setAttribute("data-glow", "off");
    else document.documentElement.removeAttribute("data-glow");
  }, [appearance?.glow]);

  // 「鼠标指针光晕」开关只关掉了项目自绘的 halo（useLiquidGlassHalo），但库自带一层
  // 跟手光斑 .lg-glow（pointerenter 时打 data-lit 点亮、跟随鼠标）完全不受这个开关控制，
  // 深色下关掉开关后侧边栏等玻璃组件照样有光。这里把状态挂到 <html>，由 CSS 一并关掉库光斑。
  useEffect(() => {
    if (appearance?.pointerHalo === false)
      document.documentElement.setAttribute("data-halo", "off");
    else document.documentElement.removeAttribute("data-halo");
  }, [appearance?.pointerHalo]);

  // 把用户主题色写入 <html> 的 --accent，让全局 var(--accent) 消费方（开关 on 色、
  // 焦点环、向导 dot、进度条等）真正跟随「个性化」页的选择。
  // 此前 --accent 只在 :root 里写死成 #3b82f6，改主题色后除了喂给玻璃库的
  // --lg-accent 之外全部没反应 —— 开关 on 色覆盖写的是 var(--accent, var(--lg-green))，
  // 于是永远落在写死的蓝/绿上（用户反馈「主题色变更之后开关没变化」）。
  useEffect(() => {
    const el = document.documentElement;
    if (appearance?.accent) el.style.setProperty("--accent", appearance.accent);
    else el.style.removeProperty("--accent");
  }, [appearance?.accent]);

  // 从仪表盘点「查看详情」时直接跳到账户页并选中该账户
  const openAccount = useCallback((id: string) => {
    setSelectedId(id);
    setView("account");
  }, []);

  // 软件设置：点侧栏分类选项卡 → 高亮 + 平滑滚动定位到对应分区
  const handleSwSectionClick = useCallback((key: string) => {
    setSwSec(key);
    swScrollLockRef.current = Date.now() + 900;
    document.getElementById(`swsec-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // 软件设置：右侧滚动 → scroll-spy 上报当前分类（加锁期间忽略）
  const handleSwSpy = useCallback((key: string) => {
    setSwSec((prev) => (Date.now() < swScrollLockRef.current || prev === key ? prev : key));
  }, []);

  // 把项目配色 + 壁纸环境色喂给玻璃库。
  // accent 取自用户主题色，ambient 由壁纸取样得到（取不到时为 undefined，库用默认）。
  const glassTheme = useMemo(
    () =>
      createTheme({
        accent: appearance?.accent || undefined,
        ambient: ambient || undefined,
      }),
    [appearance?.accent, ambient]
  );

  const shellStyle = useMemo(
    () =>
      ({
        "--bg-dim": String(appearance?.bgDim ?? 0.25),
        // 面板不透明度：compat 层用它调制内容材质（.app-material-card）的填充 alpha。
        // 之前这个滑块只存在于设置界面，没有任何消费方 → 拖动完全没反应。
        "--panel-opacity": String(appearance?.opacity ?? 1),
      }) as CSSProperties,
    [appearance?.bgDim, appearance?.opacity]
  );

  // 主界面壁纸层：只跟随主界面 bgType。流场动画不在这里——它只属于登录页/
  // 向导的 AuthBackground（0.13.1 曾全局默认流场，用户纠正后拆分）。
  // 向导 / 锁屏分支不再挂这层，由各视图自带 AuthBackground。
  const bgLayer = bgSrc ? (
    <>
      <div className="bg-layer">
        <div
          className="bg-image"
          style={{
            backgroundImage: `url("${bgSrc}")`,
            filter: `blur(${appearance?.bgBlur ?? 4}px)`,
          }}
        />
        <div className="bg-tint" />
      </div>
      <div className="shell-scrim" />
    </>
  ) : null;

  if (loading || !setup || !vault) {
    return (
      <div className="empty" style={{ height: "100vh" }}>
        <div className="empty-icon">◍</div>
        <p>正在加载账户数据…</p>
      </div>
    );
  }

  // 关闭选项卡：三条界面分支（向导 / 锁屏 / 主界面）下点 × 都可能被主进程询问
  const closePrompt = closePromptOpen ? (
    <ClosePrompt onClose={() => setClosePromptOpen(false)} />
  ) : null;

  // 首次启动：向导走完才进主界面
  if (!setup.done) {
    return (
      <LiquidGlassConfig appearance={resolvedTheme} forceFallback={!appearance?.glass} theme={glassTheme}>
        <SetupWizard onDone={() => setSetup({ ...setup, done: true })} />
        {/* 向导是独立 early-return 分支，不经过主界面的 <Toaster/>；
            保存数字密钥 / 下载 txt 等操作的 toast 必须在这里单独挂一个，
            否则 toast.success() 发出去却没有容器渲染 → 用户看到「点了没反应」 */}
        <Toaster position="bottom-right" max={3} />
        <BgProgressBubble />
        {closePrompt}
      </LiquidGlassConfig>
    );
  }

  // 已启用加密但本次没解开：挡在锁屏后，解不出登录态就不能跑任务
  if (vault.configured && !vault.unlocked) {
    return (
      <LiquidGlassConfig appearance={resolvedTheme} forceFallback={!appearance?.glass} theme={glassTheme}>
        <VaultLock onUnlocked={() => setVault({ ...vault, unlocked: true })} />
        <Toaster position="bottom-right" max={3} />
        <BgProgressBubble />
        {closePrompt}
      </LiquidGlassConfig>
    );
  }

  const meta = VIEW_META[view];

  return (
    // glass 开关关掉时走 forceFallback —— 复用库自带的毛玻璃降级通道，
    // 比自己维护两套样式干净得多。
    <LiquidGlassConfig
      appearance={resolvedTheme}
      forceFallback={!appearance?.glass}
      theme={glassTheme}
    >
      <div style={shellStyle}>
        {bgLayer}

        <div className="shell">
          <Sidebar
            view={view}
            onViewChange={setView}
            swSection={view === "software" ? swSec : null}
            onSwSectionClick={handleSwSectionClick}
          />

          <div className="content">
            <header className="topbar">
              <div style={{ position: "relative", zIndex: 1 }}>
                <h1>{meta.title}</h1>
                <p>{meta.desc}</p>
              </div>
              <div className="topbar-actions" style={{ position: "relative", zIndex: 1 }}>
                <TopbarActions view={view} />
              </div>
              {/* 顶栏下缘不再放渐进模糊带：topbar 与内容区都是全透明，唯一被它"过渡"的
                  只有壁纸本身，真机细节壁纸上会显形成一条横贯全页的模糊条（用户反馈）。 */}
            </header>

            {/* key=当前视图：切页时重挂载，内容区播一次上浮淡入（.view-enter） */}
            <div className="scroll-area">
              <div className="view-enter" key={view}>
                {view === "dashboard" && <Dashboard onOpenAccount={openAccount} />}
                {view === "account" && (
                  <AccountDetail selectedId={selectedId} onSelect={setSelectedId} />
                )}
                {view === "settings" && <SettingsView />}
                {view === "software" && (
                  <SoftwareSettingsView bgSrc={bgSrc} onShuffle={shuffleBg} onSpySec={handleSwSpy} />
                )}
                {view === "about" && <About />}
              </div>
            </div>
          </div>
        </div>

        <LogConsole />
        {closePrompt}
        <Toaster position="bottom-right" max={3} />
        <BgProgressBubble />
      </div>
    </LiquidGlassConfig>
  );
}

/** 顶栏右侧操作：刷新 / 运行全部 / 停止 */
function TopbarActions({ view }: { view: ViewKey }) {
  const { running, refreshAccounts } = useAppState();
  const [busy, setBusy] = useState(false);

  const onRefresh = async () => {
    setBusy(true);
    await refreshAccounts();
    setBusy(false);
  };

  const onRunAll = async () => {
    const r = await api.runAll();
    if (!r.ok) toast.error(r.error || "运行失败");
    await refreshAccounts();
  };

  const onStop = async () => {
    const r = await api.stop();
    if (!r.ok && r.error) toast.error(r.error);
  };

  return (
    <GlassSurface radius={999} material="clear" style={{ display: "flex", gap: 6, padding: 6 }}>
      <GlassButton variant="glass" controlSize="small" onClick={onRefresh} loading={busy} title="重新读取账户数据">
        ⟳ 刷新
      </GlassButton>
      {view === "dashboard" && (
        <GlassButton variant="glassProminent" controlSize="small" onClick={onRunAll} disabled={running} title="依次运行所有已启用账户">
          ▶ 运行全部
        </GlassButton>
      )}
      {running && (
        <GlassButton variant="destructive" controlSize="small" onClick={onStop} title="中断当前任务">
          ■ 停止
        </GlassButton>
      )}
    </GlassSurface>
  );
}
