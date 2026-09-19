import { useEffect, useRef, useState } from "react";
import { Button, toast } from "@ttqtt/liquid-glass-react";
import { api, IS_WEB } from "../api/ipc";
import { clearSavedRecoveryKey, getSavedRecoveryKey, saveRecoveryKeyToBrowser } from "../api/web";
import { VaultRescue, extractRecoveryKey } from "../components/VaultRescue";
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
  // 恢复密钥除了手输，也支持直接上传建库时下载的 txt（文件里含标题/时间行，
  // 由 extractRecoveryKey 过滤出密钥本体，与自救面板共用同一套解析）
  const keyFileRef = useRef<HTMLInputElement | null>(null);
  const [rkFromFile, setRkFromFile] = useState("");
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
    let r: Awaited<ReturnType<typeof api.vaultUnlock>> | undefined;
    try {
      r = byKey ? await api.vaultUnlockRecovery(value) : await api.vaultUnlock(value);
    } catch (e) {
      // 网络断 / 会话 401 等异常也要恢复按钮，否则会永远转圈
      setBusy(false);
      setErr((e as Error)?.message || "解锁失败");
      return;
    }
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

  /** 从密钥文件里读出恢复密钥填进输入框，用户确认后再点解锁 */
  const pickKeyFile = async (file: File | null | undefined) => {
    if (!file) return;
    setErr("");
    try {
      const key = extractRecoveryKey(await file.text());
      if (!key) {
        setErr("这个文件里没找到有效的恢复密钥（应是一串 44 位的字符）");
        return;
      }
      setRk(key);
      setRkFromFile(file.name);
    } catch (e) {
      setErr(`读取文件失败：${(e as Error).message}`);
    }
  };

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

              {/* 恢复密钥支持从建库时下载的 txt 直接读取，省去手抄 44 位密钥 */}
              {mode === "rk" && (
                <div className="wz-key-file">
                  <input
                    ref={keyFileRef}
                    type="file"
                    accept=".txt,text/plain"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      void pickKeyFile(e.target.files?.[0]);
                      // 允许重复选同一个文件
                      e.target.value = "";
                    }}
                  />
                  <Button variant="glass" size="sm" onClick={() => keyFileRef.current?.click()}>
                    📄 上传密钥文件
                  </Button>
                  <span className="hint">
                    {rkFromFile ? `已从「${rkFromFile}」读取密钥` : "选择建库时下载的 txt 文件"}
                  </span>
                </div>
              )}
            </div>

            {err && <div className="wz-err">{err}</div>}

            <p className="wz-lead">
              密码不会被保存到任何地方，忘记时只能用恢复密钥解锁。
              连续输错不会锁定，但也请谨慎尝试。
            </p>

            {/* 自助退路：有恢复密钥→重设密码；两样都没有→清空账号数据。
                忘了密码的人正被挡在这一屏，这里不放入口等于没有退路。
                清空数据后主进程已把向导状态重置，重载即重新进入首次启动向导。 */}
            <VaultRescue onReset={afterUnlocked} onWiped={() => window.location.reload()} />
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
