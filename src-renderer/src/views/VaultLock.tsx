import { useEffect, useRef, useState } from "react";
import { GlassButton } from "@ttqtt/liquid-glass-react";
import { toast } from "../components/liquidGlassCompat";
import { api, IS_WEB } from "../api/ipc";
import { clearSavedRecoveryKey, getSavedRecoveryKey, saveRecoveryKeyToBrowser } from "../api/web";
import { loginWithPasskey, passkeyStatus, passkeySupported, registerPasskey } from "../api/passkeyClient";
import { VaultRescue, extractRecoveryKey } from "../components/VaultRescue";
import { AuthBackground } from "../components/AuthBackground";
import type { VaultStatus } from "../types";

/**
 * 登录页（左图右表单，参考 1Panel 版式）。
 *
 * 登录方式优先级：
 *   1. Passkey（WebAuthn，浏览器原生通行密钥弹窗）—— 仅安全上下文（HTTPS）可用；
 *   2. 本机保存的数字密钥（一键）—— 旧版兼容入口，收纳在恢复密钥标签下；
 *   3. 密码 / 恢复密钥手输。
 *
 * 已启用加密但本次启动没解开时（换了 Windows 用户、钥匙串被清空、
 * 数据目录是刚从别的机器拷来的，或浏览器会话过期）用它挡住管理界面。
 * 注意：锁着的时候**定时任务照跑**（Docker 自动解锁凭据），锁只挡管理面。
 */
export function VaultLock({ onUnlocked }: { onUnlocked: () => void }) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [pw, setPw] = useState("");
  const [rk, setRk] = useState("");
  const [mode, setMode] = useState<"pw" | "rk">("pw");
  const [busy, setBusy] = useState<"" | "passkey" | "form" | "saved">("");
  const [err, setErr] = useState("");
  const keyFileRef = useRef<HTMLInputElement | null>(null);
  const [rkFromFile, setRkFromFile] = useState("");
  const [savedKey, setSavedKey] = useState<string | null>(() => (IS_WEB ? getSavedRecoveryKey() : null));
  const [pkEnabled, setPkEnabled] = useState(false);
  const [pkSupported] = useState(() => passkeySupported());

  useEffect(() => {
    api
      .getVaultStatus()
      .then((s) => {
        setStatus(s);
        if (IS_WEB) passkeyStatus().then((st) => setPkEnabled(!!st.enabled)).catch(() => {});
      })
      .catch(() =>
        setStatus({ configured: true, unlocked: false, keychain: false, hint: "", byEnv: false })
      );
  }, []);

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
    setBusy("form");
    let r: Awaited<ReturnType<typeof api.vaultUnlock>> | undefined;
    try {
      r = byKey ? await api.vaultUnlockRecovery(value) : await api.vaultUnlock(value);
    } catch (e) {
      setBusy("");
      setErr((e as Error)?.message || "解锁失败");
      return;
    }
    setBusy("");
    if (!r.ok) {
      setErr(r.error || "解锁失败");
      return;
    }
    if (byKey && IS_WEB) saveRecoveryKeyToBrowser(value);
    afterUnlocked();
  };

  const doPasskey = async () => {
    setErr("");
    setBusy("passkey");
    try {
      const r = await loginWithPasskey();
      if (!r.ok) {
        setBusy("");
        setErr(r.error || "通行密钥登录失败");
        return;
      }
      afterUnlocked();
      return;
    } catch (e) {
      setBusy("");
      setErr((e as Error)?.message || "浏览器拒绝调用通行密钥");
    }
  };

  /** 已登录会话下（设置页）才用得到；锁屏页只在解锁成功后顺手注册 */
  const doRegister = async () => {
    setErr("");
    setBusy("passkey");
    try {
      const r = await registerPasskey(navigator.userAgent.includes("Windows") ? "此 Windows 设备" : "此设备");
      setBusy("");
      if (!r.ok) {
        setErr(r.error || "注册失败");
        return;
      }
      setPkEnabled(true);
      toast.success("通行密钥已注册，下次可一键登录");
    } catch (e) {
      setBusy("");
      setErr((e as Error)?.message || "注册失败");
    }
  };

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

  if (!status) return null;

  const passkeyHint = !IS_WEB
    ? "桌面版使用系统钥匙串免密，无需通行密钥"
    : !pkSupported
      ? "通行密钥需要 HTTPS（当前为明文 HTTP）"
      : pkEnabled
        ? "使用浏览器保存的通行密钥一键登录"
        : "尚未注册通行密钥（解锁后可在设置页注册）";

  return (
    <div className="login-page">
      {/* 登录页背景（authBg）：默认流场粒子动画，可在设置切 Bing 每日一图 */}
      <AuthBackground />
      <div className="login-card">
        {/* 左：品牌图区 */}
        <div className="login-art">
          <img src="./login-art.png" alt="" draggable={false} />
          <div className="login-brand">
            <img src="./icon.png" alt="" />
            <span>MS Rewards Auto</span>
          </div>
        </div>

        {/* 右：表单区 */}
        <div className="login-form">
          <h2>登录</h2>

          {/* Passkey 主按钮 */}
          <button
            type="button"
            className="login-passkey"
            disabled={!IS_WEB || !pkSupported || !pkEnabled || busy !== ""}
            title={passkeyHint}
            onClick={() => void doPasskey()}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="4" y="10" width="16" height="10" rx="2" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            </svg>
            {busy === "passkey" ? "等待通行密钥确认…" : "Passkey 登录"}
          </button>
          {IS_WEB && !pkEnabled && <div className="login-hint">{passkeyHint}</div>}

          <div className="login-or">或</div>

          {/* 本机保存的数字密钥（旧版兼容，一键） */}
          {IS_WEB && savedKey && (
            <button
              type="button"
              className="login-savedkey"
              disabled={busy !== ""}
              onClick={() => {
                setBusy("saved");
                void unlockWith(savedKey, true).finally(() => setBusy(""));
              }}
            >
              🔑 使用本机保存的数字密钥登录（尾号 …{savedKey.slice(-6)}）
            </button>
          )}

          {/* 密码 / 恢复密钥 */}
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

          {status.hint && mode === "pw" && (
            <div className="wz-alert">
              <strong>密码提示</strong>
              <span>{status.hint}</span>
            </div>
          )}

          <div className="login-fields">
            <input
              type="password"
              value={mode === "pw" ? pw : rk}
              onChange={(e) => (mode === "pw" ? setPw(e.target.value) : setRk(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter") void unlockWith(mode === "pw" ? pw : rk, mode === "rk");
              }}
              placeholder={mode === "pw" ? "加密密码" : "粘贴建库时保存的恢复密钥"}
              autoFocus
            />
            {mode === "rk" && (
              <div className="wz-key-file">
                <input
                  ref={keyFileRef}
                  type="file"
                  accept=".txt,text/plain"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    void pickKeyFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <GlassButton variant="glass" controlSize="small" onClick={() => keyFileRef.current?.click()}>
                  📄 上传密钥文件
                </GlassButton>
                <span className="hint">
                  {rkFromFile ? `已从「${rkFromFile}」读取密钥` : "或选择建库时下载的 txt"}
                </span>
              </div>
            )}
          </div>

          {err && <div className="wz-err">{err}</div>}

          <button
            type="button"
            className="login-submit"
            disabled={busy !== ""}
            onClick={() => void unlockWith(mode === "pw" ? pw : rk, mode === "rk")}
          >
            {busy === "form" || busy === "saved" ? "解锁中…" : "解锁"}
          </button>

          {savedKey && (
            <div className="login-hint">
              <a
                href="#clear"
                onClick={(e) => {
                  e.preventDefault();
                  clearSavedRecoveryKey();
                  setSavedKey(null);
                  toast.success("已清除本机保存的数字密钥");
                }}
              >
                清除本机数字密钥
              </a>
            </div>
          )}

          {/* 自助退路：有恢复密钥→重设密码；两样都没有→清空账号数据 */}
          <VaultRescue onReset={afterUnlocked} onWiped={() => window.location.reload()} />

          <p className="login-note">
            密码不会被保存到任何地方，忘记时只能用恢复密钥解锁。
            解锁后可在「设置 → 安全」注册 Passkey，实现一键登录。
            {IS_WEB && pkEnabled && (
              <>
                {" "}
                <a href="#reg" onClick={(e) => { e.preventDefault(); void doRegister(); }}>
                  现在注册通行密钥
                </a>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
