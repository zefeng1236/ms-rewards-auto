# 更新日志

本文件记录各版本的重要变更。版本格式为主版本.次版本.修订号，带 `-beta` 后缀的为测试版本。

## 0.9.1

发布日期：2026-09-15

本版本在 0.9.0（已撤回）的基础上修复了若干问题，并补充了交互细节。

### 修复

- **修复向导建库白屏（严重）**：`SetupWizard` 的 `PageVault` 中，`useEffect` 与 `evaluatePassword` 原本写在 `if (recovery) return` 之后，导致「建库成功、显示恢复密钥」那一次渲染少调一个 Hook，React 直接卸载整棵树白屏。桌面版同样中招。已将 Hook 与函数提到所有 early return 之上（源码含注释说明）。该问题接口测试无法暴露（HTTP 全 200），只有真实浏览器跑界面才会复现。

### 新增 / 调整

- **向导加密密码框小眼睛**：「加密密码」「确认密码」两处新增显隐切换按钮，便于确认输入是否输对。
- **搜索词来源默认改为 `hot.nntool.cc`**：设置项将该来源排到第一位并作为默认值（替代原 `offline`）。
- **Web 全屏向导适配**：Web/SSE 版向导页铺满视口，避免内容被截断。

> 注：向导「密码提示」placeholder 文案调整属于细节打磨，不计入本版本变更说明。

---

## 0.9.0（已撤回，内容并入 0.9.1）

发布日期：2026-09-15

本版本开始把运行编排逻辑抽离为**纯 Node 共用核心**，为 Electron 桌面版与未来的 Web/SSE 版（无桌面环境的 Docker / 服务器部署）统一行为打基础。

### 架构

- **新增共用编排核心 `src/app-core.js`**：独立模块收口「全局运行态 / 单账号状态 / 批次串行」逻辑，通过 EventEmitter 暴露 `running` / `accounts` / `account-status` / `account-log` 事件。Web/SSE 版（`src/web-api.js`）已接入该核心做事件转发，桌面主进程后续也将迁移至此核心，避免两个版本行为漂移。
- **Web/SSE 版配套**：新增 `src/web-api.js`（把 app-core 与 logger 的事件转为 SSE 流）、`src-renderer/src/api/web.ts`（Web 版 API 适配）、`src-renderer/vite.web.config.ts`（Web 版独立构建配置），并增加 `build:web:docker` 脚本产出 Web 版前端。

### 构建 / 清理

- 前端产物 `gui-react` 基于当前 `src-renderer` 源码重新构建（hash 刷新），orphan bundle 由 `scripts/clean-assets.js` 清理。
- `package.json` 版本 0.8.10 → 0.9.0。

### 验证

- `tsc --noEmit` 零错误；`npm test` 自检 36/36 通过。

---

## 0.8.10

发布日期：2026-09-15

本版本聚焦「数据准确性 + 任务可用性 + 安全加固」三大方向，集中修复了一批实战中暴露的问题，并补充了测试基建。

### 修复

- **总积分显示错误（核心）**：
  此前积分查询把 earn 页的 `pointsCounters.totalPoints`（**今日积分，约 82**）误当作账户总积分，
  导致界面总积分与官网差距巨大。现改为优先读取 earn 页独立的 `balance` /
  `availablePoints` 字段（**可用/总积分，约 582**），回退链为 `availablePoints` → `pc.totalPoints`；
  「今日积分」单独取自 `pc.totalPoints`。
- **账号日志为空**：
  刷新状态 / 同步 / 登录产生的日志此前未正确归属账号（`logger.setContext` 未调用），
  导致账户详情页日志一片空白。现 `account:sync` / `account:login` handler 在运行前
  `setContext(id, name)`、结束后 `clearContext()`，日志正确落入对应账号环形缓冲。
- **每日活动任务失效**：
  旧的 `taskPromos()` 走 `next-action` POST 交卷接口，该接口已失效，活动永远显示未完成。
  真实机制是访问每日活动卡片内的 3 条带 `rnoreward=1` / `Gamification_DailySet`
  追踪参数的 Bing 奖励搜索链接。现改为「先访问链接 → 再 POST 兜底」。

### 新增

- **每周可领取积分**：新增 `taskClaimRewards()`，自动点击「可领取 / 待领取」卡片领取积分，
  由 `state.lastClaimDate` 做 7 天节流，避免重复领取。
- **加密密码强度体系**：
  - 复杂度要求：大小写字母 + 数字 + 特殊字符，且长度 ≥ 8 位。
  - 五段分色强度条，达到第 3 段才视为合规。
  - 弱密码检测（生日 / 年月日 / 连续数字 / 重复 / 常见弱密码）静默多出一行红色小字提醒，**但不禁止**。
  - 取消密码开关时弹出风险确认窗：左侧红色「确定取消」（5 秒倒计时防误触）、右侧蓝色「启用密码」（无倒计时）。
  - 恢复密钥支持导出为 **txt 文件**到本地（弹窗让用户选择保存位置）。
  - 向导 `SetupWizard` 与设置页 `VaultPanel` 全链路一致接入，堵住「向导跳过 → 设置设弱密码」的绕过。
- **仪表盘交互增强**：
  - 点击账号区域任意位置直达账户详情页。
  - 账号首次创建完成后，状态列显示「去登录」按钮（直接调用登录），不再只是静态标签。
- **恢复密钥 txt 导出 IPC**：主进程新增 `app:saveTextFile`，由 `dialog.showSaveDialog` 让用户决定保存位置。
- **构建产物自清理**：新增 `scripts/clean-assets.js`，在 `build:web` 阶段比对 `gui-react/index.html` 引用，
  精准删除 vite `emptyOutDir:false` 残留的孤儿 bundle（已清掉约 778KB 旧产物）。
- **自检脚本**：`scripts/selfcheck.js`（接入 `npm test`），覆盖密码强度、每日活动解析、领取节流，
  23 → 24 项断言全过。

### 安全 / 清理

- 删除本地调试产生的 `scrape-out/`（含真实账号页面 HTML / 截图 / 积分数据）与 `scrape-profile/`（含真实登录 Cookie）。
- 自检改用净化版固定样本 `selfcheck-fixtures/home.json`（搜索会话 sid 替换为固定假值，**无任何凭据**），
  密码强度测试的 esbuild 临时产物改写到系统临时目录，彻底切断测试对敏感数据的依赖。

---

## 0.8.9

发布日期：2026-09-14

### 修复

- **修复积分统计对不上**：
  搜索任务此前只记录 PC/移动搜索进度，没有记录搜索得分，导致搜索卡片只能显示「60/60 已完成」
  却看不到分数，且本地「今日合计」兜底计算漏掉搜索分。
  - 新增 `state.searchPoint`，搜索进度变化/完成/最终校验时同步更新。
  - 本地兜底「今日合计」现在包含 `signPoint + readPoint + promosPoint + searchPoint`。
  - 账户详情页搜索卡片现在会显示「已完成 · N 分」。

---

## 0.8.8

发布日期：2026-09-14

### 修复

- **修复全新数据目录下 `mkdtemp` 报 `ENOENT`**：
  打开浏览器前会先确保 `storage/tmp` 目录存在，否则 `fs.mkdtempSync` 会因为父目录不存在而失败。
  这导致部分用户在 Administrator 账户或全新安装后无法登录/同步（日志反复出现
  `ENOENT: no such file or directory, mkdtemp ... prof-XXXXXX`）。
- **修复 Chromium 安装完成后侧边栏仍显示「缺失 Chromium」**：
  后台或手动安装完成后，主进程现在会主动推送 `chromium-status` 事件，前端订阅后即时刷新徽标，
  不再需要手动刷新或重启应用。
- **Docker / 外部 Chromium 兼容**：`browser.js` 支持通过环境变量
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定外部 Chromium，并支持 `MS_REWARDS_CHROMIUM_ARGS`
  注入额外启动参数。
- **非 Windows 平台安装回落**：`ensure-deps.js` 在 Linux/Docker 环境下直接跳过 chocolatey fallback，
  避免无意义等待。

---

## 0.8.7

发布日期：2026-09-13

### 重大更新：登录态端到端加密（保险库 Vault）

这是本版本最重要的变化。在此之前，账户的 Cookie 与令牌以**明文 JSON** 存盘，且 Playwright 的持久化
浏览器目录 `profile/` 里还留着一份明文 Cookie 数据库——即使加密了 `state.json`，攻击者也只需拷贝
`profile/` 就能拿到完整登录态（"假加密"）。0.8.7 彻底解决了这个问题。

- **加密存储**：账户的 Cookie / refreshToken / accessToken 统一加密为密文 blob 存入 `state.json` 的
  `secrets` 字段。磁盘上不再有明文凭据。
- **消除 profile 后门**：浏览器不再使用持久化 `profile/` 目录，改为每次运行时创建临时 profile，
  登录/同步完成后把 Cookie 读回加密存储，随即删除临时目录。
- **密钥体系**：scrypt 派生 + AES-256-GCM 加密。随机主密钥 VK 由「密码」和「恢复密钥」分别加密一份
  保存，密码本身不落盘。修改密码不需要重新加密数据（VK 不变）。
- **日常免密**：主密钥可缓存到系统钥匙串（Windows 下为 DPAPI），日常重启自动解锁，**不需要每次输密码**。
- **恢复密钥**：首次设置密码时生成并展示，是忘记密码时唯一的解锁途径。
- **一键迁移**：旧版本的明文数据会在解锁时自动加密迁移，并清理遗留的 `profile/` 目录。
- **锁屏闸门**：锁定状态下所有涉及登录态的操作（登录 / 同步 / 运行任务）都会被拒绝。
- **纯 Node 实现**：加密核心不依赖 Electron，为将来的 Docker 版预留了通道——无桌面环境时可通过
  环境变量 `MS_REWARDS_VAULT_PASSWORD` 或 `MS_REWARDS_VAULT_KEY` 解锁。

### 新增

- **关闭主窗口行为三选一**：设置 → 启动与托盘，点击 × 时可设为「每次询问 / 退出到托盘 / 完全退出」。
  选择「每次询问」时会弹出确认框，并可记住本次选择。旧的「关闭时最小化到托盘」开关会自动迁移。
- **安装界面中文化**：Windows 安装向导改为简体中文（此前为英文）。
- **加密向导页**：首次启动向导新增第 4 页，引导设置加密密码并保存恢复密钥（可跳过）。
- **锁屏与设置页安全卡片**：新增 `VaultLock` 锁屏（支持密码 / 恢复密钥解锁）和设置页「安全」卡片。
- **自检脚本**：`scripts/vault-selfcheck.js`，纯 Node 运行，26 条断言覆盖加密逻辑，`--disk` 模式可扫描
  真实数据目录确认无明文泄漏。

### 修复

- 桌面快捷方式图标为 Electron 默认图标：原因是 `signAndEditExecutable: false` 会让 electron-builder 跳过
  rcedit 步骤，改为通过 `afterPack` 钩子在打包后手动写入图标。
- 向导加密页选项卡片样式缺失导致说明文字被卡片遮挡。
- 仪表盘目标卡片进度文字被截断显示不全，改为自动换行且不再溢出卡片。
- 设置页「积分目标」移除多余的「奖品名称」输入框及其 label。

### 文案调整

- 目标卡片进度文案「已完成 N 还差 M 积分」改为「已获得 N 还差 M 积分」。

### 验证情况

- 加密逻辑：纯 Node 自检脚本 26/26 断言通过。
- 磁盘无明文：在真实数据目录上扫描确认，账户密文完好、无明文泄漏。
- 重启免密解锁：Windows 真机验证通过，系统钥匙串（DPAPI）接管成功，重启不弹密码框。

---

## 0.8.6-beta

- 支持打包为 Windows 安装程序（NSIS），运行时自动补全 Playwright / Chromium 依赖。
- 打包后数据目录迁移到 `userData`，避免安装目录写入权限问题。
- 通过 `afterPack` 钩子修复 exe 图标未写入的问题。

---

## 关于升级

从 0.8.6-beta 及更早版本升级时：

1. 启动后会自动把已有的明文登录态加密迁移，无需手动操作。
2. 首次使用时需要设置一个加密密码（可跳过，但不建议）。
3. 升级不会自动删除旧数据，但残留的明文 `profile/` 目录会在迁移时被清理。
