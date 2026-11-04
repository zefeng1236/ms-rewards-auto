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
  const [busy, setBusy] = useState<"" | "passkey" | "form" | "saved" | "hello">("");
  const [err, setErr] = useState("");
  const keyFileRef = useRef<HTMLInputElement | null>(null);
  const [rkFromFile, setRkFromFile] = useState("");
  const [savedKey, setSavedKey] = useState<string | null>(() => (IS_WEB ? getSavedRecoveryKey() : null));
  const [pkEnabled, setPkEnabled] = useState(false);
  const [pkSupported] = useState(() => passkeySupported());
  /** 仅 Web 有效：勾选后会话 cookie 有效期 6 小时，否则关浏览器即需重新登录 */
  const [remember, setRemember] = useState(false);
  /** 卡片翻页：login = 登录表单（正面），rescue = 忘记密码自救（背面） */
  const [face, setFace] = useState<"login" | "rescue">("login");
  /** 是否允许弱密码（来自 security.allowWeakPassword）：重新设密码时与设置页同规则 */
  const [allowWeak, setAllowWeak] = useState(false);
  /** Windows Hello 状态（可用性 + 用户是否开启用它解锁） */
  const [hello, setHello] = useState<{
    supported: boolean;
    available: boolean;
    reason: string;
    enabled: boolean;
  } | null>(null);

  useEffect(() => {
    api
      .getGlobalConfig()
      .then((c) => setAllowWeak(c?.security?.allowWeakPassword === true))
      .catch(() => {});
    // Windows Hello 只在 Windows 桌面版存在；Web 版拿到的实现恒返回不支持
    api
      .vaultHelloStatus()
      .then(setHello)
      .catch(() => setHello(null));
  }, []);

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
      r = byKey ? await api.vaultUnlockRecovery(value, remember) : await api.vaultUnlock(value, remember);
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

  /**
   * 用 Windows Hello 解锁（系统级弹窗，用户输本机 PIN / 指纹）。
   *
   * ⚠️ 这是「授权门」而不是「密钥绑定」：Hello 只回验证结果，拿不到 PIN 本身，
   * 所以验证通过后仍由主进程从系统钥匙串取真密钥。详见 src/windows-hello.js。
   */
  const unlockWithHello = async () => {
    setErr("");
    setBusy("hello");
    let r: Awaited<ReturnType<typeof api.vaultHelloUnlock>> | undefined;
    try {
      r = await api.vaultHelloUnlock();
    } catch (e) {
      setBusy("");
      setErr((e as Error)?.message || "验证失败");
      return;
    }
    setBusy("");
    if (!r.ok) {
      setErr(r.error || "验证未通过");
      return;
    }
    afterUnlocked();
  };

  const doPasskey = async () => {
    setErr("");
    setBusy("passkey");
    try {
      const r = await loginWithPasskey(remember);
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

        {/* 右：翻页区 —— 正面登录表单 / 背面忘记密码自救。
            3D 翻页始终约束在同一张卡片内，背面内容超高时内部滚动 */}
        <div className="login-right">
          <div className={`login-flip${face === "rescue" ? " flipped" : ""}`}>
            {/* ---- 正面：登录表单 ---- */}
            <div className="login-face login-form" inert={face !== "login"}>
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

              {/* 6 小时免登录（仅 Web 版有会话概念） */}
              {IS_WEB && (
                <label className="login-remember" title="勾选后 6 小时内打开页面不再要求登录；不勾则关闭浏览器后需重新登录">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                  />
                  <span>6 小时内免登录</span>
                </label>
              )}

              {err && <div className="wz-err">{err}</div>}

              {/* Windows Hello（PIN / 指纹 / 面容）：走系统级弹窗。
                  只在「Windows 且设备可用 且用户在设置里开了这个方式」时出现，
                  否则摆一个点不动的按钮只会让人以为坏了。 */}
              {hello?.available && hello?.enabled && (
                <div style={{ marginBottom: 10 }}>
                  <GlassButton
                    variant="glass"
                    controlSize="small"
                    disabled={busy !== ""}
                    onClick={() => void unlockWithHello()}
                  >
                    {busy === "hello" ? "等待系统验证…" : "用 Windows Hello 解锁（PIN / 指纹）"}
                  </GlassButton>
                </div>
              )}

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

              {/* 自助退路入口：翻到卡片背面，自救面板全程不出这张卡片 */}
              <button
                type="button"
                className="login-flip-trigger"
                onClick={() => {
                  setFace("rescue");
                  setErr("");
                }}
              >
                🔑 忘记密码？
              </button>

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

            {/* ---- 背面：忘记密码自救面板 ---- */}
            <div className="login-face login-form login-flip-back" inert={face !== "rescue"}>
              <div className="login-flip-topbar">
                <button
                  type="button"
                  className="login-flip-backbtn"
                  onClick={() => {
                    setFace("login");
                    setErr("");
                  }}
                >
                  ← 返回登录
                </button>
              </div>
              <VaultRescue
                variant="panel"
                allowWeak={allowWeak}
                onReset={afterUnlocked}
                onWiped={() => window.location.reload()}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
