/**
 * 运行时依赖自动补全
 *
 * 打包成 exe 后用户没有 Node 环境，npx playwright install 跑不了。
 * 这里用 Playwright 内部的 programmatic API 直接安装 Chromium：
 *   registry.installBrowsersForNpmInstall(['chromium'])
 *
 * Fallback 链：
 *   1. 检测 Playwright cache 里是否已有可执行文件（isChromiumReady）
 *   2. 调 Playwright 内部 API 下载（最可靠，自带版本匹配）。默认用 npmmirror 镜像，
 *      失败/超时回落官方源（PLAYWRIGHT_DOWNLOAD_HOST 清空），再失败才报 choco。
 *   3. 上面失败 → 查 chocolatey 是否可用，choco install chromium 作为系统 channel
 *      （通过 chromium.launch({ channel: 'chromium' }) 调用系统装的 chromium）
 *
 * 编码说明：
 *   所有 spawn/execSync 都通过 chcp 65001 强制子进程输出 UTF-8，
 *   避免中文 Windows 默认 GBK 编码导致日志乱码。
 *
 * 进度来源：
 *   Playwright 库内部下载走子进程并自带 progress bar，但**不对外暴露 progress 回调**。
 *   我们在外部 spin 一个 poll loop，每秒 stat 临时目录里最新的 zip，按已写字节
 *   估算百分比与速度（用 descriptor.dir 下的 EXPECTED_SIZE 反推总大小）。
 *   日志端按 ≥2s 或 ≥5% 才输出一行，避免刷屏；按钮端（progressCb）拿到稳定增量。
 */

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const logger = require("./logger");

const IS_WIN = process.platform === "win32";
const UTF8_CP = IS_WIN ? "chcp 65001 >nul && " : "";

/** npmmirror 提供的 playwright 镜像（许多内网/限速用户必备） */
const NPMMIRROR_HOST = "https://cdn.npmmirror.com/binaries/playwright";
/** Playwright 官方默认镜像 base */
const OFFICIAL_HOST_DEFAULT = "https://cdn.playwright.dev/dbazure/download/playwright";

let progressCb = null;

/** 设置进度回调（用于 GUI 显示安装进度）
 *  payload: { stage, message?, pct?, speed?, eta?, loaded?, total? } */
function onProgress(cb) {
  progressCb = cb;
}

function report(stage, msg, extra) {
  logger.log("依赖", `[${stage}] ${msg}`);
  if (progressCb) progressCb({ stage, message: msg, ...(extra || {}) });
}

/**
 * 查询 Chromium 在 npmmirror 的 HEAD 信息，给进度条当"总大小"用。
 * 失败不影响下载，只是 progress 失去 total。
 */
async function probeChromiumHeadOk(mirrorBase) {
  try {
    // browsers.json 被 playwright-core/package.json 的 exports 屏蔽，require 直接走 fs。
    const fs2 = require("fs");
    const path2 = require("path");
    const coreModulePath = require.resolve("playwright-core/lib/coreBundle");
    // coreBundle 在 lib/ 下；包根是再上一级
    const pkgRoot = path2.join(path2.dirname(coreModulePath), "..");
    const bj = JSON.parse(fs2.readFileSync(path2.join(pkgRoot, "browsers.json"), "utf8"));
    const desc = bj.browsers.find((b) => b.name === "chromium");
    if (!desc) return null;
    // 1.62+ 用 Chrome for Testing 路径：builds/cft/<browserVersion>/<hostPlatform>/chrome-<hostPlatform>.zip
    //   我们自己推导 hostPlatform（避免依赖 _downloadURLs 私有方法或 new Registry 失败）。
    const hp = hostPlatform();
    const mirrorUrl = `${mirrorBase}/builds/cft/${desc.browserVersion}/${hp}/chrome-${hp}.zip`;
    const resp = await fetch(mirrorUrl, { method: "HEAD" });
    if (!resp.ok) return null;
    const total = parseInt(resp.headers.get("content-length") || "0", 10);
    return { url: mirrorUrl, total };
  } catch (e) {
    return null;
  }
}

/** 与 playwright 内部 hostPlatform 字符串对齐（win64 / linux64 / mac-x64 / mac-arm64） */
function hostPlatform() {
  if (process.platform === "win32") return "win64";
  if (process.platform === "darwin") return process.arch === "arm64" ? "mac-arm64" : "mac-x64";
  return "linux64";
}

function fmtSize(n) {
  if (!n || n < 0) return "--";
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + "MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + "GB";
}

function makeBar(pct) {
  const width = 20;
  const filled = Math.round((pct / 100) * width);
  return "[" + "█".repeat(filled) + "·".repeat(width - filled) + "]";
}

/**
 * 在临时目录里找 playwright 当前下载中的 zip（>=1KB 的最新文件）。
 * 返回 { bytes, file }；没找到说明还没开始写。
 */
function statDownloadingZip(sinceMs) {
  try {
    const tmp = os.tmpdir();
    const minTime = Number.isFinite(sinceMs) ? sinceMs - 2000 : 0;
    const dirs = fs.readdirSync(tmp).filter((n) => n.startsWith("playwright-download-"));
    let best = null;
    for (const d of dirs) {
      const dp = path.join(tmp, d);
      let ents;
      try {
        ents = fs.readdirSync(dp);
      } catch {
        continue;
      }
      for (const e of ents) {
        if (!/^playwright-download-.*\.zip$/i.test(e)) continue;
        const full = path.join(dp, e);
        try {
          const st = fs.statSync(full);
          const touched = Math.max(st.birthtimeMs || 0, st.mtimeMs || 0, st.ctimeMs || 0);
          if (touched < minTime) continue;
          if (!best || touched > best.touched || (touched === best.touched && st.size > best.bytes)) best = { bytes: st.size, file: full, touched };
        } catch {}
      }
    }
    return best;
  } catch {
    return null;
  }
}

function startInstallProgressPoller({ stage }) {
  let lastBytes = 0;
  let lastTickMs = Date.now();
  let lastEmitMs = 0;
  let lastEmitPct = 0;
  const startedAt = Date.now();
  let total = 0;

  const tick = () => {
    if (pollStop) return;
    const now = Date.now();
    const stat = statDownloadingZip(startedAt);
    if (stat && stat.bytes > 0) {
      const dt = (now - lastTickMs) / 1000;
      const dBytes = stat.bytes - lastBytes;
      const speed = dt > 0 ? dBytes / dt : 0;
      const pct = total > 0 ? Math.min(99, Math.round((stat.bytes / total) * 100)) : 0;
      const eta = speed > 0 && total > 0 ? Math.max(0, (total - stat.bytes) / speed) : 0;
      lastBytes = stat.bytes;
      lastTickMs = now;
      // 节流：≥2s 或 ≥5% 才打日志，避免刷屏
      if (now - lastEmitMs >= 2000 || Math.abs(pct - lastEmitPct) >= 5) {
        lastEmitMs = now;
        lastEmitPct = pct;
        const bar = makeBar(pct);
        const speedStr = fmtSize(speed) + "/s";
        const etaStr = total > 0 && speed > 0 ? `ETA ${Math.round(eta)}s` : "";
        const msg = total > 0
          ? `${bar} ${pct}%  ${fmtSize(stat.bytes)} / ${fmtSize(total)}  ${speedStr}  ${etaStr}`.trim()
          : `${bar} ${fmtSize(stat.bytes)}  ${speedStr}`.trim();
        report(stage, msg, { pct, speed, eta, loaded: stat.bytes, total });
      }
      if (progressCb) {
        progressCb({ stage, pct, speed, eta, loaded: stat.bytes, total });
      }
    }
  };

  const timer = setInterval(tick, 1000);
  let pollStop = false;
  return {
    stop() {
      pollStop = true;
      clearInterval(timer);
    },
    setTotal(t) {
      total = t;
    },
  };
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
      fs.accessSync(p, fs.X_OK);
      return p;
    } catch {}
  }
  // 试 PATH
  try {
    const out = execSync(UTF8_CP + "where choco 2>nul", { encoding: "utf8", shell: "cmd.exe" });
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
  report("choco", "chocolatey 确认 chromium 包存在，开始安装（需要管理员权限）");

  // choco install 需要管理员权限，普通用户会弹 UAC
  return new Promise((resolve) => {
    const child = spawn(choco, ["install", "chromium", "-y", "--no-progress"], {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    // Windows 下强制子进程输出 UTF-8，避免中文 GBK 乱码
    if (IS_WIN) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
    }
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
 * 在指定镜像 base 下调用 Playwright API。
 * @param {string} hostValue  base URL（不含 trailing slash）
 * @param {string} stage      日志标签
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function tryInstallWithMirror(hostValue, stage) {
  // 进程内 require 已加载的 playwright-core 不会重新读 env，强制重置 require 缓存
  const corePath = require.resolve("playwright-core/lib/coreBundle");
  delete require.cache[corePath];
  const probed = hostValue.startsWith("https://cdn.npmmirror.com")
    ? await probeChromiumHeadOk(hostValue)
    : null;
  const poller = startInstallProgressPoller({ stage });
  if (probed && probed.total > 0) {
    poller.setTotal(probed.total);
    report(
      stage,
      `目标大小 ${fmtSize(probed.total)}（来源：${probed.url}）。如卡住可手动取消后切换镜像。`
    );
  } else {
    report(stage, "镜像 HEAD 探测失败，仅以已写入字节估算（无 total 时仅显示速度）");
  }
  // 设 env（在子进程层面会传给下载子进程；本进程 require cache 已清，会走新 env）
  process.env.PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST = hostValue;
  // 清掉通用 host，避免被它覆盖
  delete process.env.PLAYWRIGHT_DOWNLOAD_HOST;
  try {
    const { registry } = require("playwright-core/lib/coreBundle");
    await registry.installBrowsersForNpmInstall(["chromium"]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    poller.stop();
  }
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

  // 2. Playwright 内部 API 下载：默认走 npmmirror（许多内网/限速用户必备），
  //    失败后清掉 host env 重试官方源（兜底）。cft 路径镜像与官方一致。
  report("playwright", "尝试通过 Playwright 内部 API 下载 Chromium（首次约 192MB）");
  report(
    "playwright",
    `默认下载源 = npmmirror 镜像 (${NPMMIRROR_HOST})；失败/异常会清掉 env 重试官方源`
  );

  const npmmirrorRes = await tryInstallWithMirror(NPMMIRROR_HOST, "playwright/镜像");
  if (browser.isChromiumReady()) {
    report("playwright", "Chromium 通过 npmmirror 镜像安装完成");
    return { ready: true, method: "playwright-mirror" };
  }
  if (npmmirrorRes.ok) {
    // API 没报错但也没就绪（极少见：解压失败）
    report("playwright", "Playwright 镜像执行完但 Chromium 仍不可用");
  } else {
    report("playwright", `镜像源失败: ${npmmirrorRes.error}`);
    report("playwright", `回落到官方源（${OFFICIAL_HOST_DEFAULT}）重试…`);
    const officialRes = await tryInstallWithMirror(OFFICIAL_HOST_DEFAULT, "playwright/官方");
    if (browser.isChromiumReady()) {
      report("playwright", "Chromium 通过官方源安装完成");
      return { ready: true, method: "playwright-official" };
    }
    if (!officialRes.ok) {
      report("playwright", `官方源失败: ${officialRes.error}`);
    }
  }

  // 3. chocolatey fallback（仅 Windows；Linux/Docker 请在镜像内预装 Chromium）
  if (!IS_WIN) {
    report("choco", "非 Windows 平台，跳过 chocolatey 回落（Docker 请在镜像内 apt 安装 chromium）");
    return { ready: false, method: "none", error: "非 Windows 平台无法自动安装，请在镜像内预装 Chromium" };
  }
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
  // 暴露给 selfcheck / 诊断脚本用
  probeChromiumHeadOk,
  NPMMIRROR_HOST,
  OFFICIAL_HOST_DEFAULT,
  startInstallProgressPoller,
  statDownloadingZip,
  fmtSize,
  makeBar,
};