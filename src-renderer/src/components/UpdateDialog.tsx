import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GlassButton } from "@ttqtt/liquid-glass-react";
import { api } from "../api/ipc";
import { DISPLAY_VERSION } from "../version";
import type { CheckAppUpdateResult } from "../types";

/**
 * 「自动更新」弹窗（对齐参考设计）：
 *   - 头部：标题「自动更新」+ 频道 pill（正式版 / 测试版）+ 关闭 ×
 *   - 检查中：居中琥珀色转圈 + 「正在检查更新...」+ 当前版本
 *   - 有更新：圆形 accent 图标 + 「版本更新可用」+ 旧 → 新 版本行 +
 *     可上下滚动的更新日志（Markdown-lite：标题 / 列表 / 行内代码 / 加粗）
 *   - 已是最新 / 查询失败：对应提示态
 *   - 底部：「关闭」+「下载更新」（检查中或无更新时禁用）
 *
 * 用原生 <dialog> + showModal()：焦点 containment / top layer / Escape 由平台提供，
 * 与补位层 Modal 同一套路（见 liquidGlassCompat 的 ModalBase 注释）。
 */

type Phase = "checking" | "result";

/** 版本号是否带预发布后缀（-alpha / -beta / -rc / -test）→ 测试版频道 */
function isPrereleaseChannel(v: string): boolean {
  return /-(alpha|beta|rc|test|pre)/i.test(v || "");
}

/* ---------------- Markdown-lite 渲染（纯 React 节点，不走 innerHTML） ---------------- */

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // 交替切分 `code` 与 **bold**
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      out.push(<code key={`${keyBase}-c${i++}`}>{tok.slice(1, -1)}</code>);
    } else {
      out.push(<strong key={`${keyBase}-b${i++}`}>{tok.slice(2, -2)}</strong>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderNotes(md: string): ReactNode {
  const lines = (md || "").replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];
  let key = 0;
  const flushList = () => {
    if (list.length) {
      blocks.push(<ul key={`ul${key++}`}>{list}</ul>);
      list = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (!t) {
      flushList();
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      flushList();
      blocks.push(
        <h4 key={`h${key++}`} className="upd-note-h">
          {renderInline(h[2], `h${key}`)}
        </h4>
      );
      continue;
    }
    const li = /^[-*•]\s+(.*)$/.exec(t);
    if (li) {
      list.push(<li key={`li${key++}`}>{renderInline(li[1], `li${key}`)}</li>);
      continue;
    }
    flushList();
    blocks.push(
      <p key={`p${key++}`} className="upd-note-p">
        {renderInline(t, `p${key}`)}
      </p>
    );
  }
  flushList();
  return blocks;
}

export function UpdateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<Phase>("checking");
  const [info, setInfo] = useState<CheckAppUpdateResult | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // 每次打开都重新查一遍：先转圈（检查中态），拿到结果再切结果态
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setPhase("checking");
    setInfo(null);
    api
      .checkAppUpdate()
      .then((r) => {
        if (!alive) return;
        setInfo(r || null);
        setPhase("result");
      })
      .catch(() => {
        if (!alive) return;
        setInfo({ ok: false, updateAvailable: false, currentVersion: DISPLAY_VERSION, latestVersion: "", downloadUrl: "", assetName: "", pageUrl: "", releaseNotes: "", publishedAt: "", error: "网络异常，无法连接更新服务器" });
        setPhase("result");
      });
    return () => {
      alive = false;
    };
  }, [open]);

  if (!open) return null;

  const checking = phase === "checking";
  const hasUpdate = !!info && info.ok && info.updateAvailable;
  const channel = isPrereleaseChannel(checking ? DISPLAY_VERSION : info?.latestVersion || DISPLAY_VERSION);

  const onDownload = () => {
    if (!info) return;
    window.open(info.pageUrl || info.downloadUrl, "_blank", "noopener,noreferrer");
  };

  return createPortal(
    <dialog
      ref={dialogRef}
      className="compat-modal upd-dialog"
      style={{ maxWidth: 620 }}
      aria-label="自动更新"
      onCancel={(e) => {
        e.preventDefault();
        onOpenChange(false);
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
    >
      <div className="compat-modal-panel upd-panel">
        {/* 头部：标题 + 频道 pill + 关闭 */}
        <div className="upd-head">
          <span className="upd-title">自动更新</span>
          <span className={`upd-channel${channel ? " is-pre" : ""}`}>
            {channel ? "测试版" : "正式版"}
          </span>
          <button
            type="button"
            className="upd-close"
            aria-label="关闭"
            onClick={() => onOpenChange(false)}
          >
            ×
          </button>
        </div>

        {/* 主体 */}
        <div className="upd-body">
          {checking ? (
            <div className="upd-checking">
              <div className="upd-spinner" aria-hidden />
              <div className="upd-checking-text">正在检查更新...</div>
              <div className="upd-checking-ver">v{DISPLAY_VERSION}</div>
            </div>
          ) : hasUpdate && info ? (
            <>
              <div className="upd-hero">
                <span className="upd-hero-icon" aria-hidden>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 19V5" />
                    <path d="m5 12 7-7 7 7" />
                  </svg>
                </span>
                <div>
                  <div className="upd-hero-title">版本更新可用</div>
                  <div className="upd-hero-ver">
                    <span className="upd-ver-old">v{info.currentVersion || DISPLAY_VERSION}</span>
                    <span className="upd-ver-arrow">→</span>
                    <span className="upd-ver-new">v{info.latestVersion}</span>
                  </div>
                </div>
              </div>
              <div className="upd-notes" tabIndex={0}>
                {info.releaseNotes?.trim() ? (
                  renderNotes(info.releaseNotes)
                ) : (
                  <p className="upd-note-p">本版本暂无更新说明。</p>
                )}
              </div>
            </>
          ) : (
            <div className="upd-checking">
              <div className={`upd-hero-icon upd-hero-icon-static${info && !info.ok ? " is-warn" : " is-ok"}`} aria-hidden>
                {info && !info.ok ? (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 9v4" />
                    <path d="M12 17h.01" />
                    <circle cx="12" cy="12" r="9" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m5 13 4 4L19 7" />
                  </svg>
                )}
              </div>
              <div className="upd-checking-text">
                {info && !info.ok ? "检查更新失败" : "已是最新版本"}
              </div>
              <div className="upd-checking-ver">
                {info && !info.ok ? info.error || "请稍后重试" : `v${DISPLAY_VERSION}`}
              </div>
            </div>
          )}
        </div>

        {/* 底部：关闭 + 下载更新 */}
        <div className="upd-foot">
          <GlassButton variant="plain" controlSize="small" onClick={() => onOpenChange(false)}>
            关闭
          </GlassButton>
          <GlassButton
            variant="glassProminent"
            controlSize="small"
            disabled={checking || !hasUpdate}
            onClick={onDownload}
          >
            下载更新
          </GlassButton>
        </div>
      </div>
    </dialog>,
    document.body
  );
}
