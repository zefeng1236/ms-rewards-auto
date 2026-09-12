const fs = require("fs");
const sp = require("./storage-path");
const logger = require("./logger");

/**
 * 启动与托盘设置（launch.json）
 *
 * 跟外观（appearance.json）、账户业务配置分开存：这是「这台机器上这个用户
 * 的启动偏好」，跟具体账户无关。文件落在 storage 根目录（打包后即在
 * userData/storage 下，见 storage-path.js）。
 *
 * 字段：
 *   autoLaunch     是否注册到系统登录项（开机自启动）
 *   launchToTray   开机自启后是否驻留托盘（不弹主窗口，后台静默运行）
 *   launchDelay    开机自启延迟（秒），仅 autoLaunch 生效，用于错峰启动
 *   minimizeToTray 关闭主窗口时是否最小化到托盘（而非退出）
 */

const FILE = sp.resolve("launch.json");

const DEFAULTS = {
  autoLaunch: false,
  launchToTray: false,
  launchDelay: 10,
  minimizeToTray: true,
};

function clampDelay(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULTS.launchDelay;
  return Math.min(600, Math.max(0, Math.round(n)));
}

/** 读取并规范化。文件损坏时退回默认值，不抛错 */
function get() {
  let raw = {};
  try {
    if (fs.existsSync(FILE)) raw = JSON.parse(fs.readFileSync(FILE, "utf8")) || {};
  } catch {
    raw = {};
  }
  return {
    autoLaunch: raw.autoLaunch === true,
    launchToTray: raw.launchToTray === true,
    launchDelay: clampDelay(raw.launchDelay === undefined ? DEFAULTS.launchDelay : raw.launchDelay),
    minimizeToTray: raw.minimizeToTray !== false,
  };
}

/** 增量保存，返回规范化后的完整值 */
function set(patch) {
  const cur = get();
  const merged = { ...cur, ...(patch || {}) };
  const out = {
    autoLaunch: merged.autoLaunch === true,
    launchToTray: merged.launchToTray === true,
    launchDelay: clampDelay(merged.launchDelay),
    minimizeToTray: merged.minimizeToTray !== false,
  };
  try {
    fs.writeFileSync(FILE, JSON.stringify(out, null, 2), "utf8");
  } catch (e) {
    logger.warn(`保存启动设置失败: ${e.message}`);
  }
  return out;
}

/**
 * 把设置同步到系统登录项（开机自启）。
 *
 * - autoLaunch 关：移除登录项。
 * - autoLaunch 开：注册登录项；launchToTray 时一并请求「以隐藏方式启动」。
 *   Windows 上 openAsHidden 不生效，改用 --hidden 启动参数，由主进程识别后驻留托盘。
 *
 * 仅在打包后写入 path/args，避免开发模式下注册出无法正确加载项目的登录项。
 */
function syncLoginItems(app, cfg) {
  try {
    if (!cfg.autoLaunch) {
      app.setLoginItemSettings({ openAtLogin: false });
      return;
    }
    const settings = { openAtLogin: true, openAsHidden: cfg.launchToTray };
    if (app.isPackaged) {
      settings.path = process.execPath;
      settings.args = cfg.launchToTray ? ["--hidden"] : [];
    }
    app.setLoginItemSettings(settings);
  } catch (e) {
    logger.warn(`设置开机自启失败: ${e.message}`);
  }
}

module.exports = { get, set, syncLoginItems, DEFAULTS, FILE };
