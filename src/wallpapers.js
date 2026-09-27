const { httpRequest } = require("./http");

/**
 * 第三方壁纸源客户端（upx8 / 98qy / Unsplash）
 *
 * 统一操作模型（0.13.10 起）：主分类（bgType）→ 二级分类（bgCategory）。
 *   - upx8     = 壁纸 API v2.0（wp.upx8.com），302 直链，默认请求 4K 分辨率
 *   - qy98     = 98情缘随机壁纸（www.98qy.com/sjbz），302 直链
 *   - unsplash = Unsplash 官方 API（需 Access Key），返回图片直链
 * UAPI 的随机图源（acg/furry/…）已按用户要求移除，UAPI 只保留必应每日壁纸，
 * 见 ./uapi.js。分类目录（SOURCES）是前端 chips 与 appearance 校验的唯一真源。
 */

/** UAPI 移除随机图源后，本模块是全部随机壁纸来源的唯一入口 */

const Upx8_BASE = "https://wp.upx8.com/api.php";
const QY98_BASE = "https://www.98qy.com/sjbz/api.php";

/**
 * 壁纸源分类目录：主分类 key → { label, categories: [{ key, label }] }。
 * key 即请求参数原值（upx8 的 category / 98qy 的 lx / unsplash 的 query），
 * "random" 是统一的「随机（不限分类）」伪分类：请求时不带分类参数。
 */
const SOURCES = {
  upx8: {
    label: "Upx8 壁纸",
    categories: [
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
  qy98: {
    label: "98qy 壁纸",
    categories: [
      { key: "suiji", label: "随机" },
      { key: "fengjing", label: "风景" },
      { key: "dongman", label: "动漫" },
      { key: "meizi", label: "美图" },
    ],
  },
  unsplash: {
    label: "Unsplash 摄影",
    // unsplash 的分类 key 直接用作官方 API 的 query 关键词
    categories: [
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
};

/** 该主分类下的二级分类 key 列表；无分类的主分类返回 [] */
function categoryKeys(type) {
  const s = SOURCES[type];
  return s ? s.categories.map((c) => c.key) : [];
}

/** 该主分类的默认二级分类 key（列表首个）；无分类的主分类返回 "" */
function defaultCategory(type) {
  const keys = categoryKeys(type);
  return keys.length ? keys[0] : "";
}

/** 二级分类合法性校验：非法/缺失回落到该源默认值；无分类的主分类恒返回 "" */
function normalizeCategory(type, value) {
  const keys = categoryKeys(type);
  if (!keys.length) return "";
  return keys.includes(String(value || "")) ? String(value) : keys[0];
}

/**
 * Upx8 壁纸 API（wp.upx8.com，文档 https://wp.upx8.com/#endpoints）。
 * 302 模式：接口直接跳转到图片，可下载/直用。
 * 用户要求默认请求 4K 分辨率 → resolution=3840x2160（接口支持的最大档）。
 * 说明：birdpaper 数据源返回原图尺寸，resolution 仅作记录；必应兜底源支持缩放。
 * @param {string} [category] 二级分类 key（random/省略 = 不限分类随机）
 * @returns {string} 可直接加载的接口地址
 */
function upx8Url(category) {
  const params = new URLSearchParams({ resolution: "3840x2160" });
  const cat = normalizeCategory("upx8", category);
  if (cat && cat !== "random") params.set("category", cat);
  return `${Upx8_BASE}?${params.toString()}`;
}

/**
 * 98qy 随机壁纸（文档 https://www.98qy.com/sjbz/）。
 * format=images + method=pc（横屏）→ 302 跳转到图片（实测 1080p/4K 原图）。
 * @param {string} [category] 二级分类 key：suiji/fengjing/dongman/meizi
 * @returns {string} 可直接加载的接口地址
 */
function qy98Url(category) {
  const params = new URLSearchParams({ method: "pc", format: "images" });
  const cat = normalizeCategory("qy98", category);
  if (cat) params.set("lx", cat);
  return `${QY98_BASE}?${params.toString()}`;
}

/**
 * Unsplash 随机摄影（官方 API，必须 Access Key；服务端请求，key 不进渲染层）。
 * 文档：https://unsplash.com/documentation#get-a-random-photo
 * 二级分类映射为 query 关键词，横屏 + 高内容安全过滤。
 * @param {string} accessKey Unsplash Access Key（Client-ID）
 * @param {string} [category] 二级分类 key（random/省略 = 不限主题随机）
 * @returns {Promise<string>} 可直接使用的横屏图片地址
 */
async function unsplashRandom(accessKey, category) {
  const key = String(accessKey || "").trim();
  if (!key) throw new Error("未配置 Unsplash Access Key");
  const params = new URLSearchParams({
    orientation: "landscape",
    content_filter: "high",
  });
  const cat = normalizeCategory("unsplash", category);
  if (cat && cat !== "random") params.set("query", cat);
  const r = await httpRequest({
    url: `https://api.unsplash.com/photos/random?${params.toString()}`,
    headers: { Authorization: `Client-ID ${key}` },
    timeout: 12000,
  });
  if (r.status === 401) throw new Error("Unsplash Access Key 无效（401）");
  if (r.status === 403) throw new Error("Unsplash 拒绝请求（403，可能超出每小时速率限制）");
  if (r.error) throw new Error(r.error);
  if (r.status !== 200) {
    let msg = `HTTP ${r.status}`;
    try { const j = JSON.parse(r.body); if (j && j.errors) msg = String(j.errors); } catch {}
    throw new Error(msg);
  }
  const j = JSON.parse(r.body);
  const src = (j.urls && (j.urls.regular || j.urls.full)) || "";
  if (!src) throw new Error("Unsplash 响应缺少图片地址");
  return src;
}

module.exports = {
  SOURCES,
  categoryKeys,
  defaultCategory,
  normalizeCategory,
  upx8Url,
  qy98Url,
  unsplashRandom,
};
