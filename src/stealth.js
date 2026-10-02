/**
 * 浏览器「去自动化」补丁
 *
 * 背景：本项目的登录授权 / 每周领取要用 Playwright 的 Chromium（headless）打开真实页面。
 * headless Chromium 的默认环境特征跟正常浏览器差得很远 —— UA 里带 `HeadlessChrome`、
 * `navigator.webdriver === true`、`window.chrome` 不存在、plugins 列表为空，
 * 这些都是站点用来判定「这是自动化程序」的一线指标。
 *
 * 参考的目标/对照对象（1:【原】-> 4）：
 *   https://github.com/geosam/FuckScripts  https://scriptcat.org/zh-CN/users/27974  【原】
 *   https://scriptcat.org/zh-CN/users/211564
 *   https://scriptcat.org/zh-CN/users/187483
 *   https://scriptcat.org/zh-CN/users/207134
 * 它们是浏览器里的用户脚本，天然跑在真实用户的真实浏览器上，所以本身不需要做这些拟真；
 * 而我们是在独立 headless Chromium 里跑同一套流程，才需要自己把「看起来像人」补回去。
 *
 * 这里只做拟真层面的事：不涉及任何登录凭据的绕过，只让自动化环境与普通浏览器难区分。
 */

const rewards = require("./rewards");

/** UA 统一采用桌面 Edge（与 HTTP 层一致），避免 headless 后缀暴露 */
const STEALTH_USER_AGENT = rewards.UA_PC;

/** 给 Chromium 追加的启动参数 */
const EXTRA_ARGS = [
  // 去掉自动化开关（去掉「正在受到自动测试软件控制」的 infobar 与对应 switch）
  "--exclude-switches=enable-automation",
  "--disable-infobars",
];

/** 补 Origin/导航请求的自然语言偏好 */
const EXTRA_HTTP_HEADERS = {
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
};

/**
 * 注入到每个页面的初始化脚本。
 *
 * ⚠️ 这段字符串是在浏览器上下文里执行的，不能用任何 Node 侧变量，务必自包含。
 * 所有改动都包在 try/catch 里——注入脚本抛错会污染整个页面。
 */
const STEALTH_INIT = `(() => {
  const safe = (fn) => { try { fn(); } catch (e) {} };
  // 环境拟真浏览器（src/fingerprint-browser.js）模式下为 true。
  // 它自己在源码层生成 languages / plugins / CPU 核数 / platform，
  // 我们再盖一层就是两套矛盾的环境特征，所以这些维度直接让位。
  const FP = !!window.__MSR_FP;

  // ① navigator.webdriver：自动化环境下恒为 true，最经典的一线特征
  safe(() => {
    if (!Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver")) return;
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false, configurable: true });
  });

  // ② window.chrome：headless shell 里根本没有这个对象
  safe(() => {
    if (window.chrome && window.chrome.runtime) return;
    const noop = () => {};
    window.chrome = {
      app: { isInstalled: false, InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" }, RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" } },
      runtime: { id: undefined, connect: noop, sendMessage: noop, onMessage: { addListener: noop, removeListener: noop }, onConnect: { addListener: noop, removeListener: noop } },
      csi: () => ({ onloadT: Date.now(), startE: Date.now(), pageT: performance.now(), tran: 15 }),
      loadTimes: () => ({ commitLoadTime: Date.now() / 1000, connectionInfo: "h2", finishDocumentLoadTime: Date.now() / 1000, finishLoadTime: Date.now() / 1000, firstPaintAfterLoadTime: 0, firstPaintTime: Date.now() / 1000, navigationType: "Other", npnNegotiatedProtocol: "h2", requestTime: Date.now() / 1000, startLoadTime: Date.now() / 1000, wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true }),
    };
  });

  // ③ 语言 / 插件 / MIME：headless 环境这些几乎都是空的
  safe(() => {
    if (FP) return; // 环境拟真浏览器自有固定插件表，且 --accept-lang 已生效
    const langs = ["zh-CN", "zh", "en-US", "en"];
    Object.defineProperty(navigator, "languages", { get: () => langs, configurable: true });
    Object.defineProperty(navigator, "language", { get: () => "zh-CN", configurable: true });

    const pdfViewer = { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format", length: 1, 0: { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null } };
    const chromePdf = { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format", length: 1, 0: { type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null } };
    const widevine = { name: "Widevine Content Decryption Module", filename: "internal-remoting-viewer", description: "Widevine Content Decryption Module", length: 0 };
    const plugins = [ pdfViewer, chromePdf, widevine ];
    plugins.item = (i) => plugins[i];
    plugins.namedItem = (name) => plugins.find((p) => p.name === name) || null;
    plugins.refresh = () => {};
    Object.defineProperty(navigator, "plugins", { get: () => plugins, configurable: true });

    const mimeTypes = [ pdfViewer[0], chromePdf[0] ];
    mimeTypes.item = (i) => mimeTypes[i];
    mimeTypes.namedItem = (name) => mimeTypes.find((m) => m.type === name) || null;
    Object.defineProperty(navigator, "mimeTypes", { get: () => mimeTypes, configurable: true });
  });

  // ④ 硬件信息：headless 常给出异常的小核数 / 缺失 deviceMemory
  safe(() => {
    if (FP) return; // CPU 核数 / 内存 / platform 由 --fingerprint 种子统一生成
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8, configurable: true });
    if (!("deviceMemory" in navigator)) {
      Object.defineProperty(navigator, "deviceMemory", { get: () => 8, configurable: true });
    }
    // UA 声明的是 Windows，Docker 容器里 platform 会如实暴露 Linux —— 对齐 UA 以免自相矛盾
    Object.defineProperty(navigator, "platform", { get: () => "Win32", configurable: true });
  });

  // ⑤ WebGL：headless 走软件渲染，UNMASKED_RENDERER 里会带 SwiftShader / Mesa 字样
  //
  // ⚠️ 之前这里是个负优化：只对「命中 SwiftShader 正则的值」做替换，而 vendor 的真实值
  //    "Google Inc. (Google)" 不含这些字样 → vendor 被放过、renderer 被换掉，
  //    拼出一对现实中不存在的组合（Google 的 vendor + MS 的驱动），比不补丁更可疑。
  //    改成先探测一次渲染器是否为软渲染，是则 vendor / renderer **成对**替换为同一厂商。
  safe(() => {
    const GL_SWIFT = /SwiftShader|Mesa|llvmpipe|ANGLE \\(Google, Vulkan/i;
    // 真机基准：ANGLE 的 vendor 形如 "Google Inc. (NVIDIA)"，renderer 形如
    // "ANGLE (NVIDIA, NVIDIA GeForce ... Direct3D11 vs_5_0 ps_5_0, D3D11)" —— 两者必须同厂商
    const VENDOR = "Google Inc. (NVIDIA)";
    const RENDERER = "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)";
    const patchCtx = (Ctor) => {
      if (!Ctor) return;
      const proto = Ctor.prototype;
      if (!proto || typeof proto.getParameter !== "function") return;
      const raw = proto.getParameter;
      let software = null;
      // 只在第一次取参数时探测一次，之后缓存（同一进程内 GPU 不会变）
      const isSoftware = (self) => {
        if (software === null) {
          try {
            const r = raw.call(self, 37446);
            software = typeof r === "string" && GL_SWIFT.test(r);
          } catch {
            software = false;
          }
        }
        return software;
      };
      proto.getParameter = function (p) {
        const v = raw.call(this, p);
        // 37445 = UNMASKED_VENDOR_WEBGL，37446 = UNMASKED_RENDERER_WEBGL
        if (p !== 37445 && p !== 37446) return v;
        if (!isSoftware(this)) return v;
        return p === 37445 ? VENDOR : RENDERER;
      };
    };
    patchCtx(window.WebGLRenderingContext);
    patchCtx(window.WebGL2RenderingContext);
  });

  // ⑥ 权限查询：headless 一律 denied，真人浏览器默认是 prompt
  safe(() => {
    if (!navigator.permissions || typeof navigator.permissions.query !== "function") return;
    const rawQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (params) => {
      if (params && params.name === "notifications") {
        return Promise.resolve({ state: "prompt", onchange: null, addEventListener() {}, removeEventListener() {} });
      }
      return rawQuery(params);
    };
    if (window.Notification) {
      Object.defineProperty(Notification, "permission", { get: () => "default", configurable: true });
    }
  });
})();`;

module.exports = {
  STEALTH_INIT,
  STEALTH_USER_AGENT,
  EXTRA_ARGS,
  EXTRA_HTTP_HEADERS,
};
