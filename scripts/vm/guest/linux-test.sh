#!/bin/bash
# Runs inside the Ubuntu test VM (copied there by scripts/vm/linux.sh).
# Usage: linux-test.sh <Fabdesk.AppImage|.deb> <out-dir>
set -uo pipefail
INSTALLER="$1"; OUT="$2"; mkdir -p "$OUT"
UD="$HOME/.config/Fabdesk"
LOG="$OUT/log.txt"; exec > >(tee -a "$LOG") 2>&1
ERRORS=(); R_INSTALL="" R_CORE="" R_HEALTH="" R_SHOT="" LAUNCH_MS="" BIN=""
err() { ERRORS+=("$1"); echo "ERROR: $1"; }
write_report() {
  local ok=true; [ ${#ERRORS[@]} -eq 0 ] || ok=false
  python3 - "$OUT/report.json" "$ok" "$(basename "$INSTALLER")" "$R_INSTALL" "$R_CORE" "$R_HEALTH" "$R_SHOT" "$LAUNCH_MS" "${ERRORS[@]}" <<'PY'
import json, sys
a = sys.argv[1:]
json.dump({"platform": "linux", "ok": a[1] == "true", "installer": a[2], "install": a[3], "core_version": a[4],
           "health": a[5], "screenshot": a[6], "launch_ms": a[7], "errors": a[8:]}, open(a[0], "w"), indent=2)
PY
}
trap write_report EXIT
echo "== host: $(. /etc/os-release; echo "$PRETTY_NAME") $(uname -m)  installer: $INSTALLER"
rm -rf "$UD"

case "$INSTALLER" in
  *.AppImage)
    chmod +x "$INSTALLER"
    BIN="$INSTALLER"
    # FUSE mount check (users hit this first): the AppImage must run without --appimage-extract.
    "$INSTALLER" --appimage-version >/dev/null 2>&1 || true
    R_INSTALL="AppImage executable" ;;
  *.deb)
    sudo apt-get install -y "./$(basename "$INSTALLER")" >"$OUT/apt.txt" 2>&1 || sudo apt-get install -y "$INSTALLER" >>"$OUT/apt.txt" 2>&1 || err "apt install of the .deb failed (see apt.txt)"
    BIN="$(command -v fabdesk || echo /opt/Fabdesk/fabdesk)"
    [ -x "$BIN" ] || { err "no fabdesk binary after installing the .deb"; exit 0; }
    R_INSTALL="deb installed, binary $BIN" ;;
  *) err "unknown installer type"; exit 0 ;;
esac

if [ -n "$BIN" ] && [[ "$INSTALLER" == *.AppImage ]]; then
  # The compiled core sits inside the image; extract it once to check it runs on this distro.
  ( cd "$OUT" && "$INSTALLER" --appimage-extract 'resources/core/*' >/dev/null 2>&1 ) || true
  CORE="$OUT/squashfs-root/resources/core/fabdesk-core"
else
  CORE="/opt/Fabdesk/resources/core/fabdesk-core"
fi
[ -x "$CORE" ] && { R_CORE="$("$CORE" version 2>&1 | head -1)" || err "fabdesk-core version failed: $R_CORE"; } || err "core binary not found at $CORE"

export DISPLAY=:99
Xvfb :99 -screen 0 1440x900x24 >/dev/null 2>&1 &
XPID=$!; sleep 2
T0=$(date +%s%3N)
FABDESK_AUTOMATION=1 FABDESK_UPDATE_CHECK=0 "$BIN" >"$OUT/app-stdout.txt" 2>&1 &
APP_PID=$!
for i in $(seq 1 90); do [ -f "$UD/daemon.json" ] && [ -f "$UD/app-bridge.json" ] && break; sleep 1; done
if [ ! -f "$UD/daemon.json" ]; then err "daemon.json never appeared (app did not start its core)"; kill $APP_PID $XPID 2>/dev/null; exit 0; fi
PORT=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["port"])' "$UD/daemon.json")
TOKEN=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["token"])' "$UD/daemon.json")
for i in $(seq 1 30); do R_HEALTH="$(curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/health" 2>/dev/null)" && break; sleep 1; done
[ -n "$R_HEALTH" ] || err "core /health did not answer on $PORT"
LAUNCH_MS=$(( $(date +%s%3N) - T0 ))
sleep 5
if [ -f "$UD/app-bridge.json" ]; then
  BURL=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["url"])' "$UD/app-bridge.json")
  if curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"format":"png"}' "$BURL/screenshot" \
      | python3 -c 'import sys,json,base64;d=json.load(sys.stdin);open(sys.argv[1],"wb").write(base64.b64decode(d["base64"]));print(d["width"],d["height"])' "$OUT/app.png" >"$OUT/.dim" 2>/dev/null; then
    R_SHOT="app.png $(cat "$OUT/.dim")"
  else err "bridge screenshot failed"; fi
else err "app-bridge.json missing"; fi
import -window root "$OUT/screen.png" 2>/dev/null || true
cp "$UD"/*.log "$OUT/" 2>/dev/null || true
kill $APP_PID 2>/dev/null; sleep 2; pkill -f "$BIN" 2>/dev/null || true; kill $XPID 2>/dev/null || true
rm -rf "$OUT/squashfs-root"
echo "== done"
