import { useMemo, useState } from "react";
import { GlassButton, GlassSegmentedControl, GlassSwitch } from "@ttqtt/liquid-glass-react";
import { AppCard, Input, Modal, toast } from "../components/liquidGlassCompat";
import { CommitSlider } from "../components/CommitSlider";
import { api } from "../api/ipc";
import { useAppState } from "../hooks/useAppState";
import { DisclaimerModal } from "../components/DisclaimerModal";
import { describeCron } from "../utils/cron";
import type { AppearancePreset, BgCategory, BgType, HitokotoPosition } from "../types";

/**
 * 把 cron 的「下次触发时刻」格式成人话（2026-10-08）。
 *
 * 显示「今天 / 明天 / 周几」而不是完整日期 —— cron 的典型用法是「每天几点」，
 * 用户只关心"下一次是几点"，跨年的日期反而是噪音。
 */
function fmtNextRun(d: Date): string {
  const now = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const ss = String(d.getSeconds()).padStart(2, "0");
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  // 6 段（秒级）表达式：只在**秒不为 0** 时补秒。5 段表达式的秒恒为 0，
  // 补了反而让人以为「今天 10:03:00」是精确到秒的触发点。
  const withSec = d.getSeconds() !== 0 ? `${hhmm}:${ss}` : hhmm;
  if (sameDay(d, now)) return `今天 ${withSec}`;
  const t = new Date(now.getTime() + 86400000);
  if (sameDay(d, t)) return `明天 ${withSec}`;
  const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  // 7 天内（多为「每周几」）：只说周几；更远就带上月/日
  const in7 = d.getTime() - now.getTime() <= 7 * 86400000;
  return in7 ? `${week} ${withSec}` : `${d.getMonth() + 1}/${d.getDate()} ${week} ${withSec}`;
}

/**
 * cron 示例表（点「示例」按钮后弹窗展示，行可点击直接填入）。
 *
 * 为什么把示例放进弹窗而不是全塞在输入框下方：完整示例有十几行，
 * 常驻会把设置页撑得很长、干扰其它选项；而cron 语法本身有门槛，
 * 需要时才翻出来对照更合适。
 *
 * ⚠️ 这里的表达式全部经过 `parseCron` 验证可解析（实测），别写错示例 ——
 * 用户点一下就会真的写进配置，一个错示例比没有示例更糟。
 */
const CRON_EXAMPLES: { expr: string; desc: string }[] = [
  // —— 5 段（分 时 日 月 周）——
  { expr: "30 7 * * *", desc: "每天 07:30" },
  { expr: "0 */2 * * *", desc: "每 2 小时整点" },
  { expr: "15 3 * * 1-5", desc: "工作日 03:15" },
  { expr: "0,30 * * * *", desc: "每小时 0 分与 30 分" },
  { expr: "0 8 * * 1", desc: "每周一 08:00" },
  { expr: "0 9 * * 0", desc: "每周日 09:00（7 也表示周日）" },
  { expr: "0 10 1 * *", desc: "每月 1 号 10:00" },
  // —— 步长 / 区间 / 列举——
  { expr: "*/5 * * * *", desc: "每 5 分钟（步长）" },
  { expr: "*/2 8-18 * * *", desc: "8–18 点每 2 小时（步长 + 区间）" },
  { expr: "5/10 * * * *", desc: "5、15、25… 分（基点 + 步长）" },
  { expr: "1-10/2 * * * *", desc: "1、3、5、7、9 分（区间 + 步长）" },
  { expr: "*/2,5 * * * *", desc: "0、2、4、5、6、8… 分（步长 + 列举）" },
  // —— 6 段（秒 分 时 日 月 周），秒在**最前**——
  { expr: "*/10 * * * * *", desc: "每 10 秒（6 段，秒在左端）" },
  { expr: "5 30 7 * * *", desc: "每天 07:30:05（精确到第 5 秒）" },
  { expr: "0 0 9 * * 1-5", desc: "工作日 09:00:00" },
];

/** 外观预设：液态玻璃（半透明面板）/ 不透明（实心面板），均为纯 CSS 热切换 */
const PRESETS: { key: AppearancePreset; label: string; desc: string }[] = [
  { key: "normal", label: "液态玻璃", desc: "默认半透明玻璃面板" },
  { key: "opaque", label: "不透明", desc: "完全实心面板" },
];

const SWATCHES = ["#3b82f6", "#34d399", "#f0b429", "#f85149", "#a855f7", "#ec4899"];

/**
 * 壁纸主分类（一级）→ 壁纸类别（二级分类，选中主分类时展开）。
 * 分类 key 与后端 src/wallpapers.js 的 SOURCES 严格一致（selfcheck 有跨文件守卫）。
 * UAPI 随机图源已移除；upx8 默认请求 4K（3840x2160）。
 */
const BG_SOURCES: { type: BgType; label: string; cats: { key: BgCategory; label: string }[] }[] = [
  {
    type: "upx8",
    label: "Upx8 壁纸",
    cats: [
      { key: "random", label: "随机" },
      { key: "nature", label: "风景" },
      { key: "anime", label: "动漫" },
      { key: "game", label: "游戏" },
      { key: "animal", label: "动物" },
      { key: "city", label: "城市" },
      { key: "abstract", label: "抽象" },
      { key: "space", label: "宇宙" },
      { key: "car", label: "汽车" },
      { key: "girl", label: "美女" },
      { key: "sport", label: "运动" },
    ],
  },
  {
    type: "qy98",
    label: "98qy 壁纸",
    cats: [
      { key: "suiji", label: "随机" },
      { key: "fengjing", label: "风景" },
      { key: "dongman", label: "动漫" },
      { key: "meizi", label: "美图" },
    ],
  },
  {
    type: "unsplash",
    label: "Unsplash 摄影",
    cats: [
      { key: "random", label: "随机" },
      { key: "nature", label: "自然" },
      { key: "animals", label: "动物" },
      { key: "architecture", label: "建筑" },
      { key: "travel", label: "旅行" },
      { key: "city", label: "城市" },
      { key: "ocean", label: "海洋" },
      { key: "space", label: "太空" },
      { key: "food", label: "美食" },
      { key: "flowers", label: "花卉" },
    ],
  },
  {
    type: "pexels",
    label: "Pexels 摄影",
    cats: [
      { key: "random", label: "随机" },
      { key: "nature", label: "自然" },
      { key: "animals", label: "动物" },
      { key: "architecture", label: "建筑" },
      { key: "travel", label: "旅行" },
      { key: "city", label: "城市" },
      { key: "ocean", label: "海洋" },
      { key: "space", label: "太空" },
      { key: "food", label: "美食" },
      { key: "flowers", label: "花卉" },
      { key: "abstract", label: "抽象" },
    ],
  },
];

/** 带二级分类的随机图源主分类 key */
const BG_SOURCE_TYPES: BgType[] = BG_SOURCES.map((s) => s.type);

/**
 * 一言显示位置（界面侧）。
 * ⚠️ label/value 必须与 src/hitokoto.js 的 POSITIONS 保持一致（selfcheck 有跨文件守卫）。
 */
const HITOKOTO_POSITION_OPTIONS = [
  { label: "左下角侧边栏（贴底部）", value: "sidebar" },
  { label: "右下角（贴底部）", value: "bottomRight" },
  { label: "标题栏（原生窗口标题栏，任务栏可见）", value: "topbar" },
];

/**
 * 一言句子类型（接口 c 参数，可多选）。空数组 = 不限类型（全类型随机）。
 * ⚠️ label/value 必须与 src/hitokoto.js 的 TYPES 保持一致（selfcheck 有跨文件守卫）。
 * 数据源：https://developer.hitokoto.cn/sentence/
 */
const HITOKOTO_TYPE_OPTIONS = [
  { label: "动画", value: "a" },
  { label: "漫画", value: "b" },
  { label: "游戏", value: "c" },
  { label: "文学", value: "d" },
  { label: "原创", value: "e" },
  { label: "来自网络", value: "f" },
  { label: "其他", value: "g" },
  { label: "影视", value: "h" },
  { label: "诗词", value: "i" },
  { label: "网易云", value: "j" },
  { label: "哲学", value: "k" },
  { label: "抖机灵", value: "l" },
] as const;

export function Personalize({ bgSrc, onShuffle }: { bgSrc: string; onShuffle?: () => void }) {
  const { appearance, patchAppearance } = useAppState();
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const [pending, setPending] = useState<{ type: BgType; cat?: BgCategory } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  // 随机图源主分类只展开二级分类区、不立刻切源（切源要先过免责声明），
  // 所以它无法从外观设置反推，需要一个临时的分组覆盖值。
  const [groupOverride, setGroupOverride] = useState<string | null>(null);
  // 滑动条拖动草稿：受控值只在 onChangeEnd 提交（避免拖动中高频写盘），
  // 拖动过程中用本地草稿让滑块与数值实时跟手，松手后回落到已提交值。
  const [blurDraft, setBlurDraft] = useState<number | null>(null);
  const [dimDraft, setDimDraft] = useState<number | null>(null);
  const [opacityDraft, setOpacityDraft] = useState<number | null>(null);
  // cron 高级选项（2026-10-08 新增）：默认收起，保持旧界面紧凑。
  // 开关状态不入 appearance.json —— 它只是「这次要不要展开这个输入框」的
  // UI 状态，和外观配置无关（换台机器不该继承「我正开着高级面板」）。
  const [cronAdvanced, setCronAdvanced] = useState(false);
  // 输入框受控副本：跟着配置走（外部改动 / 恢复默认时能同步回来），
  // 但用户正在打字时不回灌，否则光标会跳。
  const [cronDraft, setCronDraft] = useState<string | null>(null);
  const cronText = cronDraft ?? appearance?.bgRotateCron ?? "";
  const cronState = useMemo(() => describeCron(cronText.trim()), [cronText]);
  // cron 示例弹窗（用户点「示例」按钮打开）
  const [cronHelpOpen, setCronHelpOpen] = useState(false);

  // 一言（界面侧）派生值。位置与句子类型都走「白名单过滤」而不是直接用配置值：
  // 配置文件可能被手改，旧版本（迁移前）也可能存着非法值 ——
  // 直接透传会让分段控件的高亮项对不上（界面看着像坏了）。
  const hitokotoPosition: HitokotoPosition = HITOKOTO_POSITION_OPTIONS.some(
    (o) => o.value === appearance?.hitokotoPosition
  )
    ? (appearance!.hitokotoPosition as HitokotoPosition)
    : "sidebar";
  const hitokotoTypes: string[] = Array.isArray(appearance?.hitokotoTypes)
    ? HITOKOTO_TYPE_OPTIONS.filter((o) => appearance!.hitokotoTypes?.includes(o.value)).map((o) => o.value)
    : [];

  if (!appearance) return null;

  const isRandom = BG_SOURCE_TYPES.includes(appearance.bgType);
  // 主界面壁纸分组（流场不属于这里——它是登录页/向导的 authBg）。
  // 带二级分类的 API 源各自独立成组：被选中时展示壁纸类别（二级分类）。
  const derivedGroup =
    appearance.bgType === "none"
      ? "none"
      : appearance.bgType === "bing"
      ? "bing"
      : isRandom
      ? appearance.bgType
      : "custom";
  const bgGroup = groupOverride ?? derivedGroup;

  const onBgGroup = async (v: string) => {
    // 随机图源主分类只展开二级分类区，具体类别点 chip 后经免责声明才真正切换
    if (BG_SOURCE_TYPES.includes(v as BgType)) {
      setGroupOverride(v);
      return;
    }
    setGroupOverride(null);
    if (v === "none") await patchAppearance({ bgType: "none" });
    else if (v === "bing") await patchAppearance({ bgType: "bing" });
    else if (v === "custom") {
      // 进入自定义分组时，根据已有输入决定默认类型；否则默认 URL
      const nextType = appearance.bgFile ? "file" : "url";
      await patchAppearance({ bgType: nextType });
    }
  };

  const onPickSource = (type: BgType, cat: BgCategory) => {
    const already = appearance.bgType === type && appearance.bgCategory === cat;
    if (already) return;
    setPending({ type, cat });
    setDisclaimerOpen(true);
  };

  const onAgreeDisclaimer = async () => {
    if (!pending) return;
    await patchAppearance({
      bgType: pending.type,
      ...(pending.cat ? { bgCategory: pending.cat } : {}),
    });
    setGroupOverride(null); // 选完类别交给 bgType 反推，撤掉临时覆盖
    setDisclaimerOpen(false);
    setPending(null);
    onShuffle?.();
  };

  const onPreset = async (key: AppearancePreset) => {
    await patchAppearance({ preset: key });
  };

  const onTestUrl = async () => {
    const r = await api.testBgUrl(appearance.bgUrl);
    if (r.ok) toast.success(`可以访问${r.contentType ? `（${r.contentType}）` : ""}`);
    else toast.error(r.error || "无法访问该链接");
  };

  const onPickImage = async () => {
    const p = await api.pickImage();
    if (p) await patchAppearance({ bgType: "file", bgFile: p });
  };

  const onDownload = async () => {
    if (!bgSrc) return;
    const r = await api.downloadWallpaper(bgSrc);
    if (r.ok) toast.success(`已保存到 ${r.path}`);
    else if (!r.canceled) toast.error(r.error || "下载失败");
  };

  const onReset = async () => {
    await patchAppearance({
      preset: "normal",
      mode: "system",
      opacity: 1,
      accent: "#3b82f6",
      glow: true,
      bgType: "bing",
      authBg: "flow",
      bgUrl: "",
      bgFile: "",
      bgCategory: "random",
      bgUnsplashKey: "",
      bgPexelsKey: "",
      bgRotate: 0,
      bgRotateCron: "",
      bgBlur: 4,
      bgDim: 0.25,
      glass: false,
      pointerHalo: false,
      autoTheme: false,
    });
    toast.success("已恢复默认外观");
  };

  return (
    <>
      {/* ---- 外观预设 ---- */}
      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">外观预设</div>
            <div className="block-sub">
              液态玻璃与不透明均为纯 CSS 效果，切换即时生效
            </div>
          </div>
        </div>
        <div className="theme-grid">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`theme-card ${appearance.preset === p.key ? "active" : ""}`}
              onClick={() => void onPreset(p.key)}
            >
              <div className="theme-card-name">{p.label}</div>
              <div className="theme-card-desc">{p.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* ---- 主题色 ---- */}
      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">主题色</div>
            <div className="block-sub">强调色实时生效，可点色板快速选择</div>
          </div>
        </div>
        <AppCard padding={16}>
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <label className="range-field">
              <span>主题色</span>
              <input
                type="color"
                value={appearance.accent}
                onChange={(e) => void patchAppearance({ accent: e.target.value })}
                style={{ width: 44, height: 28, border: "none", background: "none", cursor: "pointer" }}
              />
            </label>
            <div className="swatches">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`swatch ${appearance.accent === c ? "active" : ""}`}
                  style={{ background: c }}
                  title={c}
                  onClick={() => void patchAppearance({ accent: c })}
                />
              ))}
            </div>
          </div>
        </AppCard>
      </div>

      {/* ---- 深浅模式（已移除）----
          2026-10-03 用户反馈：浅色主题不生效且观感不佳，改为固定深色。
          原「深浅模式」分段控件（深色/浅色/跟随系统）与「跟随壁纸自动反色」
          开关一并移除 —— 后者会在深浅两套里自动选，留着会破坏「统一深色」。
          解析端同样强制：src-renderer/src/hooks/useTheme.ts 恒定返回 "dark"。
          要恢复时：从 git 历史取回本段 JSX，并把 useTheme 换回按
          mode / autoTheme 解析（对比度选主题的辅助函数仍在 useTheme.ts 里，已导出）。 */}

      {/* ---- 背景图片（主界面壁纸） ---- */}
      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">背景图片</div>
            <div className="block-sub">
              主界面壁纸：必应每日一图、Upx8/98qy/Unsplash 壁纸类别（Upx8 默认 4K）、图片直链/API 或本地图片；开启后表面呈液态玻璃效果
            </div>
          </div>
        </div>

        <GlassSegmentedControl
          value={bgGroup} items={[
            { label: "关闭", value: "none" },
            { label: "Bing 每日", value: "bing" },
            { label: "Upx8 壁纸", value: "upx8" },
            { label: "98qy 壁纸", value: "qy98" },
            { label: "Unsplash", value: "unsplash" },
            { label: "Pexels", value: "pexels" },
            { label: "自定义", value: "custom" },
          ]} onValueChange={onBgGroup}
          aria-label="背景图来源"
        />

        {/* 登录页 / 向导背景：流场粒子动画（默认）或 Bing 每日一图，与主界面壁纸独立 */}
        <div style={{ marginTop: 16 }}>
          <div className="block-sub" style={{ marginBottom: 8 }}>
            登录页 / 初始化向导背景
          </div>
          <GlassSegmentedControl
            value={appearance.authBg === "bing" ? "bing" : "flow"}
            items={[
              { label: "流场动态", value: "flow" },
              { label: "Bing 每日一图", value: "bing" },
            ]}
            onValueChange={(v) => void patchAppearance({ authBg: v === "bing" ? "bing" : "flow" })}
            aria-label="登录页背景"
          />
          <p className="bg-note" style={{ marginTop: 8 }}>
            流场动态是一段内置的粒子动画（Perlin 噪声流场，鼠标划过会搅起尾流），
            纯本地渲染、不联网；只在登录页与向导背后播放，主界面不显示。
          </p>
        </div>

        {/* 主分类被选中时展示壁纸类别（二级分类）：第三方接口，切换前弹免责声明 */}
        {BG_SOURCES.filter((s) => s.type === bgGroup).map((s) => (
          <div key={s.type} style={{ marginTop: 12 }}>
            <div className="bg-chips">
              {s.cats.map((c) => {
                const active = appearance.bgType === s.type && appearance.bgCategory === c.key;
                return (
                  <button
                    key={c.key}
                    type="button"
                    className={`bg-chip ${active ? "active" : ""}`}
                    onClick={() => onPickSource(s.type, c.key)}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>

            {s.type === "unsplash" && (
              <div className="field-block" style={{ marginTop: 12 }}>
                <span className="field-label">
                  Unsplash Access Key（官方 API 必需；也可用环境变量 UNSPLASH_ACCESS_KEY）
                  <a
                    href="https://unsplash.com/oauth/applications"
                    target="_blank"
                    rel="noreferrer"
                    className="field-link"
                  >
                    去官网获取 →
                  </a>
                </span>
                <Input
                  size="sm"
                  type="password"
                  placeholder="粘贴你的 Access Key，应用内仅本地保存"
                  value={appearance.bgUnsplashKey}
                  onChange={(e) => void patchAppearance({ bgUnsplashKey: e.target.value })}
                />
              </div>
            )}

            {s.type === "pexels" && (
              <div className="field-block" style={{ marginTop: 12 }}>
                <span className="field-label">
                  Pexels API Key（官方 API 必需；也可用环境变量 PEXELS_API_KEY）
                  <a
                    href="https://www.pexels.com/api/"
                    target="_blank"
                    rel="noreferrer"
                    className="field-link"
                  >
                    去官网获取 →
                  </a>
                </span>
                <Input
                  size="sm"
                  type="password"
                  placeholder="粘贴你的 API Key，应用内仅本地保存"
                  value={appearance.bgPexelsKey}
                  onChange={(e) => void patchAppearance({ bgPexelsKey: e.target.value })}
                />
                <p className="bg-note" style={{ marginTop: 6 }}>
                  「随机」档走 Pexels 官方精选流（/curated），其余分类按关键词搜索横屏大图。
                  官方限额每小时 200 次、每月 20000 次，超出会回落到必应每日一图。
                </p>
              </div>
            )}
          </div>
        ))}

        {/* 自定义二级 */}
        {bgGroup === "custom" && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <Input
                size="sm"
                placeholder="https://… 图片直链或返回图片的 API"
                value={appearance.bgUrl}
                onChange={(e) => void patchAppearance({ bgUrl: e.target.value, bgType: "url" })}
                style={{ minWidth: 280, flex: 1 }}
              />
              <GlassButton variant="plain" controlSize="small"
                onClick={() => void onTestUrl()}
                disabled={!appearance.bgUrl}
              >
                测试链接
              </GlassButton>
              <GlassButton variant="plain" controlSize="small" onClick={() => void onPickImage()}>
                选择本地图片…
              </GlassButton>
            </div>
            {appearance.bgFile && (
              <div className="hint" style={{ marginTop: 6 }}>
                本地图片：{appearance.bgFile}
              </div>
            )}
          </div>
        )}

        {/* 预览 / 下载 / 轮换 */}
        {bgGroup !== "none" && (
          <div className="bg-ctrl">
            <div className="bg-preview-row">
              <button
                type="button"
                className="bg-thumb"
                style={bgSrc ? { backgroundImage: `url("${bgSrc}")` } : undefined}
                title="点击查看大图"
                onClick={() => setPreviewOpen(true)}
              />
              <div className="bg-preview-info">
                <div className="bg-preview-title">当前壁纸</div>
                <div className="bg-preview-btns">
                  <GlassButton variant="plain" controlSize="small" onClick={() => onShuffle?.()} disabled={!isRandom}>
                    🎲 换一张
                  </GlassButton>
                  <GlassButton variant="plain" controlSize="small"
                    onClick={() => void onDownload()}
                    disabled={!bgSrc}
                  >
                    ⬇ 下载到本地
                  </GlassButton>
                </div>
              </div>
            </div>

            {(bgGroup !== "none" && bgGroup !== "bing") && (
              <div className="range-field" style={{ marginTop: 12 }}>
                <span>自动轮换</span>
                {/* 高级模式开启时，下面的固定秒数输入要让位给 cron —— 两个都填会让人
                    搞不清到底哪个生效，所以直接隐藏并给出说明。 */}
                {!cronAdvanced ? (
                  <>
                    <Input
                      size="sm"
                      type="number"
                      min={0}
                      // step=1 + 正整数：轮换间隔只接受整秒（小数秒对定时器没有意义）
                      step={1}
                      value={String(appearance.bgRotate || 0)}
                      onChange={(e) =>
                        void patchAppearance({
                          bgRotate: Number.isFinite(Number(e.target.value))
                            ? Math.max(0, Math.floor(Math.abs(Number(e.target.value))))
                            : 0,
                        })
                      }
                      style={{ width: 90 }}
                    />
                    <span className="rng-val">秒</span>
                  </>
                ) : null}
                <button
                  type="button"
                  className="bg-chip"
                  style={{ padding: "2px 10px", marginLeft: cronAdvanced ? 0 : 8 }}
                  onClick={() => setCronAdvanced((v) => !v)}
                >
                  {cronAdvanced ? "返回简单模式" : "高级（cron 表达式）"}
                </button>
                <span className="bg-note" style={{ margin: 0 }}>
                  {cronAdvanced
                    ? "填 cron 后以它为准，下面的秒数不再生效。"
                    : "0=不轮换（默认）；须为正整数秒；随机图源最低 60 秒，自定义链接不限；切到后台自动暂停。Bing 每日按天固定，不参与轮换。"}
                </span>
              </div>
            )}

            {/* 高级：cron 表达式（2026-10-08 新增，用户要求） */}
            {cronAdvanced && bgGroup !== "none" && bgGroup !== "bing" && (
              <div className="range-field" style={{ marginTop: 8 }}>
                <span>cron</span>
                <Input
                  size="sm"
                  value={cronText}
                  placeholder="30 7 * * *"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => {
                    const v = e.target.value;
                    setCronDraft(v);
                    // 即时校验并把错误显示在下方；合法才落盘，非法**不写** ——
                    // 边打边存会让「半成品表达式」被保存成"已启用"。
                    const d = describeCron(v.trim());
                    if (v.trim() === "" || d.ok) {
                      void patchAppearance({ bgRotateCron: v.trim() });
                    }
                  }}
                  style={{ width: 160, fontFamily: "Consolas, monospace" }}
                />
                <button
                  type="button"
                  className="bg-chip"
                  style={{ padding: "2px 10px" }}
                  onClick={() => setCronHelpOpen(true)}
                >
                  示例
                </button>
                <span className="bg-note" style={{ margin: 0 }}>
                  <code>分 时 日 月 周</code> 共 5 段（本地时区），例 <code>30 7 * * *</code> 每天 07:30、
                  <code> 15 3 * * 1-5</code> 工作日 03:15。每段都支持 <code>*</code>、
                  <code>1-5</code> 区间、<code>斜杠+数字</code> 步长（<code>*/5</code> 每 5 分钟）、
                  <code>7,14,21</code> 并列。
                  <br />
                  需要精确到秒就用 <code>秒 分 时 日 月 周</code> 共 6 段（秒在<strong>最前面</strong>，
                  如 <code>*/10 * * * * *</code> 每 10 秒）。留空 = 不启用。
                </span>
                <br />
                <a
                  className="cron-help-link"
                  href="https://cron.ciding.cc/"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  在线生成 cron 表达式 →
                </a>
              </div>
            )}

            {/* cron 校验结果 / 下次触发时刻（实时，随输入变化） */}
            {cronAdvanced && bgGroup !== "none" && bgGroup !== "bing" && cronText.trim() !== "" && (
              cronState.ok ? (
                <p className="bg-note" style={{ color: "var(--lg-success)", margin: "4px 0 0" }}>
                  {cronState.next
                    ? `表达式有效 · 下次自动换壁纸：${fmtNextRun(cronState.next)}`
                    : "表达式有效，但未来一年内没有触发时刻（请检查日期组合）"}
                </p>
              ) : (
                <p className="bg-note" style={{ color: "var(--lg-danger)", margin: "4px 0 0" }}>
                  {cronState.error}
                </p>
              )
            )}

            {bgGroup === "random" && (
              <p className="bg-note">
                随机图片均来自第三方公共接口（Upx8 / 98qy / Unsplash），未经人工审核；不满意可「换一张」或切回其他来源。
                <button
                  type="button"
                  className="bg-chip"
                  style={{ marginLeft: 8, padding: "2px 10px" }}
                  onClick={() => setDisclaimerOpen(true)}
                >
                  查看第三方图片声明
                </button>
              </p>
            )}
          </div>
        )}

        {/* 模糊与暗化 */}
        <div className="form-grid" style={{ marginTop: 14 }}>
          <div className="range-field">
            <span>高斯模糊</span>
            <CommitSlider
              min={0}
              max={40}
              step={1}
              value={blurDraft ?? appearance.bgBlur}
              onValueChange={(v) => setBlurDraft(v)}
              onCommit={(v) => {
                setBlurDraft(null);
                void patchAppearance({ bgBlur: v });
              }}
              ariaLabel="背景高斯模糊"
            />
            <span className="rng-val">{blurDraft ?? appearance.bgBlur}px</span>
          </div>
          <div className="range-field">
            <span>背景暗化</span>
            <CommitSlider
              min={0}
              max={85}
              step={5}
              value={dimDraft ?? Math.round(appearance.bgDim * 100)}
              onValueChange={(v) => setDimDraft(v)}
              onCommit={(v) => {
                setDimDraft(null);
                void patchAppearance({ bgDim: v / 100 });
              }}
              ariaLabel="背景暗化"
            />
            <span className="rng-val">{dimDraft ?? Math.round(appearance.bgDim * 100)}%</span>
          </div>
        </div>

        <div className="field-row" style={{ marginTop: 12 }}>
          <div>
            <div>液态玻璃表面</div>
            <div className="hint">
              边缘折射与色散（配合背景图效果最佳，性能开销略高）
            </div>
          </div>
          <GlassSwitch
            checked={appearance.glass}
            onCheckedChange={(v) => void patchAppearance({ glass: v })}
            aria-label="液态玻璃表面"
          />
        </div>

        <div className="field-row" style={{ marginTop: 12 }}>
          <div>
            <div>鼠标指针光晕</div>
            <div className="hint">
              光标划过面板时跟随的一大团柔光（独立于玻璃表面，随时可开关）
            </div>
          </div>
          <GlassSwitch
            checked={appearance.pointerHalo === true}
            onCheckedChange={(v) => void patchAppearance({ pointerHalo: v })}
            aria-label="鼠标指针光晕"
          />
        </div>
      </div>

      {/* ---- 氛围与操作 ---- */}
      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">氛围与操作</div>
          </div>
        </div>
        <AppCard padding={16}>
          <div className="field-row">
            <div>
              <div>背景氛围光</div>
              <div className="hint">两团极淡的辉光，避免大面积纯色发闷</div>
            </div>
            <GlassSwitch
              checked={appearance.glow !== false}
              onCheckedChange={(v) => void patchAppearance({ glow: v })}
              aria-label="背景氛围光"
            />
          </div>
          <div className="field-row">
            <div>
              <div>面板不透明度</div>
              <div className="hint">仅在半透明类预设下有视觉差异</div>
            </div>
            <div className="range-field">
              <CommitSlider
                min={20}
                max={100}
                step={5}
                value={opacityDraft ?? Math.round(appearance.opacity * 100)}
                onValueChange={(v) => setOpacityDraft(v)}
                onCommit={(v) => {
                  setOpacityDraft(null);
                  void patchAppearance({ opacity: v / 100 });
                }}
                ariaLabel="面板不透明度"
              />
              <span className="rng-val">{opacityDraft ?? Math.round(appearance.opacity * 100)}%</span>
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <GlassButton variant="plain" controlSize="small" onClick={() => void onReset()}>
              恢复默认
            </GlassButton>
          </div>
        </AppCard>
      </div>

      {/* ---- 每日一言（界面侧）----
          一言三件套（开关 / 位置 / 句子类型）原本挤在「任务全局设置 → 推送通知」里，
          但「显示位置」本质是外观、且与任务执行无关，放在这里更顺。
          推送是否附加一言是另一件事 —— 那条开关留在推送通知里（notice.hitokotoInPush），
          两者互相独立：可以只关界面、或只关推送。 */}
      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">每日一言</div>
          </div>
        </div>
        <AppCard padding={16}>
          <div className="field-row">
            <div>
              <div>界面上显示一言</div>
              <div className="hint">
                在界面里显示当天的一句一言小字（按天缓存，接口不可用时自动跳过）。
                是否在推送里附加一言是另一条开关，在「任务全局设置 → 推送通知」里。
              </div>
            </div>
            <GlassSwitch
              checked={appearance.hitokoto !== false}
              onCheckedChange={(v) => void patchAppearance({ hitokoto: v })}
              aria-label="界面上显示一言"
            />
          </div>

          {appearance.hitokoto !== false && (
            <>
              <div className="field-row" style={{ marginTop: 12 }}>
                <div>
                  <div>显示位置</div>
                  <div className="hint">
                    「标题栏」会送到窗口原生标题栏（任务栏切换时也可见）。
                    推送里的位置固定在末尾，不受这里影响。
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 8 }}>
                <GlassSegmentedControl
                  value={hitokotoPosition}
                  items={HITOKOTO_POSITION_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
                  onValueChange={(v) =>
                    void patchAppearance({
                      hitokotoPosition: v as HitokotoPosition,
                    })
                  }
                  aria-label="一言显示位置"
                />
              </div>

              <div style={{ marginTop: 14 }}>
                <span className="field-label">句子类型</span>
                <div className="hk-chips">
                  <button
                    type="button"
                    className={`hk-chip${hitokotoTypes.length === 0 ? " active" : ""}`}
                    onClick={() => void patchAppearance({ hitokotoTypes: [] })}
                    title="不限类型，全库随机"
                  >
                    全部（不限）
                  </button>
                  {HITOKOTO_TYPE_OPTIONS.map((o) => {
                    const on = hitokotoTypes.includes(o.value);
                    return (
                      <button
                        key={o.value}
                        type="button"
                        className={`hk-chip${on ? " active" : ""}`}
                        onClick={() =>
                          void patchAppearance({
                            hitokotoTypes: on
                              ? hitokotoTypes.filter((v) => v !== o.value)
                              : // 追加后按 HITOKOTO_TYPE_OPTIONS 的顺序重排，
                                // 免得存进配置的是点击顺序（normalizeTypes 也会再排一次，这里只是让 UI 可预测）
                                HITOKOTO_TYPE_OPTIONS.filter(
                                  (x) => x.value === o.value || hitokotoTypes.includes(x.value)
                                ).map((x) => x.value),
                          })
                        }
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
                <div className="hint" style={{ marginTop: 6 }}>
                  勾选后只从这些类型里取句（多选，点「全部（不限）」回到不限）；
                  改动后 15 秒内换一句新范围的句。
                  数据源：<a href="https://developer.hitokoto.cn/sentence/" target="_blank" rel="noreferrer">一言开发者中心</a>
                </div>
              </div>
            </>
          )}
        </AppCard>
      </div>

      <DisclaimerModal
        open={disclaimerOpen}
        onAgree={() => void onAgreeDisclaimer()}
        onCancel={() => {
          setDisclaimerOpen(false);
          setPending(null);
        }}
      />

      <Modal
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        title="壁纸预览"
        size="lg"
        footer={
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <GlassButton variant="plain" controlSize="small" onClick={() => setPreviewOpen(false)}>
              关闭
            </GlassButton>
          </div>
        }
      >
        {bgSrc ? (
          <img
            src={bgSrc}
            alt="当前壁纸"
            style={{ width: "100%", borderRadius: 12, display: "block" }}
          />
        ) : (
          <div className="hint">当前没有可预览的壁纸</div>
        )}
      </Modal>
    <Modal
        open={cronHelpOpen}
        onOpenChange={setCronHelpOpen}
        title="cron 表达式示例"
        size="lg"
        footer={
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <a
              className="cron-help-link"
              href="https://cron.ciding.cc/"
              target="_blank"
              rel="noreferrer noopener"
            >
              在线生成 cron 表达式 →
            </a>
            <GlassButton variant="plain" controlSize="small" onClick={() => setCronHelpOpen(false)}>
              关闭
            </GlassButton>
          </div>
        }
      >
        <p className="cron-help-tip">
          点击任意一行即可把该表达式填入输入框。<code>*</code> = 全部、
          <code>1-5</code> = 区间、<code>斜杠+数字</code> = 步长、<code>7,14,21</code> = 并列；
          日与周同时指定时是<strong>「或」</strong>关系。6 段的<strong>秒在左端</strong>。
        </p>
        <div className="cron-help-list">
          {CRON_EXAMPLES.map((ex) => (
            <button
              key={ex.expr}
              type="button"
              className="cron-help-row"
              title="点击填入"
              onClick={() => {
                //走与手动输入**完全相同**的路径（校验 → 合法才落盘），
                // 不直接 setState 绕过校验，否则点了个错示例会静默写进配置。
                setCronDraft(ex.expr);
                if (describeCron(ex.expr).ok) {
                  void patchAppearance({ bgRotateCron: ex.expr });
                }
                setCronHelpOpen(false);
              }}
            >
              <code className="cron-help-expr">{ex.expr}</code>
              <span className="cron-help-desc">{ex.desc}</span>
            </button>
          ))}
        </div>
      </Modal>
    </>
  );
}
