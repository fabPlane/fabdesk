#!/bin/bash
# Runs inside the macOS test VM (copied there by scripts/vm/mac.sh).
# Usage: mac-test.sh <installer.dmg|.zip> <out-dir>
# Installs Fabplane the way a user would, records the Gatekeeper verdict, launches the app with the
# automation bridge on, checks the core daemon, grabs a screenshot, writes <out-dir>/report.json.
set -uo pipefail
INSTALLER="$1"; OUT="$2"; mkdir -p "$OUT"
APP=/Applications/Fabplane.app
UD="$HOME/Library/Application Support/Fabplane"
UD_PREV="$HOME/Library/Application Support/Fabdesk"              # productName before the Fabplane rename
UD_LEGACY="$HOME/Library/Application Support/@fabdesk/desktop"   # builds before 0.1.40
pick_ud() {
  if [ -f "$UD/daemon.json" ]; then return; fi
  if [ -f "$UD_PREV/daemon.json" ]; then UD="$UD_PREV"; return; fi
  if [ -f "$UD_LEGACY/daemon.json" ]; then UD="$UD_LEGACY"; fi
}
LOG="$OUT/log.txt"; exec > >(tee -a "$LOG") 2>&1
ERRORS=(); R_INSTALL="" R_GK="" R_CS="" R_CORE="" R_HEALTH="" R_SHOT="" LAUNCH_MS=""
err() { ERRORS+=("$1"); echo "ERROR: $1"; }
write_report() {
  local ok=true; [ ${#ERRORS[@]} -eq 0 ] || ok=false
  python3 - "$OUT/report.json" "$ok" "$(basename "$INSTALLER")" "$R_INSTALL" "$R_GK" "$R_CS" "$R_CORE" "$R_HEALTH" "$R_SHOT" "$LAUNCH_MS" ${ERRORS[@]+"${ERRORS[@]}"} <<'PY'
import json, sys
a = sys.argv[1:]
rep = {"platform": "macos", "ok": a[1] == "true", "installer": a[2], "install": a[3], "gatekeeper": a[4],
       "codesign": a[5], "core_version": a[6], "health": a[7], "screenshot": a[8], "launch_ms": a[9], "errors": a[10:]}
json.dump(rep, open(a[0], "w"), indent=2)
PY
}
trap write_report EXIT

echo "== host: $(sw_vers -productVersion) $(uname -m)  installer: $INSTALLER"
rm -rf "$APP" /Applications/Fabdesk.app "$UD" "$UD_PREV" "$UD_LEGACY"

# Simulate a browser download: quarantine the installer, so Gatekeeper evaluates it like a user's copy.
xattr -w com.apple.quarantine "0083;$(printf '%x' "$(date +%s)");Safari;" "$INSTALLER" 2>/dev/null || true

case "$INSTALLER" in
  *.dmg)
    if ! hdiutil verify "$INSTALLER" >/dev/null 2>&1; then err "hdiutil verify failed (corrupt image)"; exit 0; fi
    MNT="$(hdiutil attach -nobrowse -readonly "$INSTALLER" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)"
    [ -d "$MNT" ] || { err "dmg did not mount"; exit 0; }
    BUNDLE="$(ls -d "$MNT"/Fabplane.app "$MNT"/Fabdesk.app 2>/dev/null | head -1)"
    [ -n "$BUNDLE" ] || { err "dmg has no Fabplane.app / Fabdesk.app"; hdiutil detach "$MNT" -quiet || true; exit 0; }
    APP="/Applications/$(basename "$BUNDLE")"
    cp -R "$BUNDLE" /Applications/ || err "copy to /Applications failed"
    hdiutil detach "$MNT" -quiet || true
    R_INSTALL="dmg mounted at $MNT, copied to /Applications" ;;
  *.zip)
    ditto -x -k "$INSTALLER" /Applications/ || err "unzip failed"
    R_INSTALL="zip extracted to /Applications" ;;
  *) err "unknown installer type"; exit 0 ;;
esac
if [ ! -d "$APP" ] && [ -d /Applications/Fabdesk.app ]; then APP=/Applications/Fabdesk.app; fi
[ -d "$APP" ] || { err "no $APP after install"; exit 0; }

# Gatekeeper verdict on the quarantined app (what a user sees on first launch). VM base images ship
# with Gatekeeper disabled, so turn it back on first (admin has passwordless sudo in the tart images).
sudo -n spctl --global-enable >/dev/null 2>&1 || sudo -n spctl --master-enable >/dev/null 2>&1 || echo "note: could not enable Gatekeeper"
GK="$(spctl -a -vv -t exec "$APP" 2>&1 | tr '\n' ' ')"
R_GK="$GK"
echo "gatekeeper: $GK"
R_CS="$(codesign -dv --verbose=2 "$APP" 2>&1 | grep -E '^(Authority|Signature|TeamIdentifier)' | tr '\n' ' ')"
codesign --verify --deep --strict "$APP" 2>&1 || err "codesign --verify failed"
if ! xcrun stapler validate "$APP" >/dev/null 2>&1; then echo "notarization: not stapled"; else echo "notarization: stapled"; fi
# Ad-hoc builds are blocked by Gatekeeper; drop quarantine so the rest of the test exercises the app itself.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

CORE="$APP/Contents/Resources/core/fabdesk-core"
R_CORE="$("$CORE" version 2>&1 | head -1)" || err "fabdesk-core version failed: $R_CORE"

mkdir -p "$UD"
T0=$(python3 -c 'import time;print(int(time.time()*1000))')
MAC_BIN="$APP/Contents/MacOS/Fabplane"
[ -x "$MAC_BIN" ] || MAC_BIN="$APP/Contents/MacOS/Fabdesk"
FABDESK_AUTOMATION=1 FABDESK_UPDATE_CHECK=0 "$MAC_BIN" >"$OUT/app-stdout.txt" 2>&1 &
APP_PID=$!
for i in $(seq 1 180); do pick_ud; [ -f "$UD/daemon.json" ] && [ -f "$UD/app-bridge.json" ] && break; sleep 1; done   # x64 under Rosetta translates ~200 MB on first launch
echo "userData: $UD"
if [ ! -f "$UD/daemon.json" ]; then err "daemon.json never appeared (app did not start its core)"; echo "--- app stdout/stderr:"; tail -20 "$OUT/app-stdout.txt"; screencapture -x "$OUT/screen.png" 2>/dev/null; kill $APP_PID 2>/dev/null; exit 0; fi
PORT=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["port"])' "$UD/daemon.json")
TOKEN=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["token"])' "$UD/daemon.json")
for i in $(seq 1 30); do R_HEALTH="$(curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/health" 2>/dev/null)" && break; sleep 1; done
[ -n "$R_HEALTH" ] || err "core /health did not answer on $PORT"
LAUNCH_MS=$(( $(python3 -c 'import time;print(int(time.time()*1000))') - T0 ))
sleep 4  # let the renderer paint
if [ -f "$UD/app-bridge.json" ]; then
  BURL=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["url"])' "$UD/app-bridge.json")
  if curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"format":"png"}' "$BURL/screenshot" \
      | python3 -c 'import sys,json,base64;d=json.load(sys.stdin);open(sys.argv[1],"wb").write(base64.b64decode(d["base64"]));print(d["width"],d["height"])' "$OUT/app.png" >"$OUT/.dim" 2>/dev/null; then
    R_SHOT="app.png $(cat "$OUT/.dim")"
  else err "bridge screenshot failed"; fi
else err "app-bridge.json missing (FABDESK_AUTOMATION not honored?)"; fi
screencapture -x "$OUT/screen.png" 2>/dev/null || true
cp "$UD"/*.log "$OUT/" 2>/dev/null || true
kill $APP_PID 2>/dev/null; sleep 2; pkill -x Fabplane 2>/dev/null || pkill -x Fabdesk 2>/dev/null || true
echo "== done"
