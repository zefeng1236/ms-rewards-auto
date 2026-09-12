import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  // Electron 用 file:// 加载产物，必须是相对路径，不能用默认的 /
  base: "./",
  plugins: [react()],
  build: {
    // 产物输出到项目根的 gui-react/，供 electron-main.js loadFile
    outDir: resolve(here, "../gui-react"),
    // 不自动清空，避免沙箱安全删除守护对大量文件拦截
    emptyOutDir: false,
    // 便于排查产物体积
    reportCompressedSize: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
