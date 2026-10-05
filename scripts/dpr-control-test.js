/**
 * dpr 残值的对照实验：Chromix 154（本项目用的）vs 本机正常 Edge。
 *
 * 上一轮发现 window.devicePixelRatio === 1.0000000149011612（= 1 + 2^-26），
 * 在「项目真实参数」下依然复现，且与窗口尺寸无关。
 *
 * 两种可能，必须用对照组分开，不能靠猜：
 *   A. Chromix 指纹层把 dpr 算成了 float32 残值 → 真实缺陷，会被风控识别
 *   B. 本平台/无头宿主下 Chromium 固有行为（普通 Edge 也一样）→ 不是缺陷
 *
 * 判据：同一台机器、同一个时刻，Edge 也返回同一个残值 → B；
 *       Edge 返回干净的 1 而 Chromix 返回残值 → A。
 * 这就是本项目一贯的「对照组 vs 实验组实测」纪律，验收指纹改动唯一认这个。
 */

const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const { chromium } = require(path.join(ROOT, "node_modules", "playwright-core"));
const fp = require(path.join(ROOT, "src", "fingerprint-browser.js"));

// 与真实运行同种子
const seed = fp.seedFor("msr-ippure-realparams");

const READ = () => ({
  dpr: window.devicePixelRatio,
  dprExact1: window.devicePixelRatio === 1,
  dprOffset: window.devicePixelRatio - 1,
  screen: [screen.width, screen.height],
  avail: [screen.availWidth, screen.availHeight],
  inner: [innerWidth, innerHeight],
  ua: navigator.userAgent,
  webdriver: navigator.webdriver,
  platform: navigator.platform,
});

async function probe(label, opts) {
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(opts.userDataDir || undefined, opts.launch);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto("about:blank");
    await new Promise((r) => setTimeout(r, 1000));
    const d = await page.evaluate(READ);
    console.log(`\n=== ${label} ===`);
    console.log(JSON.stringify(d, null, 1));
    return d;
  } catch (e) {
    console.log(`\n=== ${label} === 启动失败: ${e.message.slice(0, 120)}`);
    return null;
  } finally {
    if (ctx) { try { await ctx.close(); } catch {} }
  }
}

(async () => {
  const os = require("os");
  const fs = require("fs");
  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "msr-dpr-a-"));
  const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "msr-dpr-b-"));

  // 实验组：本项目的环境拟真浏览器
  const chromix = await probe("实验组 Chromix 154（项目实际使用）", {
    userDataDir: tmpA,
    launch: {
      executablePath: fp.executablePath(),
      headless: false,
      args: [
        "--disable-blink-features=AutomationControlled",
        ...fp.buildArgs({ seed }),
      ],
      ignoreHTTPSErrors: true,
      locale: "zh-CN",
    },
  });

  // 对照组：本机正常 Edge，同样由 playwright 驱动（同宿主同协议）
  const edge = await probe("对照组 本机 Edge（未加任何指纹参数）", {
    userDataDir: tmpB,
    launch: { channel: "msedge", headless: false },
  });

  for (const t of [tmpA, tmpB]) {
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(t, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 500)); }
    }
  }

  console.log("\n=== 判定 ===");
  if (!chromix || !edge) {
    console.log("有一组没跑起来，无法判定（不猜）");
    return;
  }
  const same = chromix.dpr === edge.dpr;
  console.log(`Chromix dpr = ${chromix.dpr}`);
  console.log(`Edge    dpr = ${edge.dpr}`);
  console.log(same
    ? "→ 两组一致：本平台 Chromium 固有行为，不是 Chromix 缺陷"
    : "→ 两组不一致：Edge 干净而 Chromix 有残值，判定为 Chromix 指纹层缺陷");
  console.log(`Chromix screen=${chromix.screen.join("x")} avail=${chromix.avail.join("x")}`);
  console.log(`Edge    screen=${edge.screen.join("x")} avail=${edge.avail.join("x")}`);
})();
