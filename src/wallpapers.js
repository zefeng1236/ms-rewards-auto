const { httpRequest } = require("./http");

/**
 * 第三方壁纸源客户端（upx8 / 98qy / Unsplash / Pexels）
 *
 * 统一操作模型（0.13.10 起）：主分类（bgType）→ 二级分类（bgCategory）。
 *   - upx8     = 壁纸 API v2.0（wp.upx8.com），302 直链，默认请求 4K 分辨率
 *   - qy98     = 98情缘随机壁纸（www.98qy.com/sjbz），302 直链
 *   - unsplash = Unsplash 官方 API（需 Access Key），返回图片直链
 *   - pexels   = Pexels 官方 API（需 API Key），返回图片直链，随机档走 /v1/curated
 * UAPI 的随机图源（acg/furry/…）已按用户要求移除，UAPI 只保留必应每日壁纸，
 * 见 ./uapi.js。分类目录（SOURCES）是前端 chips 与 appearance 校验的唯一真源。
 */

/** UAPI 移除随机图源后，本模块是全部随机壁纸来源的唯一入口 */

const Upx8_BASE = "https://wp.upx8.com/api.php";
const QY98_BASE = "https://www.98qy.com/sjbz/api.php";
const PEXELS_BASE = "https://api.pexels.com/v1";

/**
 * 壁纸源分类目录：主分类 key → { label, categories: [{ key, label }] }。
 * key 即请求参数原值（upx8 的 category / 98qy 的 lx / unsplash 的 query /
 * pexels 的 query），"random" 是统一的「随机（不限分类）」伪分类：请求时不带分类参数。
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
  pexels: {
    label: "Pexels 摄影",
    // pexels 的分类 key 直接用作 /v1/search 的 query 关键词
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
      { key: "abstract", label: "抽象" },
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
 *
 * ⚠️ 实测（0.13.10 服务器验证）：参数名与取值都是文档认可的（6 档分辨率之一），
 * **但上游 birdpaper 数据源返回图片原始尺寸，`resolution` 对其仅作记录、不做强制缩放**
 * —— 所以实拉常见 1920x1080，这不是我们的 bug。文档原文：
 *   「birdpaper 数据源返回图片原始尺寸，resolution 参数对其仅作记录，不做强制缩放。
 *     必应数据源支持指定分辨率，但部分图片不含 4K 版本。」
 * 即：4K 请求已按用户要求发出，能否真拿到 4K 取决于上游当次命中的数据源与图库。
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

/**
 * Pexels 随机摄影（官方 API，必须 API Key；服务端请求，key 不进渲染层）。
 * 文档：https://www.pexels.com/api/documentation/#photos-search
 *
 * 与 Unsplash 的两处结构性差异（踩过就记住）：
 *  1. **「随机」必须走 /v1/curated**，不能用 /v1/search —— search 强制要求 query，
 *     缺 query 直接 400。所以 random 分类下换端点，其余分类用 search + query=分类key。
 *  2. 返回的是 **photos 数组**（搜索/精选都是），不是单张对象；
 *     横屏图用 src.large（1200px 宽，正是壁纸常用档），src.original 常是 4K+ 巨图。
 *
 * 鉴权头是 `Authorization: <KEY>`，**不带 Bearer 前缀**（与 Unsplash 的
 * `Client-ID <KEY>` 不同，照抄会 401）。
 * 限额每小时 200 次 / 每月 20000 次，比 Unsplash 紧，所以失败时回落到 bing 兜底。
 * @param {string} apiKey Pexels API Key
 * @param {string} [category] 二级分类 key（random/省略 = 走 curated 精选流）
 * @returns {Promise<string>} 可直接使用的横屏图片地址
 */
async function pexelsRandom(apiKey, category) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("未配置 Pexels API Key");
  const cat = normalizeCategory("pexels", category);
  const isRandom = !cat || cat === "random";
  // 壁纸一律横屏：curated 端点不支持 orientation 参数，只能多取一些自己挑横图
  const params = new URLSearchParams({ per_page: isRandom ? "20" : "1" });
  let url;
  if (isRandom) {
    url = `${PEXELS_BASE}/curated?${params.toString()}`;
  } else {
    params.set("query", cat);
    params.set("orientation", "landscape");
    params.set("size", "large");
    url = `${PEXELS_BASE}/search?${params.toString()}`;
  }
  const r = await httpRequest({
    url,
    headers: { Authorization: key },
    timeout: 12000,
  });
  if (r.status === 401) throw new Error("Pexels API Key 无效（401）");
  if (r.status === 403) throw new Error("Pexels 拒绝请求（403）");
  if (r.status === 429) throw new Error("Pexels 超出速率限制（每小时 200 次）");
  if (r.error) throw new Error(r.error);
  if (r.status !== 200) {
    let msg = `HTTP ${r.status}`;
    try { const j = JSON.parse(r.body); if (j && j.error) msg = String(j.error); } catch {}
    throw new Error(msg);
  }
  const j = JSON.parse(r.body);
  const photos = Array.isArray(j.photos) ? j.photos : [];
  if (!photos.length) throw new Error("Pexels 未返回图片（该分类可能无结果）");
  // curated 混排竖图，壁纸用横屏更合适：优先 src.large，退 src.original
  const pick =
    photos.find((p) => p && p.src && p.src.large && p.width >= p.height) ||
    photos.find((p) => p && p.src && (p.src.large || p.src.original));
  if (!pick) throw new Error("Pexels 响应缺少图片地址");
  return pick.src.large || pick.src.original;
}

module.exports = {
  SOURCES,
  categoryKeys,
  defaultCategory,
  normalizeCategory,
  upx8Url,
  qy98Url,
  unsplashRandom,
  pexelsRandom,
};
