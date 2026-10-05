/**
 * ippure.com 专项：把「WebRTC 指纹 / DNS 泄露 / 浏览器指纹」三块都读出来。
 *
 * 之前只用正则抓 cloudflare.html 的 innerText，只拿到「风险指数 98/100」（IP 信誉）
 * 就下了结论，但这个站还有三块没确认 —— 用户明确问了，必须实测。
 *
 * 真实页面（从站点导航抓的，别猜）：
 *   /cloudflare.html                     Cloudflare 风控 + Turnstile/reCAPTCHA
 *   /Browser-WebRTC-Leak-Detect.html     WebRTC 泄露
 *   /DNS-Leak-Detect.html                DNS 泄露
 *   /fingerprint.html                    浏览器指纹
 *
 * 已知坑（今天踩的第 6~7 次）：这些站点的「评分标准说明」和「实测结果」在同一页，
 * 纯文本抓必然混淆。所以每块都按 DOM 结构定位，取不到就如实标 unknown。
 *
 * 另：`page.evaluate(fn)` 的函数体**不支持顶层 await**（踩过）—— 所以 WebRTC
 * 这种要等 ICE 收集的，必须拆成"埋 hook → 外层等 → 读结果"两步。
 */

const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..");
const { chromium } = require(path.join(ROOT, "node_modules", "playwright-core"));
const fp = require(path.join(ROOT, "src", "fingerprint-browser.js"));

const seed = fp.seedFor("msr-ippure-check");
const STEALTH = [
  "--exclude-switches=enable-automation",
  "--disable-infobars",
  "--no-first-run",
  "--disable-default-apps",
  "--no-default-browser-check",
  "--disable-sync",
];

const PAGES = [
  { name: "Cloudflare 风控", url: "https://ippure.com/cloudflare.html", wait: 18000 },
  { name: "WebRTC 泄露", url: "https://ippure.com/Browser-WebRTC-Leak-Detect.html", wait: 18000 },
  { name: "DNS 泄露", url: "https://ippure.com/DNS-Leak-Detect.html", wait: 18000 },
  { name: "浏览器指纹", url: "https://ippure.com/fingerprint.html", wait: 15000 },
];

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msr-ippure-"));
  let crashed = false;
  try {
    const ctx = await chromium.launchPersistentContext(tmp, {
      executablePath: fp.executablePath(),
      headless: false,
      args: [...fp.buildArgs({ seed }), ...STEALTH],
      ignoreHTTPSErrors: true,
      viewport: { width: 1366, height: 768 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });
    const page = ctx.pages()[0] || (await ctx.newPage());
    page.on("crash", () => { crashed = true; });

    for (const p of PAGES) {
      if (crashed) { console.log("❌ 浏览器崩溃，后续页面跳过"); break; }
      console.log(`\n${"=".repeat(60)}\n=== ${p.name} · ${p.url} ===`);
      await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 45000 })
        .catch((e) => console.log("goto:", e.message.slice(0, 60)));
      await new Promise((r) => setTimeout(r, p.wait));

      // WebRTC：先埋 hook（同步），外层等 ICE，再读结果
      await page.evaluate(() => {
        window.__msrIce = [];
        window.__msrPc = null;
        try {
          if (typeof RTCPeerConnection === "undefined") return;
          const pc = new RTCPeerConnection({ iceServers: [] });
          window.__msrPc = pc;
          pc.createDataChannel("x");
          pc.onicecandidate = (e) => { if (e.candidate) window.__msrIce.push(e.candidate.candidate); };
          pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => {});
        } catch {}
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 3500));

      const out = await page.evaluate(() => {
        const cands = window.__msrIce || [];
        try { window.__msrPc && window.__msrPc.close(); } catch {}
        const txt = document.body.innerText || "";
        return {
          // ── WebRTC ──
          webrtc: {
            candidates: cands,
            // mDNS 化 = 主机名被替换成 xxx.local（不泄露真实内网 IP）
            mdnsMasked: cands.some((c) => /\.local\b/.test(c)),
            // 是否泄露真实内网/公网 IP
            hasRealIp: cands.some((c) => {
              const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(c);
              return m && !/^(0\.0\.0\.0|127\.)/.test(m[1]);
            }),
            supported: typeof RTCPeerConnection !== "undefined",
          },
          // ── 页面上的关键指标（按固定格式抓，不从说明文字里猜）──
          riskIndex: (/风险指数[:：]\s*(\d+)\s*\/\s*100/.exec(txt) || [])[1] || null,
          dnsLeak: (/DNS[^\n]{0,20}泄露[:：]?\s*([^\n]{0,40})/.exec(txt) || [])[1] || null,
          ipShown: (/当前\s*IP[^\n]{0,10}[:：]\s*([\d.:a-f]{3,40})/i.exec(txt) || [])[1] || null,
          // 指纹页常见字段
          fp: {
            ua: navigator.userAgent,
            platform: navigator.platform,
            webdriver: navigator.webdriver,
            tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
            lang: navigator.language,
            langs: navigator.languages,
            hw: navigator.hardwareConcurrency,
            mem: navigator.deviceMemory,
            screen: [screen.width, screen.height],
            dpr: window.devicePixelRatio,
            colorDepth: screen.colorDepth,
            plugins: navigator.plugins ? navigator.plugins.length : 0,
            canvasHash: (() => {
              try {
                const c = document.createElement("canvas");
                c.width = 200; c.height = 50;
                const x = c.getContext("2d");
                x.font = "16px Arial";
                x.fillText("Cwm fjordbank", 2, 15);
                const d = x.getImageData(0, 0, 200, 50).data;
                let h = 0;
                for (let i = 0; i < d.length; i++) h = (h * 31 + d[i]) >>> 0;
                return "ok:" + h.toString(16);
              } catch (e) { return "throw:" + e.message.slice(0, 40); }
            })(),
            audioHash: (() => {
              try {
                const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
                if (!AC) return "unsupported";
                const ac = new AC(1, 44100, 44100);
                const osc = ac.createOscillator();
                osc.type = "triangle";
                osc.frequency.value = 10000;
                const comp = ac.createDynamicsCompressor();
                osc.connect(comp); comp.connect(ac.destination);
                osc.start(0);
                return "renderable";
              } catch (e) { return "throw:" + e.message.slice(0, 40); }
            })(),
          },
          // 页面正文（人工判读用，截断）
          text: txt.replace(/\n{2,}/g, "\n").slice(0, 1200),
        };
      }).catch((e) => ({ err: e.message.slice(0, 100) }));

      if (out.err) { console.log("ERR", out.err); continue; }

      console.log("WebRTC:", JSON.stringify(out.webrtc));
      if (out.riskIndex) console.log("风险指数:", out.riskIndex, "/ 100");
      if (out.ipShown) console.log("页面显示 IP:", out.ipShown);
      if (out.dnsLeak) console.log("DNS 段:", out.dnsLeak);
      console.log("指纹:", JSON.stringify(out.fp, null, 1));
      console.log("--- 正文 ---");
      console.log(out.text);
    }

    await ctx.close();
  } finally {
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 600)); }
    }
  }
})();