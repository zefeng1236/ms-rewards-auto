import {
  Input,
  InputNumber,
  Select,
  Switch,
  type SelectOption,
} from "@ttqtt/liquid-glass-react";

/** 带说明文字的开关行 */
export function SwitchField({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="field-row">
      <div style={{ minWidth: 0 }}>
        <div>{label}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
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
}: {
  label: string;
  hint?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="field-block">
      <span className="field-label">{label}</span>
      <InputNumber
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(v) => onChange(Number(v) || 0)}
        size="sm"
      />
      {hint && <div className="hint">{hint}</div>}
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
  value,
  onChange,
}: {
  label?: string;
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
    </div>
  );
}

/** 分节标题 */
export function Section({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="sec">
      <div className="sec-title">{title}</div>
      {desc && <div className="hint" style={{ marginBottom: 8 }}>{desc}</div>}
      {children}
    </section>
  );
}
