import { useState } from "react";
import {
  Button,
  Input,
  InputNumber,
  Select,
  type SelectOption,
} from "@ttqtt/liquid-glass-react";
import { NumberField, Section, SelectField, SwitchField, TextField, TimeField } from "./fields";
import type { AppConfig, DeepPartial, GoalItem, ScheduleWindow } from "../types";

const SEARCH_API_OPTIONS: SelectOption[] = [
  { label: "hot.nntool.cc", value: "hot.nntool.cc" },
  { label: "hot.baiwumm.com", value: "hot.baiwumm.com" },
  { label: "hot.cnxiaobai.com", value: "hot.cnxiaobai.com" },
  { label: "内置随机词", value: "offline" },
];

const MODE_OPTIONS: SelectOption[] = [
  { label: "循环间隔（推荐）", value: "interval" },
  { label: "指定时间段", value: "windows" },
  { label: "每天固定时刻一次", value: "daily" },
];

const SCOPE_OPTIONS: SelectOption[] = [{ label: "总积分余额", value: "balance" }];

const TASK_LABELS: { key: keyof AppConfig["tasks"]; label: string }[] = [
  { key: "sign", label: "每日签入" },
  { key: "read", label: "阅读文章" },
  { key: "promos", label: "活动交卷" },
  { key: "search", label: "搜索积分" },
];

/**
 * 全局设置 / 账户独立设置共用的表单。
 *
 * 每次改动都通过 onChange 向上抛补丁，由调用方决定何时落盘
 * （全局设置立即写；账户设置要视 useGlobal 状态而定）。
 */
export function SettingsForm({
  value,
  onChange,
  onTestPush,
  showLogging = false,
}: {
  value: AppConfig;
  onChange: (patch: DeepPartial<AppConfig>) => void;
  onTestPush?: (notice: AppConfig["notice"]) => Promise<void>;
  /** 日志保留是应用级设置，仅全局设置页显示 */
  showLogging?: boolean;
}) {
  const [testing, setTesting] = useState(false);

  const patchSchedule = (p: Partial<AppConfig["schedule"]>) =>
    onChange({ schedule: p } as DeepPartial<AppConfig>);

  const windows = value.schedule?.windows ?? [];

  const setWindow = (i: number, p: Partial<ScheduleWindow>) => {
    const next = windows.map((w, idx) => (idx === i ? { ...w, ...p } : w));
    patchSchedule({ windows: next });
  };
  const addWindow = () => patchSchedule({ windows: [...windows, { start: "09:00", end: "23:00" }] });
  const delWindow = (i: number) => patchSchedule({ windows: windows.filter((_, idx) => idx !== i) });

  const goals = value.goals ?? { enable: true, items: [] };
  const setGoal = (i: number, p: Partial<GoalItem>) =>
    onChange({
      goals: { items: goals.items.map((g, idx) => (idx === i ? { ...g, ...p } : g)) },
    } as DeepPartial<AppConfig>);
  const addGoal = () =>
    onChange({
      goals: {
        items: [
          ...goals.items,
          { name: "新目标", scope: "balance", target: 100, rewardName: "", showDashboard: true },
        ],
      },
    } as DeepPartial<AppConfig>);
  const delGoal = (i: number) =>
    onChange({
      goals: { items: goals.items.filter((_, idx) => idx !== i) },
    } as DeepPartial<AppConfig>);

  const onTest = async () => {
    if (!onTestPush) return;
    setTesting(true);
    try {
      await onTestPush(value.notice);
    } finally {
      setTesting(false);
    }
  };

  const mode = value.schedule?.mode ?? "interval";

  return (
    <div className="settings-form">
      <Section title="任务开关">
        <div className="form-grid">
          {TASK_LABELS.map(({ key, label }) => (
            <SwitchField
              key={key}
              label={label}
              checked={!!value.tasks?.[key]}
              onChange={(v) => onChange({ tasks: { [key]: v } } as DeepPartial<AppConfig>)}
            />
          ))}
        </div>
      </Section>

      <Section title="单次执行数量" desc="把当天的阅读与活动摊到多轮里做，避免一轮全部清空">
        <SwitchField
          label="随机波动"
          hint="在设定数量上随机 ±2–4 个；不会一次做完，也不会少到 0 个（不满足时自动放弃随机）"
          checked={value.limits?.random === true}
          onChange={(v) => onChange({ limits: { random: v } } as DeepPartial<AppConfig>)}
        />
        <div className="form-grid" style={{ marginTop: 12 }}>
          <NumberField
            label="阅读文章每次篇数"
            hint="0 = 不限制（一次读完）"
            value={value.limits?.read ?? 0}
            min={0}
            max={50}
            onChange={(v) => onChange({ limits: { read: Math.max(0, v) } } as DeepPartial<AppConfig>)}
          />
          <NumberField
            label="活动交卷每次个数"
            hint="0 = 不限制（一次做完）"
            value={value.limits?.promos ?? 0}
            min={0}
            max={50}
            onChange={(v) => onChange({ limits: { promos: Math.max(0, v) } } as DeepPartial<AppConfig>)}
          />
        </div>
      </Section>

      <Section title="区域设置">
        <SwitchField
          label="锁定国区"
          hint="开启后，检测到 IP 非中国大陆时停止任务"
          checked={value.region?.lock !== false}
          onChange={(v) => onChange({ region: { lock: v } })}
        />
      </Section>

      <Section title="搜索设置">
        <div className="form-grid">
          <NumberField
            label="搜索间隔（秒）"
            hint="实际间隔会在此值 ±15 秒间随机"
            value={value.search?.span ?? 30}
            min={5}
            max={300}
            onChange={(v) => onChange({ search: { span: v } })}
          />
          <SelectField
            label="搜索词来源"
            value={value.search?.api ?? "offline"}
            options={SEARCH_API_OPTIONS}
            onChange={(v) => onChange({ search: { api: v as AppConfig["search"]["api"] } })}
          />
        </div>
      </Section>

      <Section title="自动运行">
        <SwitchField
          label="启用自动运行"
          checked={value.schedule?.enable !== false}
          onChange={(v) => patchSchedule({ enable: v })}
        />

        <div className="form-grid" style={{ marginTop: 10 }}>
          <SelectField
            label="运行模式"
            value={mode}
            options={MODE_OPTIONS}
            onChange={(v) => patchSchedule({ mode: v as AppConfig["schedule"]["mode"] })}
          />
        </div>

        {mode === "interval" && (
          <div className="form-grid" style={{ marginTop: 12 }}>
            <NumberField
              label="每隔多少分钟跑一轮"
              value={value.schedule?.intervalMinutes ?? 45}
              min={5}
              max={720}
              onChange={(v) => patchSchedule({ intervalMinutes: v })}
            />
            <NumberField
              label="每天最多轮数"
              hint="0 表示不限"
              value={value.schedule?.maxRounds ?? 0}
              min={0}
              max={99}
              onChange={(v) => patchSchedule({ maxRounds: v })}
            />
            <SwitchField
              label="当天任务全部完成后停止循环"
              checked={value.schedule?.stopWhenDone !== false}
              onChange={(v) => patchSchedule({ stopWhenDone: v })}
            />
          </div>
        )}

        {mode === "windows" && (
          <div style={{ marginTop: 12 }}>
            <div className="hint" style={{ marginBottom: 8 }}>
              执行时间段（可添加多段，支持跨零点如 22:00–02:00）
            </div>
            {windows.map((w, i) => (
              <div className="win-row" key={i}>
                <TimeField value={w.start} onChange={(v) => setWindow(i, { start: v })} />
                <TimeField value={w.end} onChange={(v) => setWindow(i, { end: v })} />
                <Button variant="danger" size="sm" onClick={() => delWindow(i)}>
                  删除
                </Button>
              </div>
            ))}
            <div className="form-grid" style={{ marginTop: 8 }}>
              <NumberField
                label="段内每隔多少分钟跑一轮"
                value={value.schedule?.intervalMinutes ?? 45}
                min={5}
                max={720}
                onChange={(v) => patchSchedule({ intervalMinutes: v })}
              />
              <NumberField
                label="每天最多轮数"
                hint="0 表示不限"
                value={value.schedule?.maxRounds ?? 0}
                min={0}
                max={99}
                onChange={(v) => patchSchedule({ maxRounds: v })}
              />
            </div>
            <div style={{ marginTop: 8 }}>
              <Button variant="ghost" size="sm" onClick={addWindow}>
                ＋ 添加时间段
              </Button>
            </div>
          </div>
        )}

        {mode === "daily" && (
          <div className="form-grid" style={{ marginTop: 12 }}>
            <TimeField
              label="每天运行时刻"
              value={value.schedule?.time ?? "08:00"}
              onChange={(v) => patchSchedule({ time: v })}
            />
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <SwitchField
            label="随机延迟启动"
            hint="定时触发后先随机等待一段时间再开始，避免每次都卡在固定时刻"
            checked={value.schedule?.randomDelay !== false}
            onChange={(v) => patchSchedule({ randomDelay: v })}
          />
        </div>
        {value.schedule?.randomDelay !== false && (
          <div className="form-grid" style={{ marginTop: 10 }}>
            <NumberField
              label="最短等待（秒）"
              value={value.schedule?.randomDelayMin ?? 20}
              min={0}
              max={3600}
              onChange={(v) => patchSchedule({ randomDelayMin: Math.max(0, v) })}
            />
            <NumberField
              label="最长等待（秒）"
              hint="默认 20 — 300 秒（5 分钟）"
              value={value.schedule?.randomDelayMax ?? 300}
              min={0}
              max={3600}
              onChange={(v) => patchSchedule({ randomDelayMax: Math.max(0, v) })}
            />
          </div>
        )}
      </Section>

      {showLogging && (
        <Section title="日志设置" desc="账户历史日志按天保存，超过保留天数后自动清理">
          <div className="form-grid">
            <NumberField
              label="历史日志保留天数"
              hint="默认 7 天，可设置 1–365 天"
              value={value.logging?.retentionDays ?? 7}
              min={1}
              max={365}
              onChange={(v) => onChange({ logging: { retentionDays: Math.min(365, Math.max(1, v)) } })}
            />
          </div>
        </Section>
      )}

      <Section title="推送通知" desc="留空则不启用该通道">
        <div className="form-grid">
          <TextField
            label="企业微信 Webhook"
            placeholder="https://qyapi.weixin.qq.com/..."
            value={value.notice?.wework ?? ""}
            onChange={(v) => onChange({ notice: { wework: v } })}
          />
          <TextField
            label="钉钉 Webhook"
            placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
            value={value.notice?.dingding ?? ""}
            onChange={(v) => onChange({ notice: { dingding: v } })}
          />
          <TextField
            label="钉钉关键词"
            hint="留空表示未启用"
            placeholder="如 # 或 Rewards"
            value={value.notice?.dingdingKeyword ?? ""}
            onChange={(v) => onChange({ notice: { dingdingKeyword: v } })}
          />
          <TextField
            label="飞书 Webhook"
            placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
            value={value.notice?.feishu ?? ""}
            onChange={(v) => onChange({ notice: { feishu: v } })}
          />
          <TextField
            label="PushMe Key"
            placeholder="push_key"
            value={value.notice?.pushme ?? ""}
            onChange={(v) => onChange({ notice: { pushme: v } })}
          />
          <TextField
            label="Bark Key"
            placeholder="https://api.day.app/XXXX"
            value={value.notice?.bark ?? ""}
            onChange={(v) => onChange({ notice: { bark: v } })}
          />
        </div>
        {onTestPush && (
          <div style={{ marginTop: 12 }}>
            <Button variant="accent" size="sm" onClick={onTest} loading={testing}>
              🔔 测试推送
            </Button>
          </div>
        )}
      </Section>

      <Section
        title="积分目标"
        desc="按总积分设置目标，可控制是否显示在个人详情页"
      >
        <SwitchField
          label="启用积分目标"
          checked={goals.enable !== false}
          onChange={(v) => onChange({ goals: { enable: v } } as DeepPartial<AppConfig>)}
        />

        {goals.enable !== false && (
          <div style={{ marginTop: 10 }}>
            {goals.items.length === 0 && <div className="hint">还没有目标，点下方按钮添加</div>}
            {goals.items.map((g, i) => (
              <div className="goal-row" key={i}>
                <div className="field-block">
                  <span className="field-label">名称</span>
                  <Input
                    size="sm"
                    value={g.name}
                    onChange={(e) => setGoal(i, { name: e.target.value })}
                  />
                </div>
                <div className="field-block">
                  <span className="field-label">比较对象</span>
                  <Select size="sm" value="balance" options={SCOPE_OPTIONS} disabled />
                </div>
                <div className="field-block">
                  <span className="field-label">目标值</span>
                  <InputNumber
                    size="sm"
                    value={g.target}
                    min={1}
                    onChange={(v) => setGoal(i, { target: Number(v) || 0 })}
                  />
                </div>
                <SwitchField
                  label="显示在仪表盘"
                  checked={g.showDashboard !== false}
                  onChange={(v) => setGoal(i, { showDashboard: v })}
                />
                <Button variant="danger" size="sm" onClick={() => delGoal(i)} title="删除此目标">
                  ×
                </Button>
              </div>
            ))}
            <Button variant="ghost" size="sm" onClick={addGoal}>
              ＋ 添加目标
            </Button>
          </div>
        )}
      </Section>
    </div>
  );
}
