const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

// ⚠️ 必须在 require 任何业务模块之前确定存储目录。
// 打包后安装目录（Program Files）没有写权限，数据必须落在 userData 下；
// account/config/global-config/state 都在 require 时就读这个环境变量算路径。
if (!process.env.MS_REWARDS_STORAGE_DIR && app.isPackaged) {
  process.env.MS_REWARDS_STORAGE_DIR = path.join(app.getPath("userData"), "storage");
}

const accounts = require("./account");
const globalConfig = require("./global-config");
const browser = require("./browser");
const auth = require("./auth");
const runner = require("./runner");
const rewards = require("./rewards");
const logger = require("./logger");
const cancel = require("./cancel");
const ensureDeps = require("./ensure-deps");
const sp = require("./storage-path");

const ROOT = path.join(__dirname, "..");
const IS_SMOKE = process.argv.includes("--smoke");
let mainWindow = null;
let running = false;
let daemonStop = null;

/** 向渲染进程广播运行状态，用于切换「停止任务」按钮显隐 */
function setRunning(v) {
  running = v;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("running", v);
  }
  // 运行状态变化时立即推一次数据，让卡片及时反映最新结果
  pushAccounts();
}

/**
 * 主动把最新账户数据推给渲染进程
 *
 * 之前卡片只在用户点按钮后才刷新（renderer 主动 listAccounts），
 * 任务在后台跑时界面完全不动，看起来像「不自动刷新」。
 */
function pushAccounts() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("accounts", accounts.describeAll());
  } catch (e) {
    logger.warn(`推送账户数据失败: ${e.message}`);
  }
}

/** 启动周期性推送：任务运行中 3 秒一次，空闲时 10 秒一次 */
let pushTimer = null;
let pushTick = 0;
function startAutoPush() {
  if (pushTimer) clearInterval(pushTimer);
  pushTick = 0;
  pushTimer = setInterval(() => {
    pushTick++;
    // 运行中每 3 秒推；空闲时每 9 秒推一次（降低无谓 IO）
    if (running || pushTick % 3 === 0) pushAccounts();
  }, 3000);
}

function stopAutoPush() {
  if (pushTimer) clearInterval(pushTimer);
  pushTimer = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 600,
    title: "Microsoft Rewards 自动任务",
    backgroundColor: "#11141a",
    webPreferences: {
      preload: path.join(__dirname, "electron-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(ROOT, "gui", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  // 外链用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // 冒烟测试模式：加载完成后等待 init() 异步渲染，再探查关键 DOM
  if (IS_SMOKE) {
    mainWindow.webContents.on("did-finish-load", () => {
      console.log("GUI_LOADED_OK");
      // 2.5s 等待 refreshOverview / switchView 渲染完成
      setTimeout(async () => {
        try {
          const probe = await mainWindow.webContents.executeJavaScript(`(async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const r = {};
            // 仪表盘表格行数（有账户时 >0）
            const tbody = document.querySelector("#d-tbody");
            r.dRows = tbody ? tbody.children.length : -1;
            // 当前激活导航
            const act = document.querySelector(".nav-item.active");
            r.activeNav = act ? act.dataset.view : null;
            // 切到全局设置：表单工厂应注入完整表单
            document.querySelector('.nav-item[data-view="settings"]').click();
            await sleep(400);
            r.globalForm = !!document.querySelector("#g-search-api");
            r.gViewVisible = !document.getElementById("view-settings").hidden;
            // 切到账户详情：下拉、状态条、use-global 开关就位
            document.querySelector('.nav-item[data-view="account"]').click();
            await sleep(600);
            const sel = document.getElementById("acc-select");
            r.accOptions = sel ? sel.options.length : 0;
            r.ugSwitch = !!document.getElementById("use-global");
            r.ugChecked = (() => { const el = document.getElementById("use-global"); return el ? el.checked : null; })();
            r.aViewVisible = !document.getElementById("view-account").hidden;
            // 模拟关闭「遵循全局设置」：独立设置表单应注入并显示
            const ug = document.getElementById("use-global");
            if (ug) {
              ug.checked = false;
              ug.dispatchEvent(new Event("change", { bubbles: true }));
              await sleep(700);
              r.aFormShown = !document.getElementById("acc-settings").hidden;
              r.aFormInjected = !!document.querySelector("#a-search-api");
              // 恢复为遵循全局，避免污染真实配置
              ug.checked = true;
              ug.dispatchEvent(new Event("change", { bubbles: true }));
              await sleep(300);
              r.restored = document.getElementById("acc-settings").hidden === true;
            }
            // 切回仪表盘收尾
            document.querySelector('.nav-item[data-view="dashboard"]').click();
            await sleep(200);

            // ===== 次要功能探查（不写真实数据）=====

            // 表格搜索框存在 + 输入后过滤（不验证行数变化，只验证不报错）
            const search = document.getElementById("acc-search");
            r.searchBox = !!search;
            if (search) {
              search.value = "__nomatch__";
              search.dispatchEvent(new Event("input", { bubbles: true }));
              await sleep(50);
              r.searchFiltered = document.querySelectorAll("#d-tbody tr").length;
              search.value = "";
              search.dispatchEvent(new Event("input", { bubbles: true }));
              await sleep(50);
            }

            // 顶部按钮全在
            r.btnRefresh = !!document.getElementById("btn-refresh");
            r.btnRunAll = !!document.getElementById("btn-run-all");
            r.btnStop = !!document.getElementById("btn-stop");

            // 日志面板：开关 + resizer + console 容器
            r.logResizer = !!document.getElementById("log-resizer");
            r.logConsole = !!document.querySelector(".log-console");
            r.btnToggleLog = !!document.getElementById("btn-toggle-log");
            r.btnClearLog = !!document.getElementById("btn-clear-log");
            // 点一下开关日志，验证显隐切换不报错 + collapsed class 翻转
            const tl = document.getElementById("btn-toggle-log");
            if (tl) {
              const consoleEl = document.querySelector(".log-console");
              const beforeCollapsed = consoleEl ? consoleEl.classList.contains("collapsed") : null;
              tl.click();
              await sleep(100);
              const afterCollapsed = consoleEl ? consoleEl.classList.contains("collapsed") : null;
              r.logToggled = beforeCollapsed !== afterCollapsed;
              // 再点回去恢复初始状态
              tl.click();
              await sleep(50);
            }

            // 自动缩放：--fs-base 已设
            r.fsBase = getComputedStyle(document.documentElement).getPropertyValue("--fs-base").trim();

            // 新增账号 modal：点按钮 → askText 弹 modal → 点取消（不创建）
            const btnAdd = document.getElementById("btn-add");
            if (btnAdd) {
              btnAdd.click();
              await sleep(250);
              r.addModalShown = !document.getElementById("modal-mask").hidden;
              r.addModalTitle = document.getElementById("modal-title").textContent;
              r.addModalInputVisible = !document.getElementById("modal-input").hidden;
              // 点取消关闭
              document.getElementById("modal-cancel").click();
              await sleep(150);
              r.addModalClosed = document.getElementById("modal-mask").hidden;
            }

            // 账户详情页按钮全在
            document.querySelector('.nav-item[data-view="account"]').click();
            await sleep(200);
            r.btnLogin = !!document.getElementById("btn-login");
            r.btnSync = !!document.getElementById("btn-sync");
            r.btnRun = !!document.getElementById("btn-run");
            r.btnDelete = !!document.getElementById("btn-delete");

            return r;
          })()`);

          console.log("SMOKE_PROBE " + JSON.stringify(probe));
          const bad = !probe.activeNav || probe.dRows < 0 || !probe.globalForm
            || !probe.gViewVisible || probe.accOptions < 0 || !probe.ugSwitch
            || probe.ugChecked === null || !probe.aViewVisible
            || probe.aFormShown !== true || probe.aFormInjected !== true
            || probe.restored !== true
            || !probe.searchBox || probe.searchFiltered === undefined
            || !probe.btnRefresh || !probe.btnRunAll || !probe.btnStop
            || !probe.logResizer || !probe.logConsole || !probe.btnToggleLog
            || !probe.btnClearLog || !probe.logToggled || !probe.fsBase
            || !probe.addModalShown || probe.addModalTitle !== "新增账号"
            || !probe.addModalInputVisible || !probe.addModalClosed
            || !probe.btnLogin || !probe.btnSync || !probe.btnRun || !probe.btnDelete;
          app.exit(bad ? 2 : 0);
        } catch (e) {
          console.error("SMOKE_PROBE_FAIL " + e.message);
          app.exit(3);
        }
      }, 2500);
    });
    mainWindow.webContents.on("did-fail-load", (_e, code, desc) => {
      console.error(`GUI_LOAD_FAIL ${code} ${desc}`);
      app.exit(1);
    });
    mainWindow.webContents.on("render-process-gone", (_e, details) => {
      console.error("RENDER_PROCESS_GONE " + JSON.stringify(details));
      app.exit(1);
    });
    mainWindow.webContents.on("console-message", (_e, level, message) => {
      if (level >= 2) {
        console.error(`RENDER_CONSOLE_${level}: ${message}`);
        app.exit(1);
      }
    });
  }
}

/* ---------------- IPC ---------------- */
function registerIpc() {
  ipcMain.handle("accounts:list", () => {
    try {
      return accounts.describeAll();
    } catch (e) {
      logger.error(`读取账户列表失败: ${e.message}`);
      return [];
    }
  });

  ipcMain.handle("accounts:create", (_e, name) => {
    try {
      const meta = accounts.create(name);
      logger.info(`已创建账户「${meta.name}」`);
      return meta;
    } catch (e) {
      logger.error(`创建账户失败: ${e.message}`);
      return { error: e.message };
    }
  });
  ipcMain.handle("accounts:remove", (_e, id) => {
    accounts.remove(id);
    return true;
  });
  ipcMain.handle("accounts:rename", (_e, id, name) => {
    accounts.rename(id, name);
    return true;
  });
  ipcMain.handle("accounts:setEnabled", (_e, id, enabled) => {
    accounts.setEnabled(id, enabled);
    return true;
  });

  ipcMain.handle("account:getConfig", (_e, id) => accounts.context(id).config.get());
  ipcMain.handle("account:setConfig", (_e, id, patch) => accounts.context(id).config.set(patch));
  ipcMain.handle("account:getOverrides", (_e, id) => accounts.context(id).config.getOverrides());
  ipcMain.handle("account:setUseGlobal", (_e, id, v) => {
    const acc = accounts.get(id);
    const r = accounts.context(id).config.setUseGlobal(v);
    logger.info(`账户「${acc ? acc.name : id}」已切换为${v ? "遵循全局设置" : "独立设置"}`);
    pushAccounts();
    return r;
  });

  // ---- 全局设置 ----
  ipcMain.handle("global:getConfig", () => globalConfig.get());
  ipcMain.handle("global:setConfig", (_e, patch) => {
    const r = globalConfig.set(patch);
    // 全局值变了，遵循全局的账户其有效配置随之改变，立刻推一次让界面同步
    pushAccounts();
    return r;
  });

  // ---- 仪表盘聚合 ----
  ipcMain.handle("app:overview", () => {
    try {
      return accounts.overview();
    } catch (e) {
      logger.error(`读取概览数据失败: ${e.message}`);
      return { accounts: [], stats: {} };
    }
  });


  ipcMain.handle("account:login", async (_e, id) => {
    if (running) return { ok: false, error: "已有任务正在运行，请稍候" };
    const acc = accounts.get(id);
    if (!acc) return { ok: false, error: "账户不存在" };
    setRunning(true);
    logger.info(`开始为「${acc.name}」授权登录（弹出独立干净浏览器）...`);
    try {
      const { code, loggedIn } = await browser.loginInteractive(accounts.context(id));
      if (code) {
        const token = await auth.exchangeCode(accounts.context(id), code);
        return {
          ok: !!token,
          loggedIn,
          message: token
            ? loggedIn
              ? "授权成功，登录状态已同步"
              : "授权成功，但未捕获到 bing 认证 Cookie，可点「⟳ 刷新状态」重试"
            : "授权码换取 token 失败",
        };
      }
      return { ok: false, loggedIn, message: "未捕获授权码" };
    } catch (e) {
      logger.error(`登录失败: ${e.message}`);
      return { ok: false, error: e.message };
    } finally {
      setRunning(false);
    }
  });

  // 手动刷新登录状态（重新读取浏览器 Cookie）
  ipcMain.handle("account:sync", async (_e, id) => {
    if (running) return { ok: false, error: "已有任务正在运行，请稍候" };
    const acc = accounts.get(id);
    if (!acc) return { ok: false, error: "账户不存在" };
    setRunning(true);
    logger.info(`正在刷新「${acc.name}」的登录状态...`);
    try {
      const ctx = accounts.context(id);
      const r = await browser.syncCookies(ctx);
      // 登录态正常时顺便拉取一次积分余额与今日合计，刷新卡片数据
      if (r.loggedIn) {
        try {
          // 跨天先清零昨日累计，避免旧数据混入今日合计
          if (ctx.state.resetIfNewDay()) {
            logger.info("检测到新的一天，已重置每日积分累计");
          }
          const info = await rewards.getRewardsInfo(ctx);
          if (info && info.ok) {
            const st = ctx.state.get();
            if (info.balance > 0) st.lastBalance = info.balance;
            if (Number.isFinite(info.todayTotal)) {
              st.todayPointsServer = info.todayTotal;
              st.todayPoints = info.todayTotal;
            }
            // 搜索进度：无条件写入（国区 m.max 为 0，用 >0 判断会导致永不更新）
            if (info.pc) st.pc = { progress: info.pc.progress, max: info.pc.max };
            if (info.m) st.m = { progress: info.m.progress, max: info.m.max };
            // describe() 只在 lastRunDate === 今天 时才采信服务器值，
            // 这里同步成功即视为今日已有数据，否则刚拉到的值会被忽略
            st.lastRunDate = ctx.state.getDateNum();
            ctx.state.save();
            logger.success(
              `积分已刷新：总积分 ${info.balance}，今日已得 ${info.todayTotal}，PC搜索 ${info.pc.progress}/${info.pc.max}`
            );
          } else {
            logger.warn("积分信息获取失败，卡片数据未更新");
          }

          // 顺便刷新阅读进度（需要 access token，失败不影响主流程）
          try {
            const token = await auth.ensureAccessToken(ctx, false);
            if (token) {
              const rp = await rewards.getReadPro(ctx, token);
              if (rp && rp.ok) {
                const st2 = ctx.state.get();
                st2.readPoint = rp.progress;
                st2.readArticles = { done: rp.articlesDone, total: rp.articlesTotal };
                ctx.state.save();
                logger.success(`阅读进度已刷新：${rp.articlesDone}/${rp.articlesTotal} 篇（${rp.progress}/${rp.max} 分）`);
              }
            }
          } catch (e) {
            logger.warn(`刷新阅读进度失败: ${e.message}`);
          }
        } catch (e) {
          logger.warn(`刷新积分余额失败: ${e.message}`);
        }
      }
      return {
        ok: true,
        loggedIn: r.loggedIn,
        message: r.loggedIn ? "登录状态已同步：已登录" : "未检测到登录态，请点「授权登录」重新登录",
      };
    } catch (e) {
      logger.error(`刷新状态失败: ${e.message}`);
      return { ok: false, error: e.message };
    } finally {
      setRunning(false);
    }
  });

  ipcMain.handle("account:run", async (_e, id) => {
    if (running) return { ok: false, error: "已有任务正在运行，请稍候" };
    const acc = accounts.get(id);
    if (!acc) return { ok: false, error: "账户不存在" };
    cancel.reset();
    setRunning(true);
    try {
      const result = await runner.runOnce(accounts.context(id), { interactive: true });
      return { ok: true, result };
    } catch (e) {
      if (e && e.isAbort) {
        logger.warn("任务已被手动停止");
        return { ok: false, aborted: true, error: "任务已停止" };
      }
      logger.error(`运行失败: ${e.message}`);
      return { ok: false, error: e.message };
    } finally {
      setRunning(false);
    }
  });

  ipcMain.handle("app:runAll", async () => {
    if (running) return { ok: false, error: "已有任务正在运行，请稍候" };
    cancel.reset();
    setRunning(true);
    try {
      const results = await runner.runAll({ interactive: true });
      return { ok: true, results };
    } catch (e) {
      if (e && e.isAbort) {
        logger.warn("任务已被手动停止");
        return { ok: false, aborted: true, error: "任务已停止" };
      }
      logger.error(`运行失败: ${e.message}`);
      return { ok: false, error: e.message };
    } finally {
      setRunning(false);
    }
  });

  // 停止当前任务
  ipcMain.handle("app:stop", () => {
    if (!running) return { ok: false, error: "当前没有正在运行的任务" };
    logger.warn("收到停止指令，正在中断当前任务...");
    cancel.abort();
    return { ok: true };
  });

  ipcMain.handle("app:isRunning", () => running);

  ipcMain.handle("app:getLogs", () => {
    try {
      const file = logger.getLogFile();
      const content = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
      return content.split("\n").filter(Boolean).slice(-500);
    } catch {
      return [];
    }
  });

  ipcMain.handle("app:chromiumStatus", () => ({
    ready: browser.isChromiumReady(),
    executable: browser.chromiumExecutablePath(),
  }));

  ipcMain.handle("app:installBrowser", async () => {
    if (running) return { ok: false, error: "已有任务正在运行，请稍候" };
    setRunning(true);
    // 把安装进度实时推到渲染进程
    ensureDeps.onProgress((p) => {
      try { mainWindow?.webContents?.send("install-progress", p); } catch {}
    });
    try {
      const result = await ensureDeps.ensureChromium(browser);
      logger.info(`Chromium 安装完成: method=${result.method}, ready=${result.ready}`);
      return { ok: result.ready, method: result.method, error: result.error };
    } catch (e) {
      logger.error(`Chromium 安装失败: ${e.message}`);
      return { ok: false, error: e.message };
    } finally {
      setRunning(false);
    }
  });
}

/* ---------------- 生命周期 ---------------- */
app.whenReady().then(() => {
  registerIpc();
  createWindow();

  // 日志实时推送到渲染进程
  logger.onLog((line) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("log", line);
    }
  });

  // 启动自动运行守护（按各账户 schedule 模式循环触发）
  // 自动运行开始/结束时同步广播 running 状态，让界面按钮与「停止任务」正确联动
  daemonStop = runner.startDaemon({
    isBusy: () => running,
    onRunStart: () => setRunning(true),
    onRunEnd: () => setRunning(false),
  });

  // 启动账户数据周期推送（卡片自动刷新，无需手动点按钮）
  if (!IS_SMOKE) startAutoPush();

  // 启动时自动检测 Chromium，未就绪则后台安装（不阻塞 UI）
  if (!IS_SMOKE && !browser.isChromiumReady()) {
    logger.info("检测到 Chromium 未安装，后台开始自动安装…");
    ensureDeps.onProgress((p) => {
      try { mainWindow?.webContents?.send("install-progress", p); } catch {}
    });
    ensureDeps.ensureChromium(browser)
      .then((r) => {
        logger.info(`后台 Chromium 安装结果: method=${r.method}, ready=${r.ready}`);
        // 安装完推送一次账户数据，让「Chromium 已就绪」徽标刷新
        pushAccounts();
      })
      .catch((e) => logger.error(`后台 Chromium 安装失败: ${e.message}`));
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (daemonStop) { daemonStop(); daemonStop = null; }
  stopAutoPush();
  app.quit();
});
