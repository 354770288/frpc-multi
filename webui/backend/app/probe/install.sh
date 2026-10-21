#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Run as root'; exit 1; }
. /etc/os-release
case "$ID" in debian|ubuntu) ;; *) echo 'Debian/Ubuntu required'; exit 1;; esac
case "$(uname -m)" in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; *) echo 'Unsupported architecture'; exit 1;; esac
install -d -m 700 /etc/frpc-probe
# Upgrading preserves existing identity. Legacy service credentials stay root only.
if [ -f /etc/frpc-probe/worker.env ]; then
    set -a; . /etc/frpc-probe/worker.env; set +a
elif [ -f /etc/frpc-route.env ]; then
    set -a; . /etc/frpc-route.env; set +a
elif [ -f /opt/frpc-route/.env ]; then
    set -a; . /opt/frpc-route/.env; set +a
fi
if [ -z "${PROBE_TOKEN:-${ROUTE_TOKEN:-}}" ]; then
    # systemctl emits shell-quoted Environment entries. Parse without printing secrets.
    legacy_env=$(systemctl show frpc-route.service --property=Environment --value 2>/dev/null || true)
    if [ -n "$legacy_env" ]; then
        parsed_env=$(printf '%s' "$legacy_env" | python3 -c 'import shlex,sys; values=shlex.split(sys.stdin.read()); allowed={"CONSOLE_URL","ROUTE_TOKEN","PROBE_TOKEN"}; print("\n".join(k+"="+shlex.quote(v) for x in values if "=" in x for k,v in [x.split("=",1)] if k in allowed))')
        eval "$parsed_env"
    fi
fi
PROBE_TOKEN="${PROBE_TOKEN:-${ROUTE_TOKEN:-}}"
: "${CONSOLE_URL:?Set CONSOLE_URL}"
: "${PROBE_TOKEN:?Set PROBE_TOKEN (or existing ROUTE_TOKEN)}"
case "$CONSOLE_URL" in http://*|https://*) ;; *) echo 'Invalid console URL'; exit 1;; esac
case "$CONSOLE_URL$PROBE_TOKEN" in *\'*|*$'\n'*|*$'\r'*) echo 'Invalid environment value'; exit 1;; esac
apt-get update
apt-get install -y --no-install-recommends python3 ca-certificates curl mtr-tiny
install -d -m 755 /opt/frpc-probe/versions
tmp=$(mktemp -d /opt/frpc-probe/.install.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
curl --fail --silent --show-error --location "${CONSOLE_URL%/}/api/probe/worker/bundle.tar.gz" -o "$tmp/worker.tar.gz"
curl --fail --silent --show-error --location "${CONSOLE_URL%/}/api/probe/worker/bundle.sha256" -o "$tmp/bundle.sha256"
(cd "$tmp" && sha256sum -c bundle.sha256)
rm "$tmp/bundle.sha256"
tar -xzf "$tmp/worker.tar.gz" -C "$tmp"
version=$(cat "$tmp/VERSION")
case "$version" in ''|*[!a-zA-Z0-9._-]*) echo 'Invalid worker version'; exit 1;; esac
if [ -n "${FRPC_ARCHIVE:-}" ]; then
    # Explicit offline input for hosts without a working GitHub download path.
    cp "$FRPC_ARCHIVE" "$tmp/frp.tar.gz"
else
    curl --fail --silent --show-error --location --connect-timeout 10 --max-time 180 "https://github.com/fatedier/frp/releases/download/v0.68.1/frp_0.68.1_linux_${arch}.tar.gz" -o "$tmp/frp.tar.gz"
fi
tar -xzf "$tmp/frp.tar.gz" -C "$tmp"
install -m 755 "$tmp/frp_0.68.1_linux_${arch}/frpc" "$tmp/frpc"
[ "$("$tmp/frpc" --version)" = '0.68.1' ] || { echo 'Unexpected frpc version'; exit 1; }
rm -rf "$tmp/frp_0.68.1_linux_${arch}" "$tmp/frp.tar.gz" "$tmp/worker.tar.gz"
python3 -m compileall -q "$tmp/app"
# A same-version reinstall still replaces atomically through a unique release dir.
release="/opt/frpc-probe/versions/${version}-$(date +%s)"
mv "$tmp" "$release"
trap - EXIT
systemctl stop frpc-route.service 2>/dev/null || true
systemctl disable frpc-route.service 2>/dev/null || true
systemctl stop frpc-probe.service 2>/dev/null || true
if [ -L /opt/frpc-probe/current ]; then
    ln -sfn "$(readlink /opt/frpc-probe/current)" /opt/frpc-probe/previous
fi
ln -s "$release" /opt/frpc-probe/current.next
mv -Tf /opt/frpc-probe/current.next /opt/frpc-probe/current
umask 077
printf "CONSOLE_URL='%s'\nPROBE_TOKEN='%s'\nPROBE_FRPC_BIN='/opt/frpc-probe/current/frpc'\n" "$CONSOLE_URL" "$PROBE_TOKEN" > /etc/frpc-probe/worker.env
chmod 600 /etc/frpc-probe/worker.env
cat > /etc/systemd/system/frpc-probe.service <<'UNIT'
[Unit]
Description=frpc-multi full probe worker
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
EnvironmentFile=/etc/frpc-probe/worker.env
WorkingDirectory=/opt/frpc-probe/current
ExecStart=/usr/bin/python3 -m app.probe.worker
Restart=always
RestartSec=5
TimeoutStopSec=150
KillMode=control-group
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now frpc-probe.service
