/**
 * Bing / 微软页面引导提示（环境拟真浏览器模式下也能跑）
 *
 * 用途：
 *   - 打开 Bing 时若右上角有「登录」按钮，自动点掉；
 *   - 自动点击没生效（Bing 右侧入口部分网络/区域下不跳）时，改为在右下角
 *     明确提示用户「请点击右上角登录」—— 2026-10-04 用户反馈「Bing 搜索页一直
 *     未登录、什么都没提示」；
 *   - 遇到微软「我们即将更新条款 / 更新服务协议 / 更新隐私政策」这类必须用户点
 *     「下一步」的中间态时，在页面右下角注入一个尺寸较小的置顶提示，引导用户。
 *
 * 状态优先级：terms（条款）> bing-login（Bing 未登录）> default（通用）。
 * 条款优先于登录：条款页点完才有 _U 票据，此时先让用户点条款。
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

/**
 * Bing 未登录时的提示文案（用户 2026-10-04 明确要求）。
 * 不只依赖自动点击：右上角「登录」在部分网络/区域下点击后不跳或跳错页，
 * 用户需要看到一句明确指令自己点。
 */
const GUIDE_BING_LOGIN_TITLE = "请先登录 Bing 账号";
const GUIDE_BING_LOGIN_BODY =
  "点击 Bing 页面右上角的「登录」按钮完成登录，本软件会自动继续同步并执行任务。";

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
      // 探测「Bing 未登录」：右上角有登录入口但没有用户菜单。
      // 必须给提示而非只靠自动点击 —— 2026-10-04 用户反馈 Bing 搜索页
      // 一直停在未登录、任务跑不出分，却什么都没提示。
      const bingState = isBing ? await probeBingLoginState(page) : null;
      const state = await page.evaluate(guideScript, {
        termsKeywords: TERMS_KEYWORDS,
        defaultTitle: GUIDE_DEFAULT_TITLE,
        defaultBody: GUIDE_DEFAULT_BODY,
        termsTitle: GUIDE_TERMS_TITLE,
        termsBody: GUIDE_TERMS_BODY,
        loginTitle: GUIDE_BING_LOGIN_TITLE,
        loginBody: GUIDE_BING_LOGIN_BODY,
        styleId: GUIDE_STYLE_ID,
        bodyId: GUIDE_BODY_ID,
        prevTerms: lastTermsState,
        isBing: !!isBing,
        // 仅是首帧初值：页内 MutationObserver 会在 DOM 变化后自行重算状态并更新提示，
        // 主进程传值只影响第一帧，不再决定后续（页内自闭环）。
        needBingLogin: bingState === "need-login",
      });
      if (state) {
        if (state !== lastTermsState && !opts.silent) {
          const label =
            state === "terms"
              ? "微软条款更新提示"
              : state === "bing-login"
              ? "Bing 未登录提示"
              : "通用引导";
          logger.info(`[page-guide] ${url} → ${label}`);
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

  /**
   * 页内 MutationObserver 已经自闭环地保证了「提示元素跟着页面状态更新」，
   * 这里剩下的轮询只服务两件次要的事：打日志、以及自动点 Bing 登录入口
   * （自动点击是有副作用的操作，刻意留在主进程，不放进页内回调）。
   *
   * ⚠️ 修过一个写反的条件：原写法 `probeRounds++ >= 6 || !page.isClosed()`
   * 在页面正常打开时后半为真 → 每轮都直接 return，refresh 一次都没跑过，
   * 等于这个轮询完全失效（2026-10-04）。正确写法是 page.isClosed()。
   */
  let probeRounds = 0;
  const timer = setInterval(() => {
    if (page.isClosed()) {
      clearInterval(timer);
      return;
    }
    if (probeRounds++ >= 6) {
      clearInterval(timer);
      return;
    }
    // 已在「需登录」提示态就不用再轮询了
    if (lastTermsState === "bing-login") {
      clearInterval(timer);
      return;
    }
    void refresh();
  }, 1500);
  page.on("close", () => clearInterval(timer));
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
 * 探测 Bing 页面当前是「已登录」还是「右上角有登录入口」。
 * @returns {Promise<"logged-in"|"need-login"|null>}
 */
async function probeBingLoginState(page) {
  try {
    return await page.evaluate(() => {
      // 已登录：右上角用户菜单 / 退出入口
      if (
        document.querySelector("#id_n") ||
        document.querySelector('a[aria-label*="注销"]') ||
        document.querySelector('a[aria-label*="退出"]')
      ) {
        return "logged-in";
      }
      // 有可见的登录入口 → 未登录
      for (const sel of ['#id_l', 'a[aria-label="登录"]', '#id_a', 'a[aria-label*="登录"]']) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) return "need-login";
      }
      return null;
    });
  } catch {
    return null;
  }
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
 *   prevTerms: string|null, loginTitle: string, loginBody: string,
 *   isBing: boolean, needBingLogin: boolean
 * }} cfg
 * @returns {"default"|"terms"|"bing-login"|null}
 */
function guideScript(cfg) {
  const {
    termsKeywords, defaultTitle, defaultBody, termsTitle, termsBody, styleId, bodyId,
    loginTitle, loginBody, isBing,
  } = cfg;
  try {
    /**
     * 页内自闭环：计算状态 + 更新提示元素，不依赖主进程。
     *
     * 为什么把「Bing 未登录」的判定也搬进页内（而不沿用主进程传进来的 needBingLogin）：
     * MutationObserver 触发时主进程并不在场，页内必须自己能算出新状态，
     * 否则 SPA 晚渲染出来的登录入口仍然探不到 —— 这正是 2026-10-04 用户反馈的问题。
     */
    const applyState = () => {
      let state = "default";
      // 命中条款更新页：扫 title + h1 + 大正文块
      const text = (document.title || "") + " " +
        Array.from(document.querySelectorAll("h1, h2, [role='heading']"))
          .map((n) => (n.textContent || "").trim())
          .join(" ") + " " +
        (document.body && document.body.innerText ? document.body.innerText : "").slice(0, 2000);
      const isTerms = termsKeywords.some((kw) => text.includes(kw));

      // 页内自测 Bing 登录态（与 probeBingLoginState 同一套选择器，保持单一真源语义）
      let needBingLogin = false;
      if (isBing) {
        const loggedIn =
          document.querySelector("#id_n") ||
          document.querySelector('a[aria-label*="注销"]') ||
          document.querySelector('a[aria-label*="退出"]');
        if (!loggedIn) {
          for (const sel of ['#id_l', 'a[aria-label="登录"]', '#id_a', 'a[aria-label*="登录"]']) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) {
              needBingLogin = true;
              break;
            }
          }
        }
      }

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
#${bodyId}.msra-login { background: rgba(24, 92, 168, 0.95); }
#${bodyId}.msra-login .msra-title::before { content: "🔑 "; }
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

      // 状态没变就别动 DOM —— 否则我们自己的插入会触发 MutationObserver，
      // 形成「改 DOM → 触发 → 再改 DOM」的自激循环。
      const prev = body.getAttribute("data-state");
      if (prev === (isTerms ? "terms" : isBing && needBingLogin ? "bing-login" : "default")) {
        state = prev;
        return state;
      }

      const titleEl = body.querySelector(".msra-title");
      const bodyEl = body.querySelector(".msra-body");
      // 优先级：条款页 > Bing 未登录 > 通用
      // 条款页放最前：那时即使 Bing 未登录也该让用户先点条款（点了才有票据）。
      if (isTerms) {
        body.classList.add("msra-terms");
        body.classList.remove("msra-login");
        titleEl.textContent = termsTitle;
        bodyEl.textContent = termsBody;
        state = "terms";
      } else if (isBing && needBingLogin) {
        body.classList.add("msra-login");
        body.classList.remove("msra-terms");
        titleEl.textContent = loginTitle;
        bodyEl.textContent = loginBody;
        state = "bing-login";
      } else {
        body.classList.remove("msra-terms");
        body.classList.remove("msra-login");
        titleEl.textContent = defaultTitle;
        bodyEl.textContent = defaultBody;
        state = "default";
      }
      body.setAttribute("data-state", state);
      return state;
    };

    // 每次 evaluate 都把最新的 applyState 挂到 window，
    // 让已经存在的 Observer 回调始终调用最新逻辑（闭包不会过期）。
    window.__msraGuideApply = applyState;

    // MutationObserver 只挂一次：页内自闭环，DOM 一变就自己更新提示，
    // 不需要通知主进程 → 零新增 CDP 通道（extension/exposeBinding 那条路不通的原因）。
    if (!window.__msraGuideObserver) {
      window.__msraGuideObserver = true;
      let t = null;
      const mo = new MutationObserver(() => {
        // debounce：SPA 一次渲染会刷出成百上千个 mutation，没必要每个都算
        if (t) clearTimeout(t);
        t = setTimeout(() => {
          try {
            if (typeof window.__msraGuideApply === "function") window.__msraGuideApply();
          } catch {}
        }, 300);
      });
      // 观察整个文档：title 在 head、登录入口在 body，只观察 body 会漏掉 title 变化
      mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    }

    return applyState();
  } catch {
    return null;
  }
}

module.exports = {
  attachPageGuide,
  tryClickBingLogin,
  probeBingLoginState,
  TERMS_KEYWORDS,
  GUIDE_DEFAULT_TITLE,
  GUIDE_DEFAULT_BODY,
  GUIDE_TERMS_TITLE,
  GUIDE_TERMS_BODY,
  GUIDE_BING_LOGIN_TITLE,
  GUIDE_BING_LOGIN_BODY,
};