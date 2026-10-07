/**
 * 核对安装包内前端资源 + 版本号方案：
 *   ① index.html 引用的哈希资源是否都在 asar 里；
 *   ② 包内 CSS/JS 是否包含历史各轮的关键改动，避免"本地改了但没打进包"；
 *   ③ 安装包文件名 / 包内 package.json 是否带上了小版本号（build.buildNumber）。
 *
 * 坑：@electron/asar 的 listPackage 返回反斜杠路径，extractFile 直接喂这个路径会报
 * "was not found in this archive"。这里改用 extractAll 展开到临时目录再读文件。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
// @electron/asar 由 electron-builder 传递提供（app-builder-lib 的依赖），
// npm 扁平安装后就在 node_modules 顶层 —— 故意不写进 devDependencies：
// 一旦加了却没同步 package-lock.json，CI 的 `npm ci` 会直接 EUSAGE 失败
// （历史上 bump 工具改坏过 lock，教训见 MEMORY「发布与工具链」）。
let asar;
try {
  asar = require("@electron/asar");
} catch (e) {
  console.error("缺少 @electron/asar —— 请先 `npm ci`（它由 electron-builder 传递安装）");
  process.exit(2);
}

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const expectedName = String(pkg.buildNumber) === "0" ? `MS-Rewards-Auto-Setup-${pkg.version}.exe` : `MS-Rewards-Auto-Setup-${pkg.version}.${pkg.buildNumber}.exe`;
const exePath = path.join("dist", expectedName);

const asarPath = "dist/win-unpacked/resources/app.asar";
const allAssets = fs.readdirSync("gui-react/assets");
const html = fs.readFileSync("gui-react/index.html", "utf8");
const assets = [...html.matchAll(/assets\/([^"']+)/g)].map((m) => m[1]);
const listed = asar.listPackage(asarPath);
const has = (name) => listed.some((p) => p.split(/[\\/]/).pop() === name);

// 被核对的内容根目录。默认解包 app.asar；
// 设 VERIFY_PACK_SRC=1 时直接读工作区源码树 —— 用途是「反例验证」：
// app.asar 无法可靠重打包（extractAll 出来的空目录会让 asar 的 lstat 遍历报错），
// 所以反例脚本靠这个开关在源码上注入缺陷来验证断言，而不是去伪造 asar。
const useSrc = process.env.VERIFY_PACK_SRC === "1";
const outDir = useSrc ? process.cwd() : fs.mkdtempSync(path.join(os.tmpdir(), "asar-verify-"));
if (!useSrc) asar.extractAll(asarPath, outDir);
const cssDir = path.join(outDir, "gui-react", "assets");
const cssName = assets.find((a) => a.endsWith(".css"));
const css = fs.readFileSync(path.join(cssDir, cssName), "utf8");
const js = fs.readFileSync(
  path.join(cssDir, assets.find((a) => a.endsWith(".js"))),
  "utf8"
);
const exe = fs.statSync(exePath);
const pkgInAsar = JSON.parse(fs.readFileSync(path.join(outDir, "package.json"), "utf8"));

const strip = (s) => s.replace(/\s+/g, "");
const flat = strip(css);
const jsFlat = strip(js);
/**
 * 判定「存在这样一条 CSS 规则：某个选择器同时含 A 与 B，且声明块里有 D」。
 *
 * 为什么不写死一整段正则：前端构建器升级会改排版 ——
 *   ① CSS minifier 把同一声明的选择器**并成一条规则**（逗号分隔）；
 *   ② 后代选择器的空格可能被去掉（`.lg-glow` → `:root[data-theme=light].lg-glow`）。
 * 断言只该验证「这条规则存在、且作用于正确的选择器」，不该管构建器怎么排版。
 *
 * ⚠️ 关键：必须**按逗号切分选择器组、逐个选择器判定**。
 *    只看整条选择器串「含不含 A 和 B」会跨逗号误判 —— 实测踩过：
 *    把 `:root[data-theme=light] .lg-glow` 从合并组里摘掉后，
 *    同组还留着 `:root[data-halo=off] .lg-glow`，整条串依然「含」.lg-glow，
 *    守卫于是变绿形同虚设。教训见 MEMORY「验证与纪律」：断言要盯语义。
 */
const ruleHas = (selA, selB, decl) => {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(flat))) {
    if (!m[2].includes(decl)) continue;
    // 选择器组按逗号切开，逐个看有没有单个选择器同时命中 A 与 B
    const hit = m[1].split(",").some((sel) => sel.includes(selA) && (!selB || sel.includes(selB)));
    if (hit) return true;
  }
  return false;
};
const result = {
  exeName: path.basename(exePath),
  exeBytes: exe.size,
  exeTime: exe.mtime.toISOString(),
  assets,
  htmlRefsOk: assets.every((a) => html.includes(a)),
  asarHasAll: assets.every(has),
  extractedCss: cssName,
  // 0.9.4.2 起：行内 small 按钮统一 32px（旧的 --lg-control-height:26px 压扁方案已废弃）
  cssHasFlatButton: /\.compat-table\.lg-button\[data-control-size=small\]\{min-height:32px\}/.test(flat),
  cssHasSwitchSizing: /\.account-enabled-switch/.test(flat),
  cssHasLightMask: /30%,transparent\)/.test(flat),
  // 更早一轮：开关去掉掩膜环 / sm 控件回到 28px / 网格开关列对齐 / 面板不透明度 / 氛围光开关
  cssHasSwitchRimOff: /\.lg-switch-track\.lg-rim/.test(flat),
  cssHasCompactSm: /\.compat-sm\{min-height:28px/.test(flat),
  // 压缩后 flex:1 1 auto 会变成 flex:11auto（空格被剥掉），三种形态都接受
  cssHasGridAlign: /\.form-grid>\.field-row>div:first-child\{flex:(?:11auto|auto|1 1 auto)/.test(flat),
  cssHasPanelOpacity: /calc\(var\(--panel-opacity,1\)\*100%\)/.test(flat),
  cssHasGlowOff: /data-glow=("?)off\1/.test(flat),
  cssHasDarkSpinner: /\.compat-input\{[^}]*color-scheme:dark/.test(flat),
  // 本轮（0.9.4.4）：浅色关反射 + 氛围光提到壁纸之上 + 光晕覆盖卡片/开关
  // ⚠️ 两条断言都必须兼容多种产物形态（前端构建器升级会改排版）：
  //   ① CSS minifier 把同一声明的选择器并成一条规则；
  //   ② 后代选择器的空格可能被去掉（`.lg-glow` → `:root[data-theme=light].lg-glow`）。
  // 所以走 ruleHas() 按「选择器含谁 + 声明块含什么」判定，
  // 而不是钉死整段正则 —— 教训见 MEMORY「验证与纪律」：断言要盯语义，别盯排版。
  cssHasLightReflectOff:
    ruleHas('[data-theme=light]', '.lg-glow', "opacity:0!important") &&
    ruleHas('[data-theme=light]', '.lg-decoration:after', "opacity:0!important"),
  cssHasGlowZ1: /body:before\{[^}]*z-index:1/.test(flat),
  // 0.9.4.5 起：HALO_SELECTOR 改为 .lg-surface（带排除项） + .lg-material-view + .lg-switch-track
//   开关只绑 pill，不绑 .lg-switch 容器（避免方框）
jsHasHaloSelector:
  /\.lg-surface/.test(jsFlat) &&
  /\.lg-material-view/.test(jsFlat) &&
  /\.lg-switch-track/.test(jsFlat),
  jsHasPanelVar: jsFlat.length > 0 && /--panel-opacity/.test(jsFlat),
  // 本轮：面板不透明度下限 20%（滑块 min=20 / max=100 是全局唯一一对）
  jsHasOpacityMin20: /min:20,max:100/.test(jsFlat),
  // 0.9.4.7：光晕开关管住库 .lg-glow（data-halo=off）+ 补位组件磨砂 blur
  cssHasHaloOff: /\[data-halo=off\]\.lg-glow\{opacity:0!important/.test(flat),
  cssHasCompatBlur: /\.compat-input-wrap[\s\S]*?backdrop-filter:blur\(12px\)/.test(flat) &&
    /\.compat-modal-panel\{[\s\S]*?backdrop-filter:blur\(26px\)/.test(flat) &&
    /\.compat-toast\{[\s\S]*?backdrop-filter:blur\(20px\)/.test(flat),
  jsHasHaloAttr: /data-halo/.test(jsFlat) && /(?:"off"|`off`)/.test(jsFlat),
  // 0.9.4.10：友链 logo 容器清零库 .lg-surface 的 18px padding（否则 46px 盒
  // 内容区只剩 10×10 → 图标下坠 8/16px，用户反馈「两个图标还是歪的」）
  cssHasFriendLogoPad0: /\.friend-logo\{[^}]*padding:0/.test(flat),
  // 0.9.4.9：全局设置白屏根因（渲染层防御）。旧代码 value.goals ?? {enable,items} 在
  // 配置只有 goals.enable 缺 items 时得到 items=undefined → 抛 TypeError 白屏。
  // 修复后必须逐字段兜底：Array.isArray(...)?goals.items:[]（esbuild 会把 ?. 转成
  // ==null?void 0:，这里只锚定 Array.isArray(...)?var.goals.items:[] 这个结构）。
  jsHasGoalsDefensive: /Array\.isArray\(.+?\)\?[a-zA-Z_$][\w$]*\.goals\.items:\[\]/.test(jsFlat),
  jsHasWbSquare: /120\.842/.test(jsFlat),
  asarHasBrowserSentinel: (()=>{ const p=path.join(outDir,"src","browser.js"); if(!fs.existsSync(p)) return false; const t=fs.readFileSync(p,"utf8"); return t.includes("MS_REWARDS_HTTP_LISTENING") && t.includes("loggedIn && process.env.MS_REWARDS_HTTP_LISTENING"); })(),
  // 0.9.4.16：活动上报兜底（quiz / BingTrivia）必须真的进了包。
  // ⚠️ 这些要读 outDir 的断言必须写在 result 里：outDir 在下面会被 rmSync 清掉，
  //    放到 checks 里读到的是已被删除的目录（会假红）。
  asarHasQuizFallback: (() => {
    const p = path.join(outDir, "src", "tasks.js");
    if (!fs.existsSync(p)) return false;
    const t = fs.readFileSync(p, "utf8");
    return (
      t.includes("/msrewards/api/v1/ReportActivity") &&
      t.includes('PartnerId: "BingTrivia"') &&
      t.includes("reportActivityFallback")
    );
  })(),
  asarHasStealth: (() => {
    const p = path.join(outDir, "src", "stealth.js");
    if (!fs.existsSync(p)) return false;
    const t = fs.readFileSync(p, "utf8");
    return /get: \(\) => false/.test(t) && /--exclude-switches=enable-automation/.test(t);
  })(),
  asarBrowserWiresStealth: (() => {
    const p = path.join(outDir, "src", "browser.js");
    if (!fs.existsSync(p)) return false;
    const t = fs.readFileSync(p, "utf8");
    // 契约在 0.13.9 变了（见 scripts/selfcheck.js 同名守卫）：
    // 旧版是「每页都注入，指纹模式注入带 __MSR_FP 的 initSrc」；
    // 实测发现 addInitScript 一旦调用就会被 BrowserScan 的 Navigator 项识破，
    // 且夹具/语言/硬件全由 --fingerprint 种子统一生成，再盖一层只会造出矛盾指纹。
    // 现在：只在普通 Chromium 回落路径注入，且被 !isFp 包着。
    // 三条缺一不可：①注入点存在 ②被 !isFp 包着 ③旧的 initSrc/__MSR_FP 版本已消失。
    return (
      /launchOpts\.userAgent = stealth\.STEALTH_USER_AGENT/.test(t) &&
      /if \(!isFp\) \{\s*await context\.addInitScript\(\{ content: stealth\.STEALTH_INIT \}\);/.test(t) &&
      !/\binitSrc\b/.test(t) &&
      !/window\.__MSR_FP = true/.test(t)
    );
  })(),
  // 0.9.4.17：指纹浏览器模块必须随包分发（含 6 个镜像节点与空闲超时）
  asarHasFingerprintBrowser: (() => {
    const p = path.join(outDir, "src", "fingerprint-browser.js");
    if (!fs.existsSync(p)) return false;
    const t = fs.readFileSync(p, "utf8");
    return (
      // 0.14.6 起 PINNED_VERSION 是从 ENGINES 注册表派生的常量
      // （`PINNED_VERSION = ENGINES[DEFAULT_ENGINE].version`），不再是字面量。
      // 派生写法额外要求 ENGINES 是个**真对象字面量**：
      // 只判 `/const ENGINES\s*=/` 会被 `const ENGINES = undefined` 蒙混过关
      //（反例验证实测踩到 —— 注入 undefined 后断言仍为绿，等于没守）。
      (/PINNED_VERSION\s*=\s*"\d+\.\d+\.\d+\.\d+"/.test(t) ||
        (/PINNED_VERSION\s*=\s*ENGINES\[/.test(t) &&
          /const ENGINES\s*=\s*\{[\s\S]*?chromix[\s\S]*?\};/.test(t))) &&
      ["gh-proxy.com/", "v4.gh-proxy.org/", "v6.gh-proxy.org/", "cdn.gh-proxy.org/", "axisnow.gh-proxy.org/", "gh-proxy.org/"].every((n) =>
        t.includes(`"https://${n}"`)
      ) &&
      t.includes("IDLE_TIMEOUT_MS") &&
      // 0.9.4.18：低速熔断 + 连接超时 + 纯查询检查更新必须进包
      t.includes("STALL_MIN_BPS") &&
      t.includes("HEADER_TIMEOUT_MS") &&
      /async function checkUpdate\(\)/.test(t)
    );
  })(),
  asarBrowserHasFpWiring: (() => {
    const p = path.join(outDir, "src", "browser.js");
    if (!fs.existsSync(p)) return false;
    const t = fs.readFileSync(p, "utf8");
    // 指纹浏览器接线三件套：①按配置解析来源 ②真的把 fpBrowser 的参数拼进启动参数
    // ③指纹模式下不注入 stealth 补丁（__MSR_FP 标志已随 0.13.9 重构移除，
    //   现在用 isFp 分支表达同一语义，见上面 asarBrowserWiresStealth）。
    return (
      t.includes("resolveBrowserSource") &&
      t.includes("fpBrowser.buildArgs") &&
      /if \(!isFp\) \{\s*await context\.addInitScript/.test(t)
    );
  })(),
  // 0.9.4.17：全局默认值必须带 browser.fingerprint（否则旧配置升级后渲染层读不到 → 白屏）
  asarGlobalConfigHasBrowserFp: (() => {
    const p = path.join(outDir, "src", "global-config.js");
    if (!fs.existsSync(p)) return false;
    const t = fs.readFileSync(p, "utf8");
    const i = t.indexOf("browser: {");
    if (i < 0) return false;
    // ⚠️ 不能用 `slice(i, i + 700)` 这种固定长度窗口：
    // 0.14.6 给 fingerprint 段加了 engine / singleEngineOnly 的说明注释，
    // 固定窗口会把后面的 hardwareConcurrency / mirror 挤出去 → 断言误报，
    // 看起来像「字段没打进包」，实际是窗口不够。改为按下一个顶层段
    // （缩进 2 空格的 `}:` 或 `},`）截取真正的 browser 段，与注释长度无关。
    const after = t.slice(i);
    const m = after.slice(1).match(/\n {2}\}[,:]/);
    const block = m ? after.slice(0, m.index + 1) : after.slice(0, 4000);
    return (
      block.includes("fingerprint: {") &&
      block.includes("enable:") &&
      block.includes("seed:") &&
      block.includes("brand:") &&
      block.includes("hardwareConcurrency:") &&
      // 0.10.1：新字段 mirror 必须也在默认值里（旧配置升级后渲染层读不到就会白屏）
      block.includes("mirror:") &&
      // 0.14.6：多内核改造新增的两个字段同样必须有默认值。
      // 漏掉任一个，旧配置升级后读到 undefined —— singleEngineOnly 变 undefined
      // 会让「单内核模式」静默失效、两个内核一直占着磁盘，且没有任何报错。
      block.includes("engine:") &&
      block.includes("singleEngineOnly:")
    );
  })(),
  // 0.9.4.16：致谢区（四位参考脚本作者）进了前端 bundle
  jsHasCredits: /潘钜森/.test(jsFlat) && /SDSmalin/.test(jsFlat) && /DuskLight/.test(jsFlat) && /withfeel/.test(jsFlat),
  cssHasCredits: /\.credit-item\{/.test(flat) && /\.credit-avatar\{/.test(flat),
  // 0.9.4.17：指纹浏览器面板进了前端 bundle（设置页可选增强）
  jsHasFingerprintPanel: /fingerprintStatus/.test(jsFlat) && /环境拟真浏览器/.test(jsFlat),
  // 0.9.4.18：检查更新走纯查询通道（面板 + web 适配器都要在 bundle 里）
  jsHasFpCheckUpdate: /checkFingerprintUpdate/.test(jsFlat),
  cssHasFpBar: /\.fp-bar\{/.test(flat) && /\.fp-bar-fill\{/.test(flat),
  // 0.10.1：向导末页（跳过复选框 + 置灰区 + 加速源下拉 + 立即下载）
  jsHasWizardFpPage:
    /wz-fp-body/.test(jsFlat) &&
    /跳过，不下载环境拟真浏览器/.test(jsFlat) &&
    /立即下载/.test(jsFlat) &&
    /加速源/.test(jsFlat),
  // 0.10.1：加速源下拉（选项由主进程下发、label 已带实测延迟后缀）
  jsHasFpMirrorSelect: /wz-fp-sel/.test(jsFlat),
  // 0.10.1：侧边栏指纹浏览器徽章（就绪/未安装 + 下载中百分比与进度条）
  jsHasSidebarFpBadge: /环境拟真浏览器就绪/.test(jsFlat) && /环境拟真浏览器未安装/.test(jsFlat) && /nav-install-fill/.test(jsFlat),
  cssHasWzFpGray: /\.wz-fp-body\.is-off\{/.test(flat) && /\.wz-fp-sel\{/.test(flat) && /\.wz-fp-prog\{/.test(flat),
  asarHasServerSentinel: (()=>{ const p=path.join(outDir,"src","server.js"); if(!fs.existsSync(p)) return false; const t=fs.readFileSync(p,"utf8"); return t.includes("process.env.MS_REWARDS_HTTP_LISTENING = String(PORT)"); })(),
  jsHasLoginDoneSentinel: false /* 已被 asar 断言替代，保留键以免汇总行错位 */,
  // 版本号方案：包内 package.json 必须带 buildNumber，且 asar 里要有 version.js
  asarPkgBuildNumber: pkgInAsar.buildNumber,
  asarHasVersionModule: listed.some((p) => p.replace(/\\/g, "/").endsWith("/src/version.js")),
  // 真·运行时口径：直接 require 包内的 src/version.js，看它读包内 package.json
  // 能不能算出四段版本 —— 这正是窗口标题走的那条路径。
  packedDisplayVersion: (() => {
    try {
      return require(path.join(outDir, "src", "version.js")).displayVersion();
    } catch (e) {
      return `ERR: ${e.message}`;
    }
  })(),
  // 0.9.4.8：第三方声明 / 开源许可必须随包分发（上游 liquid-glass-react 自带
  // THIRD_PARTY_NOTICES，本项目补齐 LICENSE + THIRD_PARTY_NOTICES.md 并打进 asar）
  asarHasLicense: fs.existsSync(path.join(outDir, "LICENSE")),
  asarHasNotices: fs.existsSync(path.join(outDir, "THIRD_PARTY_NOTICES.md")),
  asarLicenseIsMit: (() => {
    const p = path.join(outDir, "LICENSE");
    if (!fs.existsSync(p)) return false;
    const t = fs.readFileSync(p, "utf8");
    return /MIT License/.test(t) && /Permission is hereby granted/.test(t);
  })(),
  // 0.9.4.9：全局设置白屏根因（数据层）。GLOBAL_DEFAULTS 必须含 goals.items:[] 兜底，
  // 否则旧配置只有 { enable: true } 时 deepMerge 补不回 items。
  asarGlobalConfigHasGoals: (() => {
    const p = path.join(outDir, "src", "global-config.js");
    if (!fs.existsSync(p)) return false;
    const t = fs.readFileSync(p, "utf8");
    return /goals:\s*\{[\s\S]*?items:\s*\[/.test(t);
  })(),
  // 0.10.1：就绪判定必须校验 chrome.dll 是「有效 PE」，否则坏 DLL（0xC1）会被当成
  // 已安装，一路走到 Playwright 启动才崩成晦涩的 launchPersistentContext 报错。
  asarFpHasPeCheck: (() => {
    const p = path.join(outDir, "src", "fingerprint-browser.js");
    if (!fs.existsSync(p)) return false;
    const t = fs.readFileSync(p, "utf8");
    return (
      /function isValidPeFile/.test(t) &&
      /MIN_DLL_BYTES/.test(t) &&
      t.includes("0x4d") &&
      t.includes("0x5a") &&
      /MIN_ASSET_BYTES/.test(t)
    );
  })(),
  // 0.10.1：镜像源可配置（标识→前缀映射 + 解析器 + 延迟探测）
  asarFpHasMirrorConfig: (() => {
    const p = path.join(outDir, "src", "fingerprint-browser.js");
    if (!fs.existsSync(p)) return false;
    const t = fs.readFileSync(p, "utf8");
    return (
      /const MIRROR_KEYS\s*=/.test(t) &&
      /const MIRROR_OPTIONS\s*=/.test(t) &&
      /function resolveMirrors/.test(t) &&
      /async function mirrorLatency/.test(t) &&
      /async function mirrorOptionsWithLatency/.test(t) &&
      t.includes("· 超时") &&
      t.includes("latencyMs")
    );
  })(),
  // 0.10.1：完整性校验以官方 sha256 digest 为准（不是打个日志就放行）
  asarFpHasSha256: (() => {
    const p = path.join(outDir, "src", "fingerprint-browser.js");
    if (!fs.existsSync(p)) return false;
    const t = fs.readFileSync(p, "utf8");
    return (
      /function sha256File/.test(t) &&
      /hit\.digest/.test(t) &&
      /err\.integrity = true/.test(t) &&
      // force 重装要清掉下载缓存，坏分片绝不续传
      /if \(o\.force\)[\s\S]{0,200}rmSync/.test(t)
    );
  })(),
  // 0.13.11：成就与统计独立页 + 法定节假日日历（休/班角标 + 节日只标当天）
  jsHasAchievementsPage: /成就与统计/.test(jsFlat) && /cal-tag-rest/.test(jsFlat) && /cal-label/.test(jsFlat),
  cssHasCalTags: /\.cal-tag-rest\{/.test(flat) && /\.cal-tag-work\{/.test(flat) && /\.cal-blue\s*\.cal-day\{/.test(flat),
  cssHasCalStats: /\.cal-stats\{/.test(flat) && /\.cal-stat-value\{/.test(flat) && /\.cal-stat-label\{/.test(flat),
  asarHasHolidayModule: (() => {
    const p = path.join(outDir, "src", "holiday.js");
    if (!fs.existsSync(p)) return false;
    const t = fs.readFileSync(p, "utf8");
    return /function dayHoliday/.test(t) && /function warmup/.test(t) && /holiday-cn/.test(t) && /isOffDay/.test(t);
  })(),
  asarHistoryLabelsOnlyFestivalDay: (() => {
    const p = path.join(outDir, "src", "history.js");
    if (!fs.existsSync(p)) return false;
    const t = fs.readFileSync(p, "utf8");
    return /label: festName \|\| lunarDayLabel\(key\)/.test(t) && /function lunarDayLabel/.test(t);
  })(),
  // 0.13.11 二次覆盖：滚轮翻月只限月份栏 + 勋章墙展开动画
  jsHasWheelScopeHint: /也可在月份栏滚轮/.test(jsFlat),
  jsHasBadgeAnimWrap: /cal-badges-wrap/.test(jsFlat) && /cal-badges-inner/.test(jsFlat),
  cssHasBadgeAnim: /\.cal-badges-wrap\{/.test(flat) && /\.cal-badges-wrap\.open\{/.test(flat) && /grid-template-rows/.test(flat),
  // 批次4：日历字号流式缩放（容器查询 + clamp/cqw；flat 剥空白后容器查询写法不变）
  cssHasCalFluid: /container-type:inline-size/.test(flat) && /\.cal-day\{[^}]*font-size:clamp\([^)]*cqw/.test(flat) && /\.cal-label\{[^}]*font-size:clamp\([^)]*cqw/.test(flat),
  // 0.13.14：Web 成就页限定作用域的紧凑字号与日历格高度上限
  cssHasCompactAchievements: /:root\[data-web="?1"?\]\s*\.achievements-view\s*\.cal-stat-value\{[^}]*font-size:clamp\(18px,1\.7cqw,26px\)/.test(flat) &&
    /:root\[data-web="?1"?\]\s*\.achievements-view\s*\.cal-cell\{[^}]*height:clamp\(68px,6\.5cqw,96px\)/.test(flat) &&
    /:root\[data-web="?1"?\]\s*\.achievements-view\s*\.cal-bname\{[^}]*font-size:clamp\(10px,1\.05cqw,14px\)/.test(flat),
  // 0.13.14 二次反馈：桌面全屏不再铺满 —— 限宽居中 + 勋章墙右移 + 字号封顶
  cssHasAchievementsWidthCap: /\.achievements-view\{[^}]*max-width:1460px[^}]*margin-inline:auto/.test(flat),
  // ⚠️ 媒体查询同时兼容 `@media(min-width:1280px)`（旧）与 `@media (width>=1280px)`（新构建器）
  cssHasBadgesSideColumn:
    /@media\s*\(min-width:1280px\)\s*\{\.achievements-view\.cal-card\{[^}]*clamp\(300px,32cqw,420px\)[^}]*"calbadges"[\s\S]*?"legendbadges"/.test(flat) ||
    /@media\s*\(width>=1280px\)\s*\{\.achievements-view\.cal-card\{[^}]*clamp\(300px,32cqw,420px\)[^}]*"calbadges"[\s\S]*?"legendbadges"/.test(flat),
  cssHasBadgesGridArea:
    /\.achievements-view\.cal-grid\{grid-area:cal\}/.test(flat) &&
    /\.achievements-view\.cal-badges-col\{[^}]*grid-area:badges/.test(flat),
  // 注意：0.13.14 二次反馈把 17/30 与 20/32 收小到 15/23 与 18/25，
  // 断言必须跟着改 —— 历史断言会随方案演进而过期（见 MEMORY「验证与纪律」）。
  cssHasAchievementsFontCap: /\.achievements-view\.cal-day\{font-size:clamp\(15px,1\.8cqw,23px\)\}/.test(flat) &&
    /\.achievements-view\.cal-stat-value\{font-size:clamp\(18px,2\.1cqw,25px\)\}/.test(flat),
  jsHasBadgesCol: /cal-badges-col/.test(jsFlat),
  // 0.13.12：默认数量（read/search=6）+ 标题栏一言 + 关于页一言板块
  asarLimitsDefaults6: (() => {
    try {
      const t = fs.readFileSync(path.join(outDir, "src", "global-config.js"), "utf8");
      return /read:\s*6/.test(t) && /search:\s*6/.test(t);
    } catch {
      return false;
    }
  })(),
  jsHasWindowSubtitle:
    /setWindowSubtitle/.test(jsFlat) &&
    (() => {
      try {
        return /window:setSubtitle/.test(fs.readFileSync(path.join(outDir, "src", "electron-main.js"), "utf8"));
      } catch {
        return false;
      }
    })(),
  jsHasAboutQuote: /每日一言/.test(js) && /about-quote/.test(jsFlat),
  cssHasAboutQuote: /\.about-quote\{/.test(flat) && /\.about-quote-text\{/.test(flat),
  // 0.13.13：一言句子类型（接口 c 参数，可多选）+ hitokoto.cn 友情链接
  asarHasHkTypeApi: (() => {
    try {
      const t = fs.readFileSync(path.join(outDir, "src", "hitokoto.js"), "utf8");
      // 类型表 a–l + 拼 c 参数 + 归一化，三处都在包内
      // （反引号不能放进正则字面量，用字符串 includes）
      return /抖机灵/.test(t) && t.includes("params.push(`c=") && t.includes("normalizeTypes") && t.includes("buildUrl");
    } catch {
      return false;
    }
  })(),
  asarHkTypesDefaultsBlank: (() => {
    try {
      const t = fs.readFileSync(path.join(outDir, "src", "global-config.js"), "utf8");
      return /hitokotoTypes:\s*\[\]/.test(t);
    } catch {
      return false;
    }
  })(),
  jsHasHkTypeChips:
    /\.hk-chip\{/.test(flat) &&
    /\.hk-chip\.active\{/.test(flat) &&
    jsFlat.includes("hitokotoTypes") &&
    jsFlat.includes("全部（不限）"),
  jsHasHkFriendLink: jsFlat.includes("hitokoto.cn") && jsFlat.includes("favicon.ico"),
};
console.log(JSON.stringify(result, null, 2));
// 只清理自己解包出来的临时目录；源码模式下 outDir 就是工作区根，绝不能删
if (!useSrc) fs.rmSync(outDir, { recursive: true, force: true });

const checks = {
  exeNameMatchesScheme: path.basename(exePath) === expectedName,
  htmlRefsOk: result.htmlRefsOk,
  asarHasAll: result.asarHasAll,
  cssHasFlatButton: result.cssHasFlatButton,
  cssHasLightMask: result.cssHasLightMask,
  cssHasSwitchRimOff: result.cssHasSwitchRimOff,
  cssHasCompactSm: result.cssHasCompactSm,
  cssHasGridAlign: result.cssHasGridAlign,
  cssHasPanelOpacity: result.cssHasPanelOpacity,
  cssHasGlowOff: result.cssHasGlowOff,
  cssHasDarkSpinner: result.cssHasDarkSpinner,
  cssHasLightReflectOff: result.cssHasLightReflectOff,
  cssHasGlowZ1: result.cssHasGlowZ1,
  jsHasHaloSelector: result.jsHasHaloSelector,
  jsHasPanelVar: result.jsHasPanelVar,
  jsHasOpacityMin20: result.jsHasOpacityMin20,
  cssHasHaloOff: result.cssHasHaloOff,
  cssHasCompatBlur: result.cssHasCompatBlur,
  jsHasHaloAttr: result.jsHasHaloAttr,
  asarPkgHasBuildNumber: /^\d+$/.test(String(result.asarPkgBuildNumber || "")),
  asarHasVersionModule: result.asarHasVersionModule,
  // 包内运行时能算出四段版本（= 窗口标题会显示 0.9.4.1）
  packedDisplayVersion4Seg: result.packedDisplayVersion === (String(pkg.buildNumber) === "0" ? String(pkg.version) : `${pkg.version}.${pkg.buildNumber}`),
  asarHasLicense: result.asarHasLicense,
  asarHasNotices: result.asarHasNotices,
  asarLicenseIsMit: result.asarLicenseIsMit,
  jsHasGoalsDefensive: result.jsHasGoalsDefensive,
  asarGlobalConfigHasGoals: result.asarGlobalConfigHasGoals,
  cssHasFriendLogoPad0: result.cssHasFriendLogoPad0,
  asarHasBrowserSentinel: result.asarHasBrowserSentinel,
  asarHasServerSentinel: result.asarHasServerSentinel,
  asarHasQuizFallback: result.asarHasQuizFallback,
  asarHasStealth: result.asarHasStealth,
  asarBrowserWiresStealth: result.asarBrowserWiresStealth,
  jsHasCredits: result.jsHasCredits,
  cssHasCredits: result.cssHasCredits,
  asarHasFingerprintBrowser: result.asarHasFingerprintBrowser,
  asarBrowserHasFpWiring: result.asarBrowserHasFpWiring,
  asarGlobalConfigHasBrowserFp: result.asarGlobalConfigHasBrowserFp,
  jsHasFingerprintPanel: result.jsHasFingerprintPanel,
  cssHasFpBar: result.cssHasFpBar,
  // —— 0.10.1 ——
  asarFpHasPeCheck: result.asarFpHasPeCheck,
  asarFpHasMirrorConfig: result.asarFpHasMirrorConfig,
  asarFpHasSha256: result.asarFpHasSha256,
  jsHasWizardFpPage: result.jsHasWizardFpPage,
  jsHasFpMirrorSelect: result.jsHasFpMirrorSelect,
  jsHasSidebarFpBadge: result.jsHasSidebarFpBadge,
  cssHasWzFpGray: result.cssHasWzFpGray,
  // —— 0.13.11：成就与统计独立页 + 节假日日历 ——
  jsHasAchievementsPage: result.jsHasAchievementsPage,
  cssHasCalTags: result.cssHasCalTags,
  cssHasCalStats: result.cssHasCalStats,
  asarHasHolidayModule: result.asarHasHolidayModule,
  asarHistoryLabelsOnlyFestivalDay: result.asarHistoryLabelsOnlyFestivalDay,
  jsHasWheelScopeHint: result.jsHasWheelScopeHint,
  jsHasBadgeAnimWrap: result.jsHasBadgeAnimWrap,
  cssHasBadgeAnim: result.cssHasBadgeAnim,
  cssHasCalFluid: result.cssHasCalFluid,
  cssHasCompactAchievements: result.cssHasCompactAchievements,
  cssHasAchievementsWidthCap: result.cssHasAchievementsWidthCap,
  cssHasBadgesSideColumn: result.cssHasBadgesSideColumn,
  cssHasBadgesGridArea: result.cssHasBadgesGridArea,
  cssHasAchievementsFontCap: result.cssHasAchievementsFontCap,
  jsHasBadgesCol: result.jsHasBadgesCol,
  // —— 0.13.12：默认数量 + 标题栏一言 + 关于页一言 ——
  asarLimitsDefaults6: result.asarLimitsDefaults6,
  jsHasWindowSubtitle: result.jsHasWindowSubtitle,
  jsHasAboutQuote: result.jsHasAboutQuote,
  cssHasAboutQuote: result.cssHasAboutQuote,
  // 0.13.13：句子类型 + 友情链接
  asarHasHkTypeApi: result.asarHasHkTypeApi,
  asarHkTypesDefaultsBlank: result.asarHkTypesDefaultsBlank,
  jsHasHkTypeChips: result.jsHasHkTypeChips,
  jsHasHkFriendLink: result.jsHasHkFriendLink,
};
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
if (failed.length) {
  console.error("核对失败:", failed.join(", "));
  process.exit(1);
}
console.log(`核对通过: ${Object.keys(checks).length} 项`);
