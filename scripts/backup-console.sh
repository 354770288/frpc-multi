#!/usr/bin/env bash
set -euo pipefail

# Console SQLite 在线一致性热备脚本（基于 sqlite3 backup API，零停机、兼容 WAL 模式）。
# 用法：
#   1) 主控宿主机（容器运行中）：bash scripts/backup-console.sh
#   2) 指定本地数据库路径：DATABASE_PATH=/path/to/console.db bash scripts/backup-console.sh

PROJECT_DIR="${PROJECT_DIR:-/opt/frpc-multi}"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
CONTAINER_NAME="${CONTAINER_NAME:-frpc-console}"
CONTAINER_DB_PATH="${CONTAINER_DB_PATH:-/data/console.db}"
DATABASE_PATH="${DATABASE_PATH:-}"
KEEP_DAYS="${KEEP_DAYS:-30}"

mkdir -p "$BACKUP_DIR"
umask 077

stamp="$(date +%Y%m%d-%H%M%S)"
dest="$BACKUP_DIR/console-db-$stamp.db"
tmp_dest="$dest.tmp.$$"

cleanup() {
  rm -f "$tmp_dest"
}
trap cleanup EXIT

find_python() {
  if [ -x "$PROJECT_DIR/.venv/bin/python" ]; then
    echo "$PROJECT_DIR/.venv/bin/python"
  elif command -v python3 >/dev/null 2>&1; then
    command -v python3
  elif command -v python >/dev/null 2>&1; then
    command -v python
  else
    return 1
  fi
}

if [ -n "$DATABASE_PATH" ]; then
  if [ ! -f "$DATABASE_PATH" ]; then
    echo "ERROR: DATABASE_PATH does not exist: $DATABASE_PATH" >&2
    exit 2
  fi
  py_bin="$(find_python)" || { echo "ERROR: python3 is required for local SQLite backup" >&2; exit 2; }
  "$py_bin" - "$DATABASE_PATH" "$tmp_dest" <<'PY'
import os
import sqlite3
import sys

src_path, dst_path = sys.argv[1], sys.argv[2]
src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True, timeout=30.0)
dst = sqlite3.connect(dst_path)
try:
    src.backup(dst)
    dst.commit()
finally:
    dst.close()
    src.close()
os.chmod(dst_path, 0o600)
check_conn = sqlite3.connect(f"file:{dst_path}?mode=ro", uri=True)
try:
    verdict = check_conn.execute("PRAGMA integrity_check").fetchone()[0]
    if verdict != "ok":
        raise SystemExit(f"integrity_check failed: {verdict}")
finally:
    check_conn.close()
PY
else
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker not found and DATABASE_PATH not specified" >&2
    exit 2
  fi
  container_tmp="/tmp/console-backup-$stamp-$$.db"
  docker exec -i "$CONTAINER_NAME" python - "$CONTAINER_DB_PATH" "$container_tmp" <<'PY'
import os
import sqlite3
import sys

src_path, dst_path = sys.argv[1], sys.argv[2]
src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True, timeout=30.0)
dst = sqlite3.connect(dst_path)
try:
    src.backup(dst)
    dst.commit()
finally:
    dst.close()
    src.close()
os.chmod(dst_path, 0o600)
check_conn = sqlite3.connect(f"file:{dst_path}?mode=ro", uri=True)
try:
    verdict = check_conn.execute("PRAGMA integrity_check").fetchone()[0]
    if verdict != "ok":
        raise SystemExit(f"integrity_check failed: {verdict}")
finally:
    check_conn.close()
PY
  docker cp "$CONTAINER_NAME:$container_tmp" "$tmp_dest"
  docker exec "$CONTAINER_NAME" rm -f "$container_tmp" >/dev/null 2>&1 || true
  chmod 600 "$tmp_dest"
fi

mv -f "$tmp_dest" "$dest"
chmod 600 "$dest"

find "$BACKUP_DIR" -type f -name 'console-db-*.db' -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true

echo "Console DB backup verified (mode 0600, integrity_check=ok): $dest"
