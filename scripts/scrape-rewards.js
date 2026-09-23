// 抓取 MS Rewards 官网真实积分页面（含原始 HTML，便于离线核对字段）
// 用法: node scripts/scrape-rewards.js
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "scrape-out");
const PROFILE = path.join(ROOT, "scrape-profile");
fs.mkdirSync(OUT_DIR, { recursive: true });

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  const t = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log("[" + t + "]", ...args);
}

function save(name, data) {
  const p = path.join(OUT_DIR, name);
  fs.writeFileSync(p, data, "utf-8");
  log("[save]", p);
}

function saveErr(e, label) {
  try {
    const p = path.join(OUT_DIR, "errors.log");
    fs.appendFileSync(p, new Date().toISOString() + " " + label + ": " + e.message + "\n", "utf-8");
  } catch {}
}

process.on("uncaughtException", (e) => {
  log("[uncaughtException]", e.message);
  saveErr(e, "uncaughtException");
  process.exit(99);
});
process.on("unhandledRejection", (e) => {
  log("[unhandledRejection]", e && e.message);
  saveErr(e, "unhandledRejection");
  process.exit(99);
});

async function main() {
  let browser;
  let launched = false;
  let lastErr;
  for (const ch of ["msedge", "chrome"]) {
    try {
      browser = await chromium.launch({ headless: false, channel: ch, args: ["--no-sandbox"] });
      log("[launch] channel=" + ch);
      launched = true;
      break;
    } catch (e) {
      lastErr = e;
      log("[launch] " + ch + " 失败: " + e.message);
    }
  }
  if (!launched) {
    try {
      browser = await chromium.launch({ headless: false, args: ["--no-sandbox"] });
      log("[launch] default chromium");
      launched = true;
    } catch (e) {
      log("[launch] 全部失败: " + (lastErr && lastErr.message) + " / " + e.message);
      process.exit(2);
    }
  }

  // 持久化上下文：登录后再次运行可复用
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    userAgent: UA,
  });

  const pages = context.pages();
  const page = pages[0] || (await context.newPage());

  const responses = [];
  context.on("response", (r) => {
    const u = r.url();
    if (/rewards\.bing\.com|rewardsplatform\.microsoft\.com|login\.microsoftonline\.com/.test(u)) {
      responses.push(r.status() + " " + u);
    }
  });

  log("[nav] 打开 https://rewards.bing.com ...");
  try {
    await page.goto("https://rewards.bing.com/earn", { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (e) {
    log("[nav] goto 出错: " + e.message);
  }
  await sleep(3000);

  // 先存当前页面
  try {
    const html0 = await page.content();
    save("rewards-raw-initial.html", html0);
    await page.screenshot({ path: path.join(OUT_DIR, "rewards-initial.png"), fullPage: false });
  } catch (e) {
    log("[save] 初始页面失败: " + e.message);
    saveErr(e, "initial-save");
  }

  log("[wait] 请在弹出的浏览器窗口登录MS账号。页面顶部出现积分后，保持 10 秒即可（最多等 10 分钟）。");
  const deadline = Date.now() + 10 * 60 * 1000;
  let loggedIn = false;
  let lastHtml = "";
  let tick = 0;

  while (Date.now() < deadline) {
    tick++;
    try {
      const st = await page.evaluate(() => {
        const txt = document.body ? document.body.innerText : "";
        const h = location.hostname;
        const href = location.href;
        return {
          host: h,
          href: href,
          title: document.title,
          hasAvailablePoints: /可用积分|Available points|available points|可用奖励|积分余额/i.test(txt),
          hasTotalPoints: /总积分|Total points|lifetime points|Lifetime points/i.test(txt),
          onLogin: /login\.live\.com|login\.microsoftonline\.com|sign in|请登录|Sign in to/i.test(h + " " + txt.slice(0, 800)),
          onRewards: /rewards\.bing\.com|bing\.com/.test(h),
          len: txt.length,
        };
      });

      if (tick % 5 === 0 || st.onRewards) {
        log("[tick]", tick, "host=", st.host, "title=", st.title, "onRewards=", st.onRewards, "hasAvail=", st.hasAvailablePoints, "hasTotal=", st.hasTotalPoints, "onLogin=", st.onLogin);
      }

      if (st.onRewards && st.hasAvailablePoints && !st.onLogin) {
        loggedIn = true;
        log("[detect] 已登录并检测到积分。等待 10 秒后保存最终页面...");
        // 多等一会儿让页面完全加载
        for (let k = 0; k < 5; k++) {
          await sleep(2000);
          try {
            const ss = await page.screenshot({ path: path.join(OUT_DIR, "rewards-loggedin.png"), fullPage: false });
            if (ss) break;
          } catch {}
        }
        break;
      }
    } catch (e) {
      log("[loop] evaluate 出错: " + e.message);
      saveErr(e, "loop-evaluate");
    }

    // 每 5 秒存一次快照，避免意外退出丢失登录后页面
    if (tick % 1 === 0) {
      try {
        const snap = await page.content();
        fs.writeFileSync(path.join(OUT_DIR, "rewards-snapshot-latest.html"), snap, "utf-8");
      } catch (e) {
        // ignore
      }
    }

    await sleep(5000);
  }

  // 无论结果如何都保存最终页面
  try {
    lastHtml = await page.content();
    save("rewards-raw-final.html", lastHtml);
    await page.screenshot({ path: path.join(OUT_DIR, "rewards-final.png"), fullPage: false });
  } catch (e) {
    log("[save] 最终页面失败: " + e.message);
    saveErr(e, "final-save");
    // fallback: 尝试用快照
    try {
      const snap = fs.readFileSync(path.join(OUT_DIR, "rewards-snapshot-latest.html"), "utf-8");
      save("rewards-raw-final.html", snap);
      log("[save] 使用快照作为最终页面");
    } catch {}
  }

  // 提取可见的“可用积分/总积分”文本
  const extracted = { loggedIn };
  try {
    const vis = await page.evaluate(() => {
      const txt = document.body ? document.body.innerText : "";
      const available = txt.match(/(?:可用积分|Available points|available points|可用奖励|积分余额)\D*([\d,\.]+)/i);
      const total = txt.match(/(?:总积分|Total points|lifetime points|Lifetime points)\D*([\d,\.]+)/i);
      // 也尝试从 aria-label / 属性里找
      const meta = {};
      for (const s of ["availablePoints", "balance", "pointsBalance", "totalPoints", "lifetimePoints"]) {
        try {
          const el = document.querySelector(`[data-bi-name="${s}"], [data-value], .${s}`);
          if (el) meta[s] = el.textContent || el.getAttribute("aria-label") || el.getAttribute("data-value");
        } catch {}
      }
      return {
        sample: txt.slice(0, 4000),
        available: available ? available[1] : null,
        total: total ? total[1] : null,
        meta,
      };
    });
    extracted.visible = vis;
  } catch (e) {
    extracted.error = e.message;
    saveErr(e, "extract-visible");
  }

  // 保存关键脚本/JSON 数据
  try {
    const raw = await page.evaluate(() => {
      const data = {};
      // rewards 页面常把配置/用户状态埋在 script 标签或 window 变量里
      for (const key of ["__BINGREWARDSPAGE__,", "GDR", "MicrosoftRewards", "rewardsData", "userStatus"]) {
        try { data[key] = window[key]; } catch {}
      }
      return data;
    });
    save("window-vars.json", JSON.stringify(raw, null, 2));
  } catch (e) {
    saveErr(e, "window-vars");
  }

  save("extracted.json", JSON.stringify(extracted, null, 2));
  save("responses.txt", responses.join("\n"));

  log("[done] loggedIn=", loggedIn, "responses=", responses.length, "extracted=", JSON.stringify(extracted, null, 2));
  try {
    await context.close();
  } catch {}
  process.exit(0);
}

main().catch((e) => {
  log("[fatal] " + e.message);
  saveErr(e, "fatal");
  process.exit(1);
});
