/**
 * 桌面任务弹窗前的「用户场景」抑制（2026-11-22 用户定）。
 *
 * 用户要求：
 *   ① 前台窗口处于全屏状态 **且** CPU 或 GPU 任一占用过高 → 跳过弹窗
 *      （2026-11-22 用户追加：原为「两者都高」的 AND，改为 OR，满足其一即生效）；
 *   ② 用户在看视频 → 跳过弹窗（用户建议「GPU 的 video codec 持续工作」，并让想个好办法）。
 *
 * 【好办法 = 系统勿扰状态 + GPU 视频引擎双采样 + 全屏高负载，任一命中即抑制】
 *   1) SHQueryUserNotificationState —— 微软官方对「现在适不适合弹通知」的回答。
 *      QUNS_RUNNING_D3D_FULL_SCREEN(3) / QUNS_PRESENTATION_MODE(4) 正是全屏游戏、
 *      全屏放映（很多全屏播放器就是 4）；QUNS_BUSY(2) / QUNS_QUIET_TIME(6) 是系统级
 *      勿扰。比自己拿窗口矩形猜「是不是全屏」准得多，还顺带覆盖「在看视频」。
 *   2) GPU Video Codec / Video Decode 引擎**连续两次**采样都忙 → 硬解视频正在播
 *      （浏览器在线视频、本地播放器都会走它）。「持续」二字靠两次采样落实，
 *      单次抖动（网页里一张 JPEG 硬解）不算。本机 2026-11-22 实测引擎名：
 *      `engtype_Video Codec Engine` / `engtype_Video Decode 1` / `engtype_Video Codec 0`
 *      / `engtype_Video JPEG 0`，统一按 `engtype_Video` 前缀匹配。
 *      ⚠️ **必须再把解码归因到进程**：引擎名里带 `pid_<PID>_`，用
 *      `GetWindowThreadProcessId(GetForegroundWindow())` 拿前台窗口 PID，
 *      只有「持续解码的进程属于前台应用（同 PID / 父子 / 同进程名）」才算在看视频。
 *   3) 前台窗口矩形覆盖整屏 + (CPU 高 OR GPU 高) → 用户明确要的那条。
 *      ⚠️ 2026-11-22 用户改判：CPU/GPU 之间是**或**，全屏前提保留；两个硬件指标
 *      只要有一个过高就抑制（读不到某一项时另一项高也算，不能因 -1 把另一路带废）。
 *
 * 【动态壁纸的坑（2026-11-22 用户追问后补）】本机实测装了 Wallpaper Engine
 * （`wallpaper64.exe`），GPU 引擎实例里就有它。视频类壁纸会**整天持续硬解**，
 * 若只看「Video 引擎连续两次忙」就会一直判成「在看视频」→ 弹窗被永久抑制、
 * notify 模式等于失效；3D 类壁纸还会把 GPU 总占用抬高，误触发第 3) 条。
 * 处置：
 *   · 壁纸 / 桌面装饰进程（wallpaper / lively / rainmeter / deskscape …）的 Video
 *     引擎活动一律不算「用户在看」，同时**从 GPU 总占用里剔除**它们占的引擎；
 *   · 有持续解码但全部来自壁纸或未聚焦进程 → 明确返回不抑制（reason=
 *     `background-video`），绝不静默卡死通知；
 *   · 进程名/路径含中文时 stdout 会 GBK 乱码，所以**所有归因判定都在 PowerShell
 *     内部做完，只输出 ASCII 的布尔与数字**，不把进程名传回 Node。
 * 局限：CPU 用的是整机 LoadPercentage，无法按进程剔除；壁纸一般不会把 CPU 拉到 60%。
 *
 * 【为什么用 WMI 类名而不是 Get-Counter 计数器路径】
 * `Get-Counter '\GPU Engine(*)\Utilization Percentage'` 的计数器名随系统语言本地化
 * （中文系统是「GPU 引擎」），硬编码英文路径在中文机上直接失败 —— 本项目已经在
 * `query.exe user` 的中文「无」上踩过一次。WMI 类名
 * `Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine` 与 `Win32_Processor`
 * 是英文且跨语言稳定，实测本机 803 行、含 Name / UtilizationPercentage，正好够用。
 *
 * 【fail-open】探针失败 / 非 Windows / 解析不了 → 返回 null，上层不抑制。
 * 绝不能因为读不到状态就把 notify 模式整体卡死（与 idle-unknown 同一原则）。
 *
 * 【只在「准备弹窗」时调一次】探针含一次 Add-Type 编译 + 两次 WMI 采样（约 2~4 秒），
 * 不做常驻轮询；30 秒巡检里只有 episode 真正触发时才会走到这里。
 */
"use strict";

const path = require("node:path");

/** 判定阈值（导出给离线用例与 selfcheck 守卫锁死） */
const THRESHOLDS = {
  /** CPU 平均负载 ≥ 此值算「过高」 */
  CPU_HIGH_PCT: 60,
  /** GPU 各引擎利用率之和 ≥ 此值算「过高」 */
  GPU_HIGH_PCT: 50,
  /** 视频引擎利用率 ≥ 此值算「在工作」（WMI 是整数百分比，1080p 硬解常只有 1~3） */
  VIDEO_MIN_PCT: 1,
  /** 系统级勿扰：BUSY / 全屏 D3D / 演示模式 / 专注助手 */
  DND_QUNS: [2, 3, 4, 6],
};

const SAMPLE_GAP_MS = 900;
const PROBE_TIMEOUT_MS = 15000;
const PROBE_MARK = "WBPROBE:";

/**
 * 动态壁纸 / 桌面装饰进程名特征（ASCII 正则，PowerShell 侧按进程名与路径匹配）。
 * 这些进程的视频解码与 3D 渲染都不算「用户在看视频」，也不计入 GPU 高占用。
 */
const WALLPAPER_PROC_RE = "wallpaper|lively|rainmeter|deskscape|dreamscene|webwallpaper";

/**
 * 判定是否跳过弹窗（纯函数，便于离线测试）。
 * @param {{ok:boolean, quns?:number, fullscreen?:boolean, cpu?:number, gpu?:number,
 *          videoActive?:boolean, videoUserFacing?:boolean, videoWallpaperOnly?:boolean}|null} snapshot
 * @param {object} [thresholds] 可覆盖阈值
 * @returns {{suppress:boolean, reason:string, detail:string}}
 */
function evaluatePresence(snapshot, thresholds) {
  const t = { ...THRESHOLDS, ...(thresholds || {}) };
  if (!snapshot || snapshot.ok !== true) {
    return { suppress: false, reason: "probe-unavailable", detail: "场景探针不可用，按原计划弹窗（fail-open）" };
  }
  // ① 看视频：视频解码持续工作 **且已归因到前台应用**（动态壁纸不算）
  // ⚠️ 不能用裸 videoActive：视频壁纸会整天硬解，只看它会让 notify 永久不弹窗。
  if (snapshot.videoUserFacing === true) {
    return { suppress: true, reason: "video", detail: "检测到前台应用持续占用 GPU 视频编解码引擎（正在播放视频）" };
  }
  // （后台 / 动态壁纸的放行判定放在最后，见 ④ —— 它不能覆盖系统勿扰与全屏高负载）
  // ② 系统级勿扰 / 全屏放映 / 全屏 D3D 游戏
  const q = Number(snapshot.quns);
  const dnd = Array.isArray(t.DND_QUNS) ? t.DND_QUNS : THRESHOLDS.DND_QUNS;
  if (dnd.indexOf(q) >= 0) {
    return { suppress: true, reason: "dnd", detail: `系统处于勿扰 / 全屏状态（QUNS=${q}）` };
  }
  // ③ 2026-11-22 用户改：全屏前提下，CPU / GPU **任一**过高即抑制（原为两者都高才抑制）
  const cpu = Number(snapshot.cpu);
  const gpu = Number(snapshot.gpu);
  const cpuHigh = Number.isFinite(cpu) && cpu >= Number(t.CPU_HIGH_PCT);
  const gpuHigh = Number.isFinite(gpu) && gpu >= Number(t.GPU_HIGH_PCT);
  if (snapshot.fullscreen === true && (cpuHigh || gpuHigh)) {
    const which = [cpuHigh ? `CPU ${cpu}%` : "", gpuHigh ? `GPU ${gpu}%` : ""].filter(Boolean).join(" / ");
    return { suppress: true, reason: "fullscreen-heavy", detail: `前台窗口全屏且 ${which} 占用过高` };
  }
  // ④ 后台 / 动态壁纸的持续解码：所有抑制判定都走完后才明确放行。
  //    既不能把通知静默卡死，也不能反过来覆盖系统勿扰 / 全屏高负载。
  if (snapshot.videoWallpaperOnly === true) {
    return { suppress: false, reason: "background-video", detail: "检测到后台视频解码（动态壁纸或未聚焦播放器），不算用户在看视频" };
  }
  return { suppress: false, reason: "ok", detail: "" };
}

function numOr(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** 解析探针输出；容忍 BOM、PowerShell 的其他输出行、尾随换行 */
function parseProbeOutput(out) {
  const txt = String(out == null ? "" : out).replace(/^\uFEFF/, "");
  const i = txt.indexOf(PROBE_MARK);
  if (i < 0) return null;
  const tail = txt.slice(i + PROBE_MARK.length);
  const a = tail.indexOf("{");
  const b = tail.indexOf("}", a + 1);
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(tail.slice(a, b + 1));
    return {
      ok: o.ok === true,
      quns: numOr(o.quns, 5),
      fullscreen: o.fullscreen === true,
      cpu: numOr(o.cpu, -1),
      gpu: numOr(o.gpu, -1),
      video: numOr(o.video, 0),
      videoActive: o.videoActive === true,
      videoUserFacing: o.videoUserFacing === true,
      videoWallpaperOnly: o.videoWallpaperOnly === true,
      wallpaperGpu: numOr(o.wallpaperGpu, 0),
      foregroundPid: numOr(o.foregroundPid, 0),
    };
  } catch {
    return null;
  }
}

/**
 * PowerShell 探针脚本。输出单行 `WBPROBE:{...}`，全 ASCII，不受代码页影响。
 * 用 -EncodedCommand 传入，避开命令行引号 / 转义 / 中文编码问题。
 */
const PROBE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$cs = @'
using System;
using System.Runtime.InteropServices;
public static class WBDesktopPresence {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int s);
  public static int Quns() { int s = 5; try { SHQueryUserNotificationState(out s); } catch {} return s; }
  public static bool Fullscreen() {
    RECT r; if (!GetWindowRect(GetForegroundWindow(), out r)) return false;
    int w = GetSystemMetrics(0), h = GetSystemMetrics(1);
    return r.L <= 0 && r.T <= 0 && r.R >= w && r.B >= h;
  }
  public static uint FgPid() { uint p = 0; GetWindowThreadProcessId(GetForegroundWindow(), out p); return p; }
}
'@
try { Add-Type -TypeDefinition $cs -ErrorAction Stop }
catch { Write-Output 'WBPROBE:{"ok":false}'; exit 0 }

# 动态壁纸 / 桌面装饰进程：它们的视频解码与 3D 渲染都不算「用户在看视频」
$WALL_RE = '${WALLPAPER_PROC_RE}'
$procMap = @{}
foreach ($p in @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue)) {
  $isWall = ([string]$p.Name -match $WALL_RE) -or ([string]$p.ExecutablePath -match 'wallpaper|lively|rainmeter')
  $procMap[[int]$p.ProcessId] = @{ Name = [string]$p.Name; Parent = [int]$p.ParentProcessId; IsWall = $isWall }
}

function Sample-Gpu {
  $rows = @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue)
  $sum = 0.0; $wallSum = 0.0; $video = @{}
  foreach ($r in $rows) {
    $u = [double]$r.UtilizationPercentage
    # ⚠️ 先存 PID 再判引擎类型：连续两次 -match 会覆盖 $Matches（本机实测踩过，PID 会变 0）
    $procId = 0
    if ($r.Name -match '^pid_(\d+)_') { $procId = [int]$Matches[1] }
    if ($procMap.ContainsKey($procId) -and $procMap[$procId].IsWall) { $wallSum += $u }
    else { $sum += $u }
    if ($r.Name -match 'engtype_Video') {
      if (-not $video.ContainsKey($procId)) { $video[$procId] = 0.0 }
      $video[$procId] += $u
    }
  }
  return @{ sum = $sum; wall = $wallSum; video = $video; count = $rows.Count }
}
function Sample-Cpu {
  $v = @(Get-CimInstance -ClassName Win32_Processor -ErrorAction SilentlyContinue | ForEach-Object { [double]$_.LoadPercentage })
  if ($v.Count -eq 0) { return -1 }
  return ($v | Measure-Object -Average).Average
}
function Video-Total($h) {
  $t = 0.0
  foreach ($k in $h.Keys) { $t += $h[$k] }
  return $t
}

$s1 = Sample-Gpu; $c1 = Sample-Cpu
Start-Sleep -Milliseconds ${SAMPLE_GAP_MS}
$s2 = Sample-Gpu; $c2 = Sample-Cpu

$fgPid = [int][WBDesktopPresence]::FgPid()
$fgName = ''; $fgIsWall = $false
if ($procMap.ContainsKey($fgPid)) { $fgName = $procMap[$fgPid].Name; $fgIsWall = $procMap[$fgPid].IsWall }

# 「持续」= 同一个 PID 的 Video 引擎两次采样都 ≥ 阈值；再归因：排除壁纸 + 关联前台窗口
$persistent = @()
foreach ($procId in $s1.video.Keys) {
  if ($s1.video[$procId] -ge ${THRESHOLDS.VIDEO_MIN_PCT} -and
      $s2.video.ContainsKey($procId) -and $s2.video[$procId] -ge ${THRESHOLDS.VIDEO_MIN_PCT}) {
    $persistent += $procId
  }
}
$videoActive = ($persistent.Count -gt 0)
$videoUserFacing = $false
foreach ($procId in $persistent) {
  if ($procMap.ContainsKey($procId) -and $procMap[$procId].IsWall) { continue }
  $related = ($procId -eq $fgPid)
  if ($procMap.ContainsKey($procId)) {
    if ($procMap[$procId].Parent -eq $fgPid) { $related = $true }
    if ($fgName -ne '' -and $procMap[$procId].Name -eq $fgName) { $related = $true }
  }
  if ($related -and -not $fgIsWall) { $videoUserFacing = $true }
}
$videoWallpaperOnly = ($videoActive -and -not $videoUserFacing)

$q = [WBDesktopPresence]::Quns()
$f = [WBDesktopPresence]::Fullscreen()
$cpuVals = @($c1, $c2) | Where-Object { $_ -ge 0 }
$cpu = if ($cpuVals.Count -gt 0) { [math]::Round((($cpuVals | Measure-Object -Average).Average), 1) } else { -1 }
# ⚠️ gpu 已剔除壁纸进程占用的引擎，否则 3D 动态壁纸会把「全屏 + GPU 高」误触发
$gpu = [math]::Round([math]::Max($s1.sum, $s2.sum), 1)
$wallGpu = [math]::Round([math]::Max($s1.wall, $s2.wall), 1)
$videoMin = [math]::Round([math]::Min((Video-Total $s1.video), (Video-Total $s2.video)), 1)
$ok = ($s1.count -gt 0 -and $s2.count -gt 0)
$obj = [ordered]@{
  ok = $ok; quns = $q; fullscreen = $f; cpu = $cpu; gpu = $gpu;
  video = $videoMin; videoActive = $videoActive; videoUserFacing = $videoUserFacing;
  videoWallpaperOnly = $videoWallpaperOnly; wallpaperGpu = $wallGpu; foregroundPid = $fgPid
}
Write-Output ('WBPROBE:' + ($obj | ConvertTo-Json -Compress))
`.trim();

function powershellExe() {
  const windir = process.env.windir || process.env.WINDIR || process.env.SystemRoot;
  return windir
    ? path.join(windir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

/** Windows 采样；非 Windows / 超时 / 出错 → null（fail-open） */
function probeWindowsPresence() {
  if (process.platform !== "win32") return Promise.resolve(null);
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
      const encoded = Buffer.from(PROBE_SCRIPT, "utf16le").toString("base64");
      child = spawn(
        powershellExe(),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
      );
    } catch {
      finish(null);
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      finish(null);
    }, PROBE_TIMEOUT_MS);
    try {
      child.stdout.on("data", (c) => { out += c.toString("utf8"); });
      child.stderr.on("data", () => {});
      child.on("error", () => finish(null));
      child.on("close", () => finish(parseProbeOutput(out)));
    } catch {
      finish(null);
    }
  });
}

/** 注入点（离线测试 / 未来换 Electron 原生实现）；注入失败一律 fail-open */
let presenceProbeOverride = null;
function setPresenceProbe(fn) {
  presenceProbeOverride = typeof fn === "function" ? fn : null;
}

async function readPresence() {
  if (presenceProbeOverride) {
    try {
      const v = await presenceProbeOverride();
      return v === undefined ? null : v;
    } catch {
      return null; // 注入实现异常也不能卡住通知
    }
  }
  return probeWindowsPresence();
}

module.exports = {
  THRESHOLDS,
  SAMPLE_GAP_MS,
  PROBE_TIMEOUT_MS,
  PROBE_MARK,
  WALLPAPER_PROC_RE,
  PROBE_SCRIPT,
  evaluatePresence,
  parseProbeOutput,
  probeWindowsPresence,
  setPresenceProbe,
  readPresence,
};
