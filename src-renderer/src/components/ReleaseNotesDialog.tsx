import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { GlassButton } from "@ttqtt/liquid-glass-react";
import { renderNotes } from "../utils/releaseNotes";
import type { ReleaseNotesResult } from "../types";

/**
 * 「更新日志」只读弹窗（设置页 → 更新 → 当前版本更新日志）。
 *
 * 与 UpdateDialog 的区别：那个是「检查更新 + 下载 + 安装」的完整流程，
 * 这个**只展示某一版的正文**，不下载、不安装 —— 用户只是想回看
 * 「我装的这一版改了什么」。所以要单独一个，不能复用那个。
 *
 * 正文渲染复用 utils/releaseNotes（Markdown-lite）：GitHub Release 正文是
 * Markdown，纯文本显示会满屏 `##` / `|` / `**`，且上游仓库链接点不动。
 *
 * 用原生 <dialog> + showModal()：焦点 containment / top layer / Escape
 * 由平台提供（与 UpdateDialog 同一套路）。
 */
export function ReleaseNotesDialog({
  open,
  data,
  onClose,
}: {
  open: boolean;
  data: ReleaseNotesResult | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  if (!open) return null;

  return createPortal(
    <dialog ref={ref} className="compat-modal" onCancel={onClose} onClose={onClose}>
      {/* maxWidth 去掉：宽度由 .compat-modal-panel 的 width:100% 统一撑满
          （用户 2026-10-09 要求弹窗宽度一致，maxWidth 会把卡片卡在 680） */}
      <div className="compat-modal-panel" style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12, gap: 8 }}>
          <div style={{ flex: 1, fontSize: 16, fontWeight: 600 }}>
            更新日志
            {data?.version ? <span className="upd-notes-ver"> {data.version}</span> : null}
          </div>
          <GlassButton variant="plain" controlSize="small" onClick={onClose}>
            关闭
          </GlassButton>
        </div>

        {!data ? (
          <div className="hint">读取中…</div>
        ) : !data.ok ? (
          <div className="hint">读取失败：{data.error || "未知错误"}</div>
        ) : (
          <div className="upd-notes upd-notes-tall" tabIndex={0}>
            {data.notes?.trim() ? (
              renderNotes(data.notes)
            ) : (
              <p className="upd-note-p">该版本没有填写更新日志。</p>
            )}
          </div>
        )}

        {data?.pageUrl ? (
          <div style={{ marginTop: 12 }}>
            <a href={data.pageUrl} target="_blank" rel="noreferrer" className="upd-note-link">
              在 GitHub 上查看此版本 ↗
            </a>
          </div>
        ) : null}
      </div>
    </dialog>,
    document.body
  );
}
