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
#    0.2.0 上游已撤版；项目现在直接用 npm 镜像上的正式版（当前 0.0.2，不再需要 vendor tarball）。
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
    MS_REWARDS_FINGERPRINT_PREINSTALLED=/opt/fingerprint-chromium \
    # --disable-gpu-sandbox 是必需的：容器里 GPU 进程默认起不来，WebGL 会整个不可用
    # （GL_VENDOR = Disabled / BindToCurrentSequence failed）。⚠️ 不要用 --disable-gpu。
    MS_REWARDS_CHROMIUM_ARGS=--no-sandbox,--disable-dev-shm-usage,--disable-gpu-sandbox

# 浏览器选型（2026-09 起 Docker 版改为「环境拟真浏览器独占」）：
#   - 镜像内预装 fingerprint-chromium（下一段下载解压到 MS_REWARDS_FINGERPRINT_PREINSTALLED），
#     运行时直接可用、不再发起运行时下载；
#   - 不再安装 apt Chromium：普通 Chromium 的 sec-ch-ua / Client Hints 改不动，
#     会留下「UA 自称 Edge / CH 说 Chromium」的自相矛盾环境特征。环境拟真浏览器从根上同源生成，
#     因此 Docker 版默认、且只用环境拟真浏览器。
#   - --no-sandbox 仍必须传给环境拟真浏览器：容器内以 node(非 root) 运行。
#     extraChromiumArgs 对环境拟真浏览器同样生效（见 src/browser.js）。

# ① 先装 CA 证书（用镜像自带的 http 官方源）
#    坑：node:*-slim 不带 ca-certificates，直接换 https 国内源会报
#    "No system certificates available ... Certificate verification failed"，
#    必须先装它，否则 https 源握手失败 → apt update 全红 → exit 100
#    走 cache mount：这一步的 .deb 与索引下次构建直接复用（不写 clean，否则清掉缓存）
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates

# ② 换成国内源后装图形栈依赖 + 时区 + 中文字体（不再装 apt chromium，环境拟真浏览器在下一段预装）
#    deb822（bookworm 默认）与传统 sources.list 都试一遍。
#    sed 在 http://deb.debian.org/debian 上做前缀替换，因此 `debian-security` 会一并
#    变成 `<镜像>/debian-security`——这是安全更新包的来源，只换主仓不换 security 是
#    常见的半吊子换源，务必一起换。
#
#    xz-utils 是给**环境拟真浏览器预装**用的：Linux 版资产是 .tar.xz，而 GNU tar 解 xz
#    必须调用外部 `xz` 程序（不链接 liblzma）。实测不装它时 `tar -xf` 直接
#    exit 127「xz: not found」。体积只有几百 KB。
#
#    后半段的 libnss3 / libgtk-3-0 等是 **Chromium 运行时依赖**：这些库原本是
#    `apt install chromium` 顺带拉进来的。既然 Docker 版已改为「不装 apt chromium」，
#    就必须显式列出，否则环境拟真浏览器一启动就报 libnss3.so / libatk-1.0.so 找不到。
#    改动这段后务必在容器里跑一次 `ldd <chrome>` 确认 no "not found"（见 README）。
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
    #   （保留 fluxbox 作 KasmVNC 会话的常驻 WM 兜底）
    apt-get install -y --no-install-recommends \
        xz-utils \
        openssl \
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
        libunwind8 \
        ssl-cert \
        libyaml-tiny-perl \
        libswitch-perl \
        libtry-tiny-perl \
        liblist-moreutils-perl \
        libdatetime-perl \
        libdatetime-timezone-perl \
        libscalar-list-utils-perl \
        libhash-merge-simple-perl \
        fluxbox \
        libnss3 \
        libnspr4 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libatspi2.0-0 \
        libcups2 \
        libdrm2 \
        libxkbcommon0 \
        libxkbcommon-x11-0 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxrandr2 \
        libxrender1 \
        libxcursor1 \
        libxext6 \
        libxi6 \
        libsm6 \
        libice6 \
        libx11-xcb1 \
        libxcb1 \
        libxcb-dri3-0 \
        libxcb-present0 \
        libxcb-sync1 \
        libxcb-shm0 \
        libxcb-xfixes0 \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        libcairo2 \
        libasound2 \
        libexpat1 \
        libdbus-1-3 \
        libuuid1 \
        libfontconfig1 \
        libfreetype6 \
        libgtk-3-0 \
        libgdk-pixbuf-2.0-0 \
        libxss1 \
    ; \
    # Debian Fluxbox theme launches fbsetbg for its bundled JPEG, but no image backend is installed.
    # Remove the theme wallpaper directives; Fluxbox remains the persistent window manager.
    sed -i '/^background:[[:space:]]/d; /^background[.]pixmap:/d' /usr/share/fluxbox/styles/Squared_for_Debian/theme.cfg; \
    rm -rf /var/lib/apt/lists/*; \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime; \
    echo $TZ > /etc/timezone; \
    xz --version | head -1

# Ⓟ 预装环境拟真浏览器（fingerprint-chromium，Docker 版默认且唯一浏览器）
#   - 下载 Linux tar.xz（约 134.7MB）解压到 MS_REWARDS_FINGERPRINT_PREINSTALLED。
#   - 镜像内固定路径、不进 /data 挂载点，容器起来即就绪，运行时不再下载。
#   - 下载源用 gh-proxy 镜像链；上游固定版本与 src/fingerprint-browser.js 的
#     PINNED_VERSION 保持一致（改版本必须两处同步）。
# 解压后找 chrome/chromium/headless_shell 主程序；与桌面版同款「广度优先找主程序」
#     逻辑（见 src/fingerprint-browser.js findExecutable），这里只做一次存在性校验。
#   - 写 version.txt：让 src/fingerprint-browser.js 的 installedVersion() 能报出版本号
#     （与桌面版运行时下载安装的产物同构，状态接口不用为 Docker 单独开分支）。
#   - ldd 自检：缺运行库直接让构建失败，而不是等用户在容器里看到浏览器起不来。
ARG FPCB_VERSION=150.0.7871.186
ARG FPCB_URL=https://github.com/adryfish/fingerprint-chromium/releases/download/${FPCB_VERSION}/ungoogled-chromium-${FPCB_VERSION}-1-x86_64_linux.tar.xz
ARG FPCB_PROXY=https://gh-proxy.com/
RUN set -eux; \
    mkdir -p /opt/fingerprint-chromium; \
    if ! curl --connect-timeout 10 --max-time 600 -fsSL -o /tmp/fpcb.tar.xz "$FPCB_URL"; then \
      rm -f /tmp/fpcb.tar.xz; \
      curl --connect-timeout 10 --max-time 900 -fsSL -o /tmp/fpcb.tar.xz "${FPCB_PROXY}${FPCB_URL}"; \
    fi; \
    tar -xf /tmp/fpcb.tar.xz -C /opt/fingerprint-chromium; \
    rm -f /tmp/fpcb.tar.xz; \
    CHROME_BIN="$(find /opt/fingerprint-chromium -type f \( -name chrome -o -name chromium -o -name headless_shell \) -print -quit)"; \
    test -n "$CHROME_BIN"; \
    chmod +x "$CHROME_BIN"; \
    printf '%s\n' "$FPCB_VERSION" > /opt/fingerprint-chromium/version.txt; \
    if ldd "$CHROME_BIN" | grep -q "not found"; then \
      echo "❌ 环境拟真浏览器缺少运行库，上面 not found 的即为缺失项，请补进本文件的 apt 清单"; \
      ldd "$CHROME_BIN" | grep "not found"; \
      exit 1; \
    fi; \
    echo "✅ 环境拟真浏览器已预装且无缺失运行库: $CHROME_BIN"; \
    "$CHROME_BIN" --no-sandbox --version || echo "（构建期跳过版本号输出，运行时会自检）"

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

# KasmVNC 三层根因之一：即使 require_ssl:false，包装器仍会无条件 CheckSslCertReadable
# 读 /etc/ssl/private/ssl-cert-snakeoil.key。该目录是 drwx--x--- root:ssl-cert，
# node(uid 1000) 不在 ssl-cert 组里 → 进不去 → KEY_UNREADABLE → 打印
# "certificate file doesn't exist or isn't a file" → exit 1。把 node 加进 ssl-cert 组。
RUN usermod -aG ssl-cert node

# KasmVNC 三层根因之二：包装器跑完 ~/.vnc/xstartup 后若没有常驻进程，会判定「会话结束」
# 直接 shutting down server，并误报 "Xvnc seems to be deadlocked" 杀掉 Xkasmvnc。
# 必须有常驻 WM 兜底（fluxbox）。这里预建 xstartup（exec fluxbox），并放一个
# .de-was-selected 标记让 select-de.sh 别再去猜桌面环境。
RUN mkdir -p /home/node/.vnc \
    && printf '#!/bin/sh\nexec fluxbox\n' > /home/node/.vnc/xstartup \
    && chmod +x /home/node/.vnc/xstartup \
    && touch /home/node/.vnc/.de-was-selected \
    && chown -R node:node /home/node/.vnc

RUN mkdir -p /data/storage && chown -R node:node /data /app /home/node /etc/kasmvnc
VOLUME ["/data"]

EXPOSE 25560
# KasmVNC 内置 web UI（MS_REWARDS_ENABLE_NOVNC=1 时才真的拉起）
EXPOSE 6080

HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "require('https').get('https://127.0.0.1:25560/api/health',{rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# 以 root 启动（entrypoint 修完属主后自动降权到 node）
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/server.js"]
