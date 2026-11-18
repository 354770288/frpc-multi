#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/frpc-multi}"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"

cd "$PROJECT_DIR"
mkdir -p "$BACKUP_DIR"

stamp="$(date +%Y%m%d-%H%M%S)"
archive="$BACKUP_DIR/frpc-multi-configs-$stamp.tar.gz"

paths=()
for candidate in compose.yaml compose.console.yaml compose.agent.yaml .env scripts docs compose.generated.yaml instances systemd; do
  [ -e "$candidate" ] && paths+=("$candidate")
done

if [ "${#paths[@]}" -gt 0 ]; then
  tar -czf "$archive" "${paths[@]}"
  chmod 600 "$archive" 2>/dev/null || true
  echo "Config backup written: $archive"
fi

# 若主控容器 frpc-console 正在本机运行，自动执行 SQLite 在线一致性热备
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "${CONTAINER_NAME:-frpc-console}"; then
  PROJECT_DIR="$PROJECT_DIR" BACKUP_DIR="$BACKUP_DIR" KEEP_DAYS="$KEEP_DAYS" bash "$PROJECT_DIR/scripts/backup-console.sh"
fi

find "$BACKUP_DIR" -type f -name 'frpc-multi-configs-*.tar.gz' -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true
