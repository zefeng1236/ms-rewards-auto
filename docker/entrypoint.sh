#!/bin/sh
# 容器入口：先修好数据卷属主，再降权到 node 用户运行
#
# 为什么需要它：
#   docker 挂载宿主机目录时，若目录不存在会由 root 创建，
#   容器内以 node(uid 1000) 运行就会 EACCES 写不进 storage。
#   这里统一 chown 一次，保证「复制 compose 就能跑」。
set -eu

mkdir -p "${MS_REWARDS_STORAGE_DIR:-/data/storage}"
chown -R node:node /data 2>/dev/null || true

exec gosu node "$@"
