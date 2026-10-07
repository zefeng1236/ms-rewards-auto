import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GlassButton } from "@ttqtt/liquid-glass-react";
import { api } from "../api/ipc";
import { renderNotes } from "../utils/releaseNotes";
import { DISPLAY_VERSION } from "../version";
import type { CheckAppUpdateResult, UpdateDownloadProgress, UpdateDownloadResult } from "../types";

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

type Phase = "checking" | "result" | "downloading" | "downloaded" | "dl-error";

/** 版本号是否带预发布后缀（-alpha / -beta / -rc / -test）→ 测试版频道 */
function isPrereleaseChannel(v: string): boolean {
  return /-(alpha|beta|rc|test|pre)/i.test(v || "");
}

/** 字节数 → 人类可读（KB / MB） */
function fmtBytes(n?: number): string {
  if (!n || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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
  const [dlProgress, setDlProgress] = useState<UpdateDownloadProgress | null>(null);
  const [dlResult, setDlResult] = useState<UpdateDownloadResult | null>(null);
  const [dlError, setDlError] = useState<string | null>(null);

  // 订阅内置下载进度（主进程 update-download-progress 推送）
  useEffect(() => {
    const off = api.onUpdateDownloadProgress((p) => setDlProgress(p));
    return off;
  }, []);

  // 当前版本号：运行时问主进程拿真值（DISPLAY_VERSION 是编译期常量，
  // 与窗口标题分叉会让「已是最新版本」误判 —— 用户实测标题栏 0.14.6.1 / 侧边栏 0.14.5）
  const [runtimeVer, setRuntimeVer] = useState(DISPLAY_VERSION);
  useEffect(() => {
    let alive = true;
    Promise.resolve(api.getRuntimeVersion?.())
      .then((v) => {
        if (alive && v && typeof v.version === "string" && v.version) setRuntimeVer(v.version);
      })
      .catch(() => {
        /* 预览模式 / IPC 不可用时保留编译期常量 */
      });
    return () => {
      alive = false;
    };
  }, []);

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
    setDlProgress(null);
    setDlResult(null);
    setDlError(null);
    api
      .checkAppUpdate()
      .then((r) => {
        if (!alive) return;
        setInfo(r || null);
        setPhase("result");
      })
      .catch(() => {
        if (!alive) return;
        setInfo({ ok: false, updateAvailable: false, currentVersion: runtimeVer, latestVersion: "", downloadUrl: "", assetName: "", pageUrl: "", releaseNotes: "", publishedAt: "", error: "网络异常，无法连接更新服务器" });
        setPhase("result");
      });
    return () => {
      alive = false;
    };
  }, [open]);

  if (!open) return null;

  const checking = phase === "checking";
  const hasUpdate = !!info && info.ok && info.updateAvailable;
  const channel = isPrereleaseChannel(checking ? runtimeVer : info?.latestVersion || runtimeVer);

  const onDownload = async () => {
    if (!info || !info.downloadUrl) return;
    setPhase("downloading");
    setDlProgress(null);
    setDlResult(null);
    setDlError(null);
    try {
      const r = await api.downloadUpdate(info.downloadUrl, info.assetName);
      if (r && r.ok) {
        setDlResult(r);
        setPhase("downloaded");
      } else if (r && r.canceled) {
        // 用户取消：回到「有更新」结果态
        setPhase("result");
      } else {
        setDlError((r && r.error) || "下载失败");
        setPhase("dl-error");
      }
    } catch {
      setDlError("下载失败，请检查网络后重试");
      setPhase("dl-error");
    }
  };

  const onCancelDownload = async () => {
    await api.cancelUpdateDownload();
    setPhase("result");
  };

  const onInstall = async () => {
    if (!dlResult?.path) return;
    await api.runUpdateInstaller(dlResult.path);
  };

  const onReveal = async () => {
    if (!dlResult?.path) return;
    await api.revealUpdateFile(dlResult.path);
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
          {phase === "downloading" ? (
            <div className="upd-checking">
              <div className="upd-progress-track">
                <div
                  className="upd-progress-bar"
                  style={{ width: `${Math.max(0, Math.min(100, dlProgress?.pct ?? 0))}%` }}
                />
              </div>
              <div className="upd-checking-text">正在下载安装包… {dlProgress?.pct ?? 0}%</div>
              <div className="upd-checking-ver">
                {fmtBytes(dlProgress?.loaded)} / {fmtBytes(dlProgress?.total)}
                {dlProgress?.speed ? ` · ${fmtBytes(dlProgress.speed)}/s` : ""}
              </div>
              <div className="upd-checking-ver">{info?.assetName}</div>
            </div>
          ) : phase === "downloaded" && dlResult ? (
            <>
              <div className="upd-hero">
                <span className="upd-hero-icon upd-hero-icon-static is-ok" aria-hidden>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m5 13 4 4L19 7" />
                  </svg>
                </span>
                <div>
                  <div className="upd-hero-title">安装包已下载完成</div>
                  <div className="upd-hero-ver">
                    <span className="upd-ver-new">{info?.assetName || "安装包"}</span>
                  </div>
                </div>
              </div>
              <div className="upd-notes" tabIndex={0}>
                <p className="upd-note-p">
                  文件已保存到系统「下载」目录（{fmtBytes(dlResult.bytes)}）。
                  点击「立即安装」将关闭本软件并启动安装向导。
                </p>
                <p className="upd-note-p">{dlResult.path}</p>
              </div>
            </>
          ) : phase === "dl-error" ? (
            <div className="upd-checking">
              <div className="upd-hero-icon upd-hero-icon-static is-warn" aria-hidden>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 9v4" />
                  <path d="M12 17h.01" />
                  <circle cx="12" cy="12" r="9" />
                </svg>
              </div>
              <div className="upd-checking-text">下载失败</div>
              <div className="upd-checking-ver">{dlError || "请稍后重试"}</div>
            </div>
          ) : checking ? (
            <div className="upd-checking">
              <div className="upd-spinner" aria-hidden />
              <div className="upd-checking-text">正在检查更新...</div>
              <div className="upd-checking-ver">{runtimeVer}</div>
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
                    <span className="upd-ver-old">{info.currentVersion || runtimeVer}</span>
                    <span className="upd-ver-arrow">→</span>
                    <span className="upd-ver-new">{info.latestVersion}</span>
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
                {info && !info.ok ? info.error || "请稍后重试" : `v${runtimeVer}`}
              </div>
            </div>
          )}
        </div>

        {/* 底部：按阶段切换按钮 */}
        <div className="upd-foot">
          {phase === "downloading" ? (
            <GlassButton variant="plain" controlSize="small" onClick={onCancelDownload}>
              取消下载
            </GlassButton>
          ) : phase === "downloaded" ? (
            <>
              <GlassButton variant="plain" controlSize="small" onClick={() => onOpenChange(false)}>
                关闭
              </GlassButton>
              <GlassButton variant="plain" controlSize="small" onClick={onReveal}>
                打开文件夹
              </GlassButton>
              <GlassButton variant="glassProminent" controlSize="small" onClick={onInstall}>
                立即安装
              </GlassButton>
            </>
          ) : phase === "dl-error" ? (
            <>
              <GlassButton variant="plain" controlSize="small" onClick={() => onOpenChange(false)}>
                关闭
              </GlassButton>
              <GlassButton variant="glassProminent" controlSize="small" onClick={onDownload}>
                重试下载
              </GlassButton>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
    </dialog>,
    document.body
  );
}
