/**
 * 「通知被点击」启动参数识别 + 主进程转发链路的离线回归（2026-11-21）。
 * 全程离线：不启动 Electron、不发通知、不跑任务、不碰注册表/账号。
 * 用法: npm run test:toast
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const {
  isToastActivationArgv,
  isProtocolActivationArgv,
  shouldAuthorizeFromSecondInstance,
  TOAST_ACTIVATION_RE,
  PENDING_WINDOW_MS,
} = require(path.join(ROOT, "src", "toast-activation.js"));

const lines = [];
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    lines.push(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    lines.push(`  ❌ ${name} — ${String((e && e.message) || e).slice(0, 200)}`);
  }
}

const mainSrc = fs.readFileSync(path.join(ROOT, "src", "electron-main.js"), "utf8");

async function main() {
  await test("① COM 激活（-Embedding）识别为通知激活", async () => {
    assert.equal(isToastActivationArgv(["D:\\app\\MS Rewards Auto.exe", "-Embedding"]), true);
    assert.equal(isToastActivationArgv(["--embedding"]), true);
  });

  await test("② 快捷方式激活（-ToastActivated）三种前缀与大小写都识别", async () => {
    assert.equal(isToastActivationArgv(["-ToastActivated"]), true);
    assert.equal(isToastActivationArgv(["--toastactivated"]), true);
    assert.equal(isToastActivationArgv(["/ToastActivated"]), true);
    assert.equal(isToastActivationArgv(["-TOASTACTIVATED"]), true);
  });

  await test("③ 普通启动参数不得误判为通知激活", async () => {
    assert.equal(isToastActivationArgv(["app.exe"]), false);
    assert.equal(isToastActivationArgv(["electron.exe", "path-to-app"]), false);
    assert.equal(isToastActivationArgv(["--remote-debugging-port=9222"]), false);
    assert.equal(isToastActivationArgv(["--hidden"]), false);
    // 「-EmbeddingSomething」是别的参数，不能被前缀糊住
    assert.equal(isToastActivationArgv(["-EmbeddingFake"]), false);
  });

  await test("④ 空值 / 非数组安全返回 false（不能让主进程启动即崩）", async () => {
    assert.equal(isToastActivationArgv([]), false);
    assert.equal(isToastActivationArgv(null), false);
    assert.equal(isToastActivationArgv(undefined), false);
    assert.equal(isToastActivationArgv("not-an-array"), false);
    assert.equal(isToastActivationArgv([null, undefined]), false);
    assert.equal(TOAST_ACTIVATION_RE instanceof RegExp, true);
  });

  await test("⑤ 第二实例：激活参数直接授权；普通参数靠「待授权时间窗」", async () => {
    const now = 1_700_000_000_000;
    // 明确的激活参数：无论有没有待授权都算点击
    assert.equal(shouldAuthorizeFromSecondInstance(["-ToastActivated"], 0, now), true);
    // 普通参数 + 刚发过通知（5 分钟前）→ 视为用户授权
    assert.equal(shouldAuthorizeFromSecondInstance(["app.exe"], now - 5 * 60 * 1000, now), true);
    // 普通参数但通知已过期（40 分钟前 > 30 分钟窗口）→ 不授权
    assert.equal(shouldAuthorizeFromSecondInstance(["app.exe"], now - 40 * 60 * 1000, now), false);
    // 没有待授权通知 + 普通参数 → 只是双击图标唤窗口，不许擅自跑任务
    assert.equal(shouldAuthorizeFromSecondInstance(["app.exe"], 0, now), false);
    assert.equal(shouldAuthorizeFromSecondInstance(["app.exe"], undefined, now), false);
    // 时间窗可注入（测试/参数化）
    assert.equal(shouldAuthorizeFromSecondInstance(["app.exe"], now - 90_000, now, 60_000), false);
    assert.equal(shouldAuthorizeFromSecondInstance(["app.exe"], now - 30_000, now, 60_000), true);
    assert.equal(PENDING_WINDOW_MS, 30 * 60 * 1000);
  });

  await test("⑥ 时间戳异常不得误判（时钟回拨 / NaN）", async () => {
    const now = 1_700_000_000_000;
    assert.equal(shouldAuthorizeFromSecondInstance(["app.exe"], NaN, now), false);
    assert.equal(shouldAuthorizeFromSecondInstance(["app.exe"], -1, now), false);
    // 时钟回拨超过 1 分钟抖动容忍 -> 不授权
    assert.equal(shouldAuthorizeFromSecondInstance(["app.exe"], now + 10 * 60 * 1000, now), false);
    // 回拨 10 秒在容忍范围内 -> 授权
    assert.equal(shouldAuthorizeFromSecondInstance(["app.exe"], now + 10_000, now), true);
  });

  await test("⑦ 主进程：通知发出时记待授权、第二实例按时间窗授权、跑完清空", async () => {
    const m = mainSrc.match(/app\.on\("second-instance",\s*\(([^)]*)\)\s*=>\s*\{([\s\S]{0,1400}?)\n {4}\}\);/);
    assert.ok(m, "找不到 second-instance 处理块");
    const body = m[2];
    assert.match(m[1], /argv/, "second-instance 必须接收 argv（激活参数优先）");
    assert.match(body, /shouldAuthorizeFromSecondInstance\(\s*argv/);
    assert.match(body, /desktopNotifyPendingAt = 0;/, "授权后必须清空待授权，避免重复跑");
    assert.ok(
      body.indexOf("executeDesktopIdleRun(true)") > body.indexOf("shouldAuthorizeFromSecondInstance"),
      "判定为授权后必须真的执行（true）"
    );
    // 发通知处必须记时间
    // 2026-11-22 起发通知前多了「场景抑制 + 无响应限流」两道前置判定，函数体变长，
    // 截取窗口相应放大（断言本身不放宽：仍要求 show() 后记待授权时间）。
    const notifyBlock = mainSrc.slice(
      mainSrc.indexOf("function sendDesktopIdleNotification()"),
      mainSrc.indexOf("function sendDesktopIdleNotification()") + 3200
    );
    assert.match(notifyBlock, /\.show\(\);[\s\S]{0,400}?desktopNotifyPendingAt = Date\.now\(\);/);
    // 执行入口清空
    const runHead = mainSrc.slice(
      mainSrc.indexOf("async function executeDesktopIdleRun("),
      mainSrc.indexOf("async function executeDesktopIdleRun(") + 400
    );
    assert.match(runHead, /desktopNotifyPendingAt = 0;/);
  });

  await test("⑧ 冷启动激活也要执行（应用本来没在跑时没有第二实例可转发）", async () => {
    assert.match(mainSrc, /isToastActivationArgv\(process\.argv\)/);
    const idx = mainSrc.indexOf("isToastActivationArgv(process.argv)");
    const tail = mainSrc.slice(idx, idx + 320);
    assert.match(tail, /executeDesktopIdleRun\(true\)/, "冷启动分支必须调用授权执行");
    assert.match(tail, /冷启动/, "冷启动分支要有可检索的日志标识");
  });

  await test("⑨ 协议激活（点原生 Toast）是明确的用户授权，不受时间窗限制", async () => {
    assert.equal(isProtocolActivationArgv(["msrewards://desktop-authorize"]), true);
    assert.equal(isProtocolActivationArgv(["C:\\app.exe", "MSREWARDS://desktop-authorize/"]), true);
    assert.equal(isProtocolActivationArgv(["msrewards://other"]), false);
    assert.equal(isProtocolActivationArgv([]), false);
    assert.equal(isProtocolActivationArgv(null), false);
    assert.equal(shouldAuthorizeFromSecondInstance(["msrewards://desktop-authorize"], 0, 1e12), true);
    assert.equal(shouldAuthorizeFromSecondInstance(["普通参数"], 0, 1e12), false);
  });

  await test("⑩ 主进程：协议注册 / 原生 Toast 优先 / 冷启动认协议都接上了", async () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "electron-main.js"), "utf8");
    assert.ok(src.includes("isProtocolActivationArgv(process.argv)"), "冷启动要认协议参数");
    assert.ok(src.includes("desktopToast.ensureProtocol("), "whenReady 要注册协议");
    assert.ok(src.includes("isPackaged: app.isPackaged"), "协议注册必须限定打包版");
    const start = src.indexOf("async function sendDesktopIdleNotification");
    assert.ok(start > 0);
    const body = src.slice(start, start + 4000);
    assert.ok(body.includes("desktopToast.showAuthorizationToast()"));
    assert.ok(
      body.indexOf("desktopToast.showAuthorizationToast()") < body.indexOf("new Notification({"),
      "原生 Toast 必须在 Electron 兜底之前"
    );
  });

  console.log(lines.join("\n"));
  console.log(
    failed === 0
      ? `\n结果: ${lines.length} 通过 / 0 失败`
      : `\n结果: ${lines.length - failed} 通过 / ${failed} 失败`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("测试脚本自身异常:", e);
  process.exit(1);
});
