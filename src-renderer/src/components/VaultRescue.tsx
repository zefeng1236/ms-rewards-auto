import { useRef, useState } from "react";
import { Button, toast } from "@ttqtt/liquid-glass-react";
import { api, IS_WEB } from "../api/ipc";
import { clearSavedRecoveryKey } from "../api/web";
import { PasswordInput } from "./PasswordInput";
import { evaluatePassword, STRENGTH_COLORS } from "../utils/passwordStrength";

/**
 * 「忘记密码」自救面板。
 *
 * 两条退路，对应两种最坏情况：
 *   A. 手里还有恢复密钥（txt 文件或抄下来的那串）→ 直接重设密码，账户数据一条不丢；
 *   B. 密钥和密码都没有 → 保险库已经解不开了，只能清空账号数据回到可用状态，
 *      个性化设置（主题、壁纸、玻璃效果）保留，壁纸 API 密钥作为凭据一并清除；
 *      账号与保险库都没了，重载后会重新走一遍首次启动向导（含重新建库）。
 *
 * 安全设置页与保险库锁屏共用本组件 —— 忘了密码的人多半正被锁在门外，
 * 只放在设置页里等于没有。
 */

/** 从恢复密钥 txt 里抠出密钥本身（文件里还有标题、时间、说明等行） */
export function extractRecoveryKey(text: string): string {
  for (const raw of String(text || "").split(/\r?\n/)) {
    const s = raw.trim();
    // 32 字节 base64 = 恰好 44 字符；放宽到 40–64 兼容不同换行/空白
    if (s.length < 40 || s.length > 64) continue;
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return s;
  }
  return "";
}

export function VaultRescue({ onWiped, onReset }: { onWiped?: () => void; onReset?: () => void }) {
  // --- 方式 A：恢复密钥重置密码 ---
  const [open, setOpen] = useState(false);
  const [rk, setRk] = useState("");
  const [rkFromFile, setRkFromFile] = useState("");
  const [next, setNext] = useState("");
  const [next2, setNext2] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  // --- 方式 B：清空账号数据 ---
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [wiping, setWiping] = useState(false);

  const st = evaluatePassword(next);

  const pickFile = async (file: File | null | undefined) => {
    if (!file) return;
    setErr("");
    try {
      const text = await file.text();
      const key = extractRecoveryKey(text);
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

  const reset = async () => {
    setErr("");
    if (!rk.trim()) {
      setErr("请输入恢复密钥，或上传建库时保存的密钥文件");
      return;
    }
    if (!st.complex) {
      setErr(`新密码不符合要求：${st.missing.join("、")}`);
      return;
    }
    if (st.level < 3) {
      setErr("新密码强度不足，请达到强度条的第 3 段");
      return;
    }
    if (next !== next2) {
      setErr("两次输入的新密码不一致");
      return;
    }
    setBusy(true);
    let r: Awaited<ReturnType<typeof api.vaultResetPasswordWithRecovery>> | undefined;
    try {
      r = await api.vaultResetPasswordWithRecovery(rk.trim(), next, hint || undefined);
    } catch (e) {
      setBusy(false);
      setErr((e as Error)?.message || "重置失败");
      return;
    }
    setBusy(false);
    if (!r.ok) {
      setErr(r.error || "重置失败，请检查恢复密钥");
      return;
    }
    setRk("");
    setNext("");
    setNext2("");
    setHint("");
    setRkFromFile("");
    toast.success("密码已重置，账户数据完整保留（旧恢复密钥依然可用）");
    onReset?.();
  };

  const wipe = async () => {
    setWiping(true);
    let r: Awaited<ReturnType<typeof api.wipeAccountData>> | undefined;
    try {
      r = await api.wipeAccountData();
    } catch (e) {
      setWiping(false);
      setErr((e as Error)?.message || "清空失败");
      return;
    }
    setWiping(false);
    setConfirmWipe(false);
    if (!r.ok) {
      setErr(r.error || "清空失败");
      return;
    }
    toast.success(`已清空 ${r.accounts} 个账号的数据，正在重新进入首次启动向导…`);
    // Web 版本机存的那把密钥属于刚被删掉的保险库，留着只会误导，一并清掉
    if (IS_WEB) clearSavedRecoveryKey();
    if (onWiped) onWiped();
    else window.location.reload();
  };

  return (
    <div className="vault-rescue">
      <button
        type="button"
        className="vault-rescue-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>🔑 忘记密码？</span>
        <span className="vault-rescue-arrow">{open ? "收起 ▲" : "展开 ▼"}</span>
      </button>

      {open && (
        <div className="vault-rescue-body">
          {/* ---- A. 有恢复密钥 → 重置密码 ---- */}
          <div className="vault-rescue-sec">
            <div className="vault-rescue-title">
              方式一 · 我有恢复密钥，重置密码
              <span className="vault-rescue-tag ok">数据不丢</span>
            </div>
            <p className="hint">
              用建库时保存的恢复密钥解开保险库，然后设一个新密码。已登录的账号、
              积分进度都不会丢；重置后这把恢复密钥依然有效。
            </p>

            <label className="wz-field">
              <span>恢复密钥</span>
              <input
                type="text"
                value={rk}
                onChange={(e) => {
                  setRk(e.target.value);
                  setRkFromFile("");
                }}
                placeholder="粘贴建库时保存的 44 位恢复密钥"
                spellCheck={false}
              />
            </label>

            <div className="vault-rescue-file">
              <input
                ref={fileRef}
                type="file"
                accept=".txt,text/plain"
                style={{ display: "none" }}
                onChange={(e) => {
                  void pickFile(e.target.files?.[0]);
                  // 允许重复选同一个文件
                  e.target.value = "";
                }}
              />
              <Button variant="glass" size="sm" onClick={() => fileRef.current?.click()}>
                📄 上传密钥文件
              </Button>
              <span className="hint">
                {rkFromFile ? `已从「${rkFromFile}」读取密钥` : "选择建库时下载的 txt 文件"}
              </span>
            </div>

            <label className="wz-field">
              <span>新密码</span>
              <PasswordInput
                value={next}
                onChange={setNext}
                placeholder="至少 8 位，含大小写字母、数字和特殊字符"
                autoComplete="new-password"
              />
            </label>

            {next && (
              <div className="wz-pw-meter">
                <div className="wz-pw-bars">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <span
                      key={i}
                      className="wz-pw-bar"
                      style={{
                        background:
                          i < st.level
                            ? STRENGTH_COLORS[Math.min(st.level - 1, 4)]
                            : "rgba(255,255,255,.12)",
                      }}
                    />
                  ))}
                </div>
                <span
                  className="wz-pw-label"
                  style={{ color: st.level >= 3 ? STRENGTH_COLORS[4] : STRENGTH_COLORS[0] }}
                >
                  {st.label}
                  {st.pass ? "（符合要求）" : "（需达到第 3 段）"}
                </span>
              </div>
            )}
            {next && !st.complex && (
              <div className="wz-pw-missing">还需包含：{st.missing.join("、")}</div>
            )}
            {next && st.weakHints.length > 0 && (
              <div className="wz-pw-weak">
                {st.weakHints.map((w) => (
                  <div key={w}>⚠ {w}</div>
                ))}
              </div>
            )}

            <label className="wz-field">
              <span>确认新密码</span>
              <PasswordInput value={next2} onChange={setNext2} autoComplete="new-password" />
            </label>
            <label className="wz-field">
              <span>密码提示（可选，明文保存）</span>
              <input
                type="text"
                value={hint}
                onChange={(e) => setHint(e.target.value)}
                placeholder="给自己留一个提示"
              />
            </label>

            {err && <div className="wz-err">{err}</div>}

            <div className="vault-actions">
              <Button variant="accent" size="sm" loading={busy} onClick={reset}>
                用恢复密钥重置密码
              </Button>
            </div>
          </div>

          {/* ---- B. 密钥与密码都没了 → 清空账号数据 ---- */}
          <div className="vault-rescue-sec danger">
            <div className="vault-rescue-title">
              方式二 · 密钥和密码都没有
              <span className="vault-rescue-tag bad">数据清空</span>
            </div>
            <p className="hint">
              保险库没有密码或密钥就永远解不开，只能清空账号数据让软件回到可用状态。
              账号登录态、任务进度、历史日志与保险库本身都会被删除；<strong>个性化设置
              （主题、壁纸、玻璃效果）与启动设置保留</strong>，其中壁纸 API 密钥属于凭据，会一并清除。
              清空后会重新进入首次启动向导，由你重新创建加密保险库。
            </p>
            <div className="vault-actions">
              <Button variant="danger" size="sm" onClick={() => setConfirmWipe(true)}>
                清空账号数据
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 危险确认：取消在左，红色确认在右 */}
      {confirmWipe && (
        <div className="wz-modal-mask" role="dialog" aria-modal="true" aria-label="清空账号数据确认">
          <div className="wz-modal">
            <h3>确定清空所有账号数据吗？</h3>
            <p className="wz-modal-lead">
              将删除：全部账号（含登录态 Cookie / 令牌）、任务进度、历史日志，
              以及加密保险库本身 —— 因为密码和恢复密钥都已丢失，它已经无法解开。
            </p>
            <p className="wz-modal-sug">
              会保留：个性化设置（主题、壁纸、玻璃效果）、启动与托盘设置、推送等业务配置；
              壁纸 API 密钥属于第三方凭据，会一并清除。
            </p>
            <p className="wz-modal-lead">
              清空后账号与保险库都不复存在，软件会重新进入<strong>首次启动向导</strong>，
              由你重新创建加密保险库。<strong>此操作不可恢复</strong>，账号需要重新登录。
            </p>
            <div className="wz-modal-act">
              <button
                type="button"
                className="wz-btn-primary"
                onClick={() => setConfirmWipe(false)}
                disabled={wiping}
              >
                取消
              </button>
              <button type="button" className="wz-btn-danger" onClick={wipe} disabled={wiping}>
                {wiping ? "清空中…" : "确定清空!!!(不可恢复)"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
