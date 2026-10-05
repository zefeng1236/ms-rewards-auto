/**
 * 项目实际访问的域 × fp 150 × canvas 伪装 — 看哪个会触发 issue #94 的崩溃。
 *
 * 目标域（来自 src/tasks.js / src/runner.js / src/auth.js / src/browser.js）：
 *   - login.live.com（OAuth）
 *   - www.bing.com / cn.bing.com（搜索任务）
 *   - rewards.bing.com / rewards.bing.com/earn（积分统计）
 *   - prod.rewardsplatform.microsoft.com（dapi/me）
 *
 * 已知约束：fp 150 + canvas 伪装 + getImageData/readPixels 必崩（issue #94）。
 * 任务路径通常不调这些 API，但 Bing 主页 SPA 复杂，要实测。
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

const fp_ = require_(path.join(ROOT, "src", "fingerprint-browser.js"));

// 项目实际访问的域
const TARGETS = [
  { url: "https://login.live.com/", name: "login.live.com" },
  { url: "https://www.bing.com/", name: "www.bing.com" },
  { url: "https://cn.bing.com/", name: "cn.bing.com" },
  { url: "https://rewards.bing.com/", name: "rewards.bing.com" },
  { url: "https://rewards.bing.com/earn", name: "rewards.bing.com/earn" },
];

const HEADED = !process.argv.includes("--head");
const { chromium } = require_(path.join(ROOT, "node_modules", "playwright-core"));

async function testOne(url, fpArgs, seed) {
  const tmpProf = fs.mkdtempSync(path.join(os.tmpdir(), "msr-dom-"));
  let crashInfo = null;
  let domSnap = null;
  try {
    const context = await chromium.launchPersistentContext(tmpProf, {
      executablePath: fp_.executablePath(),
      headless: !HEADED,
      args: fpArgs,
      ignoreHTTPSErrors: true,
      viewport: HEADED ? { width: 1366, height: 768 } : null,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });
    const page = context.pages()[0] || (await context.newPage());
    page.on("crash", () => {
      crashInfo = "page crashed during navigation";
    });
    try {
      await page.goto(url, { waitUntil: "commit", timeout: 30000 });
      // 给页面 3 秒做最基础的渲染
      await new Promise((r) => setTimeout(r, 3000));
      // 不调 page.screenshot（避免触发 readPixels）—— 只读 DOM
      domSnap = await page.evaluate(() => {
        const q = (s) => document.querySelector(s);
        return {
          title: (document.title || "").slice(0, 50),
          bodyChars: (document.body.innerText || "").length,
          hasCanvas: document.querySelectorAll("canvas").length,
          isAlive: true,
        };
      }).catch((e) => ({ error: e.message.slice(0, 50), isAlive: false }));
    } catch (e) {
      crashInfo = crashInfo || ("nav error: " + e.message.slice(0, 80));
    }
    await context.close().catch(() => {});
  } catch (e) {
    crashInfo = "launch error: " + e.message.slice(0, 100);
  }
  fs.rmSync(tmpProf, { recursive: true, force: true });
  return { crashInfo, domSnap };
}

console.log("指纹浏览器:", fp_.executablePath());
console.log("模式:", HEADED ? "GUI" : "headless");
console.log();

// 跑两轮：有 fp flag / 无 fp flag —— 看 issue #94 是不是真的依赖 canvas 伪装开启
const ROUNDS = [
  {
    label: "A: fp flags（开 canvas 伪装 + stealth）",
    args: fp_.buildArgs({ seed: fp_.seedFor("msr-dom-test") }),
  },
  {
    label: "B: 无 fp flags（fp 二进制 + 裸 chromium 形态）",
    args: ["--no-first-run"],
  },
  {
    label: "C: fp flags + --disable-spoofing=canvas（issue #94 建议）",
    args: [...fp_.buildArgs({ seed: fp_.seedFor("msr-dom-test") }), "--disable-spoofing=canvas"],
  },
];

let anyCrash = false;
for (const round of ROUNDS) {
  console.log(`\n========== ${round.label} ==========`);
  for (const t of TARGETS) {
    process.stdout.write(`  ${t.name.padEnd(34)} ... `);
    const { crashInfo, domSnap } = await testOne(t.url, round.args, "msr-dom-test");
    if (crashInfo) {
      anyCrash = true;
      console.log("❌ CRASH:", crashInfo);
    } else if (domSnap && domSnap.error) {
      console.log("⚠️  eval error:", domSnap.error);
    } else if (domSnap) {
      console.log(`✅ alive (title="${domSnap.title.slice(0, 30)}", canvas=${domSnap.hasCanvas}, bodyChars=${domSnap.bodyChars})`);
    } else {
      console.log("⚠️  no snapshot");
    }
  }
}

console.log("\n========== 汇总 ==========");
console.log(anyCrash ? "❌ 至少一处命中崩溃" : "✅ 全部存活");
if (anyCrash) console.log("  → 需要给浏览器加 --disable-spoofing=canvas 或降级到 148");

// 顺便也跑一下 antcpt.com/score_detector/（用户要求）
console.log("\n========== 附带：antcpt.com/score_detector/ ==========");
for (const round of ROUNDS) {
  console.log(`\n--- ${round.label} ---`);
  process.stdout.write("  antcpt.com/score_detector ... ");
  const { crashInfo, domSnap } = await testOne(
    "https://antcpt.com/score_detector/",
    round.args,
    "msr-dom-test"
  );
  if (crashInfo) console.log("❌ CRASH:", crashInfo);
  else if (domSnap?.error) console.log("⚠️ ", domSnap.error);
  else console.log(`✅ title="${domSnap?.title.slice(0, 30)}"`);
}