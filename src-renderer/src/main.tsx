import { createRoot } from "react-dom/client";
import "@ttqtt/liquid-glass-react/style.css";
import "./styles/global.css";
import App from "./App";

const el = document.getElementById("root");
if (!el) throw new Error("找不到 #root 挂载点");

createRoot(el).render(<App />);
