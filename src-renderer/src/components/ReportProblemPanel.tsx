/**
 * 「报告问题」—— 一键导出日志（2026-11-06 用户定）
 *
 * 放在软件设置 → 更新 分区下面。交互链路：
 *   选时间段 → （自定义时选起止日期，无日志的日期置灰）→ 可选脱敏
 *   → 点导出 → 主进程弹保存位置对话框 → 生成带时间+哈希的 zip
 *   → 完成后弹免责提示弹窗。
 *
 * ⚠️ 脱敏**默认关闭**（用户指定），但导出完成弹窗必须明确提示隐私风险 ——
 *    不脱敏的日志里可能有账号 ID、推送地址密钥、Cookie 片段。
 */
import { useEffect, useMemo, useState } from "react";
import { GlassButton, GlassSwitch } from "@ttqtt/liquid-glass-react";
import { Modal, Select, SelectOption, toast } from "./liquidGlassCompat";
import { api, IS_WEB } from "../api/ipc";
import type { LogExportOptions, LogRangePreset } from "../types";

const PRESETS: SelectOption[] = [
  { label: "今天", value: "today" },
  { label: "24 小时内", value: "24h" },
  { label: "48 小时内", value: "48h" },
  { label: "72 小时内", value: "72h" },
  { label: "这个星期", value: "week" },
  { label: "这个月", value: "month" },
  { label: "所有", value: "all" },
  { label: "自定义", value: "custom" },
];

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 自定义日期行：年 / 月 / 日三个下拉，没有日志的日期禁用（变灰） */
function DatePick({
  label,
  value,
  onChange,
  available,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  available: Set<string>;
}) {
  const [y, m, d] = value.split("-").map(Number);
  const today = new Date();
  // 年份候选：可用日志里的年份 + 今年（防止一份日志都没有时下拉是空的）
  const years = useMemo(() => {
    const s = new Set<number>([today.getFullYear()]);
    for (const k of available) s.add(Number(k.slice(0, 4)));
    return [...s].sort((a, b) => b - a);
  }, [available, today.getFullYear()]);

  const setPart = (part: "y" | "m" | "d", n: number) => {
    const ny = part === "y" ? n : y || today.getFullYear();
    const nm = part === "m" ? n : m || 1;
    // 换年/月时把「日」夹到该月实际天数内，避免拼出 2026-02-31
    const maxD = new Date(ny, nm, 0).getDate();
    const nd = part === "d" ? n : Math.min(d || 1, maxD);
    onChange(`${ny}-${pad(nm)}-${pad(nd)}`);
  };

  const monthOpts: SelectOption[] = Array.from({ length: 12 }, (_, i) => ({
    label: `${i + 1} 月`,
    value: String(i + 1),
  }));
  const dayOpts: SelectOption[] = Array.from({ length: new Date(y || today.getFullYear(), m || 1, 0).getDate() }, (_, i) => {
    const dd = i + 1;
    const key = `${y || today.getFullYear()}-${pad(m || 1)}-${pad(dd)}`;
    return {
      label: String(dd),
      value: String(dd),
      // 「如果没有那天的日志就变灰」—— 用户明确要求
      disabled: !available.has(key),
    };
  });

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span className="field-label" style={{ minWidth: 52 }}>{label}</span>
      <Select
        size="sm"
        value={String(y || today.getFullYear())}
        options={years.map((n) => ({ label: `${n} 年`, value: String(n) }))}
        onChange={(v) => setPart("y", Number(v))}
      />
      <Select size="sm" value={String(m || 1)} options={monthOpts} onChange={(v) => setPart("m", Number(v))} />
      <Select size="sm" value={String(d || 1)} options={dayOpts} onChange={(v) => setPart("d", Number(v))} />
      {!available.has(value) && (
        <span className="hint" style={{ color: "var(--warn, #d97706)" }}>
          该日期没有日志，导出内容可能为空
        </span>
      )}
    </div>
  );
}

export function ReportProblemPanel() {
  const [preset, setPreset] = useState<LogRangePreset>("today");
  const [redact, setRedact] = useState(false); // 默认不脱敏（用户指定）
  const [available, setAvailable] = useState<string[]>([]);
  const [from, setFrom] = useState(dayKey(new Date()));
  const [to, setTo] = useState(dayKey(new Date()));
  const [busy, setBusy] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const [doneInfo, setDoneInfo] = useState("");

  useEffect(() => {
    let alive = true;
    api
      .getLogAvailableDays()
      .then((days) => {
        if (!alive) return;
        const list = Array.isArray(days) ? days : [];
        setAvailable(list);
        // 自定义默认落在最近一个有日志的日期，别让用户一进来就选到空日期
        const last = list[0] || dayKey(new Date());
        setFrom(last);
        setTo(last);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const availableSet = useMemo(() => new Set(available), [available]);

  const doExport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const opts: LogExportOptions = {
        preset,
        redact,
        ...(preset === "custom" ? { from: from > to ? to : from, to: from > to ? from : to } : {}),
      };
      const r = await api.exportLogs(opts);
      if (r.canceled) return; // 用户主动取消保存框，不弹失败也不弹免责
      if (!r.ok) {
        toast.error(r.error || "导出失败");
        return;
      }
      const bits = [
        r.path ? `保存位置：${r.path}` : "",
        r.bytes ? `大小：${(r.bytes / 1024).toFixed(1)} KB` : "",
        r.lines != null ? `日志行数：${r.lines}` : "",
        r.sha256 ? `SHA256：${r.sha256.slice(0, 16)}…` : "",
      ].filter(Boolean);
      setDoneInfo(bits.join("\n"));
      setDoneOpen(true);
      toast.success("日志已导出");
    } catch (e) {
      toast.error(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="hint">
        排查问题时把日志打包发给开发者。导出前可选择时间段，并决定是否隐藏账号 ID 与推送密钥。
        {IS_WEB && " Web/Docker 版由浏览器下载，保存位置取决于浏览器设置。"}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="field-label" style={{ minWidth: 68 }}>时间段</span>
        <div style={{ minWidth: 190 }}>
          <Select
            size="sm"
            value={preset}
            options={PRESETS}
            onChange={(v) => setPreset(v as LogRangePreset)}
          />
        </div>
      </div>

      {/* 自定义：下方弹出一行日期选择器；没有日志的日期在日下拉里变灰 */}
      {preset === "custom" && (
        <div style={{ display: "grid", gap: 8, paddingLeft: 4 }}>
          <DatePick label="开始" value={from} onChange={setFrom} available={availableSet} />
          <DatePick label="结束" value={to} onChange={setTo} available={availableSet} />
          <div className="hint">
            灰色日期表示当天没有日志。共有 {available.length} 天存在日志。
          </div>
        </div>
      )}

      <div className="field-row" style={{ marginTop: 2 }}>
        <div style={{ minWidth: 0 }}>
          <div>隐藏敏感信息（脱敏）</div>
          <div className="hint">
            开启后自动隐藏账号 ID 与推送地址里的密钥（钉钉 token、企微 key、Bark 设备串等）；默认关闭
          </div>
        </div>
        <GlassSwitch
          aria-label="脱敏开关"
          checked={redact}
          onCheckedChange={setRedact}
        />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <GlassButton variant="glassProminent" controlSize="small" loading={busy} onClick={() => void doExport()}>
          {busy ? "正在打包…" : "导出日志（zip）"}
        </GlassButton>
        <span className="hint">文件名自动附加当前时间与内容哈希</span>
      </div>

      {/* 导出完成：免责提示（用户指定的完整措辞） */}
      <Modal
        open={doneOpen}
        onOpenChange={(o) => { if (!o) setDoneOpen(false); }}
        title="导出完成 · 请妥善保存"
        size="sm"
        footer={
          <div style={{ display: "flex", justifyContent: "flex-end", width: "100%" }}>
            <GlassButton variant="glassProminent" controlSize="small" onClick={() => setDoneOpen(false)}>
              我知道了
            </GlassButton>
          </div>
        }
      >
        <div style={{ display: "grid", gap: 12, lineHeight: 1.7 }}>
          <div className="hint" style={{ whiteSpace: "pre-wrap" }}>{doneInfo}</div>
          <div style={{ fontWeight: 600, color: "var(--warn, #d97706)" }}>
            ⚠️ 导出的日志可能包含隐私数据，请妥善保存，不要随意分享。
          </div>
          <div className="hint">
            作者不对因用户人为因素和不可抗力造成的损失和信息泄露负责。
          </div>
        </div>
      </Modal>
    </div>
  );
}
