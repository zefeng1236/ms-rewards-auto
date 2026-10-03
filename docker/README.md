# Docker 版部署说明

Docker 版把运行环境（Node + Chromium + 系统依赖）全部封进镜像，宿主只需要 Docker。
业务逻辑与桌面版共用同一套 `src/`，**界面也是同一份 React 源码**（`src-renderer/`）——
镜像内用 Vite 现场构建，通过 `src-renderer/src/api/web.ts` 把 Electron 的 IPC 换成 HTTP + SSE，
所以两端界面完全一致，不存在「桌面版功能多、Web 版功能少」的问题。

## 一、快速开始

在项目根目录执行（首次会编译前端，约 3–6 分钟）：

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

然后浏览器打开 `http://<服务器IP>:25560`。

国内机器如果拉基础镜像慢，先配一次镜像加速器（只需做一次；若已有 `daemon.json`
请把 `registry-mirrors` 合并进去，别整个覆盖掉原有配置）：

```bash
sudo tee /etc/docker/daemon.json <<'EOF'
{ "registry-mirrors": [
    "https://docker.1ms.run",
    "https://docker.xuanyuan.me",
    "https://docker.m.daocloud.io"
] }
EOF
sudo systemctl daemon-reload && sudo systemctl restart docker
```

> **镜像内部也已经全部走国内源**，无需额外处理：
> apt 用实测最快的南大镜像（chromium 真实 deb 采样 35.8 MB/s，原阿里云只有 10.6），
> npm 用 npmmirror，环境拟真浏览器下载走 gh-proxy 镜像链。
> apt / npm 都挂了 BuildKit cache mount，**改了 Dockerfile 也不会重下那 150MB 的 Chromium 依赖**。
> 想换 apt 源：`--build-arg DEBIAN_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian`（海外填 `https://deb.debian.org/debian`）。

## 二、首次使用（安装向导）

1. **走完向导**：语言 → 协议 → 声明 → **设置保险库密码** → 个性化。
   密码用来加密账户 Cookie / Token，服务端不保存明文。
2. **保存数字密钥**：建库后向导会展示一串「恢复密钥」。Web 版多两个按钮：
   - `下载为 txt` —— 存到本机磁盘，换设备时用；
   - `🔑 存到本机浏览器` —— 写进这台设备的浏览器本地存储，**下次一键登录**。
3. **下次登录**：打开页面 → 锁屏上直接点 **🔑 使用本机保存的数字密钥登录** 即可进主界面。
   换设备 / 清了浏览器数据，就用 txt 里的密钥或密码登录。
4. **添加账户**：进主界面后「仪表盘 → 新建账户」；登录态可选
   - 把桌面版已登录好的 `storage/` 整个拷到 `./storage/`（同一把密码即可直接解锁）；
   - 或用 noVNC 做一次MS授权登录（见下）。

> 「退出登录」只销毁**当前浏览器**的会话，保险库保持解锁、后台定时任务继续跑；
> 要真正停任务，去「全局设置 → 安全 → 立即锁定」。

## 三、命令速查

```bash
docker compose -f docker/docker-compose.yml logs -f      # 看日志
docker compose -f docker/docker-compose.yml restart
docker compose -f docker/docker-compose.yml down          # 停止并移除容器（数据保留）
docker compose -f docker/docker-compose.yml ps            # 含健康状态

# 进容器跑 CLI（添加账户、授权登录、手动运行）
docker exec -it ms-rewards node src/main.js
```

## 四、首次授权登录（noVNC，可选）

只需要做一次。若账户登录态是从桌面版迁移过来的，可跳过。

```bash
docker compose -f docker/docker-compose.yml --profile login up -d
# 浏览器打开 http://<服务器IP>:6080，在里面完成MS账号登录
docker exec -it ms-rewards node src/main.js login 1
docker compose -f docker/docker-compose.yml --profile login stop
```

## 五、前后端如何对接

前端不直接调 REST，而是复用桌面版那套 `window.api` 接口：

| 桌面版 | Docker 版 |
|---|---|
| `ipcRenderer.invoke(channel, ...args)` | `POST /api/rpc`，body `{ m: 方法名, a: [参数] }` |
| `ipcRenderer.on(channel, cb)` | `GET /api/events`（SSE，帧为 `{"type":"...","payload":...}`） |

方法名与 `src-renderer/src/types/electron.d.ts` 的 `ElectronApi` 完全同名（`overview` / `runAll` /
`getVaultStatus` …），因此新增功能时两端只需各自实现同一个方法名。

事件类型：`running` `log` `accounts` `appearance` `chromium-status` `fingerprint-status`
`install-progress` `account-status` `account-log` `bg-progress`。

### HTTP 接口一览

| 接口 | 说明 |
|---|---|
| `GET /` | React 前端（未构建成功时回退到 `src/web/index.html` 轻量页） |
| `GET /api/health` | 健康检查（compose healthcheck 用），含 `spa` 标记前端产物是否就位 |
| `GET /api/bootstrap` | 引导状态：向导 / 登录 / 主界面 |
| `POST /api/events`（GET） | SSE 事件流；未登录返回 401 |
| `POST /api/rpc` | 统一业务入口，`{m, a}`；未登录时白名单外的方法返回 401 |
| `POST /api/vault/setup` | 建保险库，返回 `recoveryKey`，**建库即登录** |
| `POST /api/vault/unlock` | 解锁（设 Cookie）：`{password}` 或 `{recoveryKey}` |
| `POST /api/logout` | 销毁会话（**不锁保险库**，后台任务继续） |
| `GET /api/bg/cache?f=<name>` | 壁纸缓存图（随机图源固定成同一张） |
| `GET /api/bg/local?p=<路径>` | 本地/上传图片，路径被限制在存储目录内 |

未登录只放行：`getSetup` / `setSetup` / `getVaultStatus` / `getAppearance` / `getBgSrc` /
`chromiumStatus` / `testBgUrl`，其余一律 401。

## 六、数据与备份

全部运行时数据在宿主机的 `./storage/`（容器内 `/data/storage`）：

```
storage/
├── vault.json               保险库元数据（salt / 加密的主密钥）
├── global-config.json       全局设置
├── appearance.json          界面外观
├── launch.json / setup.json 启动偏好 / 向导状态
├── uploads/                 Web 端上传的自定义背景图
├── cache/                   远程壁纸缓存
├── accounts/<id>/state.json 账户登录态（secrets 为密文）
├── fingerprint-chromium/    环境拟真浏览器解压目录（可选增强，约 480MB，不装则无）
├── fp-download/             环境拟真浏览器下载缓存（装完自动清掉）
└── ../logs/app.log          日志
```

备份就是打包 `storage/` 目录。**注意**：`vault.json` 与 `state.json` 是一套，
只拷 `state.json` 而丢了 `vault.json` 会导致登录态解不开。

## 七、注意事项

- **时区**：compose 已设 `TZ=Asia/Shanghai`，改部署地区时记得同步改，否则每日定时会错。
- **不要以 root 跑**：镜像内已切到 `node` 用户，因此 Chromium 必须带 `--no-sandbox`（已在 compose 配好）。
- **不要设 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`**：那是「运维强指定，永远最高优先级」的口子，
  设了以后环境拟真浏览器**装了也不会被用**。本版 Docker 已改为「环境拟真浏览器独占 + 镜像预装」，
  compose 不再传 `MS_REWARDS_CHROMIUM_FALLBACK`（该兜底变量已废弃）。优先级见 `src/browser.js` 的 `resolveBrowserSource`。
- **账号数量**：建议单 IP ≤ 5 个账户，沿用桌面版的串行执行与账号间 20–60 秒随机间隔。
- **宿主断电容灾**：`restart: unless-stopped` 已配置，Docker 随系统启动后容器会自动拉起。
  保险库若未配置环境变量解锁，重启后需在页面上登录一次（可点一键登录）。
- **「启动与托盘」页面在 Web 版已隐藏**：开机自启 / 驻留托盘是桌面端语义，
  容器场景由 `restart: unless-stopped` 负责。

## 八、更新

**自动更新（推荐）**：compose 已内置 Watchtower（`containrrr/watchtower`），每 6 小时检查一次
ghcr 上的 `latest` 镜像，有新版本会自动拉取并重启 `ms-rewards` 容器，全程无需手动操作。
它用 label-enable 模式，只更新打了 `com.centurylinklabs.watchtower.enable=true` 标签的容器
（就是 `ms-rewards`），不会误伤同宿主上的其他容器。

```bash
# 手动触发一次检查（不想等 6 小时轮询时）
docker exec ms-rewards-watchtower /watchtower --run-once
```

**锁定版本（关闭自动更新）**：把 `docker-compose.yml` 里 `ms-rewards` 的
`image: ...:latest` 改成具体版本号（如 `:0.14.2`），并删掉下方 `watchtower` 服务。

**本地改源码重新构建**：前端产物在镜像内构建，改了 `src-renderer/` 后重新执行一次
`up -d --build` 即可。想在宿主机单独出产物（例如排查构建问题）：

```bash
npm run build:web:docker     # 产物输出到 src/web/dist
```

## 九、浏览器来源与环境拟真浏览器（可选增强）

容器里跑哪一个 Chromium，由 `src/browser.js` 的 `resolveBrowserSource()` 按优先级决定：

| 优先级 | 来源 | 容器里的实际取值 |
|---|---|---|
| 1 | `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | **不要设**（设了会永久屏蔽第 2 档） |
| 2 | **环境拟真浏览器**（设置里启用且已下载） | `/data/storage/fingerprint-chromium/.../chrome` |
| 3 | `MS_REWARDS_CHROMIUM_FALLBACK` | `/usr/bin/chromium`（apt 装的，compose 已配） |
| 4 | Playwright 自带 Chromium | 镜像里不存在（`npm ci --ignore-scripts` 跳过了下载） |

**环境拟真浏览器是干什么的**：Playwright 驱动普通 Chromium 时 `sec-ch-ua`（Client Hints）请求头改不动，
会出现「UA 自称 Edge、CH 说 Chromium」的自相矛盾环境特征。环境拟真浏览器是 patch 过源码的
[fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium)，UA / userAgentData / CH 三者同源生成，
并用 `--fingerprint=<种子>` 做种子化环境特征（本项目按账户 ID 派生，同账号长期稳定、不同账号互不相关）。

**在容器里是可用的**（已实测，非推测）：

- Linux 版资产是 `ungoogled-chromium-<版本>-1-x86_64_linux.tar.xz`，约 **134MB**（Windows 版是 181MB）；
- 解压需要 `xz-utils`：GNU tar 解 `.tar.xz` 会调用外部 `xz` 程序，镜像里**已装**（别从 Dockerfile 的 apt 列表里删掉，
  删了会 `tar: Child returned status 127`，环境拟真浏览器卡在解压这一步）；
- 解出的 `chrome` 与 `chrome_crashpad_handler` 同级，满足 `findExecutable()` 的 Linux 判定；
- 容器内 `chrome --version` 正常、`ldd` 缺失动态库 **0 个**、headless 带 `--no-sandbox` 实跑通过
  （只有 dbus 连不上的噪音，apt Chromium 同样会打，无害）。

下载与安装：

- 路径：「软件设置 → 浏览器 → 立即下载」，或**安装向导最后一页**（可勾「跳过」直接下一步）；
- 落在 `/data/storage/fingerprint-chromium/`（在卷内，容器重建不丢），临时下载缓存在 `/data/storage/fp-download/`；
- 走 gh-proxy 镜像链 + 断点续传 + 失败自动换源，下完做 sha256 完整性校验；
- 全局配置 `browser.fingerprint.enable` 默认为 `true`，但**没装好时是静默回落**到第 3 档兜底 Chromium，
  只在日志里留一条 warn —— 所以不装也能正常跑任务，装了才生效。
