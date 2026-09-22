import { useEffect } from "react";

/**
 * 修复 @ttqtt/liquid-glass-react@0.2.0 的指针光晕，并补足「看得见」的问题。
 *
 * 库的三个独立缺陷：
 * 1) 坐标不跟手：库把光晕坐标更新器绑在 mousemove，但玻璃元素只挂 onPointerMove，
 *    Chromium 下 pointer 事件不回退触发 mousemove → --lg-pointer-x/y 永停初始 50%/0%。
 *    这里用 pointermove 直接把光标相对玻璃元素的百分比写回这两个变量。
 * 2) 高光层透明：库的光晕层（.lg-surface:after）只在 [data-interactive] 时把高光色
 *    设为可见；项目里所有 GlassSurface 都没传 interactive → 高光永久 transparent。
 *    这里补上 data-interactive 属性（库 JS 不读此属性，纯 CSS 开关，安全）。
 * 3) 高光太散/太弱：库的 radial-gradient 未指定半径（默认 farthest-corner），在细长元素上
 *    光斑可散开数百像素被稀释到不可见；官方 demo 的观感是「一大团柔和的光跟着鼠标」。
 *    这里在 .lg-surface 本体（库未占用 background）叠加一层固定半径、缓衰减的柔光斑，
 *    引用同一对坐标变量，瞬时跟手。
 *
 * 光斑淡入淡出用 --lg-halo-alpha 变量：进入时按主题取 0.3（深色）/0.16（浅色）、
 * 离开时 0，gradient 字符串只写一次。
 * 半径是唯一需要调的观感参数：这里用常量 HALO_RADIUS_PX，改一个数字即可整体调大小。
 */
const HALO_ALPHA = "--lg-halo-alpha";
const HALO_RADIUS_PX = 200;
/**
 * 光晕挂载目标。此前只绑 `.lg-surface`（库的 GlassSurface），而项目里真正的
 * 内容卡片走的是 AppCard → MaterialView（`.lg-material-view`），开关是
 * `.lg-switch`，两者都不是 `.lg-surface` → 光晕对「大部分卡片」和「开关」
 * 完全无效（用户反馈「鼠标光晕为啥开关没有用 / 划过效果对大部分卡片无效」）。
 *
 * 注意：`.lg-switch` 是包含 label 文字的 inline-flex 容器（width = pill + gap +
 * label 宽度），如果直接绑整个 .lg-switch，200px 光晕渐变会溢出矩形容器 → 视觉
 * 上像"开关后面有框"。所以开关只绑内层 pill `.lg-switch-track`（库自带的
 * 48×28 椭圆元素，库未占用 background-image，可安全叠加）。
 *
 * 排除项：
 *   - .friend-logo（关于页友链徽标容器，46×46 的 GlassSurface。光晕 200px
 *     渐变盖上去会把 svg cube 边缘糊成"歪"。）
 *   - :disabled / aria-disabled="true"（不响应交互的按钮不应有光晕）
 */
const HALO_SELECTOR =
  ".lg-surface:not(.friend-logo):not(:disabled):not([aria-disabled=\"true\"])," +
  " .lg-material-view," +
  " .lg-switch-track";
const HALO_BG =
  "radial-gradient(" + HALO_RADIUS_PX + "px circle at var(--lg-pointer-x) var(--lg-pointer-y)," +
  " rgb(255 255 255 / var(" + HALO_ALPHA + ", 0))," +
  " rgb(255 255 255 / calc(var(" + HALO_ALPHA + ", 0) * 0.35)) 42%," +
  " transparent 75%)";

export function useLiquidGlassHalo(enabled: boolean): void {
  useEffect(() => {
    // 独立开关：关闭时不挂载任何逻辑，也不残留内联样式（cleanup 会清掉）
    if (!enabled) return;

    const THEME_ATTR = "data-theme";
    const attached = new WeakSet<Element>();

    // 深色玻璃上库默认高光太淡（28% 白），提亮到 50%；浅色用库默认（72% 白，已明显）。
    const highlightValue = (): string => {
      const theme = document.documentElement.getAttribute(THEME_ATTR) || "dark";
      return theme === "dark" ? "rgba(255, 255, 255, .5)" : "var(--lg-pointer-highlight)";
    };

    // 集中光斑强度：深色底需更亮才明显（对齐官网 demo 观感）；浅色玻璃偏亮，白光稍低。
    const haloAlpha = (): string => {
      const theme = document.documentElement.getAttribute(THEME_ATTR) || "dark";
      return theme === "dark" ? "0.3" : "0.16";
    };

    const paintHighlight = (el: HTMLElement) => {
      el.style.setProperty("--lg-surface-pointer-highlight", highlightValue());
    };

    const apply = (el: HTMLElement, clientX: number, clientY: number) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const x = ((clientX - rect.left) / rect.width) * 100;
      const y = ((clientY - rect.top) / rect.height) * 100;
      el.style.setProperty("--lg-pointer-x", x.toFixed(2) + "%");
      el.style.setProperty("--lg-pointer-y", y.toFixed(2) + "%");
      el.style.setProperty(HALO_ALPHA, haloAlpha());
    };

    const onMove = (e: Event) => {
      apply(e.currentTarget as HTMLElement, (e as PointerEvent).clientX, (e as PointerEvent).clientY);
    };
    const onLeave = (e: Event) => {
      const el = e.currentTarget as HTMLElement;
      // 光斑淡出；坐标复位到库默认（光斑已透明，位置无所谓）
      el.style.setProperty(HALO_ALPHA, "0");
      el.style.setProperty("--lg-pointer-x", "50%");
      el.style.setProperty("--lg-pointer-y", "0%");
    };

    const bind = (el: HTMLElement) => {
      if (attached.has(el)) return;
      attached.add(el);
      // 开启库自带的指针高光层（库 JS 不读此属性，纯 CSS 开关，安全）
      el.setAttribute("data-interactive", "");
      paintHighlight(el);
      // 本体叠加集中光斑：gradient 只设一次，位置跟随 --lg-pointer-x/y（库已带过渡）
      el.style.setProperty(HALO_ALPHA, "0");
      el.style.backgroundImage = HALO_BG;
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerleave", onLeave);
    };

    const scan = () => {
      document.querySelectorAll<HTMLElement>(HALO_SELECTOR).forEach(bind);
    };

    // 首扫 + 监听后续动态挂载的玻璃元素（向导 / 弹窗 / 卡片等）
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true });

    // 主题切换时（autoTheme 依壁纸亮度）重新应用对应强度的高光
    const themeObserver = new MutationObserver(() => {
      document.querySelectorAll<HTMLElement>(HALO_SELECTOR).forEach(paintHighlight);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [THEME_ATTR],
    });

    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      document.querySelectorAll<HTMLElement>(HALO_SELECTOR).forEach((el) => {
        el.removeAttribute("data-interactive");
        el.style.removeProperty("--lg-surface-pointer-highlight");
        el.style.removeProperty(HALO_ALPHA);
        el.style.removeProperty("background-image");
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerleave", onLeave);
      });
    };
  }, [enabled]);
}
