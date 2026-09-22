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
#   4. apt / npm 默认都走国内源（阿里云 / npmmirror）：
#      deb.debian.org 实测极慢（同一构建跑了 10 分钟还没下完）。
#      海外环境可用 --build-arg 改回官方源。
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
RUN npm config set registry "$NPM_REGISTRY" \
    && npm ci --no-audit --no-fund --ignore-scripts \
    && npm cache clean --force

COPY src-renderer ./src-renderer
RUN node node_modules/vite/bin/vite.js build --config src-renderer/vite.web.config.ts \
    && test -f src/web/dist/index.html

# ===========================================================================
# 阶段二：运行时
# ===========================================================================
FROM node:22-bookworm-slim

ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG DEBIAN_MIRROR=https://mirrors.aliyun.com/debian

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
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ② 换成国内源后装 Chromium 本体 + 时区 + 中文字体
#    deb822（bookworm 默认）与传统 sources.list 都试一遍
#
#    xz-utils 是给**指纹浏览器**用的：Linux 版资产是 .tar.xz，而 GNU tar 解 xz
#    必须调用外部 `xz` 程序（不链接 liblzma）。实测不装它时 `tar -xf` 直接
#    exit 127「xz: not found」——指纹浏览器会卡在解压这一步。体积只有几百 KB。
RUN set -eux; \
    if [ -n "$DEBIAN_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org/debian|$DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i "s|http://deb.debian.org/debian|$DEBIAN_MIRROR|g" /etc/apt/sources.list 2>/dev/null || true; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        chromium \
        xz-utils \
        tzdata \
        gosu \
        fonts-noto-cjk \
        fonts-noto-color-emoji \
    ; \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime; \
    echo $TZ > /etc/timezone; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    chromium --version; \
    xz --version | head -1

WORKDIR /app

# ③ 后端依赖层：单独一层，源码变动不会重装依赖
#    （npm ci 严格校验 package.json 与 lock 的一致性，详见阶段一注释）
COPY package.json package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY" \
    && npm ci --omit=dev --no-audit --no-fund --ignore-scripts \
    && npm cache clean --force

# ④ 源码（src/web/ 内含兜底轻量页）
COPY src/ ./src/
COPY config.json ./
COPY package.json ./

# ⑤ 覆盖上阶段构建出的 React 前端产物 → 访问 / 即完整界面
COPY --from=frontend /build/src/web/dist ./src/web/dist

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

RUN mkdir -p /data/storage && chown -R node:node /data /app
VOLUME ["/data"]

EXPOSE 25560

HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:25560/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# 以 root 启动（entrypoint 修完属主后自动降权到 node）
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/server.js"]
