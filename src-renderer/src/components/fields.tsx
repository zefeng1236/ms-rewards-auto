import { GlassSwitch } from "@ttqtt/liquid-glass-react";
import { Input, InputNumber, Select, SelectOption } from "./liquidGlassCompat";

/** 带说明文字的开关行 */
export function SwitchField({
  label,
  hint,
  checked,
  onChange,
  disabled,
  badge,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** 标签右侧的小徽标（如「测试中 · 延迟上线」）。用于标记尚未开放的功能。 */
  badge?: string;
}) {
  return (
    <div className="field-row">
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span>{label}</span>
          {badge && (
            <span
              className="hint"
              style={{
                fontSize: 11,
                lineHeight: "16px",
                padding: "0 7px",
                borderRadius: 8,
                color: "var(--warn, #d97706)",
                background: "rgba(217, 119, 6, 0.12)",
                border: "1px solid rgba(217, 119, 6, 0.35)",
                whiteSpace: "nowrap",
              }}
            >
              {badge}
            </span>
          )}
        </div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      <GlassSwitch aria-label="开关" checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

/** 数字输入 */
export function NumberField({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
  suffix,
  suffixHint,
}: {
  label: string;
  hint?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  /**
   * 输入框内的单位（如「分」）。只显示一个裸数字时用户看不出单位 ——
   * 2026-11-04 用户原话「你不能就叫 300 啊，谁能看懂」。
   */
  suffix?: string;
  /**
   * 值有特殊含义时追加的说明（如阈值为 0 表示「关闭」）。
   * 与 hint 分开：hint 是固定说明，这句随当前值变化。
   */
  suffixHint?: string;
}) {
  return (
    <div className="field-block">
      <span className="field-label">{label}</span>
      <InputNumber
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(v) => onChange(v == null ? 0 : Number(v))}
        size="sm"
        suffix={suffix}
      />
      {hint && <div className="hint">{hint}</div>}
      {suffixHint && (
        <div className="hint" style={{ color: "var(--warn, #d97706)" }}>
          {suffixHint}
        </div>
      )}
    </div>
  );
}

/** 下拉选择 */
export function SelectField({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="field-block">
      <span className="field-label">{label}</span>
      <Select value={value} options={options} onChange={onChange} size="sm" />
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

/** 文本输入 */
export function TextField({
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="field-block">
      <span className="field-label">{label}</span>
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        size="sm"
      />
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

/**
 * 时间输入（HH:mm）。
 * 直接用原生 input[type=time]：库的 TimePicker 走 Date 对象往返，
 * 而配置文件里存的就是 "HH:mm" 字符串，原生控件少一层转换。
 */
export function TimeField({
  label,
  hint,
  value,
  onChange,
}: {
  label?: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="field-block">
      {label && <span className="field-label">{label}</span>}
      <input
        className="lg-time"
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

/** 分节标题（action = 标题行最右侧的操作区，如「编辑」按钮） */
export function Section({
  title,
  desc,
  action,
  children,
}: {
  title: string;
  desc?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="sec">
      <div className="sec-head">
        <div className="sec-title">{title}</div>
        {action}
      </div>
      {desc && <div className="hint" style={{ marginBottom: 8 }}>{desc}</div>}
      {children}
    </section>
  );
}
