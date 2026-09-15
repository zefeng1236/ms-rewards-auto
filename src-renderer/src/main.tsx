import { createRoot } from "react-dom/client";
import "@ttqtt/liquid-glass-react/style.css";
import "./styles/global.css";
import App from "./App";
import { IS_WEB } from "./api/ipc";

const el = document.getElementById("root");
if (!el) throw new Error("找不到 #root 挂载点");

// 浏览器（Docker 版）根节点标记：向导/锁屏在 Web 下铺满视口，
// Electron 桌面端仍保留居中浮窗卡片（见 global.css 的 [data-web] 规则）
if (IS_WEB) document.documentElement.setAttribute("data-web", "1");

createRoot(el).render(<App />);
