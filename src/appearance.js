const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const sp = require("./storage-path");

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
  // 自定义背景：none | bing（必应每日一图）| url（图片直链/API）| file（本地图片）
  //           | uapi（UAPI 随机图，配 bgCategory）| qy98（98qy 随机壁纸）| unsplash
  // 默认必应每日一图：首次启动即有壁纸氛围，且随日期自动更新，无需用户手动找图。
  bgType: "bing",
  bgUrl: "",
  bgFile: "",
  // UAPI 随机图分类（仅 bgType=uapi 时生效）：acg/furry/landscape/pc_wallpaper/anime/ai_drawing
  bgCategory: "acg",
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

const BG_TYPES = ["none", "bing", "url", "file", "uapi", "qy98", "unsplash"];

/** UAPI 随机图可用分类（已排除表情包 bq 与竖屏 mb/mobile_wallpaper） */
const BG_CATEGORIES = ["acg", "furry", "landscape", "pc_wallpaper", "anime", "ai_drawing"];

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
function clampRotate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return DEFAULTS.bgRotate;
  return Math.min(86400, Math.round(n));
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
    bgUrl: String(raw.bgUrl || "").trim(),
    bgFile,
    bgCategory: BG_CATEGORIES.includes(raw.bgCategory) ? raw.bgCategory : DEFAULTS.bgCategory,
    bgUnsplashKey: String(raw.bgUnsplashKey || "").trim(),
    bgRotate: clampRotate(raw.bgRotate === undefined ? DEFAULTS.bgRotate : raw.bgRotate),
    bgBlur: clampBlur(raw.bgBlur === undefined ? DEFAULTS.bgBlur : raw.bgBlur),
    bgDim: clampDim(raw.bgDim === undefined ? DEFAULTS.bgDim : raw.bgDim),
    glass: raw.glass === true,
    pointerHalo: raw.pointerHalo === true,
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
    bgUrl: String(next.bgUrl || "").trim(),
    // bgType=file 但未指定文件时，自动指向内置默认壁纸
    bgFile:
      BG_TYPES.includes(next.bgType) && next.bgType === "file" && !String(next.bgFile || "").trim()
        ? defaultWallpaperPath()
        : String(next.bgFile || "").trim(),
    bgCategory: BG_CATEGORIES.includes(next.bgCategory) ? next.bgCategory : cur.bgCategory,
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

module.exports = { get, set, needsRestart, backgroundSrc, defaultWallpaperPath, PRESETS, DEFAULTS, BG_TYPES, BG_CATEGORIES, FILE };
