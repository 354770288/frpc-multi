#!/usr/bin/env bash
set -euo pipefail

SWAP_FILE="${SWAP_FILE:-/swapfile}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
SWAPPINESS="${SWAPPINESS:-10}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root." >&2
  exit 1
fi

if ! swapon --show | grep -q .; then
  if [ -e "$SWAP_FILE" ]; then
    echo "ERROR: $SWAP_FILE exists but swap is not active. Inspect it before continuing." >&2
    exit 1
  fi

  fallocate -l "$SWAP_SIZE" "$SWAP_FILE" || dd if=/dev/zero of="$SWAP_FILE" bs=1M count=2048
  chmod 600 "$SWAP_FILE"
  mkswap "$SWAP_FILE"
  swapon "$SWAP_FILE"
  echo "$SWAP_FILE none swap sw 0 0" >> /etc/fstab
fi

cat >/etc/sysctl.d/99-frpc-multi.conf <<SYSCTL
vm.swappiness=$SWAPPINESS
vm.vfs_cache_pressure=50
SYSCTL

sysctl --system
swapon --show

