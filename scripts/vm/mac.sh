#!/usr/bin/env bash
# Fresh macOS installer test in a Tart VM (Apple Silicon hosts only; Virtualization.framework).
#
#   scripts/vm/mac.sh prepare                      # pull the base image (~25 GB, once)
#   scripts/vm/mac.sh test [--arch arm64|x64] [--format dmg|zip] [--file X | --tag vX | --latest] [--keep]
#   scripts/vm/mac.sh shell                        # ssh into the last test VM (needs --keep)
#   scripts/vm/mac.sh destroy
#
# Each `test` clones the base image (fresh macOS, nothing installed), copies the installer in, runs
# guest/mac-test.sh over ssh, and pulls report.json + screenshots into ~/.fabdesk-vm/results/.
# --arch x64 installs Rosetta in the guest first so the Intel build runs on the arm64 VM.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
usage() { sed -n 2,13p "${BASH_SOURCE[0]}"; }
parse_args "$@"
BASE_IMAGE="${FABDESK_VM_MAC_IMAGE:-ghcr.io/cirruslabs/macos-sequoia-base:latest}"
BASE=fabdesk-mac-base; VM=fabdesk-mac-test; USER=admin; PASS=admin
[ "$(uname -m)" = arm64 ] || die "macOS VMs need an Apple Silicon host"

ensure_tart() {
  if ! command -v tart >/dev/null; then
    need brew "install Homebrew first"
    log "installing tart (brew install cirruslabs/cli/tart)"; brew install cirruslabs/cli/tart
  fi
}
vm_ip() { tart ip "$VM" --wait 120 2>/dev/null; }

case "$CMD" in
  prepare)
    ensure_tart
    tart list 2>/dev/null | grep -q " $BASE " && { log "base image $BASE already present"; exit 0; }
    log "cloning $BASE_IMAGE -> $BASE (large download)"
    tart clone "$BASE_IMAGE" "$BASE"
    tart set "$BASE" --cpu 4 --memory 6144 --display 1600x1000
    log "base image ready" ;;

  test)
    ensure_tart
    ARCH="${ARCH:-arm64}"; FORMAT="${FORMAT:-dmg}"
    INSTALLER="$(resolve_installer mac "$ARCH" "$FORMAT")"
    tart list 2>/dev/null | grep -q " $BASE " || "$0" prepare
    OUT="$(new_result_dir "mac-$ARCH-$FORMAT")"
    log "installer: $INSTALLER"; log "results: $OUT"
    tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true
    tart clone "$BASE" "$VM"
    tart run "$VM" --no-graphics >"$OUT/tart.txt" 2>&1 &
    TART_PID=$!
    cleanup() { if [ "$KEEP" = 0 ]; then tart stop "$VM" >/dev/null 2>&1 || true; kill $TART_PID 2>/dev/null || true; tart delete "$VM" >/dev/null 2>&1 || true; else warn "VM $VM left running (--keep); use 'mac.sh shell'"; fi; }
    trap cleanup EXIT
    IP="$(vm_ip)"; [ -n "$IP" ] || die "VM got no IP (see $OUT/tart.txt)"
    wait_ssh "$USER" "$IP" 22 "$PASS" 180 || die "ssh to $IP never came up"
    log "guest up at $IP"
    if [ "$ARCH" = x64 ]; then
      log "installing Rosetta in the guest"
      guest_ssh "$USER" "$IP" 22 "$PASS" "arch -arm64 /usr/sbin/softwareupdate --install-rosetta --agree-to-license >/dev/null 2>&1 || true"
    fi
    guest_ssh "$USER" "$IP" 22 "$PASS" "rm -rf ~/fabdesk-test && mkdir -p ~/fabdesk-test/out"
    guest_scp "$USER" "$IP" 22 "$PASS" "$INSTALLER" "$REPO_ROOT/scripts/vm/guest/mac-test.sh" "$USER@$IP:fabdesk-test/"
    guest_ssh "$USER" "$IP" 22 "$PASS" "bash ~/fabdesk-test/mac-test.sh ~/fabdesk-test/$(basename "$INSTALLER") ~/fabdesk-test/out" | tee "$OUT/log.txt" || true
    guest_scp "$USER" "$IP" 22 "$PASS" "$USER@$IP:fabdesk-test/out/*" "$OUT/" >/dev/null 2>&1 || true
    finish_report "$OUT" ;;

  shell)
    IP="$(vm_ip)"; [ -n "$IP" ] || die "no running $VM (run test --keep first)"
    exec "$REPO_ROOT/scripts/vm/_ssh.sh" "$USER" "$IP" "$PASS" ;;

  destroy)
    tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true
    tart delete "$BASE" >/dev/null 2>&1 || true; log "deleted $VM and $BASE" ;;
  *) usage; exit 1 ;;
esac
