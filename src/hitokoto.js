"use strict";

const fs = require("fs");
const sp = require("./storage-path");

const API_URL = "https://v1.hitokoto.cn/?encode=json&max_length=30";
const CACHE_FILE = sp.resolve("hitokoto.json");
/** 缓存有效期（毫秒）。默认 15 秒换一次随机句。 */
const TTL_MS = 15_000;
let memory = null;

function normalize(raw) {
  if (!raw || typeof raw !== "object") return null;
  const text = String(raw.hitokoto || "").trim();
  if (!text) return null;
  return {
    text,
    from: String(raw.from || "").trim(),
    fromWho: String(raw.from_who || "").trim(),
    uuid: String(raw.uuid || "").trim(),
    ts: Date.now(),
  };
}

function readCache() {
  if (memory && Date.now() - (memory.ts || 0) < TTL_MS) return memory;
  // 冷启动从文件恢复（TTL 短，文件主要防止进程刚重启就立刻又请求一次）
  try {
    const cached = normalize(JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")));
    if (cached && Date.now() - (cached.ts || 0) < TTL_MS) {
      memory = cached;
      return cached;
    }
  } catch {}
  return null;
}

function saveCache(value) {
  memory = value;
  try {
    fs.mkdirSync(sp.storageRoot, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(value, null, 2), "utf8");
  } catch {}
  return value;
}

/**
 * 获取一言。30 秒 TTL 缓存，避免频繁请求公益接口（官方 QPS 2）。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force] 跳过缓存重新请求（推送时取新句用）
 * @returns {Promise<{text:string, from:string, fromWho:string, uuid:string, ts:number}|null>}
 */
async function get(opts = {}) {
  if (!opts.force) {
    const cached = readCache();
    if (cached) return cached;
  }
  try {
    const res = await fetch(API_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return memory || null;
    const value = normalize(await res.json());
    return value ? saveCache(value) : memory || null;
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
 *   topbar      —— 标题栏（压缩成一行的小字）
 *
 * 位置列表同时也是前端下拉框的数据源，改动要与 SoftwareSettingsView 保持一致。
 */
const POSITIONS = [
  { key: "sidebar", label: "左下角侧边栏（贴底部）" },
  { key: "bottomRight", label: "右下角（贴底部）" },
  { key: "topbar", label: "标题栏（一行）" },
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
  get,
  format,
  normalize,
  normalizePosition,
};
