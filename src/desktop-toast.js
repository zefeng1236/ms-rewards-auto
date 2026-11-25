/**
 * Windows 原生 Toast + URL 协议激活（2026-11-24，修 0.17.0「点通知没反应」）。
 *
 * 【故障复盘】0.17.0 用 Electron 的 `new Notification()`，它生成的最简 toast XML
 * 是 `<toast><visual>…</visual></toast>` —— 没有 `launch`、没有 `activationType`、
 * 没有按钮。点击时 Windows 只能按 AUMID 找激活器，而本机快捷方式的
 * `System.AppUserModel.ToastActivatorCLSID` 为空、`HKCU\AppUserModelId` 里也没登记
 * `com.hermlt.msrewards`；COM 激活那条路又会带 `-Embedding`，被 Chromium 以
 * exit 9 直接杀掉。结果：`click` 回调与 `second-instance` 双双不触发 ——
 * 用户看到的就是「点了没反应、软件也没打开」。通知数据库与 app.log 均已实证。
 *
 * 【本模块的办法】绕开整套脆弱的 COM 激活：
 *   1) 注册用户级 URL 协议 `msrewards://`（HKCU，无需管理员，只在打包版注册）；
 *   2) 用 WinRT 发一条 `activationType="protocol" launch="msrewards://desktop-authorize"`
 *      的原生 toast。用户点击 → Windows 用 ShellExecute 打开该 URL → 启动本应用并
 *      把 URL 作为参数传入（**不带 -Embedding**）→ 单实例锁把 argv 转给已在运行的
 *      进程 → `second-instance` 里识别协议并授权执行，同时 `activateApp(false)`
 *      把主窗口显示出来。
 * 这样「点通知」既拉得起软件，也真的会执行，不依赖 Windows 的 COM 激活器。
 *
 * 【⚠️ 只在打包版注册协议】源码模式注册会把 dev 的 electron.exe 写进 HKCU，
 * 正式版点击通知就会被 dev 进程劫持 —— 与 2026-11-21 踩过的 Electron.lnk 是
 * 同一类坑。故 `ensureProtocol` 默认 `isPackaged=false`，必须由主进程显式传
 * `app.isPackaged`。
 *
 * 【纯逻辑可测】协议命令、toast 脚本都是生成出来的字符串；`ensureProtocol` /
 * `showAuthorizationToast` 都可注入 run / runner，离线测试不碰注册表、不弹通知。
 */
"use strict";

const path = require("node:path");

const AUMID = "com.hermlt.msrewards";
const PROTOCOL_SCHEME = "msrewards";
const PROTOCOL_LAUNCH = "msrewards://desktop-authorize";
const PROTOCOL_RE = /^msrewards:\/\/desktop-authorize\/?$/i;
const TOAST_OK_MARK = "WBTOAST:OK";
const TOAST_TIMEOUT_MS = 10000;

const DEFAULT_TITLE = "Rewards 桌面任务待执行";
const DEFAULT_BODY = "检测到您已离开电脑。点这条通知即可打开软件并授权执行桌面专属任务（执行完会自动关闭 Rewards 应用）。";

/** argv 里是否带着「点通知授权」的协议 URL（允许尾斜杠与大小写） */
function isProtocolLaunch(v) {
  return PROTOCOL_RE.test(String(v == null ? "" : v).trim());
}

/**
 * 生成 reg.exe 参数（HKCU 用户级，无需管理员）。
 * `%1` 是 Windows 传入的完整 URL；命令形如 `"<exePath>" "%1"`。
 */
function buildProtocolCommands(exePath) {
  const base = `HKCU\\Software\\Classes\\${PROTOCOL_SCHEME}`;
  const clean = String(exePath || "").replace(/"/g, "");
  const command = `"${clean}" "%1"`;
  return [
    ["add", base, "/ve", "/d", "URL:MS Rewards Auto Protocol", "/f"],
    ["add", base, "/v", "URL Protocol", "/t", "REG_SZ", "/d", "", "/f"],
    ["add", `${base}\\shell\\open\\command`, "/ve", "/d", command, "/f"],
  ];
}

function defaultRegRun(args) {
  const { spawnSync } = require("node:child_process");
  const r = spawnSync("reg.exe", args, { encoding: "utf8", timeout: 8000, windowsHide: true });
  return { ok: r.status === 0, status: r.status };
}

/**
 * 注册 URL 协议。⚠️ 默认不注册（isPackaged 缺省 false），必须显式传 true。
 * @param {{platform?:string, isPackaged?:boolean, exePath?:string,
 *          run?:(args:string[])=>{ok:boolean}}} [opts]
 */
function ensureProtocol(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== "win32" || opts.isPackaged !== true) {
    return { ok: false, skipped: true, reason: platform !== "win32" ? "non-windows" : "not-packaged" };
  }
  const exe = opts.exePath || process.execPath;
  const run = typeof opts.run === "function" ? opts.run : defaultRegRun;
  const cmds = buildProtocolCommands(exe);
  for (const args of cmds) {
    try {
      const r = run(args);
      if (!r || r.ok === false) return { ok: false, skipped: false, reason: "reg-add-failed" };
    } catch {
      return { ok: false, skipped: false, reason: "reg-add-error" };
    }
  }
  return { ok: true, skipped: false, commands: cmds.length };
}

function xmlEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 生成 PowerShell 脚本：用 WinRT 发带 launch 的原生 toast。
 * `show:false` 用于零打扰验证 —— 只构造对象、不调用 Show，仍会输出 WBTOAST:OK。
 */
function buildToastScript(opts = {}) {
  const title = xmlEscape(opts.title || DEFAULT_TITLE);
  const body = xmlEscape(opts.body || DEFAULT_BODY);
  const launch = xmlEscape(opts.launch || PROTOCOL_LAUNCH);
  const aumid = xmlEscape(opts.aumid || AUMID);
  const showLine = opts.show === false
    ? "# dry-run: 只构造对象，不实际弹出通知"
    : "$notifier.Show($toast)";
  return `$ErrorActionPreference = 'Stop'
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $xml = @'
<toast launch="${launch}" activationType="protocol">
  <visual>
    <binding template="ToastGeneric">
      <text>${title}</text>
      <text>${body}</text>
    </binding>
  </visual>
</toast>
'@
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification -ArgumentList $doc
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("${aumid}")
  ${showLine}
  "${TOAST_OK_MARK}"
} catch {
  "WBTOAST:FAIL"
}`.trim();
}

function powershellExe() {
  const windir = process.env.windir || process.env.WINDIR || process.env.SystemRoot;
  return windir
    ? path.join(windir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

/** 注入点：离线测试 / 未来换实现；注入失败一律返回 false（由上层回落 Electron 通知） */
let toastRunnerOverride = null;
function setToastRunner(fn) {
  toastRunnerOverride = typeof fn === "function" ? fn : null;
}

/**
 * 发一条「点通知即授权」的原生 toast。
 * @returns {Promise<boolean>} 是否成功发出；false 时主进程回落 Electron Notification
 */
function showAuthorizationToast(opts = {}) {
  if (toastRunnerOverride) {
    try {
      return Promise.resolve(toastRunnerOverride() === true);
    } catch {
      return Promise.resolve(false);
    }
  }
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    const { spawn } = require("node:child_process");
    let out = "";
    let done = false;
    let timer = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    let child;
    try {
      const script = buildToastScript({ show: opts.show !== false });
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      child = spawn(
        powershellExe(),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
      );
    } catch {
      finish(false);
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      finish(false);
    }, TOAST_TIMEOUT_MS);
    try {
      child.stdout.on("data", (c) => { out += c.toString("utf8"); });
      child.stderr.on("data", () => {});
      child.on("error", () => finish(false));
      child.on("close", () => finish(out.indexOf(TOAST_OK_MARK) >= 0));
    } catch {
      finish(false);
    }
  });
}

module.exports = {
  AUMID,
  PROTOCOL_SCHEME,
  PROTOCOL_LAUNCH,
  PROTOCOL_RE,
  TOAST_OK_MARK,
  TOAST_TIMEOUT_MS,
  DEFAULT_TITLE,
  DEFAULT_BODY,
  isProtocolLaunch,
  buildProtocolCommands,
  ensureProtocol,
  xmlEscape,
  buildToastScript,
  setToastRunner,
  showAuthorizationToast,
};
