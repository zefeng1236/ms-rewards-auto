/**
 * 拟人化参数（2026-11-17 竞品分析后第一批增强）。
 *
 * 参考同类工具的思路，但**修掉它最明显的设计缺陷**：对方把「今天已成功跑过」
 * 写在全局单文件 logs/last-success.txt，不区分账号，一个批次成功后当天所有
 * 后续运行（含新加账号、改配置重跑、失败补跑）都被 process.exit(0) 跳过。
 * 这里的状态按 accountId 分文件，且只由调用方显式开启，绝不隐式拦截整批任务。
 *
 * 纯函数 + 可注入 now/rand，状态文件路径可注入，便于离线打桩测试。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function todayKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** accountId 可能含邮箱等隐私信息，只取哈希做文件名 */
function accountKey(accountId) {
  return crypto.createHash("sha256").update(String(accountId || "default")).digest("hex").slice(0, 12);
}

function stateFile(dir, accountId) {
  return path.join(dir, `humanize-${accountKey(accountId)}.json`);
}

/** 按账号读「上次成功日期」；文件损坏/不存在一律当作没跑过（fail-open，绝不误跳过） */
function readRunState(dir, accountId) {
  try {
    const raw = fs.readFileSync(stateFile(dir, accountId), "utf8");
    const data = JSON.parse(raw);
    return typeof data?.date === "string" ? data : null;
  } catch {
    return null;
  }
}

function shouldSkipRunToday({ dir, accountId, nowMs = Date.now(), enabled = false }) {
  if (!enabled) return false;
  const state = readRunState(dir, accountId);
  return Boolean(state && state.date === todayKey(nowMs));
}

function markRunSucceeded({ dir, accountId, nowMs = Date.now() }) {
  const file = stateFile(dir, accountId);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ date: todayKey(nowMs), updatedAt: nowMs }) + "\n");
  fs.renameSync(tmp, file); // 原子替换，避免半截 JSON 让下一轮误判
  return file;
}

const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 命中静默时段时，返回还需等待的毫秒数；0 = 不需要等 */
function quietWaitMs(rules, nowMs = Date.now()) {
  if (!Array.isArray(rules) || !rules.length) return 0;
  const now = new Date(nowMs);
  const dayKey = DAY_KEYS[now.getDay()] || "";
  const cur = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  let best = Infinity;
  for (const rule of rules) {
    const applies = (rule?.days || []).some((d) => dayKey === String(d).trim().toLowerCase());
    if (!applies) continue;
    const start = parseHHMM(rule.start);
    const end = parseHHMM(rule.end);
    if (start == null || end == null || start === end) continue;
    let wait = -1;
    if (start < end) {
      if (cur >= start && cur < end) wait = end - cur;
    } else if (cur >= start || cur < end) {
      wait = cur >= start ? 1440 - cur + end : end - cur;
    }
    if (wait > 0) best = Math.min(best, wait);
  }
  return Number.isFinite(best) ? Math.max(Math.round(best * 60000), 1000) : 0;
}

/** 随机目标比例：不让每轮都把额度搜满，range 为 {min,max}，默认 0.85~1.0 */
function randomRatio(range, rand = Math.random) {
  const min = Math.min(Math.max(Number(range?.min ?? 0.85) || 0, 0), 1);
  const maxRaw = Number(range?.max ?? 1);
  const max = Math.min(Math.max(Number.isFinite(maxRaw) ? maxRaw : 1, min), 1);
  return min + rand() * (max - min);
}

/** 随机篇数：闭区间 [min,max]，非法值退回 fallback */
function randomArticleLimit(range, rand = Math.random, fallback = 10) {
  const base = Number(fallback) > 0 ? Math.floor(Number(fallback)) : 10;
  const min = Math.max(1, Math.floor(Number(range?.min) || base));
  const max = Math.max(min, Math.floor(Number(range?.max) || base));
  return min + Math.floor(rand() * (max - min + 1));
}

module.exports = {
  todayKey,
  accountKey,
  stateFile,
  readRunState,
  shouldSkipRunToday,
  markRunSucceeded,
  quietWaitMs,
  randomRatio,
  randomArticleLimit,
};
