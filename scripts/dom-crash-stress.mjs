/**
 * 那三个会崩的域 × 多轮重复 × 两个浏览器 —— 判定崩溃率。
 *
 * 背景（2026-10-05 实测）：fingerprint-chromium 150 开启 canvas 伪装时，
 * 页面调 getImageData / WebGL readPixels 读回像素会让渲染进程 SIGSEGV
 * （上游 issue adryfish/fingerprint-chromium#94，至今未修，150 之后无新版本）。
 * 上一轮单次对照发现崩溃**有随机性**（login.live.com 第一轮 ok、第二轮 crash），
 * 所以每个域必须跑多轮才能给出可信的崩溃率。
 *
 * 这三个域是项目每天真会跑的（tasks.js / runner.js / auth.js / browser.js）：
 *   - login.live.com        OAuth 授权登录
 *   - rewards.bing.com      积分统计首页
 *   - rewards.bing.com/earn 积分赚取页
 *
 * 铁律：只读 DOM，**绝不调 page.screenshot()** —— 它自身会触发 readPixels，
 *       在 fp 150 上必崩，会把"浏览器崩了"和"截图动作崩了"混为一谈。
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

// 项目真实 flag（fp 150 开 canvas 伪装 = 崩溃前提）
const seed = fp_.seedFor("msr-dom-stress");
const STEALTH = [
  "--exclude-switches=enable-automation",
  "--disable-infobars",
  "--no-first-run",
  "--disable-default-apps",
  "--no-default-browser-check",
  "--disable-sync",
];

const CANDS = [
  {
    label: "fp-chromium 150",
    exe: fp_.executablePath(),
    args: [...fp_.buildArgs({ seed }), ...STEALTH],
  },
  {
    label: "Chromix 154",
    exe: CHROMIX_EXE,
    // Chromix flag 命名不同：--fingerprint-timezone / --fingerprint-locale
    args: [
      `--fingerprint=${seed}`,
      "--fingerprint-platform=windows",
      "--fingerprint-timezone=Asia/Shanghai",
      "--fingerprint-locale=zh-CN",
      ...STEALTH,
    ],
  },
];

const TARGETS = [
  { url: "https://login.live.com/", name: "login.live.com" },
  { url: "https://rewards.bing.com/", name: "rewards.bing.com" },
  { url: "https://rewards.bing.com/earn", name: "rewards.bing.com/earn" },
];

// 轮数：崩溃是概率事件，3 轮能看出「必崩 / 偶发 / 不崩」；5 轮更有说服力
const ROUNDS = Number(process.env.ROUNDS || 5);

const { chromium } = require_(path.join(ROOT, "node_modules", "playwright-core"));

async function once(cand, url) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msr-stress-"));
  let crashed = false;
  let snap = null;
  try {
    const context = await chromium.launchPersistentContext(tmp, {
      executablePath: cand.exe,
      headless: false,
      args: cand.args,
      ignoreHTTPSErrors: true,
      viewport: { width: 1366, height: 768 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });
    const page = context.pages()[0] || (await context.newPage());
    page.on("crash", () => { crashed = true; });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // rewards 首页要跑完 JS 才算真正加载；给 5 秒
    await new Promise((r) => setTimeout(r, 5000));
    if (!crashed) {
      snap = await page.evaluate(() => ({
        title: (document.title || "").slice(0, 40),
        chars: (document.body.innerText || "").length,
      })).catch((e) => ({ error: e.message.slice(0, 40) }));
    }
    await context.close().catch(() => {});
  } catch (e) {
    snap = { error: e.message.slice(0, 60) };
  }
  // 临时 profile 常被 chrome 子进程短暂占用（EBUSY），必须重试
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 600)); }
  }
  return { crashed, snap };
}

console.log("种子:", seed, "| 轮数:", ROUNDS, "| 模式: GUI");
console.log("（崩溃 = 渲染进程 SIGSEGV，issue #94）\n");

const tally = {};
for (const cand of CANDS) {
  if (!fs.existsSync(cand.exe)) {
    console.log(`=== ${cand.label} → exe 不存在，跳过 ===\n`);
    continue;
  }
  console.log(`========== ${cand.label} ==========`);
  tally[cand.label] = {};
  for (const t of TARGETS) {
    let crashCount = 0;
    const details = [];
    for (let r = 1; r <= ROUNDS; r++) {
      process.stdout.write(`  ${t.name.padEnd(22)} 第${r}轮 ... `);
      const { crashed, snap } = await once(cand, t.url);
      if (crashed) {
        crashCount++;
        console.log("❌ CRASH");
      } else if (snap?.error) {
        console.log("⚠️ ", snap.error);
      } else {
        console.log(`✅ "${snap?.title || ""}"`);
      }
      details.push(crashed ? "CRASH" : (snap?.error ? "ERR" : "ok"));
    }
    tally[cand.label][t.name] = crashCount;
    const rate = Math.round((crashCount / ROUNDS) * 100);
    const verdict = crashCount === 0 ? "✅ 不崩" : crashCount === ROUNDS ? "❌ 必崩" : `⚠️ 偶发 ${rate}%`;
    console.log(`  → ${t.name}: ${crashCount}/${ROUNDS} 崩 ${verdict}\n`);
  }
}

// 汇总表
const labels = Object.keys(tally);
if (labels.length === 2) {
  console.log("========== 崩溃率汇总 ==========");
  console.log("域".padEnd(24) + labels[0].padEnd(20) + labels[1]);
  for (const t of TARGETS) {
    const a = tally[labels[0]][t.name];
    const b = tally[labels[1]][t.name];
    console.log(
      t.name.padEnd(24) +
      `${a}/${ROUNDS} (${Math.round((a / ROUNDS) * 100)}%)`.padEnd(20) +
      `${b}/${ROUNDS} (${Math.round((b / ROUNDS) * 100)}%)`
    );
  }
  const sumA = Object.values(tally[labels[0]]).reduce((a, b) => a + b, 0);
  const sumB = Object.values(tally[labels[1]]).reduce((a, b) => a + b, 0);
  const total = TARGETS.length * ROUNDS;
  console.log(
    `\n合计: ${labels[0]} ${sumA}/${total} 崩 · ${labels[1]} ${sumB}/${total} 崩`
  );
}