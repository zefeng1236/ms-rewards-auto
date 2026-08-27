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

  login: (id) => ipcRenderer.invoke("account:login", id),
  run: (id) => ipcRenderer.invoke("account:run", id),
  runAll: () => ipcRenderer.invoke("app:runAll"),

  // 手动刷新登录状态（重新读取浏览器 Cookie）
  sync: (id) => ipcRenderer.invoke("account:sync", id),
  // 停止当前任务
  stop: () => ipcRenderer.invoke("app:stop"),
  isRunning: () => ipcRenderer.invoke("app:isRunning"),

  getLogs: () => ipcRenderer.invoke("app:getLogs"),
  chromiumStatus: () => ipcRenderer.invoke("app:chromiumStatus"),
  installBrowser: () => ipcRenderer.invoke("app:installBrowser"),

  // 实时运行状态（主进程在任务开始/结束时推送）
  onRunning: (cb) => ipcRenderer.on("running", (_e, v) => cb(v)),
  onLog: (cb) => ipcRenderer.on("log", (_e, line) => cb(line)),
  // 账户数据周期推送（卡片自动刷新，无需手动点按钮）
  onAccounts: (cb) => ipcRenderer.on("accounts", (_e, list) => cb(list)),
});
