import { useState } from "react";
import { GlassButton, GlassSegmentedControl, GlassSwitch } from "@ttqtt/liquid-glass-react";
import { AppCard, Input, Modal, toast } from "../components/liquidGlassCompat";
import { CommitSlider } from "../components/CommitSlider";
import { api } from "../api/ipc";
import { useAppState } from "../hooks/useAppState";
import { DisclaimerModal } from "../components/DisclaimerModal";
import type { AppearancePreset, BgCategory, BgType, ThemeMode } from "../types";

/** 外观预设：液态玻璃（半透明面板）/ 不透明（实心面板），均为纯 CSS 热切换 */
const PRESETS: { key: AppearancePreset; label: string; desc: string }[] = [
  { key: "normal", label: "液态玻璃", desc: "默认半透明玻璃面板" },
  { key: "opaque", label: "不透明", desc: "完全实心面板" },
];

const SWATCHES = ["#3b82f6", "#34d399", "#f0b429", "#f85149", "#a855f7", "#ec4899"];

/** 随机图源（已排除表情包与竖屏） */
const RANDOM_SOURCES: { type: BgType; cat?: BgCategory; label: string }[] = [
  { type: "uapi", cat: "acg", label: "ACG 动漫 · 横屏" },
  { type: "uapi", cat: "furry", label: "福瑞 · 横屏" },
  { type: "uapi", cat: "landscape", label: "风景" },
  { type: "uapi", cat: "pc_wallpaper", label: "电脑壁纸" },
  { type: "uapi", cat: "anime", label: "混合动漫" },
  { type: "uapi", cat: "ai_drawing", label: "AI 绘画" },
  { type: "qy98", label: "98qy 随机壁纸" },
  { type: "unsplash", label: "Unsplash 摄影" },
];

export function Personalize({ bgSrc, onShuffle }: { bgSrc: string; onShuffle?: () => void }) {
  const { appearance, patchAppearance } = useAppState();
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const [pending, setPending] = useState<{ type: BgType; cat?: BgCategory } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  // 「随机美图」只展开二级区、不立刻切源（选源要先过免责声明），
  // 所以它无法从外观设置反推，需要一个临时的分组覆盖值。
  const [groupOverride, setGroupOverride] = useState<string | null>(null);
  // 滑动条拖动草稿：受控值只在 onChangeEnd 提交（避免拖动中高频写盘），
  // 拖动过程中用本地草稿让滑块与数值实时跟手，松手后回落到已提交值。
  const [blurDraft, setBlurDraft] = useState<number | null>(null);
  const [dimDraft, setDimDraft] = useState<number | null>(null);
  const [opacityDraft, setOpacityDraft] = useState<number | null>(null);

  if (!appearance) return null;

  const isRandom = ["uapi", "qy98", "unsplash"].includes(appearance.bgType);
  const derivedGroup =
    appearance.bgType === "none"
      ? "none"
      : appearance.bgType === "bing"
      ? "bing"
      : appearance.bgType === "flow"
      ? "flow"
      : isRandom
      ? "random"
      : "custom";
  const bgGroup = groupOverride ?? derivedGroup;

  const onBgGroup = async (v: string) => {
    // 随机美图只展开二级区，具体图源点 chip 后经免责声明才真正切换
    if (v === "random") {
      setGroupOverride("random");
      return;
    }
    setGroupOverride(null);
    if (v === "none") await patchAppearance({ bgType: "none" });
    else if (v === "bing") await patchAppearance({ bgType: "bing" });
    else if (v === "flow") await patchAppearance({ bgType: "flow" });
    else if (v === "custom") {
      // 进入自定义分组时，根据已有输入决定默认类型；否则默认 URL
      const nextType = appearance.bgFile ? "file" : "url";
      await patchAppearance({ bgType: nextType });
    }
  };

  const onPickSource = (type: BgType, cat?: BgCategory) => {
    const already = appearance.bgType === type && (type !== "uapi" || appearance.bgCategory === cat);
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
    setGroupOverride(null); // 选完源交给 bgType 反推，撤掉临时覆盖
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
      bgType: "flow",
      bgUrl: "",
      bgFile: "",
      bgCategory: "acg",
      bgUnsplashKey: "",
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

      {/* ---- 深浅模式 ---- */}
      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">深浅模式</div>
            <div className="block-sub">跟随系统会随操作系统外观自动切换</div>
          </div>
        </div>
        <GlassSegmentedControl
          value={appearance.mode} items={[
            { label: "深色", value: "dark" },
            { label: "浅色", value: "light" },
            { label: "跟随系统", value: "system" },
          ]} onValueChange={(v) => void patchAppearance({ mode: v as ThemeMode })}
          aria-label="深浅模式"
        />
        <div className="field-row" style={{ marginTop: 12 }}>
          <div>
            <div>跟随壁纸自动反色</div>
            <div className="hint">
              按壁纸与两套主题色合成后的文字对比度自动选深/浅主题，花色壁纸也能保证文字清晰
            </div>
          </div>
          <GlassSwitch
            checked={appearance.autoTheme === true}
            onCheckedChange={(v) => void patchAppearance({ autoTheme: v })}
            aria-label="跟随壁纸自动反色"
          />
        </div>
      </div>

      {/* ---- 背景图片 ---- */}
      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">背景图片</div>
            <div className="block-sub">
              支持内置流场粒子动画、必应每日一图、图片直链/API 或本地图片；开启后表面呈液态玻璃效果
            </div>
          </div>
        </div>

        <GlassSegmentedControl
          value={bgGroup} items={[
            { label: "关闭", value: "none" },
            { label: "流场动态", value: "flow" },
            { label: "Bing 每日一图", value: "bing" },
            { label: "随机美图", value: "random" },
            { label: "自定义", value: "custom" },
          ]} onValueChange={onBgGroup}
          aria-label="背景图来源"
        />

        {/* 流场：纯本地粒子动画，零网络请求 */}
        {bgGroup === "flow" && (
          <p className="bg-note" style={{ marginTop: 12 }}>
            流场动态是一段内置的粒子动画（Perlin 噪声流场，鼠标划过会搅起尾流），
            纯本地渲染、不联网、也不消费显卡纹理。切到流场时界面会固定为深色主题，保证文字可读。
          </p>
        )}

        {/* 随机美图二级：第三方接口，切换前弹免责声明 */}
        {bgGroup === "random" && (
          <div style={{ marginTop: 12 }}>
            <div className="bg-chips">
              {RANDOM_SOURCES.map((s) => {
                const active =
                  appearance.bgType === s.type &&
                  (s.type !== "uapi" || appearance.bgCategory === s.cat);
                return (
                  <button
                    key={`${s.type}-${s.cat || ""}`}
                    type="button"
                    className={`bg-chip ${active ? "active" : ""}`}
                    onClick={() => onPickSource(s.type, s.cat)}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>

            {appearance.bgType === "unsplash" && (
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
          </div>
        )}

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

        {/* 预览 / 下载 / 轮换（流场是本地动画、无图片地址，不显示这组） */}
        {bgGroup !== "none" && bgGroup !== "flow" && (
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

            {(bgGroup === "random" || bgGroup === "custom") && (
              <div className="range-field" style={{ marginTop: 12 }}>
                <span>自动轮换</span>
                <Input
                  size="sm"
                  type="number"
                  min={0}
                  step={10}
                  value={String(appearance.bgRotate || 0)}
                  onChange={(e) =>
                    void patchAppearance({ bgRotate: Math.max(0, Number(e.target.value) || 0) })
                  }
                  style={{ width: 90 }}
                />
                <span className="rng-val">秒</span>
                <span className="bg-note" style={{ margin: 0 }}>
                  0=不轮换；随机图源最低 60 秒，自定义链接不限
                </span>
              </div>
            )}

            {bgGroup === "random" && (
              <p className="bg-note">
                随机图片均来自第三方公共接口（UAPI / 98qy / Unsplash），未经人工审核；不满意可「换一张」或切回其他来源。
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
