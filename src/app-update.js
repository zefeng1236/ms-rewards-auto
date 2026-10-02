const logger = require("./logger");

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
 * 目前只返回版本号、更新日志与下载地址，不在主进程做热更新下载，
 * 「立即更新」先交给系统浏览器打开 Release 页，等项目开源后再补完整升级链路。
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
    const latestVersion = latest ? String(latest.tag_name || "").trim() : "";
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

module.exports = {
  OWNER,
  REPO,
  checkAppUpdate,
};
