"use strict";

const fs = require("fs");
const sp = require("./storage-path");

/** 接口基址。参数在 buildUrl() 里拼，别在这里写死 —— 句子类型是可配的。 */
const API_URL = "https://v1.hitokoto.cn/";
const CACHE_FILE = sp.resolve("hitokoto.json");
/** 缓存有效期（毫秒）。默认 15 秒换一次随机句。 */
const TTL_MS = 15_000;
let memory = null;

/**
 * 句子类型（接口参数 c）。取自官方文档 https://developer.hitokoto.cn/sentence/
 *
 * 位置同时也是设置页多选的数据源，改动要与 SettingsForm 的 HITOKOTO_TYPE_OPTIONS
 * 保持一致（selfcheck 有跨文件守卫）。
 */
const TYPES = [
  { key: "a", label: "动画" },
  { key: "b", label: "漫画" },
  { key: "c", label: "游戏" },
  { key: "d", label: "文学" },
  { key: "e", label: "原创" },
  { key: "f", label: "来自网络" },
  { key: "g", label: "其他" },
  { key: "h", label: "影视" },
  { key: "i", label: "诗词" },
  { key: "j", label: "网易云" },
  { key: "k", label: "哲学" },
  { key: "l", label: "抖机灵" },
];

/** 空数组 = 不限制类型（官方默认行为，全类型随机） */
const DEFAULT_TYPES = [];

const VALID_KEYS = TYPES.map((t) => t.key);

/**
 * 类型选择归一化：非法项丢弃、去重、按 TYPES 顺序排序。
 *
 * 接受数组或逗号串（配置文件被手改过也能兜住）。返回 [] 表示「不限类型」。
 *
 * @param {unknown} v
 * @returns {string[]}
 */
function normalizeTypes(v) {
  const raw = Array.isArray(v) ? v : String(v == null ? "" : v).split(",");
  const picked = new Set(
    raw
      .map((x) => String(x || "").trim().toLowerCase())
      .filter((x) => VALID_KEYS.includes(x))
  );
  return VALID_KEYS.filter((k) => picked.has(k));
}

/** 缓存区分键：类型不同不能复用同一句，否则切了设置还显示旧类型的句子。 */
function typesKey(types) {
  return normalizeTypes(types).join("");
}

/**
 * 拼接请求地址。
 * @param {unknown} types 句子类型（空 = 不限）
 */
function buildUrl(types) {
  const picked = normalizeTypes(types);
  const params = ["encode=json", "max_length=30"];
  // 官方支持重复传参：?c=a&c=c
  for (const k of picked) params.push(`c=${k}`);
  return `${API_URL}?${params.join("&")}`;
}

function normalize(raw) {
  if (!raw || typeof raw !== "object") return null;
  const text = String(raw.hitokoto || "").trim();
  if (!text) return null;
  return {
    text,
    from: String(raw.from || "").trim(),
    fromWho: String(raw.from_who || "").trim(),
    uuid: String(raw.uuid || "").trim(),
    /** 句子类型字母（接口返回的 type 字段） */
    type: String(raw.type || "").trim(),
    ts: Date.now(),
  };
}

function readCache(key) {
  if (memory && Date.now() - (memory.ts || 0) < TTL_MS && (memory.typesKey || "") === key) return memory;
  // 冷启动从文件恢复（TTL 短，文件主要防止进程刚重启就立刻又请求一次）
  try {
    const cached = normalize(JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")));
    // normalize 会丢掉 typesKey，从原始 JSON 单独取回来比对
    const rawKey = String((JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) || {}).typesKey || "");
    if (cached && rawKey === key && Date.now() - (cached.ts || 0) < TTL_MS) {
      cached.typesKey = rawKey;
      memory = cached;
      return cached;
    }
  } catch {}
  return null;
}

function saveCache(value, key) {
  const stored = { ...value, typesKey: key };
  memory = stored;
  try {
    fs.mkdirSync(sp.storageRoot, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(stored, null, 2), "utf8");
  } catch {}
  return stored;
}

/**
 * 获取一言。15 秒 TTL 缓存，避免频繁请求公益接口（官方 QPS 2）。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force] 跳过缓存重新请求（推送时取新句用）
 * @param {unknown} [opts.types] 句子类型（字母数组；空/缺省 = 不限类型）
 * @returns {Promise<{text:string, from:string, fromWho:string, uuid:string, type:string, ts:number}|null>}
 */
async function get(opts = {}) {
  const key = typesKey(opts.types);
  if (!opts.force) {
    const cached = readCache(key);
    if (cached) return cached;
  }
  try {
    const res = await fetch(buildUrl(opts.types), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return memory || null;
    const value = normalize(await res.json());
    return value ? saveCache(value, key) : memory || null;
  } catch {
    // 接口失败时回落到上一句（不管多旧），好过界面/推送里一句话突然消失
    return memory || null;
  }
}

/**
 * 一言在界面上的显示位置
 *
 *   sidebar     —— 左下角侧边栏，贴在窗口底部（默认）
 *   bottomRight —— 右下角，贴在窗口底部
 *   topbar      —— 窗口原生标题栏（拼在「MS Rewards 自动任务 vX · 」之后）
 *
 * 位置列表同时也是前端下拉框的数据源，改动要与 SettingsForm 保持一致。
 */
const POSITIONS = [
  { key: "sidebar", label: "左下角侧边栏（贴底部）" },
  { key: "bottomRight", label: "右下角（贴底部）" },
  { key: "topbar", label: "标题栏（原生窗口标题栏，任务栏可见）" },
];

/** 界面/推送共用的默认位置 */
const DEFAULT_POSITION = "sidebar";

/** 位置值归一化：非法/缺失回落到默认（左下角侧边栏） */
function normalizePosition(v) {
  const s = String(v || "").trim();
  return POSITIONS.some((p) => p.key === s) ? s : DEFAULT_POSITION;
}

function format(value) {
  const q = value && typeof value === "object" ? value : null;
  if (!q || !q.text) return "";
  const author = q.fromWho || q.from;
  return author ? `${q.text} —— ${author}` : q.text;
}

module.exports = {
  API_URL,
  CACHE_FILE,
  POSITIONS,
  DEFAULT_POSITION,
  TYPES,
  DEFAULT_TYPES,
  get,
  format,
  normalize,
  normalizePosition,
  normalizeTypes,
  buildUrl,
};
