import { useEffect, useState } from "react";
import { GlassButton } from "@ttqtt/liquid-glass-react";
import { api } from "../api/ipc";
import { DISPLAY_VERSION } from "../version";
import type { AppConfig, CheckAppUpdateResult, ReleaseNotesResult } from "../types";

/**
 * 软件设置 →「更新」分区（0.14.5 新增）。
 *
 * 放四块内容：
 *   ① 后台静默下载开关（默认关闭）
 *   ② 当前版本 + 运行平台
 *   ③ 「检查更新」按钮
 *   ④ 「当前版本更新日志」按钮
 *
 * 设计取舍：
 * - 开关默认关闭：不未经允许就在后台拉 100MB+ 安装包。
 * - 静默下载**绝不提权**：装目录写不进去就静默改放用户数据目录，
 *   不会弹 UAC（弹窗就不叫静默了）。这点在主进程 app-update.js 的
 *   resolveUpdateDir 里实现，这里只负责开关。
 * - 「当前版本更新日志」查的是**已装的这一版**，不是最新版 ——
 *   用户想回看的是「我这个版本改了什么」，拿最新版的日志糊弄他没意义。
 */
export function UpdatePanel({ onShowNotes }: { onShowNotes?: (notes: ReleaseNotesResult) => void }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const update = config?.update;
  const silent = !!update?.silentDownload;

  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckAppUpdateResult | null>(null);
  const [notesLoading, setNotesLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // 当前版本号：运行时问主进程拿 package.json 真值（与窗口标题同源）。
  // DISPLAY_VERSION 是 vite 编译期烧进 JS 的常量，改了不重新 build:web
  // 就会与标题栏分叉（用户实测「标题栏 0.14.6.1、设置页 0.14.5」）。
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

  // 自己读一次全局配置：省得父组件层层透传，也避免首帧读到 undefined
  useEffect(() => {
    let alive = true;
    api
      .getGlobalConfig()
      .then((c) => {
        if (alive) setConfig(c || null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 平台名：给中文展示用（与设置项 platform 的英文值区分开）
  const platformLabel = (() => {
    const p = typeof process !== "undefined" ? String((process as { platform?: string }).platform || "") : "";
    if (p === "win32") return "Windows";
    if (p === "darwin") return "macOS";
    if (p === "linux") return "Linux";
    return p || "未知";
  })();

  useEffect(() => {
    // 进页面不自动检查：检查要打网络，留给用户点。
  }, []);

  const toggleSilent = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await api.setGlobalConfig({ update: { silentDownload: !silent } });
      setConfig(next || config);
    } finally {
      setBusy(false);
    }
  };

  const onCheck = async () => {
    if (checking) return;
    setChecking(true);
    setResult(null);
    try {
      const r = await api.checkAppUpdate();
      setResult(r || null);
    } catch {
      setResult({ ok: false, updateAvailable: false, currentVersion: runtimeVer, latestVersion: "", downloadUrl: "", assetName: "", pageUrl: "", releaseNotes: "", publishedAt: "", error: "网络异常，无法连接更新服务器" });
    } finally {
      setChecking(false);
    }
  };

  const onCurrentNotes = async () => {
    if (notesLoading) return;
    setNotesLoading(true);
    try {
      const r = await api.releaseNotes();
      if (onShowNotes) onShowNotes(r);
      // 没有弹窗回调时（理论上不会）至少把失败写进检查结果区
      if (!r?.ok && !onShowNotes) setResult((prev) => prev);
    } finally {
      setNotesLoading(false);
    }
  };

  return (
    <div className="block">
      <div className="block-head">
        <div>
          <div className="block-title">软件更新</div>
          <div className="block-sub">新版本检查、后台静默下载与更新日志</div>
        </div>
      </div>

      {/* ① 后台静默下载开关 */}
      <div className="field-row" style={{ alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>后台静默下载新版本</div>
          <div className="hint">
            开启后会在后台自动下载新版本安装包，下次打开软件时提示安装。
            下载不会申请管理员权限（安装目录不可写时会改放到用户数据目录），也不会打断正在跑的任务。
          </div>
        </div>
        <GlassButton variant="plain" controlSize="small" disabled={busy} onClick={toggleSilent}>
          {silent ? "已开启" : "已关闭"}
        </GlassButton>
      </div>

      {/* ② 版本与平台 */}
      <div className="field-row">
        <div style={{ flex: 1 }}>
          <div className="hint">当前版本：<strong>{runtimeVer}</strong></div>
          <div className="hint">运行平台：{platformLabel}</div>
          {update?.readyVersion ? (
            <div className="hint" style={{ marginTop: 4 }}>
              已下载待安装：<strong>{update.readyVersion}</strong>
            </div>
          ) : null}
        </div>
      </div>

      {/* ③ 检查更新 / ④ 当前版本更新日志 */}
      <div className="field-row">
        <GlassButton variant="plain" controlSize="small" disabled={checking} onClick={onCheck}>
          {checking ? "检查中…" : "检查更新"}
        </GlassButton>
        <GlassButton variant="plain" controlSize="small" disabled={notesLoading} onClick={onCurrentNotes}>
          {notesLoading ? "读取中…" : "当前版本更新日志"}
        </GlassButton>
      </div>

      {result ? (
        <div className="hint fp-note">
          {result.ok ? (
            result.updateAvailable ? (
              <>
                发现新版本 <strong>{result.latestVersion}</strong>（当前 {result.currentVersion}）。
                {silent ? "已开启静默下载，将在后台自动下载。" : "未开启静默下载，可在上方开启，或前往 Release 页面手动下载。"}
              </>
            ) : (
              <>已是最新版本（{result.currentVersion}）。</>
            )
          ) : (
            <>检查失败：{result.error || "未知错误"}</>
          )}
        </div>
      ) : null}
    </div>
  );
}
