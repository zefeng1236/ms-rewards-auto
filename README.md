# Microsoft Rewards 自动任务（多账户 · GUI）

独立于浏览器油猴插件的微软积分（Microsoft Rewards）自动任务软件。基于 Electron + Playwright，提供多账户隔离、干净浏览器、图形界面与定时自动运行。

> **当前版本：V0.8.6-Beta** · [下载安装包](https://github.com/zefeng1236/ms-rewards-auto/releases)
>
> ⚠️ 本软件为个人学习交流用途的开源工具，**非微软官方授权产品**，与 Microsoft Corporation 无任何关联。使用产生的风险请阅读文末免责声明。

## 核心特性

- **多账户隔离**：每个账户拥有独立的 `storage/accounts/<id>/` 目录（配置、登录态、Cookie、浏览器 profile），互不干扰
- **初始干净浏览器**：使用 Playwright 自带的 Chromium（与系统 Edge/Chrome 完全隔离），不继承系统浏览器的任何数据
- **液态玻璃 GUI**：基于 React + TypeScript 重写的全新界面，毛玻璃质感、壁纸背景、深浅主题自适应
- **首次启动向导**：欢迎页（多语言）→ 协议阅读与勾选 → 风险告知 → 个性化初始设置，四步引导完成初始配置
- **三层配置模型**：全局设置 → 账户覆盖（可选），账户可一键切换「遵循全局 / 独立设置」
- **HTTP 驱动任务**：签入（type=103）、阅读（type=101）、活动交卷（next-action）、PC/移动端搜索上报，全程 fetch 模拟，仅登录时需要浏览器
- **定时自动运行**：支持单次循环 / 每日定时 / 多时间段三种调度模式
- **多账号批量运行**：勾选多个账号串行执行，账号间随机 20–60 秒错峰
- **开机自启与托盘驻留**：可注册系统登录项、开机后静默驻留托盘、关闭窗口最小化、单实例锁防止重复启动
- **积分目标**：按账户总积分设置目标与自定义奖品名称，达成后在仪表盘磁贴显示完成倍数 / 可兑换数量
- **推送通知**：任务完成或受阻时推送至企业微信 / 钉钉 / 飞书 / PushMe / Bark，消息首行带账号名

## 界面预览

- **仪表盘**：所有账户的运行概况与今日进度，统计卡 + 账户表格（支持搜索过滤、勾选批量运行）
- **账户详情**：账号切换 + 登录/调度状态 + 积分卡 + 本账号设置（含「遵循全局设置」开关）与积分目标磁贴
- **全局设置 / 个性化 / 启动与托盘**：任务与推送配置、壁纸与液态玻璃效果、开机自启与托盘行为
- **首次启动向导**：欢迎（选语言）→ 协议 → 风险告知 → 个性化初始设置

## 目录结构

```
├── src/                    # 主进程源码
│   ├── electron-main.js    # Electron 主进程（窗口、IPC、托盘、单实例锁）
│   ├── electron-preload.js # contextBridge 桥接层
│   ├── account.js          # 账户管理（创建/删除/状态/概览）
│   ├── config.js           # 三层配置：DEFAULTS → 全局 → 账户覆盖
│   ├── global-config.js    # 全局设置层（storage/global-config.json）
│   ├── appearance.js       # 外观个性化（storage/appearance.json）
│   ├── launch.js           # 启动与托盘（storage/launch.json + 系统登录项）
│   ├── setup.js            # 首次启动向导状态（storage/setup.json）
│   ├── goals.js            # 积分目标计算与汇总文案
│   ├── storage-path.js     # 存储目录统一解析（开发=项目根 / 打包=userData）
│   ├── ensure-deps.js      # 运行时依赖自动补全（Playwright → chocolatey 回落）
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
├── src-renderer/           # 渲染进程 React + TypeScript 源码
│   ├── src/views/          # 仪表盘 / 账户详情 / 全局设置 / 个性化 / 启动与托盘 / 向导
│   ├── src/components/     # 设置表单、日志控制台、侧栏等组件
│   └── src/styles/         # 主题 token 与全局样式
├── gui-react/              # 渲染进程构建产物（vite build 输出，打包进安装包）
├── gui/                    # 旧版原生 JS 前端（保留备用）
├── 参考js脚本/             # 早期油猴脚本参考
├── build/                  # 打包用构建资源（应用图标 icon.ico / icon.png）
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

## 安装使用（推荐：下载安装包）

前往 [Releases](https://github.com/zefeng1236/ms-rewards-auto/releases) 下载最新的 `Microsoft-Rewards-Auto-Setup-<版本>.exe`，双击运行即可。

- **可自选安装目录**：安装向导非一键式，可自定义路径，默认安装到当前用户目录（无需管理员权限）
- **自动创建快捷方式**：桌面 + 开始菜单
- **首次运行自动补全依赖**：应用启动时会检测 Chromium，缺失则自动后台下载（约 150MB）。下载链路：
  1. 优先走 Playwright 官方源（可配 `PLAYWRIGHT_DOWNLOAD_HOST` 镜像加速）
  2. 失败则回落调用 [chocolatey.org](https://chocolatey.org) API 查询并安装 Chromium
  3. 两条链路都失败时 GUI 会给出提示，可手动点右上角「安装 Chromium」重试
- **数据存放位置**：`%APPDATA%\Microsoft Rewards Auto\storage\`

  安装目录（可能位于 `Program Files`）不写入任何运行时数据，所有账户配置、登录态、浏览器 profile 都在上述 userData 路径下，卸载时**默认不删除**，重装后账户仍在。

> **首次使用需要重新添加账号并登录。** 安装版与源码版的存储目录是隔离的两份数据，不会互相读取。

### 卸载

从「设置 → 应用」或开始菜单卸载。账户数据不会被删除，如需彻底清理请手动删除 `%APPDATA%\Microsoft Rewards Auto\`。

## 从源码运行（开发者）

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

## 更新日志

### V0.8.6-Beta（2026-09-12）

- **首次启动向导**：新用户第一次打开软件时弹出四步引导
  1. **欢迎页**：选择界面语言（当前版本提供简体中文；繁体中文 / English / Русский / 日本語 暂未开发，已标注占位）
  2. **协议页**：隐私政策 / 服务条款 / 免责声明三份文档按钮切换、上下滚动阅读，必须勾选「我已阅读并同意」才能继续
  3. **风险告知页**：明确本软件非微软官方授权产品，列出使用可能造成的后果（账号风控 / 积分回收 / IP 限制等），确定按钮 3 秒倒计时防误触
  4. **个性化初始设置**：引导选择是否启用液态玻璃效果、是否开机自启，选择立即生效
- 向导状态持久化到 `storage/setup.json`，完成后不再弹出

#### 本版本之前的主要更新（摘要）

- 全新 React + TypeScript 液态玻璃界面（旧版原生 JS 界面保留为 `gui/` 备用）
- 全局日志控制台（快捷键 / 拖拽调高 / 按等级筛选）
- 多账号串行批处理、账号间随机间隔、账号独立状态与日志
- 外观个性化：Bing / 本地 / 在线壁纸、背景模糊与暗化、深浅主题、主题色、液态玻璃开关
- 启动与托盘：开机自启、驻留托盘、启动延迟、关闭最小化到托盘、单实例锁
- 推送消息统一带账号名首行，运行汇总首行即账号名
- 积分目标：总积分余额目标 + 自定义奖品 + 仪表盘磁贴（倍数 / 可兑换数量 / 超长渐隐悬停详情）
- 全新金色勋章应用图标（窗口 / 任务栏 / 托盘 / 安装程序）
- NSIS 安装包：自选目录、无管理员权限、卸载保留数据

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

## 自行打包安装程序

```bash
npm run pack        # 完整打包，产出 dist/Microsoft-Rewards-Auto-Setup-<版本>.exe
npm run pack:dir    # 只产出 dist/win-unpacked/（免安装，调试用，快得多）
```

打包配置在 `package.json` 的 `build` 字段，几个关键点：

| 配置 | 作用 |
| --- | --- |
| `asarUnpack: playwright-core` | Playwright 要执行 Chromium 二进制，打进 asar 里会跑不起来，必须解压到 `app.asar.unpacked/` |
| `signAndEditExecutable: false` | 跳过代码签名。winCodeSign 工具包含 macOS 符号链接，Windows 普通用户没有创建符号链接的权限，会导致解压失败 |
| `nsis.oneClick: false` | 关掉一键安装，让用户能选安装目录 |
| `nsis.perMachine: false` | 装到当前用户目录，不要求管理员权限 |
| `nsis.deleteAppDataOnUninstall: false` | 卸载保留账户数据 |

> 打包末尾如果出现清理临时文件失败的报错（`.nsis.7z` 无法删除），属于清理阶段的问题，**不影响产物** —— 检查 `dist/` 下 exe 是否已生成即可。

### 存储路径的处理

打包后 `__dirname` 指向 `app.asar/src/`，如果沿用 `path.join(__dirname, "..", "storage")` 会算到安装目录下（可能是 `Program Files`，无写权限），应用直接崩。

解决方式是 `src/storage-path.js` 统一收口所有存储路径，它读取 `process.env.MS_REWARDS_STORAGE_DIR`，缺省回落到项目根目录的 `storage/`。`electron-main.js` 在 **require 任何业务模块之前**把该变量指向 `app.getPath("userData")/storage`：

```js
// electron-main.js 顶部，必须在 require ./account 等模块之前
if (!process.env.MS_REWARDS_STORAGE_DIR && app.isPackaged) {
  process.env.MS_REWARDS_STORAGE_DIR = path.join(app.getPath("userData"), "storage");
}
```

顺序不能颠倒 —— `account.js` / `config.js` / `global-config.js` / `state.js` / `logger.js` 都在模块加载时就计算好了路径常量。

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
| 安装版看不到源码版的账号 | 两者存储目录隔离，安装版数据在 `%APPDATA%\Microsoft Rewards Auto\storage\`，需重新添加账号 |
| 安装版首次启动卡在下载 Chromium | 约 150MB，取决于网速；也可关掉应用后手动 `choco install chromium` 再启动 |
| 打包时报 winCodeSign 符号链接失败 | 确认 `build.win.signAndEditExecutable` 为 `false`（本仓库已配置） |

## 技术栈

- **主进程**：Node.js + Electron 31
- **浏览器引擎**：Playwright-core（Chromium）
- **渲染进程**：React 18 + TypeScript + Vite 5，UI 组件库 [@ttqtt/liquid-glass-react](https://www.npmjs.com/package/@ttqtt/liquid-glass-react)（液态玻璃质感）
- **旧版渲染层**：原生 HTML/CSS/JS（`gui/`，保留备用）
- **样式**：CSS 设计 token（深浅双主题）+ `backdrop-filter` 毛玻璃 + 壁纸环境色自适应

## 免责声明

1. 本软件是个人开发者出于学习与技术交流目的编写的开源工具，与 Microsoft Corporation 没有任何隶属、代理、授权或合作关系。Microsoft、Bing、Microsoft Rewards 等名称与商标归其各自权利人所有，仅作描述性指代之用。
2. 使用本软件可能违反 Microsoft 服务协议中关于自动化访问的相关条款，由此可能产生账户受限、积分扣减/回收、功能禁用、触发人机验证、IP 被限制访问等后果，相关风险与损失由使用者自行承担。
3. 软件按「现状」提供，不提供任何明示或暗示的担保。作者不对因使用或无法使用本软件所导致的任何直接或间接损失（包括积分损失、账户损失、数据丢失、利润损失或业务中断）承担责任。
4. 请在使用前确认您所在地区的法律法规以及 Microsoft 服务协议允许此类自动化行为；若不允许，请立即停止使用并卸载本软件。
5. 请合理设置运行频率（搜索间隔建议 ≥ 20 秒），避免对目标服务造成负担。

## 许可证

MIT
