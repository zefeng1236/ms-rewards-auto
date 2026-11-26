import type { ButtonHTMLAttributes } from "react";
import "./liquidGlassCompat.css";

/**
 * 全局统一的关闭 / 移除图标按钮（2026-11-25 重做）。
 *
 * 旧实现有 4 套：Modal 与 Toast 的 28px 纯圆 ×、自动更新弹窗自绘 .upd-close、
 * 更新提示弹窗拿 GlassButton 文字按钮塞一个 ×、Tag 内联裸 ×。共同问题是
 * 用 `×` 文本字符（字体渲染粗细与基线随系统变）、尺寸/圆角/颜色不一致、
 * 没有焦点环与按压反馈，与主体 22px 圆角玻璃卡片不是同一套语言。
 *
 * 现在统一为 SVG 描边字形 + 单一 .app-close-btn 令牌：
 * 尺寸档 xs/sm/md、默认/hover/active/focus-visible/disabled 全状态、
 * 深浅主题用 CSS 变量自动适配、支持 prefers-reduced-motion。
 */

/** 单独的关闭字形：给 Tag、删除按钮这类不需要独立面板的紧凑场景复用。 */
export function CloseGlyph({ size, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      style={size ? { width: size, height: size } : undefined}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 6 L18 18 M18 6 L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export type CloseButtonSize = "xs" | "sm" | "md";

export interface CloseButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 无障碍名称；移除标签时传「移除」，弹窗关闭默认「关闭」。 */
  label?: string;
  size?: CloseButtonSize;
  /** danger 用于删除类操作，hover 时切成危险色填充。 */
  tone?: "neutral" | "danger";
}

export function CloseButton({
  label = "关闭",
  size = "sm",
  tone = "neutral",
  className,
  type = "button",
  children,
  ...rest
}: CloseButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={["app-close-btn", `app-close-btn--${size}`, `app-close-btn--${tone}`, className]
        .filter(Boolean)
        .join(" ")}
      aria-label={label}
    >
      {children ?? <CloseGlyph />}
    </button>
  );
}
