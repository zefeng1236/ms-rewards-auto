/**
 * 远程规则接线回归（方案 A：参数远程化，代码留本体）
 *
 * 目标不是「规则文件里有这个字段」，而是「改了这个值，行为真的跟着变」。
 * 项目里踩过「代码写 20、规则写 1，守卫只 grep 代码常量全绿」的假绿
 * （2026-11-07），所以这里逐字段断言生效值，并验证越界值被钳制。
 *
 * 全程离线：不联网、不启动应用、不碰任何账号。
 * 用法: npm run test:rules
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const runtime = require(path.join(ROOT, "src", "desktop-runtime.js"));
const pluginRules = require(path.join(ROOT, "src", "plugin-rules.js"));
const circuit = require(path.join(ROOT, "src", "desktop-circuit.js"));

const builtin = JSON.parse(
  fs.readFileSync(path.join(ROOT, "plugins", "desktop-app-tasks", "rules.json"), "utf8")
);
const remote = JSON.parse(
  fs.readFileSync(path.join(ROOT, "rules", "desktop-app-tasks.json"), "utf8")
);
const deskSrc = fs.readFileSync(path.join(ROOT, "src", "desktop-app.js"), "utf8");
const runnerSrc = fs.readFileSync(path.join(ROOT, "src", "runner.js"), "utf8");

const lines = [];
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    lines.push(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    lines.push(`  ❌ ${name} — ${String((e && e.message) || e).slice(0, 240)}`);
  }
}

const rulesWith = (patch) => ({
  ...builtin,
  runtime: { ...builtin.runtime, ...(patch.runtime || {}) },
  quest: { ...builtin.quest, ...(patch.quest || {}) },
  card: { ...builtin.card, ...(patch.card || {}) },
  landing: { ...builtin.landing, ...(patch.landing || {}) },
});

async function main() {
  await test("① 无规则时回落内置默认（不会 undefined 导致 0ms 空转）", async () => {
    const r = runtime.effectiveRuntime(null);
    assert.equal(r.renderWaitMs, runtime.DEFAULTS.renderWaitMs);
    assert.equal(r.startTimeoutMs, runtime.DEFAULTS.startTimeoutMs);
    assert.equal(r.cardMaxWaitMs, runtime.DEFAULTS.cardMaxWaitMs);
    assert.equal(r.dwellRounds, runtime.DEFAULTS.dwellRounds);
    assert.equal(r.circuitMaxFailures, 3);
  });

  await test("② 远程值能改行为：7 个参数逐字段生效", async () => {
    const r = runtime.effectiveRuntime(
      rulesWith({
        runtime: { renderWaitMs: 21000, startTimeoutMs: 45000, restartMaxTimes: 2, circuitMaxFailures: 5 },
        quest: { minRenderChars: 420 },
        card: { maxWaitMs: 60000 },
        landing: { dwellMs: 1200, dwellRounds: 5 },
      })
    );
    assert.equal(r.renderWaitMs, 21000);
    assert.equal(r.startTimeoutMs, 45000);
    assert.equal(r.restartMaxTimes, 2);
    assert.equal(r.circuitMaxFailures, 5);
    assert.equal(r.minRenderChars, 420);
    assert.equal(r.cardMaxWaitMs, 60000);
    assert.equal(r.dwellMs, 1200);
    assert.equal(r.dwellRounds, 5);
  });

  await test("③ 越界/非法值一律钳制回默认（远程规则被投毒也不能搞坏流程）", async () => {
    const r = runtime.effectiveRuntime(
      rulesWith({
        runtime: { renderWaitMs: 0, startTimeoutMs: 99999999, circuitMaxFailures: 999 },
        quest: { minRenderChars: -1 },
        card: { maxWaitMs: "abc" },
        landing: { dwellMs: 999999, dwellRounds: 100 },
      })
    );
    assert.equal(r.renderWaitMs, runtime.DEFAULTS.renderWaitMs);
    assert.equal(r.startTimeoutMs, runtime.DEFAULTS.startTimeoutMs);
    assert.equal(r.circuitMaxFailures, runtime.DEFAULTS.circuitMaxFailures);
    assert.equal(r.minRenderChars, runtime.DEFAULTS.minRenderChars);
    assert.equal(r.cardMaxWaitMs, runtime.DEFAULTS.cardMaxWaitMs);
    assert.equal(r.dwellMs, runtime.DEFAULTS.dwellMs);
    assert.equal(r.dwellRounds, runtime.DEFAULTS.dwellRounds);
  });

  await test("④ circuitOptions 与 effectiveRuntime 同源", async () => {
    const o = runtime.circuitOptions(rulesWith({ runtime: { circuitMaxFailures: 4, circuitCountEnvFailures: false } }));
    assert.deepEqual(o, { maxFailures: 4, countEnvFailures: false });
    assert.deepEqual(runtime.circuitOptions(null), { maxFailures: 3, countEnvFailures: true });
  });

  await test("⑤ validate 接受 v2 内置/远程规则", async () => {
    assert.equal(pluginRules.validate(builtin).ok, true);
    assert.equal(pluginRules.validate(remote).ok, true);
  });

  await test("⑥ validate 拒绝越界阈值 / 非布尔（远程坏规则整体拒收）", async () => {
    const bad1 = rulesWith({ runtime: { circuitMaxFailures: 999 } });
    const bad2 = rulesWith({ runtime: { startTimeoutMs: 1 } });
    const bad3 = rulesWith({ runtime: { circuitCountEnvFailures: "false" } });
    assert.equal(pluginRules.validate(bad1).ok, false);
    assert.equal(pluginRules.validate(bad2).ok, false);
    assert.equal(pluginRules.validate(bad3).ok, false);
  });

  await test("⑦ mergeKnown 能覆盖 v2 新字段，且丢弃未知键", async () => {
    const merged = pluginRules.mergeKnown(builtin, {
      version: 9,
      runtime: { circuitMaxFailures: 6, injectedKey: "should-be-dropped" },
    });
    assert.equal(merged.runtime.circuitMaxFailures, 6);
    assert.equal("injectedKey" in merged.runtime, false);
    assert.equal(merged.version, 9);
  });

  await test("⑧ 内置与远程规则 v2 字段齐全且一致（防只改一处被白名单丢弃）", async () => {
    assert.equal(remote.version, builtin.version);
    for (const k of ["circuitMaxFailures", "circuitCountEnvFailures", "startTimeoutMs", "maxItemsPerRun"]) {
      assert.equal(
        JSON.stringify(remote.runtime[k]),
        JSON.stringify(builtin.runtime[k]),
        `runtime.${k} 两份规则不一致`
      );
    }
    for (const k of ["minRenderChars"]) assert.equal(remote.quest[k], builtin.quest[k]);
    for (const k of ["maxWaitMs"]) assert.equal(remote.card[k], builtin.card[k]);
    for (const k of ["dwellMs", "dwellRounds"]) assert.equal(remote.landing[k], builtin.landing[k]);
  });

  await test("⑨ 熔断阈值真的来自规则（1 次即熔断）", async () => {
    const fs2 = require("node:fs");
    const os = require("node:os");
    const d = fs2.mkdtempSync(path.join(os.tmpdir(), "msr-rules-circuit-"));
    try {
      const ctx = { id: "rule-test", config: { get: () => ({ tasks: { desktopApp: true } }), set() {}, load() {} } };
      const o = { ledgerDir: d, nowMs: 1760000000000, ...runtime.circuitOptions(rulesWith({ runtime: { circuitMaxFailures: 1 } })), disable: () => ({ ok: true }) };
      const r = circuit.record(ctx, { status: "retry", reason: "应用未就绪" }, o);
      assert.equal(r.tripped, true);
      assert.equal(r.consecutive, 1);
    } finally {
      fs2.rmSync(d, { recursive: true, force: true });
    }
  });

  await test("⑩ 熔断阈值上限钳制：远程 999 不等于永不熔断", async () => {
    const fs2 = require("node:fs");
    const os = require("node:os");
    const d = fs2.mkdtempSync(path.join(os.tmpdir(), "msr-rules-clamp-"));
    try {
      const ctx = { id: "clamp-test", config: { get: () => ({ tasks: { desktopApp: true } }), set() {}, load() {} } };
      const o = { ledgerDir: d, nowMs: 1760000000000, maxFailures: 999, disable: () => ({ ok: true }) };
      let last;
      for (let i = 0; i < 10; i++) last = circuit.record(ctx, { status: "retry", reason: "应用未就绪" }, o);
      assert.equal(last.tripped, true, "999 应被钳到 10，第 10 次必须熔断");
    } finally {
      fs2.rmSync(d, { recursive: true, force: true });
    }
  });

  await test("⑪ countEnvFailures=false 时未安装/未登录不计入失效", async () => {
    const off = { countEnvFailures: false };
    assert.equal(circuit.isFailure({ status: "skip", notInstalled: true }, off), false);
    assert.equal(circuit.isFailure({ status: "skip", notLoggedIn: true }, off), false);
    assert.equal(circuit.isFailure({ status: "retry", reason: "应用未就绪" }, off), true);
    assert.equal(circuit.isFailure({ status: "done" }, off), false);
    // 默认仍计入，行为不变
    assert.equal(circuit.isFailure({ status: "skip", notInstalled: true }), true);
  });

  await test("⑫ 驱动确实消费了规则参数（不是只定义不接线）", async () => {
    assert.match(deskSrc, /desktopRuntime\.effectiveRuntime\(rules\)/);
    assert.match(deskSrc, /ensureStarted\(\{ allowRestart: true, startTimeoutMs \}\)/);
    assert.match(deskSrc, /cardRounds = Math\.max\(1, Math\.ceil\(cardMaxWaitMs \/ 2000\)\)/);
    assert.match(deskSrc, /\(await bodyLen\(\)\) < minRenderChars/);
    assert.match(deskSrc, /i < dwellRounds; i\+\+/);
    assert.match(deskSrc, /popup\.waitForTimeout\(dwellMs\)/);
  });

  await test("⑬ runner 把同一份规则参数交给熔断", async () => {
    assert.match(runnerSrc, /desktopRuntime\.circuitOptions\(/);
    assert.match(runnerSrc, /desktopCircuit\.record\(ctx, rDesktopApp, circuitOpts\)/);
  });

  await test("⑭ 判据类字段仍是代码内的行为边界（远程规则不能改怎么算计分）", async () => {
    const prSrc = fs.readFileSync(path.join(ROOT, "src", "plugin-rules.js"), "utf8");
    assert.doesNotMatch(prSrc, /\beval\s*\(/);
    assert.doesNotMatch(prSrc, /new Function\s*\(/);
    assert.match(deskSrc, /a\[href\*="\$\{form\}"\]/); // 卡片选择器硬编码
    assert.match(deskSrc, /\[\?&\]dmreload=1/); // 计分判据硬编码
    assert.doesNotMatch(deskSrc, /rules\.card\.selectorTemplate/);
    assert.doesNotMatch(deskSrc, /rules\.landing\.rejectPatterns/);
  });

  // —— 空闲门禁（2026-11-19「别打断工作」）——
  await test("⑮ idleGateMinutes 默认 3、可远程调、越界钳制", async () => {
    assert.equal(runtime.effectiveRuntime(null).idleGateMinutes, 3);
    assert.equal(runtime.effectiveRuntime({ runtime: { idleGateMinutes: 10 } }).idleGateMinutes, 10);
    assert.equal(runtime.effectiveRuntime({ runtime: { idleGateMinutes: 0 } }).idleGateMinutes, 0);
    assert.equal(runtime.effectiveRuntime({ runtime: { idleGateMinutes: 9999 } }).idleGateMinutes, 3);
    assert.equal(runtime.effectiveRuntime({ runtime: { idleGateMinutes: -5 } }).idleGateMinutes, 3);
  });

  await test("⑯ parseUserIdleMinutes 正确解析 query user 空闲列", async () => {
    const mk = (idle) => ` 用户名 会话名 ID 状态 空闲时间 登录时间\r\n>zefeng console 1 运行中 ${idle} 2026/11/19 上午 6:20\r\n`;
    assert.equal(runtime.parseUserIdleMinutes(mk(".")), 0);
    assert.equal(runtime.parseUserIdleMinutes(mk("none")), 0);
    assert.equal(runtime.parseUserIdleMinutes(mk("无")), 0); // 中文 locale 的「正在使用」
    assert.equal(runtime.parseUserIdleMinutes(mk("0:05")), 5 / 60);
    assert.equal(runtime.parseUserIdleMinutes(mk("3:00")), 3);
    assert.equal(runtime.parseUserIdleMinutes(mk("1:02:03")), 62 + 3 / 60);
    assert.equal(runtime.parseUserIdleMinutes("没有会话"), null);
    assert.equal(runtime.parseUserIdleMinutes(""), null);
  });

  await test("⑰ shouldDeferForIdle：在用→延后，空闲够→跑，读不到→放行，gate=0→关闭", async () => {
    assert.equal(runtime.shouldDeferForIdle(0, 3), true);      // 正在用
    assert.equal(runtime.shouldDeferForIdle(2.9, 3), true);    // 空闲不足
    assert.equal(runtime.shouldDeferForIdle(3, 3), false);     // 刚好达标
    assert.equal(runtime.shouldDeferForIdle(10, 3), false);    // 空闲够
    assert.equal(runtime.shouldDeferForIdle(null, 3), false);  // 读不到→放行
    assert.equal(runtime.shouldDeferForIdle(0, 0), false);     // 门禁关闭
  });

  await test("⑱ 空闲门禁参数在两份规则齐全一致，validate 卡范围", async () => {
    assert.equal(builtin.runtime.idleGateMinutes, remote.runtime.idleGateMinutes);
    assert.equal(pluginRules.validate(builtin).ok, true);
    assert.equal(pluginRules.validate(remote).ok, true);
    assert.equal(pluginRules.validate({ ...remote, runtime: { ...remote.runtime, idleGateMinutes: 9999 } }).ok, false);
    assert.equal(pluginRules.validate({ ...remote, runtime: { ...remote.runtime, idleGateMinutes: "3" } }).ok, false);
  });

  await test("⑲ runner 在跑桌面任务前先过空闲门禁，延后不算失败", async () => {
    assert.match(runnerSrc, /readUserIdleMinutes\(\)/);
    assert.match(runnerSrc, /shouldDeferForIdle\(idle, eff\.idleGateMinutes\)/);
    assert.match(runnerSrc, /deferred: true/);
    assert.match(runnerSrc, /延后\(用户在使用电脑，空闲时自动跑\)/);
    assert.equal(circuit.isFailure({ status: "skip", deferred: true, reason: "用户正在使用电脑" }), false);
  });

  console.log(lines.join("\n"));
  console.log(`\n结果: ${lines.length - failed} 通过 / ${failed} 失败`);
  if (failed) process.exitCode = 1;
}

main();
