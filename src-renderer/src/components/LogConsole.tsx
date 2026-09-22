import { useEffect, useMemo, useRef, useState } from "react";
import { GlassButton } from "@ttqtt/liquid-glass-react";
import { Input } from "./liquidGlassCompat";
import { useAppState } from "../hooks/useAppState";

const MIN_H = 120;
const MAX_H = 620;

/** 从日志行里取级别，用于着色：[2026-08-31 09:12:03] [INFO] xxx */
function levelClass(line: string): string {
  const m = line.match(/^\[[^\]]*\]\s*\[([A-Za-z]+)\]/);
  switch (m?.[1]?.toUpperCase()) {
    case "ERROR":
      return "lv-error";
    case "WARN":
    case "WARNING":
      return "lv-warn";
    case "OK":
    case "SUCCESS":
      return "lv-ok";
    default:
      return "";
  }
}

export function LogConsole() {
  const { logs, logOpen, clearLogs } = useAppState();
  const [filter, setFilter] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [height, setHeight] = useState(216);
  const bodyRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!filter.trim()) return logs;
    const k = filter.trim().toLowerCase();
    return logs.filter((l) => l.toLowerCase().includes(k));
  }, [logs, filter]);

  // 自动滚动到底部
  useEffect(() => {
    if (!autoScroll || !bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [filtered, autoScroll, logOpen]);

  // 面板悬浮在底部，拖拽条要靠 --log-h 贴在面板上缘
  useEffect(() => {
    document.documentElement.style.setProperty("--log-h", `${height}px`);
  }, [height]);

  if (!logOpen) return null;

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const onMove = (ev: MouseEvent) => {
      setHeight(Math.min(MAX_H, Math.max(MIN_H, startH + (startY - ev.clientY))));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <>
      <div className="log-resizer" onMouseDown={startDrag} title="拖动调整日志窗口高度" />
      <section className="log-console" style={{ height }}>
        <div className="log-head">
          <span>运行日志</span>
          <div className="log-tools">
            <Input
              size="sm"
              placeholder="筛选关键字…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ width: 180 }}
              aria-label="筛选日志"
            />
            <GlassButton controlSize="small" variant="plain" onClick={clearLogs}>
              清空
            </GlassButton>
            <GlassButton controlSize="small"
              variant={autoScroll ? "glassProminent" : "plain"}
              onClick={() => setAutoScroll((v) => !v)}
              title="自动滚动到底部"
            >
              ⤓ 自动
            </GlassButton>
          </div>
        </div>
        <div className="log-body" ref={bodyRef}>
          {filtered.length === 0 ? (
            <div className="hint">暂无日志</div>
          ) : (
            filtered.map((line, i) => (
              <div key={i} className={`log-line ${levelClass(line)}`}>
                {line}
              </div>
            ))
          )}
        </div>
      </section>
    </>
  );
}
