import { useEffect, useState } from "react";
import { AppCard, Tag, toast } from "../components/liquidGlassCompat";
import { api } from "../api/ipc";
import { useAppState } from "../hooks/useAppState";
import { SettingsForm } from "../components/SettingsForm";
import { mergeDeep } from "../utils";
import type { AppConfig, DeepPartial } from "../types";

export function SettingsView() {
  const { accounts, refreshAccounts, refreshGlobalConfig } = useAppState();
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
    // 一言的开关/位置也是全局的，界面要立刻跟着变（否则要刷新进程才看得到效果）
    await refreshGlobalConfig();
  };

  const applyCount = accounts.filter((a) => a.useGlobal !== false).length;

  return (
    <>
      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">任务全局设置</div>
            <div className="block-sub">只包含与积分任务执行有关的配置项，所有「遵循全局设置」的账号共用，改动立即生效</div>
          </div>
          <Tag color="accent" size="sm">
            {applyCount} 个账号遵循
          </Tag>
        </div>

        <AppCard padding={16}>
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
        </AppCard>
      </div>
    </>
  );
}
