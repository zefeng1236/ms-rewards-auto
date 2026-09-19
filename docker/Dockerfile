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
# @ttqtt/liquid-glass-react 上游已从 npm 撤版（0.2.0 各镜像站 404），
# 依赖改为 file:docker/vendor/…tgz 离线包，npm ci 需要该 tarball 在上下文里
COPY package.json package-lock.json ./
COPY docker/vendor ./docker/vendor
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
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    MS_REWARDS_CHROMIUM_ARGS=--no-sandbox,--disable-dev-shm-usage,--disable-gpu

# ① 先装 CA 证书（用镜像自带的 http 官方源）
#    坑：node:*-slim 不带 ca-certificates，直接换 https 国内源会报
#    "No system certificates available ... Certificate verification failed"，
#    必须先装它，否则 https 源握手失败 → apt update 全红 → exit 100
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ② 换成国内源后装 Chromium 本体 + 时区 + 中文字体
#    deb822（bookworm 默认）与传统 sources.list 都试一遍
RUN set -eux; \
    if [ -n "$DEBIAN_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org/debian|$DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i "s|http://deb.debian.org/debian|$DEBIAN_MIRROR|g" /etc/apt/sources.list 2>/dev/null || true; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        chromium \
        tzdata \
        gosu \
        fonts-noto-cjk \
        fonts-noto-color-emoji \
    ; \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime; \
    echo $TZ > /etc/timezone; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    chromium --version

WORKDIR /app

# ③ 后端依赖层：单独一层，源码变动不会重装依赖
#    liquid-glass-react 为 file: 离线依赖（见阶段一注释），需带上 vendor tarball
COPY package.json package-lock.json ./
COPY docker/vendor ./docker/vendor
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
