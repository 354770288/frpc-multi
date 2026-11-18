#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/frpc-multi}"
WARN_RESTARTS="${WARN_RESTARTS:-3}"
WARN_DISK_PERCENT="${WARN_DISK_PERCENT:-85}"
CHECK_ROLE="${CHECK_ROLE:-auto}" # auto | console | agent

cd "$PROJECT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is not installed or not in PATH" >&2
  exit 2
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: docker compose plugin is not available" >&2
  exit 2
fi

failed=0

check_compose_stack() {
  local label="$1"
  shift
  local cids
  cids="$(docker compose "$@" ps -q 2>/dev/null || true)"
  if [ -z "$cids" ]; then
    echo "== $label: no containers running =="
    return 0
  fi
  echo "== $label compose status =="
  docker compose "$@" ps
  echo
  echo "== $label resource snapshot =="
  # shellcheck disable=SC2086
  docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}" $cids 2>/dev/null || true

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
  done <<< "$cids"
}

if [ "$CHECK_ROLE" = "console" ] || { [ "$CHECK_ROLE" = "auto" ] && [ -f compose.console.yaml ]; }; then
  if [ -f compose.console.yaml ]; then
    check_compose_stack "frpc-console" -f compose.console.yaml
    if docker ps --format '{{.Names}}' | grep -qx "frpc-console"; then
      echo
      echo "== console SQLite quick_check =="
      if ! docker exec frpc-console python -c 'import sqlite3,os; p=os.getenv("DATABASE_PATH","/data/console.db"); c=sqlite3.connect(f"file:{p}?mode=ro",uri=True); r=c.execute("PRAGMA quick_check").fetchone()[0]; c.close(); print("SQLite quick_check:",r); raise SystemExit(0 if r=="ok" else 1)'; then
        echo "ERROR: console SQLite quick_check failed"
        failed=1
      fi
    fi
  fi
fi

if [ "$CHECK_ROLE" = "agent" ] || { [ "$CHECK_ROLE" = "auto" ] && [ -f compose.yaml ]; }; then
  compose_args=(-f compose.yaml)
  [ -f compose.generated.yaml ] && compose_args+=(-f compose.generated.yaml)
  check_compose_stack "frpc-agent-instances" "${compose_args[@]}"
fi

disk_percent="$(df -P "$PROJECT_DIR" | awk 'NR==2 {gsub("%","",$5); print $5}')"
if [ "${disk_percent:-0}" -ge "$WARN_DISK_PERCENT" ]; then
  echo "WARN: disk usage for $PROJECT_DIR is ${disk_percent}%"
fi

exit "$failed"
