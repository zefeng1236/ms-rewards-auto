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

/**
 * 把若干片段拼到 storage 根下，并**校验结果没有逃出根目录**。
 *
 * ⚠️ 为什么必须有这个（2026-10-11 安全中心）：
 *   原先 `resolve(...sub)` 只是 `path.join`，而 path.join 会**正常处理 `..`** ——
 *   `sp.resolve("../../..")` 会安静地返回 storage 的上级目录。
 *   全项目 49 处 `rmSync` 的目标路径都走这里，一个来自界面/接口的 `..`
 *   就能让删除操作落到 storage 之外。这是「路径穿越」，不是理论问题。
 *
 *   判定用 `path.relative` 而不是字符串 `startsWith`：
 *     - 正确处理盘符差异与 Windows 大小写不敏感；
 *     - `relative` 返回以 `..` 开头 = 逃出去了，返回绝对路径 = 跨盘符逃出去了；
 *     - 字符串前缀比较会把 `C:\storage-evil` 误判成在 `C:\storage` 内。
 *
 * @param {...string} sub 相对 storage 根的片段
 * @returns {string} 绝对路径，保证在 storage 根之内
 * @throws {Error} 路径越界时抛出，不返回任何值
 */
function resolveIn(...sub) {
  const r = ensure();
  const target = path.resolve(r, ...sub);
  const rel = path.relative(r, target);
  if (rel === "" ) return target; // 就是根目录本身
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `路径越界：${sub.join("/")} → ${target}（storage 根为 ${r}）`
    );
  }
  return target;
}

/**
 * 判断 target 是否位于 root 之内（不创建任何目录）。
 * 给 account.js 这类「按 id 拼子路径」的场景用 —— 它们的 id 来自接口/界面。
 *
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function isInside(root, target) {
  if (!root || !target) return false;
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === "") return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
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
  /**
   * 拼一个 storage 下的子路径。
   * ⚠️ 越界即抛错，不再是静默返回。改造前确认过全项目没有任何调用传 `..`，
   *    所以收紧不会打破现存代码；今后想访问外部路径请显式用 path.join + isInside 判断。
   */
  resolve(...sub) {
    return resolveIn(...sub);
  },
  /** 显式版：语义更清楚，供新代码用（与 resolve 行为相同） */
  resolveIn,
  isInside,
  /** 只读当前根，不创建目录（诊断用） */
  peek() {
    return root();
  },
};
