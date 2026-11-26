#!/usr/bin/env bash
# In-place update test on a fresh CI runner: installs an older release, launches it with the
# automation bridge and the update check on, and lets guest/upgrade-drive.py click "Update X" and
# "Restart to update" like a user. Passes when the app comes back on the version the site serves.
#   runner-upgrade-test.sh <os: mac|linux> <arch regex> <ext: zip|AppImage> --tag vOLD
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
usage() { sed -n 2,5p "${BASH_SOURCE[0]}"; }
OS="${1:?os}"; ARCH_RE="${2:?arch}"; EXT_RE="${3:?ext}"; shift 3
parse_args test "$@"
[ -n "$TAG" ] || die "pass --tag vX.Y.Z: the older release to update from"
INSTALLER="$(resolve_installer "$OS" "$ARCH_RE" "$EXT_RE")"
OUT="$(new_result_dir "upgrade-$OS-${TAG#v}")"
echo "RESULTS_DIR=$OUT" >> "${GITHUB_OUTPUT:-/dev/null}"
log "updating from: $INSTALLER"; log "results: $OUT"
# The app replaces itself where it is installed, so it must live somewhere writable that is its own.
APPS="$HOME/fabplane-upgrade-test"; rm -rf "$APPS"; mkdir -p "$APPS"
XPID=""
case "$OS" in
  mac)
    UD="$HOME/Library/Application Support/fabPlane"
    ditto -x -k "$INSTALLER" "$APPS/"
    xattr -dr com.apple.quarantine "$APPS/fabPlane.app" 2>/dev/null || true
    BIN="$APPS/fabPlane.app/Contents/MacOS/fabPlane"; ARGS=() ;;
  linux)
    UD="$HOME/.config/fabPlane"
    BIN="$APPS/$(basename "$INSTALLER")"; cp "$INSTALLER" "$BIN"; chmod +x "$BIN"
    export DISPLAY=:99 LIBGL_ALWAYS_SOFTWARE=1
    Xvfb :99 -screen 0 1440x900x24 >/dev/null 2>&1 & XPID=$!
    for _ in $(seq 1 30); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 1; done
    ARGS=(--disable-gpu --disable-gpu-compositing --disable-software-rasterizer --disable-dev-shm-usage) ;;
  *) die "os must be mac or linux (Windows runners call guest/windows-upgrade-test.ps1)" ;;
esac
rm -rf "$UD"
FABDESK_AUTOMATION=1 "$BIN" ${ARGS[@]+"${ARGS[@]}"} >"$OUT/app-stdout.txt" 2>&1 &
rc=0
python3 "$VM_SCRIPTS/guest/upgrade-drive.py" --user-data "$UD" --out "$OUT" --timeout "$TIMEOUT" || rc=$?
ls -la "$APPS" >"$OUT/install-dir.txt" 2>&1 || true
cp "$UD"/*.log "$UD"/update-install.json "$OUT/" 2>/dev/null || true
[ "$OS" = mac ] && cp "$HOME/Library/Caches/com.tensorfleet.fabdesk.ShipIt/ShipIt_stderr.log" "$OUT/" 2>/dev/null || true
[ "$OS" = linux ] && import -window root "$OUT/screen.png" 2>/dev/null || true
pkill -f "$APPS" 2>/dev/null || true; pkill -f "/tmp/\.mount_" 2>/dev/null || true
[ -n "$XPID" ] && kill "$XPID" 2>/dev/null || true
cat "$OUT/upgrade-report.json" 2>/dev/null || true
exit "$rc"
