import { useState } from "react";
import {
  Button,
  GlassSurface,
  SideNav,
  toast,
  type SideNavItem,
} from "@ttqtt/liquid-glass-react";
import { api, IS_WEB } from "../api/ipc";
import { webLogout } from "../api/web";
import { useAppState } from "../hooks/useAppState";
import type { ViewKey } from "../App";

const NAV_ITEMS: SideNavItem[] = [
  { type: "group", label: "工作台" },
  { key: "dashboard", label: "仪表盘", icon: "◫" },
  { key: "account", label: "账户详情", icon: "◉" },
  { key: "settings", label: "全局设置", icon: "⚙" },
  { key: "personalize", label: "个性化", icon: "✺" },
  // 开机自启 / 驻留托盘是桌面端语义，Docker 版由 compose 的 restart 策略接管
  ...(IS_WEB ? [] : [{ key: "launch", label: "启动与托盘", icon: "⏻" } as SideNavItem]),
  { type: "group", label: "其它" },
  { key: "about", label: "关于", icon: "ⓘ" },
];

export function Sidebar({
  view,
  onViewChange,
}: {
  view: ViewKey;
  onViewChange: (v: ViewKey) => void;
}) {
  const { chromium, logOpen, setLogOpen, accounts } = useAppState();
  const [installing, setInstalling] = useState(false);

  const onInstall = async () => {
    setInstalling(true);
    try {
      const r = await api.installBrowser();
      if (r.ok) toast.success("Chromium 安装完成");
      else toast.error(r.error || "Chromium 安装失败");
    } finally {
      setInstalling(false);
    }
  };

  return (
    <GlassSurface as="nav" className="sidenav" radius={0}>
      <div className="nav-brand">
        <img className="nav-logo-img" src="./icon.png" alt="" draggable={false} />
        <div style={{ minWidth: 0 }}>
          <div className="nav-title">Rewards Auto</div>
          <div className="nav-sub">Microsoft Rewards</div>
        </div>
      </div>

      <SideNav
        items={NAV_ITEMS}
        value={view}
        onChange={(k) => onViewChange(k as ViewKey)}
        aria-label="主导航"
      />

      <div className="nav-foot">
        <span className={`badge ${chromium?.ready ? "ok" : "warn"}`}>
          {chromium ? (chromium.ready ? "● Chromium 就绪" : "▲ 缺失 Chromium") : "检查中…"}
        </span>

        {chromium && !chromium.ready && (
          <Button variant="ghost" size="sm" onClick={onInstall} loading={installing}>
            安装 Chromium
          </Button>
        )}

        <Button variant="glass" size="sm" onClick={() => setLogOpen(!logOpen)}>
          ▤ 运行日志
        </Button>

        {IS_WEB && (
          <Button
            variant="ghost"
            size="sm"
            title="仅退出当前浏览器的登录，后台定时任务继续运行"
            onClick={async () => {
              await webLogout();
              window.location.reload();
            }}
          >
            ⏏ 退出登录
          </Button>
        )}

        <div className="hint">共 {accounts.length} 个账户</div>
      </div>
    </GlassSurface>
  );
}
