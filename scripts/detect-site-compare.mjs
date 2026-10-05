/**
 * 指纹/伪装检测站 × 两个浏览器 —— 看谁被判成机器人。
 *
 * 背景：2026-10-05 查明 fingerprint-chromium 150 有 issue #94（canvas 伪装 +
 *   getImageData/readPixels → SIGSEGV），三个项目域随机崩。上游 150 之后无新版本。
 *   Chromix 154（xiaozhou26/Chromix）实测那三个域零崩溃 —— 但「不崩」只说明
 *   稳定性过关，**还没验过伪装水平**。本脚本补这一块。
 *
 * 检测站（业界标准四项，覆盖不同判定维度）：
 *   - bot.sannysoft.com   综合 webdriver/plugins/权限/Notification 等
 *   - bot detection 实验室（abrahamjuliot）→ creepjs 已另见 antcpt
 *   - pixelscan.net       一致性检测（最严，会抓"单项都对但组合矛盾"）
 *   - browserscan.net     环境一致性（容器/Docker 判定的老祖宗）
 *   - akile.ai            项目记忆里 2026-09-26 对照实验用过
 *
 * 铁律：只读 DOM，**绝不调 page.screenshot()**（其内部 readPixels 在 fp150 上必崩）。
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

// Chromix 已装进项目的 installDir()（与桌面版运行时下载产物同构），
// 直接问模块要路径 —— 别写死 storage/chromix-test 那种一次性测试目录。
const CHROMIX_EXE = fp_.executablePath();

const seed = fp_.seedFor("msr-detect-check");
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
    label: "Chromix 154（当前钉死版本）",
    exe: CHROMIX_EXE,
    args: [
      `--fingerprint=${seed}`,
      "--fingerprint-platform=windows",
      "--fingerprint-timezone=Asia/Shanghai",
      "--fingerprint-locale=zh-CN",
      ...STEALTH,
    ],
  },
];

// 只读整页 innerText 的检测站（各站判词都在 DOM 明文里）
const ALL_SITES = [
  { url: "https://abrahamjuliot.github.io/creepjs/", name: "creepjs", wait: 18000 },
  { url: "https://antcpt.com/score_detector/", name: "antcpt", wait: 15000, refresh: true, settle: 30000 },
  { url: "https://ippure.com/cloudflare.html", name: "ippure", wait: 15000, ippure: true },
  { url: "https://bot.sannysoft.com/", name: "sannysoft", wait: 8000 },
  { url: "https://browserscan.net/", name: "browserscan", wait: 8000 },
  { url: "https://pixelscan.net/fingerprint-check", name: "pixelscan", wait: 12000 },
  { url: "https://akile.ai/", name: "akile.ai", wait: 6000 },
];

// GUI 模式每站要起一次浏览器实例，跑满 6 站会超时被 kill —— 允许按名字筛：
//   node scripts/detect-site-compare.mjs creepjs antcpt
const want = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const SITES = want.length
  ? ALL_SITES.filter((s) => want.some((w) => s.name.includes(w)))
  : ALL_SITES.slice(0, 2);
if (!SITES.length) {
  console.error("没有匹配的站点。可选：", ALL_SITES.map((s) => s.name).join(" / "));
  process.exit(1);
}

const { chromium } = require_(path.join(ROOT, "node_modules", "playwright-core"));

/**
 * 从整页文本里抠出判定。
 *
 * ⚠️ 三个都踩过的坑：
 *  1. 不能"全文 grep bot/robot" —— antcpt 说明文字本身就写着「considers you as
 *     HUMAN or BOT」「0.0 is very likely a bot」，会把每条都误报成被判成机器人。
 *  2. 不能"全文 grep 0.x" —— 同一段说明里有 `(< 0.3)`、`(>= 0.7)` 两个阈值。
 *  3. antcpt 的分数是**站方后端**拿 token 问 Google 换来的，页面自带
 *     `Detecting score...` 中间态；这个状态既不是 0 分也不是没跑完，
 *     必须单独识别，否则会把"还在算"当成"算完了没通过"。
 */
function verdict(text) {
  const flat = text.replace(/\s+/g, " ");
  const grab = (re) => {
    const m = flat.match(re);
    return m ? m[0].trim().slice(0, 60) : null;
  };
  // creepjs：总判定词（说谎检测走 .lie / .fail 选择器，不在这里）
  const creepVerdict = grab(/\b(unusual result|lying|normal|fake|bot detected)\b/i);
  // sannysoft：webdriver 那几项
  const sanny = grab(/WebDriver[^A-Za-z]{0,4}(true|false)/i);
  // antcpt：先认中间态
  const pending = /Detecting score/i.test(flat);
  // 分数**不从 innerText 抓** —— 说明文字里全是数字（antcpt 的「0.0 is likely a
  // bot」、ippure 的整张评分标准表「0.9~1.0 极佳」），正则必误报。
  // 真实分数只由 probe 里的结构化取证（scoreNodes）给出。
  const scoreRow = null;
  const low = false;
  return {
    creepVerdict,
    score: scoreRow,
    sanny,
    pending,
  // 真被判定为机器人：低分 或 creepjs 明确异常判词（**不含** pending）
  // ⚠️ 又一个坑（今天第 5 次同类）：ippure 的页面把"评分标准"整张表印出来
  //   ——「0.9~1.0 ⭐⭐⭐⭐⭐ 极佳」「0.0~0.3 ⭐ 很差」—— 里面全是 0.x，
  //   纯正则会把"0.0"当成实测分数。所以分数只从**结构化节点**取（见 probe 里的
  //   scoreNodes），innerText 里的数字一律不作为判定依据。
  flagged: !!(low || /unusual result|lying|bot detected|fake/i.test(flat)),
    // 三态：pending（还在算）/ flagged（被判机器人）/ clean
    state: pending ? "pending" : low ? "flagged" : "clean",
    head: flat.slice(0, 240),
  };
}

async function probe(cand, site) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msr-det-"));
  let crashed = false;
  let out = null;
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
    await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 40000 });
    await new Promise((r) => setTimeout(r, site.wait));
    // 分数型站点的判定是**异步**的：页面自己每 2 秒轮询，但要人点一次
    // "Refresh score now!" 才会真的去请求 reCAPTCHA。所以这里多等一轮 +
    // 点一下刷新按钮，再抓 —— 否则只会读到占位文案（0.9/0.1 之类）。
    if (site.refresh) {
      try {
        await page.getByText(/refresh score/i).first().click({ timeout: 5000 });
        console.log("[已点刷新]");
      } catch {
        console.log("[无刷新按钮]");
      }
      await new Promise((r) => setTimeout(r, site.settle || site.wait));
    }
    if (!crashed) {
      const text = await page.evaluate(() => document.body.innerText || "").catch(() => "");
      out = verdict(text);
      // ── 结构性取证：说明文字里的数字不算判定，必须抓「独立文本节点」 ──
      // antcpt 的说明段里就有 `1.0 is very likely a good interaction`、
      // `0.0 is very likely a bot`、阈值 `(< 0.3)` / `(>= 0.7)` ——
      // 纯 innerText 正则会全中，必须按 DOM 节点形态区分。
      if (/score_detector/.test(site.url)) {
        out.struct = await page
          .evaluate(() => {
            const hits = [];
            const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let n;
            while ((n = walk.nextNode())) {
              const t = (n.nodeValue || "").trim();
              if (/^(0\.\d|1\.0)$/.test(t)) {
                hits.push({ text: t, parent: n.parentElement?.tagName || "?" });
              }
            }
            return {
              scoreNodes: hits,
              // 说明文字里的数字在 <B> 里；真分数通常是独立容器。
              // 无法可靠区分时如实标 unknown，别猜。
              realScore:
                hits.length === 1 && hits[0].parent !== "B" && hits[0].parent !== "SPAN"
                  ? hits[0].text
                  : null,
            };
          })
          .catch(() => null);
        // 只有真拿到分数才判成败；否则一律算「未定」
        if (!out.struct || !out.struct.realScore) {
          out.pending = true;
          out.state = "pending";
          out.flagged = false;
          out.score = null;
        } else {
          out.score = out.struct.realScore;
          out.pending = false;
          out.flagged = parseFloat(out.struct.realScore) < 0.5;
          out.state = out.flagged ? "flagged" : "clean";
        }
      }
      // ippure：核心指标是「风险指数: NN / 100」+ Cloudflare 风控信息。
      // ⚠️ 页面里还有整张「0.9~1.0 ⭐⭐⭐⭐⭐ 极佳」评分标准表，不能当实测值。
      if (site.ippure) {
        out.ippure = await page
          .evaluate(() => {
            const txt = document.body.innerText || "";
            // 风险指数是唯一真分数，格式固定「风险指数: 97 / 100」
            const risk = /风险指数[:：]\s*(\d+)\s*\/\s*100/.exec(txt);
            const cf = /cf-mitigated|cf-chl|challenge/i.test(txt);
            // 拿到的是"这个 IP 整体风险"，跟浏览器指纹分开看
            return {
              riskIndex: risk ? Number(risk[1]) : null,
              hasCloudflareChallenge: cf,
            };
          })
          .catch(() => null);
        if (out.ippure) {
          const r = out.ippure.riskIndex;
          out.score = r != null ? String(r) : null;
          out.pending = r == null;
          // ippure 的分数是 IP 信誉为主（0-100，越高越危险），不能按
          // reCAPTCHA 那种「<0.5 即机器人」的阈值套 —— 单独标记
          out.state = r == null ? "pending" : r >= 50 ? "ip-risky" : "clean";
          out.flagged = false; // IP 风险 ≠ 浏览器被判机器人，分开看
        }
      }
      // creepjs 的核心是「说谎检测」——把 lie 段落单独抠出来，这是判断伪装是否
      // 自洽的关键（UA/CH/时区/语言互相矛盾时它会在这里报）。
      if (/creepjs/.test(site.url)) {
        out.lies = await page
          .evaluate(() => {
            const grab = (sel) =>
              Array.from(document.querySelectorAll(sel))
                .map((n) => (n.innerText || "").replace(/\s+/g, " ").trim())
                .filter((t) => t && t.length > 2)
                .slice(0, 12);
            return { lie: grab(".lie, [class*='lie']"), fail: grab(".fail, .bad") };
          })
          .catch(() => ({ lie: [], fail: [] }));
      }
    }
    await context.close().catch(() => {});
  } catch (e) {
    out = { error: e.message.slice(0, 80) };
  }
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 600)); }
  }
  return { crashed, out };
}

console.log("种子:", seed, "| 模式: GUI");
console.log("（fp 150 遇 getImageData/readPixels 会 SIGSEGV，见 issue #94）\n");

const summary = {};
for (const cand of CANDS) {
  if (!fs.existsSync(cand.exe)) {
    console.log(`=== ${cand.label} → exe 不存在，跳过 ===\n`);
    continue;
  }
  console.log(`========== ${cand.label} ==========`);
  summary[cand.label] = {};
  for (const site of SITES) {
    process.stdout.write(`  ${site.name.padEnd(14)} ... `);
    const { crashed, out } = await probe(cand, site);
    if (crashed) {
      console.log("❌ 浏览器崩溃 (issue #94)");
      summary[cand.label][site.name] = "CRASH";
    } else if (out?.error) {
      console.log("⚠️ ", out.error);
      summary[cand.label][site.name] = "ERR";
    } else {
      const tag = out?.creepVerdict || out?.score || (out?.pending ? "Detecting…" : "-");
      summary[cand.label][site.name] = out?.state || "clean";
      console.log(
        `判定="${tag}" ` +
        `webdriver=${out?.sanny || "-"} ` +
        `${
          out?.state === "flagged" ? "❌ 判为机器人" :
          out?.state === "pending" ? "⏳ 站方后端还在算分（不是失败）" :
          "✅ 通过"
        }`
      );
      console.log(`    首段: ${out?.head?.slice(0, 220)}`);
      if (out?.struct) {
        console.log(
          `    分数节点: ${JSON.stringify(out.struct.scoreNodes)}` +
            ` → ${out.struct.realScore ? "真分数 " + out.struct.realScore : "全是说明文字里的数字，未定"}`
        );
      }
      if (out?.ippure) {
        console.log(
          `    风险指数: ${out.ippure.riskIndex ?? "(未取到)"} / 100` +
            ` · Cloudflare 挑战: ${out.ippure.hasCloudflareChallenge ? "有" : "无"}`
        );
      }
      if (out?.table?.length) {
        console.log("    表格/结果行:");
        for (const r of out.table) console.log(`      ${r.slice(0, 130)}`);
      }
      if (out?.lies) {
        console.log(`    说谎检测: ${out.lies.lie.length} 条 lie · ${out.lies.fail.length} 条 fail`);
        for (const l of out.lies.lie) console.log(`      [lie] ${l.slice(0, 110)}`);
        for (const l of out.lies.fail) console.log(`      [fail] ${l.slice(0, 110)}`);
      }
    }
  }
  console.log();
}

console.log("========== 汇总 ==========");
const labels = Object.keys(summary);
if (labels.length) {
  for (const site of SITES) {
    console.log(site.name.padEnd(14) + labels.map((l) => (summary[l]?.[site.name] || "-").toString().padEnd(16)).join(""));
  }
}
console.log("\n注：判词需人工判读（各站措辞不同），脚本只做采集不做断言。");