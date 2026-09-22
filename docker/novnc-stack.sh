#!/bin/sh
# ---------------------------------------------------------------------------
# 容器内置图形栈（KasmVNC 版）
#
# 上一版本用的是 Xvfb + fluxbox + x11vnc + websockify（4 个进程）：
#   Xvfb 出画面 → x11vnc 抓 X 协议 → websockify 转发 → 浏览器 noVNC JS 解码
# 每一段都是瓶颈：1080p 全屏每帧 8.3MB 原始像素过 X 协议；noVNC 又是纯 JS 解码。
#
# 这一版换成 KasmVNC（1 个进程 Xkasmvnc = X server + VNC server + Web UI 三合一）：
#   - framebuffer 直出，根本不经过 X11 协议传输这一段
#   - 浏览器原生 WebP 解码（不再是 noVNC 那套 JS 解 tight）
#   - DRI3 GPU 加速（NAS 上的 AMD/Intel 核显可启用 VAAPI 硬解；没有时静默回退 CPU）
#   - 多线程编码
#
# 因此本脚本从「拉起 4 个进程」收敛成「起 1 个进程」。
#
# ⚠️ 必须以 node 身份拉起（entrypoint 用 gosu node）：
#   Xkasmvnc 自带 X server，root 起的 X server，Chromium 同样 attach 不了 SHM
#   段，会静默回退 TCP（虽然本版本没了跨容器 TCP，但 SHM 仍是首选）。
#
# 端口：容器内 6080（KasmVNC 自带的 HTTP/WebUI）
# ---------------------------------------------------------------------------
set -eu

DISPLAY_NUM=":1"
export DISPLAY="$DISPLAY_NUM"
export HOME="${HOME:-/home/node}"

# KasmVNC 端口 = 6080。Deb 默认是 5900 + websocket 自动；我们显式钉 6080 以与
# 历史端口和 compose 端口映射保持一致（少改一处）。
# -ssl=0：与 kasmvnc.yaml 的 network.ssl.require_ssl: false 配套；
#   不写 -ssl=0 时它会要求 snakeoil 证书，没有就启动失败。
# -no-bootstrap：KasmVNC 启动后想给我们自动生成密码+选桌面，容器里非交互，
#   没这套机制能跑。密码文件 /home/node/.kasmpasswd 由 entrypoint 提前生成。
# -select-de=none：不调 select-de.sh；启动 X server 即可，Chromium 自己会起。
nohup /usr/bin/Xkasmvnc \
  "$DISPLAY_NUM" \
  -fg \
  -httpd /usr/share/kasmvnc/www \
  -port 6080 \
  -interface 0.0.0.0 \
  -ssl=0 \
  -no-bootstrap \
  -select-de none \
  > /tmp/kasmvnc.log 2>&1 &