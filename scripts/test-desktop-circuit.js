/**
 * 桌面任务熔断离线回归（不联网、不启动应用、不写真实配置）。
 * 运行: npm run test:circuit
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const circuit = require(path.join(ROOT, "src", "desktop-circuit.js"));

const lines = [];
let failed = 0;
async function test(name, fn) {
  try { await fn(); lines.push(`  ✅ ${name}`); }
  catch (e) { failed++; lines.push(`  ❌ ${name} — ${String((e && e.message) || e).slice(0, 220)}`); }
}

const dirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "msr-circuit-"));
  dirs.push(d);
  return d;
}

/** 假 ctx：记录账户级 / 全局级写入，模拟 useGlobal 覆盖行为 */
function fakeCtx(opts = {}) {
  const calls = { account: [], global: [], load: 0 };
  const st = { useGlobal: opts.useGlobal !== false, desktopApp: opts.desktopApp !== false };
  const ctx = {
    id: opts.id || "dev",
    name: "dev",
    calls,
    st,
    config: {
      get: () => ({ useGlobal: st.useGlobal, tasks: { desktopApp: st.desktopApp } }),
      set: (p) => {
        calls.account.push(p);
        if (p && p.tasks && p.tasks.desktopApp === false) st.desktopApp = false;
      },
      load: () => { calls.load++; },
    },
  };
  return ctx;
}

/** 离线注入 disable：不走真实 global-config 文件 */
function optsFor(ctx, extra = {}) {
  return {
    ...extra,
    disable: (c) => circuit.disableSwitch(c, {
      globalConfig: { set: (p) => c.calls.global.push(p) },
    }),
  };
}

const FAIL = { status: "retry", reason: "桌面应用未就绪" };
const DONE = { status: "done", gained: 1, points: 10 };

async function main() {
  console.log("\n=== 桌面任务熔断 · 离线回归测试 ===");

  await test("失效判定：retry / error / 未安装 / 未登录 都算，done / disabled / delayed / 扫描模式不算", async () => {
    for (const r of [
      { status: "retry", reason: "应用未就绪" },
      { status: "error", error: "插件异常" },
      { status: "skip", notInstalled: true, reason: "未安装 Rewards 应用" },
      { status: "skip", notLoggedIn: true, reason: "桌面应用未登录" },
    ]) assert.equal(circuit.isFailure(r), true, JSON.stringify(r));
    for (const r of [
      DONE,
      { status: "done", reason: "今天没有可做的桌面任务" },
      { status: "done", reason: "已点击但未到账（多在 24 小时冷却期）" },
      { status: "skip", disabled: true },
      { status: "skip", delayed: true },
      { status: "skip", reason: "扫描模式" },
    ]) assert.equal(circuit.isFailure(r), false, JSON.stringify(r));
  });

  await test("连续 3 次失败才熔断，前两次只累计不关开关", async () => {
    const d = tmpDir(), ctx = fakeCtx();
    const o = optsFor(ctx, { ledgerDir: d });
    const a = await circuit.record(ctx, FAIL, o);
    const b = await circuit.record(ctx, { status: "error", error: "CDP 接管失败" }, o);
    const c = await circuit.record(ctx, { status: "skip", notInstalled: true, reason: "未安装" }, o);
    assert.equal(a.tripped, false);
    assert.equal(a.remaining, 2);
    assert.equal(b.tripped, false);
    assert.equal(b.remaining, 1);
    assert.equal(c.tripped, true);
    assert.equal(c.consecutive, 3);
    assert.match(c.lastReason, /未安装/);
    assert.equal(ctx.st.desktopApp, false, "开关必须真的关掉");
  });

  await test("useGlobal=true 时账户级 + 全局级双写（只写账户会被全局覆盖，等于没关）", async () => {
    const d = tmpDir(), ctx = fakeCtx({ useGlobal: true });
    const o = optsFor(ctx, { ledgerDir: d, maxFailures: 1 });
    const r = await circuit.record(ctx, FAIL, o);
    assert.equal(r.tripped, true);
    assert.equal(r.useGlobal, true);
    assert.equal(r.accountWritten, true);
    assert.equal(r.globalWritten, true, "遵循全局时漏写全局 = 下一轮开关又变回 true");
    assert.equal(ctx.calls.account.length, 1);
    assert.equal(ctx.calls.global.length, 1);
    assert.equal(ctx.calls.load > 0, true, "必须刷新有效配置缓存");
  });

  await test("useGlobal=false 时只写账户级，不动全局配置", async () => {
    const d = tmpDir(), ctx = fakeCtx({ useGlobal: false });
    const o = optsFor(ctx, { ledgerDir: d, maxFailures: 1 });
    const r = await circuit.record(ctx, FAIL, o);
    assert.equal(r.tripped, true);
    assert.equal(r.globalWritten, false);
    assert.equal(ctx.calls.global.length, 0);
  });

  await test("跑通一次立刻清零（2 次失败 → done → 2 次失败也不熔断）", async () => {
    const d = tmpDir(), ctx = fakeCtx();
    const o = optsFor(ctx, { ledgerDir: d });
    await circuit.record(ctx, FAIL, o);
    await circuit.record(ctx, FAIL, o);
    const reset = await circuit.record(ctx, DONE, o);
    assert.equal(reset.reset, true);
    assert.equal(reset.consecutive, 0);
    const a = await circuit.record(ctx, FAIL, o);
    const b = await circuit.record(ctx, FAIL, o);
    assert.equal(a.consecutive, 1);
    assert.equal(b.consecutive, 2);
    assert.equal(b.tripped, false);
  });

  await test("disabled / delayed / 扫描模式不动账本（没执行就不算失效）", async () => {
    const d = tmpDir(), ctx = fakeCtx();
    const o = optsFor(ctx, { ledgerDir: d });
    await circuit.record(ctx, FAIL, o);
    await circuit.record(ctx, FAIL, o);
    for (const r of [
      { status: "skip", disabled: true },
      { status: "skip", delayed: true },
      { status: "skip", reason: "扫描模式" },
    ]) {
      const v = await circuit.record(ctx, r, o);
      assert.equal(v.skipped, true);
    }
    const last = await circuit.record(ctx, FAIL, o);
    assert.equal(last.consecutive, 3, "不该被未执行的轮次稀释或放大");
  });

  await test("熔断后用户手动重开 → 重新武装，再给完整 3 次机会", async () => {
    const d = tmpDir(), ctx = fakeCtx();
    const o = optsFor(ctx, { ledgerDir: d });
    await circuit.record(ctx, FAIL, o);
    await circuit.record(ctx, FAIL, o);
    assert.equal((await circuit.record(ctx, FAIL, o)).tripped, true);
    // 用户到设置页把开关重新打开
    ctx.st.desktopApp = true;
    const rearm = await circuit.record(ctx, { status: "done", reason: "今天没有可做的桌面任务" }, o);
    assert.equal(rearm.rearmed, true);
    assert.equal(rearm.consecutive, 0);
    assert.equal((await circuit.record(ctx, FAIL, o)).tripped, false);
    assert.equal((await circuit.record(ctx, FAIL, o)).tripped, false);
    assert.equal((await circuit.record(ctx, FAIL, o)).tripped, true);
  });

  await test("已熔断且开关仍关着时不重复推送（already=true）", async () => {
    const d = tmpDir(), ctx = fakeCtx();
    const o = optsFor(ctx, { ledgerDir: d, maxFailures: 1 });
    await circuit.record(ctx, FAIL, o);
    // 开关仍关着，再来一次失败：只回 already，不重复关配置 / 不重复推送
    const again = await circuit.record(ctx, FAIL, o);
    assert.equal(again.tripped, true);
    assert.equal(again.already, true);
    assert.equal(ctx.calls.account.length, 1, "不该重复写配置");
    const ledger = circuit.readLedger(ctx.id, { ledgerDir: d });
    assert.equal(ledger.tripped, true);
  });

  await test("账本损坏 fail-safe：当空账本，绝不误关开关", async () => {
    const d = tmpDir(), ctx = fakeCtx();
    const file = circuit.ledgerPath(ctx.id, d);
    fs.writeFileSync(file, "{ broken json");
    const l = circuit.readLedger(ctx.id, { ledgerDir: d });
    assert.equal(l.consecutive, 0);
    assert.equal(l.tripped, false);
    const r = await circuit.record(ctx, FAIL, optsFor(ctx, { ledgerDir: d }));
    assert.equal(r.tripped, false);
    assert.equal(ctx.calls.account.length, 0);
  });

  await test("账本按账号隔离：A 失败 2 次不影响 B", async () => {
    const d = tmpDir();
    const a = fakeCtx({ id: "A" }), b = fakeCtx({ id: "B" });
    await circuit.record(a, FAIL, optsFor(a, { ledgerDir: d }));
    await circuit.record(a, FAIL, optsFor(a, { ledgerDir: d }));
    const rb = await circuit.record(b, FAIL, optsFor(b, { ledgerDir: d }));
    assert.equal(rb.consecutive, 1);
    assert.notEqual(circuit.accountKey("A"), circuit.accountKey("B"));
  });

  await test("阈值可注入（maxFailures=2 时两次即熔断）", async () => {
    const d = tmpDir(), ctx = fakeCtx();
    const o = optsFor(ctx, { ledgerDir: d, maxFailures: 2 });
    assert.equal((await circuit.record(ctx, FAIL, o)).tripped, false);
    assert.equal((await circuit.record(ctx, FAIL, o)).tripped, true);
  });

  await test("接线：runner 每轮记录结果，熔断时推送说明", async () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "runner.js"), "utf8");
    assert.match(src, /desktopCircuit\.record\(ctx, rDesktopApp, circuitOpts\)/);
    assert.match(src, /desktopRuntime\.circuitOptions\(/);
    assert.match(src, /桌面专属任务已自动停用/);
    assert.match(src, /cb\.tripped && !cb\.already/);
  });

  console.log(lines.join("\n"));
  console.log(`\n结果: ${lines.length - failed} 通过 / ${failed} 失败`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((e) => { console.error("[测试异常]", e); process.exitCode = 1; })
  .finally(() => {
    for (const d of dirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
    }
  });
