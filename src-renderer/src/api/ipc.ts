import type { ElectronApi } from "../types/electron";
import { createMockApi } from "./mock";
import { createWebApi } from "./web";

/**
 * 统一的 API 访问入口。三种运行环境自动切换实现：
 *
 *   Electron 桌面版 —— preload 注入的 window.api（IPC）
 *   Docker / 浏览器 —— createWebApi()（HTTP + SSE，与桌面版同接口）
 *   Vite 单独预览 UI —— createMockApi()（假后端，方便脱机调样式）
 *
 * 判定顺序很重要：桌面版产物在 Electron 里也是 PROD 构建，
 * 所以必须先认 window.api，再按 PROD 落 Web 适配器，最后才是 mock。
 */

const viteEnv = (import.meta as unknown as { env?: { PROD?: boolean } }).env;

export const IS_ELECTRON =
  typeof window !== "undefined" && typeof window.api !== "undefined";

/** 构建产物被浏览器直接打开（Docker 版），走 HTTP + SSE */
export const IS_WEB = !IS_ELECTRON && !!viteEnv?.PROD;

export const api: ElectronApi = IS_ELECTRON ? window.api : IS_WEB ? createWebApi() : createMockApi();
