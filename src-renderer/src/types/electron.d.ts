import type {
  Account,
  AccountLogEntry,
  AccountMeta,
  AccountRunStatusMap,
  AppConfig,
  Appearance,
  AppearanceSetResult,
  BgSrcResult,
  BgProgress,
  CheckAppUpdateResult,
  CheckFingerprintUpdateResult,
  ChromiumStatus,
  CloseAction,
  DeepPartial,
  DownloadResult,
  FingerprintStatus,
  HistorySnapshot,
  Hitokoto,
  InstallBrowserResult,
  InstallFingerprintResult,
  InstallProgress,
  LaunchConfig,
  Overview,
  PushTestResult,
  RunAllOptions,
  RunResult,
  SaveTextResult,
  SetupState,
  TestUrlResult,
  UpdateDownloadProgress,
  UpdateDownloadResult,
  VaultResult,
  VaultStatus,
  WipeResult,
} from "./index";

/**
 * src/electron-preload.js 通过 contextBridge 暴露的接口。
 * 这里的签名必须与 preload 严格一一对应，改动 preload 时同步更新本文件。
 */
export interface ElectronApi {
  // ---- 账户 ----
  listAccounts(): Promise<Account[]>;
  createAccount(name: string): Promise<AccountMeta>;
  removeAccount(id: string): Promise<boolean>;
  /** 保留账户元信息，只清空该账户的配置、状态、Cookie/令牌与历史日志 */
  clearAccountData(id: string): Promise<{ ok: boolean; error?: string }>;
  renameAccount(id: string, name: string): Promise<unknown>;
  setAccountEnabled(id: string, enabled: boolean): Promise<unknown>;

  // ---- 账户配置 ----
  getConfig(id: string): Promise<AppConfig>;
  setConfig(id: string, patch: DeepPartial<AppConfig>): Promise<AppConfig>;
  /** 账户的独立覆盖值（未覆盖的字段回落全局） */
  getOverrides(id: string): Promise<DeepPartial<AppConfig>>;
  setUseGlobal(id: string, v: boolean): Promise<unknown>;

  // ---- 全局配置 ----
  getGlobalConfig(): Promise<AppConfig>;
  setGlobalConfig(patch: DeepPartial<AppConfig>): Promise<AppConfig>;

  // ---- 仪表盘 ----
  overview(): Promise<Overview>;
  /** 某账户某月的日历 + 连续签到 + 勋章计数（year/month 缺省为当前月） */
  getHistory(id: string, year?: number, month?: number): Promise<HistorySnapshot>;

  // ---- 外观 ----
  getAppearance(): Promise<Appearance>;
  setAppearance(patch: Partial<Appearance>): Promise<AppearanceSetResult>;
  /** auth=true 时按登录页/向导背景（authBg）解析，与主界面 bgType 无关 */
  getBgSrc(opts?: { fresh?: boolean; auth?: boolean }): Promise<BgSrcResult>;
  pickImage(): Promise<string | null>;
  testBgUrl(url: string): Promise<TestUrlResult>;
  downloadWallpaper(url: string): Promise<DownloadResult>;
  /** 把文本（恢复密钥）存成 txt，弹窗让用户选保存位置；canceled=true 表示用户取消 */
  saveTextFile(text: string, defaultName?: string): Promise<SaveTextResult>;

  // ---- 启动与托盘 ----
  getLaunch(): Promise<LaunchConfig>;
  setLaunch(patch: Partial<LaunchConfig>): Promise<LaunchConfig>;
  /** 关闭窗口「每次询问」选项卡的选择；remember=true 时存为默认关闭行为 */
  closeChoice(choice: Exclude<CloseAction, "ask">, remember: boolean): Promise<{ ok: boolean }>;
  /** 主进程拦截到关闭请求且行为为「每次询问」时推送；返回退订函数 */
  onClosePrompt(cb: () => void): () => void;

  // ---- 首次启动向导 ----
  getSetup(): Promise<SetupState>;
  setSetup(patch: Partial<SetupState>): Promise<SetupState>;

  // ---- 保险库（登录态加密） ----
  getVaultStatus(): Promise<VaultStatus>;
  /** 首次设置：用密码建库，返回恢复密钥 */
  vaultSetup(password: string, hint?: string): Promise<VaultResult>;
  /** remember：仅 Web 版有效 —— 勾选后会话 cookie 有效期 6 小时（免登录），否则关浏览器即失效 */
  vaultUnlock(password: string, remember?: boolean): Promise<VaultResult>;
  /** 用恢复密钥解锁（忘记密码时） */
  vaultUnlockRecovery(key: string, remember?: boolean): Promise<VaultResult>;
  vaultLock(): Promise<VaultStatus>;
  vaultChangePassword(current: string, next: string, hint?: string): Promise<VaultResult>;
  /** 取恢复密钥（仅已解锁时可用，内部会轮换一把新的） */
  vaultRecoveryKey(): Promise<VaultResult>;
  /** 忘记密码：用恢复密钥重置密码（无需原密码，主密钥不变） */
  vaultResetPasswordWithRecovery(
    key: string,
    next: string,
    hint?: string
  ): Promise<VaultResult>;
  /**
   * 忘记密码且恢复密钥也丢失：清空全部账号数据（含保险库与历史日志），
   * 个性化设置与启动设置保留（壁纸 API 密钥作为凭据一并清除）。
   */
  wipeAccountData(): Promise<WipeResult>;
  /** 删除一枚通行密钥（仅 Web/Docker 有实现；桌面版返回不支持） */
  passkeyRemove(id: string): Promise<{ ok: boolean; error?: string }>;

  // ---- 每日一言 ----
  /**
   * 取当天的一言（后端按天缓存，界面与推送共用同一句）。
   * 接口不可用/未取到时返回 null，界面据此隐藏该区域。
   */
  getHitokoto(): Promise<Hitokoto | null>;

  /**
   * 把一言送到窗口原生标题栏（仅「标题栏」位置时调用）。
   * 传空串恢复原标题；浏览器 / mock 环境为 no-op。
   */
  setWindowSubtitle(text: string): Promise<boolean>;

  // ---- 推送测试 ----
  testPush(notice: AppConfig["notice"]): Promise<PushTestResult>;

  // ---- 任务 ----
  login(id: string): Promise<RunResult>;
  run(id: string, opts?: RunAllOptions): Promise<RunResult>;
  /** opts.force = 一次性完成模式：忽略单次执行数量限制，一轮做完当天全部任务 */
  runAll(opts?: RunAllOptions): Promise<RunResult>;
  /** 运行勾选的多个账号（串行 + 账号间随机 20–60 秒） */
  runSelected(ids: string[]): Promise<RunResult>;
  sync(id: string): Promise<RunResult>;
  stop(): Promise<{ ok: boolean; error?: string }>;
  /** 只停止单个账号（正在执行则中断该账号；排队中则移除） */
  stopAccount(id: string): Promise<{ ok: boolean; error?: string }>;
  isRunning(): Promise<boolean>;
  /** 每账号运行态快照 */
  getRunStatus(): Promise<AccountRunStatusMap>;

  // ---- 日志与环境 ----
  getLogs(): Promise<string[]>;
  /** 某账号的最近日志（详情页只显示该账号） */
  getAccountLogs(id: string): Promise<AccountLogEntry[]>;
  /** 某账号有历史日志的日期列表（新日期在前） */
  getAccountLogDays(id: string): Promise<string[]>;
  /** 某账号指定日期的历史日志 */
  getAccountLogHistory(id: string, day: string): Promise<AccountLogEntry[]>;
  chromiumStatus(): Promise<ChromiumStatus>;
  installBrowser(): Promise<InstallBrowserResult>;

  // ---- 环境拟真浏览器（可选增强）----
  fingerprintStatus(): Promise<FingerprintStatus>;
  /** 下载并安装环境拟真浏览器（约 181MB，走 gh-proxy 镜像链）；force 为 true 时强制重装 */
  installFingerprint(opts?: { force?: boolean }): Promise<InstallFingerprintResult>;
  /** 取消当前环境拟真浏览器下载任务 */
  cancelFingerprintInstall(): Promise<{ ok: boolean; error?: string }>;
  /**
   * 卸载环境拟真浏览器。
   * @param payload.engine 指定卸哪个内核（多内核时用来卸「非当前」的那个）；不传则卸当前。
   */
  uninstallFingerprint(payload?: { engine?: string }): Promise<{
    ok: boolean;
    error?: string;
    /** 实际删除掉的目录绝对路径（便于日志与排查） */
    removed?: string[];
  }>;
  /**
   * 切换环境拟真内核（2026-10-06）。
   * 主进程会落盘配置；在「只保留单个内核」模式下卸载旧内核，并自动开始下载目标内核。
   * @returns 成功 { ok:true, engine, removed }；失败 { ok:false, error }（内核不可选 / Docker 预装）
   */
  setFingerprintEngine(key: string): Promise<{ ok: boolean; engine?: string; removed?: string[]; error?: string }>;
  /** 检查更新：只查询上游版本，不下载不安装 */
  checkFingerprintUpdate(): Promise<CheckFingerprintUpdateResult>;
  /**
   * 运行时版本号（主进程读 package.json，与窗口标题同源）。
   * ⚠️ 渲染层自己的 version.ts 是**打包时编译进 JS 的常量**，改了不重新 build:web
   * 就仍是旧值 —— 曾出现「标题栏 0.14.6.1、侧边栏 0.14.5」的分叉。
   * 「当前版本是多少」的展示一律走这条通道。
   */
  getRuntimeVersion(): Promise<{ version: string; base: string; buildNumber: string; electron: string }>;
  /** 应用本身更新检查：查询 GitHub Releases 最新正式版（自动加速），只查不下载 */
  checkAppUpdate(): Promise<CheckAppUpdateResult>;
  /** 内置下载安装包到系统「下载」目录，进度经 onUpdateDownloadProgress 推送 */
  downloadUpdate(url: string, assetName: string): Promise<UpdateDownloadResult>;
  /** 取消当前更新下载 */
  cancelUpdateDownload(): Promise<{ ok: boolean; error?: string }>;
  /** 运行下载好的安装包（NSIS 会覆盖本体，主进程随后退出应用） */
  runUpdateInstaller(filePath: string): Promise<{ ok: boolean; error?: string }>;
  /** 打开安装包所在文件夹并选中 */
  revealUpdateFile(filePath: string): Promise<{ ok: boolean; error?: string }>;
  /** 取指定版本的更新日志（不传 = 当前版本） */
  releaseNotes(version?: string): Promise<ReleaseNotesResult>;
  /**
   * 安装已下载的更新包：先校验文件确实存在，再校验完整性（大小 + PE 头 + sha256），
   * 通过后才启动安装包。静默下载场景尤其必要 —— 下完到点安装可能隔好几天。
   */
  installUpdate(payload?: { file?: string }): Promise<{ ok: boolean; error?: string }>;
  /** 关掉更新提示：当天不再弹 */
  dismissUpdatePrompt(version?: string): Promise<{ ok: boolean }>;
  /** 手动检查更新（忽略「当天已弹过」的限制） */
  checkUpdateNow(): Promise<CheckAppUpdateResult>;
  /** 主进程推来的更新提示；返回退订函数 */
  onUpdatePrompt(cb: (v: UpdatePromptPayload) => void): () => void;
  /** 更新下载进度推送：{ loaded, total, pct, speed }；返回退订函数 */
  onUpdateDownloadProgress(cb: (v: UpdateDownloadProgress) => void): () => void;

  // ---- 主进程推送 ----
  onRunning(cb: (v: boolean) => void): void;
  onLog(cb: (line: string) => void): void;
  onAccounts(cb: (list: Account[]) => void): void;
  onAppearance(cb: (v: Appearance) => void): void;
  /** 壁纸下载进度推送：{ loaded, total, pct } 或 { done: true }；返回退订函数 */
  onBgProgress(cb: (v: BgProgress) => void): () => void;
  onChromiumStatus(cb: (v: ChromiumStatus) => void): void;
  /** 环境拟真浏览器安装/卸载后的状态推送 */
  onFingerprintStatus(cb: (v: FingerprintStatus) => void): void;
  /** Chromium 自动安装进度：{ stage, message?, pct?, speed?, eta?, loaded?, total? }；返回退订函数 */
  onInstallProgress(cb: (v: InstallProgress) => void): () => void;
  /** 每账号运行态变更；返回退订函数 */
  onAccountStatus(cb: (v: { id: string; status: AccountRunStatusMap[string]["status"]; reason?: string }) => void): () => void;
  /** 每账号结构化日志；返回退订函数 */
  onAccountLog(cb: (entry: AccountLogEntry) => void): () => void;
}

declare global {
  interface Window {
    api: ElectronApi;
  }
}
