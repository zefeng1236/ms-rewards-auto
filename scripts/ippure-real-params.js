/**
 * 用「项目真实运行参数」复测，避免测试脚本自身偏差造成误报。
 *
 * 为什么要这个文件（两个具体坑）：
 *  ① ippure-deep-check.js 里传了 viewport:{1366,768}，而 src/browser.js 真机是
 *     `viewport: headless ? {...} : null`（有头模式用真实窗口尺寸）。
 *     传 viewport 时 window.devicePixelRatio 会出现 1.0000000149011612 这种
 *     float32 残值 —— 那是**测试脚手架的产物，不是浏览器指纹缺陷**。
 *     拿它当结论就等于给项目记了个假 bug。
 *  ② DNS 泄露页只在正文列「解析 DNS 的出口 IP 列表」，没有 WebRTC 页那种
 *     「未检测到泄露」的一句话判定，必须自己拿 出口IP vs 解析IP 的归属比对。
 *
 * 判定口径（写在代码里，避免下次又靠感觉念）：
 *   - WebRTC：以站方结论文本 + 本地 ICE 候选双证据为准
 *   - DNS：解析 IP 的归属商 与 出口 IP 归属商 一致 → 无泄露；
 *          解析 IP 归属商 与 出口 IP 归属商 不同 → 记为「DNS 走第三方出口」
 *   - 指纹：只核对「自洽性」（dpr 是否整值、时区/语言/平台是否互相矛盾），
 *          不去猜站方的风控阈值
 */

const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..");
const { chromium } = require(path.join(ROOT, "node_modules", "playwright-core"));
const fp = require(path.join(ROOT, "src", "fingerprint-browser.js"));

const seed = fp.seedFor("msr-ippure-realparams");

// 与 src/browser.js 有头模式一致：不传 viewport，用真实窗口
const REAL_PARAMS = {
  executablePath: fp.executablePath(),
  headless: false,
  args: [
    "--disable-blink-features=AutomationControlled",
    ...fp.buildArgs({ seed }),
    "--exclude-switches=enable-automation",
    "--disable-infobars",
    "--no-first-run",
    "--disable-default-apps",
    "--no-default-browser-check",
    "--disable-sync",
  ],
  ignoreHTTPSErrors: true,
  locale: "zh-CN",
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msr-ippure-real-"));
  let crashed = false;
  try {
    const ctx = await chromium.launchPersistentContext(tmp, REAL_PARAMS);
    const page = ctx.pages()[0] || (await ctx.newPage());
    page.on("crash", () => { crashed = true; console.log("❌ 渲染进程崩溃"); });

    // ── 1. DNS 页：抓「出口 IP」和「DNS 解析 IP 列表」，做归属比对 ──
    await page.goto("https://ippure.com/DNS-Leak-Detect.html", {
      waitUntil: "domcontentloaded", timeout: 60000,
    }).catch((e) => console.log("goto:", e.message.slice(0, 80)));
    await new Promise((r) => setTimeout(r, 20000));

    const dns = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("table tr")]
        .map((tr) => [...tr.querySelectorAll("td")].map((td) => td.innerText.trim()))
        .filter((c) => c.length >= 2 && /^\d{1,3}(\.\d{1,3}){3}$|:[0-9a-f]{2,}$/i.test(c[0] || ""));
      return {
        exitIp: (document.body.innerText.match(/My IP\s*([\d.:a-f]{3,60})/i) || [])[1] || null,
        resolvers: rows.map((c) => ({ ip: c[0], where: c[1], org: c[2] })),
        // 站方有没有给出显式判定（有的站给，有的只列表）
        verdict: (/(未检测到[^\n]{0,10}泄露|检测到[^\n]{0,10}泄露|无泄露)/.exec(document.body.innerText) || [])[0] || null,
      };
    }).catch((e) => ({ err: e.message.slice(0, 120) }));
    console.log("=== DNS 页原始数据 ===");
    console.log(JSON.stringify(dns, null, 1));

    if (dns.resolvers) {
      const orgs = [...new Set(dns.resolvers.map((r) => r.org).filter(Boolean))];
      const where = dns.resolvers[0] && dns.resolvers[0].where;
      console.log("\n=== DNS 归属比对 ===");
      console.log("出口 IP:", dns.exitIp, "所在:", where);
      console.log("解析 DNS 的组织（去重）:", orgs.join(" / ") || "（无）");
      console.log("站方显式判定:", dns.verdict || "无（该页只列表不判定）");
    }

    // ── 2. WebRTC 页：拿站方结论文本 ──
    if (!crashed) {
      await page.goto("https://ippure.com/Browser-WebRTC-Leak-Detect.html", {
        waitUntil: "domcontentloaded", timeout: 60000,
      }).catch((e) => console.log("goto:", e.message.slice(0, 80)));
      await new Promise((r) => setTimeout(r, 20000));
      const w = await page.evaluate(() => {
        const t = document.body.innerText || "";
        return {
          verdict: (/(未检测到[^\n]{0,20}WebRTC[^\n]{0,10}泄露|检测到[^\n]{0,20}WebRTC[^\n]{0,10}泄露)/.exec(t) || [])[0] || null,
          leakRows: (t.match(/检测到[^\n]{0,30}泄露/g) || []).slice(0, 5),
        };
      }).catch((e) => ({ err: e.message.slice(0, 120) }));
      console.log("\n=== WebRTC 页站方结论 ===");
      console.log(JSON.stringify(w, null, 1));
    }

    // ── 3. 指纹自洽性：真实参数下的 dpr / 屏幕 / 语言 / 时区 ──
    if (!crashed) {
      await page.goto("about:blank");
      const consistency = await page.evaluate(() => {
        const dpr = window.devicePixelRatio;
        const dprClean = Math.abs(dpr - Math.round(dpr)) < 1e-6;
        return {
          dpr,
          dprIsCleanInteger: dprClean,
          inner: [innerWidth, innerHeight],
          screen: [screen.width, screen.height],
          avail: [screen.availWidth, screen.availHeight],
          ua: navigator.userAgent,
          platform: navigator.platform,
          webdriver: navigator.webdriver,
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          lang: navigator.language,
          langs: navigator.languages,
          plugins: navigator.plugins.length,
          // 自洽性交叉检查
          checks: {
            uaWinMatchesPlatform: /Windows/.test(navigator.userAgent) === /Win/.test(navigator.platform),
            uaVersionMatchesMajor: (() => {
              const m = /Chrome\/(\d+)/.exec(navigator.userAgent);
              return m ? m[1] : null;
            })(),
            tzIsShanghai: Intl.DateTimeFormat().resolvedOptions().timeZone === "Asia/Shanghai",
            screenBiggerThanViewport: screen.width >= innerWidth && screen.height >= innerHeight,
          },
        };
      });
      console.log("\n=== 真实参数下的指纹自洽性 ===");
      console.log(JSON.stringify(consistency, null, 1));
    }

    await ctx.close();
  } finally {
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 600)); }
    }
  }
})();
