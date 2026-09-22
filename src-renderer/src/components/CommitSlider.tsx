import { useRef } from "react";
import { GlassSlider } from "@ttqtt/liquid-glass-react";

/**
 * 在 GlassSlider（新库原生滑动条）之上补一层「提交语义」。
 *
 * 新库只提供 `onValueChange`（拖动过程中持续触发），而外观设置希望
 * 拖动中走本地草稿、松手才写盘（避免高频 IPC 与磁盘写入）。
 * 这里用外层容器的 pointerup / keyup 判定提交时机，把「实时值」与
 * 「已提交值」两个概念显式分开，而不是去模拟旧库的 onChangeEnd。
 */
export function CommitSlider({
  value,
  min,
  max,
  step,
  ariaLabel,
  formatValue,
  onValueChange,
  onCommit,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  ariaLabel: string;
  formatValue?: (value: number) => string;
  /** 拖动过程中的实时值（用于草稿态跟手） */
  onValueChange?: (value: number) => void;
  /** 松手 / 键盘操作结束后的最终值（用于落盘） */
  onCommit?: (value: number) => void;
}) {
  const latest = useRef(value);

  return (
    <span
      className="commit-slider"
      onPointerUp={() => onCommit?.(latest.current)}
      onKeyUp={() => onCommit?.(latest.current)}
    >
      <GlassSlider
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={ariaLabel}
        formatValue={formatValue}
        onValueChange={(next) => {
          latest.current = next;
          onValueChange?.(next);
        }}
      />
    </span>
  );
}