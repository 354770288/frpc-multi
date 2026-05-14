#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/frpc-multi}"

cd "$PROJECT_DIR"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Review it before production use."
fi

if grep -R "CHANGE_ME" configs >/dev/null 2>&1; then
  echo "ERROR: Replace all CHANGE_ME values in configs before starting." >&2
  grep -R "CHANGE_ME" configs || true
  exit 1
fi

docker compose pull
docker compose up -d
docker compose ps

