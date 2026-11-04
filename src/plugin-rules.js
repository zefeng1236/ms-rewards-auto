/**
 * 插件规则热更新
 *
 * 【为什么需要】
 * Rewards 的活动规则每周都在变：新的 punchcard、新的归因码、新的冷却条件。
 * 如果这些都写死在代码里，就得每周发一个版本才能跟上。所以把「点哪些、怎么判」
 * 抽成纯数据规则（plugins/<id>/rules.json），每天从 GitHub 拉一次更新。
 *
 * 【安全边界 —— 这段是硬约束，改动前想清楚】
 * 规则**只能是数据**，绝不能是代码：
 *   ① 远程内容只做 JSON.parse，不 eval、不 require、不 new Function；
 *   ② 只允许覆盖「内置规则里已经存在、且类型相同」的键（白名单深合并），
 *      远程新增任何未知键一律丢弃 —— 否则攻击者可以借规则塞进任意字段；
 *   ③ 选择器做格式约束（必须以 `a[href` 开头且含 {form}），防止被改成
 *      `javascript:` 之类的东西；
 *   ④ 数值做范围校验，避免 renderWaitMs=0 这类值把流程搞成空转。
 * 换句话说：远程能调参数，不能改行为边界。
 *
 * 【网络】
 * 本机直连 raw.githubusercontent.com 经常不可达（项目里早有记录），
 * 所以 manifest 里配了镜像链：raw → jsdelivr → ghproxy，依次尝试，
 * 全失败就用上次缓存；再没有就用内置 rules.json，保证离线也能跑。
 */

const fs = require("fs");
const path = require("path");
const sp = require("./storage-path");
const logger = require("./logger");

const SCHEMA = 1;
const FETCH_TIMEOUT_MS = 8000;

function isObj(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function cacheDir() {
  try {
    const d = sp.resolve("plugin-rules");
    fs.mkdirSync(d, { recursive: true });
    return d;
  } catch {
    return "";
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    return true;
  } catch {
    return false;
  }
}

function ruleCacheFile(id) {
  const d = cacheDir();
  return d ? path.join(d, `${id}.json`) : "";
}

function metaCacheFile(id) {
  const d = cacheDir();
  return d ? path.join(d, `${id}.meta.json`) : "";
}

/** 选择器必须是我们认识的那种形态，别的一律判非法 */
function validSelector(tpl) {
  if (typeof tpl !== "string") return false;
  if (!tpl.includes("{form}")) return false;
  if (!/^a\[href/.test(tpl)) return false;
  if (/javascript:/i.test(tpl)) return false;
  return tpl.length <= 200;
}

function validNumber(n, min, max) {
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
}

function validStringArray(a) {
  return Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === "string" && x.length > 0 && x.length < 200);
}

/**
 * 结构校验。任何一条不过就整体拒收（宁可继续用旧规则，也不要用半份坏规则跑任务）。
 * @returns {{ ok: boolean, reason?: string }}
 */
function validate(r) {
  if (!isObj(r)) return { ok: false, reason: "不是对象" };
  if (r.schema !== SCHEMA) return { ok: false, reason: `schema 不符（期望 ${SCHEMA}）` };
  if (!validNumber(r.version, 1, 1e6)) return { ok: false, reason: "version 非法" };

  if (r.quest !== undefined) {
    if (!isObj(r.quest)) return { ok: false, reason: "quest 段不是对象" };
    if (r.quest.includePrefixes !== undefined && !validStringArray(r.quest.includePrefixes))
      return { ok: false, reason: "quest.includePrefixes 非法" };
    if (r.quest.minRenderChars !== undefined && !validNumber(r.quest.minRenderChars, 50, 5000))
      return { ok: false, reason: "quest.minRenderChars 超出范围" };
    if (r.quest.earnUrl !== undefined && !/^https:\/\/rewards\.bing\.com\//.test(String(r.quest.earnUrl)))
      return { ok: false, reason: "quest.earnUrl 必须是 rewards.bing.com" };
  }

  if (r.card !== undefined) {
    if (!isObj(r.card)) return { ok: false, reason: "card 段不是对象" };
    if (r.card.selectorTemplate !== undefined && !validSelector(r.card.selectorTemplate))
      return { ok: false, reason: "card.selectorTemplate 形态非法" };
    if (r.card.formParam !== undefined && !/^[a-zA-Z]{1,20}$/.test(String(r.card.formParam)))
      return { ok: false, reason: "card.formParam 非法" };
    if (r.card.maxWaitMs !== undefined && !validNumber(r.card.maxWaitMs, 5000, 180000))
      return { ok: false, reason: "card.maxWaitMs 超出范围" };
  }

  if (r.landing !== undefined) {
    if (!isObj(r.landing)) return { ok: false, reason: "landing 段不是对象" };
    if (r.landing.rejectPatterns !== undefined && !Array.isArray(r.landing.rejectPatterns))
      return { ok: false, reason: "landing.rejectPatterns 必须是数组" };
    // 正则片段必须是合法正则，否则会在运行时抛错
    for (const p of r.landing.rejectPatterns || []) {
      try {
        new RegExp(p);
      } catch {
        return { ok: false, reason: `landing.rejectPatterns 含非法正则: ${p}` };
      }
    }
    if (r.landing.dwellMs !== undefined && !validNumber(r.landing.dwellMs, 0, 30000))
      return { ok: false, reason: "landing.dwellMs 超出范围" };
    if (r.landing.dwellRounds !== undefined && !validNumber(r.landing.dwellRounds, 0, 20))
      return { ok: false, reason: "landing.dwellRounds 超出范围" };
  }

  if (r.cooldown !== undefined) {
    if (!isObj(r.cooldown)) return { ok: false, reason: "cooldown 段不是对象" };
    if (r.cooldown.hints !== undefined && !validStringArray(r.cooldown.hints))
      return { ok: false, reason: "cooldown.hints 非法" };
    if (r.cooldown.skipIfNoGain !== undefined && typeof r.cooldown.skipIfNoGain !== "boolean")
      return { ok: false, reason: "cooldown.skipIfNoGain 必须是布尔" };
  }

  if (r.runtime !== undefined) {
    if (!isObj(r.runtime)) return { ok: false, reason: "runtime 段不是对象" };
    if (r.runtime.renderWaitMs !== undefined && !validNumber(r.runtime.renderWaitMs, 5000, 120000))
      return { ok: false, reason: "runtime.renderWaitMs 超出范围" };
    if (r.runtime.maxItemsPerRun !== undefined && !validNumber(r.runtime.maxItemsPerRun, 1, 10))
      return { ok: false, reason: "runtime.maxItemsPerRun 超出范围" };
    if (r.runtime.restartMaxTimes !== undefined && !validNumber(r.runtime.restartMaxTimes, 0, 5))
      return { ok: false, reason: "runtime.restartMaxTimes 超出范围" };
  }

  return { ok: true };
}

/**
 * 白名单深合并：只覆盖 base 里已存在的键，且类型必须一致。
 * 远程多出来的键直接丢弃（这是防注入的关键，不是保守）。
 */
function mergeKnown(base, remote) {
  if (!isObj(base) || !isObj(remote)) return base;
  const out = { ...base };
  for (const k of Object.keys(base)) {
    if (!(k in remote)) continue;
    const b = base[k];
    const r = remote[k];
    if (isObj(b)) {
      out[k] = mergeKnown(b, r);
    } else if (Array.isArray(b)) {
      if (Array.isArray(r)) out[k] = r;
    } else if (typeof b === typeof r) {
      out[k] = r;
    }
  }
  // version / updatedAt 允许远程带更高版本（用于判断是否更新）
  if (typeof remote.version === "number") out.version = remote.version;
  if (typeof remote.updatedAt === "string") out.updatedAt = remote.updatedAt;
  return out;
}

async function fetchOne(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "cache-control": "no-cache" } });
    if (!res.ok) return null;
    const text = await res.text();
    return JSON.parse(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 按镜像链依次尝试，返回 { json, source } */
async function fetchFirst(urls, log) {
  for (const u of urls) {
    const j = await fetchOne(u);
    if (j) return { json: j, source: u };
    if (log) log(`规则源不可达: ${u.slice(0, 80)}`);
  }
  return null;
}

/**
 * 取生效规则。
 * 顺序：当天已更新过的缓存 → 远程（镜像链）→ 上次缓存 → 内置 rules.json
 *
 * @param {{ id: string, dir: string, manifest: object }} plugin
 * @param {{ force?: boolean, log?: Function }} opts
 */
async function ensureRules(plugin, opts = {}) {
  const { force = false, log = null } = opts;
  const spec = (plugin.manifest && plugin.manifest.rules) || {};
  const builtinFile = path.join(plugin.dir, spec.file || "rules.json");
  const builtin = readJson(builtinFile);
  const cached = readJson(ruleCacheFile(plugin.id) || "/nonexistent");
  const meta = readJson(metaCacheFile(plugin.id) || "/nonexistent") || {};

  const fallback = () => ({ rules: cached || builtin || {}, meta, from: cached ? "cache" : "builtin" });

  if (!builtin) {
    logger.warn(`[plugin:${plugin.id}] 内置规则缺失: ${builtinFile}`);
    return fallback();
  }

  const ttl = (Number(spec.ttlHours) || 24) * 3600 * 1000;
  const fresh = meta.fetchedAt && Date.now() - meta.fetchedAt < ttl;
  if (fresh && cached && !force) return { rules: cached, meta, from: "cache" };

  const urls = [spec.remote, ...(spec.mirrors || [])].filter(Boolean);
  if (!urls.length) return fallback();

  const got = await fetchFirst(urls, log);
  if (!got) return fallback();

  const check = validate(got.json);
  if (!check.ok) {
    logger.warn(`[plugin:${plugin.id}] 远程规则被拒收: ${check.reason}`);
    return fallback();
  }

  const merged = mergeKnown(builtin, got.json);
  const m = { id: plugin.id, version: merged.version, fetchedAt: Date.now(), source: got.source };
  writeJson(ruleCacheFile(plugin.id), merged);
  writeJson(metaCacheFile(plugin.id), m);
  if (log) log(`规则已更新到 v${merged.version}（${got.source.includes("jsdelivr") ? "jsdelivr" : "github"}）`);
  return { rules: merged, meta: m, from: "remote" };
}

/** 同步读取当前生效规则（不联网），供不关心更新的调用方使用 */
function getEffectiveRules(plugin) {
  const spec = (plugin.manifest && plugin.manifest.rules) || {};
  return (
    readJson(ruleCacheFile(plugin.id) || "/nonexistent") ||
    readJson(path.join(plugin.dir, spec.file || "rules.json")) ||
    {}
  );
}

module.exports = {
  SCHEMA,
  validate,
  mergeKnown,
  ensureRules,
  getEffectiveRules,
  // 便于守卫断言
  validSelector,
};
