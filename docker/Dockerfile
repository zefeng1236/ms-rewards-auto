# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# MS Rewards Auto · Docker 版
#
# 三条设计取舍（改动前请先读，都是实测踩出来的）：
#   1. 基础镜像用 Debian 12 (bookworm) 而不是 Ubuntu 24.04 (noble)：
#      noble 的 chromium 是 snap 包，容器里装不了；bookworm 有官方 deb。
#   2. Chromium 走 apt，不走 `npx playwright install`：
#      Playwright 官方 CDN 在国内普遍不可达（本机实测容器内下载返回 000）。
#      apt 的 Chromium 版本比 Playwright 自带的新，CDP 向后兼容，已实证可用。
#   3. 前端（React）在镜像内构建，不依赖宿主机 npm：
#      多阶段 builder 用同一份 src-renderer 源码跑 vite，产物拷进运行时镜像。
#      用户只要 `docker compose up -d --build`，不必先在本地 npm install。
#   4. apt / npm 默认都走国内源，且源是**实测选出来的**：
#      deb.debian.org 官方源极慢；国内镜像之间差异也很大。2026-09-22 在测试服务器上
#      按 chromium 真实 deb 取前 12MB 采样实测（MB/s）：
#        mirror.nju.edu.cn 35.8 > tuna 26.2 > bfsu 9.3 > ustc 7.0 > huawei 6.0 > tencent 1.9
#      阿里云当时只有 10.6（原来的默认），故默认改用南大镜像。
#      海外环境用 --build-arg DEBIAN_MIRROR= 改回官方源。
#   5. apt 与 npm 都挂 BuildKit cache mount（/var/lib/apt、/var/cache/apt、/root/.npm）：
#      前一次构建下过的包，即使 Dockerfile 改动导致层缓存失效也还能复用，
#      不必每次重下 150MB+ 的 Chromium 依赖。因此这两处**不要**再写
#      `apt-get clean` / `rm -rf /var/lib/apt/lists/*` / `npm cache clean`——那会把缓存清掉。
# ---------------------------------------------------------------------------

# ===========================================================================
# 阶段一：构建 React 前端（产物 → /frontend）
#   node_modules 与最终镜像完全隔离，运行时镜像不会带 devDependencies
# ===========================================================================
FROM node:22-bookworm-slim AS frontend

ARG NPM_REGISTRY=https://registry.npmmirror.com

WORKDIR /build

# 依赖层：只依赖 package*.json，源码改动不会触发重新 npm ci
#
# ⚠️ npm ci 会**严格校验** package.json 与 package-lock.json 是否一致：两者一旦漂移
#    （哪怕只是一个依赖的 spec 不同），这里会直接 exit 1，而且报错只在构建日志里，
#    前端产物根本没生成。改依赖后务必重新跑 `npm install --package-lock-only` 同步 lock。
#
#    历史上踩过：package.json 写着 "@ttqtt/liquid-glass-react": "0.0.1"，
#    而 lock 还停在 file:docker/vendor/…0.2.0.tgz，容器构建一直失败。
#    0.2.0 上游已撤版，项目现在直接用 npm 上的 0.0.1（不再需要 vendor tarball）。
COPY package.json package-lock.json ./
# --ignore-scripts：跳过 electron / playwright 的 postinstall 下载（构建前端用不到）
# /root/.npm 挂 cache mount：npm 缓存跨构建复用，重复构建秒过依赖层。
# 不要在这里写 `npm cache clean`——那正好把刚挂上的缓存清空。
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm config set registry "$NPM_REGISTRY" \
    && npm ci --no-audit --no-fund --ignore-scripts

COPY src-renderer ./src-renderer
RUN node node_modules/vite/bin/vite.js build --config src-renderer/vite.web.config.ts \
    && test -f src/web/dist/index.html

# ===========================================================================
# 阶段二：运行时
# ===========================================================================
FROM node:22-bookworm-slim

ARG NPM_REGISTRY=https://registry.npmmirror.com
# 实测最快（见文件头第 4 条）。换成官方源：--build-arg DEBIAN_MIRROR=https://deb.debian.org/debian
ARG DEBIAN_MIRROR=https://mirror.nju.edu.cn/debian

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    NODE_ENV=production \
    MS_REWARDS_STORAGE_DIR=/data/storage \
    MS_REWARDS_CHROMIUM_FALLBACK=/usr/bin/chromium \
    MS_REWARDS_CHROMIUM_ARGS=--no-sandbox,--disable-dev-shm-usage,--disable-gpu

# 注意这里用的是 MS_REWARDS_CHROMIUM_FALLBACK 而不是 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH：
#   前者 = 「指纹浏览器不可用时的兜底」，后者 = 「运维强指定，永远优先」。
# 早期版本用后者把容器 Chromium 钉死，结果指纹浏览器下载完也永远轮不到它
# （优先级见 src/browser.js 的 resolveBrowserSource）。容器里 Playwright 自带
# Chromium 是缺席的（npm ci --ignore-scripts 跳过了下载），所以这个兜底必须留着。

# ① 先装 CA 证书（用镜像自带的 http 官方源）
#    坑：node:*-slim 不带 ca-certificates，直接换 https 国内源会报
#    "No system certificates available ... Certificate verification failed"，
#    必须先装它，否则 https 源握手失败 → apt update 全红 → exit 100
#    走 cache mount：这一步的 .deb 与索引下次构建直接复用（不写 clean，否则清掉缓存）
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates

# ② 换成国内源后装 Chromium 本体 + 时区 + 中文字体
#    deb822（bookworm 默认）与传统 sources.list 都试一遍。
#    sed 在 http://deb.debian.org/debian 上做前缀替换，因此 `debian-security` 会一并
#    变成 `<镜像>/debian-security`——这是安全更新包的来源（chromium 本体 80MB 就在这），
#    只换主仓不换 security 是常见的半吊子换源，务必一起换。
#
#    xz-utils 是给**指纹浏览器**用的：Linux 版资产是 .tar.xz，而 GNU tar 解 xz
#    必须调用外部 `xz` 程序（不链接 liblzma）。实测不装它时 `tar -xf` 直接
#    exit 127「xz: not found」——指纹浏览器会卡在解压这一步。体积只有几百 KB。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    set -eux; \
    if [ -n "$DEBIAN_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org/debian|$DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i "s|http://deb.debian.org/debian|$DEBIAN_MIRROR|g" /etc/apt/sources.list 2>/dev/null || true; \
    fi; \
    printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\nAcquire::http::Pipeline-Depth "10";\nAcquire::Queue-Mode "access";\n' \
      > /etc/apt/apt.conf.d/99-msrewards-tuning; \
    apt-get update; \
    # 图形转发栈（KasmVNC = X server + VNC server + Web UI 三合一）
    #   取代原先的 xvfb + x11vnc + websockify + novnc + fluxbox。
    #   为什么换：noVNC 是纯 JS 解码器（瓶颈 3），1440×900 才能勉强喂得动；
    #   KasmVNC 浏览器原生 WebP 解码（瓶颈 3 直接消失），并自带 WebP/JPEG/QOI
    #   编码 + 多线程 + DRI3 GPU 加速（NAS 上 AMD/Intel 核显直接可用）。
    #   官方 deb 在 https://github.com/kasmtech/KasmVNC/releases
    #   GPU 驱动不在基础镜像里硬装：Debian 默认只启用 main，
    #   intel-media-va-driver-non-free 属于可选 non-free 包，且 NAS 通常已经由宿主
    #   管理驱动。需要硬件加速时只需透传 /dev/dri（见 compose 注释）；无 GPU 时
    #   KasmVNC 自动回退 CPU，不应阻塞普通服务器构建。
    apt-get install -y --no-install-recommends \
        chromium \
        xz-utils \
        tzdata \
        gosu \
        fonts-noto-cjk \
        fonts-noto-color-emoji \
        curl \
        ca-certificates \
        x11-xkb-utils \
        xkb-data \
        xauth \
        libbsd0 \
        libgbm1 \
        libgl1 \
        libpixman-1-0 \
        libxfont2 \
        libxshmfence1 \
        libxtst6 \
        libyaml-tiny-perl \
        libswitch-perl \
        libtry-tiny-perl \
        liblist-moreutils-perl \
        libdatetime-perl \
        libdatetime-timezone-perl \
        libscalar-list-utils-perl \
        libhash-merge-simple-perl \
    ; \
    # KasmVNC deb 装在第二阶段（不在 cache mount 下，避免半成品污染 apt 缓存）。
    # 镜像里预装 + 缓存版本号 ARG，将来上游发版只改这一处。
    rm -rf /var/lib/apt/lists/*; \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime; \
    echo $TZ > /etc/timezone; \
    chromium --version; \
    xz --version | head -1

# ⑥ KasmVNC（核心图形栈）
#   - 必须卸掉 apt cache 防止半成品（deb 没装完时缓存里有 锁文件，污染下次构建）
#   - 必须先有 ca-certificates（已在阶段二 ① 装），直连 GitHub 失败时回退 gh-proxy
#   - 一旦上游发新版：改 KASMVNC_VERSION 与 URL 一处即可
ARG KASMVNC_VERSION=1.5.0
ARG KASMVNC_URL=https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_bookworm_${KASMVNC_VERSION}_amd64.deb
ARG KASMVNC_PROXY=https://gh-proxy.org/
RUN set -eux; \
    if ! curl --connect-timeout 10 --max-time 120 -fsSL -o /tmp/kasmvnc.deb "$KASMVNC_URL"; then \
      rm -f /tmp/kasmvnc.deb; \
      curl --connect-timeout 10 --max-time 180 -fsSL -o /tmp/kasmvnc.deb "${KASMVNC_PROXY}${KASMVNC_URL}"; \
    fi; \
    apt-get install -y --no-install-recommends /tmp/kasmvnc.deb; \
    rm /tmp/kasmvnc.deb; \
    which Xkasmvnc; \
    /usr/bin/Xkasmvnc --help 2>&1 | head -3 || true

WORKDIR /app

# ③ 后端依赖层：单独一层，源码变动不会重装依赖
#    （npm ci 严格校验 package.json 与 lock 的一致性，详见阶段一注释）
#    同样挂 /root/.npm 缓存；调试时若怀疑缓存中毒，用 --no-cache-filter 或 docker builder prune 清
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm config set registry "$NPM_REGISTRY" \
    && npm ci --omit=dev --no-audit --no-fund --ignore-scripts

# ④ 源码（src/web/ 内含兜底轻量页）
COPY src/ ./src/
COPY config.json ./
COPY package.json ./

# ⑤ 覆盖上阶段构建出的 React 前端产物 → 访问 / 即完整界面
COPY --from=frontend /build/src/web/dist ./src/web/dist

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/novnc-stack.sh /usr/local/bin/novnc-stack.sh
COPY docker/kasmvnc.yaml /etc/kasmvnc/kasmvnc.yaml
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/novnc-stack.sh

# Xkasmvnc / Xvfb 以 node 身份跑时不会自建 /tmp/.X11-unix（root 跑又会让 Chromium
# attach 不了 SHM）。先由 root 建好 + 1777 权限，省掉日志里那条 euid != 0 报错。
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

RUN mkdir -p /data/storage && chown -R node:node /data /app /home/node /etc/kasmvnc
VOLUME ["/data"]

EXPOSE 25560
# KasmVNC 内置 web UI（MS_REWARDS_ENABLE_NOVNC=1 时才真的拉起）
EXPOSE 6080

HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:25560/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# 以 root 启动（entrypoint 修完属主后自动降权到 node）
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/server.js"]
