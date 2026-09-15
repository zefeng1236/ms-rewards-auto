import { useEffect, useState } from "react";
import { Card, Tag, toast } from "@ttqtt/liquid-glass-react";
import { api } from "../api/ipc";
import { useAppState } from "../hooks/useAppState";
import { SettingsForm } from "../components/SettingsForm";
import { VaultPanel } from "../components/VaultPanel";
import { mergeDeep } from "../utils";
import type { AppConfig, DeepPartial } from "../types";

export function SettingsView() {
  const { accounts, refreshAccounts } = useAppState();
  const [cfg, setCfg] = useState<AppConfig | null>(null);

  useEffect(() => {
    api
      .getGlobalConfig()
      .then(setCfg)
      .catch(() => setCfg(null));
  }, []);

  const onChange = async (patch: DeepPartial<AppConfig>) => {
    const next = await api.setGlobalConfig(patch);
    setCfg(next);
    // 全局值变了，遵循全局的账户有效配置随之改变
    await refreshAccounts();
  };

  const applyCount = accounts.filter((a) => a.useGlobal !== false).length;

  return (
    <>
      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">全局设置</div>
            <div className="block-sub">所有「遵循全局设置」的账号共用这份配置，改动立即生效</div>
          </div>
          <Tag color="accent" size="sm">
            {applyCount} 个账号遵循
          </Tag>
        </div>

        <Card padding="md">
          {cfg ? (
            <SettingsForm
              value={cfg}
              showLogging
              onChange={(patch) => {
                // 本地先乐观更新，避免输入框闪烁
                setCfg((prev) => (prev ? mergeDeep(prev, patch) : prev));
                void onChange(patch);
              }}
              onTestPush={async (notice) => {
                const r = await api.testPush(notice);
                if (r.ok === false) toast.error(r.error || "推送失败");
                else toast.success("测试推送已发送，详见日志");
              }}
            />
          ) : (
            <div className="hint">加载中…</div>
          )}
        </Card>
      </div>

      {/* 安全：登录态加密存储（启用/改密/恢复密钥/锁定） */}
      <VaultPanel />
    </>
  );
}
