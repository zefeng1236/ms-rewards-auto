/**
 * 运行时依赖自动补全
 *
 * 打包成 exe 后用户没有 Node 环境，npx playwright install 跑不了。
 * 这里用 Playwright 内部的 programmatic API 直接安装 Chromium：
 *   registry.installBrowsersForNpmInstall(['chromium'])
 *
 * Fallback 链：
 *   1. 检测 Playwright cache 里是否已有可执行文件（isChromiumReady）
 *   2. 调 Playwright 内部 API 下载（最可靠，自带版本匹配）
 *   3. 上面失败 → 查 chocolatey 是否可用，choco install chromium 作为系统 channel
 *      （通过 chromium.launch({ channel: 'chromium' }) 调用系统装的 chromium）
 */

const { spawn, execSync } = require("child_process");
const logger = require("./logger");

let progressCb = null;

/** 设置进度回调（用于 GUI 显示安装进度） */
function onProgress(cb) {
  progressCb = cb;
}

function report(stage, msg) {
  logger.log("依赖", `[${stage}] ${msg}`);
  if (progressCb) progressCb({ stage, message: msg });
}

/**
 * 检查 chocolatey 是否可用
 * @returns {string|null} choco 可执行路径，不可用返回 null
 */
function findChoco() {
  // 常见安装路径
  const candidates = [
    "C:\\ProgramData\\chocolatey\\bin\\choco.exe",
    "C:\\Program Files\\chocolatey\\bin\\choco.exe",
  ];
  for (const p of candidates) {
    try {
      require("fs").accessSync(p, require("fs").X_OK);
      return p;
    } catch {}
  }
  // 试 PATH
  try {
    const out = execSync("where choco 2>nul", { encoding: "utf8", shell: "cmd.exe" });
    const first = out.split(/\r?\n/)[0].trim();
    if (first) return first;
  } catch {}
  return null;
}

/**
 * 查询 chocolatey API 确认 chromium 包存在
 * GET https://community.chocolatey.org/api/v2/Packages()?$filter=Id eq 'chromium'
 */
async function chocoPackageExists(pkgName) {
  try {
    const resp = await fetch(
      `https://community.chocolatey.org/api/v2/Packages()?$filter=Id eq '${pkgName}'&$top=1`,
      { headers: { Accept: "application/json" } }
    );
    if (!resp.ok) return false;
    const data = await resp.json();
    const items = data.d || data.value || data;
    if (!Array.isArray(items) || !items.length) return false;
    return true;
  } catch (e) {
    report("choco", `查询 chocolatey API 失败: ${e.message}`);
    return false;
  }
}

/**
 * 通过 chocolatey 安装 chromium（系统级）
 * 安装后可通过 chromium.launch({ channel: 'chromium' }) 调用
 */
async function installChromiumViaChoco() {
  const choco = findChoco();
  if (!choco) {
    report("choco", "未找到 chocolatey，跳过该 fallback");
    return false;
  }
  report("choco", `使用 chocolatey: ${choco}`);

  const exists = await chocoPackageExists("chromium");
  if (!exists) {
    report("choco", "chocolatey 上未找到 chromium 包");
    return false;
  }
  report("choco", "chocolatey 上确认 chromium 包存在，开始安装（需要管理员权限）");

  // choco install 需要管理员权限，普通用户会弹 UAC
  return new Promise((resolve) => {
    const child = spawn(choco, ["install", "chromium", "-y", "--no-progress"], {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => report("choco", String(d).trim()));
    child.stderr.on("data", (d) => report("choco", String(d).trim()));
    child.on("close", (code) => {
      if (code === 0) {
        report("choco", "chocolatey chromium 安装完成");
        resolve(true);
      } else {
        report("choco", `chocolatey 安装失败 (code=${code})，可能需要管理员权限`);
        resolve(false);
      }
    });
  });
}

/**
 * 主入口：确保 Chromium 就绪
 * @param {object} browser browser.js 模块（用于 isChromiumReady 检测）
 * @returns {Promise<{ready: boolean, method: string, error?: string}>}
 */
async function ensureChromium(browser) {
  // 1. 已经就绪
  if (browser.isChromiumReady()) {
    report("ready", "Chromium 已就绪");
    return { ready: true, method: "cached" };
  }

  // 2. Playwright 内部 API 下载
  report("playwright", "尝试通过 Playwright 内部 API 下载 Chromium（首次约 150MB）");
  try {
    const { registry } = require("playwright-core/lib/coreBundle");
    await registry.installBrowsersForNpmInstall(["chromium"]);
    if (browser.isChromiumReady()) {
      report("playwright", "Chromium 通过 Playwright API 安装完成");
      return { ready: true, method: "playwright" };
    }
    report("playwright", "Playwright API 执行完但 Chromium 仍不可用");
  } catch (e) {
    report("playwright", `Playwright API 失败: ${e.message}`);
  }

  // 3. chocolatey fallback
  report("choco", "尝试 chocolatey fallback");
  const chocoOk = await installChromiumViaChoco();
  if (chocoOk) {
    // 装好后让 Playwright 用系统 chromium channel
    // 注意：browser.js 的 openContext 默认用 Playwright 自带 chromium，
    // 用 channel:'chromium' 需要调用方支持。这里只返回状态，由调用方处理。
    return { ready: true, method: "chocolatey" };
  }

  return { ready: false, method: "none", error: "所有安装方式均失败" };
}

module.exports = {
  onProgress,
  ensureChromium,
  findChoco,
  chocoPackageExists,
};
