import { useEffect, useRef, useState } from "react";
import type { ThemeMode } from "../types";

/**
 * 把 appearance.mode 解析成实际的深浅主题。
 *
 * - system 模式监听系统偏好变化并实时跟随。
 * - 开启 autoTheme 且能取到壁纸亮度时，不再用「整图平均亮度」这种对花色
 *   壁纸不可靠的判据（一张图可能上半亮、左下暗，平均值落在中间带），
 *   而是**检测主题色**：模拟深/浅两套主题的面板色与文字色，和壁纸经过
 *   暗化层、衬底、玻璃染色层层合成后的实际颜色，分别算 WCAG 文字对比度，
 *   选对比度更高的那套主题。纯色壁纸结论与亮度法一致，花色壁纸则按
 *   「哪套主题的文字真的看得清」来选。
 *   两套对比度差距 <5% 时保持上一次结果，避免临界来回闪烁。
 */
export function useTheme(
  mode: ThemeMode | undefined,
  autoTheme: boolean,
  luma: number | null,
  bgDim?: number
): "dark" | "light" {
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true
  );

  useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  const base: "dark" | "light" =
    mode === "system" ? (systemDark ? "dark" : "light") : mode ?? "dark";

  // 滞回用的上一次结果
  const last = useRef<"dark" | "light">(base);

  let resolved = base;
  if (autoTheme && luma != null) {
    resolved = pickThemeByContrast(luma, bgDim ?? 0.25, last.current);
  }
  last.current = resolved;

  // 写到 <html> 上，CSS 里的 :root[data-theme=...] 才能生效
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);
  }, [resolved]);

  return resolved;
}

/* ---------------- 主题色对比度选主题 ----------------
 * 合成链与 global.css 保持一致（有壁纸时，自下而上）：
 *   壁纸平均色 --黑色暗化层(bg-dim)--> --主题衬底(shell-scrim)--> --玻璃染色(lg-tint)--> 面板
 *   深色主题：衬底 rgb(0,0,0,0.45)，染色 rgb(255,255,255,0.10)，文字 rgb(233,237,245)
 *   壁纸暗化比例由调用方传入，默认 0.25。
 *   浅色主题：衬底 rgb(255,255,255,0.62)，染色 rgb(255,255,255,0.42)，文字 rgb(28,36,51)
 * 用平均亮度 luma 近似壁纸平均色（灰度）对「选哪套主题」足够精确。
 */

/** sRGB 相对亮度（WCAG 定义） */
function relLum(r: number, g: number, b: number): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG 对比度（1–21） */
function contrast(l1: number, l2: number): number {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** alpha 合成：fg 以 a 不透明度叠在 bg 上 */
function over(fg: number, a: number, bg: number): number {
  return fg * a + bg * (1 - a);
}

/** 模拟某套主题合成后的面板灰度 */
function compositePanel(w: number, theme: "dark" | "light"): number {
  if (theme === "dark") {
    const scrim = over(0, 0.25, w);
    return over(255, 0.1, scrim);
  }
  const scrim = over(255, 0.62, w);
  return over(255, 0.42, scrim);
}

function pickThemeByContrast(
  luma: number,
  dim: number,
  fallback: "dark" | "light"
): "dark" | "light" {
  // 壁纸平均色先过黑色暗化层（--bg-dim）
  const w = luma * 255 * (1 - dim);

  const pDark = compositePanel(w, "dark");
  const pLight = compositePanel(w, "light");
  const cDark = contrast(relLum(233, 237, 245), relLum(pDark, pDark, pDark));
  const cLight = contrast(relLum(28, 36, 51), relLum(pLight, pLight, pLight));

  // 差距太小（<5%）时不切换，避免临界抖动
  if (Math.abs(cDark - cLight) / Math.max(cDark, cLight) < 0.05) return fallback;
  return cDark >= cLight ? "dark" : "light";
}
