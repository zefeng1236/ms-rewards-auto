/**
 * 一次性：用项目自己的指纹浏览器打开 creepjs，实测指纹判定。
 *
 * 目的：验证本轮 page-guide 改动（页内 MutationObserver 自闭环）
 * 没有新增任何 CDP 注入通道，指纹 verdict 仍是 Normal。
 *
 * 用法（需先装好 fingerprint-chromium 或 playwright chromium）：
 *   node scripts/fp-creepjs-check.mjs [--fp|--chromium] [--head]
 *
 * 已知问题（2026-10-05 实测 + GitHub issue #94）：
 *   fingerprint-chromium 150.0.7871.186 + canvas 伪装 + 任意读回像素操作
 *   (getImageData / WebGL readPixels) → 渲染进程必崩（SIGSEGV）。这是
 *   fp 150 的官方已知 bug，影响所有调用这两个 API 的检测站，包括
 *   creepjs（用到 readPixels）和 pixelscan.net（实测 12 次访问崩 7 次）。
 *
 *   缓解方案：
 *     - playwright 的 page.screenshot() 自身会触发 readPixels → 必崩。
 *       所以**本脚本绝不调用 page.screenshot()**，只读 DOM 内容。
 *     - 你手动开 GUI 不崩：因为手动启动 chrome 不触发 readPixels API，
 *       creepjs 在浏览器内自渲染也不调用 readPixels（它只用 canvas2d + toDataURL）。
 *       → 所以脚本**只读 DOM**，验证 fingerprint 渲染结果，不截图。
 *
 * 默认行为：
 *   - 走指纹浏览器（fingerprint-chromium 150）
 *   - 走 GUI（headless=false）
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const require_ = createRequire(import.meta.url);

const fp = require_(path.join(ROOT, "src", "fingerprint-browser.js"));

const WANT_FP = !process.argv.includes("--chromium");
const HEADED = !process.argv.includes("--head");
// 默认 GUI：fp 150 + headless + creepjs → 即使不调 screenshot，headless 模式下
// chromium 内部也可能触发 readback；GUI 模式不会。
const OUT = path.join(ROOT, "shots", "creepjs.png");

// ⚠️ 千万别设 MS_REWARDS_STORAGE_DIR！
// 它会连指纹浏览器的安装/查找目录一起改到临时目录去，导致 fingerprint 模块找不到
// 环境拟真浏览器、悄悄回落到普通 Chromium —— 那样测出来的指纹全是回落路径的结果。
// 2026-10-05 首次跑就踩了这个坑。

const ctx = { id: "fp-check-" + Date.now() };

console.log("模式:", WANT_FP ? "环境拟真浏览器" : "普通 Chromium", "| 有头:", HEADED);

const { chromium } = require_(path.join(ROOT, "node_modules", "playwright-core"));
const tmpProf = fs.mkdtempSync(path.join(os.tmpdir(), "msr-fpcheck-"));

const fpArgs = WANT_FP
  ? fp.buildArgs({ seed: fp.seedFor(ctx.id || "") })
  : ["--no-first-run", "--disable-default-apps", "--no-default-browser-check"];

const context = await chromium.launchPersistentContext(tmpProf, {
  executablePath: WANT_FP ? fp.executablePath() : undefined,
  headless: !HEADED,
  args: fpArgs,
  ignoreHTTPSErrors: true,
  viewport: HEADED ? { width: 1366, height: 768 } : null,
  locale: "zh-CN",
  timezoneId: "Asia/Shanghai",
});

const page = context.pages()[0] || (await context.newPage());

let crashed = false;
page.on("crash", () => {
  crashed = true;
  console.log(">>> page crash 事件触发");
});

console.log("打开 creepjs ...");
await page.goto("https://abrahamjuliot.github.io/creepjs/", {
  waitUntil: "commit",
  timeout: 60000,
}).catch((e) => console.log("goto:", e.message));

// 每 2 秒抓一次快照。crash 后用最后一个能拿到的快照。
// **绝不调 page.screenshot()**（会触发 readPixels → 崩）。
let lastSnapshot = null;
for (let i = 1; i <= 8; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const snap = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const txt = (s) => (q(s) && q(s).innerText.trim()) || "";
      const fails = Array.from(document.querySelectorAll(".fail, .lie, [class*='lie'], .bad"))
        .map((n) => (n.innerText || "").trim().slice(0, 100))
        .filter(Boolean)
        .slice(0, 10);
      // creepjs 各检测项面板（h3 是每个维度标签）
      const sections = Array.from(document.querySelectorAll(".feature, .section, section"))
        .map((s) => ({
          label: ((s.querySelector("h1,h2,h3,h4") || {}).innerText || "").trim().slice(0, 40),
          tag: s.className.slice(0, 60),
          snippet: s.innerText.replace(/\s+/g, " ").trim().slice(0, 120),
        }))
        .filter((s) => s.label)
        .slice(0, 30);
      // 自己提示元素
      const msraGuide = (() => {
        const el = document.getElementById("__msra_page_guide_body__");
        return el
          ? { state: el.getAttribute("data-state"), text: (el.innerText || "").slice(0, 60) }
          : null;
      })();
      return {
        // 总判定：unusual result / normal / lying
        topVerdict: (document.body.innerText || "").slice(0, 100).replace(/\n+/g, " "),
        fails,
        sections,
        msraGuide,
      };
    });
    lastSnapshot = snap;
    console.log(`  ${i * 2}s: snapshot ok (${snap.sections.length} sections, ${snap.fails.length} fails)`);
  } catch (e) {
    console.log(`  ${i * 2}s: evaluate 失败 (crashed=${crashed}) msg: ${e.message.slice(0, 50)}`);
    break;
  }
}

console.log("\n===== creepjs 采样 =====");
console.log(JSON.stringify(lastSnapshot, null, 2));

await context.close().catch(() => {});
fs.rmSync(tmpProf, { recursive: true, force: true });
console.log("\n完成");

if (crashed) {
  console.log("\n⚠️  浏览器在跑的过程中 SIGSEGV —— 这是 fp 150 的 canvas spoofing 已知 bug。");
  console.log("   如果上面的 sections 数据已经够你看 verdict，那 index 这一项不影响结论。");
  console.log("   详见: https://github.com/adryfish/fingerprint-chromium/issues/94");
}