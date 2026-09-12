/**
 * 开发模式一键启动：同时拉起 Vite dev server 与 Electron。
 *
 * 直接用 `npm start` 时，如果 Vite 没跑，electron-main 会回落到已构建的
 * gui-react/（见 loadRenderer 的兜底逻辑）——能开窗口但没有热更新。
 * 想边改边看就用 `npm run dev`：本脚本会等 dev server 就绪后再启动 Electron。
 */
const { spawn, execSync } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DEV_SERVER = "http://localhost:5173/";
const VITE_BIN = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
const isWin = process.platform === "win32";

// 沙箱/某些终端会带 ELECTRON_RUN_AS_NODE，会把 electron.exe 变成纯 Node
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Windows 控制台默认 GBK，会把子进程输出的 UTF-8 中文显示成乱码 */
function ensureUtf8Console() {
  if (!isWin) return;
  try {
    const cp = execSync("chcp", { encoding: "utf8" });
    if (!/65001/.test(cp)) {
      execSync("chcp 65001 >nul", { stdio: "ignore" });
      console.log("[dev] 已将控制台切换到 UTF-8（chcp 65001），避免中文日志乱码");
    }
  } catch {
    /* 拿不到代码页就跳过，不影响启动 */
  }
}

function reachable() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const req = http.get(DEV_SERVER, (res) => {
        res.resume();
        done(res.statusCode < 500);
      });
      req.setTimeout(700, () => {
        req.destroy();
        done(false);
      });
      req.on("error", () => done(false));
    } catch {
      done(false);
    }
  });
}

async function waitForServer(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await reachable()) return true;
    await wait(400);
  }
  return false;
}

async function main() {
  ensureUtf8Console();

  // 直接 spawn vite 的 node 入口（而不是 npm run），这样 kill 能真正杀掉进程；
  // 走 npm.cmd 时 kill 只杀到外壳，vite 会变孤儿进程继续占着 5173。
  let vite = null;

  if (await reachable()) {
    // 已有 dev server 在跑（比如上次没退干净），复用它，不要起第二个
    console.log("[dev] 5173 已有 dev server 在运行，直接复用");
  } else {
    console.log("[dev] 启动 Vite dev server…");
    vite = spawn(process.execPath, [VITE_BIN, "--config", "src-renderer/vite.config.ts"], {
      cwd: ROOT,
      stdio: "inherit",
      env,
    });

    if (!(await waitForServer())) {
      console.error("[dev] Vite dev server 启动超时，放弃");
      vite.kill("SIGTERM");
      process.exit(1);
    }
  }

  console.log("[dev] dev server 就绪，启动 Electron…");
  const electronExe = path.join(
    ROOT,
    "node_modules",
    "electron",
    "dist",
    isWin ? "electron.exe" : "electron"
  );
  const electron = spawn(electronExe, ["."], { cwd: ROOT, stdio: "inherit", env });

  const shutdown = () => {
    // 只杀自己拉起来的 vite，复用的不能动
    if (vite) vite.kill("SIGTERM");
    electron.kill("SIGTERM");
  };
  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });

  electron.on("exit", (code) => {
    if (vite) vite.kill("SIGTERM");
    process.exit(code === null ? 0 : code);
  });
}

main().catch((e) => {
  console.error("[dev] 启动失败:", e.message);
  process.exit(1);
});
