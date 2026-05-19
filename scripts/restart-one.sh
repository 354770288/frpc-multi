#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/frpc-multi}"
client="${1:-}"

if [ -z "$client" ]; then
  echo "Usage: $0 <instance-name>" >&2
  echo "       (e.g. $0 client-001)" >&2
  exit 1
fi

if ! [[ "$client" =~ ^[a-z0-9](-?[a-z0-9])+$ ]]; then
  echo "ERROR: instance name must match [a-z0-9-], length 3-40, no leading/trailing dash" >&2
  exit 1
fi

cd "$PROJECT_DIR"

if [ ! -d "instances/$client" ]; then
  echo "ERROR: instance directory instances/$client does not exist" >&2
  exit 1
fi

docker compose -f compose.yaml -f compose.generated.yaml up -d --no-deps --force-recreate "frpc-$client"
docker compose -f compose.yaml -f compose.generated.yaml ps "frpc-$client"
