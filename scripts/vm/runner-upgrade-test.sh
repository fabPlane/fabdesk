#!/usr/bin/env bash
# In-place update test on a fresh CI runner: installs an older release, launches it with the
# automation bridge and the update check on, and lets guest/upgrade-drive.py click "Update X" and
# "Restart to update" like a user. Passes when the app comes back on the version the site serves.
#   runner-upgrade-test.sh <os: mac|linux> <arch regex> <ext: zip|AppImage> --tag vOLD
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
usage() { sed -n 2,5p "${BASH_SOURCE[0]}"; }
OS="${1:?os}"; ARCH_RE="${2:?arch}"; EXT_RE="${3:?ext}"; shift 3
parse_args test "$@"
[ -n "$TAG$FILE" ] || die "pass --tag vX.Y.Z or --file <installer>"
INSTALLER="$(resolve_installer "$OS" "$ARCH_RE" "$EXT_RE")"
OUT="$(new_result_dir "upgrade-$OS-${TAG:-candidate}")"
echo "RESULTS_DIR=$OUT" >> "${GITHUB_OUTPUT:-/dev/null}"
log "updating from: $INSTALLER"; log "results: $OUT"
# The app replaces itself where it is installed, so it must live somewhere writable that is its own.
APPS="$(mktemp -d "${TMPDIR:-/tmp}/fabplane-upgrade-test.XXXXXX")"
XPID=""
MNT=""
EXTRA=()
if [ "${FABDESK_TEST_ONE_CLICK:-}" = 1 ]; then EXTRA+=(--one-click); fi
case "$OS" in
  mac)
    UD="$HOME/Library/Application Support/fabPlane"
    if [[ "$INSTALLER" == *.dmg ]]; then
      [ ! -e /Applications/fabPlane.app ] || die "needs a fresh runner without an installed copy"
      MNT="/Volumes/fabdesk-update-test-$RANDOM"
      hdiutil attach -readonly -nobrowse -mountpoint "$MNT" "$INSTALLER"
      BIN=/Applications/fabPlane.app/Contents/MacOS/fabPlane
      if [ "${FABDESK_TEST_MOVE:-}" != 1 ]; then
        ditto "$MNT/fabPlane.app" /Applications/fabPlane.app
      fi
    else
      ditto -x -k "$INSTALLER" "$APPS/"
      BIN="$APPS/fabPlane.app/Contents/MacOS/fabPlane"
    fi
    ARGS=() ;;
  linux)
    UD="$HOME/.config/fabPlane"
    if [[ "$INSTALLER" == *.deb ]]; then
      sudo apt-get install -y "$INSTALLER"
      export FABDESK_TEST_DEB_NAME="$(dpkg-deb -f "$INSTALLER" Package)"
      BIN="$(command -v fabplane)"
    else
      BIN="$APPS/$(basename "$INSTALLER")"; cp "$INSTALLER" "$BIN"; chmod +x "$BIN"
    fi
    export DISPLAY=:99 LIBGL_ALWAYS_SOFTWARE=1
    Xvfb :99 -screen 0 1440x900x24 >/dev/null 2>&1 & XPID=$!
    for _ in $(seq 1 30); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 1; done
    ARGS=(--disable-gpu --disable-gpu-compositing --disable-software-rasterizer --disable-dev-shm-usage) ;;
  *) die "os must be mac or linux (Windows runners call guest/windows-upgrade-test.ps1)" ;;
esac
if [ -e "$UD" ]; then die "fresh test profile required at $UD"; fi
# ShipIt reopens the updated app through launchd, which does not pass this shell's environment on.
[ "$OS" = mac ] && launchctl setenv FABDESK_AUTOMATION 1
[ "$OS" = mac ] && [ -n "${FABDESK_UPDATE_URL:-}" ] && launchctl setenv FABDESK_UPDATE_URL "$FABDESK_UPDATE_URL"
export FABDESK_AUTOMATION=1
LAUNCH="$BIN"
if [ "${FABDESK_TEST_MOVE:-}" = 1 ]; then LAUNCH="$MNT/fabPlane.app/Contents/MacOS/fabPlane"; fi
"$LAUNCH" ${ARGS[@]+"${ARGS[@]}"} >"$OUT/app-stdout.txt" 2>&1 &
rc=0
python3 "$VM_SCRIPTS/guest/upgrade-drive.py" --user-data "$UD" --out "$OUT" --timeout "$TIMEOUT" --executable "$BIN" ${EXTRA[@]+"${EXTRA[@]}"} || rc=$?
ls -la "$APPS" >"$OUT/install-dir.txt" 2>&1 || true
cp "$UD"/*.log "$UD"/update-install.json "$OUT/" 2>/dev/null || true
[ "$OS" = mac ] && cp "$HOME/Library/Caches/com.tensorfleet.fabdesk.ShipIt/ShipIt_stderr.log" "$OUT/" 2>/dev/null || true
[ "$OS" = linux ] && import -window root "$OUT/screen.png" 2>/dev/null || true
[ "$OS" = mac ] && launchctl unsetenv FABDESK_AUTOMATION || true
[ "$OS" = mac ] && launchctl unsetenv FABDESK_UPDATE_URL || true
[ -n "$MNT" ] && hdiutil detach "$MNT" -quiet || true
pkill -f "$APPS" 2>/dev/null || true; pkill -f "/tmp/\.mount_" 2>/dev/null || true
[ -n "$XPID" ] && kill "$XPID" 2>/dev/null || true
cat "$OUT/upgrade-report.json" 2>/dev/null || true
exit "$rc"
