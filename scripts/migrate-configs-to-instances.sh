#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/frpc-multi}"

cd "$PROJECT_DIR"
mkdir -p instances

for config in configs/client-*/frpc.toml; do
  [ -f "$config" ] || continue
  name="$(basename "$(dirname "$config")")"
  target_dir="instances/$name"
  if [ -e "$target_dir" ]; then
    echo "Skip existing instance: $name"
    continue
  fi

  mkdir -p "$target_dir"
  cp "$config" "$target_dir/frpc.toml"
  now="$(date -Iseconds)"
  cat > "$target_dir/meta.json" <<JSON
{
  "name": "$name",
  "displayName": "$name",
  "createdAt": "$now",
  "updatedAt": "$now",
  "enabled": true,
  "description": "Migrated from configs/$name/frpc.toml"
}
JSON
  echo "Migrated: $name"
done

PYTHONPATH=webui/backend python3 - <<'PY'
from pathlib import Path
from app.compose_generator import write_generated_compose
from app.instance_store import InstanceStore

root = Path.cwd()
store = InstanceStore(root)
path = write_generated_compose(root, store.list_instances())
print(f"Generated: {path}")
PY

