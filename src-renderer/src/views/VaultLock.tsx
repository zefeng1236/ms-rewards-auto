import { useEffect, useState } from "react";
import { Button, toast } from "@ttqtt/liquid-glass-react";
import { api, IS_WEB } from "../api/ipc";
import { clearSavedRecoveryKey, getSavedRecoveryKey, saveRecoveryKeyToBrowser } from "../api/web";
import type { VaultStatus } from "../types";

/**
 * 保险库锁屏。
 *
 * 已启用加密但本次启动没解开时（换了 Windows 用户、钥匙串被清空、
 * 数据目录是刚从别的机器拷来的，或浏览器会话过期）用它挡住主界面。
 *
 * 注意：锁着的时候自动任务不会跑 —— 解不出登录态却去跑任务，
 * 只会被判成"未登录"，甚至把空结果写回去覆盖掉真实会话，所以必须拦住。
 *
 * Web 版追加了一条捷径：首次安装时若把恢复密钥「存到本机浏览器」，
 * 这里就能直接一键登录，不必每次手输密码。
 */
export function VaultLock({ onUnlocked }: { onUnlocked: () => void }) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [pw, setPw] = useState("");
  const [rk, setRk] = useState("");
  const [mode, setMode] = useState<"pw" | "rk">("pw");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // 本机浏览器里保存的恢复密钥（数字密钥）
  const [savedKey, setSavedKey] = useState<string | null>(() => (IS_WEB ? getSavedRecoveryKey() : null));

  useEffect(() => {
    api
      .getVaultStatus()
      .then(setStatus)
      .catch(() =>
        setStatus({ configured: true, unlocked: false, keychain: false, hint: "", byEnv: false })
      );
  }, []);

  /** 解锁成功后：Web 版刷新页面让整套数据在有效会话下重新加载 */
  const afterUnlocked = () => {
    if (IS_WEB) {
      window.location.reload();
      return;
    }
    onUnlocked();
  };

  const unlockWith = async (value: string, byKey: boolean) => {
    setErr("");
    if (!value) {
      setErr(byKey ? "请输入恢复密钥" : "请输入密码");
      return;
    }
    setBusy(true);
    const r = byKey ? await api.vaultUnlockRecovery(value) : await api.vaultUnlock(value);
    setBusy(false);
    if (!r.ok) {
      setErr(r.error || "解锁失败");
      return;
    }
    // 手动用恢复密钥登录成功 → 顺手记到本机，下次一键进门
    if (byKey && IS_WEB) saveRecoveryKeyToBrowser(value);
    afterUnlocked();
  };

  const submit = () => unlockWith(mode === "pw" ? pw : rk, mode === "rk");

  const oneClick = async () => {
    if (!savedKey) return;
    await unlockWith(savedKey, true);
  };

  if (!status) return null;

  return (
    <div className="wizard">
      <div className="wizard-card">
        <header className="wizard-head">
          <img className="wizard-logo" src="./icon.png" alt="" />
          <div className="wizard-lock-title">
            <strong>🔒 {IS_WEB ? "需要登录" : "保险库已锁定"}</strong>
            <span>解锁后才能读取账户登录态并继续自动任务</span>
          </div>
        </header>

        <div className="wizard-body">
          <div className="wz-page wz-vault">
            {/* 本机保存了数字密钥 → 一键登录 */}
            {IS_WEB && savedKey && (
              <div className="wz-next" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <Button variant="accent" size="sm" loading={busy} onClick={oneClick}>
                  🔑 使用本机保存的数字密钥登录
                </Button>
                <div className="hint">
                  密钥尾号 …{savedKey.slice(-6)} ·{" "}
                  <a
                    href="#clear"
                    onClick={(e) => {
                      e.preventDefault();
                      clearSavedRecoveryKey();
                      setSavedKey(null);
                      toast.success("已清除本机保存的数字密钥");
                    }}
                  >
                    清除
                  </a>
                </div>
              </div>
            )}

            {IS_WEB && savedKey && (
              <div className="wz-doc-end" style={{ margin: "4px 0" }}>
                —— 或者手动输入 ——
              </div>
            )}

            {status.hint && mode === "pw" && (
              <div className="wz-alert">
                <strong>密码提示</strong>
                <span>{status.hint}</span>
              </div>
            )}

            <div className="wz-doc-tabs">
              <button
                type="button"
                className={`wz-doc-tab${mode === "pw" ? " on" : ""}`}
                onClick={() => {
                  setMode("pw");
                  setErr("");
                }}
              >
                用密码解锁
              </button>
              <button
                type="button"
                className={`wz-doc-tab${mode === "rk" ? " on" : ""}`}
                onClick={() => {
                  setMode("rk");
                  setErr("");
                }}
              >
                用恢复密钥解锁
              </button>
            </div>

            <div className="wz-fields">
              <label className="wz-field">
                <span>{mode === "pw" ? "加密密码" : "恢复密钥"}</span>
                <input
                  type="password"
                  value={mode === "pw" ? pw : rk}
                  onChange={(e) => (mode === "pw" ? setPw(e.target.value) : setRk(e.target.value))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submit();
                  }}
                  placeholder={mode === "pw" ? "输入你设置的加密密码" : "粘贴建库时保存的恢复密钥"}
                  autoFocus
                />
              </label>
            </div>

            {err && <div className="wz-err">{err}</div>}

            <p className="wz-lead">
              密码不会被保存到任何地方，忘记时只能用恢复密钥解锁。
              连续输错不会锁定，但也请谨慎尝试。
            </p>
          </div>
        </div>

        <footer className="wizard-foot">
          <span className="wizard-note">自动任务已暂停</span>
          <span />
          <Button variant="accent" size="sm" loading={busy} onClick={submit}>
            解锁 →
          </Button>
        </footer>
      </div>
    </div>
  );
}
