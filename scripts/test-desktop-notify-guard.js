/**
 * 「无响应弹窗」限流离线回归（2026-11-22）。
 * 全程固定时间戳 / 不碰磁盘 / 不碰 Electron / 不发通知。
 * 用法: npm run test:notify-guard
 */
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const G = require(path.join(ROOT, "src", "desktop-notify-guard.js"));

const lines = [];
let failed = 0;
async function test(name, fn) {
  try { await fn(); lines.push(`  ✅ ${name}`); }
  catch (e) { failed++; lines.push(`  ❌ ${name} — ${String((e && e.message) || e).slice(0, 220)}`); }
}

const T0 = 1770000000000; // 固定时刻，仅作相对基准
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 20261122;

/** 固定 dayOf，避免本地时区/跨天影响用例 */
function guard(initial, dayOf) {
  return G.createDesktopNotifyGuard(initial, { dayOf: dayOf || (() => DAY) });
}

/** 模拟一次「空闲达标 → 准备弹通知 → 弹出去」 */
function popup(g, t) {
  const d = g.decide(t, false);
  if (d.action === "allow") g.noteShown(t);
  return d;
}

async function main() {
  await test("① 常量锁死：待授权 30min / 窗口 1h / 阈值 3 次 / 抑制 2h", async () => {
    assert.equal(G.PENDING_WINDOW_MS, 30 * MIN);
    assert.equal(G.MISS_WINDOW_MS, HOUR);
    assert.equal(G.MISS_LIMIT, 3);
    assert.equal(G.SUPPRESS_MS, 2 * HOUR);
  });

  await test("② 前 4 条无人理仍允许，第 5 条起触发限流（超过 3 次）", async () => {
    const g = guard();
    for (let i = 1; i <= 4; i++) {
      assert.equal(popup(g, T0 + i * MIN).action, "allow", `第 ${i} 条应允许`);
    }
    const d = popup(g, T0 + 5 * MIN);
    assert.equal(d.action, "suppress");
    assert.equal(d.reason, "miss-limit");
    assert.equal(d.until, T0 + 5 * MIN + G.SUPPRESS_MS);
    assert.equal(g.snapshot().triggerCount, 1);
  });

  await test("③ 2 小时抑制期内一律不弹，过期后恢复", async () => {
    const g = guard();
    for (let i = 1; i <= 5; i++) popup(g, T0 + i * MIN);
    const triggerAt = T0 + 5 * MIN;
    assert.equal(g.decide(triggerAt + HOUR, false).reason, "cooldown");
    assert.equal(g.decide(triggerAt + 2 * HOUR - 1, false).reason, "cooldown");
    assert.equal(g.decide(triggerAt + 2 * HOUR, false).action, "allow");
  });

  await test("④ 用户响应一次 → 连续计数中断，不再误触发", async () => {
    const g = guard();
    for (let i = 1; i <= 3; i++) popup(g, T0 + i * MIN);
    g.noteResponded(T0 + 3 * MIN + 1000); // 点了通知 / 唤回应用完成授权
    assert.equal(g.snapshot().misses.length, 0);
    assert.equal(g.pendingAt(), 0);
    for (let i = 4; i <= 7; i++) assert.equal(popup(g, T0 + i * MIN).action, "allow");
    assert.equal(g.decide(T0 + 8 * MIN, false).action, "suppress");
  });

  await test("⑤ 1 小时滑动窗口：过期 miss 不参与计数", async () => {
    const g = guard();
    // 间隔 40 分钟发一条：第 4 条时窗口内只剩 2 次 miss
    popup(g, T0);
    popup(g, T0 + 40 * MIN);
    popup(g, T0 + 80 * MIN);
    const d = popup(g, T0 + 120 * MIN);
    assert.equal(d.action, "allow");
    assert.ok(d.misses < G.MISS_LIMIT + 1);
    // 连续密集 4 次仍能触发（窗口内都有效）
    const g2 = guard();
    for (let i = 0; i < 4; i++) popup(g2, T0 + i * 10 * MIN);
    assert.equal(popup(g2, T0 + 40 * MIN).action, "suppress");
  });

  await test("⑥ 巡检 settle：窗口内不记账，超 30 分钟结算一次 miss", async () => {
    const g = guard();
    g.noteShown(T0);
    assert.equal(g.settle(T0 + 29 * MIN), false);
    assert.equal(g.snapshot().misses.length, 0);
    assert.equal(g.settle(T0 + 30 * MIN), true);
    assert.equal(g.snapshot().misses.length, 1);
    assert.equal(g.pendingAt(), 0);
    assert.equal(g.settle(T0 + 31 * MIN), false); // 不重复记账
  });

  await test("⑦ 跨天：清连续计数与待授权，但 2 小时抑制期必须保留", async () => {
    let day = DAY;
    const g = guard(null, () => day);
    for (let i = 1; i <= 4; i++) popup(g, T0 + i * MIN);
    const trigger = g.decide(T0 + 5 * MIN, false);
    assert.equal(trigger.action, "suppress");
    day = DAY + 1;
    assert.equal(g.decide(T0 + 6 * MIN, false).reason, "cooldown", "跨天不能绕过抑制期");
    // 单独验证跨天清连续：当天攒了 miss，跨天后必须重新算
    const g2 = guard(null, () => day);
    popup(g2, T0);
    popup(g2, T0 + 2 * MIN);
    assert.equal(g2.snapshot().misses.length, 1, "当天应已记 1 次无响应");
    day = DAY + 2;
    g2.decide(T0 + 10 * MIN, false);
    assert.equal(g2.snapshot().misses.length, 0, "跨天后昨天的无响应不该接着累计");
  });

  await test("⑧ snapshot / restore 往返：抑制期与计数不丢", async () => {
    const g = guard();
    for (let i = 1; i <= 5; i++) popup(g, T0 + i * MIN);
    const snap = g.snapshot();
    const json = JSON.parse(JSON.stringify(snap));
    const g2 = guard(json);
    assert.equal(g2.decide(T0 + 6 * MIN, false).reason, "cooldown");
    assert.equal(g2.snapshot().triggerCount, snap.triggerCount);
    // 损坏数据不能炸，也不能凭空产生抑制
    const g3 = guard({ misses: "bad", suppressUntil: -5, pendingAt: "x" });
    assert.equal(g3.decide(T0, false).action, "allow");
  });

  await test("⑨ 开关「1小时内多次未响应弹窗自动运行」：触发时 auto-run 一次", async () => {
    const g = guard();
    for (let i = 1; i <= 4; i++) {
      assert.equal(g.decide(T0 + i * MIN, true).action, "allow");
      g.noteShown(T0 + i * MIN);
    }
    const d = g.decide(T0 + 5 * MIN, true);
    assert.equal(d.action, "auto-run");
    assert.equal(d.reason, "miss-limit");
    assert.equal(g.snapshot().lastAutoRunAt, T0 + 5 * MIN);
    // 抑制期内后续 episode 不再重复自动跑（避免 2 小时内反复抢焦点）
    assert.equal(g.decide(T0 + 6 * MIN, true).action, "suppress");
    // 默认关闭：同样的序列只 suppress
    const g2 = guard();
    for (let i = 1; i <= 4; i++) { g2.decide(T0 + i * MIN, false); g2.noteShown(T0 + i * MIN); }
    assert.equal(g2.decide(T0 + 5 * MIN, false).action, "suppress");
    assert.equal(g2.snapshot().lastAutoRunAt, 0);
  });

  await test("⑩ now 全由调用方注入（固定输入得到确定结果，不读真实时钟）", async () => {
    const src = require("node:fs").readFileSync(path.join(ROOT, "src", "desktop-notify-guard.js"), "utf8");
    assert.match(src, /function decide\(now, autoRunOnMiss\)/);
    assert.match(src, /function settle\(now\)/);
    assert.match(src, /function noteShown\(now\)/);
    assert.match(src, /function noteResponded\(now\)/);
    const a = guard(); const b = guard();
    for (let i = 1; i <= 5; i++) { a.decide(T0 + i * MIN, false); a.noteShown(T0 + i * MIN); }
    for (let i = 1; i <= 5; i++) { b.decide(T0 + i * MIN, false); b.noteShown(T0 + i * MIN); }
    assert.deepEqual(a.snapshot(), b.snapshot());
  });

  await test("⑪ 组合不变量：看视频被抑制时不弹窗，也不该记「无响应」", async () => {
    const P = require(path.join(ROOT, "src", "desktop-presence.js"));
    const g = guard();
    const attempt = (snap, t) => {
      const pv = P.evaluatePresence(snap);
      if (pv.suppress) return { action: "skip-scene", reason: pv.reason };
      const d = g.decide(t, false);
      if (d.action === "allow") g.noteShown(t);
      return d;
    };
    // 2026-11-22 起视频必须「归因到前台应用」才算看视频（动态壁纸不算）
    const video = { ok: true, quns: 5, fullscreen: false, cpu: 30, gpu: 8, videoActive: true, videoUserFacing: true };
    const wallpaper = { ...video, videoUserFacing: false, videoWallpaperOnly: true };
    assert.equal(P.evaluatePresence(wallpaper).suppress, false, "动态壁纸不该抑制弹窗");
    for (let i = 1; i <= 6; i++) {
      const r = attempt(video, T0 + i * MIN);
      assert.equal(r.action, "skip-scene");
      assert.equal(r.reason, "video");
    }
    assert.equal(g.snapshot().misses.length, 0, "没弹过的窗不能算无响应");
    assert.equal(g.pendingAt(), 0);
    // 视频结束后恢复正常：仍要累计 4 次无响应才触发限流
    const idle = { ok: true, quns: 5, fullscreen: false, cpu: 12, gpu: 3, videoActive: false };
    for (let i = 7; i <= 10; i++) assert.equal(attempt(idle, T0 + i * MIN).action, "allow");
    assert.equal(attempt(idle, T0 + 11 * MIN).action, "suppress");
  });

  console.log(lines.join("\n"));
  console.log(`\n结果: ${lines.length - failed} 通过 / ${failed} 失败`);
  if (failed) process.exitCode = 1;
}
main();
