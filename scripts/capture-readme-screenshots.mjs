/**
 * 重拍 README 用的界面截图。
 *
 * 用法：
 *   1. 先起预览服务：npm run dev:web（或 vite --port 5183）
 *   2. node scripts/capture-readme-screenshots.mjs [http://127.0.0.1:5183]
 *
 * 两处刻意的处理，改脚本前先看懂，不然截图会退化：
 *
 * ① 壁纸用「当日必应一图」：dev:web 走 mock 后端，getBgSrc 只回一张 SVG 渐变占位，
 *    拿不到真壁纸。这里自己问必应官方 HPImageArchive 拿当日直链，再用
 *    .bg-image{background-image:url(...)!important} 覆盖内联 style
 *    （样式表 !important 优先于内联普通声明）。blur/dim 渲染链与真机一致。
 *    ⚠️ 必应图每天换 → README 截图会「过期」，发版时重跑一次即可。
 *
 * ② 关掉鼠标光晕：project 自绘 halo 由 --lg-halo-alpha 控制，玻璃库自带的跟手光斑是
 *    .lg-glow。截图是静态图，光标停在默认位置会留一大团白光，很丑且毫无信息量。
 *    这里用 *{--lg-halo-alpha:0!important} + .lg-glow{opacity:0!important} 灭掉
 *    （!important 覆盖元素上的内联 setProperty）。
 *
 *    排查备忘（2026-10-04，别再走弯路）：关掉光晕后画面左侧仍可能有一团柔和白光，
 *    那不是光晕残留，是**当日必应图自带的内容**（那天正好是 Artemis 1 与满月，
 *    月亮被 4px 模糊成一团）。逐层关掉 body::before / ::after / 光晕都不消失、
 *    关掉 .bg-image 才消失即可确认。属壁纸本身，不改代码。
 */
import { chromium } from "playwright-core";
import https from "node:https";

const BASE = process.argv[2] || "http://127.0.0.1:5183";
const OUT = "docs/screenshots/";

/** 当日必应一图直链（与 src/uapi.js 的 HPImageArchive 兜底同源） */
function todayBing() {
  return new Promise((resolve) => {
    const req = https.get(
      "https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1",
      { headers: { "User-Agent": "Mozilla/5.0" } },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            const img = JSON.parse(body).images?.[0];
            const url = img?.url?.startsWith("http")
              ? img.url
              : `https://cn.bing.com${img?.url || ""}`;
            resolve({ url, title: img?.title || "" });
          } catch {
            resolve({ url: "", title: "" });
          }
        });
      }
    );
    req.on("error", () => resolve({ url: "", title: "" }));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ url: "", title: "" });
    });
  });
}

const { url: BING, title } = await todayBing();
if (!BING) {
  console.error("取当日必应图失败，终止（不想拿占位渐变冒充壁纸）");
  process.exit(1);
}
console.log("今日必应一图：", title || "(无标题)", BING.slice(0, 60) + "…");

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();
// 预热图片，避免截图瞬间还没解码完
await page.goto(BING, { timeout: 60000 }).catch(() => {});

async function shot(name, steps) {
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2000);
  for (const label of steps) {
    const el = page.getByText(label, { exact: true }).first();
    if ((await el.count()) === 0) {
      console.log(`MISS "${label}" → 跳过 ${name}`);
      return;
    }
    await el.click();
    await page.waitForTimeout(1400);
  }
  await page.addStyleTag({
    content: [
      `.bg-image{background-image:url("${BING}") !important;}`,
      /* 关鼠标光晕（截图不需要展示光标） */
      `*{--lg-halo-alpha:0 !important;}`,
      `.lg-glow{opacity:0 !important;}`,
    ].join("\n"),
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + name, type: "jpeg", quality: 84 });
  console.log("ok", name);
}

await shot("dashboard.jpg", ["仪表盘"]);
await shot("achievements.jpg", ["成就与统计"]);
await shot("settings.jpg", ["软件设置"]);
await shot("browser.jpg", ["软件设置", "浏览器"]);

await browser.close();
