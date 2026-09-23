import { useEffect, useState } from "react";
import { GlassButton } from "@ttqtt/liquid-glass-react";
import { AppCard, Tag, toast } from "./liquidGlassCompat";
import { api, IS_WEB } from "../api/ipc";
import { VaultRescue } from "./VaultRescue";
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

  const load = async () => {
    try {
      setStatus(await api.getVaultStatus());
    } catch {
      setStatus(null);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (!status) return null;

  // 与首次向导保持一致的强度校验：达到第 3 段且四类字符齐全才允许提交
  const stPw = evaluatePassword(pw);
  const stNxt = evaluatePassword(nxt);

  const enable = async () => {
    setErr("");
    if (!stPw.complex) {
      setErr(`密码不符合要求：${stPw.missing.join("、")}`);
      return;
    }
    if (stPw.level < 3) {
      setErr("密码强度不足，请达到强度条的第 3 段");
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
    if (!stNxt.complex) {
      setErr(`新密码不符合要求：${stNxt.missing.join("、")}`);
      return;
    }
    if (stNxt.level < 3) {
      setErr("新密码强度不足，请达到强度条的第 3 段");
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
                  placeholder="至少 8 位，含大小写字母、数字和特殊字符"
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
                  placeholder="至少 8 位，含大小写字母、数字和特殊字符"
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
        {status.configured && <VaultRescue onWiped={() => window.location.reload()} />}

        {err && <div className="wz-err">{err}</div>}
      </AppCard>
    </div>
  );
}
