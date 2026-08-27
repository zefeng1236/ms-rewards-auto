# Microsoft Rewards 自动任务（多账户 · GUI）

独立于浏览器油猴插件的微软积分（Microsoft Rewards）自动任务软件。基于 Electron + Playwright，提供多账户隔离、干净浏览器、图形界面与定时自动运行。

## 核心特性

- **多账户隔离**：每个账户拥有独立的 `storage/accounts/<id>/` 目录（配置、登录态、Cookie、浏览器 profile），互不干扰
- **初始干净浏览器**：使用 Playwright 自带的 Chromium（与系统 Edge/Chrome 完全隔离），不继承系统浏览器的任何数据
- **图形界面**：Electron GUI，左侧导航 + 右侧三视图（仪表盘 / 账户详情 / 全局设置），支持响应式布局与自动缩放
- **三层配置模型**：全局设置 → 账户覆盖（可选），账户可一键切换「遵循全局 / 独立设置」
- **HTTP 驱动任务**：签入（type=103）、阅读（type=101）、活动交卷（next-action）、PC/移动端搜索上报，全程 fetch 模拟，仅登录时需要浏览器
- **定时自动运行**：支持单次循环 / 每日定时 / 多时间段三种调度模式
- **推送通知**：任务完成或受阻时推送至企业微信 / 钉钉 / 飞书 / PushMe / Bark

## 界面预览

- **仪表盘**：所有账户的运行概况与今日进度，4 张统计卡（总数 / 已启用 / 已登录 / 今日积分）+ 账户表格（支持搜索过滤）
- **账户详情**：顶部下拉选账号 + 登录状态/调度状态，下方 7 张积分卡 + 本账号设置（含「遵循全局设置」开关）
- **全局设置**：所有「遵循全局设置」的账号共用这份配置，顶部显示跟随数量

## 目录结构

```
├── src/                    # 主进程源码
│   ├── electron-main.js    # Electron 主进程（窗口、IPC、调度）
│   ├── electron-preload.js # contextBridge 桥接层
│   ├── account.js          # 账户管理（创建/删除/状态/概览）
│   ├── config.js           # 三层配置：DEFAULTS → 全局 → 账户覆盖
│   ├── global-config.js    # 全局设置层（storage/global-config.json）
│   ├── state.js            # 账户状态（cookies/token/任务进度）
│   ├── auth.js             # 微软登录授权码捕获
│   ├── browser.js          # Playwright Chromium 管理
│   ├── tasks.js            # 任务执行（签入/阅读/活动/搜索）
│   ├── rewards.js          # 积分查询
│   ├── runner.js           # 任务调度器（循环/每日/时间段）
│   ├── http.js             # fetch 封装
│   ├── notify.js           # 推送通知
│   ├── logger.js           # 日志
│   ├── cancel.js           # 任务取消
│   ├── utils.js            # 工具函数
│   └── main.js             # CLI 入口
├── gui/                    # 渲染进程前端
│   ├── index.html          # 主界面结构（左导航 + 三视图）
│   ├── renderer.js         # 渲染逻辑（视图路由 + 表单工厂 + 事件绑定）
│   └── style.css          # 样式（设计 token + 响应式三档）
├── 参考js脚本/             # 早期油猴脚本参考
├── config.json             # CLI 默认配置模板
├── package.json
├── start.bat               # Windows 启动脚本
└── README.md
```

运行时数据（不入库）：

```
storage/
├── global-config.json          # 全局设置（所有账户默认共用）
├── state.json                  # 全局状态
└── accounts/<账户id>/
    ├── config.json             # 该账户的覆盖值（useGlobal=true 时仅含此字段）
    ├── state.json             # 该账户的 Cookie / token / 任务进度
    └── profile/               # 该账户独立的浏览器会话数据
```

## 快速开始

### 1. 安装依赖（首次）

```bash
npm install
```

> 会自动安装 Electron 与 Playwright Chromium（约 250MB）。
> 国内网络建议设置镜像后重装：
> ```powershell
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> $env:PLAYWRIGHT_DOWNLOAD_HOST="https://npmmirror.com/mirrors/playwright/"
> npm install
> ```
> 若 Chromium 未装成功，可单独执行 `npm run install-browser`。

### 2. 启动 GUI

```bash
npm start
```

或双击 `start.bat`。

### 3. 使用步骤

1. 点击「＋ 添加」创建账户（每个账户独立登录态）
2. 选中账户 → 点击「授权登录」→ 在弹出的干净 Chromium 中完成微软登录，自动捕获授权码
3. 勾选需要的任务（签入/阅读/活动/搜索），可调整搜索间隔与词源
4. 点击「立即运行」或「运行全部账户」；可设置每日定时自动运行
5. 底部为实时日志，可筛选查看，支持拖拽调整高度（快捷键 Ctrl+\` 切换显隐）

## 三层配置模型

配置按优先级合并，下游所有调用点统一通过 `config.get()` 获取「有效配置」，无需关心来源：

```
DEFAULTS（代码内置默认值）
   ↓ 深合并
全局设置（storage/global-config.json）
   ↓ 深合并（仅当账户 useGlobal === false 时）
账户覆盖（storage/accounts/<id>/config.json）
```

- **遵循全局**（默认）：账户 `config.json` 仅含 `{ "useGlobal": true }`，直接用全局设置
- **独立设置**：关闭「遵循全局设置」开关后，账户 `config.json` 保存覆盖值；未覆盖的字段仍回落到全局值作为表单起点
- **无损迁移**：从旧版升级时，若全局文件不存在，自动把账户的完整配置提升为全局设置；已存在则转为账户独立覆盖
- **覆盖值保留**：切回「遵循全局」时，账户的覆盖值不删除，再次切回独立模式立即恢复

设置表单由工厂函数 `settingsFormHtml(ns)` 生成，全局（`g-` 前缀）与账户（`a-` 前缀）两份表单字段完全一致，省去重复维护。

## 调度模式

| 模式 | 说明 | 适用场景 |
| --- | --- | --- |
| loop | 循环运行，间隔 N 分钟，可设最大轮数与「完成即停」 | 日常挂机 |
| daily | 每日固定时间运行一次 | 定时任务 |
| windows | 多个时间段（如 09:00-12:00、14:00-23:00）轮流运行 | 精细化时段控制 |

GUI 运行期间由主进程守护（每 30 秒巡检），也可纯后台运行 `node src/main.js daemon`。

## CLI 备用入口

```bash
npm run cli          # 进入交互菜单
node src/main.js add "账户名"   # 添加账户
node src/main.js login 1        # 授权登录
node src/main.js run 1          # 运行账户1
node src/main.js run all        # 运行全部
node src/main.js daemon         # 定时守护
node src/main.js browser        # 检查 Chromium
```

## 推送通知

在 GUI 账户的「推送通知」中填写 Webhook（企业微信 / 钉钉 / 飞书 / PushMe / Bark），留空则不推送。任务完成或受阻时会推送汇总。

## 注意事项

- 运行需网络可达 `login.live.com`、`rewards.bing.com`、`prod.rewardsplatform.microsoft.com`
- 建议保持默认「锁定国区」，非中国大陆 IP 会自动停止任务
- 搜索间隔建议 ≥ 20 秒，避免触发风控
- 定时任务在 GUI 运行期间生效；如需纯后台运行，使用 `node src/main.js daemon`
- `storage/` 目录含账户登录态与浏览器 profile，**切勿提交到版本库**（已在 `.gitignore` 排除）

## 常见问题

| 问题 | 解决 |
| --- | --- |
| 提示 Chromium 未安装 | 点击 GUI 右上角「安装 Chromium」或运行 `npm run install-browser` |
| Electron 启动报 failed to install | 见上方镜像安装说明，重装 `npm install` |
| 授权登录后仍显示未登录 | 检查网络是否被代理干扰，重新点「授权登录」 |
| 修改全局设置后某些账户没生效 | 检查该账户是否关闭了「遵循全局设置」开关 |
| 从旧版升级后配置丢失 | 旧版账户配置已自动迁移：全局文件不存在时提升为全局设置 |

## 技术栈

- **主进程**：Node.js + Electron 31
- **浏览器引擎**：Playwright-core（Chromium）
- **渲染进程**：原生 HTML/CSS/JS（无框架），contextBridge IPC 桥接
- **样式**：CSS 设计 token（5 档表面 / 3 档边框 / 4 档文字）+ 三档响应式媒体查询（1180/900/700px）+ `backdrop-filter` 毛玻璃

## 许可证

MIT
