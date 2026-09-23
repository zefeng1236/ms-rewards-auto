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
  InstallBrowserResult,
  InstallFingerprintResult,
  InstallProgress,
  LaunchConfig,
  Overview,
  PushTestResult,
  RunResult,
  SaveTextResult,
  SetupState,
  TestUrlResult,
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

  // ---- 外观 ----
  getAppearance(): Promise<Appearance>;
  setAppearance(patch: Partial<Appearance>): Promise<AppearanceSetResult>;
  getBgSrc(opts?: { fresh?: boolean }): Promise<BgSrcResult>;
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
  vaultUnlock(password: string): Promise<VaultResult>;
  /** 用恢复密钥解锁（忘记密码时） */
  vaultUnlockRecovery(key: string): Promise<VaultResult>;
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

  // ---- 推送测试 ----
  testPush(notice: AppConfig["notice"]): Promise<PushTestResult>;

  // ---- 任务 ----
  login(id: string): Promise<RunResult>;
  run(id: string): Promise<RunResult>;
  runAll(): Promise<RunResult>;
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

  // ---- 指纹浏览器（可选增强）----
  fingerprintStatus(): Promise<FingerprintStatus>;
  /** 下载并安装指纹浏览器（约 181MB，走 gh-proxy 镜像链）；force 为 true 时强制重装 */
  installFingerprint(opts?: { force?: boolean }): Promise<InstallFingerprintResult>;
  /** 取消当前指纹浏览器下载任务 */
  cancelFingerprintInstall(): Promise<{ ok: boolean; error?: string }>;
  uninstallFingerprint(): Promise<{ ok: boolean }>;
  /** 检查更新：只查询上游版本，不下载不安装 */
  checkFingerprintUpdate(): Promise<CheckFingerprintUpdateResult>;
  /** 应用本身更新检查：查询 GitHub Releases 最新正式版（自动加速），只查不下载 */
  checkAppUpdate(): Promise<CheckAppUpdateResult>;

  // ---- 主进程推送 ----
  onRunning(cb: (v: boolean) => void): void;
  onLog(cb: (line: string) => void): void;
  onAccounts(cb: (list: Account[]) => void): void;
  onAppearance(cb: (v: Appearance) => void): void;
  /** 壁纸下载进度推送：{ loaded, total, pct } 或 { done: true }；返回退订函数 */
  onBgProgress(cb: (v: BgProgress) => void): () => void;
  onChromiumStatus(cb: (v: ChromiumStatus) => void): void;
  /** 指纹浏览器安装/卸载后的状态推送 */
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
