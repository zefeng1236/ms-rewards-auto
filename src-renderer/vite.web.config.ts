import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Docker / 浏览器版的 React 构建配置。
 *
 * 与桌面版（vite.config.ts）唯一的差别就在「产物给谁加载」：
 *   桌面版：Electron 用 file:// 加载 → base "./"、产物进 gui-react/
 *   Web 版：Node 服务用 http:// 托管 → base "/"、产物进 src/web/dist/
 * base 必须是绝对路径，否则部署在子路径下时 assets 会 404。
 */
export default defineConfig({
  root: here,
  base: "/",
  plugins: [react()],
  build: {
    outDir: resolve(here, "../src/web/dist"),
    // 产物目录在 root 之外，必须显式允许清空，否则每次构建都会堆历史 hash 文件
    emptyOutDir: true,
    sourcemap: false,
    reportCompressedSize: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
