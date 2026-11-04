/**
 * Windows Hello 身份验证（系统级弹窗，用户输入本机 PIN / 指纹 / 面容）。
 *
 * 【为什么走 PowerShell 而不是原生模块】
 *   Windows Hello 只有两套可编程入口：
 *     ① WinRT `Windows.Security.Credentials.UI.UserConsentVerifier`
 *     ② Win32 `CredUIPromptForWindowsCredentials`（凭据对话框）
 *   ② 拿不到 PIN —— Windows Hello 的 PIN 不是账户密码，CredUI 解不出明文。
 *   只剩 ①，而 Node/Electron 没有 WinRT 绑定；自己写 native addon 要编译
 *   还要为目标机架构分发，代价远大于收益。所以用 Windows PowerShell 5.1
 *   跑一段短脚本调用它（⚠️ pwsh 7 基于 .NET Core，没有 System.Runtime.WindowsRuntime，
 *   调不了 WinRT —— 必须用 powershell.exe 5.1）。
 *
 * 【安全模型：这是「授权门」，不是「密钥绑定」】
 *   UserConsentVerifier 只返回 Verified / Canceled，**拿不到 PIN 本身**，
 *   所以无法用 PIN 派生密钥。实际做法是：
 *       验证通过 → 再从 DPAPI（keychain）里取出真正的 VK
 *   这意味着：
 *     ✅ 能挡住「别人坐在你电脑前打开这个软件」（必须本人在场）
 *     ❌ 挡不住「恶意程序已经跑在你的 Windows 账户下」（它可以直接读 .vaultkey）
 *   这不是偷懒：Windows 根本不提供「与 Hello PIN 绑定的对称加密」API，
 *   Hello 是认证机制而不是密钥派生机制。要真正绑定，只能用 TPM + NCryptProtectSecret
 *   自建方案，属于另一个量级的工程。这条限制必须对用户如实说明。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const logger = require("./logger");

const IS_WIN = process.platform === "win32";
const SCRIPT_NAME = "ms-rewards-hello-probe.ps1";

/**
 * 探测脚本（PowerShell 5.1）。
 *
 * 两个动作：
 *   check  → CheckAvailabilityAsync（不弹窗、不打扰）
 *   verify → RequestVerificationAsync（弹系统窗口，等用户输 PIN）
 *
 * 异步 → 同步的关键是 AsTask 扩展方法：WinRT 的 IAsyncOperation 不是 .NET Task，
 * 必须借 System.Runtime.WindowsRuntime 里的扩展转一次才能 Wait。
 */
const CHECK_SCRIPT = `
param([string]$Verb = "check", [string]$Message = "")
# ⚠️ 必须显式设输出编码：Windows PowerShell 5.1 默认按 GBK 输出，
#    Node 侧按 UTF-8 解码会得到一串乱码（实测把「请验证身份」变成问号方块）。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($op, [Type]$t) {
  $task = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  return $task.Result
}
$ucv = [Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
if ($Verb -eq "check") {
  $r = Await ($ucv::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
  Write-Output ("RESULT=" + $r)
} else {
  # 提示语默认写在脚本里（=UTF-8 BOM 保证中文正确），不靠命令行参数传中文 ——
  # spawn 的命令行是 UTF-8，而 PS 5.1 按 ANSI 解析参数，中文参数会变乱码。
  if ([string]::IsNullOrWhiteSpace($Message)) { $Message = "请验证身份以解锁 MS Rewards 自动化工具" }
  $r = Await ($ucv::RequestVerificationAsync($Message)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
  Write-Output ("RESULT=" + $r)
}
`;

/**
 * 把系统验证窗提到最前（PowerShell 5.1）。
 *
 * 【为什么需要它 —— 2026-11-04 实测数据】
 *   Electron 主窗与 Hello 验证窗**确实重叠**，而系统窗默认排在应用窗之后：
 *     应用窗  (584, 252) 880x600      ← Z 序 0
 *     PIN 窗  (796, 338) 456x476      ← Z 序 1
 *   只做 blur() 没用（实测仍被压住），而且 blur 过头会让验证窗**根本弹不出来**
 *   （对照组实测「未拿到验证结果」，Z 序里连 CredentialUIBroker 都没有）。
 *   所以这里在验证开始后轮询找窗口，找到就 SetForegroundWindow 提上来。
 *
 * 【为什么不用应用自己置顶】
 *   setAlwaysOnTop(true) 是反的：它会让**我们的**窗口压到系统窗之上（实测 Z 序 0=electron）。
 *   SetForegroundWindow 有前台锁限制，所以先 AttachThreadInput 挂到当前前台线程再调，
 *   实测 RAISE_OK=True 且 Z 序变成 0=CredentialUIBroker。
 */
const RAISE_SCRIPT = `
param([int]$Tries = 20, [int]$SleepMs = 250)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class HelloRaise {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId2(IntPtr h, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
}
"@
# GetWindowThreadProcessId 重载：上面的 2 参版本用于「只要线程 id」
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class HelloTid {
  [DllImport("user32.dll", EntryPoint="GetWindowThreadProcessId")] public static extern uint Get(IntPtr h, IntPtr p);
}
"@

$script:target = [IntPtr]::Zero
$cb = [HelloRaise+EnumWindowsProc]{
  param($h, $l)
  if ([HelloRaise]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][HelloRaise]::GetWindowTextW($h, $sb, 512)
    if ($sb.ToString().Trim().Length -gt 0) {
      $p = 0
      [void][HelloRaise]::GetWindowThreadProcessId($h, [ref]$p)
      $pn = ""
      try { $pn = (Get-Process -Id $p -ErrorAction Stop).ProcessName } catch {}
      if ($pn -eq "CredentialUIBroker") { $script:target = $h }
    }
  }
  return $true
}

$raised = 0
for ($i = 0; $i -lt $Tries; $i++) {
  $script:target = [IntPtr]::Zero
  [void][HelloRaise]::EnumWindows($cb, [IntPtr]::Zero)
  if ($script:target -ne [IntPtr]::Zero) {
    $fg = [HelloRaise]::GetForegroundWindow()
    $fgTid = [HelloTid]::Get($fg, [IntPtr]::Zero)
    $myTid = [HelloRaise]::GetCurrentThreadId()
    $attached = $false
    if ($fgTid -ne 0 -and $fgTid -ne $myTid) {
      $attached = [HelloRaise]::AttachThreadInput($fgTid, $myTid, $true)
    }
    [void][HelloRaise]::BringWindowToTop($script:target)
    $ok = [HelloRaise]::SetForegroundWindow($script:target)
    # SWP_NOSIZE|SWP_NOMOVE|SWP_SHOWWINDOW
    [void][HelloRaise]::SetWindowPos($script:target, [IntPtr]::Zero, 0,0,0,0, 0x0001 -bor 0x0002 -bor 0x0040)
    if ($attached) { [void][HelloRaise]::AttachThreadInput($fgTid, $myTid, $false) }
    if ($ok) { $raised++ }
    # 提上来就够用了；多提几次是为了对抗「系统随后又把焦点抢回去」
    if ($raised -ge 2) { break }
  }
  Start-Sleep -Milliseconds $SleepMs
}
Write-Output ("RAISED=" + $raised)
`;

/** 提窗脚本落地（同样要 BOM，理由同 CHECK_SCRIPT） */
function ensureRaiseScript() {
  const p = path.join(os.tmpdir(), "ms-rewards-hello-raise.ps1");
  const want = "\ufeff" + RAISE_SCRIPT;
  try {
    if (fs.existsSync(p) && fs.readFileSync(p, "utf8") === want) return p;
  } catch {}
  fs.writeFileSync(p, want, "utf8");
  return p;
}

/**
 * 后台把系统验证窗提到最前。不阻塞调用方，失败也不影响验证本身
 * （提不上来只是难看，验证照样能用键盘/鼠标操作）。
 */
function raiseConsentWindow() {
  if (!IS_WIN) return;
  let file;
  try {
    file = ensureRaiseScript();
  } catch {
    return;
  }
  try {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], {
      windowsHide: true,
      detached: false,
    });
    child.on("error", () => {});
    // 15 秒后强制结束：验证窗早该关掉了，留着只是白占进程
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, 15000);
    child.on("close", () => clearTimeout(t));
  } catch {
    /* 见上：提窗是尽力而为 */
  }
}

/** 把探测脚本落到临时目录（内容不一致就重写，避免复用上次的坏文件） */
function ensureScript() {
  const p = path.join(os.tmpdir(), SCRIPT_NAME);
  // ⚠️ 必须带 BOM。Windows PowerShell 5.1 对「无 BOM 的 UTF-8」按系统 ANSI（中文环境是 GBK）
  //    解析，脚本里的中文会变成乱码并把字符串截断，直接报「字符串缺少终止符」。
  //    实测：不带 BOM 时 check 永远失败，且失败原因本身还是一串乱码。
  const want = "\ufeff" + CHECK_SCRIPT;
  try {
    // 必须比对内容而不是只看文件存在：上一版不带 BOM 的旧文件会一直被复用，
    // 修了代码也照样报错（2026-11-04 踩过一次）。
    if (fs.existsSync(p) && fs.readFileSync(p, "utf8") === want) return p;
  } catch {}
  fs.writeFileSync(p, want, "utf8");
  return p;
}

/**
 * 跑一次脚本。
 * @param {"check"|"verify"} verb
 * @param {string} [message] verify 时弹窗上的提示语
 * @param {number} [timeoutMs] 用户不操作时 WinRT 自己会超时，这里再兜一层
 * @returns {Promise<{ok:boolean, result:string|null, error?:string}>}
 */
function runScript(verb, message, timeoutMs = 120000) {
  return new Promise((resolve) => {
    if (!IS_WIN) return resolve({ ok: false, result: null, error: "仅 Windows 支持" });
    let file;
    try {
      file = ensureScript();
    } catch (e) {
      return resolve({ ok: false, result: null, error: `写入探测脚本失败：${e.message}` });
    }
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      file,
      "-Verb",
      verb,
      "-Message",
      // 不传中文：spawn 的命令行是 UTF-8，PS 5.1 按 ANSI 解析参数，中文会乱码。
      // 默认提示语写在脚本里（脚本带 BOM，中文正确）。
      message || "",
    ];
    // ⚠️ 不加 -NonInteractive：WinRT 的安全对话框由系统托管，与 PS 宿主是否交互无关，
    //    但加了这个开关在某些策略下会让脚本提前退出，反而拿不到结果。
    const child = spawn("powershell.exe", args, { windowsHide: true });
    let out = "";
    let err = "";
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      done({ ok: false, result: null, error: "等待验证超时（系统弹窗未响应）" });
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));
    child.on("error", (e) => done({ ok: false, result: null, error: `无法启动 PowerShell：${e.message}` }));
    child.on("close", () => {
      const m = out.match(/RESULT=([A-Za-z]+)/);
      if (!m) {
        const hint = (err || out).replace(/\s+/g, " ").trim().slice(0, 160);
        return done({ ok: false, result: null, error: hint || "未拿到验证结果" });
      }
      done({ ok: true, result: m[1] });
    });
  });
}

/** Windows Hello 不可用的原因（按枚举值给中文说明） */
const AVAIL_REASON = {
  DeviceNotPresent: "这台电脑没有可用的 Windows Hello 设备",
  NotConfiguredForUser: "尚未设置 Windows Hello（请先在系统设置里设置 PIN 或指纹）",
  DisabledByPolicy: "Windows Hello 已被系统策略禁用",
  DeviceBusy: "Windows Hello 设备正忙，请稍后再试",
};

const VERIFY_REASON = {
  DeviceNotPresent: "这台电脑没有可用的 Windows Hello 设备",
  NotConfiguredForUser: "尚未设置 Windows Hello（请先在系统设置里设置 PIN 或指纹）",
  DisabledByPolicy: "Windows Hello 已被系统策略禁用",
  DeviceBusy: "Windows Hello 设备正忙，请稍后再试",
  RetriesExhausted: "验证失败次数过多，请改用密码解锁",
  Canceled: "已取消验证",
};

let availCache = null;

/**
 * 是否可用（结果缓存：同一次运行内设备状态不会突变，避免每次开界面都起一个 PowerShell）
 * @returns {Promise<{available:boolean, reason?:string, cached?:boolean}>}
 */
async function isAvailable() {
  if (!IS_WIN) return { available: false, reason: "仅 Windows 支持 Windows Hello" };
  if (availCache) return { ...availCache, cached: true };
  const r = await runScript("check", "", 20000);
  if (!r.ok) {
    availCache = { available: false, reason: r.error || "探测失败" };
    return availCache;
  }
  if (r.result === "Available") {
    availCache = { available: true };
  } else {
    availCache = { available: false, reason: AVAIL_REASON[r.result] || `Windows Hello 不可用（${r.result}）` };
  }
  logger.info(`Windows Hello 可用性：${availCache.available ? "可用" : availCache.reason}`);
  return availCache;
}

/**
 * 弹系统级验证窗，等用户输入 PIN / 指纹。
 *
 * ⚠️ 会阻塞到用户操作或超时，调用方必须是从用户点击触发的路径（不能在启动时自动弹）。
 * @param {string} [message] 弹窗里的提示语
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function verify(message) {
  const st = await isAvailable();
  if (!st.available) return { ok: false, reason: st.reason };
  // 先起「提窗」辅助：系统验证窗默认被压在应用窗之下（实测 Z 序 0=应用、1=PIN 窗），
  // 而它出现的时间点拿不到事件通知，只能由辅助脚本轮询找窗口再提到前台。
  // 放在 verify 之前起，避免用户还没看清窗口就被计时器拖过。
  raiseConsentWindow();
  const r = await runScript("verify", message || "");
  if (!r.ok) return { ok: false, reason: r.error || "验证失败" };
  if (r.result === "Verified") return { ok: true };
  return { ok: false, reason: VERIFY_REASON[r.result] || `验证未通过（${r.result}）` };
}

module.exports = {
  IS_WIN,
  isAvailable,
  verify,
  raiseConsentWindow,
  // 供自检断言：这两个枚举映射是「用户能不能看懂失败原因」的唯一来源
  AVAIL_REASON,
  VERIFY_REASON,
};
