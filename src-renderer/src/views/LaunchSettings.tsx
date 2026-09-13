import { useEffect, useState } from "react";
import { Button, Card, InputNumber, toast } from "@ttqtt/liquid-glass-react";
import { api } from "../api/ipc";
import { SwitchField } from "../components/fields";
import type { CloseAction, LaunchConfig } from "../types";

/** 点 × 关闭主窗口的三种行为，顺序即分段控件中的展示顺序 */
const CLOSE_OPTIONS: { key: CloseAction; label: string; desc: string }[] = [
  { key: "ask", label: "每次询问", desc: "每次点 × 都弹出选项卡，由你选择去托盘还是退出" },
  { key: "tray", label: "退出到托盘", desc: "窗口隐藏，任务和定时调度继续在后台运行；托盘「退出」才真正关闭" },
  { key: "exit", label: "完全退出", desc: "直接结束进程，所有任务与定时调度停止" },
];

export function LaunchSettings() {
  const [cfg, setCfg] = useState<LaunchConfig | null>(null);

  useEffect(() => {
    api
      .getLaunch()
      .then(setCfg)
      .catch(() => setCfg(null));
  }, []);

  const onChange = async (patch: Partial<LaunchConfig>) => {
    const next = await api.setLaunch(patch);
    setCfg(next);
    // 开机自启开关会改变系统登录项注册，给出可感知反馈
    if (patch.autoLaunch !== undefined) {
      toast.success(patch.autoLaunch ? "已开启开机自启动" : "已关闭开机自启动");
    }
  };

  if (!cfg) return <div className="hint">加载中…</div>;

  return (
    <div className="block">
      <div className="block-head">
        <div>
          <div className="block-title">启动与托盘</div>
          <div className="block-sub">
            控制软件是否随系统开机自启、启动后是否驻留托盘，以及开机启动的延迟时间
          </div>
        </div>
      </div>

      <Card padding="md">
        <SwitchField
          label="开机自动启动"
          hint="把本软件注册到系统登录项，开机后自动运行"
          checked={cfg.autoLaunch}
          onChange={(v) => void onChange({ autoLaunch: v })}
        />

        <SwitchField
          label="开机后驻留到托盘"
          hint={
            cfg.autoLaunch
              ? "开机自启后不弹主窗口，仅在托盘区后台运行；点击托盘图标再唤出"
              : "需先开启上方「开机自动启动」，才会在开机时生效"
          }
          checked={cfg.launchToTray}
          disabled={!cfg.autoLaunch}
          onChange={(v) => void onChange({ launchToTray: v })}
        />

        <div className="field-row" style={{ marginTop: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div>开机启动延迟</div>
            <div className="hint">
              {cfg.autoLaunch
                ? "仅开机自启时生效；0 表示立即启动，错峰避免开机时抢占系统资源"
                : "仅开机自启时生效"}
            </div>
          </div>
          <div className="range-field">
            <InputNumber
              value={cfg.launchDelay}
              min={0}
              max={600}
              step={1}
              size="sm"
              onChange={(v) => void onChange({ launchDelay: Number(v) || 0 })}
            />
            <span className="rng-val">秒</span>
          </div>
        </div>

        <div className="field-row" style={{ marginTop: 12, alignItems: "flex-start" }}>
          <div style={{ minWidth: 0 }}>
            <div>点击 × 关闭主窗口时</div>
            <div className="hint">{CLOSE_OPTIONS.find((o) => o.key === cfg.closeAction)?.desc}</div>
          </div>
          <div className="close-action-group">
            {CLOSE_OPTIONS.map((o) => (
              <Button
                key={o.key}
                size="sm"
                variant={cfg.closeAction === o.key ? "accent" : "glass"}
                onClick={() => void onChange({ closeAction: o.key })}
              >
                {o.label}
              </Button>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}
