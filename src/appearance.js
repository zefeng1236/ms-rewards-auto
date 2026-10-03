const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const sp = require("./storage-path");
const wallpapers = require("./wallpapers");

/**
 * 应用外观设置（appearance.json）
 *
 * 跟账户业务配置分开存：外观是「这台机器上这个用户的偏好」，
 * 跟账户无关，也不该被账户的「遵循全局设置」开关影响。
 *
 * 预设只保留两档：液态玻璃（CSS 级半透明面板）与不透明（实心面板），
 * 全部纯 CSS 热切换，无需重启窗口。
 */

const FILE = sp.resolve("appearance.json");

/** 两套外观预设，均为纯 CSS 效果，可热切换 */
const PRESETS = {
  normal: { label: "液态玻璃", needsRestart: false },
  opaque: { label: "不透明",   needsRestart: false },
};

const DEFAULTS = {
  preset: "normal",
  // 深浅模式：dark | light | system。
  // 默认深色：液态玻璃的折射/高光/白字在深色下对比度与观感最好，也是本应用的视觉核心。
  mode: "dark",
  // 窗口/面板不透明度，0.20–1.00。仅在半透明类预设下有视觉差异
  opacity: 1,
  // 主题色（custom 预设下生效，其余预设也会用它作为强调色）
  accent: "#3b82f6",
  // 背景氛围光开关
  glow: true,
  // 自定义背景（主界面软件壁纸），主分类（一级）：
  //   none | bing（必应每日一图）| upx8（壁纸 API v2.0，配 bgCategory）
  //   | qy98（98qy 壁纸，配 bgCategory）| unsplash（Unsplash 摄影，配 bgCategory）
  //   | url（图片直链/API）| file（本地图片）
  // 两级结构：主分类被选中时展示其壁纸类别（二级分类 bgCategory）。
  // UAPI 的随机壁纸来源已按用户要求移除，UAPI 只保留必应每日壁纸。
  // 默认必应每日一图：主界面壁纸氛围，随日期自动更新。
  // 注意：流场粒子动画不在这里——它只用于登录页/向导背景，见下方 authBg。
  bgType: "bing",
  // 登录页 / 初始化向导的背景（与主界面 bgType 相互独立）：
  //   flow = 内置 Canvas 流场粒子动画（默认）；bing = 必应每日一图
  authBg: "flow",
  bgUrl: "",
  bgFile: "",
  // 壁纸二级分类（仅 upx8/qy98/unsplash 三个主分类生效），按主分类分源校验，
  // 取值见 wallpapers.SOURCES；"random" = 不限分类随机。
  bgCategory: "random",
  // Unsplash 官方 API Access Key（也可用环境变量 UNSPLASH_ACCESS_KEY）
  bgUnsplashKey: "",
  // 背景自动轮换间隔（秒）。0=不启用；随机图源最低 60s，自定义链接不受此限
  bgRotate: 0,
  // 背景高斯模糊像素（0–40）与暗化比例（0–0.85）
  bgBlur: 4,
  bgDim: 0.25,
  // 液态玻璃表面开关：边缘折射 + 色散 + 跟着指针走的细边高光。
  // 默认开启：这是本应用的视觉核心特征，关掉后退回普通毛玻璃。
  glass: true,
  // 鼠标指针光晕开关：光标划过面板时跟随的一团柔光。默认开启，
  // 独立开关（与 glass 解耦；玻璃 fallback 面板同样带 .lg-surface，关玻璃也可见）。
  pointerHalo: true,
  // 跟随壁纸自动反色：渲染端模拟深/浅两套主题色与壁纸合成后的文字对比度，
  // 自动选对比度更高的一套（亮壁纸倾向深色主题白字，暗壁纸倾向浅色主题黑字）。
  // 开启后优先级高于上面的 mode；壁纸亮度取不到时退回 mode。
  autoTheme: false,
  // bing 每日图解析缓存 { date: "YYYY-MM-DD", url }，一天只请求一次
  bgResolved: null,
};

// 主界面壁纸白名单。0.13.1 曾把 "flow" 放进来当全局默认，用户纠正：
// 流场只属于登录页/向导背景（authBg），主界面不渲染 → 已移除。
// 0.13.10 移除 UAPI 随机图（uapi），新增 upx8（壁纸 API v2.0）。
// 旧配置里存了 flow/uapi 的会被规范化拒绝、回退到默认值，无需迁移脚本。
const BG_TYPES = ["none", "bing", "upx8", "qy98", "unsplash", "url", "file"];

/** 登录页/向导背景白名单 */
const AUTH_BG_TYPES = ["flow", "bing"];

/** 壁纸二级分类表（主分类 → key 列表），唯一真源在 wallpapers.SOURCES */
const BG_CATEGORIES = Object.fromEntries(
  Object.entries(wallpapers.SOURCES).map(([type, s]) => [type, s.categories.map((c) => c.key)])
);

/** 全部二级分类 key 的并集（无分类主分类切换时的合法性兜底） */
const ALL_CATEGORY_KEYS = [...new Set(Object.values(BG_CATEGORIES).flat())];

function clampOpacity(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0.2, n));
}

function normalizeHex(v, fallback) {
  const s = String(v || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : fallback;
}

function clampBlur(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULTS.bgBlur;
  return Math.min(40, Math.max(0, Math.round(n)));
}
function clampDim(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULTS.bgDim;
  return Math.min(0.85, Math.max(0, n));
}
/**
 * 归一化「背景自动轮换间隔（秒）」。
 *
 * 三条硬约束（2026-10-03 用户指定）：
 *   ① 0 = 关闭自动轮换（默认值，不启用）
 *   ② 启用时必须是**正整数** —— 不接受小数（12.5 秒没有意义，
 *      定时器精度也不保证），不接受负数
 *   ③ 上限 86400（24 小时），避免填出一个永远等不到的间隔
 *
 * 非法输入（小数 / 负数 / 非数字 / 空串）统一回落到 0（关闭）而不是保留旧值：
 * 「用户填了个看不懂的数」比「静默沿用上次的值」安全，且 UI 上能看到变回 0。
 */
function clampRotate(v) {
  const n = Number(v);
  // 空串 Number("") === 0，单独拦掉：用户清空输入框应该是「关闭」而不是意外 0（也是关闭，但语义要明确）
  if (v === "" || v === null || v === undefined) return 0;
  if (!Number.isFinite(n) || n < 0) return 0;
  const int = Math.floor(n);
  if (int <= 0) return 0;
  return Math.min(86400, int);
}

/**
 * 二级分类合法性校验（按主分类分源）：
 *   - upx8/qy98/unsplash：取值必须在该源分类表内，非法回落该源默认（列表首个）
 *   - 其余主分类（none/bing/url/file）无二级分类：保留已知 key（切源不丢选择），
 *     未知值回落 DEFAULTS.bgCategory
 */
function normalizeBgCategory(bgType, v) {
  const s = String(v || "");
  const perType = BG_CATEGORIES[bgType];
  if (perType) return perType.includes(s) ? s : wallpapers.defaultCategory(bgType);
  return ALL_CATEGORY_KEYS.includes(s) ? s : DEFAULTS.bgCategory;
}

/** 本地图片路径转 file:// URL，非路径（已是 URL）原样返回 */
function toFileUrl(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  if (/^(file|https?):/i.test(s)) return s;
  try { return pathToFileURL(s).href; } catch { return ""; }
}

/** 内置默认壁纸路径：打包后取 resources 下经 extraResources 释放的文件，
 *  开发时回落项目 build/default-wallpaper.jpg。 */
function defaultWallpaperPath() {
  const { app } = require("electron");
  if (app && app.isPackaged) {
    return path.join(process.resourcesPath, "default-wallpaper.jpg");
  }
  // 开发环境 / 非 Electron 上下文（selfcheck）
  return path.join(__dirname, "..", "build", "default-wallpaper.jpg");
}

/** 读取并规范化。文件损坏时退回默认值，不抛错 */
function get() {
  let raw = {};
  try {
    if (fs.existsSync(FILE)) raw = JSON.parse(fs.readFileSync(FILE, "utf8")) || {};
  } catch {
    raw = {};
  }
  const resolved = raw.bgResolved && typeof raw.bgResolved === "object" ? raw.bgResolved : null;
  const bgType = BG_TYPES.includes(raw.bgType) ? raw.bgType : DEFAULTS.bgType;
  const authBg = AUTH_BG_TYPES.includes(raw.authBg) ? raw.authBg : DEFAULTS.authBg;
  // bgType 为 file 但未指定文件时，自动指向内置默认壁纸
  let bgFile = String(raw.bgFile || "").trim();
  if (bgType === "file" && !bgFile) {
    bgFile = defaultWallpaperPath();
  }
  return {
    preset: PRESETS[raw.preset] ? raw.preset : DEFAULTS.preset,
    mode: ["dark", "light", "system"].includes(raw.mode) ? raw.mode : DEFAULTS.mode,
    opacity: clampOpacity(raw.opacity === undefined ? DEFAULTS.opacity : raw.opacity),
    accent: normalizeHex(raw.accent, DEFAULTS.accent),
    glow: raw.glow !== false,
    bgType,
    authBg,
    bgUrl: String(raw.bgUrl || "").trim(),
    bgFile,
    bgCategory: normalizeBgCategory(bgType, raw.bgCategory === undefined ? DEFAULTS.bgCategory : raw.bgCategory),
    bgUnsplashKey: String(raw.bgUnsplashKey || "").trim(),
    bgRotate: clampRotate(raw.bgRotate === undefined ? DEFAULTS.bgRotate : raw.bgRotate),
    bgBlur: clampBlur(raw.bgBlur === undefined ? DEFAULTS.bgBlur : raw.bgBlur),
    bgDim: clampDim(raw.bgDim === undefined ? DEFAULTS.bgDim : raw.bgDim),
    glass: raw.glass !== false,
    pointerHalo: raw.pointerHalo !== false,
    autoTheme: raw.autoTheme === true,
    bgResolved:
      resolved && typeof resolved.url === "string" && typeof resolved.date === "string"
        ? { date: resolved.date, url: resolved.url }
        : null,
  };
}

/** 增量保存，返回规范化后的完整值 */
function set(patch) {
  const cur = get();
  const next = { ...cur, ...(patch || {}) };
  const out = {
    preset: PRESETS[next.preset] ? next.preset : cur.preset,
    mode: ["dark", "light", "system"].includes(next.mode) ? next.mode : cur.mode,
    opacity: clampOpacity(next.opacity),
    accent: normalizeHex(next.accent, cur.accent),
    glow: next.glow !== false,
    bgType: BG_TYPES.includes(next.bgType) ? next.bgType : cur.bgType,
    authBg: AUTH_BG_TYPES.includes(next.authBg) ? next.authBg : cur.authBg,
    bgUrl: String(next.bgUrl || "").trim(),
    // bgType=file 但未指定文件时，自动指向内置默认壁纸
    bgFile:
      BG_TYPES.includes(next.bgType) && next.bgType === "file" && !String(next.bgFile || "").trim()
        ? defaultWallpaperPath()
        : String(next.bgFile || "").trim(),
    bgCategory: normalizeBgCategory(
      BG_TYPES.includes(next.bgType) ? next.bgType : cur.bgType,
      next.bgCategory === undefined ? cur.bgCategory : next.bgCategory
    ),
    bgUnsplashKey: String(next.bgUnsplashKey || "").trim(),
    bgRotate: clampRotate(next.bgRotate),
    bgBlur: clampBlur(next.bgBlur),
    bgDim: clampDim(next.bgDim),
    glass: next.glass === true,
    pointerHalo: next.pointerHalo === true,
    autoTheme: next.autoTheme === true,
    // 缓存只在 date/url 都齐全时保留
    bgResolved:
      next.bgResolved && next.bgResolved.date && next.bgResolved.url
        ? { date: next.bgResolved.date, url: next.bgResolved.url }
        : null,
  };
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2), "utf8");
  return out;
}

/** 该预设是否需要重启窗口才能生效（当前所有预设均为纯 CSS，恒 false） */
function needsRestart(preset) {
  return !!(PRESETS[preset] && PRESETS[preset].needsRestart);
}

/** 当前背景类型对应的可直接用于 CSS background-image 的地址 */
function backgroundSrc() {
  const cfg = get();
  if (cfg.bgType === "url") return cfg.bgUrl;
  if (cfg.bgType === "file") return toFileUrl(cfg.bgFile);
  // bing 的实际图片地址由主进程解析（见 electron-main 的 appearance:bg-src）
  return "";
}

module.exports = {
  get, set, needsRestart, backgroundSrc, defaultWallpaperPath,
  PRESETS, DEFAULTS, BG_TYPES, AUTH_BG_TYPES, BG_CATEGORIES, ALL_CATEGORY_KEYS, FILE,
};
