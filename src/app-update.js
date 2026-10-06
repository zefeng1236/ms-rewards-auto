const logger = require("./logger");
const fs = require("fs");
const path = require("path");

const OWNER = "zefeng1236";
const REPO = "ms-rewards-auto";
const RELEASES_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases`;

/** 安装包在更新目录下的子目录名 */
const UPDATE_SUBDIR = "updates";

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

/**
 * 更新包的落盘目录：**优先软件安装目录下的 updates/**，当前权限写不进去就回落 AppData。
 *
 * 用户要求「默认更新下载目录放在软件根目录下」（即安装目录，如
 * `D:\Program Files\MS Rewards Auto\updates`）。
 *
 * ⚠️⚠️ **绝不提权**（2026-10-06 用户强调：「静默下载弹窗就不叫静默了」）：
 *   这里**只判断当前进程有没有权限写**，写不通就**直接改用 AppData**，
 *   **绝不**去申请管理员权限、绝不触发 UAC。静默下载的本意就是后台无感，
 *   弹一次 UAC 整个功能就失去意义了。
 *
 * 于是行为是：
 *   - 用户装在了可写位置（如 D:\Software\...），或系统关了 UAC → 下到安装目录 ✅
 *   - 装在受保护的 `Program Files` 且 UAC 开着 → 静默回落 AppData（不打扰用户）
 *
 * ⚠️ 只试**软件自己的安装目录**，不要往上试 `Program Files` 根目录：
 *   关了 UAC 时那个也能写，结果包被丢到 `D:\Program Files\updates` 这种
 *   不属于本软件的位置，既难找又难清理。
 *
 * @param {string} [appDataDir] userData 目录（回落用）
 * @returns {{dir: string, fallback: boolean}} fallback=true 表示用了 AppData
 */
function resolveUpdateDir(appDataDir) {
  // ① 软件安装目录：exe 所在目录（生产态 = .../MS Rewards Auto/）
  let installDir = "";
  try {
    const exeDir = path.dirname(process.execPath || "");
    // 打包后 exeDir 就是安装根；开发态为 electron 的 dist，写不通自然会回落
    installDir = exeDir ? path.join(exeDir, UPDATE_SUBDIR) : "";
  } catch {}
  // ② userData（一定能写，作为静默回落）
  const fallbackDir = appDataDir ? path.join(appDataDir, UPDATE_SUBDIR) : "";

  if (installDir) {
    try {
      fs.mkdirSync(installDir, { recursive: true });
      // 实测可写才算数（不提权、不弹窗）
      if (probeWritable(installDir)) return { dir: installDir, fallback: false };
    } catch {
      /* 不可写 → 静默回落，不打扰用户 */
    }
  }
  if (fallbackDir) {
    try {
      fs.mkdirSync(fallbackDir, { recursive: true });
    } catch {}
    return { dir: fallbackDir, fallback: true };
  }
  return { dir: "", fallback: true };
}

/**
 * 实测目录可写：真写一个临时文件再删掉。
 *
 * 为什么不看 ACL / 不看 isAdmin：ACL 里 `BUILTIN\Users` 只有 ReadAndExecute
 * 的目录，换个进程身份就可能能写；而 UAC 虚拟化会让「看起来成功」的写入
 * 落到 VirtualStore。只有真写一遍才准（2026-10-05 排查安装失败时学到的）。
 */
function probeWritable(dir) {
  const probe = path.join(dir, `.wtest-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, "1", "utf8");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    try {
      fs.rmSync(probe, { force: true });
    } catch {}
    return false;
  }
}

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

/**
 * 取**指定版本**的更新日志（供设置页「当前版本更新日志」按钮用）。
 *
 * 与 checkAppUpdate 的区别：那个查的是「最新正式版」，这个查的是「我装的这一版」。
 * 用户想回看「我这个版本改了什么」时，不能拿最新版的日志糊弄他。
 *
 * @param {string} version 形如 "0.14.4"（允许带 v 前缀）
 */
async function fetchReleaseNotes(version) {
  const v = String(version || "").trim().replace(/^v/i, "");
  if (!v) return { ok: false, error: "缺少版本号" };
  try {
    // GitHub 支持按 tag 精确取单个 release
    const r = await fetchJsonWithMirror(`${RELEASES_API}/tags/v${v}`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (r && typeof r.body === "string") {
      return { ok: true, version: v, notes: r.body, pageUrl: r.html_url || "" };
    }
    // 单条接口不通（镜像对 /tags/ 支持不齐）→ 退回列表里找
    const list = await fetchJsonWithMirror(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!Array.isArray(list)) return { ok: false, error: "更新接口返回格式异常" };
    const hit = list.find(
      (x) => String(x && x.tag_name || "").trim().replace(/^v/i, "") === v
    );
    if (!hit) return { ok: false, error: `未找到版本 ${v} 的发布信息` };
    return { ok: true, version: v, notes: String(hit.body || ""), pageUrl: hit.html_url || "" };
  } catch (e) {
    return { ok: false, error: e.message || "获取更新日志失败" };
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
      // 顺手记下哈希：安装前用它做「再次校验完整性」的基准。
      // 算 200MB 约 1 秒，值得（用户明确要求点安装时再校验一次）。
      let sha256 = "";
      try {
        sha256 = await sha256File(destFile);
      } catch {}
      return { ok: true, path: destFile, bytes, sha256 };
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

/** 流式算 sha256（202MB 安装包不能整个读进内存） */
function sha256File(file) {
  const crypto = require("crypto");
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const rs = fs.createReadStream(file);
    rs.on("error", reject);
    rs.on("data", (d) => h.update(d));
    rs.on("end", () => resolve(h.digest("hex")));
  });
}

/**
 * 安装前的完整性校验（用户要求：点安装时先确认文件真的存在，再校验完整性）。
 *
 * 三层，逐层加严：
 *   ① **存在**：静默下载完到用户点安装可能隔好几天，中途可能被清理工具删掉；
 *   ② **PE 头**：镜像出错时常常返回 200 + 一个 HTML 错误页，体积也可能正常，
 *      但 MZ 魔数骗不了人（沿用环境拟真浏览器那套 isValidPeFile 思路）；
 *   ③ **sha256 重算比对**：与下载当时算的哈希比对 ——
 *      ⚠️ 说明清楚它保什么、不保什么：GitHub Releases **不提供** asset 的官方
 *      digest（那是容器 registry 的能力），所以这里没有「上游权威哈希」可比对。
 *      留存 + 重算能抓到的是「文件坏了 / 下了一半 / 被别的程序改过」，
 *      抓不到「上游当初给的就是坏的」。这层是防损坏，不是防投毒。
 *
 * @param {{path?:string, bytes?:number, sha256?:string}} info 下载时记录的信息
 */
async function verifyUpdateFile(info) {
  const file = String((info && info.path) || "");
  if (!file) return { ok: false, reason: "没有待安装的更新包" };
  if (!fs.existsSync(file)) return { ok: false, reason: "安装包文件不存在（可能已被清理）" };

  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { ok: false, reason: "安装包无法读取" };
  }
  if (st.size < MIN_SETUP_BYTES) {
    return { ok: false, reason: `安装包体积异常（${st.size} 字节），疑似下载不完整` };
  }
  // 期望大小：下载时的字节数（对不上说明被截断或被动过）
  if (info.bytes && st.size !== info.bytes) {
    return { ok: false, reason: `安装包大小不符（${st.size} / 应为 ${info.bytes}），文件已损坏` };
  }
  // PE 头：挡住 HTML 错误页
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    if (buf[0] !== 0x4d || buf[1] !== 0x5a) {
      return { ok: false, reason: "安装包不是有效的 Windows 可执行文件（疑似镜像返回了错误页）" };
    }
  } catch (e) {
    return { ok: false, reason: `安装包无法校验: ${e.message}` };
  }
  // sha256 重算比对（仅在下载时记录过哈希的情况下做）
  if (info.sha256) {
    let actual;
    try {
      actual = await sha256File(file);
    } catch (e) {
      return { ok: false, reason: `完整性校验失败: ${e.message}` };
    }
    if (actual !== info.sha256) {
      return { ok: false, reason: "完整性校验失败：sha256 与下载时不一致，文件已损坏" };
    }
  }
  return { ok: true, path: file, bytes: st.size };
}

/** 安装包的最小合理体积（小于它就是坏文件；正常约 100MB+） */
const MIN_SETUP_BYTES = 20 * 1024 * 1024;

/**
 * 清理更新目录里的旧安装包（用户要求：自动清理）。
 *
 * 只删 `MS-Rewards-Auto-Setup-*.exe` 及其 .blockmap，**保留** keepFile 指定的那个
 * （通常是刚下好待安装的），其余按 mtime 保留最近 keep 个。
 */
function cleanupOldSetups(dir, keepFile, keep = 1) {
  const removed = [];
  try {
    if (!dir || !fs.existsSync(dir)) return { removed };
    const keepAbs = keepFile ? path.resolve(keepFile) : "";
    const ents = fs
      .readdirSync(dir)
      .filter((f) => /^MS-Rewards-Auto-Setup-.*\.(exe|exe\.blockmap)$/i.test(f))
      .map((f) => {
        const p = path.join(dir, f);
        let mtime = 0;
        try {
          mtime = fs.statSync(p).mtimeMs;
        } catch {}
        return { p, mtime, isExe: /\.exe$/i.test(f) };
      })
      .filter((x) => x.isExe && path.resolve(x.p) !== keepAbs)
      .sort((a, b) => b.mtime - a.mtime);

    for (let i = keep; i < ents.length; i++) {
      try {
        fs.rmSync(ents[i].p, { force: true });
        removed.push(ents[i].p);
        // 连带删掉同名 blockmap（AutoUpdate 用，留着是垃圾）
        try {
          fs.rmSync(ents[i].p + ".blockmap", { force: true });
        } catch {}
      } catch {}
    }
  } catch {}
  return { removed };
}

module.exports = {
  OWNER,
  REPO,
  UPDATE_SUBDIR,
  resolveUpdateDir,
  verifyUpdateFile,
  cleanupOldSetups,
  sha256File,
  checkAppUpdate,
  fetchReleaseNotes,
  downloadUpdate,
};
