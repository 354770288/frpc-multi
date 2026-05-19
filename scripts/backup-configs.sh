#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/frpc-multi}"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"

cd "$PROJECT_DIR"
mkdir -p "$BACKUP_DIR"

stamp="$(date +%Y%m%d-%H%M%S)"
archive="$BACKUP_DIR/frpc-multi-configs-$stamp.tar.gz"

paths=(compose.yaml .env scripts docs)
[ -f compose.generated.yaml ] && paths+=(compose.generated.yaml)
[ -d instances ] && paths+=(instances)
[ -d systemd ] && paths+=(systemd)

tar -czf "$archive" "${paths[@]}"

find "$BACKUP_DIR" -type f -name 'frpc-multi-configs-*.tar.gz' -mtime +"$KEEP_DAYS" -delete

echo "Backup written: $archive"
