/**
 * 2026-11-17 竞品分析后第一批增强的离线回归测试。
 *
 * 不联网、不登录账号、不启动浏览器；只驱动纯函数 + 临时状态文件。
 * 运行: npm run test:boost
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const risk = require(path.join(ROOT, "src", "risk-signals.js"));
const qs = require(path.join(ROOT, "src", "query-sources.js"));
const humanize = require(path.join(ROOT, "src", "humanize.js"));

const lines = [];
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    lines.push(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    lines.push(`  ❌ ${name} — ${String((e && e.message) || e).slice(0, 220)}`);
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "msr-boost-"));
const NOW = new Date(2026, 10, 17, 13, 0, 0).getTime(); // 2026-11-17 13:00 本地

async function main() {
  console.log("\n=== 竞品增强第一批 · 离线回归测试 ===");

  // ---------- 风控信号 ----------
  await test("HTML/RSC 文本命中 Fraud_UserWarning_BotScore_UX → 暂停", async () => {
    const s = risk.parseRiskSignals('<script>{"userWarnings":[{"name":"Fraud_UserWarning_BotScore_UX"}]}</script>');
    assert.equal(s.limited, true);
    assert.equal(risk.shouldPauseAccount(s).pause, true);
  });

  await test("dapi/me 对象里的 userWarnings + serpbotscore 都能解析", async () => {
    const s = risk.parseRiskSignals({
      profile: { attributes: { serpbotscore: 42, serpbotscore_upd: "2026-11-17" } },
      dashboard: { userWarnings: [{ name: "Fraud_UserWarning_BotScore_UX" }] },
    });
    assert.equal(s.botScore, 42);
    assert.equal(s.scoreUpdated, "2026-11-17");
    assert.equal(s.limited, true);
    assert.equal(risk.shouldPauseAccount(s).pause, true);
  });

  await test("只有高机器人评分、没有明确警告 → 只记录不暂停（保守判据）", async () => {
    const s = risk.parseRiskSignals('{"profile":{"attributes":{"serpbotscore":99}}}');
    assert.equal(s.botScore, 99);
    assert.equal(s.observed, true);
    assert.equal(s.limited, false);
    assert.equal(risk.shouldPauseAccount(s).pause, false);
  });

  await test("未知警告名 / 空输入 / 脏字符串一律放行", async () => {
    for (const input of [
      '{"dashboard":{"userWarnings":[{"name":"SomeNewWarning"}]}}',
      "",
      null,
      "not a json at all",
    ]) {
      const s = risk.parseRiskSignals(input);
      assert.equal(risk.shouldPauseAccount(s).pause, false, `误伤输入: ${String(input).slice(0, 40)}`);
    }
  });

  await test("暂停原因要可读且说明恢复方式", async () => {
    const s = risk.parseRiskSignals("Fraud_UserWarning_BotScore_UX");
    const v = risk.shouldPauseAccount(s);
    assert.match(v.reason, /暂停本轮任务/);
    assert.match(v.reason, /人工正常使用/);
  });

  // ---------- 搜索词池 ----------
  await test("normalizeTopic 去 HTML / 空白 / 首尾标点，过滤短串与纯数字", async () => {
    assert.equal(qs.normalizeTopic("  <b>今日新闻</b>！！ "), "今日新闻");
    assert.equal(qs.normalizeTopic("1"), "");
    assert.equal(qs.normalizeTopic("123456"), "");
    assert.equal(qs.normalizeTopic("   "), "");
  });

  await test("dedupe 大小写不敏感去重", async () => {
    assert.deepEqual(qs.dedupe(["ABC", "abc", " 天气 ", "天气", ""]), ["ABC", "天气"]);
  });

  await test("多源累加：第二个源的重复标题不会污染词池", async () => {
    const c = qs.createCache();
    assert.equal(qs.addSource(c, ["热词甲", "热词乙"], () => 0.5), 2);
    assert.equal(qs.addSource(c, ["热词乙", "热词丙"], () => 0.5), 1);
    assert.equal(c.pool.length, 3);
  });

  await test("连续 40 次取词无空值、无连续重复", async () => {
    const c = qs.createCache();
    qs.addSource(c, ["热词甲", "热词乙", "热词丙"], () => 0.5);
    let prev = "";
    for (let i = 0; i < 40; i++) {
      const q = qs.nextQuery(c, () => 0.5);
      assert.ok(q && q.length >= 2, `第 ${i} 次取到空词`);
      assert.notEqual(q, prev, `第 ${i} 次与上一次重复: ${q}`);
      prev = q;
    }
  });

  await test("所有热榜源都挂时仍有本地词库兜底（不是固定 10 个词）", async () => {
    const c = qs.createCache();
    assert.equal(qs.hasPool(c), false);
    assert.ok(qs.nextQuery(c, () => 0.5));
    assert.ok(qs.LOCAL_TOPICS.length >= 30, "本地词库太小，兜底会高度重复");
  });

  // ---------- 拟人化（重点：按账号隔离，修对方全局单文件缺陷） ----------
  await test("默认 enabled=false 时绝不跳过（fail-open）", async () => {
    humanize.markRunSucceeded({ dir: tmpDir, accountId: "a@x.com", nowMs: NOW });
    assert.equal(humanize.shouldSkipRunToday({ dir: tmpDir, accountId: "a@x.com", nowMs: NOW }), false);
  });

  await test("同账号同日成功 → 跳过；跨天 → 不跳过", async () => {
    humanize.markRunSucceeded({ dir: tmpDir, accountId: "b@x.com", nowMs: NOW });
    assert.equal(humanize.shouldSkipRunToday({ dir: tmpDir, accountId: "b@x.com", nowMs: NOW, enabled: true }), true);
    const nextDay = NOW + 24 * 3600 * 1000;
    assert.equal(humanize.shouldSkipRunToday({ dir: tmpDir, accountId: "b@x.com", nowMs: nextDay, enabled: true }), false);
  });

  await test("关键：A 账号成功后，B 账号当天仍必须照跑（不能全局跳过）", async () => {
    humanize.markRunSucceeded({ dir: tmpDir, accountId: "only-a@x.com", nowMs: NOW });
    assert.equal(humanize.shouldSkipRunToday({ dir: tmpDir, accountId: "only-a@x.com", nowMs: NOW, enabled: true }), true);
    assert.equal(humanize.shouldSkipRunToday({ dir: tmpDir, accountId: "only-b@x.com", nowMs: NOW, enabled: true }), false);
    assert.notEqual(humanize.stateFile(tmpDir, "only-a@x.com"), humanize.stateFile(tmpDir, "only-b@x.com"));
  });

  await test("状态文件损坏时不误跳过", async () => {
    const f = humanize.stateFile(tmpDir, "broken@x.com");
    fs.writeFileSync(f, "{not json");
    assert.equal(humanize.shouldSkipRunToday({ dir: tmpDir, accountId: "broken@x.com", nowMs: NOW, enabled: true }), false);
  });

  await test("quietWaitMs：命中工作日静默时段要等待，时段外为 0", async () => {
    const rules = [{ days: ["monday", "tuesday", "wednesday", "thursday", "friday"], start: "12:00", end: "14:30" }];
    const inQuiet = humanize.quietWaitMs(rules, NOW); // 周二 13:00
    assert.ok(inQuiet >= 89 * 60000 && inQuiet <= 91 * 60000, `等待时长异常: ${inQuiet}`);
    const evening = new Date(2026, 10, 17, 20, 0, 0).getTime();
    assert.equal(humanize.quietWaitMs(rules, evening), 0);
    assert.equal(humanize.quietWaitMs([], NOW), 0);
  });

  await test("randomRatio / randomArticleLimit 边界正确", async () => {
    assert.equal(humanize.randomRatio({ min: 0.85, max: 1 }, () => 0), 0.85);
    assert.equal(humanize.randomRatio({ min: 0.85, max: 1 }, () => 1), 1);
    assert.ok(humanize.randomRatio({ min: 0.85, max: 1 }, () => 0.5) > 0.85);
    assert.equal(humanize.randomArticleLimit({ min: 7, max: 10 }, () => 0, 10), 7);
    assert.equal(humanize.randomArticleLimit({ min: 7, max: 10 }, () => 0.999, 10), 10);
    assert.equal(humanize.randomArticleLimit({}, () => 0.5, 6), 6);
  });

  // ---------- 接线（源码级契约） ----------
  await test("rewards.getRewardsInfo 复用已拉取的 HTML 解析风控，不额外发请求", async () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "rewards.js"), "utf8");
    assert.match(src, /risk:\s*riskSignals\.parseRiskSignals\(res\.text\)/);
  });

  await test("runner 在任务链之前做风控暂停，且解析失败放行", async () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "runner.js"), "utf8");
    const iGuard = src.indexOf("riskSignals.shouldPauseAccount");
    const iTasks = src.indexOf("// 4. 顺序执行任务");
    assert.ok(iGuard >= 0 && iTasks > iGuard, "风控检查没排在任务链前面");
    assert.match(src, /风控信号检查失败（已放行）/);
  });

  await test("tasks 走多源词池 + 拟人化设备占比，且不再用固定 60% 字面量", async () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "tasks.js"), "utf8");
    assert.match(src, /querySources\.nextQuery\(queryCache\)/);
    assert.match(src, /humanize\.randomRatio\(\{ min: 0\.5, max: 0\.75 \}\)/);
    assert.doesNotMatch(src, /Math\.random\(\) > 0\.6/);
    assert.doesNotMatch(src, /const keywordCache =/);
  });

  console.log(lines.join("\n"));
  console.log(`\n结果: ${lines.length - failed} 通过 / ${failed} 失败`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((e) => { console.error("[测试异常]", e); process.exitCode = 1; })
  .finally(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
