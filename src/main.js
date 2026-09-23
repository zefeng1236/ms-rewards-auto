const readline = require("readline");
const accounts = require("./account");
const runner = require("./runner");
const browser = require("./browser");
const logger = require("./logger");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q) {
  return new Promise((res) => rl.question(q, res));
}

function printHeader() {
  logger.plain("");
  logger.plain("=====================================");
  logger.plain("  MS Rewards 自动任务 (CLI)");
  logger.plain("=====================================");
}

function printAccounts() {
  const list = accounts.list();
  if (list.length === 0) {
    logger.plain("（暂无账户）");
    return;
  }
  list.forEach((a, i) => {
    const view = accounts.describe(a.id);
    const login = view.state.loggedIn ? "已登录" : "未登录";
    const on = a.enabled ? "启用" : "停用";
    logger.plain(`${i + 1}. [${a.id.slice(0, 8)}] ${a.name} (${on} / ${login} / 今日${view.state.todayPoints}分)`);
  });
}

function pickAccount(label) {
  return new Promise(async (resolve) => {
    const list = accounts.list();
    if (list.length === 0) {
      logger.plain("请先添加账户：add <名称>");
      return resolve(null);
    }
    printAccounts();
    const ans = (await ask(`选择账户（1-${list.length}）用于${label}: `)).trim();
    const idx = Number(ans) - 1;
    resolve(list[idx] || null);
  });
}

async function cmdAdd(name) {
  const acc = accounts.create(name);
  logger.ok(`已创建账户「${acc.name}」，请使用 login 进行授权登录`);
}

async function cmdLogin(id) {
  const acc = accounts.get(id);
  if (!acc) return logger.error("账户不存在");
  const ctx = accounts.context(id);
  logger.info(`开始为「${acc.name}」授权登录（将弹出独立干净浏览器）...`);
  const { code, loggedIn } = await browser.loginInteractive(ctx);
  if (code) {
    const auth = require("./auth");
    const token = await auth.exchangeCode(ctx, code);
    if (token) logger.ok(`「${acc.name}」授权成功`);
    else logger.error(`「${acc.name}」授权码换取 token 失败`);
  } else {
    logger.warn("未捕获授权码");
  }
}

async function cmdRun(id) {
  const acc = accounts.get(id);
  if (!acc) return logger.error("账户不存在");
  const ctx = accounts.context(id);
  await runner.runOnce(ctx, { interactive: false });
}

async function menu() {
  printHeader();
  printAccounts();
  logger.plain("");
  logger.plain("支持命令：");
  logger.plain("  add <名称>          添加账户");
  logger.plain("  rm <序号>           删除账户");
  logger.plain("  login <序号>        授权登录");
  logger.plain("  run <序号|all>      立即运行");
  logger.plain("  daemon              启动定时守护（Ctrl+C 退出）");
  logger.plain("  browser             检查/安装 Chromium");
  logger.plain("  quit                退出");
  const cmd = (await ask("> ")).trim().split(/\s+/);
  const action = (cmd[0] || "").toLowerCase();
  const arg = cmd[1];

  const list = accounts.list();
  const byIdx = (s) => {
    const i = Number(s) - 1;
    return Number.isFinite(i) ? list[i] : null;
  };

  try {
    switch (action) {
      case "add": {
        await cmdAdd(arg);
        break;
      }
      case "rm": {
        const acc = byIdx(arg);
        if (!acc) return logger.error("序号无效");
        accounts.remove(acc.id);
        logger.ok(`已删除账户「${acc.name}」`);
        break;
      }
      case "login": {
        const acc = byIdx(arg);
        if (!acc) return logger.error("序号无效");
        await cmdLogin(acc.id);
        break;
      }
      case "run": {
        if (arg === "all") {
          await runner.runAll({ interactive: false });
        } else {
          const acc = byIdx(arg);
          if (!acc) return logger.error("序号无效");
          await cmdRun(acc.id);
        }
        break;
      }
      case "daemon": {
        logger.plain("定时守护运行中，按 Ctrl+C 退出...");
        runner.startDaemon();
        break;
      }
      case "browser": {
        if (browser.isChromiumReady()) {
          logger.ok(`Chromium 已就绪: ${browser.chromiumExecutablePath()}`);
        } else {
          logger.warn("Chromium 未安装，请运行: npx playwright install chromium");
        }
        break;
      }
      case "quit":
      case "exit":
      case "q":
        rl.close();
        return;
      default:
        logger.warn("未知命令");
    }
  } catch (e) {
    logger.error(`命令执行失败: ${e.message}`);
  }
  menu();
}

async function main() {
  const args = process.argv.slice(2);
  const sub = (args[0] || "").toLowerCase();
  try {
    switch (sub) {
      case "add": {
        await cmdAdd(args.slice(1).join(" "));
        break;
      }
      case "login": {
        const list = accounts.list();
        const acc = Number(args[1]) - 1 >= 0 ? list[Number(args[1]) - 1] : list[0];
        if (!acc) return logger.error("账户不存在，请先 add");
        await cmdLogin(acc.id);
        break;
      }
      case "run": {
        const list = accounts.list();
        if (args[1] === "all") {
          await runner.runAll({ interactive: false });
        } else {
          const acc = Number(args[1]) - 1 >= 0 ? list[Number(args[1]) - 1] : list[0];
          if (!acc) return logger.error("账户不存在，请先 add");
          await cmdRun(acc.id);
        }
        break;
      }
      case "daemon": {
        logger.plain("定时守护运行中，按 Ctrl+C 退出...");
        runner.startDaemon();
        break;
      }
      case "list": {
        printAccounts();
        break;
      }
      case "rm": {
        const list = accounts.list();
        const acc = list[Number(args[1]) - 1];
        if (acc) {
          accounts.remove(acc.id);
          logger.ok(`已删除账户「${acc.name}」`);
        }
        break;
      }
      case "browser": {
        if (browser.isChromiumReady()) {
          logger.ok(`Chromium 已就绪: ${browser.chromiumExecutablePath()}`);
        } else {
          logger.warn("Chromium 未安装，请运行: npx playwright install chromium");
        }
        break;
      }
      default: {
        menu();
        return;
      }
    }
  } catch (e) {
    logger.error(`执行失败: ${e.message}`);
  }
  if (sub !== "daemon") rl.close();
}

main();
