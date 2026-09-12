import { useEffect, useState } from "react";
import { Card, InputNumber, toast } from "@ttqtt/liquid-glass-react";
import { api } from "../api/ipc";
import { SwitchField } from "../components/fields";
import type { LaunchConfig } from "../types";

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

        <SwitchField
          label="关闭窗口时最小化到托盘"
          hint="点击窗口关闭按钮时不退出，而是缩到托盘区继续后台运行；托盘「退出」才真正关闭"
          checked={cfg.minimizeToTray}
          onChange={(v) => void onChange({ minimizeToTray: v })}
        />
      </Card>
    </div>
  );
}
