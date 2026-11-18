/**
 * 账号安全闸门离线回归（不联网、不登录账号、不写账户）。
 * 运行: npm run test:safety
 *
 * 覆盖：数据源校验、风控警告、单轮上限、按账号冷却、账本损坏 fail-closed、
 * 开关型动作默认禁写、写前落账、拟人间隔，以及产品代码的接线不被拆掉。
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const safety = require(path.join(ROOT, "src", "account-safety.js"));

const lines = [];
let failed = 0;
async function test(name, fn) {
  try { await fn(); lines.push(`  ✅ ${name}`); }
  catch (e) { failed++; lines.push(`  ❌ ${name} — ${String((e && e.message) || e).slice(0, 220)}`); }
}

const tmpDirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "msr-safety-"));
  tmpDirs.push(d);
  return d;
}
const T0 = new Date(2026, 10, 17, 10, 0, 0).getTime();
const item = (offerId, kind = "punchCard") => ({ offerId, kind, actionName: "reportActivity" });
const dash = (patch = {}) => ({ source: "getuserinfo", warnings: [], botScore: 0.09, ...patch });

async function main() {
  console.log("\n=== 账号安全闸门 · 离线回归测试 ===");

  await test("账号哈希稳定且不同账号互不影响", async () => {
    assert.equal(safety.accountKey("dev"), safety.accountKey("dev"));
    assert.notEqual(safety.accountKey("dev"), safety.accountKey("other"));
    assert.match(safety.accountKey("dev"), /^[a-f0-9]{12}$/);
  });

  await test("① flyout 兜底源（信息不足）一律拒写", async () => {
    const r = safety.checkRisk({ source: "flyout", warnings: [], botScore: null });
    assert.equal(r.allow, false);
    assert.match(r.reason, /getuserinfo/);
  });

  await test("② 明确风控警告拒写；高分值只记录不拦截（量纲不明，避免误伤）", async () => {
    const hit = safety.checkRisk(dash({ warnings: ["Fraud_UserWarning_BotScore_UX"] }));
    assert.equal(hit.allow, false);
    assert.match(hit.reason, /风控警告/);
    const high = safety.checkRisk(dash({ botScore: 17 }));
    assert.equal(high.allow, true);
    assert.equal(high.botScore, 17);
  });

  await test("③ 单轮默认只准写 1 个；allowBulk 最多 3，且不突破硬上限", async () => {
    const many = ["A", "B", "C", "D", "E"].map((x) => item(x));
    const d = tmpDir();
    const one = safety.planWrites(many, dash(), { accountId: "dev", ledgerDir: d, nowMs: T0 });
    assert.equal(one.allowed.length, 1);
    assert.equal(one.skipped.length, 4);
    assert.equal(safety.planWrites(many, dash(), { accountId: "dev", ledgerDir: d, nowMs: T0, maxWrites: 99, allowBulk: true }).allowed.length, 3);
    assert.equal(safety.HARD_MAX_WRITES, 3);
  });

  await test("④ 冷却：同一 offerId 写后 20 小时内不再写；跨天自动失效", async () => {
    const d = tmpDir();
    const ledger = safety.readLedger("dev", { ledgerDir: d, nowMs: T0 });
    assert.equal(safety.isCoolingDown(ledger, "A", T0), false);
    safety.markWrite(ledger, "A", T0);
    assert.equal(safety.isCoolingDown(ledger, "A", T0 + 3600 * 1000), true);
    assert.equal(safety.isCoolingDown(ledger, "A", T0 + 21 * 3600 * 1000), false);
    const nextDay = safety.readLedger("dev", { ledgerDir: d, nowMs: T0 + 24 * 3600 * 1000 });
    assert.deepEqual(nextDay.entries, {});
  });

  await test("④-b 账本损坏时 fail-closed（宁可不写，也不在状态未知时重发）", async () => {
    const d = tmpDir();
    const ledger = safety.readLedger("dev", { ledgerDir: d, nowMs: T0 });
    fs.writeFileSync(ledger.file, "{ broken json");
    const broken = safety.readLedger("dev", { ledgerDir: d, nowMs: T0 });
    assert.equal(broken.ok, false);
    const plan = safety.planWrites([item("A")], dash(), { accountId: "dev", ledgerDir: d, nowMs: T0 });
    assert.equal(plan.allowed.length, 0);
    assert.match(plan.reason, /账本/);
  });

  await test("④-c 账号级间隔：换个活动也不能在 10 分钟内连发第二个 POST", async () => {
    const d = tmpDir();
    const first = safety.planWrites([item("A")], dash(), { accountId: "dev", ledgerDir: d, nowMs: T0 });
    assert.equal(first.allowed.length, 1);
    safety.markWrite(first.ledger, "A", T0);
    const second = safety.planWrites([item("B")], dash(), { accountId: "dev", ledgerDir: d, nowMs: T0 + 60000 });
    assert.equal(second.allowed.length, 0);
    assert.match(second.reason, /账号级写入冷却/);
    const later = safety.planWrites([item("B")], dash(), { accountId: "dev", ledgerDir: d, nowMs: T0 + 11 * 60 * 1000 });
    assert.equal(later.allowed.length, 1);
  });

  await test("⑤ 开关型动作（连胜保护 toggle）默认不自动写，且不占写入名额", async () => {
    const d = tmpDir();
    const plan = safety.planWrites([item("SP", "streakProtection"), item("A")], dash(), { accountId: "dev", ledgerDir: d, nowMs: T0 });
    assert.deepEqual(plan.allowed.map((x) => x.offerId), ["A"]);
    assert.ok(plan.skipped.some((s) => /开关型/.test(s.reason)));
    const forced = safety.planWrites([item("SP", "streakProtection")], dash(), { accountId: "dev", ledgerDir: d, nowMs: T0, allowToggleWrite: true });
    assert.equal(forced.allowed.length, 1);
  });

  await test("冷却按账号隔离：A 账号写过不影响 B 账号同一活动", async () => {
    const d = tmpDir();
    const la = safety.readLedger("A", { ledgerDir: d, nowMs: T0 });
    safety.markWrite(la, "X", T0);
    const planB = safety.planWrites([item("X")], dash(), { accountId: "B", ledgerDir: d, nowMs: T0 });
    assert.equal(planB.allowed.length, 1);
  });

  await test("⑥ 拟人间隔默认 3~8 秒；gapMs=0 供离线测试跳过", async () => {
    assert.equal(safety.nextGapMs({ gapMs: 0 }), 0);
    for (let i = 0; i < 20; i++) {
      const g = safety.nextGapMs();
      assert.ok(g >= 3000 && g < 8000, `间隔越界: ${g}`);
    }
    const t = Date.now();
    await safety.pace({ gapMs: 0 });
    assert.ok(Date.now() - t < 200);
  });

  await test("接线：runActivities 写前落账、只遍历 plan.allowed、两次写之间 pace", async () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "rewards-activities.js"), "utf8");
    assert.match(src, /safety\.planWrites\(report\.pending, before/);
    assert.match(src, /plan\.allowed\.length/);
    assert.match(src, /safety\.markWrite\(plan\.ledger/);
    assert.match(src, /safety\.auditWrite\(ctx\.id/);
    assert.match(src, /safety\.pace\(opts\)/);
    // 写前落账必须排在 reportServerAction 之前（失败也不重发）
    assert.ok(src.indexOf("safety.markWrite(plan.ledger") < src.indexOf("next.reportServerAction(ctx"));
  });

  await test("接线：真实写操作强制走浏览器通道，且先 GET earn 建立会话", async () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "rewards-next.js"), "utf8");
    assert.match(src, /await browserRequest\(ctx, \{ \.\.\.requestOpts, warmupUrl:/);
    assert.match(src, /page\.request\.post\(/);
    assert.match(src, /if \(isPost && o\.warmupUrl\)/);
    assert.match(src, /const r = injected\s*\n\s*\? await injected\(requestOpts\)/);
  });

  await test("接线：runner 默认仍只读，写操作必须显式开启", async () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "runner.js"), "utf8");
    assert.match(src, /dryRun: opts\.runNextActivities !== true/);
  });

  console.log(lines.join("\n"));
  console.log(`\n结果: ${lines.length - failed} 通过 / ${failed} 失败`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((e) => { console.error("[测试异常]", e); process.exitCode = 1; })
  .finally(() => {
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
    }
  });
