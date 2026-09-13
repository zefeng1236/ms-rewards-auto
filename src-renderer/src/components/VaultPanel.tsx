import { useEffect, useState } from "react";
import { Button, Card, Tag, toast } from "@ttqtt/liquid-glass-react";
import { api } from "../api/ipc";
import type { VaultStatus } from "../types";

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

  const enable = async () => {
    setErr("");
    if (pw.length < 6) {
      setErr("密码至少 6 位");
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
    if (nxt.length < 6) {
      setErr("新密码至少 6 位");
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

      <Card padding="md">
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
            <div className="hint">
              请立刻保存到密码管理器或离线介质。关闭后无法再次查看（只能重新生成一把新的）。
            </div>
            <Button variant="glass" size="sm" onClick={() => setRecovery(null)}>
              我已保存，收起
            </Button>
          </div>
        )}

        {!status.configured && !recovery && (
          <>
            <div className="vault-note">
              当前登录态以<strong>明文</strong>存放在本机数据目录。启用后：
              <ul>
                <li>Cookie 与令牌用你的密码加密后落盘，磁盘上不再有明文；</li>
                <li>日常启动由系统钥匙串自动解锁，<strong>不需要每次输密码</strong>；</li>
                <li>锁定时自动任务会暂停，避免把"未登录"的空结果写回去。</li>
              </ul>
              <strong>密码不会被保存</strong>，忘记后只能靠恢复密钥解锁，请务必保存。
            </div>
            <div className="wz-fields">
              <label className="wz-field">
                <span>加密密码（至少 6 位）</span>
                <input
                  type="password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
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
              <Button variant="accent" size="sm" loading={busy} onClick={enable}>
                启用加密
              </Button>
            </div>
          </>
        )}

        {status.configured && status.unlocked && !recovery && (
          <>
            <div className="vault-note">
              系统钥匙串{status.keychain ? "可用" : "不可用"}
              {status.keychain
                ? "：下次启动会自动解锁，无需重复输入密码。"
                : "：当前环境下每次启动都需要手动输入密码（无桌面环境属正常现象）。"}
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
                <span>新密码（至少 6 位）</span>
                <input
                  type="password"
                  value={nxt}
                  onChange={(e) => setNxt(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
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
              <Button variant="accent" size="sm" loading={busy} onClick={changePw}>
                修改密码
              </Button>
              <Button variant="glass" size="sm" loading={busy} onClick={showRecovery}>
                查看恢复密钥
              </Button>
              <Button variant="danger" size="sm" loading={busy} onClick={doLock}>
                立即锁定
              </Button>
            </div>
          </>
        )}

        {status.configured && !status.unlocked && (
          <div className="hint">
            保险库处于锁定状态，自动任务已暂停。请按界面提示解锁后再操作。
          </div>
        )}

        {err && <div className="wz-err">{err}</div>}
      </Card>
    </div>
  );
}
