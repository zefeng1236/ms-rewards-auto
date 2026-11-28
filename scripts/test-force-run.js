/**
 * 「立即完成」force 链路离线回归（2026-11-27）。
 *
 * 背景：真机点「立即完成」后只读了 3 篇、只搜了 6 次，日志里没有
 * 「已进入一次性完成模式」。根因是 runBatch 调 runAccountGuarded 时只传
 * interactive，把 force 丢了；同时 taskSearch 的 force 分支只跑 randInt(6,9)，
 * 且用户设定 limits.search 优先于 force —— 即使 force 贯通也一轮做不完。
 *
 * 本测试全程离线：只读源码与纯函数，不碰网络 / 账号 / 磁盘写入。
 * ① 真实源码必须满足全部守卫；
 * ② 把源码注入成旧写法后，守卫必须变红（反例验证，防止守卫写成恒真）。
 * 用法: npm run test:force-run
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const dailyQuota = require(path.join(ROOT, "src", "daily-quota.js"));
const { resolveTaskCount } = require(path.join(ROOT, "src", "task-limit.js"));

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const runnerSrc = read("src/runner.js");
const tasksSrc = read("src/tasks.js");
const coreSrc = read("src/app-core.js");
const preloadSrc = read("src/electron-preload.js");
const mainSrc = read("src/electron-main.js");
const selfcheckSrc = read("scripts/selfcheck.js");

/** 与 selfcheck 里的守卫同形，改守卫时两边要一起改（下方有漂移检测） */
const guards = {
  batchForwardsForce: (s) => /runAccountGuarded\(ctx, \{[\s\S]{0,180}?force: opts\.force === true,/.test(s),
  forceUsesRemaining: (s) =>
    /if \(ctx\.force\) \{[\s\S]{0,120}?limit = remainingUnits;/.test(s) &&
    /const remainingUnits = Math\.max\(0, pcQuota\.unitsRequired\) \+ Math\.max\(0, mQuota\.unitsRequired\);/.test(s),
  forceBeforeUserLimit: (s) => s.indexOf("if (ctx.force)") < s.indexOf("} else if (setBase > 0)"),
  chainCarriesForce: (preload, main, core) =>
    /run: \(id, opts\) => ipcRenderer\.invoke\("account:run", id, opts\)/.test(preload) &&
    /ipcMain\.handle\("account:run", async \(_e, id, opts\)/.test(main) &&
    /runIds\(\[id\], true, opts \|\| \{\}\)/.test(main) &&
    /force: opts\.force === true/.test(core),
};

const lines = [];
let failed = 0;
async function test(name, fn) {
  try { await fn(); lines.push(`  ✅ ${name}`); }
  catch (e) { failed++; lines.push(`  ❌ ${name} — ${String((e && e.message) || e).slice(0, 220)}`); }
}

async function main() {
  await test("① 真实源码：runBatch 把 force 传给 runAccountGuarded", async () => {
    assert.equal(guards.batchForwardsForce(runnerSrc), true);
  });
  await test("② 真实源码：force 轮按服务器剩余次数，且优先于用户设定", async () => {
    assert.equal(guards.forceUsesRemaining(tasksSrc), true);
    assert.equal(guards.forceBeforeUserLimit(tasksSrc), true);
  });
  await test("③ 真实源码：preload → IPC → runIds → runBatch 全链路带 force", async () => {
    assert.equal(guards.chainCarriesForce(preloadSrc, mainSrc, coreSrc), true);
  });
  await test("④ selfcheck 里四条守卫都在（防止测试与门禁漂移）", async () => {
    assert.ok(selfcheckSrc.includes("runBatch 把 force 传给 runAccountGuarded"));
    assert.ok(selfcheckSrc.includes("立即完成链路：preload → IPC → runIds → runBatch 全程带 force"));
    assert.ok(selfcheckSrc.includes("taskSearch force 轮按服务器剩余次数一轮完成"));
    assert.ok(selfcheckSrc.includes("force 轮按服务器剩余次数做完"));
  });

  // —— 反例注入：把源码还原成 2026-11-27 之前的旧写法，守卫必须变红 ——
  await test("⑤ 反例：runBatch 只传 interactive（旧断链）→ 守卫变红", async () => {
    const old = runnerSrc.replace(
      /const r = await runAccountGuarded\(ctx, \{\s*interactive: opts\.interactive,\s*force: opts\.force === true,\s*\}\);/,
      "const r = await runAccountGuarded(ctx, { interactive: opts.interactive });"
    );
    assert.notEqual(old, runnerSrc, "注入失败：没找到 runBatch 调用点");
    assert.equal(guards.batchForwardsForce(old), false);
  });
  await test("⑥ 反例：force 退回 randInt(6,9) 且用户设定优先 → 守卫变红", async () => {
    const old = tasksSrc.replace(
      /if \(ctx\.force\) \{[\s\S]{0,120}?\} else if \(setBase > 0\) \{/,
      "if (setBase > 0) {\n    limit = setBase;\n  } else if (ctx.force) {\n    limit = randInt(6, 9);\n  } else {"
    );
    assert.notEqual(old, tasksSrc, "注入失败：没找到 force 分支");
    assert.equal(guards.forceUsesRemaining(old), false);
    assert.equal(guards.forceBeforeUserLimit(old), false);
  });
  await test("⑦ 反例：runIds 恒传 force=false → 链路守卫变红", async () => {
    const old = coreSrc.replace("force: opts.force === true", "force: false");
    assert.notEqual(old, coreSrc, "注入失败：没找到 runIds 的 force 传参");
    assert.equal(guards.chainCarriesForce(preloadSrc, mainSrc, old), false);
  });
  await test("⑧ 反例：preload 丢掉 opts → 链路守卫变红", async () => {
    const old = preloadSrc.replace(
      'run: (id, opts) => ipcRenderer.invoke("account:run", id, opts)',
      'run: (id) => ipcRenderer.invoke("account:run", id)'
    );
    assert.notEqual(old, preloadSrc, "注入失败：没找到 preload 的 run");
    assert.equal(guards.chainCarriesForce(old, mainSrc, coreSrc), false);
  });

  // —— 纯函数：force 一轮做完的算术，对照普通轮的分批 ——
  const quotaOf = (pc, m) => ({
    pc: dailyQuota.normalizeCounter(pc, { fallbackMax: 0, pointsPerUnit: dailyQuota.POINTS_PER_SEARCH }),
    m: dailyQuota.normalizeCounter(m, { fallbackMax: 0, pointsPerUnit: dailyQuota.POINTS_PER_SEARCH }),
  });
  const forceCount = (q) => {
    const want = Math.max(0, q.pc.unitsRequired) + Math.max(0, q.m.unitsRequired);
    return dailyQuota.planSearchUnits(q.pc, q.m, want).count;
  };

  await test("⑨ 真机 23:01 状态 42/60：force 一轮补 6 次，普通轮只补 6 次中的设定值", async () => {
    const q = quotaOf({ progress: 42, max: 60 }, { progress: 0, max: 0 });
    assert.equal(q.pc.unitsRequired, 6);
    assert.equal(forceCount(q), 6);
    assert.equal(dailyQuota.planSearchUnits(q.pc, q.m, 6).count, 6);
  });
  await test("⑩ 当天 0/60：force 一轮 20 次，旧的 randInt(6,9) 必然做不完", async () => {
    const q = quotaOf({ progress: 0, max: 60 }, { progress: 0, max: 0 });
    assert.equal(forceCount(q), 20);
    assert.ok(forceCount(q) > 9);
  });
  await test("⑪ 服务器明确 0（月度封顶）：force 也不白搜", async () => {
    const q = quotaOf({ progress: 0, max: 0 }, { progress: 0, max: 0 });
    assert.equal(forceCount(q), 0);
    assert.equal(dailyQuota.isQuotaExhausted([q.pc, q.m]), true);
  });
  await test("⑫ 阅读 21/30 分：force 一轮读完剩余 3 篇，普通轮按设定值分批", async () => {
    const r = dailyQuota.normalizeReadQuota({ max: 30, progress: 21 });
    assert.equal(r.articlesLeft, 3);
    assert.equal(resolveTaskCount({ base: 0, total: r.articlesLeft, random: false }).count, 3);
    assert.equal(resolveTaskCount({ base: 6, total: r.articlesLeft, random: false }).count, 3);
    assert.equal(resolveTaskCount({ base: 2, total: r.articlesLeft, random: false }).count, 2);
  });

  console.log(lines.join("\n"));
  console.log(`\nforce-run: ${lines.length - failed}/${lines.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
