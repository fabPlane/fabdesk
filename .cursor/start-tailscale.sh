#!/usr/bin/env bash
# Join the Fabdesk staging tailnet in userspace mode (Cloud Agent VMs have no TUN).
# Requires the Cursor environment secret TS_AUTH_KEY (tagged, ephemeral).
# Skips cleanly when the secret is unset so public-only agents still boot.
set -euo pipefail

log() { printf '[tailscale] %s\n' "$*"; }

if [ -z "${TS_AUTH_KEY:-}" ]; then
  log "TS_AUTH_KEY unset; skipping tailnet (staging login will not work)"
  exit 0
fi

if ! command -v tailscaled >/dev/null 2>&1 || ! command -v tailscale >/dev/null 2>&1; then
  log "tailscale not installed; run .cursor/install.sh first"
  exit 1
fi

DIR="${FABDESK_TAILSCALE_DIR:-$HOME/.config/fabdesk-tailscale}"
STATE="$DIR/state"
SOCK="$DIR/tailscaled.sock"
KEYFILE="$DIR/authkey"
HOSTNAME="cursor-fabdesk-$(hostname -s)"
mkdir -p "$STATE"
chmod 700 "$DIR" "$STATE"

cleanup_key() { rm -f "$KEYFILE"; }
trap cleanup_key EXIT

write_key() {
  umask 077
  printf '%s\n' "$TS_AUTH_KEY" > "$KEYFILE"
  chmod 600 "$KEYFILE"
}

if [ ! -S "$SOCK" ]; then
  # systemd TUN mode does not work in these VMs.
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl stop tailscaled.service 2>/dev/null || true
    sudo systemctl disable tailscaled.service 2>/dev/null || true
  fi
  nohup tailscaled \
    --tun=userspace-networking \
    --statedir="$STATE" \
    --socket="$SOCK" \
    --outbound-http-proxy-listen=localhost:1054 \
    --socks5-server=localhost:1055 \
    >"$DIR/tailscaled.log" 2>&1 &
  for _ in $(seq 1 40); do
    [ -S "$SOCK" ] && break
    sleep 0.15
  done
fi

if [ ! -S "$SOCK" ]; then
  log "tailscaled failed to create $SOCK"
  tail -n 40 "$DIR/tailscaled.log" >&2 || true
  exit 1
fi

backend_state() {
  tailscale --socket="$SOCK" status --json 2>/dev/null | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("BackendState") or "")
except Exception:
    print("")' 2>/dev/null || true
}

# Re-running start (same VM) must reuse persisted node state. `--reset` plus a
# fresh auth key would mint a new ephemeral node on every boot.
if [ "$(backend_state)" = "Running" ]; then
  log "already up as $(tailscale --socket="$SOCK" ip -4) (SOCKS 127.0.0.1:1055, HTTP proxy 127.0.0.1:1054)"
  exit 0
fi

# Reconnect with persisted identity when possible. Auth key only if login is
# still required. Never `--reset`: that discarded node state on every start.
UP_ARGS=(--hostname="$HOSTNAME" --accept-dns=false)
state="$(backend_state)"
if [ "$state" = "NeedsLogin" ] || [ -z "$state" ] || [ "$state" = "NoState" ]; then
  write_key
  tailscale --socket="$SOCK" up --auth-key="file:$KEYFILE" "${UP_ARGS[@]}"
elif ! tailscale --socket="$SOCK" up "${UP_ARGS[@]}"; then
  write_key
  tailscale --socket="$SOCK" up --auth-key="file:$KEYFILE" "${UP_ARGS[@]}"
fi

if ! tailscale --socket="$SOCK" status >/dev/null; then
  log "tailscale up did not reach a running state"
  exit 1
fi

log "up as $(tailscale --socket="$SOCK" ip -4) (SOCKS 127.0.0.1:1055, HTTP proxy 127.0.0.1:1054)"
