import { useCallback, useEffect, useRef, useState } from "react";
import { useAmbientFromImage } from "../components/liquidGlassCompat";
import { api } from "../api/ipc";
import { useAppState } from "./useAppState";
import type { BgType } from "../types";

/** 随机图源：轮换间隔有下限，避免把第三方接口打爆 */
const RANDOM_SOURCES: BgType[] = ["uapi", "qy98", "unsplash"];
const MIN_ROTATE_SEC = 60;

/**
 * 壁纸背景：地址解析 + 自动轮换 + 环境色取样。
 *
 * 环境色（--lg-ambient）是液态玻璃最出效果的一环 —— 玻璃会染上当张
 * 壁纸的主色。跨域或解码失败时 useAmbientFromImage 静默返回 null，
 * 这里保持透明即可，不需要额外兜底。
 */
export function useBackground() {
  const { appearance } = useAppState();
  const [src, setSrc] = useState("");
  const [nonce, setNonce] = useState(0);
  const [luma, setLuma] = useState<number | null>(null);

  const bgType = appearance?.bgType ?? "none";
  const bgUrl = appearance?.bgUrl;
  const bgFile = appearance?.bgFile;
  const bgCategory = appearance?.bgCategory;
  const bgRotate = appearance?.bgRotate ?? 0;

  // ---- 解析当前背景地址 ----
  const lastNonce = useRef<number>(-1);
  useEffect(() => {
    // 「流场」是纯本地粒子动画，没有图片地址；此处直接清空并返回
    if (bgType === "none" || bgType === "flow") {
      setSrc("");
      lastNonce.current = nonce;
      return;
    }
    // nonce 变化说明是「换一张」或轮换到期，此时要强制重新拉随机图；
    // 首次挂载或切换图源时复用缓存，保证各处看到的是同一张。
    const fresh = lastNonce.current >= 0 && nonce !== lastNonce.current;
    lastNonce.current = nonce;

    let alive = true;
    api
      .getBgSrc({ fresh })
      .then((r) => {
        if (!alive) return;
        // 随机图源每次下载到同一个缓存文件 → 返回的 file:// 路径字符串不变。
        // React 认为状态没变就不会重渲染，用户看到「点了没反应」。
        // 追加时间戳强制浏览器重新加载图片（file:// 的 query 会被 Electron 忽略，
        // 但 CSS background-image 和 Image.src 会把它当作新地址去请求）。
        const finalSrc = r?.src
          ? r.src.startsWith("data:")
            ? r.src // data URI 内容本身就是载荷，追加查询串会破坏内联 SVG。
            : r.src + (r.src.includes("?") ? "&" : "?") + "_t=" + Date.now()
          : "";
        setSrc(finalSrc);
        setLuma(typeof r?.luma === "number" ? r.luma : null);
      })
      .catch(() => {
        if (alive) {
          setSrc("");
          setLuma(null);
        }
      });
    return () => {
      alive = false;
    };
  }, [bgType, bgUrl, bgFile, bgCategory, nonce]);

  // ---- 自动轮换 ----
  useEffect(() => {
    // bing 按天缓存、本地文件固定，都不参与轮换
    if (!bgRotate || bgType === "none" || bgType === "bing" || bgType === "file") return;
    const isRandom = RANDOM_SOURCES.includes(bgType);
    const sec = isRandom ? Math.max(MIN_ROTATE_SEC, bgRotate) : bgRotate;
    const timer = window.setInterval(() => setNonce((n) => n + 1), sec * 1000);
    return () => window.clearInterval(timer);
  }, [bgType, bgRotate]);

  // ---- 从壁纸取样环境色 ----
  const ambient = useAmbientFromImage(src || null, { strategy: "edge" });

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { src, ambient, reload, luma };
}
