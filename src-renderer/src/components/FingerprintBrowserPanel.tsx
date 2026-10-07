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

// ⚠️ mirror / engine 默认值必须与 src/config.js / src/global-config.js 一致（selfcheck 有跨文件守卫）
const FALLBACK: FpCfg = {
  enable: false,
  // 与 GLOBAL_DEFAULTS 一致：默认内核是 Chromix 154（fp150 备用，当前不可选）
  engine: "chromix",
  // 默认只留一个内核（切换时自动卸载旧的）
  singleEngineOnly: true,
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

  /**
   * 切换内核（2026-10-06）。
   *
   * ⚠️ 刻意**不走**上面的 `patch`：内核切换不只是改配置，主进程还要
   * ① 在「只保留单个内核」模式下卸载旧内核（省 ~500MB）
   * ② 目标内核没装时自动开始下载
   * ③ Docker 预装场景要拒绝（预装在镜像层，切了也换不了）
   * 这些都只有主进程能做，所以走独立 IPC。
   */
  const onSwitchEngine = async (key: string) => {
    // ⚠️ 这里不能用 currentEngineKey（它是下面才定义的 const，TDZ）——
    //    直接比对 cfg.engine，语义一样且没有时序问题。
    if (key === cfg.engine) return;
    setLocalBusy(true);
    try {
      const r = await api.setFingerprintEngine(key);
      if (r && r.ok === false) {
        toast.error(r.error || "切换内核失败");
      } else if (r && r.removed && r.removed.length) {
        toast.success(
          `已切换到 ${key}，并卸载了旧内核（释放约 500MB）：${r.removed.join("、")}`
        );
      } else {
        toast.success(`已切换到 ${key}，正在后台下载该内核`);
      }
      // 状态要重新拉：installed / version / 下载进度都会变
      await refresh();
      try {
        setCfg(await api.getGlobalConfig().then((g) => g?.browser?.fingerprint || FALLBACK));
      } catch {}
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "切换内核失败");
    } finally {
      setLocalBusy(false);
    }
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
  /**
   * 新版本已下好、放在暂存区等着替换（还没真正装上）。
   *
   * ⚠️ 这个状态必须优先于下载进度条：以前 `pct` 被 Math.min(99,...) 夹住，
   * 下载完成时 progress.pct=100 → 压成 99 → `pct < 100` 恒真 →
   * **进度条永远停在 99% 不动**，用户以为卡住了，其实只是在等替换时机。
   * 现在命中这个状态就显示「等待安装」，不再显示那条假进度。
   */
  const waitingInstall = !!st?.staged?.ready && !st?.staged?.committed && !st?.preinstalled;

  /**
   * 内核清单（2026-10-06 多内核）。
   *
   * ⚠️ 主进程没下发 engines 时（旧版本 / 接口异常）必须**回落到一个只含默认内核的
   * 列表**，不能让下拉空掉 —— 空下拉会让人以为功能坏了，且用户无法回到默认内核。
   * 这里用 st.pinned 反推版本号，保证与主进程自报一致。
   */
  const engineOpts: NonNullable<FingerprintStatus["engines"]> =
    st?.engines && st.engines.length
      ? st.engines
      : [
          {
            key: "chromix",
            label: "Chromix 154",
            version: st?.pinned || "154.0.8037.57",
            available: true,
            unavailableReason: "",
            notes: "",
            installed: !!st?.ready,
            default: true,
          },
        ];
  // 当前生效的内核：配置里的值优先，非法/缺失则与主进程自报对齐
  const currentEngineKey = engineOpts.some((e) => e.key === cfg.engine)
    ? cfg.engine
    : engineOpts.find((e) => e.default)?.key || engineOpts[0].key;
  // 用户正选中的那个不可用内核（要展示它的已知缺陷说明）
  const pickedEngine = engineOpts.find((e) => e.key === currentEngineKey);
  const pickedBlocked = !!pickedEngine && !pickedEngine.available;

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
              label={`启用环境拟真浏览器（${currentEngineKey === "fp150" ? "adryfish/fingerprint-chromium" : "xiaozhou26/Chromix"}）`}
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
              {/* —— 内核选择（2026-10-06 多内核，0.14.7 重排为卡片视图）——
                  两个内核做成「当前/备用」一眼看到的卡片：选中的高亮、不可用的灰显。
                  之前是个普通 SelectField，混在「拟真种子 / CPU 核数 / 操作系统 /
                  镜像源」里看不出来「这是切内核」，用户反馈"找不到切换"。 */}
              <div className="form-field">
                <div className="form-label">环境拟真内核</div>
                <div className="form-hint" style={{ marginBottom: 6 }}>
                  {engineOpts.length
                    ? engineOpts
                        .map(
                          (e) =>
                            `${e.label}${e.default ? "（默认）" : ""}${e.installed ? " · 已装" : ""}` +
                            `${e.available ? "" : " · 暂不可选"}`
                        )
                        .join("　/　")
                    : "内核清单加载中…"}
                </div>
                <div className="fp-engine-grid" role="radiogroup" aria-label="环境拟真内核选择">
                  {engineOpts.map((e) => {
                    const active = e.key === currentEngineKey;
                    const blocked = !e.available;
                    return (
                      <button
                        key={e.key}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={blocked}
                        title={
                          blocked
                            ? e.unavailableReason || "上游存在问题，修复后即可选择"
                            : `切换到 ${e.label}${e.installed ? "（已装）" : "（将自动下载）"}`
                        }
                        onClick={() => {
                          if (blocked) return;
                          void onSwitchEngine(e.key);
                        }}
                        className={
                          "theme-card fp-engine-card" +
                          (active ? " active" : "") +
                          (blocked ? " is-blocked" : "")
                        }
                      >
                        <div className="theme-card-name">
                          {e.label}
                          {e.default ? <span className="fp-engine-tag">默认</span> : null}
                          {active ? <span className="fp-engine-tag is-active">当前</span> : null}
                        </div>
                        <div className="theme-card-desc">
                          {blocked
                            ? "暂不可选 · 上游缺陷"
                            : e.installed
                              ? "已安装，点此切换并保留此内核"
                              : "未安装，切换时会自动下载"}
                        </div>
                        <div className="theme-card-desc" style={{ marginTop: 2, opacity: 0.75 }}>
                          {e.notes || (e.key === "chromix" ? "216 个 patch 的指纹一致性 Chromium" : "")}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
              <SwitchField
                label="只保留单个内核"
                hint={
                  cfg.singleEngineOnly === false
                    ? "两个内核都会保留（约各 500MB），可随时来回切换"
                    : "切换内核时自动卸载旧的，只占用一个内核的空间（约 500MB）。想让两个都留着可随时切换就关掉它"
                }
                checked={cfg.singleEngineOnly !== false}
                disabled={!st?.preinstalled && engineOpts.filter((e) => e.installed).length < 2}
                onChange={(v) => void patch({ singleEngineOnly: v })}
              />
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

            {/* 不可用内核的完整原因放在卡片的 title 提示里（hover 可见），
                卡片本身只显示一句"暂不可选 · 上游缺陷"，避免与卡片描述重复。 */}

            {/* 防御：若配置里存了不可用/已下架的内核，明确告知「本轮不会用」，
                别让用户以为界面改了但浏览器没换（这种错位没有报错，最难自查）。 */}
            {pickedBlocked && (
              <div className="hint fp-note" style={{ marginTop: 4, color: "var(--warn, #d97706)" }}>
                你选择的 {pickedEngine?.label} 当前不可用，本轮会回落到默认内核（
                {engineOpts.find((e) => e.default)?.label || "Chromix 154"}）。请改选其他内核。
              </div>
            )}

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

            {waitingInstall ? (
              <div className="fp-progress">
                <div className="hint" style={{ fontWeight: 600 }}>
                  新版本 {st?.staged?.version} 已下载完成，等待安装
                </div>
              </div>
            ) : (
              progress &&
              pct < 100 && (
                <div className="fp-progress">
                  <div className="fp-bar">
                    <div className="fp-bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="hint" title={progress.message || ""}>
                    {progress.message || `正在下载 ${pct}%`}
                  </div>
                </div>
              )
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

            {/* 0.14：后台 staging 状态提示 —— 仅在"已装旧版 + 钉死版本更新"或"刚装好新版"两种场景出现
                ⚠️ 这里只补充「为什么还在等」，「已下载完成、等待安装」那句在上面的进度区显示，
                两处不要重复同一句话。 */}
            {waitingInstall && (
              <div className="hint fp-note" style={{ marginTop: 4 }}>
                替换时机：只要当前没有账户任务在跑就会自动装（登录、同步、下载都不算忙）。
                正在跑的内核不受影响，会等它空闲下来再切。（当前活跃内核数：{st.fpContextCount ?? 0}）
              </div>
            )}
          </>
        )}
      </AppCard>
    </div>
  );
}
