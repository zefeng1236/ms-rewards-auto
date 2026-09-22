#!/bin/sh
# ---------------------------------------------------------------------------
# 容器内置图形栈（KasmVNC 版）
#
# 上一版本用的是 Xvfb + fluxbox + x11vnc + websockify（4 个进程）：
#   Xvfb 出画面 → x11vnc 抓 X 协议 → websockify 转发 → 浏览器 noVNC JS 解码
# 每一段都是瓶颈：1080p 全屏每帧 8.3MB 原始像素过 X 协议；noVNC 又是纯 JS 解码。
#
# 这一版换成 KasmVNC（kasmvncserver 包装器 + Xkasmvnc 子进程）：
#   - framebuffer 直出，根本不经过 X11 协议传输这一段
#   - 浏览器原生 WebP 解码（不再是 noVNC 那套 JS 解 tight）
#   - DRI3 GPU 加速（NAS 上的 AMD/Intel 核显可启用 VAAPI 硬解；没有时静默回退 CPU）
#   - 多线程编码
#
# 官方 Debian 包的 kasmvncserver 负责读取 YAML、初始化 X authority / 用户配置，
# 再拉起 Xkasmvnc；不能直接把 Xkasmvnc 当成完整 Web 服务入口。
# 因此本脚本从「拉起 4 个进程」收敛成「起 1 个包装器及其子进程」。
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

# KasmVNC 官方 Debian 入口是 kasmvncserver（/usr/bin/vncserver 同源）：
# 它会读取 /etc/kasmvnc/kasmvnc.yaml，再以当前用户启动 Xkasmvnc。
# -fg：让日志和生命周期由本脚本控制。
# -xstartup：必须显式指定常驻 WM 脚本（exec fluxbox）。历史踩坑：用 -noxstartup
#   会跳过桌面环境自动选择、且空 xstartup 跑完即被判定「会话结束」→ shutting down
#   server → 误报 "Xvnc deadlocked" 杀掉 Xkasmvnc。fluxbox 常驻后进程才稳定。
# 6080 由 YAML 的 network.websocket_port 固定，Web UI 目录也由 YAML 指定。
nohup /usr/bin/kasmvncserver \
  "$DISPLAY_NUM" \
  -fg \
  -xstartup /home/node/.vnc/xstartup \
  -interface 0.0.0.0 \
  -websocketPort 6080 \
  -prompt 0 \
  > /tmp/kasmvnc.log 2>&1 &