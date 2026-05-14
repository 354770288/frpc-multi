#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/frpc-multi}"
WARN_RESTARTS="${WARN_RESTARTS:-3}"
WARN_DISK_PERCENT="${WARN_DISK_PERCENT:-85}"

cd "$PROJECT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is not installed or not in PATH" >&2
  exit 2
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: docker compose plugin is not available" >&2
  exit 2
fi

echo "== frpc compose status =="
docker compose ps

echo
echo "== frpc resource snapshot =="
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}" \
  $(docker compose ps -q) 2>/dev/null || echo "No running frpc containers found."

failed=0

while IFS= read -r cid; do
  [ -n "$cid" ] || continue

  name="$(docker inspect --format '{{.Name}}' "$cid" | sed 's#^/##')"
  running="$(docker inspect --format '{{.State.Running}}' "$cid")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid")"
  restarts="$(docker inspect --format '{{.RestartCount}}' "$cid")"

  if [ "$running" != "true" ]; then
    echo "ERROR: $name is not running"
    failed=1
  fi

  if [ "$health" = "unhealthy" ]; then
    echo "ERROR: $name is unhealthy"
    failed=1
  fi

  if [ "$restarts" -gt "$WARN_RESTARTS" ]; then
    echo "WARN: $name restart count is $restarts"
  fi
done < <(docker compose ps -q)

disk_percent="$(df -P "$PROJECT_DIR" | awk 'NR==2 {gsub("%","",$5); print $5}')"
if [ "${disk_percent:-0}" -ge "$WARN_DISK_PERCENT" ]; then
  echo "WARN: disk usage for $PROJECT_DIR is ${disk_percent}%"
fi

echo
echo "== recent compose events =="
timeout 5s docker compose events --since 10m --json 2>/dev/null | tail -n 20 || true

exit "$failed"
