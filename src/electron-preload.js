const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  listAccounts: () => ipcRenderer.invoke("accounts:list"),
  createAccount: (name) => ipcRenderer.invoke("accounts:create", name),
  removeAccount: (id) => ipcRenderer.invoke("accounts:remove", id),
  renameAccount: (id, name) => ipcRenderer.invoke("accounts:rename", id, name),
  setAccountEnabled: (id, enabled) => ipcRenderer.invoke("accounts:setEnabled", id, enabled),

  getConfig: (id) => ipcRenderer.invoke("account:getConfig", id),
  setConfig: (id, patch) => ipcRenderer.invoke("account:setConfig", id, patch),
  // 账户的独立覆盖值（未覆盖的字段回落全局值，供独立设置表单渲染）
  getOverrides: (id) => ipcRenderer.invoke("account:getOverrides", id),
  // 切换「遵循全局设置」
  setUseGlobal: (id, v) => ipcRenderer.invoke("account:setUseGlobal", id, v),

  // 全局设置（所有账户默认共用）
  getGlobalConfig: () => ipcRenderer.invoke("global:getConfig"),
  setGlobalConfig: (patch) => ipcRenderer.invoke("global:setConfig", patch),

  // 仪表盘聚合数据
  overview: () => ipcRenderer.invoke("app:overview"),

  // 外观个性化（应用级偏好，独立于账户）
  getAppearance: () => ipcRenderer.invoke("appearance:get"),
  setAppearance: (patch) => ipcRenderer.invoke("appearance:set", patch),
  // 背景图地址解析（远程图源会先缓存到本地，保证各处看到同一张）
  // opts: { fresh } —— 换一张 / 轮换到期时强制重新拉取
  getBgSrc: (opts) => ipcRenderer.invoke("appearance:bg-src", opts),
  pickImage: () => ipcRenderer.invoke("appearance:pickImage"),
  // 壁纸预览：探测自定义图片地址是否可访问
  testBgUrl: (url) => ipcRenderer.invoke("appearance:testUrl", url),
  // 下载当前壁纸到本地（弹保存位置对话框）
  downloadWallpaper: (url) => ipcRenderer.invoke("appearance:downloadWallpaper", url),

  // 启动与托盘（应用级偏好，独立于账户）
  getLaunch: () => ipcRenderer.invoke("launch:get"),
  setLaunch: (patch) => ipcRenderer.invoke("launch:set", patch),

  // 首次启动向导（是否已完成、语言、协议勾选与初始选择）
  getSetup: () => ipcRenderer.invoke("setup:get"),
  setSetup: (patch) => ipcRenderer.invoke("setup:set", patch),

  // 推送通知测试：把当前表单填的通道试发一遍，日志输出具体（脱敏）地址
  testPush: (notice) => ipcRenderer.invoke("notify:test", notice),

  login: (id) => ipcRenderer.invoke("account:login", id),
  run: (id) => ipcRenderer.invoke("account:run", id),
  runAll: () => ipcRenderer.invoke("app:runAll"),
  // 运行勾选的多个账号（串行 + 账号间随机 20–60 秒）
  runSelected: (ids) => ipcRenderer.invoke("app:runSelected", ids),

  // 手动刷新登录状态（重新读取浏览器 Cookie）
  sync: (id) => ipcRenderer.invoke("account:sync", id),
  // 停止当前任务（全部）
  stop: () => ipcRenderer.invoke("app:stop"),
  // 只停止单个账号（正在执行则中断该账号；排队中则移除）
  stopAccount: (id) => ipcRenderer.invoke("account:stop", id),
  isRunning: () => ipcRenderer.invoke("app:isRunning"),
  // 每账号运行态快照：{ [id]: { status, reason, at } }
  getRunStatus: () => ipcRenderer.invoke("app:getRunStatus"),

  getLogs: () => ipcRenderer.invoke("app:getLogs"),
  // 某账号的最近日志（详情页只显示该账号）
  getAccountLogs: (id) => ipcRenderer.invoke("app:getAccountLogs", id),
  chromiumStatus: () => ipcRenderer.invoke("app:chromiumStatus"),
  installBrowser: () => ipcRenderer.invoke("app:installBrowser"),

  // 实时运行状态（主进程在任务开始/结束时推送）
  onRunning: (cb) => ipcRenderer.on("running", (_e, v) => cb(v)),
  onLog: (cb) => ipcRenderer.on("log", (_e, line) => cb(line)),
  // 每账号运行态变更推送：{ id, status, reason }
  // 返回退订函数，组件卸载时调用避免重复订阅
  onAccountStatus: (cb) => {
    const handler = (_e, v) => cb(v);
    ipcRenderer.on("account-status", handler);
    return () => ipcRenderer.removeListener("account-status", handler);
  },
  // 每账号结构化日志推送：{ time, level, msg, line, accountId, accountName }
  onAccountLog: (cb) => {
    const handler = (_e, v) => cb(v);
    ipcRenderer.on("account-log", handler);
    return () => ipcRenderer.removeListener("account-log", handler);
  },
  // 账户数据周期推送（卡片自动刷新，无需手动点按钮）
  onAccounts: (cb) => ipcRenderer.on("accounts", (_e, list) => cb(list)),
  // 外观变更推送（主进程保存后实时同步到渲染进程）
  onAppearance: (cb) => ipcRenderer.on("appearance", (_e, v) => cb(v)),
});
