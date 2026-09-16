const fs = require("fs");
const sp = require("./storage-path");
const logger = require("./logger");

/**
 * 首次启动向导状态（setup.json）
 *
 * 跟外观、启动设置一样属于「这台机器上这个用户的偏好」，落在 storage 根目录
 * （打包后即 userData/storage 下）。只用于判断要不要弹向导，以及记录用户在
 * 向导里的初始选择，跟账户、推送、积分这些业务数据完全无关。
 *
 * 字段：
 *   done        向导是否已完成。true 后不再弹（除非文件被删/换机器）
 *   lang        界面语言。当前仅 zh-CN 可用，其余语种尚未开发
 *   agreed      是否已勾选「已阅读并同意」协议
 *   liquidGlass 初始是否启用液态玻璃效果
 *   autoLaunch  初始是否开机自启（由主进程同步到系统登录项）
 */

const FILE = sp.resolve("setup.json");

/** 支持的语言列表（只有 zh-CN 已开发，其余仅占位展示） */
const LANGS = ["zh-CN", "zh-TW", "en", "ru", "ja"];

/** 已开发完成、可真正切换的语言 */
const READY_LANGS = ["zh-CN"];

const DEFAULTS = {
  done: false,
  lang: "zh-CN",
  agreed: false,
  liquidGlass: true,
  autoLaunch: false,
};

function normLang(v) {
  const s = String(v == null ? "" : v);
  return LANGS.indexOf(s) >= 0 ? s : DEFAULTS.lang;
}

/**
 * 升级兼容迁移：0.8.6 之前的版本没有 setup.json，但保险库（0.8.7+）可能已经
 * 建好。这类老用户覆盖安装后 done 为 false，首次启动向导会把他们重新拉进
 * 「创建保险库」页，而那里点创建只会得到「保险库已配置，请勿重复设置」，
 * 用户会被卡死在向导里。
 *
 * 检测到 vault.json 存在即视为向导早已走完，立即补写 done=true 并落盘，
 * 老用户随后直接进保险库锁屏（configured && !unlocked 的正常分支）。
 * 注意：这里不能调 set()（set 内部会再调 get，造成递归），直接写文件。
 */
function migrateUpgradedVaultUser(out) {
  let vaultConfigured = false;
  try {
    vaultConfigured = fs.existsSync(sp.resolve("vault.json"));
  } catch {
    vaultConfigured = false;
  }
  if (!vaultConfigured) return out;
  const migrated = { ...out, done: true, agreed: true };
  try {
    fs.writeFileSync(FILE, JSON.stringify(migrated, null, 2), "utf8");
    logger.ok("检测到已配置的保险库，自动完成首次启动向导（升级兼容）");
  } catch (e) {
    logger.warn(`补写向导完成状态失败: ${e.message}`);
  }
  return migrated;
}

/** 读取并规范化。文件损坏时退回默认值，不抛错 */
function get() {
  let raw = {};
  try {
    if (fs.existsSync(FILE)) raw = JSON.parse(fs.readFileSync(FILE, "utf8")) || {};
  } catch {
    raw = {};
  }
  const out = {
    done: raw.done === true,
    lang: normLang(raw.lang),
    agreed: raw.agreed === true,
    liquidGlass: raw.liquidGlass !== false,
    autoLaunch: raw.autoLaunch === true,
  };
  if (!out.done) return migrateUpgradedVaultUser(out);
  return out;
}

/** 增量保存，返回规范化后的完整值 */
function set(patch) {
  const cur = get();
  const merged = { ...cur, ...(patch || {}) };
  const out = {
    done: merged.done === true,
    lang: normLang(merged.lang),
    agreed: merged.agreed === true,
    liquidGlass: merged.liquidGlass !== false,
    autoLaunch: merged.autoLaunch === true,
  };
  try {
    fs.writeFileSync(FILE, JSON.stringify(out, null, 2), "utf8");
  } catch (e) {
    logger.warn(`保存向导状态失败: ${e.message}`);
  }
  return out;
}

module.exports = { get, set, DEFAULTS, LANGS, READY_LANGS, FILE };
