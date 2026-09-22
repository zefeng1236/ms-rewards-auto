#!/bin/sh
# ---------------------------------------------------------------------------
# 内置图形转发栈：Xvfb + fluxbox + x11vnc + websockify(noVNC)
#
# 为什么从「独立 novnc 容器」搬进主容器（实测踩出来的，别改回去）：
#   两个容器的 IpcMode 都是 private → MIT-SHM 不可用 → X11 只能走 TCP。
#   1920x1080 全屏时每帧 8.3MB 原始像素走网络（实测累计 140MB），
#   Chromium 每帧 PutImage 都在等 TCP，服务端这一半就这么被拖死。
#   同容器之后 X11 走 Unix socket 并启用共享内存，这段流量直接归零。
#
# 必须以 node 用户运行（entrypoint 用 gosu node 调起）：
#   X server 与 Chromium 同 uid 才能 attach 同一个 SHM 段；root 起的 Xvfb，
#   node 用户的 Chromium 没有权限 attach，会静默回退到 TCP。
#
# 端口：容器内 6080（noVNC 网页）/ 5900（x11vnc，仅限容器内回环）
# ---------------------------------------------------------------------------
set -eu

DISPLAY_NUM=":0"
W="${DISPLAY_WIDTH:-1440}"
H="${DISPLAY_HEIGHT:-900}"
export DISPLAY="$DISPLAY_NUM"
export HOME="${HOME:-/home/node}"

# 虚拟桌面。1440x900 是权衡值：比 1080p 少 37% 像素，noVNC 那个纯 JS 解码器
# 才喂得动；又比 1280x800 宽敞。想改就改 compose 的 DISPLAY_WIDTH/HEIGHT。
# -br 黑底：默认是黑白网格（root weave），VNC 编码代价明显更高。
nohup Xvfb "$DISPLAY_NUM" -screen 0 "${W}x${H}x24" -br -nolisten tcp >/tmp/xvfb.log 2>&1 &

# 等 X 起来（靠 unix socket 判断，省一个 x11-utils 依赖）
i=0
while [ "$i" -lt 100 ] && [ ! -S "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ]; do
  i=$((i + 1))
  sleep 0.1
done

# 窗口管理器：没有 WM 时 X 的输入焦点停在 root window，noVNC 里的键盘
# 事件根本送不到 Chromium（表现为「能点、打不了字」）。fluxbox 关掉工具栏，
# 让窗口最大化就是真正的满屏。
nohup fluxbox >/tmp/fluxbox.log 2>&1 &

# x11vnc 参数逐条都是针对性的，删哪个都会退回到卡顿：
#   -defer 0          默认 20ms 节流输入事件，是鼠标「跳格」的直接原因
#   -wait 10          抓屏间隔从默认 20ms 降到 10ms
#   -threads          多线程抓屏/编码，1080p 下差别很大
#   -scrollcopyrect   页面滚动走 CopyRect，别整屏重传
#   -solid            纯色背景，避开 root weave 的高熵噪声
#   -nosel/-noprimary 不做剪贴板同步，省掉一次全屏重传
nohup x11vnc -forever -shared -display "$DISPLAY_NUM" -rfbport 5900 -nopw \
  -defer 0 -wait 10 -threads -scrollcopyrect -solid \
  -nosel -noprimary -nosetclipboard -xkb >/tmp/x11vnc.log 2>&1 &

nohup websockify --web /usr/share/novnc 6080 localhost:5900 >/tmp/websockify.log 2>&1 &
