const logger = require("./logger");
const fs = require("fs");

const OWNER = "zefeng1236";
const REPO = "ms-rewards-auto";
const RELEASES_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases`;

/* 与环境拟真浏览器同源：项目内已验证 gh-proxy 节点按当前默认顺序做 GitHub 加速 */
const MIRROR_PREFIXES = [
  "https://cdn.gh-proxy.org/",
  "https://gh-proxy.com/",
  "https://v4.gh-proxy.org/",
  "https://gh-proxy.org/",
  "https://axisnow.gh-proxy.org/",
  "https://v6.gh-proxy.org/",
  "",
];

function parseVersionTag(tag) {
  const raw = String(tag || "").trim().replace(/^v/i, "");
  if (!raw) return null;
  const m = raw.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [0, 1, 2, 3].map((i) => Number(m[i + 1] || 0));
}

function compareVersion(a, b) {
  const va = Array.isArray(a) ? a : parseVersionTag(a);
  const vb = Array.isArray(b) ? b : parseVersionTag(b);
  if (!va || !vb) return 0;
  for (let i = 0; i < 4; i++) {
    const x = va[i] || 0;
    const y = vb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

async function fetchJsonWithMirror(rawUrl, init = {}) {
  let lastErr = null;
  for (const prefix of MIRROR_PREFIXES) {
    try {
      const res = await fetch(prefix + rawUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(12000),
        ...init,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("无法连接更新服务器");
}

function normalizeAsset(asset) {
  if (!asset) return null;
  return {
    name: String(asset.name || ""),
    url: String(asset.browser_download_url || asset.url || ""),
  };
}

/**
 * 查询本应用 GitHub Releases 最新正式版。
 * 只返回版本号、更新日志与下载地址（不下载）；「立即更新」由主进程
 * 调 downloadUpdate 内置下载安装包到系统「下载」目录，见下方 downloadUpdate。
 */
async function checkAppUpdate(currentVersion) {
  try {
    const releases = await fetchJsonWithMirror(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!Array.isArray(releases)) {
      return { ok: false, error: "更新接口返回格式异常" };
    }
    const stable = releases
      .filter((r) => r && !r.draft && !r.prerelease && parseVersionTag(r.tag_name))
      .sort((a, b) => compareVersionTagForSort(b.tag_name, a.tag_name));
    const latest = stable[0];
    // ⚠️ 必须**剥掉前缀 v**：tag_name 形如 "v0.13.15"，UI 又会加一个 "v" 当版本号
    // 装饰，剥不掉就拼出 "VV0.13.15"（双 V，2026-10-03 用户反馈的 bug）。剥在这里
    // 而不是 UI，因为这里只有一个口径，UI 有多处（更新弹窗 / Sidebar / Mock）。
    const latestVersion = latest ? String(latest.tag_name || "").trim().replace(/^v/i, "") : "";
    if (!latestVersion) {
      return { ok: false, error: "未找到可用的正式版发布信息" };
    }
    const asset = normalizeAsset((latest.assets || []).find((a) => /\.exe$/i.test(a.name || "")) || latest.assets?.[0]);
    const pageUrl = latest.html_url ? String(latest.html_url) : `https://github.com/${OWNER}/${REPO}/releases/latest`;
    return {
      ok: true,
      updateAvailable: compareVersion(latestVersion, currentVersion || "0.0.0") > 0,
      currentVersion: currentVersion || "",
      latestVersion,
      downloadUrl: asset?.url || "",
      assetName: asset?.name || "",
      pageUrl,
      releaseNotes: String(latest.body || ""),
      publishedAt: latest.published_at || "",
    };
  } catch (e) {
    logger.warn(`检查应用更新失败: ${e.message || e}`);
    return { ok: false, error: e.message || "检查更新失败" };
  }
}

function compareVersionTagForSort(a, b) {
  const va = parseVersionTag(a);
  const vb = parseVersionTag(b);
  if (!va && !vb) return 0;
  if (!va) return -1;
  if (!vb) return 1;
  return compareVersion(va, vb);
}

/**
 * 内置下载安装包：流式写入 destFile，走与「检查更新」同源的 gh-proxy 镜像链
 * （国内直连 GitHub 慢/失败时自动换下一个镜像，最后回落直连）。
 *
 * 进度经 onProgress({ loaded, total, pct, speed }) 周期性回调（按 1% 节流）；
 * 传入 signal 可取消（abort 后返回 { ok:false, canceled:true } 并清理半截文件）。
 *
 * 为什么不是 electron 的 session.downloadURL：那个走 Chromium 下载栈，
 * 一来在无窗口/后台场景不好用，二来镜像链需要逐个试（下载栈没法优雅回退）。
 */
async function downloadUpdate({ url, destFile, signal, onProgress }) {
  const rawUrl = String(url || "");
  if (!rawUrl) return { ok: false, error: "缺少下载地址" };

  let lastErr = null;
  let canceled = false;

  for (const prefix of MIRROR_PREFIXES) {
    if (signal && signal.aborted) {
      canceled = true;
      break;
    }
    try {
      const res = await fetch(prefix + rawUrl, {
        redirect: "follow",
        signal: signal || AbortSignal.timeout(180000),
        headers: { Accept: "application/octet-stream" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const total = Number(res.headers.get("content-length")) || 0;
      const reader = res.body.getReader();
      const fd = fs.createWriteStream(destFile);
      const start = Date.now();
      let loaded = 0;
      let lastPct = -1;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          loaded += value.length;
          if (!fd.write(value)) {
            await new Promise((r) => fd.once("drain", r));
          }
          if (onProgress && total > 0) {
            const pct = Math.floor((loaded / total) * 100);
            if (pct !== lastPct) {
              lastPct = pct;
              const secs = (Date.now() - start) / 1000;
              onProgress({
                loaded,
                total,
                pct,
                speed: secs > 0 ? Math.round(loaded / secs) : 0,
              });
            }
          }
        }
      } finally {
        await new Promise((r) => fd.end(r));
      }

      const bytes = fs.statSync(destFile).size;
      return { ok: true, path: destFile, bytes };
    } catch (e) {
      if (signal && signal.aborted) {
        canceled = true;
        break;
      }
      lastErr = e;
      try {
        if (fs.existsSync(destFile)) fs.unlinkSync(destFile);
      } catch {
        /* 忽略清理失败 */
      }
    }
  }

  if (canceled) {
    try {
      if (fs.existsSync(destFile)) fs.unlinkSync(destFile);
    } catch {
      /* 忽略 */
    }
    return { ok: false, canceled: true, error: "下载已取消" };
  }
  return { ok: false, error: lastErr ? lastErr.message || "下载失败" : "下载失败" };
}

module.exports = {
  OWNER,
  REPO,
  checkAppUpdate,
  downloadUpdate,
};
