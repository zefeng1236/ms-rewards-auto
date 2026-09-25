import { createRoot } from "react-dom/client";
import "@ttqtt/liquid-glass-react/style.css";
import "./styles/global.css";
import App from "./App";
import { IS_WEB } from "./api/ipc";

const el = document.getElementById("root");
if (!el) throw new Error("找不到 #root 挂载点");

// 浏览器（Docker 版）根节点标记：Web 专属样式钩子（0.13.4 起向导与桌面
// 统一为居中浮动玻璃卡片，仅个别 Web-only 微调仍用 [data-web] 区分）
if (IS_WEB) document.documentElement.setAttribute("data-web", "1");

createRoot(el).render(<App />);
