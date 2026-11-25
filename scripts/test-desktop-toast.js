/**
 * 原生 Toast + 协议激活离线回归（2026-11-24）。
 * 全程离线：不写注册表、不弹通知、不启动 PowerShell。
 * 用法: npm run test:desktop-toast
 */
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const T = require(path.join(ROOT, "src", "desktop-toast.js"));
const toastActivation = require(path.join(ROOT, "src", "toast-activation.js"));

const lines = [];
let failed = 0;
async function test(name, fn) {
  try { await fn(); lines.push(`  ✅ ${name}`); }
  catch (e) { failed++; lines.push(`  ❌ ${name} — ${String((e && e.message) || e).slice(0, 220)}`); }
}

const EXE = "D:\\Program Files\\MS Rewards Auto\\MS Rewards Auto.exe";

async function main() {
  await test("① 常量锁死：AUMID / 协议 / launch / 成功标记", async () => {
    assert.equal(T.AUMID, "com.hermlt.msrewards");
    assert.equal(T.PROTOCOL_SCHEME, "msrewards");
    assert.equal(T.PROTOCOL_LAUNCH, "msrewards://desktop-authorize");
    assert.equal(T.TOAST_OK_MARK, "WBTOAST:OK");
    assert.ok(T.TOAST_TIMEOUT_MS >= 5000);
  });

  await test("② isProtocolLaunch：只认授权 URL，大小写/尾斜杠/空白宽容", async () => {
    assert.equal(T.isProtocolLaunch("msrewards://desktop-authorize"), true);
    assert.equal(T.isProtocolLaunch("  MSREWARDS://desktop-authorize/  "), true);
    assert.equal(T.isProtocolLaunch("msrewards://other"), false);
    assert.equal(T.isProtocolLaunch("https://msrewards://desktop-authorize"), false);
    assert.equal(T.isProtocolLaunch(""), false);
    assert.equal(T.isProtocolLaunch(null), false);
  });

  await test("③ buildProtocolCommands：HKCU 用户级、3 条、%1 传完整 URL", async () => {
    const cmds = T.buildProtocolCommands(EXE);
    assert.equal(cmds.length, 3);
    assert.ok(cmds.every((a) => a[0] === "add" && a[1].startsWith("HKCU\\Software\\Classes\\msrewards")));
    assert.ok(cmds[1].includes("URL Protocol"));
    assert.ok(cmds[1].includes("REG_SZ"));
    const cmd = cmds[2][4];
    assert.equal(cmd, `"${EXE}" "%1"`);
    assert.ok(cmds[2][1].endsWith("shell\\open\\command"));
    // 不经过 cmd.exe，%1 不会被提前展开
    assert.ok(cmd.includes("%1"));
  });

  await test("④ ensureProtocol：非 Windows / 非打包一律跳过（防 dev exe 劫持）", async () => {
    let calls = 0;
    const run = () => { calls++; return { ok: true }; };
    const a = T.ensureProtocol({ platform: "linux", isPackaged: true, exePath: EXE, run });
    assert.equal(a.skipped, true);
    assert.equal(a.reason, "non-windows");
    const b = T.ensureProtocol({ platform: "win32", exePath: EXE, run });
    assert.equal(b.skipped, true);
    assert.equal(b.reason, "not-packaged", "未显式传 isPackaged:true 绝不能注册");
    assert.equal(calls, 0, "跳过时一条 reg 命令都不能执行");
  });

  await test("⑤ ensureProtocol：打包版执行 3 条命令；失败/异常安全返回", async () => {
    const seen = [];
    const ok = T.ensureProtocol({ platform: "win32", isPackaged: true, exePath: EXE, run: (a) => { seen.push(a); return { ok: true }; } });
    assert.equal(ok.ok, true);
    assert.equal(ok.commands, 3);
    assert.equal(seen.length, 3);
    assert.equal(T.ensureProtocol({ platform: "win32", isPackaged: true, exePath: EXE, run: () => ({ ok: false }) }).reason, "reg-add-failed");
    assert.equal(T.ensureProtocol({ platform: "win32", isPackaged: true, exePath: EXE, run: () => { throw new Error("boom"); } }).reason, "reg-add-error");
  });

  await test("⑥ buildToastScript：launch + activationType=protocol + AUMID + WinRT 构造", async () => {
    const s = T.buildToastScript();
    assert.ok(s.includes('launch="msrewards://desktop-authorize"'));
    assert.ok(s.includes('activationType="protocol"'), "没有 activationType=protocol 就退回 0.17.0 的死路");
    assert.ok(s.includes('CreateToastNotifier("com.hermlt.msrewards")'));
    assert.ok(s.includes("ToastNotificationManager") && s.includes("XmlDocument"));
    assert.ok(s.includes('template="ToastGeneric"'));
    assert.ok(s.includes("$notifier.Show($toast)"));
    assert.ok(s.includes("WBTOAST:OK"));
    assert.ok(s.includes("@'") && s.includes("'@"));
  });

  await test("⑦ buildToastScript：show:false 零打扰（只构造不 Show）+ XML 转义", async () => {
    const dry = T.buildToastScript({ show: false });
    assert.ok(!dry.includes("$notifier.Show($toast)"));
    assert.ok(dry.includes("WBTOAST:OK"));
    assert.ok(dry.includes("dry-run"));
    const esc = T.buildToastScript({ title: 'A & <B> "C"', body: "x'y", show: false });
    assert.ok(esc.includes("A &amp; &lt;B&gt; &quot;C&quot;"));
    assert.ok(esc.includes("x&apos;y"));
  });

  await test("⑧ showAuthorizationToast：注入 runner / 异常一律 false（上层回落）", async () => {
    try {
      T.setToastRunner(() => true);
      assert.equal(await T.showAuthorizationToast(), true);
      T.setToastRunner(() => false);
      assert.equal(await T.showAuthorizationToast(), false);
      T.setToastRunner(() => { throw new Error("boom"); });
      assert.equal(await T.showAuthorizationToast(), false);
      T.setToastRunner(() => "truthy-string");
      assert.equal(await T.showAuthorizationToast(), false, "只有严格 true 才算成功");
    } finally {
      T.setToastRunner(null);
    }
  });

  await test("⑨ 与 toast-activation 的协议识别保持一致", async () => {
    for (const v of ["msrewards://desktop-authorize", "MSREWARDS://desktop-authorize/", "msrewards://other", ""]) {
      assert.equal(toastActivation.isProtocolActivationArgv([v]), T.isProtocolLaunch(v), `不一致: ${v}`);
    }
    assert.equal(
      toastActivation.shouldAuthorizeFromSecondInstance(["msrewards://desktop-authorize"], 0, 1e12),
      true,
      "点通知是明确的用户动作，不该被 30 分钟窗口挡住"
    );
    assert.equal(toastActivation.shouldAuthorizeFromSecondInstance(["普通参数"], 0, 1e12), false);
  });

  console.log(lines.join("\n"));
  console.log(`\n结果: ${lines.length - failed} 通过 / ${failed} 失败`);
  if (failed) process.exitCode = 1;
}
main();
