#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

SERVICE_NAME="${SERVICE_NAME:-server-portal}"

confirm_reset() {
  if [[ "${1:-}" == "--yes" ]]; then
    return 0
  fi

  echo "警告：此操作会删除全部用户、推荐码、远程会话、业务文件和审计日志。"
  read -r -p "请输入 RESET 确认恢复出厂：" answer
  [[ "$answer" == "RESET" ]] || { echo "已取消。"; exit 1; }
}

node_config_value() {
  local expression="$1"
  if command -v node >/dev/null 2>&1; then
    node -e "const config = require('./config'); console.log($expression);" 2>/dev/null || true
  fi
}

safe_clear_dir() {
  local dir="$1"
  [[ -n "$dir" ]] || return 0
  mkdir -p "$dir"
  local resolved
  resolved="$(cd "$dir" && pwd -P)"
  case "$resolved" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/sys|/tmp|/usr|/var)
      echo "拒绝清空危险目录：$resolved" >&2
      exit 1
      ;;
  esac
  find "$resolved" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
}

has_systemd_service() {
  command -v systemctl >/dev/null 2>&1 \
    && systemctl list-unit-files "${SERVICE_NAME}.service" --no-legend 2>/dev/null \
      | awk '{print $1}' \
      | grep -qx "${SERVICE_NAME}.service"
}

stop_portal() {
  if has_systemd_service; then
    [[ "$(id -u)" -eq 0 ]] || { echo "检测到 systemd 服务，请使用 root 执行：sudo SERVICE_NAME=$SERVICE_NAME ./factory-reset.sh" >&2; exit 1; }
    systemctl stop "$SERVICE_NAME" || true
  elif [[ -x ./stop.sh ]]; then
    ./stop.sh || true
  fi
}

start_portal() {
  if has_systemd_service; then
    systemctl start "$SERVICE_NAME"
  elif [[ -x ./start.sh ]]; then
    ./start.sh
  fi
}

confirm_reset "${1:-}"

DATA_ROOT="$(node_config_value "config.data.root")"
FILE_ROOT="$(node_config_value "config.files.root")"
DATA_ROOT="${DATA_ROOT:-$PWD/data}"
FILE_ROOT="${FILE_ROOT:-$DATA_ROOT/files}"

stop_portal

mkdir -p "$DATA_ROOT" "$FILE_ROOT"
safe_clear_dir "$FILE_ROOT"

printf '[]\n' > "$DATA_ROOT/users.json"
printf '[]\n' > "$DATA_ROOT/invites.json"
printf '[]\n' > "$DATA_ROOT/remote-sessions.json"
printf '[]\n' > "$DATA_ROOT/audit-logs.json"
: > "$DATA_ROOT/audit.log"

rm -f \
  "$DATA_ROOT/portal.sqlite3" \
  "$DATA_ROOT/portal.sqlite3-shm" \
  "$DATA_ROOT/portal.sqlite3-wal" \
  "$DATA_ROOT/remote-master.key"

chmod 600 \
  "$DATA_ROOT/users.json" \
  "$DATA_ROOT/invites.json" \
  "$DATA_ROOT/remote-sessions.json" \
  "$DATA_ROOT/audit-logs.json" \
  "$DATA_ROOT/audit.log" 2>/dev/null || true

start_portal

echo "恢复出厂完成：系统已重新启动，现在可注册首位管理员。"
