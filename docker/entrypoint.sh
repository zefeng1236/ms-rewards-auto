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

# 自签 TLS 证书（Passkey/WebAuthn 要求安全上下文，浏览器在纯 HTTP 下拒绝调用）。
# MS_REWARDS_TLS=auto 且证书不存在时生成一次（10 年有效期，SAN 覆盖常见访问方式）；
# 已存在则复用，容器重建不换证书（否则浏览器每次都要重新信任）。
# 浏览器首次访问会弹证书警告，点「继续前往」即可；之后记住。
if [ "${MS_REWARDS_TLS:-auto}" = "auto" ]; then
  TLS_DIR="${MS_REWARDS_STORAGE_DIR:-/data/storage}/tls"
  if [ ! -f "$TLS_DIR/server.crt" ] || [ ! -f "$TLS_DIR/server.key" ]; then
    mkdir -p "$TLS_DIR"
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
      -keyout "$TLS_DIR/server.key" -out "$TLS_DIR/server.crt" \
      -subj "/CN=ms-rewards-auto" \
      -addext "subjectAltName=DNS:localhost,DNS:ms-rewards,IP:127.0.0.1" 2>/dev/null
    chown -R node:node "$TLS_DIR"
    chmod 600 "$TLS_DIR/server.key"
    echo "[entrypoint] 已生成自签 TLS 证书: $TLS_DIR"
  fi
  export MS_REWARDS_TLS_CERT="$TLS_DIR/server.crt"
  export MS_REWARDS_TLS_KEY="$TLS_DIR/server.key"
fi

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

  # docker restart / 崩溃自动重启不会清 /tmp，残留的 X1 锁会让新 Xvnc 直接退出：
  #   "Warning: <host>:1 is taken because of /tmp/.X1-lock" → "A VNC server is already running as :1"
  # 结果容器起来了但图形会话死掉（「去登录」打不开）。2026-10-28 实测踩到。
  # 判据：没有活的 Xvnc 进程时才清锁（有进程在跑就别动，避免误杀正常会话）。
  if ! ps aux 2>/dev/null | grep -q "[X]vnc :1"; then
    rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
  fi

  gosu node /usr/local/bin/novnc-stack.sh >/tmp/novnc-stack.log 2>&1 &
  i=0
  while [ "$i" -lt 100 ] && [ ! -S /tmp/.X11-unix/X1 ]; do
    i=$((i + 1))
    sleep 0.1
  done
  export DISPLAY=:1
fi

# ---- 容器内硬件 GL：① 让 node 拿到渲染设备权限 ② 验证能读 ③ 才加 ANGLE-Vulkan ----
# 为什么是「探测后再加」而不是直接写进 compose 默认值：
#   2026-10-27 实测（NAS 上同一镜像，两个场景对照）
#     有 /dev/dri + mesa-vulkan-drivers + --use-gl=angle --use-angle=vulkan
#        → ANGLE (AMD, Vulkan 1.3.230 (AMD Radeon Graphics (RADV RENOIR)), radv)
#          opengl=enabled_on / gpu_compositing=enabled  ← 真 GPU
#     无 /dev/dri  + 同样装好驱动 + 同样两个参数
#        → getContext('webgl') 返回 null，WebGL **完全不可用**
#          （ANGLE 的 Vulkan 路径不接 lavapipe 软件 ICD）
#   而「桌面浏览器没有 WebGL」是比软件渲染更强的机器人特征 —— 所以无 GPU 时必须
#   保持默认后端（退到 SwiftShader，至少 WebGL 还在）。
#
# 为什么还要「给 node 加设备组」（2026-10-28 实测，这是 0.15.7 的漏）：
#   容器里 /dev/dri/renderD128 是 `crw-rw---- root:<宿主GID>`（NAS 上是 105），
#   容器内既没有这个组名、node 也不在其中 → node 打不开渲染设备，
#   ANGLE 只能挑到 lavapipe（软件 Vulkan），WebGL 反而**直接不可用**；
#   同样是这套参数，以 root 跑就正常（RADV RENOIR）。
#   所以这里按设备真实 GID 建组 + usermod 把 node 加进去，再用 gosu 实测可读，
#   读不到就**不加参数**（宁可 SwiftShader，也不能把 WebGL 搞没）。
#   /etc/group 在容器重建时重置，因此每次启动都做一遍（幂等）。
# 关掉探测（想强制用软件后端）：MS_REWARDS_GPU_VULKAN=0
if [ "${MS_REWARDS_GPU_VULKAN:-auto}" = "0" ]; then
  echo "[entrypoint] MS_REWARDS_GPU_VULKAN=0 → 保持默认 GL 后端（WebGL 可用）"
elif ! ls /dev/dri/renderD* >/dev/null 2>&1; then
  echo "[entrypoint] 未检测到 /dev/dri → 保持默认 GL 后端（WebGL 可用）"
else
  RENDER_OK=0
  for dev in /dev/dri/renderD*; do
    [ -e "$dev" ] || continue
    gid="$(stat -c '%g' "$dev" 2>/dev/null || echo '')"
    [ -n "$gid" ] || continue
    gname="$(getent group "$gid" | cut -d: -f1)"
    if [ -z "$gname" ]; then
      gname="dri$gid"
      groupadd -g "$gid" "$gname" 2>/dev/null || true
    fi
    usermod -aG "$gname" node 2>/dev/null || true
    if gosu node test -r "$dev" 2>/dev/null; then
      RENDER_OK=1
      echo "[entrypoint] $dev 可访问（组 $gname / gid $gid）"
    fi
  done

  if [ "$RENDER_OK" != "1" ]; then
    echo "[entrypoint] /dev/dri 存在但 node 无权访问 → 不加 Vulkan 参数（保持 WebGL 可用）"
  elif printf '%s' "${MS_REWARDS_CHROMIUM_ARGS:-}" | grep -q -- "--use-angle=vulkan"; then
    echo "[entrypoint] 已由环境变量指定 ANGLE-Vulkan"
  else
    MS_REWARDS_CHROMIUM_ARGS="${MS_REWARDS_CHROMIUM_ARGS:-}"
    MS_REWARDS_CHROMIUM_ARGS="${MS_REWARDS_CHROMIUM_ARGS:+$MS_REWARDS_CHROMIUM_ARGS,}--use-gl=angle,--use-angle=vulkan"
    export MS_REWARDS_CHROMIUM_ARGS
    echo "[entrypoint] 检测到可访问的 /dev/dri → 启用 ANGLE-Vulkan 硬件渲染"
  fi
fi

exec gosu node "$@"
