import { useEffect } from "react";
import type { ThemeMode } from "../types";

/**
 * 把 appearance.mode 解析成实际的深浅主题。
 *
 * ⚠️ 2026-10-03 起**强制深色**：用户反馈浅色主题不生效、且观感不佳，
 * 深浅模式切换入口已隐藏（见 Personalize.tsx）。此处不再看 mode / autoTheme，
 * 恒定返回 "dark"，保证任何旧配置（mode=light/system、autoTheme=true）都不会再切到浅色。
 *
 * 历史逻辑（保留在下方供回溯，不再生效）：
 * - system 模式监听系统偏好变化并实时跟随。
 * - 开启 autoTheme 且能取到壁纸亮度时，模拟深/浅两套主题合成后的 WCAG 对比度
 *   选更高的一套（花色壁纸也准），差距 <5% 时保持上一次结果避免闪烁。
 */
export function useTheme(
  _mode: ThemeMode | undefined,
  _autoTheme: boolean,
  _luma: number | null,
  _bgDim?: number
): "dark" | "light" {
  const resolved: "dark" | "light" = "dark";
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);
  }, [resolved]);
  return resolved;
}

/**
 * 历史实现已移除（强制深色后不再需要）：原逻辑是「system 跟随系统偏好 +
 * autoTheme 按 WCAG 对比度在深/浅两套里选」，需要恢复时从 git 历史取回
 * （搜 pickThemeByContrast）。对比度合成链见下方注释。
 */

/* ---------------- 主题色对比度选主题 ----------------
 * 合成链与 global.css 保持一致（有壁纸时，自下而上）：
 *   壁纸平均色 --黑色暗化层(bg-dim)--> --主题衬底(shell-scrim)--> --玻璃染色(lg-tint)--> 面板
 *   深色主题：衬底 rgb(0,0,0,0.45)，染色 rgb(255,255,255,0.10)，文字 rgb(233,237,245)
 *   壁纸暗化比例由调用方传入，默认 0.25。
 *   浅色主题：衬底 rgb(255,255,255,0.62)，染色 rgb(255,255,255,0.42)，文字 rgb(28,36,51)
 * 用平均亮度 luma 近似壁纸平均色（灰度）对「选哪套主题」足够精确。
 */

/** sRGB 相对亮度（WCAG 定义） */
export function relLum(r: number, g: number, b: number): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG 对比度（1–21） */
export function contrast(l1: number, l2: number): number {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** alpha 合成：fg 以 a 不透明度叠在 bg 上 */
export function over(fg: number, a: number, bg: number): number {
  return fg * a + bg * (1 - a);
}

/** 模拟某套主题合成后的面板灰度 */
export function compositePanel(w: number, theme: "dark" | "light"): number {
  if (theme === "dark") {
    const scrim = over(0, 0.25, w);
    return over(255, 0.1, scrim);
  }
  const scrim = over(255, 0.62, w);
  return over(255, 0.42, scrim);
}

export function pickThemeByContrast(
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
