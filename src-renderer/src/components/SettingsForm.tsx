import { useState } from "react";
import { GlassButton } from "@ttqtt/liquid-glass-react";
import { Input, InputNumber, Select, SelectOption } from "./liquidGlassCompat";
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

/**
 * 一言的开关 / 位置 / 句子类型常量已迁去 src/views/Personalize.tsx（个性化菜单）。
 * 推送侧只留 hitokotoInPush 一个开关，参见下方「推送通知」Section。
 */

const TASK_LABELS: { key: keyof AppConfig["tasks"]; label: string; hint?: string }[] = [
  { key: "sign", label: "每日签入", hint: "每日打卡签到，获得固定积分奖励" },
  { key: "read", label: "阅读文章", hint: "自动阅读 MSN 文章，每篇 3 分，满额 30 分" },
  { key: "daily", label: "每日活动", hint: "首页每日三格活动，访问活动链接即可完成" },
  { key: "promos", label: "积分活动", hint: "earn 页更多活动，浏览指定网页获取积分" },
  {
    key: "claim",
    label: "定期收取积分",
    // ⚠️ 不要再写死「每周」—— 节奏由下方 claimSchedule 决定（2026-10-06 支持自选）
    hint: "自动点击「领取」按钮，收取待领取的积分；频率在下方设置",
  },
  { key: "search", label: "搜索积分", hint: "自动使用 Bing 搜索，每次 3 分，满额为止" },
];

/**
 * 把用户输入的时间点收口成 "HH:MM"（2026-10-06）。
 *
 * 为什么要收口而不是原样存：`dailyAt` 会被主进程拿去与「今天该点的时间戳」比较，
 * 写成 "9:00am" / "25:00" / "" 这类值要么被正则拒掉（退回 interval）、
 * 要么算出离谱的时间点。渲染层先收口，用户改完立刻看到规范化后的值。
 *
 * 允许 9:00 → 09:00 的补零，但**不静默改时间点本身**（9:30 不会被挪成别的点）。
 */
function normalizeHHMM(input: unknown): string {
  const m = /^(\d{1,2})\s*[:：]\s*(\d{1,2})$/.exec(String(input == null ? "" : input).trim());
  if (!m) return "09:00";
  const hh = Math.min(23, Math.max(0, Number(m[1])));
  const mm = Math.min(59, Math.max(0, Number(m[2])));
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

const CLAIM_MODE_OPTIONS: SelectOption[] = [
  { label: "每隔 N 天（默认 7 天）", value: "interval" },
  { label: "每天定时（到点就跑一次）", value: "daily" },
];

const IP_PROVIDER_OPTIONS: SelectOption[] = [  { label: "Bing 首页判定（默认，与MS Rewards 同源）", value: "bing" },
  { label: "ip.sb（备用，全球 CDN、标准国家码）", value: "ipsb" },
  { label: "太平洋 IP 库（国内）", value: "pconline" },
  { label: "ipinfo.io", value: "ipinfo" },
  { label: "ip-api.com", value: "ipapi" },
  { label: "自动选择（ip.sb 优先，失败自动降级，全挂再用 Bing）", value: "auto" },
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

  // 旧配置可能只有 goals.enable 而无 items（跨版本升级后的历史文件）。`??` 只在 goals
  // 整体缺失时兜底，遇到 { enable: true } 会得到 items === undefined，随后
  // goals.items.length 抛 TypeError → React 卸载整棵树 → 白屏（0.9.4 生产事故）。
  // 这里逐字段兜底，不信任外部数据形状：enable 缺省 true，items 缺省 []。
  const goals = {
    enable: value.goals?.enable !== false,
    items: Array.isArray(value.goals?.items) ? value.goals.items : [],
  };
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
  // 一言三件套（开关 / 位置 / 句子类型）已迁去「个性化」菜单——见 appearance 对象。
  // 这里只留推送侧的 hitokotoInPush 开关；不再从 notice 里读 hitokoto/hitokotoPosition/hitokotoTypes。

  // —— 定期收取积分的节奏（2026-10-06）——
  // ⚠️ 全部经收口后再用：旧配置文件没有 claimSchedule 段，值会是 undefined，
  // 直接进 Number()/正则会得到 NaN → 界面显示空白或 NaN。
  const sched = value.claimSchedule || {};
  const claimMode: "interval" | "daily" = sched.mode === "daily" ? "daily" : "interval";
  const claimEveryDays = Math.min(30, Math.max(1, Math.floor(Number(sched.everyDays)) || 7));
  const claimDailyAt = normalizeHHMM(sched.dailyAt);

  return (
    <div className="settings-form">
      <Section title="任务开关">
        <div className="form-grid">
          {TASK_LABELS.map(({ key, label, hint }) => (
            <SwitchField
              key={key}
              label={label}
              hint={hint}
              checked={!!value.tasks?.[key]}
              onChange={(v) => onChange({ tasks: { [key]: v } } as DeepPartial<AppConfig>)}
            />
          ))}
        </div>

        {/* —— 定期收取积分的节奏（2026-10-06）——
            只在开关打开时显示：关着的时候改频率没有意义（任务压根不会跑），
            摆在那里只会让人以为改了有用。
            ⚠️ 这里的值一律经 Math.min/max + 正则收口 —— 主进程也会再收一次，
               但渲染层先收口能避免用户输「0 天」时界面就显示异常值。 */}
        {value.tasks?.claim && (
          <div className="form-grid" style={{ marginTop: 8 }}>
            <SelectField
              label="收取节奏"
              hint="「每隔 N 天」按上次领取日算差值；「每天定时」到点就跑一次，当天已领过会跳过"
              value={claimMode}
              options={CLAIM_MODE_OPTIONS}
              onChange={(v) => onChange({ claimSchedule: { mode: v } } as DeepPartial<AppConfig>)}
            />
            {claimMode === "interval" ? (
              <NumberField
                label="间隔天数"
                hint="1 ~ 30 天。默认 7 天（与旧行为一致）"
                value={claimEveryDays}
                min={1}
                max={30}
                onChange={(v) =>
                  onChange({
                    claimSchedule: {
                      everyDays: Math.min(30, Math.max(1, Math.floor(v) || 7)),
                    },
                  } as DeepPartial<AppConfig>)
                }
              />
            ) : (
              <TimeField
                label="每天几点"
                hint="本地时区 24 小时制。到点后当天跑一次，当天已领过会自动跳过"
                value={claimDailyAt}
                onChange={(v) =>
                  onChange({
                    claimSchedule: { dailyAt: normalizeHHMM(v) },
                  } as DeepPartial<AppConfig>)
                }
              />
            )}
          </div>
        )}
      </Section>

      <Section title="单次执行数量" desc="把当天的阅读与活动摊到多轮里做，避免一轮全部清空">
        <SwitchField
          label="随机波动"
          hint="在设定数量上随机 ±2–4 个；不会一次做完，也不会少到 0 个（不满足时自动放弃随机）"
          checked={value.limits?.random === true}
          onChange={(v) => onChange({ limits: { random: v } } as DeepPartial<AppConfig>)}
        />
        <SwitchField
          label="允许自定义数量超过剩余任务数"
          hint="开启后阅读会按设定篇数继续尝试；积分活动仅能执行当前实际存在的条目，搜索仍按服务器额度停止。一次性完成模式不受影响。"
          checked={value.limits?.allowExceed === true}
          onChange={(v) => onChange({ limits: { allowExceed: v } } as DeepPartial<AppConfig>)}
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
            label="积分活动每次个数"
            hint="0 = 不限制（一次做完）"
            value={value.limits?.promos ?? 0}
            min={0}
            max={50}
            onChange={(v) => onChange({ limits: { promos: Math.max(0, v) } } as DeepPartial<AppConfig>)}
          />
          <NumberField
            label="搜索每次次数"
            hint="0 = 沿用内置随机节奏（普通 4–7，一次性完成 6–9）"
            value={value.limits?.search ?? 0}
            min={0}
            max={30}
            onChange={(v) => onChange({ limits: { search: Math.max(0, v) } } as DeepPartial<AppConfig>)}
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
        <div className="form-grid" style={{ marginTop: 12 }}>
          <SelectField
            label="IP 归属地查询服务"
            hint="自动模式下 ip.sb 优先，失败依次降级太平洋 / ipinfo / ip-api，全部不可用再用 Bing 判定。锁定国区时无论选哪家都会额外交叉验证 ipsb 境外 GeoIP，防止代理分流规则把检测和任务引导到不同出口"
            value={value.region?.ipProvider ?? "auto"}
            options={IP_PROVIDER_OPTIONS}
            onChange={(v) => onChange({ region: { ipProvider: v as AppConfig["region"]["ipProvider"] } })}
          />
        </div>
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
        <div className="form-grid" style={{ marginTop: 12 }}>
          <TimeField
            label="每天开始时间"
            value={value.schedule?.startTime ?? "09:00"}
            onChange={(v) => patchSchedule({ startTime: v })}
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
                <GlassButton variant="destructive" controlSize="small" onClick={() => delWindow(i)}>
                  删除
                </GlassButton>
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
              <GlassButton variant="plain" controlSize="small" onClick={addWindow}>
                ＋ 添加时间段
              </GlassButton>
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
        <div style={{ marginTop: 10 }} />
        <SwitchField
          label="企业微信 Markdown 排版"
          hint="开启后企业微信推送用 Markdown（标题加粗、字段等宽、列表排版）。如果这条消息会被转发到微信客户端，请关掉 —— 微信不支持 Markdown，会显示成带 ** 和 ` 的裸文本。只影响企业微信，钉钉/飞书不受影响"
          checked={value.notice?.weworkMarkdown !== false}
          onChange={(v) => onChange({ notice: { weworkMarkdown: v } })}
        />
        <SwitchField
          label="推送附加一言"
          hint="开启后，每条推送的末尾会自动追加当天的一句一言作为签名（位置 / 句子类型在「软件设置 → 个性化」里管）。界面显示开关不受影响，已迁去个性化菜单"
          checked={value.notice?.hitokotoInPush !== false}
          onChange={(v) => onChange({ notice: { hitokotoInPush: v } })}
        />
        {onTestPush && (
          <div style={{ marginTop: 12 }}>
            <GlassButton variant="glassProminent" controlSize="small" onClick={onTest} loading={testing}>
              🔔 测试推送
            </GlassButton>
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
                <GlassButton variant="destructive" controlSize="small" onClick={() => delGoal(i)} title="删除此目标">
                  ×
                </GlassButton>
              </div>
            ))}
            <GlassButton variant="plain" controlSize="small" onClick={addGoal}>
              ＋ 添加目标
            </GlassButton>
          </div>
        )}
      </Section>
    </div>
  );
}
