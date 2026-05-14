#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/frpc-multi}"
client="${1:-}"

if [ -z "$client" ]; then
  echo "Usage: $0 client-01" >&2
  exit 1
fi

case "$client" in
  client-0[1-9]|client-10) ;;
  *)
    echo "ERROR: client must be client-01 through client-10" >&2
    exit 1
    ;;
esac

cd "$PROJECT_DIR"
docker compose up -d --no-deps --force-recreate "frpc-$client"
docker compose ps "frpc-$client"

