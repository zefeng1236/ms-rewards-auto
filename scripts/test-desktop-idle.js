/**
 * 桌面任务空闲触发器离线回归（2026-11-19，notify/auto/manual 三模式）。
 * 全程离线：不读真实空闲、不发通知、不跑任务、不碰账号。
 * 用法: npm run test:idle
 */
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const { createDesktopIdleWatcher } = require(path.join(ROOT, "src", "desktop-idle.js"));
const runtime = require(path.join(ROOT, "src", "desktop-runtime.js"));

const lines = [];
let failed = 0;
async function test(name, fn) {
  try { await fn(); lines.push(`  ✅ ${name}`); }
  catch (e) { failed++; lines.push(`  ❌ ${name} — ${String((e && e.message) || e).slice(0, 200)}`); }
}

function mk(cfg, idle, busy = false) {
  return createDesktopIdleWatcher({
    readIdle: () => idle,
    getConfig: () => cfg,
    isBusy: () => busy,
  });
}
const AUTO = { enabled: true, mode: "auto", idleMinutes: 5 };
const NOTIFY = { enabled: true, mode: "notify", idleMinutes: 5 };
const MANUAL = { enabled: true, mode: "manual", idleMinutes: 5 };

async function main() {
  await test("① auto：空闲不足不跑，达标跑一次，episode 内不重复", async () => {
    let idle = 2;
    const w = createDesktopIdleWatcher({ readIdle: () => idle, getConfig: () => AUTO, isBusy: () => false });
    assert.equal(w.tick().action, "none");       // 2 < 5
    idle = 5;
    assert.equal(w.tick().action, "run");        // 达标 → run
    assert.equal(w.tick().action, "none");       // 同 episode 不重复
    assert.equal(w.tick().reason, "episode-handled");
  });

  await test("② auto：用户恢复操作复位，再次空闲算新 episode", async () => {
    let idle = 6;
    const w = createDesktopIdleWatcher({ readIdle: () => idle, getConfig: () => AUTO, isBusy: () => false });
    assert.equal(w.tick().action, "run");
    idle = 0;                                    // 回到电脑前
    assert.equal(w.tick().action, "none");
    assert.equal(w.tick().reason, "user-active");
    idle = 7;                                    // 又离开
    assert.equal(w.tick().action, "run");        // 新 episode 再跑
  });

  await test("③ notify：达标发通知而非直接跑，episode 内不重复通知", async () => {
    const w = mk(NOTIFY, 6);
    const d = w.tick();
    assert.equal(d.action, "notify");
    assert.equal(w.tick().action, "none");
    assert.equal(w.tick().reason, "episode-handled");
  });

  await test("④ notify：点通知 authorize → run（授权不受 episode 限制）", async () => {
    const w = mk(NOTIFY, 6);
    assert.equal(w.tick().action, "notify");
    assert.equal(w.authorize().action, "run");
    assert.equal(w.authorize().authorized, true);
  });

  await test("⑤ 未开启 / 读不到空闲 / 忙 → 一律不动作", async () => {
    assert.equal(mk({ enabled: false, mode: "auto", idleMinutes: 5 }, 99).tick().action, "none");
    assert.equal(mk(AUTO, null).tick().action, "none");       // fail-open
    assert.equal(mk(AUTO, undefined).tick().action, "none");
    assert.equal(mk(AUTO, 99, true).tick().action, "none");   // busy
    assert.equal(mk(AUTO, 99, true).tick().reason, "busy");
  });

  await test("⑥ 阈值取 config.idleMinutes，非法回落 5", async () => {
    const w = mk({ enabled: true, mode: "auto", idleMinutes: 0 }, 4);
    assert.equal(w.tick().action, "none");      // 非法阈值回落 5，4<5
    const w2 = mk({ enabled: true, mode: "auto", idleMinutes: 3 }, 3);
    assert.equal(w2.tick().action, "run");      // 3>=3
  });

  await test("⑦ 关闭开关会复位 episode（重新开启后空闲达标能再触发）", async () => {
    let cfg = { ...AUTO };
    let idle = 6;
    const w = createDesktopIdleWatcher({ readIdle: () => idle, getConfig: () => cfg, isBusy: () => false });
    assert.equal(w.tick().action, "run");
    cfg = { enabled: false };
    assert.equal(w.tick().action, "none");
    cfg = { ...AUTO };
    assert.equal(w.tick().action, "run");       // 关闭时已复位
  });

  await test("⑧ 与 runDesktopTask 的冷却/收口函数协同（纯函数）", async () => {
    runtime.resetDesktopCooldown();
    assert.equal(runtime.normalizeIdleMinutes(5), 5);
    assert.equal(runtime.desktopInCooldown(Date.now()), false);
    runtime.markDesktopRun(Date.now());
    assert.equal(runtime.desktopInCooldown(Date.now()), true);
    runtime.resetDesktopCooldown();
  });

  await test("⑨ manual（仅限手动）：空闲再多也永不触发，且复位 episode", async () => {
    const w = mk(MANUAL, 99);
    assert.equal(w.tick().action, "none");
    assert.equal(w.tick().reason, "manual");
    // 用户定「仅限手动」：authorize 也不该被空闲触发器这条链路用到，
    // 但函数本身保留（notify 点通知用）—— 这里只锁 tick 永不动作。
    assert.equal(mk(MANUAL, 99, true).tick().action, "none");
    // 切回 auto 后能正常触发（manual 期间 episode 已复位）
    let cfg = { ...MANUAL };
    let idle = 6;
    const w2 = createDesktopIdleWatcher({ readIdle: () => idle, getConfig: () => cfg, isBusy: () => false });
    assert.equal(w2.tick().reason, "manual");
    cfg = { ...AUTO };
    assert.equal(w2.tick().action, "run");
  });

  console.log(lines.join("\n"));
  console.log(`\n结果: ${lines.length - failed} 通过 / ${failed} 失败`);
  if (failed) process.exitCode = 1;
}
main();
