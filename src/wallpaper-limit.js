"use strict";

/**
 * 壁纸请求按来源 IP 限流（滑动窗口）
 *
 * 为什么需要：
 *   第三方壁纸接口（Upx8 / 98qy / Unsplash）都有自己的速率限制，而「定时换壁纸」
 *   会把请求放大成每隔 N 秒一次。一旦某个 webhook/多标签页/多实例同时触发，
 *   单 IP 很容易在一分钟内打出去几十次，轻则被上游限流、重则被封一段时间。
 *
 * 为什么是「按 IP」而不是「全局」：
 *   Docker 版是多人/多浏览器共享一个进程，全局计数会让先来的用户把后来者的
 *   配额耗光；按 IP 计数才能做到「谁超限谁等」，这也是用户明确要的口径。
 *
 * 超限时的行为是**回落**而不是报错：
 *   桌面端：保留上一张已缓存的壁纸（而不是让背景突然消失）；
 *   Web 端 ：返回 429 + 明确文案，前端继续用当前图。
 *   总之不能让「壁纸换不了」升级成「背景挂了」。
 */

/**
 * 每个 IP 每分钟最多允许的请求次数。
 *
 * 定 30 而不是 60（2026-10-03 用户指定）：壁纸是「定时轮换」场景，
 * 30 次/分 已经远超正常轮换频率（最快的合法间隔是 60 秒 → 1 次/分），
 * 留出的余量是给「换一张」手动点击与多标签页并发，不是给刷接口的。
 */
const MAX_PER_MIN = 30;
/** 滑动窗口长度 */
const WINDOW_MS = 60 * 1000;
/** 桌面端 / 本机没有真实来源 IP，统一归一到这个 key */
const LOCAL_KEY = "127.0.0.1";

/** ip -> number[]（毫秒时间戳，升序，只保留窗口内的） */
const hits = new Map();

/** 归一化 IP：去 IPv6 前缀、把本机回环统一成一个 key */
function normalizeIp(ip) {
  let s = String(ip == null ? "" : ip).trim();
  if (!s) return LOCAL_KEY;
  // IPv4-mapped IPv6（::ffff:192.168.1.1）→ IPv4，避免同一台机器算成两个来源
  if (s.startsWith("::ffff:")) s = s.slice(7);
  if (s === "::1" || s.toLowerCase() === "localhost") s = LOCAL_KEY;
  return s.slice(0, 64);
}

/**
 * 从 HTTP 请求里取来源 IP。
 *
 * 自建反向代理（Nginx / Caddy）场景下优先信 X-Forwarded-For 的第一跳；
 * 没有代理头时退回 socket.remoteAddress（直连语义）。
 */
function ipFromRequest(req) {
  if (!req) return LOCAL_KEY;
  const h = req.headers || {};
  const xf = h["x-forwarded-for"] || h["x-real-ip"];
  if (xf) {
    const raw = String(Array.isArray(xf) ? xf[0] : xf);
    const first = raw.split(",")[0];
    if (first && first.trim()) return normalizeIp(first);
  }
  return normalizeIp(req.socket && req.socket.remoteAddress);
}

/** 清理窗口外的历史记录（每次 take 都顺带做，防止无界增长） */
function evict(list, now) {
  while (list.length && now - list[0] >= WINDOW_MS) list.shift();
  // 长期无请求的 IP 直接从 Map 里摘掉，避免 Map 本身无限膨胀
  if (!list.length) return true;
  return false;
}

/**
 * 计入一次请求并判定是否放行。
 *
 * @param {string} ip  来源 IP（桌面端传空即可，会归一到本机 key）
 * @param {number} [now] 时间戳，自检注入用以快进窗口
 * @returns {boolean} true = 放行；false = 本分钟内已超限
 */
function take(ip, now = Date.now()) {
  const key = normalizeIp(ip);
  let list = hits.get(key);
  if (!list) {
    list = [];
    hits.set(key, list);
  }
  evict(list, now);
  if (list.length >= MAX_PER_MIN) return false;
  list.push(now);
  if (hits.size > 512) sweep(now);
  return true;
}

/** 某 IP 在当前窗口内已计入的次数（自检 / 调试用） */
function count(ip, now = Date.now()) {
  const list = hits.get(normalizeIp(ip));
  if (!list) return 0;
  evict(list, now);
  return list.length;
}

/** 清理所有已空转的 key */
function sweep(now = Date.now()) {
  for (const [k, v] of hits) {
    if (evict(v, now)) hits.delete(k);
  }
}

/** 清空全部计数（自检用） */
function reset() {
  hits.clear();
}

/**
 * 桌面端 / 无 IP 场景的统一入口。
 * 命名用 local 而不是直接调 take("")，是为了在日志与自检里一眼看出这是本机来源。
 */
function takeLocal(now = Date.now()) {
  return take(LOCAL_KEY, now);
}

module.exports = {
  MAX_PER_MIN,
  WINDOW_MS,
  LOCAL_KEY,
  normalizeIp,
  ipFromRequest,
  take,
  takeLocal,
  count,
  sweep,
  reset,
};
