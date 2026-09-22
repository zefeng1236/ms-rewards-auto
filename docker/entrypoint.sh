#!/bin/sh
# 容器入口：先修好数据卷属主 → 按需拉起内置图形栈 → 降权到 node 用户运行
#
# 为什么需要它：
#   docker 挂载宿主机目录时，若目录不存在会由 root 创建，
#   容器内以 node(uid 1000) 运行就会 EACCES 写不进 storage。
#   这里统一 chown 一次，保证「复制 compose 就能跑」。
set -eu

mkdir -p "${MS_REWARDS_STORAGE_DIR:-/data/storage}"
chown -R node:node /data 2>/dev/null || true

# 内置 noVNC（替代早期的独立 novnc 容器）：默认关，MS_REWARDS_ENABLE_NOVNC=1 启用。
# 必须以 node 身份拉起，X server 与 Chromium 同 uid 才能共享内存（见 novnc-stack.sh）。
# 等 X socket 出现再放行主进程，否则「去登录」会撞上还没就绪的 X。
if [ "${MS_REWARDS_ENABLE_NOVNC:-0}" = "1" ]; then
  gosu node /usr/local/bin/novnc-stack.sh >/tmp/novnc-stack.log 2>&1 &
  i=0
  while [ "$i" -lt 100 ] && [ ! -S /tmp/.X11-unix/X0 ]; do
    i=$((i + 1))
    sleep 0.1
  done
  export DISPLAY=:0
fi

exec gosu node "$@"
