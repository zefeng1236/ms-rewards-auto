/**
 * Bing / 微软页面引导提示（环境拟真浏览器模式下也能跑）
 *
 * 用途：
 *   - 打开 Bing 时若右上角有「登录」按钮，自动点掉；
 *   - 遇到微软「我们即将更新条款 / 更新服务协议 / 更新隐私政策」这类必须用户点
 *     「下一步」的中间态时，在页面右下角注入一个尺寸较小的置顶提示，引导用户。
 *
 * 设计取舍 —— 为什么不像 stealth.js 那样走 addInitScript：
 *   指纹浏览器模式刻意不用 addInitScript（browser.js:282-285 的硬教训：哪怕一句
 *   `/* noop *\/` 注释都会被环境一致性检测站识破成 Robot）。这条 page-guide
 *   也走 page.evaluate（DOM 注入），不给 CDP 留指纹，与既有 tasks.js:495/539
 *   范式一致 —— page.evaluate 注入的 DOM 不被算作"额外指纹"。
 *
 * 注入策略：
 *   - 每个 page（context.on('page') 进来的）都挂载一次
 *   - 在 page.on('domcontentloaded' / 'load') 时执行 evaluate
 *   - 用 MutationObserver 监听 <title> / 大文本节点，对「更新条款」类页面即时切换提示文案
 *   - 提示元素：尺寸较小的置顶（z-index=2147483647）+ 右下角（bottom:24px / right:24px），
 *     pointer-events 仅关闭按钮可点，主体不动（不挡用户操作）
 */

const logger = require("./logger");

const GUIDE_STYLE_ID = "__msra_page_guide_style__";
const GUIDE_BODY_ID = "__msra_page_guide_body__";

/** 默认提示文案（Bing 普通页面：告知用户可随时停止任务） */
const GUIDE_DEFAULT_TITLE = "任务正在自动执行";
const GUIDE_DEFAULT_BODY =
  "本软件正在后台自动完成任务；如需立即停止，请在软件主界面点「停止」按钮" +
  "（含等待中的延时与排队任务，立即生效）。";

/** 「微软条款更新」类页面的引导文案（截图场景） */
const GUIDE_TERMS_TITLE = "检测到微软条款更新";
const GUIDE_TERMS_BODY = "请按微软要求点下方「下一步」按钮继续。";

/** 命中条款更新的关键词（标题/H1/明显大文本） */
const TERMS_KEYWORDS = [
  "更新条款",
  "更新服务协议",
  "更新隐私政策",
  "更新 Microsoft 服务协议",
  "Microsoft 服务协议",
  "服务协议更新",
  "Privacy Policy",
  "Terms of use",
];

/**
 * 给一个 page 装上引导提示（同一页面只装一次）。
 *
 * @param {import("playwright").Page} page
 * @param {{ silent?: boolean }} [opts] silent=true 不打 info 日志（用户主动登录等场景）
 */
function attachPageGuide(page, opts = {}) {
  if (!page) return;
  if (page.__msraPageGuide) return;
  page.__msraPageGuide = true;

  let lastTermsState = null;
  let lastUrl = null;

  const refresh = async () => {
    try {
      const url = page.url();
      const isBing =
        /(^|\.)bing\.com$|\.bing\.com\//i.test(new URL(url).hostname);
      // Bing 登录自动点：先尝试点右上角「登录」入口
      if (isBing) {
        await tryClickBingLogin(page);
      }
      const state = await page.evaluate(guideScript, {
        termsKeywords: TERMS_KEYWORDS,
        defaultTitle: GUIDE_DEFAULT_TITLE,
        defaultBody: GUIDE_DEFAULT_BODY,
        termsTitle: GUIDE_TERMS_TITLE,
        termsBody: GUIDE_TERMS_BODY,
        styleId: GUIDE_STYLE_ID,
        bodyId: GUIDE_BODY_ID,
        prevTerms: lastTermsState,
      });
      if (state) {
        if (state !== lastTermsState && !opts.silent) {
          logger.info(`[page-guide] ${url} → ${state === "terms" ? "微软条款更新提示" : "通用引导"}`);
        }
        lastTermsState = state;
        lastUrl = url;
      }
    } catch (e) {
      // 页面可能在导航中 evaluate 失败 —— 下次 load 会再试
      if (!opts.silent) logger.warn(`[page-guide] 评估失败: ${e.message}`);
    }
  };

  // 多次事件都触发评估，幂等
  page.on("domcontentloaded", refresh);
  page.on("load", refresh);
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) refresh();
  });

  // 首次立刻评估一次（attach 时可能已经 load 完了）
  refresh();
}

/**
 * 检测并点击 Bing 登录入口。
 *
 * 选择器按"MS 多年不变的稳定 ID"优先：
 *   - Bing 首页登录入口：#id_l（fallback: aria-label 含「登录」/ a#id_a）
 *
 * 只在「未登录」时点（已登录：右上角是用户头像，不是登录入口）。
 *
 * 注意：环境拟真浏览器模式下 addInitScript 被禁（CDP 检测），但 page.evaluate
 * 注入 DOM 是允许的 —— 这里 evaluate 只读 document.querySelector，不改 fingerprint。
 */
async function tryClickBingLogin(page) {
  try {
    const clicked = await page.evaluate(() => {
      // 「已登录」信号：头像 / 退出按钮 / _U cookie 都行；最直观的是右侧有用户菜单
      if (
        document.querySelector("#id_n") || // 登录后右上角的用户菜单节点
        document.querySelector('a[aria-label*="注销"]') ||
        document.querySelector('a[aria-label*="退出"]') ||
        document.querySelector("#b_sydPayText")
      ) {
        return "logged-in";
      }
      for (const sel of [
        "#id_l",
        'a[aria-label="登录"]',
        "#id_a",
        'a[aria-label*="登录"]',
      ]) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          el.click();
          return sel;
        }
      }
      return null;
    });
    if (clicked && clicked !== "logged-in") {
      logger.info(`[page-guide] 自动点击 Bing 登录入口（${clicked}）`);
    }
  } catch {}
}

/**
 * 在页面里跑的 IIFE —— 注入/更新右下角置顶提示。
 *
 * 通过 evaluate 的方式注入：因为 page-guide 自身不能用 addInitScript（CDP 指纹）。
 * evaluate 注入 DOM 不在 navigator / UA / WebGL 上添指纹，安全性等同既有 tasks.js:495。
 *
 * @param {{
 *   termsKeywords: string[], defaultTitle: string, defaultBody: string,
 *   termsTitle: string, termsBody: string, styleId: string, bodyId: string,
 *   prevTerms: string|null
 * }} cfg
 * @returns {"default"|"terms"|null}
 */
function guideScript(cfg) {
  const { termsKeywords, defaultTitle, defaultBody, termsTitle, termsBody, styleId, bodyId } = cfg;
  try {
    // 命中条款更新页：扫 title + h1 + 大正文块
    const text = (document.title || "") + " " +
      Array.from(document.querySelectorAll("h1, h2, [role='heading']"))
        .map((n) => (n.textContent || "").trim())
        .join(" ") + " " +
      (document.body?.innerText || "").slice(0, 2000);
    const isTerms = termsKeywords.some((kw) => text.includes(kw));

    // 注入 CSS（幂等）
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
#${bodyId} {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 2147483647;
  max-width: 280px;
  min-width: 200px;
  padding: 10px 30px 10px 12px;
  border-radius: 10px;
  background: rgba(20, 22, 28, 0.92);
  color: #e7eaf2;
  font: 12px/1.45 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  pointer-events: none;
  backdrop-filter: blur(8px);
}
#${bodyId} .msra-title { font-weight: 600; margin-bottom: 4px; font-size: 12px; }
#${bodyId} .msra-body { font-size: 11px; opacity: 0.86; white-space: pre-wrap; }
#${bodyId}.msra-terms { background: rgba(184, 56, 56, 0.94); }
#${bodyId}.msra-terms .msra-title::before { content: "⚠ "; }
#${bodyId} .msra-close {
  position: absolute; top: 4px; right: 6px;
  background: transparent; border: 0; color: inherit; cursor: pointer;
  pointer-events: auto; padding: 2px 6px; font: 14px/1 inherit;
  opacity: 0.65;
}
#${bodyId} .msra-close:hover { opacity: 1; }
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    let body = document.getElementById(bodyId);
    if (!body) {
      body = document.createElement("div");
      body.id = bodyId;
      body.innerHTML = `
<button class="msra-close" aria-label="关闭">×</button>
<div class="msra-title"></div>
<div class="msra-body"></div>`;
      body.querySelector(".msra-close").addEventListener("click", () => body.remove());
      (document.body || document.documentElement).appendChild(body);
    }

    const titleEl = body.querySelector(".msra-title");
    const bodyEl = body.querySelector(".msra-body");
    if (isTerms) {
      body.classList.add("msra-terms");
      titleEl.textContent = termsTitle;
      bodyEl.textContent = termsBody;
      return "terms";
    }
    body.classList.remove("msra-terms");
    titleEl.textContent = defaultTitle;
    bodyEl.textContent = defaultBody;
    return "default";
  } catch {
    return null;
  }
}

module.exports = {
  attachPageGuide,
  tryClickBingLogin,
  TERMS_KEYWORDS,
  GUIDE_DEFAULT_TITLE,
  GUIDE_DEFAULT_BODY,
  GUIDE_TERMS_TITLE,
  GUIDE_TERMS_BODY,
};