/**
 * 每日任务额度动态归一化离线回归（2026-11-24）。
 * 全程离线：不碰网络 / 账号 / 磁盘。
 * 用法: npm run test:daily-quota
 */
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const Q = require(path.join(ROOT, "src", "daily-quota.js"));

const lines = [];
let failed = 0;
async function test(name, fn) {
  try { await fn(); lines.push(`  ✅ ${name}`); }
  catch (e) { failed++; lines.push(`  ❌ ${name} — ${String((e && e.message) || e).slice(0, 220)}`); }
}

async function main() {
  await test("① 常量锁死：搜索/阅读每次 3 分，兜底 15 / 30", async () => {
    assert.equal(Q.POINTS_PER_SEARCH, 3);
    assert.equal(Q.POINTS_PER_ARTICLE, 3);
    assert.equal(Q.FALLBACK_SEARCH_MAX, 15);
    assert.equal(Q.FALLBACK_READ_MAX, 30);
  });

  await test("② normalizeCounter：正常额度换算成次数", async () => {
    const a = Q.normalizeCounter({ max: 60, progress: 0 }, { fallbackMax: 15, pointsPerUnit: 3 });
    assert.equal(a.max, 60);
    assert.equal(a.unitsRequired, 20);
    assert.equal(a.explicit, true);
    assert.equal(a.source, "server");
    // 真机 11-24 18:50 日志：PC 39/60 → 21 分 → 还需 7 次
    const b = Q.normalizeCounter({ max: 60, progress: 39 }, { fallbackMax: 15, pointsPerUnit: 3 });
    assert.equal(b.remainingPoints, 21);
    assert.equal(b.unitsRequired, 7);
  });

  await test("③ 关键区分：服务器明确 0 ≠ 字段缺失", async () => {
    const zero = Q.normalizeCounter({ max: 0, progress: 0 }, { fallbackMax: 15, pointsPerUnit: 3 });
    assert.equal(zero.max, 0, "明确 0 不能被兜底成 15");
    assert.equal(zero.capped, true);
    assert.equal(zero.unitsRequired, 0);
    assert.equal(zero.source, "server");
    const missing = Q.normalizeCounter({}, { fallbackMax: 15, pointsPerUnit: 3 });
    assert.equal(missing.max, 15, "字段缺失才允许兜底");
    assert.equal(missing.explicit, false);
    assert.equal(missing.capped, false);
    assert.equal(missing.source, "fallback");
    // normProgress 明确标注 explicitMax:false 时（emptyInfo），优先信它
    const forced = Q.normalizeCounter({ max: 0, progress: 0, explicitMax: false }, { fallbackMax: 15, pointsPerUnit: 3 });
    assert.equal(forced.max, 15);
    assert.equal(forced.capped, false);
  });

  await test("④ 月度计划拿满：额度被压到 1/1 或 originalMax 更小", async () => {
    const one = Q.normalizeCounter({ max: 1, progress: 1 }, { fallbackMax: 15, pointsPerUnit: 3 });
    assert.equal(one.max, 1);
    assert.equal(one.unitsRequired, 0, "1/1 已完成，不该再搜");
    assert.equal(one.capped, false);
    const compressed = Q.normalizeCounter(
      { max: 1, progress: 0, originalMax: 60 },
      { fallbackMax: 15, pointsPerUnit: 3 }
    );
    assert.equal(compressed.compressed, true, "originalMax=60 但今天只有 1 分 → 标记压缩");
    assert.equal(compressed.unitsRequired, 1);
  });

  await test("⑤ 脏数据：progress 越界、负数、字符串、NaN 都不炸", async () => {
    const a = Q.normalizeCounter({ max: 30, progress: 999 }, { fallbackMax: 15, pointsPerUnit: 3 });
    assert.equal(a.progress, 30);
    assert.equal(a.unitsRequired, 0);
    const b = Q.normalizeCounter({ max: -5, progress: -8 }, { fallbackMax: 15, pointsPerUnit: 3 });
    assert.equal(b.max, 0);
    assert.equal(b.progress, 0);
    const c = Q.normalizeCounter({ max: "30", progress: "12" }, { fallbackMax: 15, pointsPerUnit: 3 });
    assert.equal(c.unitsRequired, 6);
    assert.equal(Q.normalizeCounter(null, { fallbackMax: 15, pointsPerUnit: 3 }).source, "fallback");
  });

  await test("⑥ normalizeReadQuota：篇数由服务器 max 换算，0 就 0 篇", async () => {
    const normal = Q.normalizeReadQuota({ max: 30, progress: 0 });
    assert.equal(normal.articlesTotal, 10);
    assert.equal(normal.articlesLeft, 10);
    const partial = Q.normalizeReadQuota({ max: 30, progress: 21 });
    assert.equal(partial.articlesDone, 7);
    assert.equal(partial.articlesLeft, 3);
    const capped = Q.normalizeReadQuota({ max: 0, progress: 0 });
    assert.equal(capped.capped, true);
    assert.equal(capped.articlesTotal, 0, "不能再 `|| 30` 写死成 10 篇");
    assert.equal(capped.articlesLeft, 0);
    const small = Q.normalizeReadQuota({ max: 3, progress: 0, originalMax: 30 });
    assert.equal(small.articlesTotal, 1);
    assert.equal(small.compressed, true);
    assert.equal(Q.normalizeReadQuota({}).source, "fallback");
  });

  await test("⑦ summarizeCounters：借鉴 MRS助手，数组逐项累加缺口", async () => {
    const arr = [
      { pointProgressMax: 30, pointProgress: 12 },
      { pointProgressMax: 30, pointProgress: 30 },
      { pointProgressMax: 15, pointProgress: 0 },
    ];
    const q = Q.summarizeCounters(arr, { pointsPerUnit: 3 });
    assert.equal(q.max, 75);
    assert.equal(q.earned, 42);
    assert.equal(q.remaining, 33);
    assert.equal(q.unitsRequired, 11);
    assert.equal(q.hasCounters, true);
    assert.equal(Q.summarizeCounters([]).hasCounters, false);
    assert.equal(Q.summarizeCounters([{ pointProgressMax: 10, pointProgress: 99 }]).earned, 10);
  });

  await test("⑧ planSearchUnits：本轮次数以服务器剩余为硬上界", async () => {
    const pc = Q.normalizeCounter({ max: 60, progress: 57 }, { fallbackMax: 0, pointsPerUnit: 3 });
    const m = Q.normalizeCounter({ max: 0, progress: 0, explicitMax: false }, { fallbackMax: 0, pointsPerUnit: 3 });
    // 真机日志曾出现「本轮计划 6 次（剩余 3 次）」→ 应被截成 1 次
    const a = Q.planSearchUnits(pc, m, 6);
    assert.equal(a.remaining, 1);
    assert.equal(a.count, 1);
    assert.equal(a.truncated, true);
    assert.equal(Q.planSearchUnits(pc, m, 0).count, 0);
    const fresh = Q.normalizeCounter({ max: 60, progress: 0 }, { fallbackMax: 0, pointsPerUnit: 3 });
    assert.equal(Q.planSearchUnits(fresh, m, 6).count, 6);
    const mobile = Q.normalizeCounter({ max: 30, progress: 0 }, { fallbackMax: 0, pointsPerUnit: 3 });
    assert.equal(Q.planSearchUnits(pc, mobile, 30).remaining, 11);
  });

  await test("⑨ 回归：旧代码三处写死回去的行为都不再出现", async () => {
    const zero = Q.normalizeReadQuota({ max: 0, progress: 0 });
    assert.equal(zero.articlesTotal, 0, "① 不能再 max||30");
    const done = Q.normalizeReadQuota({ max: 30, progress: 30 });
    assert.equal(done.articlesLeft, 0, "② 进度已满不能再强制 cur=0/max=30 重跑 10 篇");
    const missing = Q.normalizeCounter({ max: 0, progress: 0 }, { fallbackMax: 15, pointsPerUnit: 3 });
    assert.equal(missing.max, 0, "③ 明确 0 不能再回落 15");
  });

  console.log(lines.join("\n"));
  console.log(`\n结果: ${lines.length - failed} 通过 / ${failed} 失败`);
  if (failed) process.exitCode = 1;
}
main();
