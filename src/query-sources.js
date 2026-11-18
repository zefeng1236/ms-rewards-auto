/**
 * 搜索词池（2026-11-17 竞品分析后第一批增强）。
 *
 * 旧实现：单一热榜接口 + 10 个固定兜底词，接口一挂就反复用同一批词，
 * 搜索行为高度重复。这里改成：多源降级 → 归一化去重 → 本地词库兜底 →
 * 轮转取词 + 轻度变体，让「连续多轮搜索」的词面不再像脚本。
 *
 * 纯函数 + 可注入随机数，不联网、不读写磁盘，便于离线打桩测试。
 */
"use strict";

/** 本地兜底主题：接口全挂时仍有一批不重复的真人话题，不再只有 10 个固定词 */
const LOCAL_TOPICS = [
  "今日天气", "本周新闻", "城市地铁线路", "家常菜做法", "手机摄影技巧", "睡眠质量改善",
  "春季旅行路线", "博物馆开放时间", "公共交通攻略", "家庭健身计划", "咖啡豆产地", "桌面整理技巧",
  "电子书推荐", "本地图书馆", "自行车保养", "绿植养护", "早餐搭配", "跑步装备选择",
  "垃圾分类指南", "老照片修复", "城市步行路线", "传统手工艺", "夜间摄影", "家庭急救常识",
  "二手书市集", "社区活动", "季节养生", "家电节能", "文具测评", "地图导航技巧",
  "纪录片推荐", "街边小吃", "雨天出行", "书房收纳", "宠物日常", "城市夜景",
  "手工烘焙", "短途徒步", "科普读物", "旧物改造", "周末安排", "阳台种菜",
];

/** 归一化：去 HTML 标签、空白、常见首尾标点，限制长度，过滤无意义短串 */
function normalizeTopic(raw) {
  if (raw == null) return "";
  let s = String(raw)
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:amp|quot|#39|lt|gt|nbsp);/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/^[【】\[\]（）()"'“”‘’,，。.!！?？:：;；\-\s]+/, "")
       .replace(/[【】\[\]（）()"'“”‘’,，。.!！?？:：;；\-\s]+$/, "");
  if (s.length < 2 || s.length > 60) return "";
  // 纯数字/纯符号不是搜索词
  if (!/[\p{L}\p{N}]/u.test(s) || /^\d+$/.test(s)) return "";
  return s.slice(0, 60);
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const t = normalizeTopic(item);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function shuffle(list, rand = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 轻度变体：给热词加一个真人常见的前缀/后缀，避免每次搜同一串 */
const PREFIXES = ["", "", "", "怎么", "什么是", "最新"];
const SUFFIXES = ["", "", "", " 介绍", " 攻略", " 推荐"];
function makeVariant(topic, rand = Math.random) {
  const t = normalizeTopic(topic);
  if (!t) return "";
  const pre = PREFIXES[Math.floor(rand() * PREFIXES.length)];
  const suf = SUFFIXES[Math.floor(rand() * SUFFIXES.length)];
  // 只在短词上加前缀，长标题保持原样（更像人直接搜新闻标题）
  const body = t.length > 18 ? t : `${pre}${t}`;
  return `${body}${suf}`.trim();
}

function createCache() {
  return { pool: [], index: 0, seen: new Set(), sources: [] };
}

/** 把一个热榜源的标题加入词池；返回新增条数 */
function addSource(cache, titles, rand = Math.random) {
  const before = cache.pool.length;
  const fresh = dedupe(titles).filter((t) => !cache.seen.has(t.toLowerCase()));
  for (const t of fresh) cache.seen.add(t.toLowerCase());
  cache.pool.push(...shuffle(fresh, rand));
  return cache.pool.length - before;
}

function hasPool(cache) {
  return Boolean(cache && cache.pool && cache.pool.length);
}

/** 轮转取词：优先用热榜池，用完/为空则落本地词库；同一批词不会连续重复 */
function nextQuery(cache, rand = Math.random) {
  if (!cache) cache = createCache();
  if (!hasPool(cache)) {
    const local = shuffle(LOCAL_TOPICS, rand);
    cache.pool.push(...local);
    for (const t of local) cache.seen.add(t.toLowerCase());
  }
  const topic = cache.pool[cache.index % cache.pool.length];
  cache.index = (cache.index + 1) % cache.pool.length;
  // 池子转完一圈就重新洗牌，避免周期性重复
  if (cache.index === 0 && cache.pool.length > 1) {
    cache.pool = shuffle(cache.pool, rand);
  }
  return makeVariant(topic, rand);
}

module.exports = {
  LOCAL_TOPICS,
  normalizeTopic,
  dedupe,
  shuffle,
  makeVariant,
  createCache,
  addSource,
  hasPool,
  nextQuery,
};
