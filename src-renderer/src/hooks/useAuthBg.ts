import { useEffect, useState } from "react";
import { api } from "../api/ipc";
import { useAppState } from "./useAppState";
import type { AuthBgType } from "../types";

/**
 * 登录页 / 初始化向导的背景解析（独立于主界面壁纸 bgType）。
 *
 * - authBg = "flow"：不发请求，由 <AuthBackground/> 直接播 Canvas 流场动画；
 * - authBg = "bing"：按必应每日一图解析（服务端按 auth 语义覆盖 bgType）。
 *
 * 外观配置变化（emit appearance）时自动重解析，设置页切换即时生效。
 */
export function useAuthBg(): { authBg: AuthBgType; src: string } {
  const { appearance } = useAppState();
  const authBg: AuthBgType = appearance?.authBg === "bing" ? "bing" : "flow";
  const [src, setSrc] = useState("");

  useEffect(() => {
    // 流场是纯本地动画，没有图片地址；bing 才需要向服务端要图
    if (authBg !== "bing") {
      setSrc("");
      return;
    }
    let alive = true;
    api
      .getBgSrc({ auth: true })
      .then((r) => {
        if (alive) setSrc(r?.src || "");
      })
      .catch(() => {
        if (alive) setSrc("");
      });
    return () => {
      alive = false;
    };
  }, [authBg]);

  return { authBg, src };
}
