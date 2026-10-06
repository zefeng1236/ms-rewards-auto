/**
 * 环境拟真浏览器（可选增强）
 *
 * 用的是 Chromix（xiaozhou26，基于 Ungoogled Chromium 的 216-patch 定制版，BSD-3）：
 *   https://github.com/xiaozhou26/Chromix
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

/**
 * ============================================================================
 * 内核注册表（2026-10-06）
 * ============================================================================
 *
 * 为什么要多内核：Chromix 154 换掉 fingerprint-chromium 150 是因为 150 有上游
 * issue #94（canvas 读像素 SIGSEGV）。但**换掉不等于删掉** —— 上游随时可能修好，
 * 用户也可能出于某些原因想要旧的。所以两个内核的完整能力都要留着，让用户自选。
 *
 * 架构上刻意做成「**注册表 + 按 engine 取值**」而不是到处 `if (engine === ...)`：
 * 两个上游的差异点有五处（repo / tag 前缀 / 资产名 / 平台映射 / 启动 flag），
 * 散在 if 里必然漏一处 —— 而漏掉 tag 前缀只会静默下载 404，漏掉 flag 名会让
 * 时区/语言**被静默忽略**（不报错，只是露馅，最难查）。
 *
 * ⚠️ 150 的已知缺陷就在 available:false 的 reason 里，UI 必须原样展示给用户，
 *    别自己编措辞（那是实测结论，见 MEMORY-反检测与指纹.md）。
 */
const ENGINES = {
  /**
   * Chromix 154 —— 默认内核。216 patches，活跃维护，实测三个目标域零崩溃。
   */
  chromix: {
    key: "chromix",
    label: "Chromix 154",
    repo: "xiaozhou26/Chromix",
    version: "154.0.8037.57",
    available: true,
    // Chromix 的 tag 带 v 前缀，且资产名**不含**版本号
    tag: (v) => `v${v}`,
    asset: (platform) =>
      platform === "win32"
        ? "chromix-win-x64.zip"
        : platform === "linux"
        ? "chromix-linux-x64.zip"
        : null,
    notes: "默认内核。canvas / WebGL / 时区语言伪装完整，实测零崩溃。",
  },

  /**
   * adryfish/fingerprint-chromium 150 —— 备用内核，**当前不可选**。
   *
   * 保留它的全部代码路径（下载 / 解压 / 启动 / 版本校验），只把 available 置 false
   * 让 UI 禁用。上游 issue #94 修好后把 available 改 true 即可，无需其他改动。
   */
  fp150: {
    key: "fp150",
    label: "fingerprint-chromium 150",
    repo: "adryfish/fingerprint-chromium",
    version: "150.0.7871.186",
    available: false,
    // 已知缺陷（上游 issue #94，2026-10-03 报出未修）：开启 canvas 伪装时，
    // 页面调 getImageData / WebGL readPixels 读回像素会让渲染进程 SIGSEGV
    // （PC 固定在 chromium+0xf2da5fb，fault addr 是 tagged V8 heap 指针）。
    // 崩溃有概率性，单次测试不作数 —— 项目每天真会访问的 login.live.com /
    // rewards.bing.com / rewards.bing.com/earn 实测随机崩。
    unavailableReason:
      "存在已知崩溃缺陷：开启 canvas 伪装时，页面读取像素（getImageData / WebGL readPixels）" +
      "会导致浏览器渲染进程崩溃（上游 issue #94，暂无补丁）。项目每天访问的登录与 Bing 页面" +
      "正落在触发路径上，可能出现随机闪退。",
    // 旧上游：tag 无 v 前缀，资产名**内嵌**版本号且带 build 编号后缀
    tag: (v) => `${v}`,
    asset: (platform, v) =>
      platform === "win32"
        ? `ungoogled-chromium_${v}-1.1_windows_x64.zip`
        : platform === "linux"
        ? `ungoogled-chromium-${v}-1-x86_64_linux.tar.xz`
        : null,
    notes: "旧内核，备用保留。等上游修好 canvas 崩溃后开放选择。",
  },
};

/** 默认内核 key（写进配置层的 engine 缺省值） */
const DEFAULT_ENGINE = "chromix";

/** 校验 engine key 合法；非法/缺失回落默认内核。配置层与守卫都依赖它。 */
function normalizeEngine(key) {
  const k = String(key == null ? "" : key).trim();
  return Object.prototype.hasOwnProperty.call(ENGINES, k) ? k : DEFAULT_ENGINE;
}

/** 取内核定义（未知 key 回落默认，不抛 —— 配置文件可能来自旧版本） */
function engine(key) {
  return ENGINES[normalizeEngine(key)];
}

/** 当前内核的钉死版本（保持旧导出名兼容：模块里大量地方用 PINNED_VERSION） */
function pinnedVersion(key) {
  return engine(key).version;
}

/** 默认内核的钉死版本 —— 兼容旧调用点（无 engine 参数时一律用默认内核） */
const PINNED_VERSION = ENGINES[DEFAULT_ENGINE].version;


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
 * macOS 包未签名未 notarize，本项目暂不支持（Chromix 上游有提供）。
 *
 * 资产名与上游 release 一一对应（用 gh api 核对，别照抄旧项目的命名）：
 *   v154.0.8037.57 → chromix-win-x64.zip / chromix-linux-x64.zip
 * 同一 tag 下不同平台可能对应不同源码 SHA 与构建任务，这是上游的既定做法。
 * @returns {string|null} null 表示该平台不提供
 */
function assetName(version, engineKey) {
  const e = engine(engineKey);
  return e.asset(process.platform, version || e.version);
}

function isSupported(engineKey) {
  return assetName(null, engineKey) !== null;
}

/**
 * release 下载地址。
 * ⚠️ tag 前缀与资产名规则**两个上游相反**（Chromix: v前缀/名不含版本；
 *    fp150: 无前缀/名内嵌版本+build编号），都封装在 ENGINES 的 tag()/asset() 里，
 *    这里只做拼接 —— 别在这里写死任何一条规则。
 */
function releaseUrl(version, engineKey) {
  const e = engine(engineKey);
  const v = version || e.version;
  const asset = e.asset(process.platform, v);
  if (!asset) return null;
  return `https://github.com/${e.repo}/releases/download/${e.tag(v)}/${asset}`;
}

/* ---------------- 安装位置 ---------------- */

/**
 * 安装目录。**按内核分目录**（2026-10-06 多内核）。
 *
 * 目录名保留历史的 `fingerprint-chromium` 形式（没跟上游改名）—— 目录名同时是
 * 「已装版本」的判定依据（version.txt + 目录内二进制），一改名就会让所有存量用户
 * 的已装环境被判为「不可用」而重新下载 500MB+。里面的东西是 Chromix，
 * 只是目录名沿用历史。
 *
 * ⚠️ 必须按内核分目录（`fingerprint-chromium/chromix` vs `fingerprint-chromium/fp150`）：
 *   两个内核的资产格式不同（zip vs zip+tar.xz）、启动 flag 不同，解压产物结构也不同。
 *   共用目录会互相覆盖 —— 用户切回 154 时可能被 150 的残留顶掉，或反过来。
 *   分目录后切换只是「换一个子目录读 version.txt」，两边可同时存在。
 */
function installDir(engineKey) {
  const base = sp.resolve("fingerprint-chromium");
  const e = engine(engineKey);
  // 默认内核仍放 base 根目录：存量用户的已装 154 不需要迁移（迁移要重下 200MB，
  // 且迁移期间软件不可用）。只在**非默认内核**时才建子目录。
  return e.key === DEFAULT_ENGINE ? base : path.join(base, e.key);
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

/**
 * 当前生效的内核 key（模块级）。
 *
 * 为什么要用模块级状态而不是给每个函数加 engine 参数：这条链路上有 **20+ 个**
 * 函数涉及「装的是哪个内核 / 版本号是多少 / 目录在哪」，
 * 逐个加参数会让 90% 的调用点都要改、且极易漏一个（漏了就是静默用错内核）。
 * 这里让主进程在启动 / 配置变更时调一次 `setEngine()`，其余函数一律读它。
 *
 * 守卫会钉住这个机制：`setEngine` 必须被主进程在启动路径上调用过
 * （否则回落默认内核 —— 不会错，但用户选了 150 却静默用 154）。
 */
let CURRENT_ENGINE = DEFAULT_ENGINE;

/** 设置当前生效内核（主进程启动时 + 用户切换时调用）。非法 key 静默回落默认。 */
function setEngine(key) {
  const next = normalizeEngine(key);
  CURRENT_ENGINE = next;
  return next;
}

function currentEngine() {
  return CURRENT_ENGINE;
}

/** 当前内核的钉死版本（供旧调用点用：之前是直接读常量 PINNED_VERSION） */
function currentPinned() {
  return ENGINES[CURRENT_ENGINE].version;
}

function versionFile(engineKey) {
  return path.join(installDir(engineKey), "version.txt");
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
 * 后台静默下载的**独立**下载目录（2026-10-06）。
 *
 * 为什么必须与 downloadDir 物理隔离，而不是只加「正在下载就别重复触发」的检查：
 *   `downloadAsset` 第二轮失败重试时会**清场** —— 删掉目标 zip 和它的全部分片。
 *   手动下载与后台下载一旦共用目录，后台那 16 个分片正在写的文件会被手动那轮
 *   的清场直接删掉 → 后台报 `ENOENT: ...part0` → 两边互相重试，
 *   202MB 反复下三遍（用户 2026-10-05 22:45 的实测日志就是这么炸的）。
 *   路径隔离是**结构性**的根治，检查还可能被时序绕过，隔离不会。
 */
function stagedDownloadDir() {
  return stagedDownloadDirFor(CURRENT_ENGINE);
}

/**
 * 后台暂存目录：放着下一版内核的解压产物，闲时再切到 installDir。
 *
 * 与 installDir 平级，路径 `storage/fingerprint-chromium-staging`。后台下载
 * 全程只写这里，绝不碰 installDir —— 这样**正在用旧内核跑的任务**的文件
 * 句柄、目录锁都不会被破坏。
 *
 * ⚠️ 多内核后默认内核仍用根目录（存量用户的 staging 不失效），
 *   非默认内核用 `-<key>` 后缀 —— 否则用户装 150 的后台下载会把 154 的
 *   staging 覆盖掉，切换后拿到的是另一个内核的产物。
 */
function stagingDir(engineKey) {
  const e = engine(engineKey);
  const base = sp.resolve("fingerprint-chromium-staging");
  return e.key === DEFAULT_ENGINE ? base : `${base}-${e.key}`;
}

function stagingVersionFile(engineKey) {
  return path.join(stagingDir(engineKey), "version.txt");
}

/**
 * 读 staging 里的版本号；staging 不存在/无 version.txt 返回 null。
 * 调用方据此决定要不要尝试切换、后台要不要开始下载。
 */
function stagedVersion(CURRENT_ENGINE) {
  try {
    const v = fs.readFileSync(stagingVersionFile(CURRENT_ENGINE), "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * 正在运行的指纹浏览器上下文数（openContext isFp=true 进入 +1，
 * closeContext isFp=true 离开 -1）。commitStagedInstall 拿它当"当前没人用
 * 旧内核"的判据之一，确保替换不打断正在跑的任务。
 */
let _fpContextCount = 0;
function fpContextActive() {
  return _fpContextCount;
}
function notifyFpContext(delta) {
  const d = Number(delta) || 0;
  _fpContextCount = Math.max(0, _fpContextCount + d);
  return _fpContextCount;
}

/**
 * 已安装版本（未安装返回 null）。
 *
 * 预装目录优先 —— 与 executablePath() 的优先级保持同源：既然实际用的是预装的
 * 那份可执行文件，报出来的版本就必须是它，否则会出现「跑的是 A 版本、界面显示 B 版本」
 * 的错位（桌面版可能同时存在运行时下载 + 预装两种来源）。
 */
function installedVersion() {
  const candidates = [preinstalledVersionFile(), versionFile(CURRENT_ENGINE)].filter(Boolean);
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

/**
 * 已安装且版本与当前内核钉死版本一致的可执行文件路径；不一致返回 null。
 *
 * ⚠️ **版本必须校验**（2026-10-05 加）：原先只看「exe 存在」就算就绪，于是
 * 换上游（fingerprint-chromium 150 → Chromix 154）之后，装着旧内核的用户
 * 会被判为「可用」而继续用 —— 而 150 恰恰是有 issue #94 崩溃缺陷的那个版本。
 * 存量用户升级本软件后会被引导重新下载，这是期望行为。
 *
 * ⚠️ 多内核后这里校验的是**当前 engine 的**钉死版本：切到 150 就比对 150 的版本号，
 * 装在 fp150 子目录里的那份用 154 的版本号去比一定不过（正确行为）。
 *
 * Docker 预装路径同样校验：镜像里写 version.txt 的是构建时的版本，
 * 镜像没重建就不该用（selfcheck 也有守卫钉 Dockerfile 与 ENGINES 一致）。
 */
function executablePath() {
  const pinned = currentPinned();
  /** 读目录里的 version.txt；读不到（缺文件/空）返回 null */
  const readVer = (dir) => {
    try {
      if (dir === preinstalledDir()) return fs.readFileSync(preinstalledVersionFile(), "utf8").trim() || null;
      return fs.readFileSync(versionFile(CURRENT_ENGINE), "utf8").trim() || null;
    } catch {
      return null;
    }
  };
  // 镜像预装优先：Docker 场景运行时不需要下载，直接用它。
  const pre = preinstalledDir();
  if (pre) {
    const exe = findExecutable(pre);
    if (exe) {
      const v = readVer(pre);
      if (v && v !== pinned) {
        logger.warn(
          `镜像预装环境拟真浏览器版本为 ${v}，与钉死的 ${pinned} 不符，已忽略（需重建镜像）`
        );
      } else {
        return exe;
      }
    }
  }
  const dir = installDir(CURRENT_ENGINE);
  const exe = findExecutable(dir);
  if (!exe) return null;
  const v = readVer(dir);
  if (v && v !== pinned) {
    logger.warn(
      `已安装的环境拟真浏览器为 ${v}，与钉死的 ${pinned} 不符，判为不可用` +
        `（可在设置页点「重新下载」升级）`
    );
    return null;
  }
  // 只信 version.txt 不够：解压中断/换包会留下「多个版本目录并存」，而
  // findExecutable 是广度优先、先撞到哪个算哪个 —— 于是 version.txt 写着新版、
  // 实际返回旧目录里的 exe（实测踩过：拷进 Chromix 后仍返回 fp150 的 exe）。
  //
  // 但不能无条件要求「exe 路径含版本号」：本项目 install() 解压出来的形态是
  // `chromix/chrome.exe`（Chromix 的 zip 内层目录固定叫 chromix，不含版本号）。
  // 所以只在**确实存在多个候选目录**时才用「路径含版本号」当第二道判据。
  //
  // ⚠️ 多内核后必须**排除非当前引擎的子目录**（fingerprint-chromium/fp150 等）：
  //   那是另一个内核的安装位（用户装了 150 也留着 154 时就在这儿），不是「版本目录」。
  //   不排除的话切回默认内核会误报「存在多个版本」。
  const otherEngineDirs = new Set(
    Object.values(ENGINES)
      .map((e) => e.key)
      .filter((k) => k !== CURRENT_ENGINE)
      .map((k) => path.basename(installDir(k)))
  );
  const dirs = (() => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .filter((e) => !otherEngineDirs.has(e.name))
        .map((e) => path.join(dir, e.name));
    } catch {
      return [];
    }
  })().filter((d) => !!findExecutable(d));
  if (dirs.length > 1 && !dirs.some((d) => d.includes(pinned) && findExecutable(d) === exe)) {
    logger.warn(
      `安装目录里存在多个版本（${dirs.length} 个候选），实际找到的可执行文件不在 ${pinned} 目录内` +
        `（${exe}），判为不可用（建议清理安装目录后重新下载）`
    );
    return null;
  }
  return exe;
}

function isReady() {
  return !!executablePath();
}

/** 供 IPC / UI 展示的状态（async：镜像下拉要带实测延迟，见 mirrorLatency） */
async function status() {
  const exe = executablePath();
  const pre = preinstalledDir();
  const cur = ENGINES[CURRENT_ENGINE];
  const pinned = currentPinned();
  const stagedV = stagedVersion(CURRENT_ENGINE);
  const stagedReady = stagedV === pinned && findExecutable(stagingDir(CURRENT_ENGINE));
  return {
    supported: isSupported(CURRENT_ENGINE),
    platform: process.platform,
    ready: !!exe,
    executable: exe,
    version: installedVersion(),
    pinned,
    installDir: installDir(CURRENT_ENGINE),
    // 多内核：把可选内核清单下发给 UI。UI 只负责展示与提交 key，
    // 不可用的（available:false）要显示 unavailableReason 而不是直接隐藏 ——
    // 隐藏会让用户以为「没这个内核」，看不到「等它修好就能用」这条路径。
    engines: engineCatalog(),
    // 镜像内置（Docker）：界面据此隐藏「下载/重新下载/删除」，避免用户在容器里
    // 点一下就把 134MB 拉到 /data 卷上（明明已经预装好了，纯属白折腾）。
    preinstalled: !!pre,
    downloadUrl: releaseUrl(null, CURRENT_ENGINE),
    // 预装场景不需要镜像源下拉，跳过测速探测（省掉最长 4s 的启动等待）
    mirrors: pre ? [] : await mirrorOptionsWithLatency(),
    // 0.14 起：后台 staging 信息 —— UI 据此显示"后台下载中 / 等待闲时替换 / 已是最新"
    staged: {
      version: stagedV,
      ready: !!stagedReady,
      // installed 已是 pinned 时返回 true（说明 staging 是上一次清扫的产物，不需要再切）
      committed: installedVersion() === pinned && preinstalledDir() == null,
    },
    // 0.14 起：当前活跃指纹浏览器上下文数（用户查看 + UI 角标）
    fpContextCount: fpContextActive(),
  };
}

/* ---------------- 内核清单 ---------------- */

/**
 * 可选内核清单（下发给 UI）。
 *
 * **只导出 UI 需要的字段** —— repo / tag / asset 规则这些是实现细节，
 * 漏出去只会让前端有机会拼出错 URL。每个条目都带 `installed`（该内核是否已装），
 * 这样 UI 能把「已装的」和「没装的」区分开，而不是只显示版本号让人猜。
 */
function engineCatalog() {
  return Object.values(ENGINES).map((e) => ({
    key: e.key,
    label: e.label,
    version: e.version,
    available: !!e.available,
    // 不可用时给原因；UI 必须原样展示（措辞是实测结论，见 ENGINES 里的注释）
    unavailableReason: e.available ? "" : e.unavailableReason || "",
    notes: e.notes || "",
    installed: installedVersionFor(e.key) === e.version,
    default: e.key === DEFAULT_ENGINE,
  }));
}

/** 指定内核的已装版本（供清单用；未装返回 null） */
function installedVersionFor(engineKey) {
  const f = versionFile(engineKey);
  try {
    return fs.readFileSync(f, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** 切换当前内核。返回生效的 key（非法 key 静默回落默认）。 */
function selectEngine(key) {
  return setEngine(key);
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
    const asset = assetName(version, CURRENT_ENGINE);
    if (!asset) return { total: 0, sha256: null };
    const cur = ENGINES[CURRENT_ENGINE];
    const api = `https://api.github.com/repos/${cur.repo}/releases/tags/${cur.tag(version || cur.version)}`;
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
 * 并发连接数（自适应，2026-10-03 实测定档）。
 *
 * 单连接下载实测（181MB 的 ungoogled-chromium，同一台机器同一时刻）：
 *   直连（hosts 优选 IP）单连接 0.63 MiB/s → 8 连接 1.46 → **16 连接 5.51**
 *   gh-proxy 镜像  单连接 0.52 MiB/s → 6 连接 1.20
 * 结论：单连接被TCP 流控与CDN 单流限速卡住，**并发是最有效的提速手段**。
 *
 * 取区间 4~16 而不是固定 16：
 *   - 下限 4：太少的并发等于没提速（实测 2 线程只比单连接快 1.6×），
 *     但服务端对低于 4 的并发普遍有"非浏览器"风险标记；
 *   - 上限 16：超过 16 实测增益趋平（16 连接已达单连接的 8.7×），
 *     32+ 还会被部分 gh-proxy 节点当作异常流量限速。
 *
 * 自适应策略（pickConnections）：
 *   < 8MB  → 4 线程（小包分太细收益为 0；4 线程 10 秒内搞定）
 *   < 64MB → 8 线程（中等包，折中档）
 *   ≥ 64MB → 16 线程（大包才把上限用满）
 *
 * "依据服务器限制调整"：分片首段拿到 200 而不是 206 时 → noRange，
 * downloadAsset 捕获后切回 downloadOnce 单连接，这条降级链不变。
 */
const MIN_PARALLEL_CONNECTIONS = 4;
const MAX_PARALLEL_CONNECTIONS = 16;

/**
 * 给定文件总长返回合理的并发连接数。详见 MIN/MAX 注释。
 * @param {number} total 字节（0/负数 → 1）
 * @returns {number} 1..MAX_PARALLEL_CONNECTIONS
 */
function pickConnections(total) {
  if (!total || total <= 0) return 1;
  const mb = total / (1024 * 1024);
  if (mb < 8) return MIN_PARALLEL_CONNECTIONS;
  if (mb < 64) return 8;
  return MAX_PARALLEL_CONNECTIONS;
}

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
  // 自适应并发：按文件大小在 4..16 之间挑档位（pickConnections 注释），不再写死 16
  const n = pickConnections(total);
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

  /**
   * ⚠️ 必须自建一个「本轮分片共享」的 AbortController（2026-10-06 修）。
   *
   * `Promise.all` 的语义是「任一 reject 就整体 reject」，但它**不会取消其余
   * 仍在 pending 的分片** —— 那些分片的 HTTP 请求继续跑、继续回调 onBytes、
   * 继续往上抛进度。外层 catch 到错误换下一个镜像源之后，上一个源的僵尸分片
   * 还在上报进度，于是界面出现**两条进度条一前一后交替跳**，其中那条永远到不了
   * 100%（看着像卡住）。用户 2026-10-05 23:40 的日志就是这么炸的：
   *   cdn 源 aborted → 切 v4 → 慢的那组 136MB→164MB 还在涨。
   *
   * 注意 downloadSegment 自己是**有** AbortController 的，但它只桥接外部传入的
   * signal；换源走的是「Promise.all 被 reject」这条路，外部 signal 从头到尾没被
   * abort 过 —— 那层保护形同虚设。所以这里必须自建一个本轮私有的，再把外部
   * signal 桥接进来，两者任一触发都掐掉全部分片。
   */
  const roundAc = new AbortController();
  const onOuterAbort = () => {
    try {
      roundAc.abort();
    } catch {}
  };
  if (signal) {
    if (signal.aborted) onOuterAbort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  try {
    await Promise.all(
      segs.map(async (s) => {
        if (s.got === s.end - s.start + 1) return; // 已完成，跳过
        await downloadSegment(url, s.file, s.start, s.end, (n2) => {
          s.got += n2;
          emit(false);
        }, roundAc.signal, ip);
        emit(false);
      })
    );
  } catch (e) {
    // 换源/失败前先掐掉本轮所有还在跑的分片，杜绝僵尸进度
    try {
      roundAc.abort();
    } catch {}
    throw e;
  } finally {
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
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
 *
 * @param {object} [opts]
 * @param {boolean} [opts.staged] true=后台静默下载，用独立目录 stagedDownloadDir()
 *   （见该函数注释：两路下载共用目录时，一方的「失败清场」会互删对方分片）
 */
async function downloadAsset(version, onProgress, mirror, signal, opts) {
  throwIfAborted(signal);
  const asset = assetName(version, CURRENT_ENGINE);
  const raw = releaseUrl(version);
  if (!asset || !raw) throw new Error(`当前平台（${process.platform}）不提供环境拟真浏览器`);
  const mirrors = await resolveMirrors(mirror);

  // 后台静默下载走独立目录（见 stagedDownloadDir 注释：清场会互删分片）
  const dir = opts && opts.staged ? stagedDownloadDir() : downloadDir();
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

  // hosts 优选 IP：只在用户**显式**选了 ip-direct 时才接管解析。
  // 不要因为 hosts 看着像 127.0.0.1 就自动接管 —— 那个地址很可能是 Watt Toolkit /
  // Steam++ 等加速器的本地代理监听端口，绕过它等于把本来能用的链路掐断。
  // 真正"连不通"的判定应该走真实 HTTP 探测（gh-proxy 失败 ⇒ 链已穷尽 ⇒ 让用户
  // 自己来 ip-direct 档重试），不要替用户做"看 hosts 接管解析"的预判。
  const wantPinned = mirror === IP_DIRECT;
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
  const version = o.version || currentPinned();
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
      fs.rmSync(installDir(CURRENT_ENGINE), { recursive: true, force: true });
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

  const dir = installDir(CURRENT_ENGINE);
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

/**
 * 卸载（删除解压目录与下载缓存）。
 *
 * @param {object} [opts]
 * @param {string} [opts.engine] 指定要卸载哪个内核（默认当前内核）。
 *   多内核后用户可能想「删掉备用内核但保留正在用的」或反过来，
 *   所以这个参数是必须的 —— 只有「删当前」的话，切换过内核后就再也没法
 *   清理另一个（目录留在磁盘上白占 500MB+）。
 * @param {boolean} [opts.keepStaging] 保留 staging（默认 false，一并清）
 * @returns {{ok: boolean, error?: string, removed?: string[]}}
 */
function uninstall(opts) {
  // 镜像内置（Docker）：预装目录在镜像层里，删不掉也不该删 —— 删了容器重建又回来，
  // 而且会让「默认使用环境拟真浏览器」直接落空。明确拒绝，别给假成功。
  if (preinstalledDir()) {
    return { ok: false, error: "环境拟真浏览器由镜像内置预装，无法在容器内删除；如需更替请重建镜像" };
  }
  const key = (opts && opts.engine) || CURRENT_ENGINE;
  const targets = [installDir(key), downloadDir()];
  if (!(opts && opts.keepStaging)) targets.push(stagingDir(key));
  // ⚠️ 删非默认内核时**顺带清掉它专属的下载缓存目录**：
  //   fp-download-staged-fp150 这类分片残留没清的话，
  //   磁盘上会留一份「下了一半的 200MB」，用户不会知道它是什么。
  if (key !== DEFAULT_ENGINE) targets.push(stagedDownloadDirFor(key));

  /**
   * ⚠️⚠️ 删一个目录前必须先把它内部**其它内核的子目录搬出去**（2026-10-06）。
   *
   * 目录结构是「默认内核在根、其它内核在子目录」：
   *   fingerprint-chromium/          ← chromix（默认）
   *   fingerprint-chromium/fp150/    ← fp150（在上面那层的**里面**）
   *
   * 于是 `rmSync(installDir('chromix'), {recursive:true})` 会**把 fp150 一起删掉** ——
   * 症状是「卸载旧内核 154，结果 150 的目录也消失了」，而 150 明明是本次要保留的目标。
   * 反过来（删 fp150 子目录）不会影响根目录，所以这个坑只在一个方向上出现，
   * 极难靠直觉发现。
   *
   * 解法：删非默认内核时，直接删它自己的子目录即可（不碰根）；
   * 删默认内核时，把要保留的其它内核子目录先搬到 storage 根下同级位置。
   */
  const keptChildren = [];
  if (key === DEFAULT_ENGINE) {
    const base = installDir(DEFAULT_ENGINE);
    for (const e of Object.values(ENGINES)) {
      if (e.key === DEFAULT_ENGINE) continue;
      const child = path.join(base, e.key);
      if (!fs.existsSync(child)) continue;
      // 暂存到 storage 根下（与 base 同级），避开 base 的递归删除
      const parked = sp.resolve(`${path.basename(base)}-${e.key}-keep`);
      try {
        if (fs.existsSync(parked)) fs.rmSync(parked, { recursive: true, force: true });
        fs.renameSync(child, parked);
        keptChildren.push({ key: e.key, from: child, to: parked });
      } catch (e) {
        // 搬不动就**放弃删根目录**：宁可让用户手动清磁盘，也不能连带删掉另一个内核
        logger.warn(
          `卸载默认内核时无法搬走 ${e.key}（${e.message}），已取消删除以免连带删除该内核`
        );
        return {
          ok: false,
          removed: [],
          error: `无法保留 ${e.label} 的安装目录，已取消删除（请关闭正在运行的浏览器后重试）`,
        };
      }
    }
  }

  const removed = [];
  for (const d of targets) {
    if (!d) continue;
    try {
      if (!fs.existsSync(d)) continue;
      fs.rmSync(d, { recursive: true, force: true });
      removed.push(d);
    } catch (e) {
      logger.warn(`删除 ${d} 失败: ${e.message}`);
    }
  }
  // 把搬出去的子目录放回原位（此刻 base 已删或已空，路径是干净的）
  for (const k of keptChildren) {
    const restored = path.join(installDir(DEFAULT_ENGINE), k.key);
    try {
      fs.mkdirSync(path.dirname(restored), { recursive: true });
      fs.renameSync(k.to, restored);
    } catch (e) {
      // 还原失败**绝不能悄悄吞掉** —— 用户会以为内核还在，实际目录在 storage 根下
      logger.error(
        `卸载默认内核后 ${k.key} 的目录还原失败（${e.message}），现位于 ${k.to}，` +
          `可手动移回 ${restored}`
      );
      return {
        ok: true,
        removed,
        error: `部分内核目录未能还原：${k.key} 现位于 ${k.to}`,
      };
    }
  }
  if (keptChildren.length) {
    logger.info(`卸载默认内核时保留了 ${keptChildren.map((k) => k.key).join("、")} 的安装目录`);
  }
  return { ok: true, removed };
}

/**
 * 后台静默下载的缓存目录（按内核分目录）。
 *
 * ⚠️ 默认内核是 `fp-download-staged`（**不是** `fp-download`）——
 *   `fp-download` 是**手动下载**的目录，两者绝不能撞：撞了之后
 *   `downloadAsset` 第二轮失败重试的清场会删掉对方正在写的分片
 *   （2026-10-05 用户日志：202MB 下了三遍，详见 MEMORY）。
 *   非默认内核加 `-<key>` 后缀，防止两个内核的后台下载互删。
 */
function stagedDownloadDirFor(key) {
  const e = engine(key);
  return e.key === DEFAULT_ENGINE
    ? sp.resolve("fp-download-staged")
    : sp.resolve(`fp-download-staged-${e.key}`);
}

/**
 * 切换当前内核，并在「只保留单个内核」模式下**卸载其它已装内核**（2026-10-06）。
 *
 * ## 为什么要自动卸载
 *
 * 每个内核解压后约 500MB。两个都留着就是 1GB 常驻磁盘 —— 而绝大多数用户
 * 只用一个。默认开启单内核模式，切换时把旧的卸掉；用户想要「两个都留着随时切」
 * 可以把这个开关关掉（设置页有）。
 *
 * ## 几条安全边界（都是踩过才知道的）
 *
 * 1. **绝不动当前 kernel 之外的「预装」目录** —— Docker 镜像层删不掉也不该删。
 * 2. **有活跃指纹上下文时不动手** —— 正在跑的任务握着 exe 的文件句柄，
 *    删了会让那个任务崩掉。返回 ok:false + 原因，下次切内核时再试。
 * 3. **只卸「已装且不是目标内核」的** —— 没装的目录不存在，删了是空操作还白写日志。
 * 4. **目标内核自己不能被卸** —— 切过去之后它就是当前内核，必须留着。
 *
 * @param {string} key 目标内核
 * @param {{singleOnly?: boolean}} [opts] singleOnly=false 时保留其它内核
 * @returns {{ok: boolean, engine: string, removed?: string[], reason?: string}}
 */
function switchEngine(key, opts) {
  const next = normalizeEngine(key);
  const singleOnly = !(opts && opts.singleOnly === false);
  if (preinstalledDir()) {
    // Docker：预装内核不可切换也不可删（镜像层），直接告知而不是假装成功
    return { ok: false, engine: next, reason: "容器内由镜像内置预装，无法切换或删除内核" };
  }
  setEngine(next);

  if (!singleOnly) return { ok: true, engine: next, removed: [] };

  const removed = [];
  const skipped = [];
  for (const e of Object.values(ENGINES)) {
    if (e.key === next) continue; // 目标内核自己不动
    const ver = installedVersionFor(e.key);
    if (!ver) continue; // 没装 → 无需卸
    // 有活跃上下文时保留：删了会断掉正在跑的任务。留着下次再试。
    if (fpContextActive() > 0) {
      skipped.push(e.label);
      continue;
    }
    const r = uninstall({ engine: e.key });
    if (r.ok) removed.push(e.label);
    else skipped.push(`${e.label}(${r.error || "删除失败"})`);
  }
  if (skipped.length) {
    logger.info(
      `切换到 ${ENGINES[next].label}，但以下内核暂未卸载：${skipped.join("、")}` +
        (fpContextActive() > 0 ? "（有任务正在使用它们，任务结束后再切换一次即可）" : "")
    );
  } else if (removed.length) {
    logger.info(`切换到 ${ENGINES[next].label}，已卸载旧内核：${removed.join("、")}`);
  }
  return { ok: true, engine: next, removed };
}

/**
 * 一次性迁移：清理「旧上游内核」的残留（2026-10-06）。
 *
 * ## 背景
 *
 * 0.14.5 之前，环境拟真浏览器的安装目录是**没有内核子目录**的
 * `storage/fingerprint-chromium/`（0.14.4 及更早都是这个形态，含 fp150）。
 * 0.14.6 起按内核分目录，而**默认内核 Chromix 刻意继续用根目录**（存量用户
 * 不用重下 200MB）。于是会出现这个组合：
 *
 *   - 用户从 0.14.4（装的是 fp150）升到 0.14.6
 *   - 根目录里躺着的仍是 **fp150**，`executablePath()` 会因版本不符判「不可用」
 *     → 引导重装（这是对的），但**旧文件一直占着 ~500MB 不清理**。
 *   - 而且用户若切到 fp150 内核，会发现「已装」但一跑就崩。
 *
 * ## 判定的安全边界
 *
 * 只在**根目录版本号与默认内核不符，且根目录不是默认内核版本**时才清理 ——
 * 也就是「确定根目录里是旧内核」才动手。根目录版本正确时**绝不能碰**
 * （那是用户正在用的 154，删了就是灾难）。
 *
 * @returns {{ok: boolean, removed?: string[], reason?: string}}
 */
function migrateAwayLegacyEngine() {
  if (preinstalledDir()) return { ok: true, removed: [] }; // Docker：镜像层不能动
  const base = installDir(DEFAULT_ENGINE); // 根目录
  const want = ENGINES[DEFAULT_ENGINE].version;
  let v = "";
  try {
    v = fs.readFileSync(path.join(base, "version.txt"), "utf8").trim();
  } catch {}
  if (!v) return { ok: true, removed: [] }; // 没装 / 读不到 → 无从判断，不动
  if (v === want) return { ok: true, removed: [] }; // 正是当前内核 → 绝不能删

  // 到这里根目录里确定是「非当前内核的旧版本」。先找出它属于哪个已知内核，
  // 让日志能说清删的是什么（便于用户对照备份/反馈）。
  const owner = Object.values(ENGINES).find((e) => e.version === v);

  // 先看有没有正在跑的指纹上下文：有就别删（删了会断掉正在跑的任务的文件句柄）。
  if (fpContextActive() > 0) {
    return {
      ok: false,
      removed: [],
      reason: `仍有 ${fpContextActive()} 个指纹浏览器在运行，稍后会自动清理`,
    };
  }

  // 把 legacy 根目录挪到一边再删：比直接 rmSync 稳（rm 失败时用户数据还在，
  // 只是变成「一堆认不出的文件」，比「删一半删不动」好排查）。
  const stash = `${base}.legacy-${v}`;
  const removed = [];
  try {
    fs.renameSync(base, stash);
  } catch (e) {
    logger.warn(`迁移清理：无法移走旧内核目录（${e.message}），跳过清理`);
    return { ok: false, removed: [], reason: e.message };
  }
  try {
    fs.rmSync(stash, { recursive: true, force: true });
    removed.push(stash);
  } catch (e) {
    // 移走了但删不掉：还原回去，别让用户的浏览器处于「目录没了」的坏状态
    try {
      fs.renameSync(stash, base);
      logger.warn(`迁移清理：删除旧内核残留失败（${e.message}），已还原，未影响当前使用`);
      return { ok: false, removed: [], reason: `删除失败已还原: ${e.message}` };
    } catch (e2) {
      logger.error(`迁移清理：还原也失败（${e2.message}），旧内核残留留在 ${stash}`);
      removed.push(stash);
      return { ok: true, removed, reason: `已移出但删除失败，残留: ${stash}` };
    }
  }
  logger.info(
    `迁移清理：已移除旧内核残留（${owner ? owner.label : v}，约占用数百 MB），当前内核 ${want} 不受影响`
  );
  return { ok: true, removed };
}

/**
 * 后台静默下载并解压到 stagingDir（不动 installDir，避免打断正在跑的旧内核）。
 *
 * 与 install() 的差别只有两条：
 *   1. 解压目标是 stagingDir 而不是 installDir —— 旧内核的目录锁、文件句柄
 *      不会被破坏，正在用旧内核跑的任务全程不受影响。
 *   2. 跳过「同版本跳过」的早返回：stagedVersion 与 installedVersion 不绑，
 *      即便用户已经手动装了新版本，再次进入本函数也会按需重下 —— 反正 staging
 *      总是临时目录，被覆盖没副作用。
 *
 * @param {{mirror?: string, signal?: AbortSignal, onProgress?: Function}} [opts]
 * @returns {Promise<{ok: boolean, version?: string, executable?: string,
 *   error?: string, canceled?: boolean}>}
 */
async function installStaged(opts) {
  const o = opts || {};
  const signal = o.signal;
  const version = currentPinned();
  const report = (p) => {
    const payload = { stage: "fingerprint-staged", ...p };
    logger.log("依赖", `[${payload.stage}] ${p.message || ""}`.trim());
    if (o.onProgress) o.onProgress(payload);
  };
  throwIfAborted(signal);
  if (!isSupported()) return { ok: false, error: `当前平台（${process.platform}）暂不支持环境拟真浏览器` };
  if (preinstalledDir()) return { ok: false, error: "环境拟真浏览器已由镜像内置预装，无需后台下载" };

  const dir = stagingDir();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dir, { recursive: true });

  const mirrorKey = String(o.mirror == null ? "" : o.mirror).trim() || DEFAULT_MIRROR;
  report({ message: `后台静默下载环境拟真浏览器 ${version}…`, pct: 0 });
  let file;
  try {
    // staged:true → 走独立目录，不与手动下载共用分片（见 stagedDownloadDir 注释）
    const dl = await downloadAsset(version, (p) => report(p), mirrorKey, signal, { staged: true });
    file = dl.file;
    report({ message: `下载完成（${fmtSize(dl.size)}，来源 ${dl.mirror}），后台解压中…`, pct: 100 });
  } catch (e) {
    const canceled = !!(e && e.canceled);
    report({ message: canceled ? "后台下载已取消" : `后台下载失败: ${e.message}` });
    // 失败时清掉 staging 残骸，避免下次 commitStagedInstall 误把半截当成品
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return { ok: false, canceled, error: canceled ? "后台下载已取消" : e.message };
  }

  try {
    const method = await extractArchive(file, dir);
    fs.writeFileSync(stagingVersionFile(CURRENT_ENGINE), version, "utf8");
    try { fs.rmSync(file, { force: true }); } catch {}
    const exe = findExecutable(dir);
    if (!exe) {
      return { ok: false, error: `staging 解压目录里没有浏览器主程序（解压方式: ${method}）` };
    }
    report({ message: `后台解压完成: ${exe}`, pct: 100 });
    return { ok: true, version, executable: exe };
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return { ok: false, error: e.message };
  }
}

/**
 * 把 staging 切换为新的 active 安装（闲时执行）。
 *
 * 触发条件（全部满足才执行）：
 *   1. stagedVersion === PINNED_VERSION —— staging 里有完整的新版本；
 *   2. fpContextActive() === 0 —— 当前没有正在跑的指纹浏览器上下文
 *      （旧内核可能被某个任务持着，贸然切换会断它的文件句柄）；
 *   3. opts.isIdle !== false —— 调用方明确说"现在没有账户任务在跑"。
 *      选 false 之外的"留空 = 默认允许"是因为：commitStagedInstall 通常由
 *      后台循环调用，那时"没人跑"是常态，不需要每次都说"是的没人在跑"。
 *
 * 切换步骤（按顺序）：
 *   1. 清掉上一次失败留下的 installDir.old（旧 exe 还在跑时它的文件锁可能
 *      让 rmSync 失败，所以这里尽力清不抛错）；
 *   2. installDir → installDir.old（同上尽力清；剩下会被压缩进下一步）；
 *   3. stagingDir → installDir（重命名）；
 *   4. 写 installDir/version.txt = staged；
 *   5. 尽力清理 installDir.old —— 若旧 exe 还在跑会留到下次。
 *
 * 已是 pinned 版本时，直接清掉 staging 收工（防止后台把刚装好的 installDir
 * 误重装一遍）。
 *
 * @param {{isIdle?: boolean}} [opts]
 * @returns {{ok: boolean, reason?: string, swapped?: boolean, cleaned?: boolean}}
 */
function commitStagedInstall(opts) {
  const o = opts || {};
  if (preinstalledDir()) return { ok: false, reason: "镜像内置预装" };
  const staged = stagedVersion(CURRENT_ENGINE);
  if (staged !== currentPinned()) return { ok: false, reason: "staging 没有新版本" };
  if (fpContextActive() > 0) return { ok: false, reason: `仍有 ${fpContextActive()} 个指纹浏览器上下文在运行` };
  if (o.isIdle === false) return { ok: false, reason: "账户任务正在运行" };

  const active = installDir(CURRENT_ENGINE);
  const staging = stagingDir();

  // 已是 pinned 版本 → 后台把 staging 当垃圾清理掉
  if (installedVersion() === currentPinned()) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    return { ok: true, swapped: false, cleaned: true };
  }

  const oldDir = active + ".old";
  // 先清掉上一次失败留下的 .old（若旧 exe 仍在跑会失败，留着等下次）
  try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch {}
  // 旧 active 目录：旧 exe 可能还在跑，rmSync 会失败也无所谓（重命名能挪走目录）
  try { fs.rmSync(active, { recursive: true, force: true }); } catch {}
  // staging → active：原子（同一父目录下的 renameSync）
  try {
    fs.renameSync(staging, active);
  } catch (e) {
    return { ok: false, reason: `staging 切换失败: ${e.message}` };
  }
  fs.writeFileSync(versionFile(), staged, "utf8");
  logger.info(`指纹内核 ${staged} 已切换为活动版本`);
  return { ok: true, swapped: true, oldKept: fs.existsSync(oldDir) };
}

/**
 * 查询上游最新版本（用于「检查更新」）。
 * 走同样的镜像链；查不到就返回 null，由调用方决定是否提示。
 */
async function latestVersion() {
  const api = `https://api.github.com/repos/${ENGINES[CURRENT_ENGINE].repo}/releases/latest`;
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
    return { ok: false, error: e.message, latest: null, installed: installedVersion(), pinned: currentPinned(), updateAvailable: false, reinstallAvailable: false };
  }
  const installed = installedVersion();
  return {
    ok: true,
    latest,
    installed,
    pinned: currentPinned(),
    // 上游发了比钉死版本更新的 tag（本项目不自动跟，仅提示）
    updateAvailable: !!latest && latest !== currentPinned(),
    // 已安装版本与钉死版本不一致（含未安装）→ 点「重新安装」可对齐
    reinstallAvailable: installed !== currentPinned(),
  };
}

/* ---------------- 启动参数 ---------------- */

/**
 * 环境拟真浏览器的启动参数（Chromix 154）。
 *
 * 注意**不要**在这里设 UA：UA 必须由 --fingerprint 的种子统一生成，
 * 再叠加一层我们自己的 UA 就会退化成「应用层硬改」那条死路（CH 对不上）。
 *
 * ⚠️ flag 命名与旧的 adryfish/fingerprint-chromium **不同**，迁过来时踩过的坑：
 *   旧上游                        Chromix
 *   --timezone=                  →  --fingerprint-timezone=
 *   --accept-lang= / --lang=     →  --fingerprint-locale=（已含 Accept-Language 归一化，
 *                                   Chromix 没有单独的 --lang / --accept-lang）
 *   --fingerprint=<seed> / --fingerprint-platform= / --fingerprint-brand= /
 *   --fingerprint-brand-version= / --fingerprint-hardware-concurrency=  → 同名，保留
 *
 * 完整 flag 契约见 https://github.com/xiaozhou26/Chromix/blob/main/docs/fingerprint-flags.md
 * 用 `--key=value` 形式，不要拆成两个参数。
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
  if (opts.timezone !== false) args.push(`--fingerprint-timezone=${opts.timezone || "Asia/Shanghai"}`);
  if (opts.acceptLang !== false) args.push(`--fingerprint-locale=${opts.acceptLang || "zh-CN"}`);
  return args;
}

module.exports = {
  // —— 多内核（2026-10-06）——
  ENGINES,
  DEFAULT_ENGINE,
  engine,
  normalizeEngine,
  setEngine,
  currentEngine,
  currentPinned,
  engineCatalog,
  installedVersionFor,
  selectEngine,
  switchEngine,
  migrateAwayLegacyEngine,
  stagedDownloadDirFor,
  // 兼容旧导出：默认内核的 repo / 版本号
  get REPO() {
    return ENGINES[DEFAULT_ENGINE].repo;
  },
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
  PART_SUFFIX,
  MIN_PARALLEL_CONNECTIONS,
  MAX_PARALLEL_CONNECTIONS,
  pickConnections,
  DEFAULT_MIRROR,
  resolveMirrors,
  sha256File,
  mirrorLatency,
  stagingDir,
  stagingVersionFile,
  stagedVersion,
  installStaged,
  commitStagedInstall,
  fpContextActive,
  notifyFpContext,
};
