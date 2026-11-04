/**
 * 插件加载器
 *
 * 约定：
 *   plugins/<id>/manifest.json   id / name / version / entry / task / rules
 *   plugins/<id>/index.js        导出 { id, run(ctx, rules, opts) }
 *   plugins/<id>/rules.json      内置兜底规则（远程会覆盖，见 plugin-rules.js）
 *
 * 【为什么用 require 而不是动态 eval】
 * 插件是**随安装包一起分发**的本地代码（打包白名单里），不是从网络拉下来的。
 * 远程只下发规则数据。所以这里 require 本地文件是安全的；一旦允许远程下发
 * 可执行代码，就等于给了对方任意代码执行权限。
 *
 * 【路径约束】
 * id 必须匹配 ^[a-z0-9][a-z0-9-]{1,40}$，且解析后的入口文件必须仍在插件目录内，
 * 防止 `../../etc/passwd` 这类穿越。
 */

const fs = require("fs");
const path = require("path");
const logger = require("./logger");

const PLUGIN_ROOT = path.join(__dirname, "..", "plugins");
const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

const cache = new Map();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 列出磁盘上的插件 id（目录名） */
function listIds() {
  try {
    return fs
      .readdirSync(PLUGIN_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && ID_RE.test(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * 读取并校验一个插件的元信息（不加载代码）。
 * @returns {{ id: string, dir: string, manifest: object, entryPath: string } | null}
 */
function inspect(id) {
  if (!ID_RE.test(String(id || ""))) return null;
  const dir = path.join(PLUGIN_ROOT, id);
  const manifest = readJson(path.join(dir, "manifest.json"));
  if (!manifest || manifest.id !== id) return null;

  const entryPath = path.resolve(dir, manifest.entry || "index.js");
  // 必须仍在插件目录内（防穿越）
  if (!entryPath.startsWith(dir + path.sep)) {
    logger.warn(`[plugin:${id}] 入口路径越界，已拒绝: ${entryPath}`);
    return null;
  }
  if (!fs.existsSync(entryPath)) {
    logger.warn(`[plugin:${id}] 入口文件不存在: ${entryPath}`);
    return null;
  }
  return { id, dir, manifest, entryPath };
}

/**
 * 加载插件（带缓存）。加载失败返回 null，不抛 —— 一个插件坏了不该拖垮整轮任务。
 */
function get(id) {
  if (cache.has(id)) return cache.get(id);
  const info = inspect(id);
  if (!info) {
    cache.set(id, null);
    return null;
  }
  try {
    const mod = require(info.entryPath);
    if (!mod || typeof mod.run !== "function") {
      logger.warn(`[plugin:${id}] 入口没有导出 run()`);
      cache.set(id, null);
      return null;
    }
    const plugin = { ...info, module: mod };
    cache.set(id, plugin);
    return plugin;
  } catch (e) {
    logger.warn(`[plugin:${id}] 加载失败: ${String((e && e.message) || e).slice(0, 120)}`);
    cache.set(id, null);
    return null;
  }
}

/** 所有可用插件 */
function all() {
  return listIds()
    .map((id) => get(id))
    .filter(Boolean);
}

/** 仅用于测试：清空加载缓存 */
function _reset() {
  cache.clear();
}

module.exports = { PLUGIN_ROOT, ID_RE, listIds, inspect, get, all, _reset };
