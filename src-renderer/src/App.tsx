import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  Button,
  createTheme,
  LiquidGlassConfig,
  Toaster,
  GlassSurface,
  ProgressiveBlur,
  toast,
} from "@ttqtt/liquid-glass-react";
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
import { Personalize } from "./views/Personalize";
import { LaunchSettings } from "./views/LaunchSettings";
import { About } from "./views/About";
import { SetupWizard } from "./views/SetupWizard";
import { VaultLock } from "./views/VaultLock";
import { ClosePrompt } from "./components/ClosePrompt";
import { BgProgressBubble } from "./components/BgProgressBubble";
import type { SetupState, VaultStatus } from "./types";

export type ViewKey = "dashboard" | "account" | "settings" | "personalize" | "launch" | "about";

const VIEW_META: Record<ViewKey, { title: string; desc: string }> = {
  dashboard: { title: "仪表盘", desc: "所有账户的运行概况与今日进度。" },
  account: { title: "账户详情", desc: "单个账户的任务进度与独立配置。" },
  settings: { title: "全局设置", desc: "所有「遵循全局设置」的账号共用这份配置，改动立即生效。" },
  personalize: { title: "个性化", desc: "主题、壁纸与液态玻璃效果。" },
  launch: { title: "启动与托盘", desc: "开机自启动、驻留托盘与启动延迟等系统行为设置。" },
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
  // 解析深浅主题并写入 <html data-theme>；autoTheme 打开时由壁纸亮度 +
  // 两套主题色的合成对比度决定（亮壁纸→深色主题白字，暗壁纸→浅色主题黑字），
  // 花色壁纸按「哪套主题的文字真的看得清」来选，而不是简单看平均亮度。
  useTheme(appearance?.mode, appearance?.autoTheme === true, luma, appearance?.bgDim);
  const [view, setView] = useState<ViewKey>("dashboard");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 首次启动向导：setup.done 为 false 时挡在最前面，走完写入 done=true
  const [setup, setSetup] = useState<SetupState | null>(null);
  // 保险库状态：已启用加密但未解锁时，用锁屏挡住主界面
  const [vault, setVault] = useState<VaultStatus | null>(null);
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
        setSetup({ done: true, lang: "zh-CN", agreed: true, liquidGlass: true, autoLaunch: false })
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

  // 从仪表盘点「查看详情」时直接跳到账户页并选中该账户
  const openAccount = useCallback((id: string) => {
    setSelectedId(id);
    setView("account");
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
      }) as CSSProperties,
    [appearance?.bgDim]
  );

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
      <>
        <SetupWizard onDone={() => setSetup({ ...setup, done: true })} />
        {/* 向导是独立 early-return 分支，不经过主界面的 <Toaster/>；
            保存数字密钥 / 下载 txt 等操作的 toast 必须在这里单独挂一个，
            否则 toast.success() 发出去却没有容器渲染 → 用户看到「点了没反应」 */}
        <Toaster position="bottom-right" max={3} />
        <BgProgressBubble />
        {closePrompt}
      </>
    );
  }

  // 已启用加密但本次没解开：挡在锁屏后，解不出登录态就不能跑任务
  if (vault.configured && !vault.unlocked) {
    return (
      <>
        <VaultLock onUnlocked={() => setVault({ ...vault, unlocked: true })} />
        <Toaster position="bottom-right" max={3} />
        <BgProgressBubble />
        {closePrompt}
      </>
    );
  }

  const meta = VIEW_META[view];

  return (
    // glass 开关关掉时走 forceFallback —— 复用库自带的毛玻璃降级通道，
    // 比自己维护两套样式干净得多。
    <LiquidGlassConfig forceFallback={!appearance?.glass} theme={glassTheme}>
      <div style={shellStyle}>
        {bgSrc && (
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
        )}

        {/* 主题衬底：有壁纸时给整屏文字垫一层可控底色（见 global.css） */}
        {bgSrc && <div className="shell-scrim" />}

        <div className="shell">
          <Sidebar view={view} onViewChange={setView} />

          <div className="content">
            <header className="topbar">
              <div style={{ position: "relative", zIndex: 1 }}>
                <h1>{meta.title}</h1>
                <p>{meta.desc}</p>
              </div>
              <div className="topbar-actions" style={{ position: "relative", zIndex: 1 }}>
                <TopbarActions view={view} />
              </div>
              {/* 顶栏下缘的渐进模糊带，让内容与顶栏自然过渡 */}
              <ProgressiveBlur direction="to-bottom" size={28} maxBlur={10} />
            </header>

            <div className="scroll-area">
              {view === "dashboard" && <Dashboard onOpenAccount={openAccount} />}
              {view === "account" && (
                <AccountDetail selectedId={selectedId} onSelect={setSelectedId} />
              )}
              {view === "settings" && <SettingsView />}
              {view === "personalize" && <Personalize bgSrc={bgSrc} onShuffle={shuffleBg} />}
              {view === "launch" && <LaunchSettings />}
              {view === "about" && <About />}
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
    <GlassSurface as="div" radius={999} material="clear" style={{ display: "flex", gap: 6, padding: 6 }}>
      <Button variant="glass" size="sm" onClick={onRefresh} loading={busy} title="重新读取账户数据">
        ⟳ 刷新
      </Button>
      {view === "dashboard" && (
        <Button variant="accent" size="sm" onClick={onRunAll} disabled={running} title="依次运行所有已启用账户">
          ▶ 运行全部
        </Button>
      )}
      {running && (
        <Button variant="danger" size="sm" onClick={onStop} title="中断当前任务">
          ■ 停止
        </Button>
      )}
    </GlassSurface>
  );
}
