/**
 * 环境拟真浏览器（可选增强）
 *
 * 用的是 fingerprint-chromium（adryfish，基于 Ungoogled Chromium 的 patch 版，BSD-3）：
 *   https://github.com/adryfish/fingerprint-chromium
 *
 * 为什么需要它 —— 上一轮实测得出的硬结论：
 *   用 Playwright 驱动普通 Chromium 时，`sec-ch-ua`（Client Hints）请求头**改不动**。
 *   setExtraHTTPHeaders 和 page.route().continue({headers}) 两种方式都试过，服务端
 *   收到的始终是浏览器如实生成的品牌值。而 JS 层的 UA 我们能改 —— 于是就会出现
 *   「UA 自称 Edge / CH 说 Chromium」这种永久自相矛盾的环境特征，比不做拟真更可疑。
 *
 *   这个浏览器是 patch 源码的，UA / userAgentData / Client Hints 三者同源生成，
 *   从根上解决了应用层够不到的那一层。
 *
 * 另外它用 `--fingerprint=<32 位整数>` 做**种子化**环境特征：同一颗种子恒定产出同一套环境特征，
 *   不同种子互不相关。这正好避开了「Canvas 随机噪声」的坑 —— 随机噪声多次采样比对就露，
 *   而种子化等价于「一个真人长期用同一台机器」。本项目按账户 ID 派生种子。
 *
 * ⚠️ 三个必须知道的约束：
 *   1. 体积：Windows ZIP 约 181MB（解压 400MB+），**不能打进安装包**，只能运行时按需下载。
 *   2. 与 src/stealth.js 的补丁会打架 —— 两边都改 UA/插件/CPU 核数，叠加出的就是矛盾环境特征。
 *      因此拟真模式下 stealth.js 会跳过自己那部分（见 browser.js 的 __MSR_FP 守卫）。
 *   3. headless 下它只把 UA 的 HeadlessChrome 改成 Chrome，其余 headless 特征不变
 *      （README 原话 "use with caution"）。它能修的是 UA/CH/插件/CPU/内存/字体/Canvas，
 *      修不掉窗口内外框差、语音列表这类 headless 固有属性。
 *
 * 下载加速：GitHub Releases 在国内直连体验很差，这里默认走 gh-proxy 镜像前缀链
 *   （https://gh-proxy.com/<原始 URL>），失败自动换 gh-proxy.org，再失败回落直连。
 *   实测本机直连 raw.githubusercontent.com 直接 000 不可达，代理 206 正常。
 *   下载支持 Range 断点续传，且换镜像时复用已下载的部分。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { once } = require("events");
const logger = require("./logger");
const sp = require("./storage-path");
const httpGet = require("./http-get");
const fastHosts = require("./fast-hosts");

const REPO = "adryfish/fingerprint-chromium";
/** 固定版本：环境拟真浏览器的发布节奏与本项目不同步，钉死避免用户环境出现不可预期变化 */
const PINNED_VERSION = "148.0.7778.215";

/**
 * 镜像前缀链：按顺序尝试，"" 表示直连。
 *
 * 都是 gh-proxy 官方文档里的多 CDN 节点（同一家服务的不同入口，用法一样：
 * 把原始 URL 整个拼在后面）。顺序按 2026-09-21 实测吞吐排的（8MB 采样）：
 *   gh-proxy.com 6.26 MB/s > v4.gh-proxy.org 1.68（官方标「推荐」）
 *   > cdn.gh-proxy.org 0.99（Fastly）> gh-proxy.org 0.24
 *   > axisnow 0.03 > v6（IPv6 线路，本机没测出数据，留给 v6 网络的用户）
 * 节点速度随时间波动，且每个用户所在网络完全不同，所以**这个顺序只是保底**：
 * auto 模式会先实测各节点延迟再重排（见 mirrorsByLatency），这里只决定
 * 「同分/全部测不到时」的先后。真正的保障始终是失败自动换下一个 + 空闲超时 + 两轮重试。
 */
const MIRROR_PREFIXES = [
  "https://gh-proxy.com/",
  "https://v4.gh-proxy.org/",
  "https://cdn.gh-proxy.org/",
  "https://gh-proxy.org/",
  "https://axisnow.gh-proxy.org/",
  "https://v6.gh-proxy.org/",
  "",
];

/**
 * 镜像源标识 → URL 前缀。
 *
 * 配置文件里存可读标识（如 "gh-proxy.com"）而不是整条 URL：以后换域名或增删节点，
 * 只要改这一张表，历史配置不会变成指向死链的脏值。
 *   auto   → null，表示按 MIRROR_PREFIXES 的顺序依次尝试全部（默认，最稳）
 *   direct → ""，直连 GitHub（国内多不可达，但海外/内网环境可能反而最快）
 */
const MIRROR_KEYS = {
  auto: null,
  "cdn.gh-proxy.org": "https://cdn.gh-proxy.org/",
  "gh-proxy.com": "https://gh-proxy.com/",
  "v4.gh-proxy.org": "https://v4.gh-proxy.org/",
  "gh-proxy.org": "https://gh-proxy.org/",
  "axisnow.gh-proxy.org": "https://axisnow.gh-proxy.org/",
  "v6.gh-proxy.org": "https://v6.gh-proxy.org/",
  direct: "",
};

/**
 * 「优选 IP 直连」是特例，**不进 MIRROR_KEYS**。
 *
 * 它和 direct 的 URL 前缀都是 ""，放进那张表会与 direct 撞成同一个键，
 * 导致 PREFIX_TO_KEY 反查时"直连"到底对应哪个标识说不清。区别只在**解析方式**：
 *   direct     → 系统 DNS（本地 hosts 把 github 指向 127.0.0.1 时必然失败）
 *   ip-direct  → hosts.gitcdn.top 的优选 IP（绕开阻断，实测能到 5.5MiB/s）
 * 所以由 resolveMirrors 单独识别，downloadAsset 再按标识决定要不要取优选 IP。
 */
const IP_DIRECT = "ip-direct";

/** 供界面下拉展示的镜像源选项（顺序即自动链的尝试顺序） */
const MIRROR_OPTIONS = [
  { value: "auto", label: "自动（测速选最快 · 推荐）" },
  { value: IP_DIRECT, label: "优选 IP 直连（绕 hosts 阻断 + 16 线程）" },
  { value: "cdn.gh-proxy.org", label: "cdn.gh-proxy.org（Fastly）" },
  { value: "gh-proxy.com", label: "gh-proxy.com" },
  { value: "v4.gh-proxy.org", label: "v4.gh-proxy.org（官方推荐）" },
  { value: "gh-proxy.org", label: "gh-proxy.org" },
  { value: "axisnow.gh-proxy.org", label: "axisnow.gh-proxy.org" },
  { value: "v6.gh-proxy.org", label: "v6.gh-proxy.org（IPv6 线路）" },
  { value: "direct", label: "直连 GitHub（系统 DNS）" },
];

/**
 * 默认镜像源：配置缺失/为空/写了未知值时都退回它。
 *
 * = "cdn.gh-proxy.org"。用户实测该节点在多数国内电脑上速度更快、延迟更低；
 * 仍保留 auto 选项用于按延迟自动排序，并在下载失败时沿镜像链回落。
 *
 * ⚠️ 改这个值必须同步 src/config.js 与 src/global-config.js 的
 * browser.fingerprint.mirror 默认值（selfcheck 有跨文件一致性守卫）。
 */
const DEFAULT_MIRROR = "cdn.gh-proxy.org";

/**
 * 各镜像节点的连通延迟（毫秒）。
 *
 * 用户要求加速源下拉里能看到延迟，选源不再靠猜。测法：对每个节点 HEAD 一次
 * 真实的下载 URL，取「发出请求到拿到响应头」的往返耗时 —— 它同时涵盖了
 * DNS / TLS / 代理转发，比 ping 一个域名更贴近真实下载体验。
 * auto 不是节点（只是「按序尝试全部」的语义）不参与探测；全部并发发起，
 * 总耗时 ≈ 最慢那个，不会拖慢 status()。
 *
 * 结果缓存 2 分钟：status() 会被面板/向导/侧栏多处调用，不能每次都打一圈网络。
 */
let latencyCache = { at: 0, map: {} };
async function mirrorLatency() {
  if (Date.now() - latencyCache.at < 2 * 60 * 1000) return latencyCache.map;
  const probeUrl = releaseUrl();
  if (!probeUrl) return {};
  const targets = Object.entries(MIRROR_KEYS).filter(([, p]) => p !== null);
  const entries = await Promise.all(
    targets.map(async ([key, prefix]) => {
      const t0 = Date.now();
      try {
        const res = await fetch(prefix + probeUrl, {
          method: "HEAD",
          redirect: "follow",
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) return [key, null];
        return [key, Date.now() - t0];
      } catch {
        return [key, null];
      }
    })
  );
  const map = Object.fromEntries(entries);
  latencyCache = { at: Date.now(), map };
  return map;
}

/** 把延迟并进下拉选项：值保留纯 key，label 尾部追加「 · 123ms」或「 · 超时」 */
async function mirrorOptionsWithLatency() {
  const lat = await mirrorLatency();
  return MIRROR_OPTIONS.map((o) => {
    if (!(o.value in lat)) return { ...o, latencyMs: null };
    const ms = lat[o.value];
    return {
      ...o,
      latencyMs: ms,
      label: ms == null ? `${o.label} · 超时` : `${o.label} · ${ms}ms`,
    };
  });
}

/** 前缀 → 镜像标识（测速结果是以 key 为索引的，排序时要反查回来） */
const PREFIX_TO_KEY = Object.fromEntries(
  Object.entries(MIRROR_KEYS).map(([k, v]) => [v, k])
);

/**
 * 按实测延迟升序排出的完整镜像链。
 *
 * 「自动」不再是「按写死的顺序挨个试」，而是先探一圈延迟、最快的排最前。
 * 每个用户的运营商和地域都不一样（有人直连 GitHub 反而最快），写死的顺序
 * 只对写下它的那一刻那台机器成立；实测则永远贴合当下这台机器。
 *
 * 注意返回的是**完整链**而不只是最快的那一个：最快的节点也可能在下载中途
 * 挂掉，排好序的链天然就是回落顺序，不用再写一套失败重试。
 * 探测不到的一律排到末尾（保留原顺序），全部超时时等价于旧的固定顺序。
 */
async function mirrorsByLatency() {
  let lat = {};
  try {
    lat = await mirrorLatency();
  } catch {
    lat = {};
  }
  const rank = (prefix) => {
    const ms = lat[PREFIX_TO_KEY[prefix]];
    return ms == null ? Number.MAX_SAFE_INTEGER : ms;
  };
  // Array.prototype.sort 在 V8 是稳定排序 → 同分（含都测不到）保持原顺序
  return MIRROR_PREFIXES.slice().sort((a, b) => rank(a) - rank(b));
}

/**
 * 把配置里的镜像标识解析成「本次要尝试的前缀数组」。
 *
 * 指定某个节点时就只用那一个（用户既然明确选了，就别再让自动链里的慢节点掺和）；
 * auto / 空 / 未知值一律走 mirrorsByLatency()（实测排序的完整链）—— 未知值
 * 多半是手改配置写错的，静默当自动处理比直接报错更符合
 * 「可选增强不该卡住主流程」的原则。
 */
async function resolveMirrors(mirror) {
  const key = String(mirror == null ? "" : mirror).trim();
  // 优选 IP 直连：前缀为空串（真直连），但解析方式由标识本身决定。
  // 放在自动链的最前面 —— 实测它在阻断环境下是唯一能通的直连方案，
  // 而通了之后又有16 线程分片，吞吐比任何镜像都快。
  if (key === IP_DIRECT) return [""];
  if (key && Object.prototype.hasOwnProperty.call(MIRROR_KEYS, key)) {
    const p = MIRROR_KEYS[key];
    return p === null ? await mirrorsByLatency() : [p];
  }
  return await mirrorsByLatency();
}

/** 低于这个字节数视为「镜像返回了错误页」而不是真文件 */
const MIN_ASSET_BYTES = 20 * 1024 * 1024;

/**
 * chrome.dll 的最小可信体积。
 *
 * 正常 Ungoogled Chromium 148 的 chrome.dll 约 294MB（308,093,440 字节），
 * chrome.exe 只是 4MB 的加载器，真正的浏览器逻辑全在 chrome.dll 里。
 * 取 64MB 作下限：足够低不会误伤未来正常版本，又足够高能拦下
 * 「下载/解压截断到只剩零头」的坏文件（那种文件 chrome.exe 一启动就报
 * 0xC1「不是有效的 Win32 应用程序」）。
 */
const MIN_DLL_BYTES = 64 * 1024 * 1024;

/**
 * 空闲超时（毫秒）：超过这么久一个字节都没收到就判定连接已死。
 *
 * 实测踩到：经代理下载 181MB 的包，速度会从 700KB/s 一路衰减到接近 0 后**僵住**，
 * 而 fetch 不会报错 —— 没有这道超时，安装界面会永远停在某个百分比上。
 */
const IDLE_TIMEOUT_MS = 30000;

/**
 * 连接阶段超时（毫秒）：fetch 发出后这么久还拿不到响应头就换源。
 * 镜像节点半死不活时 TCP 能连上但 TLS/首字节永远等不到，空闲超时管不到这一段。
 */
const HEADER_TIMEOUT_MS = 20000;

/**
 * 低速熔断：连续 STALL_WINDOW_MS 内的均速低于 STALL_MIN_BPS 就判该源「卡住」，
 * 立刻中断换下一个镜像。
 *
 * 与空闲超时的分工：空闲超时抓「一个字节都不来」，熔断抓「还在来但慢到不可用」。
 * 用户实测截图就是后者 —— 10.9KB/s 的涓流，181MB 要下 4 个多小时，
 * 而空闲超时因为一直有字节进来永远不会触发，界面就停在 70MB 不动弹。
 * 阈值 32KB/s 的取值：实测最慢的可用节点 axisnow 也有 ~30KB/s 量级的突发，
 * 而真正卡死的连接通常是个位数 KB/s；取 32KB/s 既能砍掉涓流又不会误伤慢节点
 * （误伤的代价只是换源，不丢数据 —— 分片保留，下一源续传）。
 */
const STALL_WINDOW_MS = 20000;
const STALL_MIN_BPS = 32 * 1024;

/* ---------------- 平台与资产 ---------------- */

/** 本项目支持的平台 → fingerprint-chromium 的 --fingerprint-platform 取值 */
function platformName() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

/**
 * 当前平台对应的 release 资产文件名。
 * macOS 是 .dmg（挂载镜像 + 拷贝 App 的流程在 Electron 里做太重），暂不支持。
 * @returns {string|null} null 表示该平台不提供
 */
function assetName(version) {
  const v = version || PINNED_VERSION;
  if (process.platform === "win32") return `ungoogled-chromium_${v}-1.1_windows_x64.zip`;
  if (process.platform === "linux") return `ungoogled-chromium-${v}-1-x86_64_linux.tar.xz`;
  return null;
}

function isSupported() {
  return assetName() !== null;
}

function releaseUrl(version) {
  const asset = assetName(version);
  if (!asset) return null;
  return `https://github.com/${REPO}/releases/download/${version || PINNED_VERSION}/${asset}`;
}

/* ---------------- 安装位置 ---------------- */

function installDir() {
  return sp.resolve("fingerprint-chromium");
}

/**
 * 镜像预装目录（Docker 场景）。
 *
 * 桌面版是「运行时按需下载」到 storage/；Docker 版已经改成**镜像内预装**——
 * Dockerfile 在构建时把 fingerprint-chromium 的 tar.xz 解压进镜像固定路径
 * （如 /opt/fingerprint-chromium），运行时用 MS_REWARDS_FINGERPRINT_PREINSTALLED
 * 指向它。这样容器起来时环境拟真浏览器就是就绪的，不再发起 134MB 的运行时下载。
 *
 * 预装目录必须放在镜像内（不放 /data 挂载点，那个会被 volume 覆盖）。
 */
function preinstalledDir() {
  const p = (process.env.MS_REWARDS_FINGERPRINT_PREINSTALLED || "").trim();
  return p && fs.existsSync(p) ? p : null;
}

function versionFile() {
  return path.join(installDir(), "version.txt");
}

/** 预装目录里的版本文件（镜像内置时由 Dockerfile 写入） */
function preinstalledVersionFile() {
  const pre = preinstalledDir();
  return pre ? path.join(pre, "version.txt") : null;
}

function downloadDir() {
  return sp.resolve("fp-download");
}

/**
 * 已安装版本（未安装返回 null）。
 *
 * 预装目录优先 —— 与 executablePath() 的优先级保持同源：既然实际用的是预装的
 * 那份可执行文件，报出来的版本就必须是它，否则会出现「跑的是 A 版本、界面显示 B 版本」
 * 的错位（桌面版可能同时存在运行时下载 + 预装两种来源）。
 */
function installedVersion() {
  const candidates = [preinstalledVersionFile(), versionFile()].filter(Boolean);
  for (const f of candidates) {
    try {
      const v = fs.readFileSync(f, "utf8").trim();
      if (v) return v;
    } catch {}
  }
  return null;
}

/* ---------------- 可执行文件探测 ---------------- */

/**
 * 校验文件是不是「看起来有效」的 PE（DLL/EXE）。
 *
 * 两条判据，缺一不可：
 *   1. 体积 >= minBytes：正常 chrome.dll 约 294MB，截断/残缺的文件会明显偏小。
 *   2. 前 2 字节是 MZ（0x4D 0x5A）：DLL/EXE 的魔数。镜像返回的 HTML 错误页、
 *      文本、0 字节文件都过不了这关。
 *
 * 只做廉价检查、不解析完整 PE 头：够在「就绪判定」入口挡住坏 DLL 即可，
 * 真正的完整性由下载环节的权威总长校验兜底。
 */
function isValidPeFile(file, minBytes) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (minBytes && st.size < minBytes) return false;
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(2);
    const n = fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    return n === 2 && head[0] === 0x4d && head[1] === 0x5a;
  } catch {
    return false;
  }
}

/**
 * 在解压目录里找浏览器可执行文件。
 *
 * 不写死目录名 —— 上游 ZIP 的内部目录名随版本变（chrome-win64 / ungoogled-chromium_x64…），
 * 硬编码会在某次升级后静默失效。改成广度优先找主程序：
 *   Windows: chrome.exe，且同级 chrome.dll 必须是有效 PE（排除 setup.exe、crashpad 之类）
 *   Linux:   chrome / chromium / headless_shell，同级有 crashpad handler 即视为就绪
 * 找不到强信号的就退回任意一个同名可执行文件（仅 Linux，见下）。
 *
 * ⚠️ Windows 上 chrome.exe 只是加载器，浏览器本体在 chrome.dll。若 DLL 损坏，
 * chrome.exe 一启动就报 0xC1「不是有效的 Win32 应用程序」（实测就是下载/解压
 * 损坏的症状）。所以坏 DLL 时**不退回 weak**，而是直接判「未就绪」，让上层
 * 静默回落普通 Chromium 并提示重新下载，别让用户面对晦涩的加载失败。
 */
function findExecutable(root) {
  if (!root || !fs.existsSync(root)) return null;
  const isWin = process.platform === "win32";
  const names = isWin ? ["chrome.exe"] : ["chrome", "chromium", "headless_shell"];
  const weak = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (depth > 4) continue;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;
      if (!names.includes(e.name)) continue;
      try {
        fs.accessSync(full, fs.X_OK);
      } catch {
        continue;
      }
      if (isWin) {
        // 强信号：同级 chrome.dll 必须是有效 PE。坏 DLL 直接跳过（不进 weak），
        // 否则会退回一个启动即崩的 chrome.exe。
        if (isValidPeFile(path.join(dir, "chrome.dll"), MIN_DLL_BYTES)) return full;
        continue;
      }
      // Linux 强信号：主程序与 chrome_crashpad_handler / chrome 同级
      const hasCore = fs.existsSync(path.join(dir, "chrome_crashpad_handler")) ||
        fs.existsSync(path.join(dir, "chrome"));
      if (hasCore) return full;
      weak.push(full);
    }
  }
  return weak.length ? weak[0] : null;
}

/**
 * 解压目录里是否存在 chrome.exe（不校验 DLL 有效性）。
 * 供安装失败时区分「完全没解出来」与「解出来了但 chrome.dll 坏」——后者通常是
 * 下载损坏或杀毒软件把 DLL 隔离了，提示要更具体。
 */
function hasChromeExe(root) {
  if (!root || !fs.existsSync(root)) return false;
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (e.isFile() && e.name.toLowerCase() === "chrome.exe") return true;
    }
  }
  return false;
}

function executablePath() {
  // 镜像预装优先：Docker 场景运行时不需要下载，直接用它。
  const pre = preinstalledDir();
  if (pre) {
    const exe = findExecutable(pre);
    if (exe) return exe;
  }
  return findExecutable(installDir());
}

function isReady() {
  return !!executablePath();
}

/** 供 IPC / UI 展示的状态（async：镜像下拉要带实测延迟，见 mirrorLatency） */
async function status() {
  const exe = executablePath();
  const pre = preinstalledDir();
  return {
    supported: isSupported(),
    platform: process.platform,
    ready: !!exe,
    executable: exe,
    version: installedVersion(),
    pinned: PINNED_VERSION,
    installDir: installDir(),
    // 镜像内置（Docker）：界面据此隐藏「下载/重新下载/删除」，避免用户在容器里
    // 点一下就把 134MB 拉到 /data 卷上（明明已经预装好了，纯属白折腾）。
    preinstalled: !!pre,
    downloadUrl: releaseUrl(),
    // 预装场景不需要镜像源下拉，跳过测速探测（省掉最长 4s 的启动等待）
    mirrors: pre ? [] : await mirrorOptionsWithLatency(),
  };
}

/* ---------------- 种子 ---------------- */

/**
 * 由账户标识派生 32 位拟真种子（FNV-1a）。
 *
 * 为什么要跟账户绑定而不是全局随机：同一个账户每次跑都必须是同一套环境特征，
 * 否则相当于「同一个人每天换一台电脑」；不同账户之间又要尽量不同，避免
 * 多账户共用一台机器时被聚成一类。种子化正好同时满足这两点。
 * @returns {number} 0 ~ 2^32-1
 */
function seedFor(key) {
  const s = String(key == null || key === "" ? "default" : key);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/* ---------------- 下载 ---------------- */

function fmtSize(n) {
  if (!n || n < 0) return "--";
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + "MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + "GB";
}

function fmtEta(sec) {
  if (!sec || sec <= 0 || !isFinite(sec)) return "";
  if (sec < 60) return `ETA ${Math.round(sec)}s`;
  if (sec < 3600) return `ETA ${Math.round(sec / 60)}m`;
  return `ETA ${(sec / 3600).toFixed(1)}h`;
}

/**
 * 探测资源的权威元数据：总长度 + 官方 sha256。
 *
 * 为什么非要单独探一次：实测 gh-proxy 对 Range 请求返回的是**重新压缩过的分片**，
 * 它自报的 Content-Length / Content-Range 跟自己发的分片是一致的，
 * 所以「实收 == 自报长度」这个校验在续传场景下形同虚设 —— 下出来的文件是
 * 「前 N 字节原文 + 一大坨 gzip 垃圾」，看着完整其实坏了。
 * 只有不带 Range 时拿到的总长度才可信，用它当唯一判据。
 *
 * sha256 来自 GitHub Releases API 资产的 `digest` 字段（官方对资产算的哈希），
 * 是比「长度一致」强得多的完整性锚点：gh-proxy 重压缩 / 提前断流 / 中间人篡改，
 * 只要内容有一个字节不对，哈希就对不上。
 *
 * @returns {{total: number, sha256: string|null}} total=总字节数（取不到为 0，
 *   调用方跳过长度校验）；sha256=十六进制小写（API 不可达时为 null，退回长度校验）
 */
async function probeTotal(rawUrl, version, mirror) {
  const mirrors = await resolveMirrors(mirror);
  // 直连档要像下载那样用上优选 IP：api.github.com 在很多本地 hosts 里被指向
  // 127.0.0.1（实测本机就是这样），走 fetch 会全盘失败 —— 结果 total=0、
  // sha256=null，最强的完整性校验被静默跳过。必须与下载路径同源。
  // ⚠️ github.com 与 api.github.com 是**两台不同的机器**（实测 .166 / .168），
  // 必须按域名分别取 IP：用错会拿到 403，表现为探测静默失败。
  let ipMap = null;
  if (mirror === IP_DIRECT || (mirror !== "direct" && mirrors.length === 1 && mirrors[0] === "")) {
    try {
      const [ghIp, apiIp] = await Promise.all([fastHosts.githubIp(), fastHosts.apiGithubIp()]);
      if (ghIp || apiIp) {
        ipMap = {};
        if (ghIp) ipMap["github.com"] = ghIp;
        if (apiIp) ipMap["api.github.com"] = apiIp;
      }
    } catch {
      ipMap = null;
    }
  }
  /** 发探测请求：直连+有优选 IP 时走 http-get（能固定解析），否则用 fetch。
   *  两者返回同形响应（有 ok / json / headers.get），上层无需分支。 */
  const probeFetch = async (url, opts) => {
    const isDirect = /^https:\/\/(github\.com|api\.github\.com)\//.test(url);
    if (ipMap && isDirect) {
      try {
        return await httpGet.get(url, {
          method: (opts && opts.method) || "GET",
          headers: (opts && opts.headers) || {},
          timeoutMs: (opts && opts.timeoutMs) || 8000,
          ip: ipMap,
        });
      } catch {
        return null;
      }
    }
    try {
      return await fetch(url, opts);
    } catch {
      return null;
    }
  };

  // ① HEAD：直连 GitHub 会如实返回 content-length；经 gh-proxy 时拿不到（实测为 null）
  const headTotal = async () => {
    for (const prefix of mirrors) {
      const res = await probeFetch(prefix + rawUrl, {
        method: "HEAD",
        signal: AbortSignal.timeout(8000),
      });
      if (!res || !res.ok) continue;
      const n = parseInt(res.headers.get("content-length") || "0", 10);
      // 必须 >= MIN_ASSET_BYTES 才信：环境拟真浏览器包至少 181MB，镜像对 HEAD返回
      // 0 / 几 KB 的异常值不能当权威总长（否则 knownTotal 失真，校验基准就错了）
      if (n >= MIN_ASSET_BYTES) return n;
    }
    return 0;
  };

  // ② Releases API：拿 size + 官方 sha256 digest。
  // ⚠ 必须**独立于 HEAD 结果无条件尝试** —— 早期写法是「HEAD 成功就提前 return」，
  // 结果 digest 永远是 null，完整性校验形同虚设（实测踩到：本地镜像 HEAD 通了，
  // sha256 全是 null）。长度可以优先用 HEAD，哈希只能来自 API。
  const apiMeta = async () => {
    const asset = assetName(version);
    if (!asset) return { total: 0, sha256: null };
    const api = `https://api.github.com/repos/${REPO}/releases/tags/${version || PINNED_VERSION}`;
    for (const prefix of mirrors) {
      const res = await probeFetch(prefix + api, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res || !res.ok) continue;
      const j = await res.json();
      const hit = (j.assets || []).find((x) => x.name === asset);
      if (hit && hit.size > 0) {
        // digest 形如 "sha256:9ef3f4…"，剥掉算法前缀只留十六进制
        const m = typeof hit.digest === "string" ? hit.digest.match(/^sha256:([0-9a-f]{64})$/i) : null;
        return { total: hit.size, sha256: m ? m[1].toLowerCase() : null };
      }
    }
    return { total: 0, sha256: null };
  };

  // 两者并发：HEAD 快、API 慢，并行不额外增加等待时间
  const [byHead, byApi] = await Promise.all([headTotal(), apiMeta()]);
  return { total: byHead || byApi.total, sha256: byApi.sha256 };
}

/**
 * 流式计算文件 sha256（十六进制小写）。
 * 190MB 量级的包在 NVMe 上不到 1 秒，不值得为它开 worker。
 */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const rs = fs.createReadStream(file);
    rs.on("data", (d) => h.update(d));
    rs.on("error", reject);
    rs.on("end", () => resolve(h.digest("hex")));
  });
}

/**
 * 单个 URL 的断点续传下载。
 * 已存在的文件用 Range 续写；服务器不支持 Range（返回 200 而非 206）时从头重写。
 * @param {number} [knownTotal] 权威总长度（见 probeTotal），用于验收
 */
function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const err = new Error("下载已取消");
    err.canceled = true;
    throw err;
  }
}

async function downloadOnce(url, dest, onProgress, knownTotal, allowResume, signal) {
  throwIfAborted(signal);
  let start = 0;
  if (allowResume !== false) {
    try {
      if (fs.existsSync(dest)) start = fs.statSync(dest).size;
    } catch {
      start = 0;
    }
  }
  const headers = {};
  if (start > 0) headers.Range = `bytes=${start}-`;
  // 连接阶段超时：半死节点 TCP 能连上但首字节永远等不到，空闲超时管不到这一段。
  // 注意不能用 AbortSignal.timeout —— 它会在超时后连 body 读取一起 abort；
  // 这里只在「拿到响应头之前」计时，拿到头就撤表，body 交给空闲超时与熔断管。
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const headerTimer = setTimeout(() => ac.abort(), HEADER_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { headers, redirect: "follow", signal: ac.signal });
  } catch (e) {
    throwIfAborted(signal);
    throw e;
  } finally {
    clearTimeout(headerTimer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }

  // 416 = 本地已写字节超过远端长度（多半是上次下到一半换了版本）→ 重来
  if (res.status === 416) {
    try {
      fs.rmSync(dest, { force: true });
    } catch {}
    start = 0;
    throwIfAborted(signal);
    const again = await fetch(url, { redirect: "follow", signal });
    return pipeTo(again, dest, 0, onProgress, knownTotal, signal);
  }
  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`HTTP ${res.status}`);
  }
  // 头部级哨兵：Content-Range 会自报整体总长，若它与权威总长对不上，
  // 说明该镜像是在**压缩后的字节流**上做切片（实测 gh-proxy 正是如此：
  // 22KB 的 README 被它当成 6092 字节的文件来切 Range）。
  // 这种情况下续传必然产出坏文件，立刻放弃，别浪费带宽把垃圾下完。
  if (knownTotal > 0 && start > 0 && res.status === 206) {
    const cr = /\/(\d+)\s*$/.exec(res.headers.get("content-range") || "");
    const declared = cr ? parseInt(cr[1], 10) : 0;
    if (declared > 0 && declared !== knownTotal) {
      const err = new Error(
        `该下载源的 Range 语义不可信（自报总长 ${fmtSize(declared)}，实际 ${fmtSize(knownTotal)}），放弃续传改为整体重下`
      );
      err.integrity = true;
      throw err;
    }
  }
  const resumed = res.status === 206 && start > 0;
  return pipeTo(res, dest, resumed ? start : 0, onProgress, knownTotal, signal);
}

/**
 * 期望的总字节数。优先用 Content-Range 末尾的 /total —— 它比 Content-Length 可靠：
 * 206 响应里 Content-Length 只是本次片段长度，而 Content-Range 给出的是整体长度。
 * 取不到就返回 0（调用方跳过完整性校验）。
 */
function expectedTotal(res, start) {
  const cr = res.headers.get("content-range");
  if (cr) {
    const m = /\/(\d+)\s*$/.exec(cr);
    if (m) return parseInt(m[1], 10);
  }
  const cl = parseInt(res.headers.get("content-length") || "0", 10);
  if (cl > 0) return res.status === 206 ? start + cl : cl;
  return 0;
}

async function pipeTo(res, dest, start, onProgress, knownTotal, signal) {
  throwIfAborted(signal);
  if (!res.body) throw new Error("响应没有 body");
  // 进度显示用响应自报长度，验收用权威总长度（knownTotal 优先）
  const total = expectedTotal(res, start);
  const want = knownTotal || total;
  const ws = fs.createWriteStream(dest, { flags: start > 0 ? "a" : "w" });
  const reader = res.body.getReader();
  let loaded = start;
  let lastEmit = 0;
  let lastPct = -1;
  const t0 = Date.now();
  // 低速熔断的滑动窗口：窗口起点时间 + 窗口起点已收字节数
  let winStart = t0;
  let winBytes = start;

  try {
    for (;;) {
      throwIfAborted(signal);
      let timer = null;
      const idle = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`超过 ${IDLE_TIMEOUT_MS / 1000} 秒没有收到数据，判定连接已中断`);
          err.idle = true;
          reject(err);
        }, IDLE_TIMEOUT_MS);
      });
      let chunk;
      let abortTimer = null;
      const aborted = new Promise((_, reject) => {
        if (!signal) return;
        if (signal.aborted) {
          try {
            reader.cancel();
          } catch {}
          reject(Object.assign(new Error("下载已取消"), { canceled: true }));
          return;
        }
        const onAbort = () => {
          try {
            reader.cancel();
          } catch {}
          reject(Object.assign(new Error("下载已取消"), { canceled: true }));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        abortTimer = () => signal.removeEventListener("abort", onAbort);
      });
      try {
        chunk = signal ? await Promise.race([reader.read(), idle, aborted]) : await Promise.race([reader.read(), idle]);
      } finally {
        if (timer) clearTimeout(timer);
        if (abortTimer) abortTimer();
      }
      const { done, value } = chunk;
      if (done) break;
      const buf = Buffer.from(value);
      if (!ws.write(buf)) await once(ws, "drain");
      loaded += buf.length;
      // 低速熔断：窗口满一个周期才结算，均速不达标就中断换源。
      // 分片保留在磁盘上，换源后续传不浪费已下部分。
      const nowWin = Date.now();
      if (nowWin - winStart >= STALL_WINDOW_MS) {
        const bps = (loaded - winBytes) / ((nowWin - winStart) / 1000);
        if (bps < STALL_MIN_BPS) {
          const err = new Error(
            `下载源速度过低（${fmtSize(Math.round(bps))}/s，低于 ${fmtSize(STALL_MIN_BPS)}/s 熔断线），自动换源续传`
          );
          err.stall = true;
          throw err;
        }
        winStart = nowWin;
        winBytes = loaded;
      }
      const now = Date.now();
      const pct = total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0;
      if (now - lastEmit >= 800 || Math.abs(pct - lastPct) >= 1) {
        const speed = loaded / Math.max(1, (now - t0) / 1000);
        lastEmit = now;
        lastPct = pct;
        if (onProgress) {
          onProgress({
            message: `${fmtSize(loaded)}${total > 0 ? " / " + fmtSize(total) : ""}  ${fmtSize(speed)}/s  ${fmtEta(speed > 0 && total > 0 ? (total - loaded) / speed : 0)}`.trim(),
            pct,
            speed,
            loaded,
            total,
          });
        }
      }
    }
    ws.end();
    await once(ws, "close");
  } catch (e) {
    try {
      ws.destroy();
    } catch {}
    throw e;
  }
  // 完整性校验：抓到的坑 —— 镜像可能提前关闭连接而 fetch 不报错，
  // 于是「下了一半」会被当成成功，解压时才发现包是坏的。
  // 没有长度信息（分块传输且没探到总长）时跳过校验。
  if (want > 0 && loaded !== want) {
    const err = new Error(`传输中断：实收 ${fmtSize(loaded)}，应为 ${fmtSize(want)}`);
    err.integrity = true;
    throw err;
  }
  return { loaded, total: want };
}

/* ---------------- 分片并发下载 ---------------- */

/**
 * 并发连接数（实测定档，2026-10-03）。
 *
 * 单连接下载实测（181MB 的 ungoogled-chromium，同一台机器同一时刻）：
 *   直连（hosts 优选 IP）单连接 0.63 MiB/s → 8 连接 1.46 → **16 连接 5.51**
 *   gh-proxy 镜像  单连接 0.52 MiB/s → 6 连接 1.20
 * 结论：单连接被TCP 流控与CDN 单流限速卡住，**并发是最有效的提速手段**，
 * 16 连接能把181MB 从 4.8 分钟压到 33 秒。
 *
 * 取 16 而不是更多：并发连接数会线性增加服务端压力，且32 连接实测增益已
 * 趋平（16 连接已达单连接的 8.7 倍）；16 也正好与主流下载器的默认档位一致。
 */
const PARALLEL_CONNECTIONS = 16;

/** 分片临时文件后缀（拼接前的中间产物） */
const PART_SUFFIX = ".part";

/** 列出某个目标文件对应的所有分片临时文件 */
function listParts(dest) {
  const dir = path.dirname(dest);
  const base = path.basename(dest) + PART_SUFFIX;
  let ents = [];
  try {
    ents = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return ents.filter((e) => e.startsWith(base)).map((e) => path.join(dir, e));
}

/**
 * 把一个分片写进自己的临时文件。
 *
 * 每片独立文件而不是各写各的 fd 偏移：后者一旦某片失败，已写入的数据
 * 会与「已下载字节数」的记账脱节（进度条说 60% 但文件只有 40%），
 * 续传就没法可靠判断。独立文件让「完成」这件事变成一个原子事实：
 * 文件大小等于分片长度 = 这片好了。
 */
async function downloadSegment(url, file, start, end, onBytes, signal, ip) {
  throwIfAborted(signal);
  const ac = new AbortController();
  let timer = null;
  const onAbort = () => {
    try {
      ac.abort();
    } catch {}
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  let res;
  try {
    res = await httpGet.get(url, {
      headers: { Range: `bytes=${start}-${end}` },
      signal: ac.signal,
      timeoutMs: HEADER_TIMEOUT_MS,
      ip,
    });
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
  // 206 = 正确按分片返回；200 = 服务器无视了Range 直接从头给整个文件
  // （那样分片方案不成立，且写出来的文件会全是重复数据）
  if (res.status !== 206) {
    try {
      await res.body.cancel();
    } catch {}
    const err = new Error(`分片请求返回 HTTP ${res.status}（期望 206，该源不支持并发分片）`);
    err.noRange = true;
    throw err;
  }
  const want = end - start + 1;
  const ws = fs.createWriteStream(file);
  const reader = res.body.getReader();
  let got = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      let idleTimer = null;
      const idle = new Promise((_, rej) => {
        idleTimer = setTimeout(() => {
          const e = new Error(`分片 ${start}-${end} 超过 ${IDLE_TIMEOUT_MS / 1000} 秒无数据`);
          e.idle = true;
          rej(e);
        }, IDLE_TIMEOUT_MS);
      });
      let chunk;
      try {
        chunk = await Promise.race([reader.read(), idle]);
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }
      const { done, value } = chunk;
      if (done) break;
      const buf = Buffer.from(value);
      if (!ws.write(buf)) await once(ws, "drain");
      got += buf.length;
      if (onBytes) onBytes(buf.length);
    }
    ws.end();
    await once(ws, "close");
  } catch (e) {
    try {
      ws.destroy();
    } catch {}
    throw e;
  }
  if (got !== want) {
    const err = new Error(`分片 ${start}-${end} 实收 ${got} 字节，应为 ${want} 字节`);
    err.integrity = true;
    throw err;
  }
  return got;
}

/**
 * 分片并发下载一个源。
 *
 * 流程：切分→ 并发拉取（各自写 .part）→ 全部成功后按序拼接 → 删分片。
 * 任何一片失败就整体失败（分片留在磁盘上，下次调用能按已有分片续传）。
 *
 * @param {string} rawUrl 原始 URL（不带镜像前缀）
 * @param {string} prefix 镜像前缀（"" 表示直连）
 * @param {string} dest 最终落盘路径
 * @param {number} total 权威总长（必须> 0，否则无法切分，调用方退回串行）
 * @returns {Promise<{file:string, size:number}>}
 */
async function downloadParallel(rawUrl, prefix, dest, total, onProgress, signal, ip) {
  const url = prefix + rawUrl;
  const n = Math.max(1, Math.min(PARALLEL_CONNECTIONS, Math.floor(total / (2 * 1024 * 1024)) || 1));
  const span = Math.ceil(total / n);
  const segs = [];
  for (let i = 0; i < n; i++) {
    const start = i * span;
    const end = Math.min(total, start + span) - 1;
    if (start > end) break;
    segs.push({ start, end, file: dest + PART_SUFFIX + i, got: 0 });
  }

  // 已完成的分片（上次续传）：大小正好等于分片长度才算好
  for (const s of segs) {
    try {
      const st = fs.statSync(s.file);
      if (st.isFile() && st.size === s.end - s.start + 1) s.got = st.size;
    } catch {}
  }
  const resumedBytes = segs.reduce((a, s) => a + s.got, 0);
  if (onProgress && resumedBytes > 0) {
    onProgress({
      stage: "fingerprint/download",
      message: `断点续传：已有 ${fmtSize(resumedBytes)} / ${fmtSize(total)}`,
      pct: Math.min(99, Math.round((resumedBytes / total) * 100)),
      loaded: resumedBytes,
      total,
    });
  }

  const t0 = Date.now();
  let lastEmit = 0;
  const emit = (force) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmit < 800) return;
    const loaded = segs.reduce((a, s) => a + s.got, 0);
    const dt = Math.max(1, (now - t0) / 1000);
    const speed = loaded / dt;
    lastEmit = now;
    onProgress({
      stage: "fingerprint/download",
      message: `${n} 线程分片  ${fmtSize(loaded)} / ${fmtSize(total)}  ${fmtSize(speed)}/s  ${fmtEta(speed > 0 ? (total - loaded) / speed : 0)}`.trim(),
      pct: Math.min(99, Math.round((loaded / total) * 100)),
      speed,
      loaded,
      total,
      connections: n,
    });
  };

  await Promise.all(
    segs.map(async (s) => {
      if (s.got === s.end - s.start + 1) return; // 已完成，跳过
      await downloadSegment(url, s.file, s.start, s.end, (n2) => {
        s.got += n2;
        emit(false);
      }, signal, ip);
      emit(false);
    })
  );
  emit(true);
  throwIfAborted(signal);

  // 拼接：顺序流式写入，避免把 180MB 全读进内存。
  // 用「读流的 end 事件」而不是 `rs.pipe(ws).on('close')`：pipe 返回的是目标流
  // 而不是布尔值，而且 end:false 时目标流不会 close，等它会死锁。
  const ws = fs.createWriteStream(dest);
  for (const s of segs) {
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(s.file);
      let settled = false;
      const done = (e) => {
        if (settled) return;
        settled = true;
        try { rs.destroy(); } catch {}
        if (e) reject(e);
        else resolve();
      };
      ws.on("error", done);
      rs.on("error", done);
      rs.on("end", () => done(null));
      rs.pipe(ws, { end: false });
    });
  }
  ws.end();
  await once(ws, "close");
  for (const s of segs) {
    try {
      fs.rmSync(s.file, { force: true });
    } catch {}
  }
  const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  if (size !== total) {
    const err = new Error(`分片拼接后大小不符：${fmtSize(size)} / ${fmtSize(total)}`);
    err.integrity = true;
    throw err;
  }
  return { file: dest, size };
}

/**
 * 按镜像链下载，中途失败换下一个镜像并复用已下载的部分。
 */
async function downloadAsset(version, onProgress, mirror, signal) {
  throwIfAborted(signal);
  const asset = assetName(version);
  const raw = releaseUrl(version);
  if (!asset || !raw) throw new Error(`当前平台（${process.platform}）不提供环境拟真浏览器`);
  const mirrors = await resolveMirrors(mirror);

  const dir = downloadDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, asset);

  // 先探一次权威元数据：续传是否被接受、最终文件对不对、以及官方 sha256，都靠它判定
  const meta = await probeTotal(raw, version, mirror);
  const total = meta.total;
  if (total > 0) {
    logger.info(`环境拟真浏览器包大小 ${fmtSize(total)}（HEAD / Releases API 探测）`);
  }
  if (meta.sha256) {
    logger.info(`环境拟真浏览器官方 sha256 = ${meta.sha256}（Releases API digest）`);
  }

  // hosts 优选 IP：只在「直连」这一档用（镜像节点有自己的 CDN，不需要也不该改解析）。
  // auto 链如果排到了空前缀（直连）也同样适用 —— 但前提是用户**不是**显式选了
  // direct（那是"我就用系统 DNS"的意思，不该被优选 IP 覆盖）。
  const wantPinned = mirror === IP_DIRECT || (mirror !== "direct" && mirrors.length === 1 && mirrors[0] === "");
  let pinnedIp = null;
  if (wantPinned) {
    try {
      pinnedIp = await fastHosts.githubIp();
      if (pinnedIp) logger.info(`使用 hosts 优选 IP 直连 GitHub: ${pinnedIp}`);
      else logger.warn("hosts 优选 IP 获取失败，退化为普通直连（可能被本地 hosts 阻断）");
    } catch (e) {
      logger.warn(`hosts 优选 IP 获取异常: ${e.message}`);
    }
  }

  let lastErr = null;
  // 两轮：第一轮允许续传（省带宽）；一轮下来全挂过就清掉分片从头再来一次，
  // 排除「分片不可信 / 连接僵死」这类只在续传路径上出现的问题。
  for (const allowResume of [true, false]) {
    throwIfAborted(signal);
    if (!allowResume) {
      try {
        fs.rmSync(dest, { force: true });
      } catch {}
      // 分片文件同样清掉：残留分片来自别的轮次/别的源，混用会拼出坏文件
      for (const f of listParts(dest)) {
        try {
          fs.rmSync(f, { force: true });
        } catch {}
      }
    }
    for (const prefix of mirrors) {
      throwIfAborted(signal);
      const label = prefix ? prefix.replace(/\/$/, "") : "直连";
      try {
        if (onProgress) onProgress({ stage: "fingerprint/download", message: `下载源: ${label}`, pct: 0 });
        // 分片并发：能探到总长就用（实测16 线程能把直连从 0.63 拉到 5.5 MiB/s）。
        // 探不到总长就没法切分，老老实实退回串行。
        let r;
        if (total > 0) {
          r = await downloadParallel(raw, prefix, dest, total, (p) =>
            onProgress({ ...p, mirror: label })
          , signal, prefix === "" ? pinnedIp : null);
        } else {
          r = await downloadOnce(prefix + raw, dest, (p) =>
            onProgress({ ...p, stage: "fingerprint/download", mirror: label })
          , total, allowResume, signal);
        }
        const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
        // 镜像出错时常常是 200 + 一个 HTML 错误页，按体积与长度双校验拦掉
        if (size < MIN_ASSET_BYTES) throw new Error(`文件过小（${fmtSize(size)}），疑似镜像返回了错误页`);
        if (r.total > 0 && size !== r.total) throw new Error(`文件不完整（${fmtSize(size)} / ${fmtSize(r.total)}）`);
        // 官方 sha256 校验（最后一道、也是最硬的一道防线）：
        // gh-proxy 对续传分片做重压缩，长度校验完全测不出来，只有哈希能抓住。
        if (meta.sha256) {
          if (onProgress) onProgress({ stage: "fingerprint/download", message: "校验下载完整性（sha256）…", pct: 100 });
          const actual = await sha256File(dest);
          if (actual !== meta.sha256) {
            const err = new Error(`完整性校验失败：sha256 不匹配（实得 ${actual.slice(0, 12)}…，应为 ${meta.sha256.slice(0, 12)}…），文件已损坏`);
            err.integrity = true; // 分片不可信，外层会清掉重下
            throw err;
          }
        }
        return { file: dest, size, mirror: label };
      } catch (e) {
        if (e && e.canceled) throw e;
        lastErr = e;
        logger.warn(`环境拟真浏览器下载失败（${label}）: ${e.message}`);
        // 两种情况本地分片都不可信，必须清掉从头再来：
        //   ① 完整性校验失败（镜像提前断流，分片是残缺的）
        //   ② 体积异常的小文件（镜像返回了 HTML 错误页），留着会让续传一路错下去
        // 其余（网络中断等）保留分片，下一个镜像接着续传。
        try {
          const st = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
          if (st > 0 && (e.integrity || st < MIN_ASSET_BYTES)) fs.rmSync(dest, { force: true });
        } catch {}
        // 并发分片失败时同理：残缺的分片留着会让下轮续传拼出坏文件。
        // 判据是「没有一片达到完整长度」——只要有一片是好的，它就还能复用。
        if (e.noRange || e.integrity || e.idle) {
          for (const f of listParts(dest)) {
            try {
              if (fs.statSync(f).size === 0) fs.rmSync(f, { force: true });
            } catch {}
          }
        }
      }
    }
  }
  throw new Error(`所有下载源均失败，最后一个错误: ${lastErr ? lastErr.message : "未知"}`);
}

/* ---------------- 解压 ---------------- */

function runCmd(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    let err = "";
    // cwd 单独传而不是拼进参数：bsdtar 遇到 `-f C:\...` 的冒号会当远程主机，
    // 只有把工作目录切到包所在处、-f 给纯文件名才绕得开（见 tarArgs）
    const child = spawn(cmd, args, { windowsHide: true, cwd });
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} 退出码 ${code}${err ? ": " + err.trim().slice(0, 200) : ""}`));
    });
  });
}

/** PowerShell 单引号转义（路径里出现单引号要写成两个） */
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * 解压。
 *
 * 刻意**不用** extract-zip / yauzl：它们在 package-lock.json 里是 dev=true，
 * electron-builder 打包时会把 devDependencies 剪掉 —— 开发环境能跑，发布版直接
 * 模块找不到。改用操作系统自带工具，顺序是「bsdtar → tar → PowerShell」。
 *
 * ⚠️ 为什么必须显式找 bsdtar（2026-10-03 实测抓到的真bug）：
 * 裸 `tar` 走 PATH 解析，而**装了Git for Windows / PortableGit 的机器上，
 * PortableGit 的 GNU tar 排在 `C:\Windows\System32\tar.exe` 前面**。
 * GNU tar 1.35 不支持 zip（实测报 "This does not look like a tar archive"，
 * 退出码 2），于是：
 *   ① 主路径 tar 失败 → 回落 PowerShell Expand-Archive
 *   ② 但 Expand-Archive 对 181MB 的包也失败（同样是空目录）
 *   ③ 结果「下载成功却装不上」，报错还指向"压缩包可能已损坏"（误导）
 * 实测用 `C:\Windows\System32\tar.exe`（bsdtar 3.8.8，libarchive）解同一个包
 * 直接成功（退出码 0）。所以这里**按绝对路径优先挑 bsdtar**，而不是赌 PATH。
 *
 * 另外 bsdtar 有个坑：`-f C:\path\file.zip` 里的冒号会被当成**远程主机分隔符**
 * （报 "Cannot connect to C: resolve failed"）。所以 cwd 切到包所在目录、
 * `-f` 只给文件名，绕开冒号。
 */
async function extractArchive(file, dir) {
  const attempts = tarCandidates().map((cmd) => {
    const t = tarArgs(cmd, file, dir);
    return { cmd, args: t.args, cwd: t.cwd };
  });
  attempts.push({
    cmd: "powershell",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath ${psQuote(file)} -DestinationPath ${psQuote(dir)} -Force`,
    ],
    cwd: undefined,
  });

  let lastErr = null;
  for (const a of attempts) {
    try {
      await runCmd(a.cmd, a.args, a.cwd);
      assertExtracted(dir, path.basename(a.cmd));
      return path.basename(a.cmd);
    } catch (e) {
      lastErr = e;
      logger.warn(`${a.cmd} 解压失败: ${e.message}`);
      // 解压失败要把目录清空，否则下一候选可能对着残留目录报"成功"
      try {
        for (const ent of fs.readdirSync(dir)) {
          fs.rmSync(path.join(dir, ent), { recursive: true, force: true });
        }
      } catch {}
      // 非 Windows 上没有 PowerShell 兜底，失败就直接抛
      if (a.cmd === "powershell" && process.platform !== "win32") break;
    }
  }
  throw new Error(
    `所有解压方式均失败（最后一个错误: ${lastErr ? lastErr.message : "未知"}）`
  );
}

/**
 * 按可用性列出 tar 可执行文件候选：先系统 bsdtar（支持 zip），再退 PATH 里的 tar。
 *
 * 用绝对路径而不是裸 `tar`，原因见 extractArchive 的注释（PATH 里排在前面的
 * 可能是 GNU tar，装不了 zip）。系统 bsdtar 不存在时（非 Windows / 老系统）
 * 才退PATH，那台机器上没有 Git 版tar 的话 GNU tar 至少能解 tar.xz。
 */
function tarCandidates() {
  const out = [];
  if (process.platform === "win32") {
    const sys = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    if (fs.existsSync(sys)) out.push(sys);
  }
  out.push("tar");
  return out;
}

/**
 * 组装 tar 参数。
 *
 * bsdtar 必须用 cwd + 纯文件名：`-f C:\...\x.zip` 里的冒号会被解释成 `host:path`，
 * 报 "Cannot connect to C: resolve failed"。spawn 的数组参数天然隔离空格，
 * 路径里有空格不用担心。
 */
function tarArgs(cmd, file, dir) {
  const isSystemBsdtar =
    process.platform === "win32" &&
    String(cmd).toLowerCase().endsWith("tar.exe") &&
    path.isAbsolute(file);
  if (isSystemBsdtar) {
    return { args: ["-xf", path.basename(file), "-C", dir], cwd: path.dirname(file) };
  }
  return { args: ["-xf", file, "-C", dir], cwd: undefined };
}

/**
 * 解压后必须真的有东西。
 *
 * 抓到的坑：给 tar 喂一个坏包，bsdtar 在 Windows 上退出码仍是 0 —— 什么都不解、
 * 一句话不说。要是只看退出码，就会以为装好了，然后卡在「找不到主程序」这种
 * 离真正原因很远的报错上。
 */
function assertExtracted(dir, method) {
  let n = 0;
  try {
    n = fs.readdirSync(dir).length;
  } catch {
    n = 0;
  }
  if (n === 0) throw new Error(`解压后目录为空（方式: ${method}），压缩包可能已损坏`);
}

/* ---------------- 安装 / 卸载 ---------------- */

/**
 * 下载并安装（已装同版本则跳过）。
 * @param {{version?: string, force?: boolean, onProgress?: Function}} [opts]
 */
async function install(opts) {
  const o = opts || {};
  const version = o.version || PINNED_VERSION;
  const signal = o.signal;
  const report = (p) => {
    const payload = { stage: "fingerprint", ...p };
    logger.log("依赖", `[${payload.stage}] ${p.message || ""}`.trim());
    if (o.onProgress) o.onProgress(payload);
  };

  throwIfAborted(signal);
  if (!isSupported()) {
    return { ok: false, error: `当前平台（${process.platform}）暂不支持环境拟真浏览器` };
  }
  // 镜像内置（Docker）：浏览器由镜像提供，运行时再下一份既无必要，又会在 /data 卷里
  // 堆一份 400MB+ 的副本（而且预装优先级更高，下完也用不上）。直接拒绝并说明原因。
  if (preinstalledDir()) {
    return { ok: false, error: "环境拟真浏览器已由镜像内置预装，无需下载；如需更换版本请重建镜像" };
  }
  if (!o.force && installedVersion() === version && isReady()) {
    report({ message: `环境拟真浏览器已是 ${version}，跳过下载`, pct: 100 });
    return { ok: true, skipped: true, version };
  }
  if (o.force) {
    // 「重新下载」语义 = 清掉旧资源从头来：解压目录 + 下载缓存都删。
    // 缓存里的分片可能正是损坏源头（镜像重压缩 / 提前断流），留着它续传
    // 等于把坏文件接着用，所以 force 时不走断点续传。
    try {
      fs.rmSync(installDir(), { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(downloadDir(), { recursive: true, force: true });
    } catch {}
  }

  // 空 / 缺失 → 默认节点（DEFAULT_MIRROR）；未知值仍由 resolveMirrors 退回完整链，
  // 那才是「配置写错了也不该卡住下载」的安全兜底。
  const mirrorKey = String(o.mirror == null ? "" : o.mirror).trim() || DEFAULT_MIRROR;
  const mirrorLabel = mirrorKey === "auto" ? "自动测速（选最快节点）" : `指定镜像 ${mirrorKey}`;
  report({ message: `准备下载环境拟真浏览器 ${version}（约 181MB，${mirrorLabel}）`, pct: 0 });
  let file;
  try {
    const dl = await downloadAsset(version, (p) => report(p), mirrorKey, signal);
    file = dl.file;
    report({ message: `下载完成（${fmtSize(dl.size)}，来源 ${dl.mirror}），开始解压…`, pct: 100 });
  } catch (e) {
    const canceled = !!(e && e.canceled);
    report({ message: canceled ? "下载已取消" : `下载失败: ${e.message}` });
    return { ok: false, canceled, error: canceled ? "下载已取消" : e.message };
  }

  const dir = installDir();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const method = await extractArchive(file, dir);
    fs.writeFileSync(versionFile(), version, "utf8");
    // 解压成功才删包：留着没用（181MB），但失败时留着能省一次重下
    try {
      fs.rmSync(file, { force: true });
    } catch {}
    const exe = executablePath();
    if (!exe) {
      // 区分「完全没解出来」与「解出来了但 chrome.dll 坏」：后者通常是下载损坏
      // 或杀毒软件隔离了 DLL，笼统的「没找到主程序」会把用户带偏。
      const hint = hasChromeExe(dir)
        ? "检测到 chrome.exe 但同级 chrome.dll 缺失或损坏（可能下载损坏，或被杀毒软件隔离，建议加白名单后重装）"
        : "解压目录里没有浏览器主程序";
      return { ok: false, error: `${hint}（解压方式: ${method}）` };
    }
    report({ message: `安装完成: ${exe}`, pct: 100 });
    return { ok: true, version, executable: exe, method };
  } catch (e) {
    report({ message: `解压失败: ${e.message}` });
    return { ok: false, error: e.message };
  }
}

/** 卸载（删除解压目录与下载缓存） */
function uninstall() {
  // 镜像内置（Docker）：预装目录在镜像层里，删不掉也不该删 —— 删了容器重建又回来，
  // 而且会让「默认使用环境拟真浏览器」直接落空。明确拒绝，别给假成功。
  if (preinstalledDir()) {
    return { ok: false, error: "环境拟真浏览器由镜像内置预装，无法在容器内删除；如需更替请重建镜像" };
  }
  for (const d of [installDir(), downloadDir()]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch (e) {
      logger.warn(`删除 ${d} 失败: ${e.message}`);
    }
  }
  return { ok: true };
}

/**
 * 查询上游最新版本（用于「检查更新」）。
 * 走同样的镜像链；查不到就返回 null，由调用方决定是否提示。
 */
async function latestVersion() {
  const api = `https://api.github.com/repos/${REPO}/releases/latest`;
  for (const prefix of MIRROR_PREFIXES) {
    try {
      const res = await fetch(prefix + api, { headers: { Accept: "application/vnd.github+json" } });
      if (!res.ok) continue;
      const j = await res.json();
      if (j && j.tag_name) return j.tag_name;
    } catch {}
  }
  return null;
}

/**
 * 「检查更新」：只查询、不下载、不安装。
 *
 * 之前这个按钮直接调 install(force=true)，点一下就把 181MB 重新下一遍 ——
 * 语义完全错了。现在拆成纯查询：上游 latest 与本项目钉死版本、已安装版本
 * 三方对比，结论交给界面展示，装不装由用户点「重新安装」决定。
 *
 * @returns {Promise<{ok: boolean, latest: string|null, installed: string|null,
 *   pinned: string, updateAvailable: boolean, reinstallAvailable: boolean, error?: string}>}
 */
async function checkUpdate() {
  let latest = null;
  try {
    latest = await latestVersion();
  } catch (e) {
    return { ok: false, error: e.message, latest: null, installed: installedVersion(), pinned: PINNED_VERSION, updateAvailable: false, reinstallAvailable: false };
  }
  const installed = installedVersion();
  return {
    ok: true,
    latest,
    installed,
    pinned: PINNED_VERSION,
    // 上游发了比钉死版本更新的 tag（本项目不自动跟，仅提示）
    updateAvailable: !!latest && latest !== PINNED_VERSION,
    // 已安装版本与钉死版本不一致（含未安装）→ 点「重新安装」可对齐
    reinstallAvailable: installed !== PINNED_VERSION,
  };
}

/* ---------------- 启动参数 ---------------- */

/**
 * 环境拟真浏览器的启动参数。
 *
 * 注意**不要**在这里设 UA：UA 必须由 --fingerprint 的种子统一生成，
 * 再叠加一层我们自己的 UA 就会退化成「应用层硬改」那条死路（CH 对不上）。
 * GPU 环境特征上游只支持 Linux，Windows 上仍由 stealth.js 的 WebGL 补丁兜底。
 */
function buildArgs(o) {
  const opts = o || {};
  const args = [
    `--fingerprint=${opts.seed >>> 0}`,
    `--fingerprint-platform=${opts.platform || platformName()}`,
  ];
  if (opts.brand) args.push(`--fingerprint-brand=${opts.brand}`);
  if (opts.brandVersion) args.push(`--fingerprint-brand-version=${opts.brandVersion}`);
  const cores = Number(opts.hardwareConcurrency) || 0;
  if (cores > 0) args.push(`--fingerprint-hardware-concurrency=${cores}`);
  // 与区域锁定（中国大陆）保持一致，避免 IP 在东八区而浏览器报 UTC
  if (opts.timezone !== false) args.push(`--timezone=${opts.timezone || "Asia/Shanghai"}`);
  if (opts.acceptLang !== false) args.push(`--accept-lang=${opts.acceptLang || "zh-CN,zh"}`);
  if (opts.lang !== false) args.push(`--lang=${opts.lang || "zh-CN"}`);
  return args;
}

module.exports = {
  REPO,
  PINNED_VERSION,
  MIRROR_PREFIXES,
  platformName,
  assetName,
  releaseUrl,
  isSupported,
  installDir,
  preinstalledDir,
  installedVersion,
  findExecutable,
  executablePath,
  isReady,
  status,
  seedFor,
  install,
  uninstall,
  latestVersion,
  checkUpdate,
  buildArgs,
  // 打桩/诊断用
  downloadOnce,
  downloadParallel,
  downloadSegment,
  listParts,
  probeTotal,
  extractArchive,
  fmtSize,
  isValidPeFile,
  hasChromeExe,
  MIRROR_OPTIONS,
  MIRROR_KEYS,
  IP_DIRECT,
  PARALLEL_CONNECTIONS,
  PART_SUFFIX,
  DEFAULT_MIRROR,
  resolveMirrors,
  sha256File,
  mirrorLatency,
};
