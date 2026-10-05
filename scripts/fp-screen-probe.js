/**
 * 判定 `screen` 是「Chromix 按种子伪造的」还是「本机真实屏幕」。
 *
 * 背景：真实参数复测拿到 screen=1280x720、avail=1280x720（== 窗口尺寸，
 * 且 avail 没有任务栏高度）。两种可能，必须分开：
 *   A. 种子按窗口尺寸伪造 screen → 指纹自洽性有洞（screen 永远等于窗口，
 *      真实用户屏幕通常远大于窗口，且 availHeight < height）
 *   B. 本机屏幕真的就是 1280x720 → 那不是缺陷
 *
 * 判据：同一颗种子，**用两个不同的窗口尺寸**各起一次浏览器。
 *   - 若 screen 随 --window-size 变化 → 情况 A（种子从窗口推导 screen）
 *   - 若 screen 两次相同且与 --window-size 无关 → 情况 B（真实屏幕）
 *
 * 顺带把 dpr 的真实值取准：之前拿到 1.0000000149011612，这看着像
 * float32 精度残值（1 + 2^-26），若在多个窗口尺寸下都稳定复现，
 * 就是内核层面的固定行为，而不是某次 launch 的偶发。
 */

const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..");
const { chromium } = require(path.join(ROOT, "node_modules", "playwright-core"));
const fp = require(path.join(ROOT, "src", "fingerprint-browser.js"));

const seed = fp.seedFor("msr-ippure-realparams"); // 与上一次复测同一颗种子
const SIZES = [
  { label: "小窗 800x600", w: 800, h: 600 },
  { label: "大窗 1600x900", w: 1600, h: 900 },
];

async function probe(size) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msr-screen-"));
  try {
    const ctx = await chromium.launchPersistentContext(tmp, {
      executablePath: fp.executablePath(),
      headless: false,
      args: [
        "--disable-blink-features=AutomationControlled",
        ...fp.buildArgs({ seed }),
        `--window-size=${size.w},${size.h}`,
        "--window-position=0,0",
      ],
      ignoreHTTPSErrors: true,
      locale: "zh-CN",
      // 注意：**不传 viewport**（与 src/browser.js 有头模式一致）
    });
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto("about:blank");
    await new Promise((r) => setTimeout(r, 1200));
    const d = await page.evaluate(() => ({
      inner: [innerWidth, innerHeight],
      outer: [outerWidth, outerHeight],
      screen: [screen.width, screen.height],
      avail: [screen.availWidth, screen.availHeight],
      colorDepth: screen.colorDepth,
      dpr: window.devicePixelRatio,
      // 指纹一致性关键量：真实 Windows 上 availHeight 通常 < height（任务栏）
      availLessThanScreen: screen.availHeight < screen.height,
      screenBiggerThanWindow: screen.width > outerWidth,
    }));
    await ctx.close();
    return d;
  } finally {
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 500)); }
    }
  }
}

(async () => {
  const results = [];
  for (const s of SIZES) {
    const d = await probe(s);
    results.push({ 请求窗口: s.label, ...d });
    console.log(`\n=== 请求窗口 ${s.label} ===`);
    console.log(JSON.stringify(d, null, 1));
  }
  console.log("\n=== 汇总判定 ===");
  const [a, b] = results;
  console.log("screen 是否随窗口变化:",
    a.screen.join("x") !== b.screen.join("x") ? "是 → 种子从窗口推导（情况A）" : "否 → 与窗口无关（情况B）");
  console.log("dpr 两次是否一致:",
    a.dpr === b.dpr ? `是（${a.dpr}）` : `否（${a.dpr} vs ${b.dpr}）`);
  console.log("任一窗口下 screen>window:",
    results.some((r) => r.screenBiggerThanWindow) ? "是" : "否");
})();
