#!/bin/sh
# 容器入口：先修好数据卷属主 → 按需拉起 KasmVNC 图形栈 → 降权到 node 用户运行
#
# 为什么需要它：
#   docker 挂载宿主机目录时，若目录不存在会由 root 创建，
#   容器内以 node(uid 1000) 运行就会 EACCES 写不进 storage。
#   这里统一 chown 一次，保证「复制 compose 就能跑」。
set -eu

mkdir -p "${MS_REWARDS_STORAGE_DIR:-/data/storage}"
chown -R node:node /data 2>/dev/null || true

# 内置 KasmVNC（替代早期的独立 novnc 容器）：默认关，MS_REWARDS_ENABLE_NOVNC=1 启用。
# 必须在主进程前起来：
#   - 以 node 身份拉起（root 起的 X server，Chromium attach 不了它的 SHM 段）
#   - 提前写 /home/node/.kasmpasswd（KasmVNC 启动会检查，没就报错要交互）
#   - 等 /tmp/.X11-unix/X1 出现再放行主进程，否则「去登录」会撞上还没就绪的 X
if [ "${MS_REWARDS_ENABLE_NOVNC:-0}" = "1" ]; then
  if [ ! -f /home/node/.kasmpasswd ]; then
    # 空密码文件（kasmpasswd 把"无密码"理解为保留文件不存在；这里手动建空文件，
    # KasmVNC 启动时检测到就跳过密码校验）。
    touch /home/node/.kasmpasswd
  fi
  chown node:node /home/node/.kasmpasswd 2>/dev/null || true
  gosu node /usr/local/bin/novnc-stack.sh >/tmp/novnc-stack.log 2>&1 &
  i=0
  while [ "$i" -lt 100 ] && [ ! -S /tmp/.X11-unix/X1 ]; do
    i=$((i + 1))
    sleep 0.1
  done
  export DISPLAY=:1
fi

exec gosu node "$@"