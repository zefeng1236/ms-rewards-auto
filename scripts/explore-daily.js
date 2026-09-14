// 探索「每日活动」与「可领取积分」的真实 DOM 结构
// 用法: node scripts/explore-daily.js
// 使用持久化 profile：首次需登录，之后复用登录态，无需再登
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "scrape-out");
const PROFILE = path.join(ROOT, "scrape-profile");
fs.mkdirSync(OUT_DIR, { recursive: true });

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...a) {
  console.log("[" + new Date().toISOString().slice(11, 19) + "]", ...a);
}
function save(name, data) {
  fs.writeFileSync(path.join(OUT_DIR, name), data, "utf-8");
  log("[save]", name);
}

process.on("uncaughtException", (e) => {
  log("[uncaught]", e.message);
  process.exit(99);
});

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    userAgent: UA,
  });
  const page = context.pages()[0] || (await context.newPage());

  log("[nav] 打开 rewards.bing.com ...");
  try {
    await page.goto("https://rewards.bing.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (e) {
    log("[nav] 出错: " + e.message);
  }
  await sleep(3000);

  // ---- 阶段 1：等待登录 ----
  let loggedIn = false;
  const deadline = Date.now() + 10 * 60 * 1000;
  let poll = 0;
  while (Date.now() < deadline) {
    poll++;
    try {
      const st = await page.evaluate(() => ({
        host: location.hostname,
        href: location.href,
        title: document.title,
        // 用完整 innerText（此前 slice(0,3000) 可能截掉「可用积分」）
        txt: document.body ? document.body.innerText : "",
      }));
      const hasAvail = /可用积分/.test(st.txt);
      if (poll === 1 || poll % 5 === 0 || hasAvail) {
        log(
          "[poll] " + poll + " host=" + st.host + " title=" + (st.title || "").slice(0, 24) +
          " len=" + st.txt.length + " hasAvail=" + hasAvail +
          " head=" + JSON.stringify(st.txt.slice(0, 80))
        );
      }
      if (st.host.includes("rewards.bing.com") && hasAvail) {
        loggedIn = true;
        log("[login] 已登录（检测到可用积分）");
        break;
      }
      // 每轮存一次快照，便于事后诊断页面状态
      if (poll % 5 === 0) {
        fs.writeFileSync(path.join(OUT_DIR, "explore-poll.html"), await page.content(), "utf-8");
      }
    } catch (e) {
      // 之前是空 catch，把真正的错误吞掉了，导致查不到失败原因
      log("[poll] " + poll + " evaluate 出错: " + e.message);
    }
    await sleep(3000);
  }
  if (!loggedIn) {
    log("[login] 超时未登录，保存当前页面后退出");
    save("explore-timeout.html", await page.content().catch(() => ""));
    await context.close().catch(() => {});
    process.exit(1);
  }

  // ---- 阶段 2：保存首页 ----
  await sleep(2000);
  save("explore-home.html", await page.content());
  await page.screenshot({ path: path.join(OUT_DIR, "explore-home.png"), fullPage: false });

  // ---- 阶段 3：展开「每日活动」并记录内部可点项 ----
  const result = { dailyActivity: null, claim: null };

  // 定位每日活动触发器（aria-label 或可见文本）
  const triggerSel = '[aria-label="每日活动"], [aria-label*="每日活动"]';
  let trigger = null;
  try {
    trigger = await page.$(triggerSel);
  } catch {}
  if (!trigger) {
    // 回退：按文本找 button
    const btns = await page.$$("button");
    for (const b of btns) {
      const t = (await b.innerText().catch(() => "")) || "";
      if (t.includes("每日活动")) {
        trigger = b;
        break;
      }
    }
  }

  if (trigger) {
    const info = await trigger.evaluate((el) => ({
      tag: el.tagName,
      ariaLabel: el.getAttribute("aria-label"),
      ariaExpanded: el.getAttribute("aria-expanded"),
      ariaControls: el.getAttribute("aria-controls"),
      role: el.getAttribute("role"),
      type: el.getAttribute("type"),
      slot: el.getAttribute("slot"),
    }));
    log("[daily] 触发器: " + JSON.stringify(info));
    const before = info.ariaExpanded;
    try {
      await trigger.click();
      log("[daily] 已点击展开");
    } catch (e) {
      log("[daily] 点击失败: " + e.message);
    }
    await sleep(2500);

    const after = await trigger.evaluate((el) => el.getAttribute("aria-expanded")).catch(() => null);
    log("[daily] aria-expanded: " + before + " -> " + after);

    await page.screenshot({ path: path.join(OUT_DIR, "explore-daily-expanded.png"), fullPage: false });

    // 抓取展开面板内部的可点项
    const panelId = info.ariaControls;
    const items = await page.evaluate((pid) => {
      let root = null;
      if (pid) root = document.getElementById(pid);
      if (!root) {
        // 回退：找触发器父级的后续兄弟节点
        return { error: "panel not found by id", pid };
      }
      const clickable = root.querySelectorAll("a[href], button, [role='button'], [role='link']");
      const list = [];
      for (const el of clickable) {
        const text = (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 120);
        list.push({
          tag: el.tagName,
          text,
          href: el.getAttribute("href"),
          ariaLabel: el.getAttribute("aria-label"),
          role: el.getAttribute("role"),
          target: el.getAttribute("target"),
          classes: (el.className || "").toString().slice(0, 120),
        });
      }
      return { panelHtml: root.innerHTML.slice(0, 20000), itemCount: list.length, items: list };
    }, panelId);

    result.dailyActivity = { trigger: info, expanded: after, ...items };
    save("explore-daily-activity.json", JSON.stringify(result.dailyActivity, null, 2));
    if (items && items.panelHtml) save("explore-daily-panel.html", items.panelHtml);
    log("[daily] 内部可点项数: " + (items && items.itemCount));
  } else {
    log("[daily] 未找到每日活动触发器");
    result.dailyActivity = { error: "trigger not found" };
  }

  // ---- 阶段 4：抓取「可领取 / 领取」结构 ----
  try {
    const claim = await page.evaluate(() => {
      const out = { cards: [], claimEls: [] };
      // 找含「可领取」文本的容器
      const all = document.querySelectorAll("div,p,a,button,span");
      for (const el of all) {
        const t = (el.textContent || "").trim();
        if (t === "可领取" || (t.includes("可领取") && t.length < 40)) {
          const card = el.closest("[class*='card'], [class*='Card']") || el.parentElement;
          out.cards.push({
            text: t.slice(0, 60),
            class: (card && card.className) || "",
            html: card ? card.innerHTML.slice(0, 3000) : "",
          });
        }
      }
      // 找「领取」可点元素
      for (const el of document.querySelectorAll("a[href], button, [role='button']")) {
        const t = (el.innerText || el.getAttribute("aria-label") || "").trim();
        if (t === "领取" || t.includes("领取")) {
          out.claimEls.push({
            tag: el.tagName,
            text: t.slice(0, 60),
            href: el.getAttribute("href"),
            ariaLabel: el.getAttribute("aria-label"),
            role: el.getAttribute("role"),
            classes: (el.className || "").toString().slice(0, 120),
          });
        }
      }
      return out;
    });
    result.claim = claim;
    save("explore-claim.json", JSON.stringify(claim, null, 2));
    log("[claim] 可领取卡片: " + claim.cards.length + " 个, 领取元素: " + claim.claimEls.length + " 个");
  } catch (e) {
    log("[claim] 抓取出错: " + e.message);
  }

  save("explore-result.json", JSON.stringify(result, null, 2));
  log("[done] 探索完成");
  await context.close().catch(() => {});
  process.exit(0);
}

main().catch((e) => {
  log("[fatal] " + e.message);
  process.exit(1);
});
