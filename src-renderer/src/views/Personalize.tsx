import { useState } from "react";
import { GlassButton, GlassSegmentedControl, GlassSwitch } from "@ttqtt/liquid-glass-react";
import { AppCard, Input, Modal, toast } from "../components/liquidGlassCompat";
import { CommitSlider } from "../components/CommitSlider";
import { api } from "../api/ipc";
import { useAppState } from "../hooks/useAppState";
import { DisclaimerModal } from "../components/DisclaimerModal";
import type { AppearancePreset, BgCategory, BgType } from "../types";

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
                <span className="bg-note" style={{ margin: 0 }}>
                  0=不轮换（默认）；须为正整数秒；随机图源最低 60 秒，自定义链接不限；切到后台自动暂停。
                  Bing 每日按天固定，不参与轮换。
                </span>
              </div>
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
    </>
  );
}
