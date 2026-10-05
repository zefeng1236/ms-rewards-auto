/**
 * Chromix 154 vs fingerprint-chromium 150 —— 对项目实际访问的域做崩溃对照。
 *
 * 背景：fp-chromium 150 有 issue #94（canvas 伪装 + getImageData/readPixels → SIGSEGV），
 *   实测 rewards.bing.com 首页在项目真实 flag（开 canvas 伪装）下必崩。
 *   fp-chromium 150 之后无新版本（150 就是 latest），issue 至今未修。
 *   Chromix 154 是另一个 fork（xiaozhou26/Chromix，216 patches），还在活跃更新。
 *
 * 本脚本对同一批域跑两轮：
 *   A: fingerprint-chromium 150 + fp flags（= 项目当前真实形态）
 *   B: Chromix 154 + 等价 flags（注意 flag 命名不同）
 * 只读 DOM，绝不调 page.screenshot（避免 readPixels 干扰）。
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

const CHROMIX_EXE = path.join(ROOT, "storage", "chromix-test", "chromix", "chrome.exe");

// 项目实际访问的域（来自 src/tasks.js / runner.js / auth.js / browser.js）
// 只测项目每天真会跑的目标；creepjs / pixelscan 这类重检测站用 --full 才加
const TARGETS = [
  { url: "https://login.live.com/", name: "login.live.com" },
  { url: "https://www.bing.com/", name: "www.bing.com" },
  { url: "https://cn.bing.com/", name: "cn.bing.com" },
  { url: "https://rewards.bing.com/", name: "rewards.bing.com" },
  { url: "https://rewards.bing.com/earn", name: "rewards.bing.com/earn" },
  { url: "https://antcpt.com/score_detector/", name: "antcpt score_detector" },
];

if (process.argv.includes("--full")) {
  TARGETS.push(
    { url: "https://abrahamjuliot.github.io/creepjs/", name: "creepjs" },
    { url: "https://pixelscan.net/fingerprint-check", name: "pixelscan" }
  );
}

// ── 两套浏览器配置 ──
const CANDIDATES = [
  {
    label: "fp-chromium 150（当前）",
    exe: fp_.executablePath(),
    // buildArgs 原样：项目 openContext 真实传的 flag
    args: (seed) => [
      ...fp_.buildArgs({ seed }),
      "--exclude-switches=enable-automation",
      "--disable-infobars",
      "--no-first-run",
      "--disable-default-apps",
      "--no-default-browser-check",
      "--disable-sync",
    ],
    available: () => {
      try { return fp_.isReady(); } catch { return false; }
    },
  },
  {
    label: "Chromix 154（新）",
    exe: CHROMIX_EXE,
    // Chromix flag 命名：--fingerprint-timezone / --fingerprint-locale（不是 --timezone/--accept-lang）
    args: (seed) => [
      `--fingerprint=${seed}`,
      "--fingerprint-platform=windows",
      "--fingerprint-timezone=Asia/Shanghai",
      "--fingerprint-locale=zh-CN",
      "--exclude-switches=enable-automation",
      "--disable-infobars",
      "--no-first-run",
      "--disable-default-apps",
      "--no-default-browser-check",
      "--disable-sync",
    ],
    available: () => fs.existsSync(CHROMIX_EXE),
  },
];

const { chromium } = require_(path.join(ROOT, "node_modules", "playwright-core"));
const HEADED = !process.argv.includes("--head");

async function probe(cand, url, seed) {
  const tmpProf = fs.mkdtempSync(path.join(os.tmpdir(), "msr-cmp-"));
  let crashed = false;
  let snap = null;
  try {
    const context = await chromium.launchPersistentContext(tmpProf, {
      executablePath: cand.exe,
      headless: !HEADED,
      args: cand.args(seed),
      ignoreHTTPSErrors: true,
      viewport: HEADED ? { width: 1366, height: 768 } : null,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });
    const page = context.pages()[0] || (await context.newPage());
    page.on("crash", () => { crashed = true; });
    await page.goto(url, { waitUntil: "commit", timeout: 30000 });
    // creepjs / pixelscan 计算量大，多等；普通域 3 秒够
    const waitMs = /creepjs|pixelscan/.test(url) ? 12000 : 4000;
    await new Promise((r) => setTimeout(r, waitMs));
    if (!crashed) {
      snap = await page.evaluate(() => ({
        title: (document.title || "").slice(0, 40),
        bodyChars: (document.body.innerText || "").length,
        canvases: document.querySelectorAll("canvas").length,
      })).catch((e) => ({ error: e.message.slice(0, 40) }));
    }
    await context.close().catch(() => {});
  } catch (e) {
    crashed = crashed || false;
    snap = { error: e.message.slice(0, 60) };
  }
  // 临时 profile 常被 chrome 子进程短暂占用（EBUSY），重试几次再放弃。
  // 清理失败不影响测试结论，绝不让它中断整轮对照。
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tmpProf, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  return { crashed, snap };
}

const seed = fp_.seedFor("msr-compare-2026-10-05");
console.log("种子:", seed, "| 模式:", HEADED ? "GUI" : "headless");
console.log();

const results = {};
for (const cand of CANDIDATES) {
  if (!cand.available()) {
    console.log(`=== ${cand.label} → 不可用，跳过 ===\n`);
    results[cand.label] = null;
    continue;
  }
  console.log(`========== ${cand.label} ==========`);
  results[cand.label] = {};
  for (const t of TARGETS) {
    process.stdout.write(`  ${t.name.padEnd(26)} ... `);
    const { crashed, snap } = await probe(cand, t.url, seed);
    results[cand.label][t.name] = { crashed, snap };
    if (crashed) console.log("❌ CRASH");
    else if (snap?.error) console.log("⚠️ ", snap.error);
    else console.log(`✅ "${snap?.title || ""}" canvas=${snap?.canvases} chars=${snap?.bodyChars}`);
  }
  console.log();
}

// 汇总
console.log("========== 汇总对照 ==========");
const labels = CANDIDATES.map((c) => c.label).filter((l) => results[l]);
if (labels.length === 2) {
  console.log("域".padEnd(28) + labels[0].padEnd(22) + labels[1]);
  for (const t of TARGETS) {
    const a = results[labels[0]]?.[t.name];
    const b = results[labels[1]]?.[t.name];
    const f = (r) => (!r ? "跳过" : r.crashed ? "❌CRASH" : "✅ok");
    console.log(t.name.padEnd(28) + f(a).padEnd(22) + f(b));
  }
  const crashA = Object.values(results[labels[0]] || {}).filter((r) => r.crashed).length;
  const crashB = Object.values(results[labels[1]] || {}).filter((r) => r.crashed).length;
  console.log(`\n崩溃数: ${labels[0]}=${crashA} · ${labels[1]}=${crashB}`);
}