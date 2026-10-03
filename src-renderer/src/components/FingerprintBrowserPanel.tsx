import { useEffect, useState } from "react";
import { GlassButton } from "@ttqtt/liquid-glass-react";
import { AppCard, Tag, toast } from "./liquidGlassCompat";
import { NumberField, SelectField, SwitchField } from "./fields";
import { api } from "../api/ipc";
import type {
  AppConfig,
  CheckFingerprintUpdateResult,
  FingerprintStatus,
  InstallProgress,
} from "../types";

type FpCfg = AppConfig["browser"]["fingerprint"];

// ⚠️ mirror 默认值必须与 src/config.js / src/global-config.js 一致（selfcheck 有跨文件守卫）
const FALLBACK: FpCfg = {
  enable: false,
  seed: 0,
  brand: "Chrome",
  hardwareConcurrency: 0,
  platform: "windows",
  mirror: "cdn.gh-proxy.org",
};

const BRAND_OPTIONS = [
  { label: "Chrome", value: "Chrome" },
  { label: "Edge", value: "Edge" },
  { label: "Opera", value: "Opera" },
  { label: "Vivaldi", value: "Vivaldi" },
];

// 声明给网站的操作系统。Docker 里真实平台恒为 Linux，照实声明会让登录设备
// 显示成「Linux」这台一眼假的设备 —— 默认 Windows，与 HTTP 层 UA 对齐。
const PLATFORM_OPTIONS = [
  { label: "Windows", value: "windows" },
  { label: "macOS", value: "macos" },
  { label: "Linux", value: "linux" },
];

/**
 * 环境拟真浏览器面板（可选增强）
 *
 * 放设置页而不是塞进 SettingsForm，是因为它不只是配置项 —— 还带一次
 * 约 181MB 的运行时下载。独立成块才能给下载进度、卸载这些操作留位置。
 *
 * 设计上刻意做成「可选」：没下载、没启用时自动回落普通 Chromium，
 * 绝不因为这是个增强项就把登录流程卡住。
 */
export function FingerprintBrowserPanel() {
  const [st, setSt] = useState<FingerprintStatus | null>(null);
  const [cfg, setCfg] = useState<FpCfg>(FALLBACK);
  const [localBusy, setLocalBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [check, setCheck] = useState<CheckFingerprintUpdateResult | null>(null);
  const [checking, setChecking] = useState(false);

  /**
   * 正在下载 = 本次点击态|| 主进程后台下载态。
   *
   * 同向导页的踩坑（2026-10-03）：首次运行主进程会后台自动下载，只认localBusy 时
   * 界面仍显示「下载并安装」，用户一点就被「正在下载，请稍候」拒绝 —— 按钮与进度条
   * 表现为闪一下就没。st.downloading 由主进程在 pushFingerprintStatus 时下发。
   */
  const busy = localBusy || !!st?.downloading;

  useEffect(() => {
    api
      .fingerprintStatus()
      .then(setSt)
      .catch(() => setSt(null));
    api
      .getGlobalConfig()
      .then((c) => setCfg(c?.browser?.fingerprint || FALLBACK))
      .catch(() => setCfg(FALLBACK));
  }, []);

  useEffect(() => {
    api.onFingerprintStatus((v) => setSt(v));
    const off = api.onInstallProgress((p) => {
      if (p.stage === "fingerprint" || p.stage === "fingerprint/download") setProgress(p);
    });
    return () => {
      if (off) off();
    };
  }, []);

  const patch = async (p: Partial<FpCfg>) => {
    const next = await api.setGlobalConfig({ browser: { fingerprint: p } });
    setCfg(next?.browser?.fingerprint || FALLBACK);
  };

  const refresh = async () => {
    try {
      setSt(await api.fingerprintStatus());
    } catch {
      /* 保持上一次状态 */
    }
  };

  /**
   * 安装 / 重新下载。
   *
   * force 语义：已安装时点「重新下载」必须真的清掉旧资源重下一遍。
   * 之前这里恒传 false，主进程命中「同版本 → skipped」分支，用户点重新下载
   * 只会弹一句「已是最新版本」—— 想修坏掉的 chrome.dll 却修不了。
   */
  const onCancelInstall = async () => {
    const r = await api.cancelFingerprintInstall();
    if (r.ok) toast.info("正在取消环境拟真浏览器下载…");
    else toast.error(r.error || "取消失败");
  };

  const onInstall = async (force: boolean) => {
    setLocalBusy(true);
    setProgress({ pct: 0 });
    try {
      const r = await api.installFingerprint({ force });
      if (r.ok) {
        if (r.skipped) {
          toast.info("环境拟真浏览器已是该版本（如需修复损坏，请点「重新下载」）");
        } else {
          toast.success(force ? "环境拟真浏览器已重新下载并校验通过" : "环境拟真浏览器安装完成");
        }
      } else if (r.canceled) {
        toast.info("已取消环境拟真浏览器下载");
      } else {
        toast.error(r.error || "环境拟真浏览器安装失败");
      }
      await refresh();
    } finally {
      setLocalBusy(false);
      setProgress(null);
    }
  };

  /**
   * 检查更新：只查询上游版本，不触发下载。
   * 0.9.4.18 修：此前该按钮直连 install(force=true)，点一下就把 181MB 重下一遍。
   */
  const onCheck = async () => {
    setChecking(true);
    setCheck(null);
    try {
      const r = await api.checkFingerprintUpdate();
      setCheck(r);
      if (!r.ok) {
        toast.error(r.error || "查询上游版本失败");
      } else if (r.reinstallAvailable) {
        toast.info(`已安装 ${r.installed || "无"}，钉死版本 ${r.pinned}，可点「重新下载」对齐`);
      } else if (r.updateAvailable) {
        toast.info(`上游已有新版 ${r.latest}（本项目钉死 ${r.pinned}，不自动跟进）`);
      } else {
        toast.success(`已是钉死版本 ${r.pinned}`);
      }
    } catch (e) {
      toast.error(String((e as Error).message || e));
    } finally {
      setChecking(false);
    }
  };

  const onUninstall = async () => {
    setLocalBusy(true);
    try {
      const r = await api.uninstallFingerprint();
      // 镜像内置（Docker）时后端会拒绝删除，必须把真实原因透出来，
      // 否则界面会假装「已删除」，而实际什么都没发生。
      if (r && r.ok === false) toast.error(r.error || "删除失败");
      else toast.success("已删除环境拟真浏览器，后续将使用普通 Chromium");
      await refresh();
    } finally {
      setLocalBusy(false);
      setConfirmDel(false);
    }
  };

  const supported = st ? st.supported : true;
  const outdated = !!st && !!st.version && st.pinned && st.version !== st.pinned;
  const pct = progress && typeof progress.pct === "number" ? Math.min(99, progress.pct) : 0;

  return (
    <div className="block">
      <div className="block-head">
        <div>
          <div className="block-title">环境拟真浏览器{st?.preinstalled ? "" : "（可选）"}</div>
          <div className="block-sub">
            {st?.preinstalled
              ? "已随镜像内置（/opt/fingerprint-chromium），容器启动即可用，运行时不再下载"
              : "用 patch 过源码的 Chromium 统一生成 UA / Client Hints / 插件 / CPU 等环境特征，需单独下载约 181MB"}
          </div>
        </div>
        <Tag color={st?.ready ? "success" : "default"} size="sm">
          {st ? (st.ready ? (st.preinstalled ? "● 镜像内置" : "● 已安装") : "○ 未安装") : "检查中…"}
        </Tag>
      </div>

      <AppCard padding={16}>
        {!supported ? (
          <div className="hint">当前平台暂不支持环境拟真浏览器，将继续使用普通 Chromium。</div>
        ) : (
          <>
            <SwitchField
              label="启用环境拟真浏览器（adryfish/fingerprint-chromium）"
              hint={
                st?.preinstalled
                  ? "Docker 版镜像内置，且容器里只有环境拟真浏览器可用，因此始终启用（不可关闭）"
                  : "未安装或启动失败时自动回落普通 Chromium，不影响登录与任务"
              }
              checked={st?.preinstalled ? true : cfg.enable}
              disabled={!st?.ready || !!st?.preinstalled}
              onChange={(v) => void patch({ enable: v })}
            />

            <div className="form-grid" style={{ marginTop: 12 }}>
              <SelectField
                label="浏览器品牌"
                hint="UA 与 Client Hints 声明的品牌，必须与内核一致才不会自相矛盾"
                value={cfg.brand}
                options={BRAND_OPTIONS}
                onChange={(v) => void patch({ brand: v })}
              />
              <NumberField
                label="拟真种子"
                hint="0 = 按账号 ID 自动派生（同一账号长期稳定，不同账号互不相同）"
                value={cfg.seed}
                min={0}
                max={4294967295}
                onChange={(v) => void patch({ seed: Math.max(0, Math.floor(v) || 0) })}
              />
              <NumberField
                label="CPU 核数"
                hint="0 = 由拟真种子生成"
                value={cfg.hardwareConcurrency}
                min={0}
                max={256}
                onChange={(v) => void patch({ hardwareConcurrency: Math.max(0, Math.floor(v) || 0) })}
              />
              <SelectField
                label="声明操作系统"
                hint="告诉网站（UA / navigator.platform / Client Hints）这台浏览器跑在什么系统上。Docker 里真实是 Linux，保持 Windows 更像一台正常的桌面浏览器"
                value={cfg.platform}
                options={PLATFORM_OPTIONS}
                onChange={(v) => void patch({ platform: v })}
              />
              {/* 镜像清单由主进程下发（status().mirrors），避免前后端各写一份。
                  镜像内置（Docker）时不渲染：镜像里已预装好，下载源无从谈起 */}
              {!st?.preinstalled && (
                <SelectField
                  label="下载镜像源"
                  hint="国内直连 GitHub Releases 通常不可达。自动=按顺序尝试全部节点、失败自动换下一个；也可钉住某一个节点，或选直连"
                  value={cfg.mirror}
                  options={st?.mirrors || []}
                  onChange={(v) => void patch({ mirror: v })}
                />
              )}
            </div>

            {st?.preinstalled ? (
              <div className="hint fp-note" style={{ marginTop: 4 }}>
                环境拟真浏览器已随镜像内置，无需也无法在容器内下载 / 删除。
                如需更换版本，请修改镜像构建参数（FPCB_VERSION）后重建镜像。
              </div>
            ) : (
              <div className="fp-actions">
                <GlassButton
                  variant="plain"
                  controlSize="small"
                  loading={busy && !progress}
                  onClick={() => (busy ? void onCancelInstall() : void onInstall(!!st?.ready))}
                >
                  {busy ? "取消下载" : st?.ready ? "重新下载" : "下载并安装"}
                </GlassButton>
                {st?.ready && (
                  <>
                    <GlassButton
                      variant="plain"
                      controlSize="small"
                      loading={checking}
                      disabled={busy || checking}
                      onClick={() => void onCheck()}
                    >
                      检查更新
                    </GlassButton>
                    {confirmDel ? (
                      <GlassButton
                        variant="plain"
                        controlSize="small"
                        disabled={busy}
                        onClick={() => void onUninstall()}
                      >
                        确认删除
                      </GlassButton>
                    ) : (
                      <GlassButton
                        variant="plain"
                        controlSize="small"
                        disabled={busy}
                        onClick={() => setConfirmDel(true)}
                      >
                        删除
                      </GlassButton>
                    )}
                  </>
                )}
              </div>
            )}

            {progress && pct < 100 && (
              <div className="fp-progress">
                <div className="fp-bar">
                  <div className="fp-bar-fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="hint" title={progress.message || ""}>
                  {progress.message || `正在下载 ${pct}%`}
                </div>
              </div>
            )}

            {check && check.ok && (
              <div className="hint fp-note">
                检查结果：上游最新 {check.latest || "未知"} · 本项目钉死 {check.pinned} · 已安装{" "}
                {check.installed || "无"}
                {check.reinstallAvailable ? "（与钉死版本不一致，可点「重新下载」对齐）" : "（与钉死版本一致）"}
                {check.updateAvailable ? "；上游已发新版，本项目不自动跟进" : ""}
              </div>
            )}

            <div className="hint fp-note">
              {st?.ready ? (
                <>
                  {st.preinstalled ? "镜像内置版本" : "已安装版本"} {st.version}
                  {outdated
                    ? st.preinstalled
                      ? `（与钉死版本 ${st.pinned} 不一致，需重建镜像对齐）`
                      : `（与钉死版本 ${st.pinned} 不一致，可点「重新下载」对齐）`
                    : `（已是本版钉死版本）`}
                </>
              ) : (
                <>
                  下载走 gh-proxy 镜像链（国内直连 GitHub Releases 通常不可达），支持断点续传；
                  失败会自动换镜像并回落直连；下载完成后比对上游官方 sha256 校验完整性，不通过就换源重下。
                </>
              )}
              <br />
              注意两处上游限制：GPU 环境特征仅 Linux 生效（Windows 上 WebGL 由本项目自己的补丁兜底）；
              headless 下它只把 UA 的 HeadlessChrome 改成 Chrome，其余 headless 特征不变。
            </div>

            {/* 0.14：后台 staging 状态提示 —— 仅在"已装旧版 + 钉死版本更新"或"刚装好新版"两种场景出现 */}
            {!st?.preinstalled &&
              st?.staged?.ready &&
              !st?.staged?.committed && (
                <div className="hint fp-note" style={{ marginTop: 4 }}>
                  新版本 <strong>{st.staged.version}</strong> 已下载到临时位置，等待空闲时段自动切换；
                  当前任务完全不受影响，正在跑的内核照常用，闲下来再切。
                  （当前活跃内核数：{st.fpContextCount ?? 0}）
                </div>
              )}
          </>
        )}
      </AppCard>
    </div>
  );
}
