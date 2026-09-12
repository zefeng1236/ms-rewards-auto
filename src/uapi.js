const logger = require("./logger");
const { httpRequest } = require("./http");
const appearance = require("./appearance");

/**
 * UAPI（uapis.cn）接口客户端
 * 文档：https://uapis.cn/docs/api-reference/get-image-bing-daily
 * 鉴权：Authorization: Bearer <KEY>，密钥以 uapi- 开头，
 *       从环境变量 UAPI_KEY 读取；未配置时不带鉴权头（接口允许匿名限流访问）。
 */

const BASE = "https://uapis.cn/api/v1";

function apiKey() {
  return (process.env.UAPI_KEY || "").trim();
}

/** GET 一个 JSON 端点；非 2xx / 限流 / 超时统一抛错，错误信息优先取响应体里的 error 字段 */
async function getJson(pathname, params) {
  const url = BASE + pathname + "?" + new URLSearchParams(params).toString();
  const headers = {};
  const key = apiKey();
  if (key) headers.Authorization = `Bearer ${key}`;

  const r = await httpRequest({ url, method: "GET", headers, timeout: 10000 });
  if (r.error) throw new Error(r.error);
  if (r.status === 429) throw new Error("请求过于频繁（429 限流），请稍后再试或配置 uapi- 密钥");
  if (!r.status || r.status < 200 || r.status >= 300) {
    let msg = `HTTP ${r.status}`;
    try {
      const j = JSON.parse(r.body);
      if (j && j.error) msg = String(j.error);
    } catch {}
    throw new Error(msg);
  }
  try {
    return JSON.parse(r.body);
  } catch {
    throw new Error("响应不是合法 JSON");
  }
}

/**
 * 获取必应每日壁纸（GET /image/bing-daily，format=json）
 * @param {object} [opts]
 * @param {string}  [opts.date]       指定日期 YYYY-MM-DD（与 random 互斥）
 * @param {boolean} [opts.random]     随机返回一张历史壁纸
 * @param {"4k"|"1080"} [opts.resolution] 分辨率，默认走接口默认值 4k
 * @returns {Promise<object>} 扁平元数据：date/title/copyright/image_url/image_url_4k/image_url_1080 等
 */
async function bingDaily(opts = {}) {
  const params = { format: "json" };
  if (opts.resolution !== undefined) {
    if (!["4k", "1080"].includes(opts.resolution)) {
      throw new Error("resolution 只能传 4k 或 1080");
    }
    params.resolution = opts.resolution;
  }
  if (opts.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new Error("date 格式应为 YYYY-MM-DD");
    if (opts.random) throw new Error("date 与 random 不能同时使用");
    params.date = opts.date;
  }
  if (opts.random) params.random = "true";

  const meta = await getJson("/image/bing-daily", params);
  if (!meta || !meta.image_url) throw new Error("必应壁纸获取失败：响应缺少 image_url");
  return meta;
}

/**
 * 解析当天必应壁纸的可直接使用图片地址（按天缓存到 appearance.json，一天只请求一次）。
 * 顺序：UAPI 元数据接口 → 必应官方 HPImageArchive（cn / www）→ 镜像直链兜底。
 * 任何一环失败都不抛出，保证背景总能拿到一个地址。
 */
async function resolveBingDailyUrl() {
  const today = new Date().toISOString().slice(0, 10);
  const cached = appearance.get().bgResolved;
  if (cached && cached.date === today && cached.url) return cached.url;

  let url = "";

  // 1) UAPI：format=json 取元数据。用户要求 4K 分辨率（接口返回 3840x2160 直链）
  try {
    const meta = await bingDaily({ resolution: "4k" });
    url = meta.image_url_4k || meta.image_url || meta.image_url_1080 || "";
    if (url) logger.info(`UAPI 必应壁纸(4K)：${meta.title || meta.date || ""}`);
  } catch (e) {
    logger.warn(`UAPI 必应壁纸获取失败，改用官方源: ${e.message}`);
  }

  // 2) 必应官方 HPImageArchive
  if (!url) {
    for (const host of ["cn.bing.com", "www.bing.com"]) {
      try {
        const r = await httpRequest({
          url: `https://${host}/HPImageArchive.aspx?format=js&idx=0&n=1`,
          timeout: 8000,
        });
        if (r.status === 200) {
          const data = JSON.parse(r.body);
          const img = data && data.images && data.images[0];
          if (img && img.url) {
            url = img.url.startsWith("http") ? img.url : `https://${host}${img.url}`;
            break;
          }
        }
      } catch {} // 换下一个源重试
    }
  }

  // 3) 镜像直链兜底（直接返回图片二进制）
  if (!url) url = "https://api.dujin.org/bing/1920.php";

  try { appearance.set({ bgResolved: { date: today, url } }); } catch {}
  return url;
}

/**
 * UAPI 随机图片地址（GET /random/image）。
 * 接口直接 302 跳转到图床图片，可直接作为 <img>/CSS background 使用，无需鉴权头。
 * 已排除表情包(bq)与竖屏(mb/mobile_wallpaper)：acg 取 pc 横屏，furry 取 4k 横屏。
 * @param {string} category acg|furry|landscape|pc_wallpaper|anime|ai_drawing
 * @returns {string} 可直接加载的接口地址
 */
function randomImageUrl(category) {
  const ALLOWED = ["acg", "furry", "landscape", "pc_wallpaper", "anime", "ai_drawing"];
  const cat = ALLOWED.includes(category) ? category : "acg";
  const params = new URLSearchParams({ category: cat });
  // 仅 UapiPro 服务器分类支持 type；acg→pc（横屏），furry→4k（横屏壁纸）
  if (cat === "acg") params.set("type", "pc");
  else if (cat === "furry") params.set("type", "4k");
  return `${BASE}/random/image?${params.toString()}`;
}

/** 98qy 随机壁纸（302 跳转到横屏图片，实测 1080p/4K） */
function qy98WallpaperUrl() {
  return "https://www.98qy.com/sjbz/api2.php?lx=fengjing";
}

/**
 * Unsplash 随机摄影（官方 API，必须 Access Key；服务端请求，key 不进渲染层）。
 * 文档：https://unsplash.com/documentation#get-a-random-photo
 * @param {string} accessKey Unsplash Access Key（Client-ID）
 * @returns {Promise<string>} 可直接使用的横屏图片地址
 */
async function unsplashRandom(accessKey) {
  const key = String(accessKey || "").trim();
  if (!key) throw new Error("未配置 Unsplash Access Key");
  const url =
    "https://api.unsplash.com/photos/random?orientation=landscape&content_filter=high&w=1920";
  const r = await httpRequest({
    url,
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

module.exports = { bingDaily, resolveBingDailyUrl, randomImageUrl, qy98WallpaperUrl, unsplashRandom, BASE };
