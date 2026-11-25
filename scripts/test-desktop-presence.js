/**
 * 弹窗「用户场景抑制」离线回归（2026-11-22）。
 * 全程离线：不 spawn PowerShell、不读 GPU、不发通知。
 * 用法: npm run test:presence
 */
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const P = require(path.join(ROOT, "src", "desktop-presence.js"));

const lines = [];
let failed = 0;
async function test(name, fn) {
  try { await fn(); lines.push(`  ✅ ${name}`); }
  catch (e) { failed++; lines.push(`  ❌ ${name} — ${String((e && e.message) || e).slice(0, 220)}`); }
}

const IDLE = { ok: true, quns: 5, fullscreen: false, cpu: 12, gpu: 3, videoActive: false };

async function main() {
  await test("① 阈值常量锁死（CPU 60 / GPU 50 / 视频 1 / 勿扰 QUNS 2,3,4,6）", async () => {
    assert.equal(P.THRESHOLDS.CPU_HIGH_PCT, 60);
    assert.equal(P.THRESHOLDS.GPU_HIGH_PCT, 50);
    assert.equal(P.THRESHOLDS.VIDEO_MIN_PCT, 1);
    assert.deepEqual(P.THRESHOLDS.DND_QUNS, [2, 3, 4, 6]);
    assert.equal(P.SAMPLE_GAP_MS, 900);
    assert.ok(P.PROBE_TIMEOUT_MS >= 10000);
    assert.match(P.WALLPAPER_PROC_RE, /wallpaper/);
    assert.match(P.WALLPAPER_PROC_RE, /lively/);
  });

  await test("② 前台应用持续硬解视频（已归因）→ 跳过弹窗", async () => {
    const r = P.evaluatePresence({ ...IDLE, videoActive: true, videoUserFacing: true });
    assert.equal(r.suppress, true);
    assert.equal(r.reason, "video");
    assert.match(r.detail, /视频/);
    // 视频优先于全屏高负载，且不受 QUNS 正常值影响
    assert.equal(P.evaluatePresence({ ...IDLE, quns: 3, videoActive: true, videoUserFacing: true }).reason, "video");
  });

  await test("③ 系统勿扰 / 全屏 D3D / 演示模式 / 专注助手 → 跳过弹窗", async () => {
    for (const q of [2, 3, 4, 6]) {
      const r = P.evaluatePresence({ ...IDLE, quns: q });
      assert.equal(r.suppress, true, `QUNS=${q} 应抑制`);
      assert.equal(r.reason, "dnd");
    }
    for (const q of [1, 5, 7]) assert.equal(P.evaluatePresence({ ...IDLE, quns: q }).suppress, false);
  });

  await test("④ 2026-11-22 改判：全屏 + CPU 或 GPU 任一高（OR）→ 跳过；全屏前提保留", async () => {
    assert.equal(P.evaluatePresence({ ...IDLE, fullscreen: true, cpu: 90, gpu: 90 }).reason, "fullscreen-heavy");
    assert.equal(P.evaluatePresence({ ...IDLE, fullscreen: true, cpu: 90, gpu: 10 }).reason, "fullscreen-heavy", "只 CPU 高也要跳");
    assert.equal(P.evaluatePresence({ ...IDLE, fullscreen: true, cpu: 20, gpu: 90 }).reason, "fullscreen-heavy", "只 GPU 高也要跳");
    assert.equal(P.evaluatePresence({ ...IDLE, fullscreen: true, cpu: 20, gpu: 10 }).suppress, false, "两者都不高不能跳");
    assert.equal(P.evaluatePresence({ ...IDLE, fullscreen: false, cpu: 90, gpu: 90 }).suppress, false, "非全屏不能跳");
    // 某一项读不到（探针返回 -1）时，另一项高仍应生效，不能被 -1 带废
    assert.equal(P.evaluatePresence({ ...IDLE, fullscreen: true, cpu: -1, gpu: 90 }).suppress, true);
    assert.equal(P.evaluatePresence({ ...IDLE, fullscreen: true, cpu: 90, gpu: -1 }).suppress, true);
  });

  await test("⑤ 阈值边界：恰好等于阈值算过高（>=），OR 下分别生效", async () => {
    assert.equal(P.evaluatePresence({ ...IDLE, fullscreen: true, cpu: 60, gpu: 20 }).suppress, true, "CPU 恰好达阈值");
    assert.equal(P.evaluatePresence({ ...IDLE, fullscreen: true, cpu: 20, gpu: 50 }).suppress, true, "GPU 恰好达阈值");
    assert.equal(P.evaluatePresence({ ...IDLE, fullscreen: true, cpu: 59.9, gpu: 49.9 }).suppress, false);
  });

  await test("⑥ 探针不可用 / 非 Windows / 解析失败 → fail-open 不抑制", async () => {
    assert.equal(P.evaluatePresence(null).suppress, false);
    assert.equal(P.evaluatePresence(undefined).reason, "probe-unavailable");
    assert.equal(P.evaluatePresence({ ok: false, videoActive: true, quns: 3 }).suppress, false);
    assert.equal(P.evaluatePresence({ ...IDLE, cpu: -1, gpu: -1 }).suppress, false);
  });

  await test("⑦ parseProbeOutput：BOM / 脏前缀 / 坏 JSON / 无标记都能兜住", async () => {
    const good = 'WBPROBE:{"ok":true,"quns":5,"fullscreen":false,"cpu":28.5,"gpu":1,"video":0,"videoActive":false,"videoUserFacing":false,"videoWallpaperOnly":false,"wallpaperGpu":3,"foregroundPid":20412}';
    const r = P.parseProbeOutput("\uFEFF" + good + "\r\n");
    assert.equal(r.ok, true);
    assert.equal(r.quns, 5);
    assert.equal(r.cpu, 28.5);
    assert.equal(r.videoActive, false);
    assert.equal(r.videoUserFacing, false);
    assert.equal(r.wallpaperGpu, 3);
    assert.equal(r.foregroundPid, 20412);
    const v = P.parseProbeOutput("some noise\r\n" + 'WBPROBE:{"ok":true,"quns":4,"fullscreen":true,"cpu":91,"gpu":88,"video":4,"videoActive":true,"videoUserFacing":true,"videoWallpaperOnly":false,"wallpaperGpu":0,"foregroundPid":1}');
    assert.equal(v.videoActive, true);
    assert.equal(v.videoUserFacing, true);
    assert.equal(v.fullscreen, true);
    // 旧格式缺新字段 → 一律 fail-open（不抑制），不能凭 videoActive 误判
    const old = P.parseProbeOutput('WBPROBE:{"ok":true,"quns":5,"videoActive":true}');
    assert.equal(old.videoUserFacing, false);
    assert.equal(old.videoWallpaperOnly, false);
    assert.equal(P.parseProbeOutput(""), null);
    assert.equal(P.parseProbeOutput("WBPROBE:{broken"), null);
    assert.equal(P.parseProbeOutput("WBPROBE:no-json"), null);
  });

  await test("⑧ 注入探针 + 注入实现抛错 → 不卡通知", async () => {
    try {
      P.setPresenceProbe(() => ({ ...IDLE, videoActive: true, videoUserFacing: true }));
      const snap = await P.readPresence();
      assert.equal(P.evaluatePresence(snap).reason, "video");
      P.setPresenceProbe(() => { throw new Error("boom"); });
      assert.equal(await P.readPresence(), null);
      P.setPresenceProbe(() => undefined);
      assert.equal(await P.readPresence(), null);
    } finally {
      P.setPresenceProbe(null);
    }
  });

  await test("⑨ 探针脚本：WMI 英文类名 + 全屏/勿扰 P/Invoke + 视频引擎双采样 + 标记输出", async () => {
    const s = P.PROBE_SCRIPT;
    assert.match(s, /Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine/);
    assert.match(s, /Win32_Processor/);
    assert.match(s, /SHQueryUserNotificationState/);
    assert.match(s, /GetForegroundWindow/);
    assert.match(s, /GetSystemMetrics/);
    assert.match(s, /engtype_Video/);
    assert.match(s, /UtilizationPercentage/);
    // 「持续工作」= 两次采样都命中，而非单次抖动
    assert.equal((s.match(/Sample-Gpu/g) || []).length >= 3, true); // 定义 + 两次调用
    assert.match(s, /Start-Sleep -Milliseconds 900/);
    // 视频解码必须归因到进程，否则动态壁纸会把 notify 永久卡死
    assert.match(s, /GetWindowThreadProcessId/);
    assert.ok(s.includes("$WALL_RE = 'wallpaper|lively|rainmeter|deskscape|dreamscene|webwallpaper'"));
    assert.ok(s.includes("IsWall) { continue }"), "壁纸进程的解码必须被跳过");
    assert.ok(s.includes("$procId = [int]$Matches[1]"), "必须先存 PID 再做第二次 -match");
    assert.ok(s.includes("先存 PID 再判引擎类型"));
    assert.match(s, /videoUserFacing/);
    assert.match(s, /videoWallpaperOnly/);
    assert.match(s, /wallpaperGpu/);
    assert.match(s, /ConvertTo-Json -Compress/);
    assert.match(s, /WBPROBE:/);
    // 故意不用本地化的 Get-Counter 路径（中文系统会失败）
    assert.doesNotMatch(s, /Get-Counter/);
  });

  await test("⑩ 判定是纯函数：不修改入参、可覆盖阈值", async () => {
    const snap = Object.freeze({ ...IDLE, fullscreen: true, cpu: 70, gpu: 70 });
    assert.equal(P.evaluatePresence(snap).suppress, true);
    // OR 语义下必须把两个阈值都抬高，才会变成「都不高」
    assert.equal(P.evaluatePresence(snap, { CPU_HIGH_PCT: 80, GPU_HIGH_PCT: 80 }).suppress, false);
    assert.equal(snap.cpu, 70);
  });

  await test("⑪ 动态壁纸：持续硬解不算看视频，3D 占用也不能拉高 GPU 误触发", async () => {
    // 探针侧已把壁纸进程的引擎从 gpu 里剔除，这里拿到的是剔除后的快照
    const wallSnap = {
      ...IDLE,
      videoActive: true,        // 原始信号：Video 引擎确实持续在忙
      videoUserFacing: false,   // 归因结果：全是壁纸 / 未聚焦进程
      videoWallpaperOnly: true,
      wallpaperGpu: 87,
      gpu: 2,                   // 剔除壁纸后只剩 2%
      fullscreen: true,
      cpu: 20,
    };
    const r = P.evaluatePresence(wallSnap);
    assert.equal(r.suppress, false, "动态壁纸绝不能把弹窗永久卡死");
    assert.equal(r.reason, "background-video");
    assert.match(r.detail, /动态壁纸|后台/);
    // 旧逻辑（裸 videoActive）会误抑制；这里锁住「必须归因到前台」
    assert.equal(P.evaluatePresence({ ...wallSnap, videoUserFacing: true }).reason, "video");
    // 壁纸豁免不能覆盖系统勿扰 / 全屏高负载
    assert.equal(P.evaluatePresence({ ...wallSnap, quns: 4 }).reason, "dnd");
    assert.equal(P.evaluatePresence({ ...wallSnap, cpu: 95 }).reason, "fullscreen-heavy");
    // 只有 videoActive 而没有任何归因字段 → fail-open 放行
    assert.equal(P.evaluatePresence({ ...IDLE, videoActive: true }).suppress, false);
  });

  console.log(lines.join("\n"));
  console.log(`\n结果: ${lines.length - failed} 通过 / ${failed} 失败`);
  if (failed) process.exitCode = 1;
}
main();
