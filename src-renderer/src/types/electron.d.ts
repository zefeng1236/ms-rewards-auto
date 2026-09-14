import type {
  Account,
  AccountLogEntry,
  AccountMeta,
  AccountRunStatusMap,
  AppConfig,
  Appearance,
  AppearanceSetResult,
  BgSrcResult,
  ChromiumStatus,
  CloseAction,
  DeepPartial,
  DownloadResult,
  InstallBrowserResult,
  LaunchConfig,
  Overview,
  PushTestResult,
  RunResult,
  SaveTextResult,
  SetupState,
  TestUrlResult,
  VaultResult,
  VaultStatus,
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
  chromiumStatus(): Promise<ChromiumStatus>;
  installBrowser(): Promise<InstallBrowserResult>;

  // ---- 主进程推送 ----
  onRunning(cb: (v: boolean) => void): void;
  onLog(cb: (line: string) => void): void;
  onAccounts(cb: (list: Account[]) => void): void;
  onAppearance(cb: (v: Appearance) => void): void;
  onChromiumStatus(cb: (v: ChromiumStatus) => void): void;
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
