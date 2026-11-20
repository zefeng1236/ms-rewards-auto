/**
 * 桌面应用专属任务：离线打桩集成测试
 *
 * 运行：npm run test:desktop
 *
 * 【为什么要有这个文件】
 * 这条链路依赖「微软 Rewards 桌面应用 + 它自己的登录态」，没法在 CI 里真跑，
 * 而真机验证又需要用户登录（本项目红线：不登录别人的账号）。于是把外部依赖
 * 全部打桩，用 Module._load 在 require 之前替换，驱动**真实的产品代码路径**：
 *   - 不联网、不登录账号、不启动真实应用、不碰注册表；
 *   - 覆盖闸门 / 未安装 / 未登录 / 扫描 / 点击到账 / 点了没到账 / 渲染失败 /
 *     主窗口导航 / 调试端口参数 / 插件规则传参等分支。
 *
 * ⚠️ 桩必须在 require("../src/desktop-app") 之前装好，否则模块会缓存真实依赖。
 */
"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DESKTOP_FILE = path.join(ROOT, "src", "desktop-app.js");
const PLUGIN_FILE = path.join(ROOT, "plugins", "desktop-app-tasks", "index.js");
const BUILTIN_RULES = JSON.parse(
  fs.readFileSync(path.join(ROOT, "plugins", "desktop-app-tasks", "rules.json"), "utf8")
);
const REMOTE_RULES = JSON.parse(
  fs.readFileSync(path.join(ROOT, "rules", "desktop-app-tasks.json"), "utf8")
);

const lines = [];
let failed = 0;
let activeRestores = [];

async function test(name, fn) {
  activeRestores = [];
  try {
    await fn();
    lines.push(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    lines.push(`  ❌ ${name} — ${String((e && e.message) || e).slice(0, 220)}`);
  } finally {
    // 桩必须覆盖整个异步用例：desktop-app.js 里的 feature-gates 是**运行时** require，
    // 只在 require 模块那一刻装桩会漏掉，导致每个用例都撞上真实闸门。
    for (const restore of activeRestores.slice().reverse()) restore();
    activeRestores = [];
  }
}

/** 每个用例一份独立临时目录：跳过清单按天落盘，不能互相污染 */
function makeWorkdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msr-desktop-test-"));
  const appDir = path.join(dir, "app");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "microsoft-rewards-desktop.exe"), "");
  return { dir, appDir };
}

/** 造一份能命中 ITEM_PATTERN 的 RSC 文本 */
function payloadOf(sc) {
  const forms = sc.forms || ["ML2Y3O"];
  const items = forms.map((f, i) => {
    const done = i < (sc.completed || 0);
    // redeemForms 里的项模拟 punchcard 的「最后领取」兑换页（真机 ML2Y3S）
    const redeem = (sc.redeemForms || []).includes(f);
    const href = redeem
      ? `https://rewards.bing.com/redeem/sku/000899?form=${f}`
      : `https://rewards.bing.com/earn/quest/Q1?form=${f}`;
    return `"ariaLabel":"任务${i + 1}","href":"${href}","edgeAction":null,"isCompleted":${done},"isLocked":false`;
  });
  const head =
    sc.progressText != null
      ? sc.progressText
      : `>${2 + (sc.completed || 0)}/5 个任务<`;
  return `<div>${head}</div>${items.join(",")}`;
}

/** 造一个「够用」的 Playwright page：evaluate 按函数体关键字分发预设响应 */
function makePage(sc) {
  const popup = {
    _url: "about:blank",
    url() { return this._url; },
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    bringToFront: async () => {},
    mouse: { wheel: async () => {} },
    close: async () => { sc.popupClosed = (sc.popupClosed || 0) + 1; },
  };
  const page = {
    _url: sc.loginPage ? "https://login.live.com/oauth20_authorize.srf" : "https://rewards.bing.com/earn",
    url() { return sc.startupFlaky > 0 ? "about:blank" : this._url; },
    async goto(u) {
      sc.gotos = (sc.gotos || 0) + 1;
      this._url = sc.loginPage ? "https://login.live.com/oauth20_authorize.srf" : u;
    },
    reload: async () => {},
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    bringToFront: async () => {},
    mouse: { wheel: async () => {} },
    close: async () => { sc.pageClosed = (sc.pageClosed || 0) + 1; },
    context() { return sc.ctx; },
    async evaluate(fn) {
      const s = String(fn);
      // 启动期：CDP 里只有会被反复销毁的 about:blank（真机 2026-11-07 实测）
      if (sc.startupFlaky > 0) {
        sc.startupFlaky--;
        if (s.includes("__msRewardsIsMainWindow") || s.includes("document.readyState")) {
          throw new Error("Target page closed");
        }
      }
      if (s.includes("__msRewardsIsMainWindow")) return false;
      if (s.includes("document.readyState")) {
        return { ready: true, url: sc.loginPage ? "https://login.live.com/oauth20_authorize.srf" : this._url };
      }
      if (s.includes("querySelectorAll")) return sc.questIds === undefined ? ["Q1"] : sc.questIds;
      if (s.includes("no-store")) return payloadOf(sc);
      if (s.includes("innerHeight")) return 800;
      if (s.includes("body.innerText")) {
        if (s.includes("length")) return sc.bodyLen == null ? 1000 : sc.bodyLen;
        return { url: this._url, text: "赚取奖励 今日积分 积分明细" };
      }
      return undefined;
    },
    locator() {
      const card = {
        count: async () => (sc.cardExists === false ? 0 : 1),
        click: async () => {
          sc.clicks = (sc.clicks || 0) + 1;
          if (sc.gainOnClick) sc.completed = (sc.completed || 0) + 1;
          // crashAfterItems：点完第 N 项后主页面崩到恢复页（不再恢复），
          // 模拟真机「已扫描并点了部分项，随后崩溃」——旧逻辑此时 scan 有值会落 done。
          if (Number.isFinite(sc.crashAfterItems) && sc.clicks >= sc.crashAfterItems) {
            sc.recovered = false;
          }
          if (sc.sameWindowNav) this._url = "https://rewards.bing.com/redeem/sku/abc";
          else popup._url = `https://cn.bing.com/?form=${(sc.forms || ["ML2Y3O"])[0]}`;
        },
      };
      return { first: () => card, count: card.count, click: card.click };
    },
  };
  // 崩溃恢复页场景（2026-11-18 真机两次实证）：主页面没了，
  // CDP 里只剩应用自己的 recovery 页 + about:blank，但调试端口还开着。
  const recoveryPage = {
    _url: "http://rewardsrecovery.localhost/recovery.html",
    url() { return this._url; },
    evaluate: async () => { throw new Error("Target page closed"); },
    close: async () => {},
  };
  const blankPage = {
    _url: "about:blank",
    url() { return this._url; },
    evaluate: async () => ({ ready: true, url: "about:blank" }),
    close: async () => {},
  };
  sc.recoveryPage = recoveryPage;
  sc.ctx = {
    pages: () => (sc.clicks && !sc.sameWindowNav ? [page, popup] : [page]),
    newCDPSession: async () => ({
      send: async () => ({ windowId: 1, bounds: { left: 0, top: 0, width: 1200, height: 800 } }),
      detach: async () => {},
    }),
  };
  sc.page = page;
  sc.popup = popup;
  sc.browser = {
    contexts: () => [{
      // crashRecovery 且尚未重启恢复时，模拟「主页面已崩、只剩恢复页」；
      // 重启恢复后**仍残留旧 recovery 页**（真机 2026-11-18：5 个页面里
      // 同时有 rewards.bing.com/dashboard 与 recovery），用来锁死判定顺序。
      pages: () => {
        const crashMode = sc.crashRecovery || Number.isFinite(sc.crashAfterRounds) || Number.isFinite(sc.crashAfterItems);
        if (crashMode && !sc.recovered) return [recoveryPage, blankPage];
        if (crashMode) return [page, recoveryPage];
        return [page];
      },
    }],
    close: async () => {},
  };
  return page;
}

/**
 * 装好桩后重新 require 产品代码。
 * stubs 的键是 require() 里出现的**原始字符串**。
 */
function loadWithStubs(file, stubs) {
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  if (stubs.__fetch) global.fetch = stubs.__fetch;
  activeRestores.push(() => {
    Module._load = originalLoad;
    global.fetch = originalFetch;
  });
  delete require.cache[require.resolve(file)];
  return require(file);
}

function scenario(overrides = {}) {
  const wd = makeWorkdir();
  const sc = Object.assign(
    {
      dir: wd.dir,
      appDir: wd.appDir,
      allowed: true,
      installDir: wd.appDir,
      questIds: ["Q1"],
      forms: ["ML2Y3O"],
      completed: 0,
      gainOnClick: true,
      calls: [],
      logs: [],
      portReady: true,
    },
    overrides
  );
  // crashAfterRounds / crashAfterItems：首轮正常（recovered=true），到阈值后才崩
  if (Number.isFinite(sc.crashAfterRounds) || Number.isFinite(sc.crashAfterItems)) sc.recovered = true;
  makePage(sc);
  return sc;
}

function stubsFor(sc) {
  const childProcess = {
    execFile(file, args, opts, cb) {
      sc.calls.push(String(file));
      let out = "";
      if (/powershell/i.test(String(file))) out = sc.installDir ? `${sc.installDir}\n` : "";
      if (/tasklist/i.test(String(file)) && sc.pids && sc.pids.length) {
        out = sc.pids.map((p) => `"microsoft-rewards-desktop.exe","${p}","Console","1","10,000 K"`).join("\n") + "\n";
      }
      // 真实 taskkill 之后进程就没了；不清空会让 stop() 白等 5 秒后判失败
      if (/taskkill/i.test(String(file))) { sc.justStopped = true; sc.pids = []; }
      setImmediate(() => cb(null, out, ""));
    },
    spawn(file, args, opts) {
      sc.spawnEnv = opts && opts.env;
      sc.spawnArgs = args;
      sc.spawnExe = String(file);
      sc.spawnAfterStale = (sc.portStaleHits || 0) === 0;
      // 崩溃自愈场景：重启后应用恢复正常；crashAlways 则一直崩，用于验证不会无限重启
      if (sc.crashRecovery && !sc.crashAlways) sc.recovered = true;
      // crashAfterRounds：第 N 次 spawn 之后主页面变恢复页（并保持崩）—— 模拟
      // 「先成功扫描并点了部分项，随后应用崩到恢复页」的真机 2026-11-20 场景。
      // 初始 recovered=true 让第一轮正常跑；超过阈值后置 false 不再恢复。
      if (Number.isFinite(sc.crashAfterRounds)) {
        sc.spawnCount = (sc.spawnCount || 0) + 1;
        if (sc.spawnCount > sc.crashAfterRounds) sc.recovered = false;
      }
      // spawn 之后端口就绪，避免 ensureStarted 的等待循环空转
      sc.portReady = true;
      sc.justStopped = false;
      return { on() {}, unref() {} };
    },
  };
  const okPort = () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/x" }) });
  const fetchStub = async () => {
    if (!sc.portReady) throw new Error("ECONNREFUSED");
    // stop() 之后旧实例的调试端口会短暂残留：前几次仍返回可用，之后才真正消失
    if (sc.justStopped && (sc.portStaleHits || 0) > 0) {
      sc.portStaleHits--;
      return okPort();
    }
    if (sc.justStopped) throw new Error("ECONNREFUSED");
    return okPort();
  };
  return {
    "node:child_process": childProcess,
    "child_process": childProcess,
    "playwright-core": { chromium: { connectOverCDP: async () => sc.browser } },
    "./logger": { info: (m) => sc.logs.push(String(m)), warn: (m) => sc.logs.push(String(m)) },
    "./storage-path": { resolve: (f) => path.join(sc.dir, String(f)) },
    "./feature-gates": { desktopAppGate: () => ({ allowed: sc.allowed, note: "测试中" }) },
    __fetch: fetchStub,
  };
}

function ctxWith(desktopAppOn) {
  return { config: { get: () => ({ tasks: { desktopApp: desktopAppOn } }) } };
}

async function main() {
  console.log("\n=== 桌面应用专属任务 · 离线打桩测试 ===");

  // ① 闸门：关闭时连 PowerShell 都不该跑（桩注入 allowed:false，与线上闸门值无关）
  await test("闸门关闭时直接 skip（不启动探测、不拉起外部程序）", async () => {
    const sc = scenario({ allowed: false });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const r = await mod.runDesktopApp(ctxWith(true), { onLog: () => {} });
    assert.equal(r.delayed, true);
    assert.equal(sc.calls.length, 0, "闸门关着却跑了 PowerShell/tasklist");
  });

  // ② 用户没开开关
  await test("用户未启用时返回 disabled", async () => {
    const sc = scenario();
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const r = await mod.runDesktopApp(ctxWith(false), { onLog: () => {} });
    assert.equal(r.disabled, true);
  });

  // ③ 未安装
  await test("未安装时返回 notInstalled（不误报成今天没任务）", async () => {
    const sc = scenario({ installDir: "" });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const r = await mod.runDesktopApp(ctxWith(true), { onLog: () => {} });
    assert.equal(r.notInstalled, true);
  });

  // ④ 调试端口注入值（历史 bug：拼成 ----remote-debugging-port）
  await test("spawn 注入的调试参数必须恰好是 --remote-debugging-port=9333", async () => {
    const sc = scenario({ portReady: false });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const r = await mod.ensureStarted({ allowRestart: true });
    assert.equal(r.ok, true);
    assert.equal(
      sc.spawnEnv.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
      "--remote-debugging-port=9333",
      "参数多了横线 / 少了端口，WebView2 起不开 CDP"
    );
  });

  // ④-b 2026-11-15 真机：MSIX 不继承 spawn 的环境块，只靠 env 时端口完全开不出来
  await test("spawn 必须同时用 argv 主通道 --edge-webview-switches", async () => {
    const sc = scenario({ portReady: false });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    await mod.ensureStarted({ allowRestart: true });
    assert.deepEqual(
      sc.spawnArgs,
      ["--edge-webview-switches=--remote-debugging-port=9333"],
      "argv 少了这个开关 → 打包应用不继承 env，CDP 端口起不来"
    );
  });

  // ⑤ 桌面应用自身未登录
  await test("停在微软登录域时判 notLoggedIn 且带上现场信息", async () => {
    const sc = scenario({ loginPage: true });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const r = await mod.runDesktopApp(ctxWith(true), { onLog: (m) => sc.logs.push(m) });
    assert.equal(r.notLoggedIn, true);
    assert.match(String(r.reason), /未登录/);
    assert.ok(String(r.detail).includes("login.live.com"), "detail 没带当前页面");
  });

  // ⑥ 进度解析：中文 / 英文 / 无进度文本
  await test("中文进度 2/5 个任务解析正确", async () => {
    const sc = scenario();
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const q = await mod.readQuest(sc.page, "Q1");
    assert.equal(q.done, 2);
    assert.equal(q.total, 5);
  });
  await test("英文进度 2 of 5 tasks 也能解析（不能退化成 done=0）", async () => {
    const sc = scenario({ progressText: "2 of 5 tasks" });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const q = await mod.readQuest(sc.page, "Q1");
    assert.equal(q.done, 2, "英文页面会把已完成数算成 0，进而永远判『点了没到账』");
    assert.equal(q.total, 5);
  });
  await test("无进度文本时用任务项状态兜底，不谎报到账", async () => {
    const sc = scenario({ progressText: "", completed: 2, forms: ["A", "B", "C"] });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const q = await mod.readQuest(sc.page, "Q1");
    assert.equal(q.done, 2);
    assert.equal(q.total, 3);
  });

  // ⑦ 扫描模式
  await test("扫描模式返回任务快照而不点击", async () => {
    const sc = scenario();
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const r = await mod.runDesktopApp(ctxWith(true), {
      dryRun: true,
      onLog: () => {},
      rules: { runtime: { renderWaitMs: 1 } },
    });
    assert.equal(r.status, "skip", `实际=${JSON.stringify(r)} logs=${JSON.stringify(sc.logs)}`);
    assert.equal(r.todo, 1, `实际=${JSON.stringify(r)} logs=${JSON.stringify(sc.logs)}`);
    assert.equal(sc.clicks || 0, 0);
  });

  // ⑦-a 真机启动期竞态：主窗口没渲染出来不等于应用坏了
  await test("启动期页面反复重建时等主窗口出现，且不重启应用", async () => {
    const sc = scenario({ startupFlaky: 4 });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const r = await mod.runDesktopApp(ctxWith(true), {
      dryRun: true,
      onLog: (m) => sc.logs.push(m),
      rules: { runtime: { renderWaitMs: 1 } },
    });
    assert.equal(r.status, "skip", `实际=${JSON.stringify(r)} logs=${JSON.stringify(sc.logs)}`);
    assert.equal(r.todo, 1);
    assert.ok(!sc.calls.some((f) => /taskkill/i.test(f)), "启动期不该杀掉应用重启");
  });

  // ⑦-a2 旧实例端口残留：必须等它真正消失再 spawn
  await test("重启后等旧调试端口消失才拉起新实例", async () => {
    const sc = scenario({ forms: ["A1", "B2"], gainOnClick: true, portStaleHits: 2, pids: ["42664"] });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const r = await mod.runDesktopApp(ctxWith(true), {
      maxItems: 2,
      onLog: () => {},
      rules: { runtime: { renderWaitMs: 1 } },
    });
    assert.equal(r.gained, 2, `实际=${JSON.stringify(r)}`);
    assert.equal(sc.spawnAfterStale, true, "端口还在残留时就 spawn 了");
  });

  // ⑦-b 没有进度文本时，到账判据要换成「可做项少了几个」
  await test("无进度文本时按可做项减少判到账（不误判成冷却期）", async () => {
    const sc = scenario({ progressText: "", forms: ["A1", "B2"], gainOnClick: true });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const r = await mod.runDesktopApp(ctxWith(true), {
      maxItems: 1,
      onLog: (m) => sc.logs.push(m),
      rules: { runtime: { renderWaitMs: 1 } },
    });
    assert.equal(r.gained, 1, `实际=${JSON.stringify(r)} logs=${JSON.stringify(sc.logs)}`);
    assert.equal(r.clicked, 1);
  });

  // ⑧ 点击到账
  await test("真实点击且到账：gained=1 / points=10 / 不关主窗口", async () => {
    const sc = scenario();
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const r = await mod.runDesktopApp(ctxWith(true), {
      maxItems: 1,
      onLog: (m) => sc.logs.push(m),
      rules: { runtime: { renderWaitMs: 1 } },
    });
    assert.equal(r.gained, 1, `实际=${JSON.stringify(r)} logs=${JSON.stringify(sc.logs)}`);
    assert.equal(r.points, 10);
    assert.equal(sc.clicks, 1);
    assert.equal(sc.pageClosed || 0, 0, "主窗口被关掉了");
    assert.equal(sc.popupClosed, 1, "新开的落地窗口应该被关闭");
  });

  // ⑨ 点了没到账 → 当日拉黑，且主窗口仍在
  await test("点了未到账：写当日跳过清单，返回可读原因", async () => {
    const sc = scenario({ gainOnClick: false });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const r = await mod.runDesktopApp(ctxWith(true), {
      maxItems: 1,
      onLog: (m) => sc.logs.push(m),
      rules: { runtime: { renderWaitMs: 1 } },
    });
    assert.equal(r.gained, 0);
    assert.equal(r.clicked, 1);
    assert.match(String(r.reason), /未到账/);
    const skipFile = path.join(sc.dir, "desktop-app-skip.json");
    assert.ok(fs.existsSync(skipFile), "冷却期任务没记入当日跳过");
    assert.ok(JSON.parse(fs.readFileSync(skipFile, "utf8")).forms.includes("ML2Y3O"));
  });

  // ⑨-b 日志编号：点了没到账也要递增（真机 11-07 见过两个「第 1 项」）
  await test("点了没到账时日志项号仍递增，不重复「第 1 项」", async () => {
    const sc = scenario({ forms: ["A1", "B2"], gainOnClick: false });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    await mod.runDesktopApp(ctxWith(true), {
      maxItems: 2,
      onLog: (m) => sc.logs.push(m),
      rules: { runtime: { renderWaitMs: 1 } },
    });
    const nums = sc.logs
      .filter((l) => /^第 \d+ 项:/.test(l))
      .map((l) => Number(l.match(/^第 (\d+) 项:/)[1]));
    assert.deepEqual(nums, [1, 2], `实际=${JSON.stringify(nums)} logs=${JSON.stringify(sc.logs)}`);
  });

  // ⑩ 主窗口自己导航（兑换类任务）绝不能被关
  await test("主窗口自身导航的落地页不关主窗口", async () => {
    const sc = scenario({ sameWindowNav: true });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    await mod.runDesktopApp(ctxWith(true), {
      maxItems: 1,
      onLog: () => {},
      rules: { runtime: { renderWaitMs: 1 } },
    });
    assert.equal(sc.pageClosed || 0, 0, "兑换类任务会把主窗口杀掉");
  });

  // ⑪ 连续渲染失败：不崩、不无限重启
  await test("页面主体持续未渲染时不抛异常且能收尾", async () => {
    const sc = scenario({ bodyLen: 100, gainOnClick: false });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const r = await mod.runDesktopApp(ctxWith(true), {
      maxItems: 1,
      onLog: (m) => sc.logs.push(m),
      rules: { runtime: { renderWaitMs: 1 } },
    });
    assert.equal(r.status, "done");
    assert.ok(sc.logs.some((l) => l.includes("页面主体未渲染")), "没记录渲染失败");
    assert.ok(
      sc.logs.some((l) => l.includes("页面连续") && l.includes("渲染失败")),
      `连续渲染失败没升级成放弃该项: ${JSON.stringify(sc.logs)}`
    );
  });

  // ⑫ 一轮做完（代码写了上限，但插件规则可能悄悄把它压回 1）
  await test("插件链路传入的一轮上限 ≥5（一次跑完，不是一轮只做一项）", async () => {
    let captured = null;
    const stubs = {
      "../../src/desktop-app": {
        MAX_ITEMS_PER_RUN: 10,
        runDesktopApp: async (_ctx, opts) => { captured = opts; return { status: "done", gained: 0 }; },
      },
    };
    const plugin = loadWithStubs(PLUGIN_FILE, stubs);
    await plugin.run(ctxWith(true), BUILTIN_RULES, { onLog: () => {} });
    assert.ok(captured, "插件没调驱动");
    assert.ok(captured.maxItems >= 5, `实际生效 maxItems=${captured.maxItems}（规则把代码里的上限压回去了）`);
    assert.ok(BUILTIN_RULES.runtime.maxItemsPerRun >= 5, "内置规则写的是 1");
    assert.ok(REMOTE_RULES.runtime.maxItemsPerRun >= 5, "远程规则写的是 1");
  });

  // ⑬ 一轮连做三项（真实循环路径，不只看常量）
  await test("一轮可连续完成 3 项（每项重启换干净实例）", async () => {
    const sc = scenario({ forms: ["A1", "B2", "C3"], gainOnClick: true });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const r = await mod.runDesktopApp(ctxWith(true), {
      maxItems: 3,
      onLog: () => {},
      rules: { runtime: { renderWaitMs: 1 } },
    });
    assert.equal(r.gained, 3);
    assert.equal(r.points, 30);
    assert.equal(sc.clicks, 3);
  });

  // —— 兑换类「最后领取」跳过（2026-11-12 用户定，真机连续 3 天点了不到账）——
  await test("needsManualClaim 只认兑换页领取链接", async () => {
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(scenario()));
    assert.equal(mod.needsManualClaim("https://rewards.bing.com/redeem/sku/000899?form=ML2Y3S"), true);
    assert.equal(mod.needsManualClaim("https://www.bing.com/search?q=x&form=ML2Y2H"), false);
    assert.equal(mod.needsManualClaim(""), false);
  });
  await test("扫描模式把兑换领取项计入 manual，不算 todo", async () => {
    const sc = scenario({ forms: ["ML2Y3S"], redeemForms: ["ML2Y3S"] });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const r = await mod.runDesktopApp(ctxWith(true), {
      dryRun: true,
      onLog: (m) => sc.logs.push(m),
      rules: { runtime: { renderWaitMs: 1 } },
    });
    assert.equal(r.todo, 0);
    assert.equal(r.manual, 1, `实际=${JSON.stringify(r)}`);
    assert.ok(sc.logs.some((l) => l.includes("需人工")), `没提示需人工: ${JSON.stringify(sc.logs)}`);
  });
  await test("纯兑换项不点击、不写冷却清单、不误报未到账", async () => {
    const sc = scenario({ forms: ["ML2Y3S"], redeemForms: ["ML2Y3S"] });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const r = await mod.runDesktopApp(ctxWith(true), {
      maxItems: 1,
      onLog: (m) => sc.logs.push(m),
      rules: { runtime: { renderWaitMs: 1 } },
    });
    assert.equal(sc.clicks || 0, 0, "兑换项被点了");
    assert.equal(r.clicked, 0);
    assert.equal(r.manual, 1, `实际=${JSON.stringify(r)}`);
    const skipFile = path.join(sc.dir, "desktop-app-skip.json");
    assert.ok(!fs.existsSync(skipFile), "兑换项被误记成当日冷却");
  });
  await test("混合任务只点普通项，兑换项不进冷却清单", async () => {
    const sc = scenario({ forms: ["ML2Y3S", "A1"], redeemForms: ["ML2Y3S"], gainOnClick: false });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    await mod.runDesktopApp(ctxWith(true), {
      maxItems: 2,
      onLog: (m) => sc.logs.push(m),
      rules: { runtime: { renderWaitMs: 1 } },
    });
    assert.equal(sc.clicks, 1, `实际点击 ${sc.clicks} 次`);
    const skipFile = path.join(sc.dir, "desktop-app-skip.json");
    const j = fs.existsSync(skipFile) ? JSON.parse(fs.readFileSync(skipFile, "utf8")) : { forms: [] };
    assert.ok(!j.forms.includes("ML2Y3S"), `兑换项被误记成冷却期: ${JSON.stringify(j)}`);
  });

  // ㉕ 崩溃恢复页 → 识别后重启实例自愈（2026-11-18 真机两次实证：干等 3×45s 整轮失败）
  await test("崩溃恢复页：识别后重启实例自愈，不再干等主窗口", async () => {
    const sc = scenario({ crashRecovery: true, pids: [4321], forms: ["A1"], gainOnClick: true });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const r = await mod.runDesktopApp(ctxWith(true), {
      maxItems: 1,
      onLog: (m) => sc.logs.push(m),
      rules: { runtime: { renderWaitMs: 1 } },
    });
    assert.equal(r.status, "done", `实际=${JSON.stringify(r)}`);
    assert.equal(r.gained, 1);
    assert.ok(sc.logs.some((l) => l.includes("崩溃恢复页")), "没识别到恢复页");
    assert.ok(sc.calls.some((c) => /taskkill/i.test(c)), "识别到崩溃却没重启实例");
    assert.ok(!sc.logs.some((l) => l.includes("连续 3 次拿不到主窗口")), "仍在干等主窗口");
  });

  // ㉖ 重启后仍崩 → 只重启一次就放弃，且报 retry（不能无限杀用户的应用）
  await test("重启后仍停在恢复页：只重启一次并报 retry", async () => {
    const sc = scenario({ crashRecovery: true, crashAlways: true, pids: [4321] });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const r = await mod.runDesktopApp(ctxWith(true), {
      maxItems: 1,
      onLog: (m) => sc.logs.push(m),
      rules: { runtime: { renderWaitMs: 1 } },
    });
    assert.equal(r.status, "retry", `崩溃零产出必须报 retry，实际=${JSON.stringify(r)}`);
    assert.equal(r.reason, "桌面应用未就绪");
    const kills = sc.calls.filter((c) => /taskkill/i.test(c)).length;
    assert.equal(kills, 1, `应只重启一次，实际 taskkill ${kills} 次`);
    assert.ok(sc.logs.some((l) => l.includes("仍停在崩溃恢复页")));
  });

  // ㉗ 零产出不得误报「今天没有可做的桌面任务」，否则熔断对崩溃永不触发
  await test("整轮没跑起来时不返回 done，熔断能计入失效", async () => {
    const sc = scenario({ crashRecovery: true, crashAlways: true, pids: [4321] });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const r = await mod.runDesktopApp(ctxWith(true), {
      onLog: () => {},
      rules: { runtime: { renderWaitMs: 1 } },
    });
    assert.notEqual(r.status, "done");
    assert.notEqual(r.reason, "今天没有可做的桌面任务");
    const circuit = require(path.join(ROOT, "src", "desktop-circuit.js"));
    assert.equal(circuit.isFailure(r), true, "熔断没把这种故障当失效");
  });

  // ㉘ 中途崩溃（已扫描/点过项）也必须报 retry，不能落 done 消耗手动额度
  // 真机 2026-11-20：点了第 1 项后应用崩到恢复页，scan 已有值 → 旧逻辑落 done、
  // 账本被写、熔断不计失败。这条锁死「异常 break 置 aborted → retry」。
  await test("扫描后中途崩溃也报 retry，不误报 done 消耗账本", async () => {
    const sc = scenario({
      crashAfterItems: 1, // 点完第 1 项就崩到第 2 轮，此时 scan 已有值（真机路径）
      forms: ["A1", "B2", "C3"],
      gainOnClick: true,
      pids: [4321],
    });
    const mod = loadWithStubs(DESKTOP_FILE, stubsFor(sc));
    const r = await mod.runDesktopApp(ctxWith(true), {
      maxItems: 3,
      onLog: (m) => sc.logs.push(m),
      rules: { runtime: { renderWaitMs: 1 } },
    });
    assert.equal(r.status, "retry", `扫描后崩溃必须报 retry，实际=${JSON.stringify(r)}`);
    assert.ok(
      sc.logs.some((l) => l.includes("崩溃恢复页")),
      "应走到崩溃恢复页分支"
    );
    const circuit = require(path.join(ROOT, "src", "desktop-circuit.js"));
    assert.equal(circuit.isFailure(r), true, "扫描后崩溃也要计入熔断失效");
  });

  console.log(lines.join("\n"));
  console.log(`\n结果: ${lines.length - failed} 通过 / ${failed} 失败\n`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error("测试脚本自身异常:", e);
  process.exitCode = 1;
});
