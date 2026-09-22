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
#   - 准备至少一个 Kasm 用户；官方包装器在禁止交互时遇到空文件会直接退出
#   - 等 /tmp/.X11-unix/X1 出现再放行主进程，否则「去登录」会撞上还没就绪的 X
if [ "${MS_REWARDS_ENABLE_NOVNC:-0}" = "1" ]; then
  umask 077
  KASM_USER="${MS_REWARDS_KASM_USER:-msrewards}"
  KASM_CREDENTIALS="${MS_REWARDS_STORAGE_DIR:-/data/storage}/kasm-credentials.txt"
  KASM_PASSWD="/home/node/.kasmpasswd"
  KASM_PASSWORD="${MS_REWARDS_KASM_PASSWORD:-}"

  # 首次启动生成随机密码并持久化；文件权限 600，日志中不打印密码。
  # 用户也可以通过 MS_REWARDS_KASM_PASSWORD 固定密码，便于 NAS 部署后统一配置。
  if [ -z "$KASM_PASSWORD" ] && [ -f "$KASM_CREDENTIALS" ]; then
    saved_user="$(sed -n 's/^username=//p' "$KASM_CREDENTIALS" | head -n 1)"
    saved_password="$(sed -n 's/^password=//p' "$KASM_CREDENTIALS" | head -n 1)"
    if [ -n "$saved_user" ] && [ -n "$saved_password" ]; then
      KASM_USER="$saved_user"
      KASM_PASSWORD="$saved_password"
    fi
  fi
  if [ -z "$KASM_PASSWORD" ]; then
    KASM_PASSWORD="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n' | cut -c1-24)"
  fi

  credentials_tmp="$(mktemp)"
  {
    printf 'username=%s\n' "$KASM_USER"
    printf 'password=%s\n' "$KASM_PASSWORD"
  } > "$credentials_tmp"
  mv "$credentials_tmp" "$KASM_CREDENTIALS"
  chown node:node "$KASM_CREDENTIALS"
  chmod 600 "$KASM_CREDENTIALS"

  # KasmVNC 官方入口固定从 $HOME/.kasmpasswd 读取用户数据库；每次启动从
  # 持久化凭据重建哈希文件，容器重建也不会丢登录用户。
  passwd_tmp="$(mktemp)"
  chown node:node "$passwd_tmp"
  printf '%s\n%s\n' "$KASM_PASSWORD" "$KASM_PASSWORD" |
    gosu node /usr/bin/kasmvncpasswd -u "$KASM_USER" -w "$passwd_tmp"
  mv "$passwd_tmp" "$KASM_PASSWD"
  chown node:node "$KASM_PASSWD"
  chmod 600 "$KASM_PASSWD"

  gosu node /usr/local/bin/novnc-stack.sh >/tmp/novnc-stack.log 2>&1 &
  i=0
  while [ "$i" -lt 100 ] && [ ! -S /tmp/.X11-unix/X1 ]; do
    i=$((i + 1))
    sleep 0.1
  done
  export DISPLAY=:1
fi

exec gosu node "$@"