import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GlassButton } from "@ttqtt/liquid-glass-react";
import { api } from "../api/ipc";
import { renderNotes } from "../utils/releaseNotes";
import type { UpdatePromptPayload } from "../types";

/**
 * 打开 GUI 时的更新提示弹窗（0.14.5）。
 *
 * 两种形态：
 *   - mode="ready"：后台静默下载已完成 → 展示更新日志 + 「立即安装」
 *     （点安装会先校验文件存在与完整性，再提权启动，软件随后自动退出）
 *   - mode="available"：未开静默下载时的告知 → 展示新版本日志 + 「知道了」
 *     （想装可以让用户开启静默下载，或去 Release 页面）
 *
 * 关闭（× 或「知道了」）都要调 dismissUpdatePrompt：
 * 主进程据此记「当天已弹过 + 该版本已忽略」，当天不再来烦。
 */
export function UpdatePromptDialog({
  payload,
  onClose,
}: {
  payload: UpdatePromptPayload | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const [installing, setInstalling] = useState(false);
  const [err, setErr] = useState("");

  const open = !!payload;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  if (!open || !payload) return null;

  const dismiss = async () => {
    try {
      await api.dismissUpdatePrompt(payload.version);
    } catch {
      /* 忽略：记不下也只是下次还会弹，不影响使用 */
    }
    onClose();
  };

  const onInstall = async () => {
    if (installing) return;
    setInstalling(true);
    setErr("");
    try {
      const r = await api.installUpdate(payload.file ? { file: payload.file } : undefined);
      // 成功时主进程会提权启动安装包并退出自己，这里不会返回；
      // 能返回就说明校验没过或启动失败
      if (r && !r.ok) {
        setErr(r.error || "安装失败");
        setInstalling(false);
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setErr(m || "安装失败");
      setInstalling(false);
    }
  };

  const ready = payload.mode === "ready";

  return createPortal(
    <dialog ref={ref} className="compat-modal" onCancel={dismiss} onClose={dismiss}>
      <div className="compat-modal-panel" style={{ maxWidth: 640, padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
          <div style={{ flex: 1, fontSize: 16, fontWeight: 600 }}>
            {ready ? `新版本 ${payload.version} 已就绪` : `发现新版本 ${payload.version}`}
          </div>
          <GlassButton variant="plain" controlSize="small" onClick={dismiss}>
            ×
          </GlassButton>
        </div>

        <div className="hint" style={{ marginBottom: 10 }}>
          {ready
            ? "安装包已下载完成。点「立即安装」会请求管理员权限并开始安装，期间本软件会自动退出，装完自动重新打开。"
            : "有新版本可用。可以开启「后台静默下载」让软件自动下载，或前往 Release 页面手动获取。"}
        </div>

        {payload.notes ? (
          <div className="upd-notes upd-notes-tall" tabIndex={0}>
            {renderNotes(payload.notes)}
          </div>
        ) : null}

        {err ? (
          <div className="hint" style={{ marginTop: 10, color: "var(--danger, #ff6b6b)" }}>
            {err}
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <GlassButton variant="plain" controlSize="small" onClick={dismiss}>
            知道了
          </GlassButton>
          {ready ? (
            <GlassButton variant="plain" controlSize="small" disabled={installing} onClick={onInstall}>
              {installing ? "正在启动安装…" : "立即安装"}
            </GlassButton>
          ) : null}
        </div>
      </div>
    </dialog>,
    document.body
  );
}
