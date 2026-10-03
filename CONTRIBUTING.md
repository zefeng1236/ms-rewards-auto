# 参与贡献

感谢你愿意花时间看这个项目。先说三件重要的事，能帮你少走弯路。

## 1. 项目定位

这是一个**个人学习交流性质**的开源工具，与 Microsoft / Bing 无任何隶属、代理或授权关系。使用它可能违反 Microsoft 服务协议中关于自动化访问的条款，导致账户受限或积分回收，**风险由使用者自行承担**。

## 2. CI 与门禁

仓库有 GitHub Actions（`.github/workflows/ci.yml`），推送 main / 提 PR / 手动触发都会跑：

| Job | 做什么 | 触发条件 |
|---|---|---|
| verify | typecheck + 自检 + 前端构建（桌面 + Web/Docker 产物） | 总是 |
| desktop | 打 Windows NSIS 安装包，上传 artifacts（保留 14 天） | 非 PR（推 main / 手动） |
| docker | 构建镜像并推送 ghcr（版本 tag + `latest`） | 非 PR（PR 只构建校验） |

门禁三件套（发版前必须全绿）：

```bash
npm run typecheck   # tsc，仅覆盖 src-renderer
npm test            # 自检脚本（selfcheck）
npm run verify:pack # 读 app.asar 真读校验打包产物（需先 npm run pack）
```

**这意味着**：提 PR 后 CI 会自动跑 verify（typecheck + 自检 + 构建）。但 `verify:pack` 依赖打包产物（只有 desktop job 产出，PR 不打包），所以请在本地先 `npm run pack` 再跑一遍，全绿再提 PR。

## 3. 版本号与发版由维护者控制

- **不要**在 PR 里改 `package.json` 的 `version` / `buildNumber`，也不要动 `version.ts`、`About.tsx`、`docker-compose.yml`、`README.md` 里的版本串。
- 小版本号的唯一真源是 `package.json` **顶层** `buildNumber`（写进 `build` 段会被 electron-builder 黑名单剔除，导致标题退回三段号）。
- 发布节奏与版本号由维护者统一安排。

## 可以直接提 PR 的改动

- **修 bug**：尤其是数据丢失、任务失败、界面错乱
- **文案修正**：错别字、失效链接、过时描述
- **文档补充**：部署方式、配置项说明、常见问题
- **兼容性**：新的系统版本、新的运行环境

## 建议先开 Issue 讨论的改动

- **重构**：本项目代码风格自成一派，大规模重构对维护者负担很重
- **新增依赖**：每个原生模块/新依赖都会影响打包与跨平台，请先说明为什么现有能力不够
- **改推送版式**：推送消息的版式是唯一拼装点（`src/notify.js` 的 `withAccountHeader`），改动影响所有用户
- **改配置默认值**：老配置缺新字段会导致界面白屏，改动需同步四处并配回归验证

## 代码风格

跟着现有代码走，没有强制的格式化工具：

- 缩进 2 空格，分号结尾，`const` 优先
- 中文注释优先，但**代码标识符一律用 ASCII**
- 不要引入 TypeScript 到 `src/`（主进程是纯 JS，只有 `src-renderer/` 是 TS）

## 提交信息

用中文描述做了什么，一行即可。例如：

```
fix: 阅读任务在剩余量为 0 时不再死循环
feat: 设置页新增每天开始时间
docs: 补充 Docker 部署的环境变量说明
```

## 联系方式

- 提 Issue / PR：直接在 GitHub 上操作
- 安全漏洞：见 [SECURITY.md](SECURITY.md)，**不要**公开 Issue

## 免责声明

贡献即表示你同意你的贡献以本仓库的 MIT 许可发布。若你的改动涉及第三方代码或素材，请在 PR 中注明来源与许可。
