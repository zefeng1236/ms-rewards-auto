import type { ElectronApi } from "../types/electron";
import { createMockApi } from "./mock";

/**
 * 统一的 IPC 访问入口。
 *
 * 真实 Electron 环境用 preload 注入的 window.api；
 * 浏览器直开（vite dev 单独预览 UI）时自动回落到假后端，
 * 这样玻璃效果和布局可以脱离客户端单独调试。
 */
export const IS_ELECTRON =
  typeof window !== "undefined" && typeof window.api !== "undefined";

export const api: ElectronApi = IS_ELECTRON ? window.api : createMockApi();
