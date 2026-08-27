const path = require("path");
const fs = require("fs");

/**
 * 统一的存储目录解析。
 *
 * 开发环境：项目根目录下的 storage/
 * 打包环境：electron-main.js 会在启动最早期把 app.getPath("userData")/storage
 *          写进 process.env.MS_REWARDS_STORAGE_DIR，本模块直接读它。
 *          （安装目录在 Program Files 下没有写权限，不能往那儿写数据）
 *
 * 所有模块（account/config/global-config/state）的 storage 路径都从这里拿，
 * 不要再各自算 __dirname + "../storage"。
 */

const PROJECT_STORAGE = path.join(__dirname, "..", "storage");

/** 每次读都看一遍环境变量，这样 electron-main 晚一点设置也能生效 */
function root() {
  const env = process.env.MS_REWARDS_STORAGE_DIR;
  return env ? path.resolve(env) : PROJECT_STORAGE;
}

/** 懒创建目录，避免 require 时就在磁盘上留痕 */
function ensure() {
  const r = root();
  if (!fs.existsSync(r)) fs.mkdirSync(r, { recursive: true });
  return r;
}

module.exports = {
  get storageRoot() {
    return ensure();
  },
  get accountsDir() {
    return path.join(ensure(), "accounts");
  },
  get globalConfigFile() {
    return path.join(ensure(), "global-config.json");
  },
  get stateFile() {
    return path.join(ensure(), "state.json");
  },
  /** 拼一个 storage 下的子路径 */
  resolve(...sub) {
    return path.join(ensure(), ...sub);
  },
  /** 只读当前根，不创建目录（诊断用） */
  peek() {
    return root();
  },
};
