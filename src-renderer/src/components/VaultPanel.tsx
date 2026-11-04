import { useEffect, useState } from "react";
import { GlassButton } from "@ttqtt/liquid-glass-react";
import { AppCard, Modal, Tag, toast } from "./liquidGlassCompat";
import { api, IS_WEB } from "../api/ipc";
import { passkeyStatus, passkeySupported, passkeyBlockedByIp, registerPasskey } from "../api/passkeyClient";
import { VaultRescue } from "./VaultRescue";
import { SwitchField } from "./fields";
import { evaluatePassword, STRENGTH_COLORS } from "../utils/passwordStrength";
import type { VaultStatus } from "../types";

/** 恢复密钥 txt 的内容（含用途说明，避免只存一串字符日后不知是什么） */
function buildRecoveryText(key: string): string {
  return [
    "MS Rewards 自动化工具 - 恢复密钥",
    "",
    `生成时间：${new Date().toISOString()}`,
    "",
    key,
    "",
    "说明：",
    "- 这是忘记加密密码时唯一的解锁方式。",
    "- 密码本身不会被保存在任何地方，密钥丢失将无法恢复数据。",
    "- 请妥善离线保存，不要与密码存放在同一处。",
  ].join("\n");
}

/**
 * 安全设置：保险库的启用 / 改密 / 恢复密钥 / 锁定。
 *
 * 这里只做「配置」，真正挡门的是 App.tsx 里的锁屏组件 ——
 * 一旦锁上，未解锁前所有需要登录态的操作都会被主进程拒绝。
 */
export function VaultPanel() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // 允许弱密码（2026-11-04）：影响本面板「首次启用」与「修改密码」两处校验。
  // 存在全局设置里（与引导页共用同一个字段），本页只读改一处。
  const [allowWeak, setAllowWeak] = useState(false);
  // 开启前的降级风险确认
  const [confirmWeak, setConfirmWeak] = useState(false);
  // 下次启动需要输入密码（2026-11-04）：开启后启动跳过钥匙串免密，直接落锁屏
  const [requirePw, setRequirePw] = useState(false);
  // Windows Hello（PIN / 指纹）解锁（2026-11-04，仅 Windows 桌面版）
  const [hello, setHello] = useState<{
    supported: boolean;
    available: boolean;
    reason: string;
    enabled: boolean;
  } | null>(null);
  const [useHello, setUseHello] = useState(false);

  // 启用加密表单
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [hint, setHint] = useState("");
  const [recovery, setRecovery] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState(false);

  // 改密表单
  const [cur, setCur] = useState("");
  const [nxt, setNxt] = useState("");
  const [nxt2, setNxt2] = useState("");

  // Passkey 管理
  const [pk, setPk] = useState<{ enabled: boolean; count: number; labels: string[]; ids: string[] }>({
    enabled: false,
    count: 0,
    labels: [],
    ids: [],
  });
  const [pkBusy, setPkBusy] = useState(false);
  const pkSupported = passkeySupported();
  const pkBlockedByIp = passkeyBlockedByIp();

  const loadPk = async () => {
    if (!IS_WEB) return;
    try {
      setPk(await passkeyStatus());
    } catch {
      /* 静默 */
    }
  };

  const doRegisterPk = async () => {
    setPkBusy(true);
    try {
      const r = await registerPasskey(navigator.userAgent.includes("Windows") ? "此 Windows 设备" : "此设备");
      if (!r.ok) {
        toast.error(r.error || "注册失败");
      } else {
        toast.success("通行密钥已注册");
        await loadPk();
      }
    } finally {
      setPkBusy(false);
    }
  };

  const doRemovePk = async () => {
    setPkBusy(true);
    try {
      for (const id of pk.ids) await api.passkeyRemove(id);
      toast.success("已删除全部通行密钥");
      await loadPk();
    } finally {
      setPkBusy(false);
    }
  };

  const load = async () => {
    try {
      setStatus(await api.getVaultStatus());
    } catch {
      setStatus(null);
    }
  };

  useEffect(() => {
    void load();
    void loadPk();
    // 读「允许弱密码」：与引导页共用 security.allowWeakPassword
    api
      .getGlobalConfig()
      .then((c) => {
        setAllowWeak(c?.security?.allowWeakPassword === true);
        setRequirePw(c?.security?.requirePasswordOnStart === true);
      })
      .catch(() => {});
    // Windows Hello 状态（Web/预览模式恒不支持，按钮会自动不显示）
    api
      .vaultHelloStatus()
      .then((h) => {
        setHello(h);
        setUseHello(h.enabled);
      })
      .catch(() => setHello(null));
  }, []);

  /**
   * 「下次启动需要输入密码」落盘。
   *
   * 只影响下一次启动 —— 不立刻锁定当前会话（那会让用户正在做的事被打断，
   * 而且他可能只是想把开关打开，并不是现在就要锁）。
   */
  const setRequirePwPersist = async (v: boolean) => {
    setRequirePw(v);
    try {
      await api.setGlobalConfig({ security: { requirePasswordOnStart: v } });
      toast.success(v ? "已开启：下次启动需要输入密码" : "已关闭：下次启动自动解锁");
    } catch {
      toast.error("保存失败，请重试");
    }
  };

  /**
   * 切换「用 Windows Hello 解锁」并落盘。
   *
   * 开启时**顺手重建系统免密凭据**：锁屏点 Hello 要靠 .vaultkey 取真密钥，
   * 而那份文件可能是别的 Windows 用户 / 别的机器写下的 DPAPI 密文（根本解不开）。
   * 不重建就会出现「PIN 验证通过了却解不开」—— 2026-11-04 用户实测就是这个现象。
   */
  const setHelloPersist = async (v: boolean) => {
    setUseHello(v);
    try {
      await api.setGlobalConfig({ security: { unlockWithWindowsHello: v } });
      if (!v) {
        // 关闭时**主动清掉**免密凭据：留着它等于「关了开关但凭据还在」，
        // 安全语义上说不通（用户关掉就是不想让 PIN 能解锁）。
        const d = await api.vaultDiscardKeychain();
        toast.success(d.ok ? "已关闭 Windows Hello 解锁，并清除了免密凭据" : "已关闭 Windows Hello 解锁");
        return;
      }
      const r = await api.vaultRefreshKeychain();
      if (r.ok) {
        toast.success("已开启，并已重建系统免密凭据");
      } else {
        // 不回滚开关：用户可能本来就打算「下次用密码解锁一次」让它自动重建
        toast.info(
          `已开启，但免密凭据没建成（${r.error || "未知原因"}）。下次用密码解锁一次即可自动重建`
        );
      }
    } catch {
      toast.error("保存失败，请重试");
    }
  };

  /** 切换「允许弱密码」并落盘（与引导页同一字段，两处必须表现一致） */
  const setWeakPassword = async (v: boolean) => {
    setAllowWeak(v);
    try {
      await api.setGlobalConfig({ security: { allowWeakPassword: v } });
    } catch {
      /* 写盘失败以配置为准，下次进入会显示真实值 */
    }
  };

  if (!status) return null;

  // 与首次向导保持一致的强度校验：默认「第 3 段 + 四类字符齐全」；
  // 开启弱密码后只要求「≥6 位 + 字母 + 数字」。
  const stPw = evaluatePassword(pw, { allowWeak });
  const stNxt = evaluatePassword(nxt, { allowWeak });

  const enable = async () => {
    setErr("");
    // stPw.pass 已按当前规则集算好（弱模式不卡强度档位），这里不再重复判 level
    if (!stPw.pass) {
      setErr(
        stPw.missing.length
          ? `密码不符合要求：${stPw.missing.join("、")}`
          : "密码强度不足，请达到强度条的第 3 段"
      );
      return;
    }
    if (pw !== pw2) {
      setErr("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    const r = await api.vaultSetup(pw, hint);
    setBusy(false);
    if (!r.ok) {
      setErr(r.error || "启用失败");
      return;
    }
    setRecovery(r.recoveryKey || "");
    setPw("");
    setPw2("");
    await load();
    toast.success("已启用加密，存量登录态已转为密文存储");
  };

  const changePw = async () => {
    setErr("");
    if (!stNxt.pass) {
      setErr(
        stNxt.missing.length
          ? `新密码不符合要求：${stNxt.missing.join("、")}`
          : "新密码强度不足，请达到强度条的第 3 段"
      );
      return;
    }
    if (nxt !== nxt2) {
      setErr("两次输入的新密码不一致");
      return;
    }
    setBusy(true);
    const r = await api.vaultChangePassword(cur, nxt, hint || undefined);
    setBusy(false);
    if (!r.ok) {
      setErr(r.error || "修改失败");
      return;
    }
    setCur("");
    setNxt("");
    setNxt2("");
    toast.success("密码已更新（账户数据无需重新加密）");
  };

  const showRecovery = async () => {
    setBusy(true);
    const r = await api.vaultRecoveryKey();
    setBusy(false);
    if (!r.ok) {
      setErr(r.error || "获取失败");
      return;
    }
    setRecovery(r.recoveryKey || "");
  };

  const doLock = async () => {
    setBusy(true);
    await api.vaultLock();
    setBusy(false);
    // 锁屏状态由 App.tsx 持有，这里刷新一下让它立刻弹出锁屏
    window.location.reload();
  };

  return (
    <div className="block">
      <div className="block-head">
        <div>
          <div className="block-title">安全</div>
          <div className="block-sub">
            账户登录态（Cookie 与令牌）的加密存储；启用后磁盘上只留密文
          </div>
        </div>
        {status.configured ? (
          <Tag color="accent" size="sm">
            {status.unlocked ? "已加密 · 已解锁" : "已加密 · 已锁定"}
          </Tag>
        ) : (
          <Tag color="danger" size="sm">
            未启用加密
          </Tag>
        )}
      </div>

      <AppCard padding={16}>
        {/* 密码规则（2026-11-04）：首次启用与修改密码共用这一套校验。
            统一用开关（用户要求），与设置页其它选项保持同一种控件语言。 */}
        <SwitchField
          label="允许弱密码（不推荐）"
          hint={
            allowWeak
              ? "当前规则：总长度 ≥6 位，且必须同时包含字母与数字（不要求大小写与特殊字符）。"
              : "默认规则：≥8 位，含小写、大写、数字、特殊字符，且强度达到第 3 段。"
          }
          checked={allowWeak}
          onChange={(v) => {
            // 开启前必须先过风险确认；关闭直接生效（降级才需要确认）
            if (v) setConfirmWeak(true);
            else void setWeakPassword(false);
          }}
        />

        {/* 下次启动需要输入密码（2026-11-04）。只在已建库时出现 ——
            没设密码就没有可输的东西，显示出来只会让人困惑。
            这是一次性要求：本次解锁成功后主进程会自动把它关掉。 */}
        {status.configured && (
          <div style={{ marginTop: 10 }}>
            <SwitchField
              label="下次启动时需要输入密码"
              hint={
                requirePw
                  ? "已开启：下次启动不会自动解锁，需要手动输入密码；本次解锁后会自动关闭这一项。"
                  : "关闭时：日常启动由系统钥匙串自动解锁，不需要每次输密码。"
              }
              checked={requirePw}
              onChange={(v) => void setRequirePwPersist(v)}
            />
          </div>
        )}

        {/* Windows Hello（PIN / 指纹）解锁：仅 Windows 桌面版出现。
            不可用时也显示，但置灰并给出具体原因 —— 直接隐藏会让人以为软件没这功能。 */}
        {status.configured && hello?.supported && (
          <div style={{ marginTop: 10 }}>
            <SwitchField
              label="用 Windows Hello 解锁（PIN / 指纹）"
              hint={
                !hello.available
                  ? hello.reason || "当前设备不支持 Windows Hello"
                  : useHello
                    ? "已开启：锁屏时会出现「用 Windows Hello 解锁」，弹系统窗口输本机 PIN 或指纹；也可以随时改用密码解锁。"
                    : "开启后可用本机 PIN / 指纹代替输入软件密码。注意：系统只回「验证是否通过」，不会把 PIN 交给本软件，所以它挡的是「别人坐到你电脑前打开软件」，挡不住已在你账户下运行的恶意程序。"
              }
              checked={useHello}
              disabled={!hello.available}
              onChange={(v) => void setHelloPersist(v)}
            />
          </div>
        )}

        {recovery && (
          <div className="vault-recovery">
            <div className="vault-recovery-title">恢复密钥（忘记密码时唯一的解锁方式）</div>
            <div className="wz-recovery">
              <code>{recovery}</code>
              <button
                type="button"
                className="wz-copy"
                onClick={() => void navigator.clipboard?.writeText(recovery)}
              >
                复制
              </button>
            </div>
            <div className="wz-recovery-act">
              <button
                type="button"
                className="wz-dl"
                disabled={savingKey}
                onClick={async () => {
                  setSavingKey(true);
                  const r = await api.saveTextFile(
                    buildRecoveryText(recovery),
                    `ms-rewards-recovery-key-${new Date().toISOString().slice(0, 10)}`
                  );
                  setSavingKey(false);
                  if (r.canceled) return;
                  if (!r.ok) toast.error(r.error || "保存失败");
                  else toast.success(`已保存到 ${r.path}`);
                }}
              >
                {savingKey ? "保存中…" : "下载为 txt"}
              </button>
              <span className="hint">建议离线保存或存入密码管理器</span>
            </div>
            <div className="hint">
              请立刻保存到密码管理器或离线介质。关闭后无法再次查看（只能重新生成一把新的）。
            </div>
            <GlassButton variant="glass" controlSize="small" onClick={() => setRecovery(null)}>
              我已保存，收起
            </GlassButton>
          </div>
        )}

        {/* Passkey 管理：注册/查看/删除通行密钥（仅 Web 且安全上下文） */}
        {status.configured && IS_WEB && (
          <div className="vault-passkey">
            <div className="vault-note-title">Passkey（通行密钥）</div>
            <div className="hint">
              {pkSupported
                ? pkBlockedByIp
                  ? "当前通过 IP 地址访问，浏览器不会保存通行密钥。请改用域名（或 localhost）访问本服务后再注册。"
                  : pk.enabled
                    ? `已注册 ${pk.count} 枚：${pk.labels.join("、")}。登录页可一键登录。`
                    : "注册后可在登录页用浏览器通行密钥一键登录（替代输密码）。"
                : "当前非安全上下文（需 HTTPS），无法使用通行密钥。"}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              <GlassButton
                variant="glassProminent"
                controlSize="small"
                disabled={!pkSupported || pkBlockedByIp || pkBusy}
                loading={pkBusy}
                onClick={() => void doRegisterPk()}
              >
                注册通行密钥
              </GlassButton>
              {pk.enabled && (
                <GlassButton
                  variant="glass"
                  controlSize="small"
                  disabled={pkBusy}
                  onClick={() => void doRemovePk()}
                >
                  删除全部通行密钥
                </GlassButton>
              )}
            </div>
          </div>
        )}

        {!status.configured && !recovery && (
          <>
            <div className="vault-note">
              当前登录态以<strong>明文</strong>存放在本机数据目录。启用后：
              <ul>
                <li>Cookie 与令牌用你的密码加密后落盘，磁盘上不再有明文；</li>
                <li>
                  {IS_WEB
                    ? "把恢复密钥存到本机浏览器后，打开网页点一下即可登录；"
                    : "日常启动由系统钥匙串自动解锁，不需要每次输密码；"}
                </li>
                <li>锁定时自动任务会暂停，避免把"未登录"的空结果写回去。</li>
              </ul>
              <strong>密码不会被保存</strong>，忘记后只能靠恢复密钥解锁，请务必保存。
            </div>
            <div className="wz-fields">
              <label className="wz-field">
                <span>加密密码</span>
                <input
                  type="password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  placeholder={
                    allowWeak ? "至少 6 位，须包含字母与数字" : "至少 8 位，含大小写字母、数字和特殊字符"
                  }
                  autoComplete="new-password"
                />
              </label>

              {pw && (
                <div className="wz-pw-meter">
                  <div className="wz-pw-bars">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <span
                        key={i}
                        className="wz-pw-bar"
                        style={{
                          background:
                            i < stPw.level
                              ? STRENGTH_COLORS[Math.min(stPw.level - 1, 4)]
                              : "rgba(255,255,255,.12)",
                        }}
                      />
                    ))}
                  </div>
                  <span
                    className="wz-pw-label"
                    style={{ color: stPw.level >= 3 ? STRENGTH_COLORS[4] : STRENGTH_COLORS[0] }}
                  >
                    {stPw.label}
                    {stPw.pass ? "（符合要求）" : "（需达到第 3 段）"}
                  </span>
                </div>
              )}
              {pw && !stPw.complex && (
                <div className="wz-pw-missing">还需包含：{stPw.missing.join("、")}</div>
              )}
              {pw && stPw.weakHints.length > 0 && (
                <div className="wz-pw-weak">
                  {stPw.weakHints.map((w) => (
                    <div key={w}>⚠ {w}</div>
                  ))}
                </div>
              )}

              <label className="wz-field">
                <span>确认密码</span>
                <input
                  type="password"
                  value={pw2}
                  onChange={(e) => setPw2(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <label className="wz-field">
                <span>密码提示（可选，明文保存）</span>
                <input
                  type="text"
                  value={hint}
                  onChange={(e) => setHint(e.target.value)}
                  placeholder="例如：生日+年份"
                />
              </label>
            </div>
            <div className="vault-actions">
              <GlassButton variant="glassProminent" controlSize="small" loading={busy} onClick={enable}>
                启用加密
              </GlassButton>
            </div>
          </>
        )}

        {status.configured && status.unlocked && !recovery && (
          <>
            <div className="vault-note">
              {IS_WEB
                ? "Web 版：把恢复密钥存到本机浏览器后，每次打开网页点一下即可登录；" +
                  "若清空了浏览器数据，用密码或 txt 里的密钥登录。"
                : `系统钥匙串${status.keychain ? "可用" : "不可用"}${
                    status.keychain
                      ? "：下次启动会自动解锁，无需重复输入密码。"
                      : "：当前环境下每次启动都需要手动输入密码。"
                  }`}
            </div>

            <div className="wz-fields">
              <label className="wz-field">
                <span>当前密码</span>
                <input
                  type="password"
                  value={cur}
                  onChange={(e) => setCur(e.target.value)}
                  autoComplete="current-password"
                />
              </label>
              <label className="wz-field">
                <span>新密码</span>
                <input
                  type="password"
                  value={nxt}
                  onChange={(e) => setNxt(e.target.value)}
                  placeholder={
                    allowWeak ? "至少 6 位，须包含字母与数字" : "至少 8 位，含大小写字母、数字和特殊字符"
                  }
                  autoComplete="new-password"
                />
              </label>

              {nxt && (
                <div className="wz-pw-meter">
                  <div className="wz-pw-bars">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <span
                        key={i}
                        className="wz-pw-bar"
                        style={{
                          background:
                            i < stNxt.level
                              ? STRENGTH_COLORS[Math.min(stNxt.level - 1, 4)]
                              : "rgba(255,255,255,.12)",
                        }}
                      />
                    ))}
                  </div>
                  <span
                    className="wz-pw-label"
                    style={{ color: stNxt.level >= 3 ? STRENGTH_COLORS[4] : STRENGTH_COLORS[0] }}
                  >
                    {stNxt.label}
                    {stNxt.pass ? "（符合要求）" : "（需达到第 3 段）"}
                  </span>
                </div>
              )}
              {nxt && !stNxt.complex && (
                <div className="wz-pw-missing">还需包含：{stNxt.missing.join("、")}</div>
              )}
              {nxt && stNxt.weakHints.length > 0 && (
                <div className="wz-pw-weak">
                  {stNxt.weakHints.map((w) => (
                    <div key={w}>⚠ {w}</div>
                  ))}
                </div>
              )}
              <label className="wz-field">
                <span>确认新密码</span>
                <input
                  type="password"
                  value={nxt2}
                  onChange={(e) => setNxt2(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
            </div>

            <div className="vault-actions">
              <GlassButton variant="glassProminent" controlSize="small" loading={busy} onClick={changePw}>
                修改密码
              </GlassButton>
              <GlassButton variant="glass" controlSize="small" loading={busy} onClick={showRecovery}>
                查看恢复密钥
              </GlassButton>
              <GlassButton variant="destructive" controlSize="small" loading={busy} onClick={doLock}>
                立即锁定
              </GlassButton>
            </div>
          </>
        )}

        {status.configured && !status.unlocked && (
          <div className="hint">
            保险库处于锁定状态，自动任务已暂停。请按界面提示解锁后再操作。
          </div>
        )}

        {/* 忘记密码自救：有恢复密钥就重置密码，两样都没有就清空账号数据。
            已配置保险库才有意义（没有密码可忘） */}
        {status.configured && (
          <VaultRescue allowWeak={allowWeak} onWiped={() => window.location.reload()} />
        )}

        {err && <div className="wz-err">{err}</div>}
      </AppCard>

      {/* 允许弱密码的降级风险确认（与引导页同一套措辞）。
          ⚠️ 必须用 Modal（portal + 原生 dialog），不能手写 fixed 遮罩：
          设置页的内容容器带 transform，fixed 会相对它定位，弹窗被推到视口外。
          2026-11-04 实测：遮罩铺成 3634px 高、top = -2341，界面上只看得到一片变暗。 */}
      <Modal
        open={confirmWeak}
        onOpenChange={(o) => {
          if (!o) setConfirmWeak(false);
        }}
        title="确定允许弱密码吗？"
        size="sm"
        footer={
          <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
            <div style={{ flex: 1 }} />
            <GlassButton variant="glassProminent" controlSize="small" onClick={() => setConfirmWeak(false)}>
              继续用强密码
            </GlassButton>
            <GlassButton
              variant="plain"
              controlSize="small"
              onClick={() => {
                void setWeakPassword(true);
                setConfirmWeak(false);
              }}
            >
              我了解风险，启用弱密码
            </GlassButton>
          </div>
        }
      >
        <div className="cp-body">
          <p>
            开启后密码只要求<b>总长度 ≥6 位且同时包含字母与数字</b>，
            不再要求大小写混排、特殊字符，也不再要求强度条达到第 3 段。
          </p>
          <p>
            代价是<b>被猜中的门槛明显降低</b>。这类密码可能几十秒就被穷举出来，
            而保险库保护的正是你的 MS 登录态 —— 一旦被解开，别人能直接拿去登录你的账户。
          </p>
          <p className="cp-hint">
            如果这台电脑只有你自己用、且磁盘没做全盘加密，弱密码勉强可以接受；
            否则建议继续用强密码（≥8 位、四类字符齐全）。
          </p>
        </div>
      </Modal>
    </div>
  );
}
