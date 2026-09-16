import { useEffect, useState } from "react";
import { api } from "../api/ipc";
import type { BgProgress } from "../types";

/**
 * 壁纸切换进度气泡。
 *
 * 主进程在下载随机壁纸时通过 bg-progress 事件推送进度，
 * 这里在页面底部正中显示「正在切换壁纸，已下载 xx%」，
 * 下载完成（done=true）后自动淡出消失。
 *
 * 非随机图源（bing/url/file）不会触发进度推送，气泡不出现。
 */
export function BgProgressBubble() {
  const [pct, setPct] = useState<number | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const off = api.onBgProgress((v: BgProgress) => {
      if (v.done) {
        setLeaving(true);
        const t = setTimeout(() => {
          setPct(null);
          setLeaving(false);
        }, 400);
        return () => clearTimeout(t);
      }
      if (typeof v.pct === "number") {
        setPct(v.pct);
        setLeaving(false);
      }
    });
    return off;
  }, []);

  if (pct === null) return null;

  return (
    <div className={`bg-progress-bubble${leaving ? " leaving" : ""}`}>
      <div className="bg-progress-spinner" />
      <span>
        {leaving ? "壁纸已就绪" : `正在切换壁纸，已下载 ${pct}%`}
      </span>
    </div>
  );
}
