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
  // ⚠️ 必须显式 dedupe react/react-dom（2026-10-07 黑屏根因）。
  //
  // 现象：打包产物打开是**纯黑窗口**（CSS 背景色生效了，但 React 组件树为空），
  //       控制台报 `TypeError: Cannot read properties of null (reading 'useState')`。
  //
  // 根因：产物里出现了**两份 React 命名空间**（`e` 与 `r`），各自持有一份
  //       `__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE`。
  //       渲染时组件从其中一份取 dispatcher，而 hook 调用走的是另一份 —— 后者的
  //       dispatcher 恒为 null，于是useState 返回 null，React 直接抛错、整棵树不渲染。
  //这是 vite 8（rolldown 内核）在 tree-shaking 阶段把 React 拆成多份的已知形态。
  //
  // dedupe 让所有对 react / react-dom / react/jsx-runtime 的引用**强制解析到同一份**，
  // 从根上消除「两份 internals 不同步」。
  resolve: {
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
  build: {
    // 产物输出到项目根的 gui-react/，供electron-main.js loadFile
    outDir: resolve(here, "../gui-react"),
    // 不自动清空，避免沙箱安全删除守护对大量文件拦截
    emptyOutDir: false,
    // 便于排查产物体积
    reportCompressedSize: true,
    // 单一 chunk（默认值）：拆包会显著提高「同一份依赖被打进多个chunk」
    // 的概率，是duplicate React 的诱因之一。
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
