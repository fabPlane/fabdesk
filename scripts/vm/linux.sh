#!/usr/bin/env bash
# Fresh Linux installer test in a QEMU VM (Ubuntu 22.04 cloud image + cloud-init, no manual install).
#
#   scripts/vm/linux.sh prepare                    # download the cloud image, first boot, apt deps (once)
#   scripts/vm/linux.sh test [--format appimage|deb] [--file X | --tag vX | --latest] [--keep]
#   scripts/vm/linux.sh shell                      # ssh into the last test VM (needs --keep)
#   scripts/vm/linux.sh destroy
#
# The Linux build is x86_64, so on Apple Silicon this runs under TCG emulation (slow: budget ~10 min
# per test). On an x86_64 host with KVM it is fast. Each `test` boots a throwaway qcow2 overlay of the
# prepared base disk, so the guest is pristine every time.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
usage() { sed -n 2,11p "${BASH_SOURCE[0]}"; }
parse_args "$@"
IMG_URL="${FABDESK_VM_LINUX_IMAGE:-https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img}"
D="$VM_DIR/linux"; mkdir -p "$D"
BASE="$D/base.qcow2"; OVL="$D/test.qcow2"; SEED="$D/seed.iso"; KEY="$D/id_ed25519"; PIDF="$D/qemu.pid"
VM_USER=fabdesk; MEM="${FABDESK_VM_MEM:-4096}"
need qemu-system-x86_64 "brew install qemu"; need qemu-img "brew install qemu"
KOPTS=("${SSH_OPTS[@]}" -o PreferredAuthentications=publickey -o BatchMode=yes)   # key auth only, never prompt

accel_args() {
  if [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = x86_64 ]; then echo "-accel hvf -cpu host"
  elif [ "$(uname -s)" = Linux ] && [ -w /dev/kvm ]; then echo "-accel kvm -cpu host"
  else echo "-accel tcg,thread=multi -cpu max -smp 4"; fi
}
boot() {  # boot <disk> <ssh-port> <log> [extra args...]
  local disk="$1" port="$2" logf="$3"; shift 3
  # shellcheck disable=SC2046
  qemu-system-x86_64 $(accel_args) -m "$MEM" -M q35 -nographic -serial "file:$logf" -monitor none -pidfile "$PIDF" \
    -drive "file=$disk,if=virtio,format=qcow2" -drive "file=$SEED,if=virtio,format=raw,readonly=on" \
    -device virtio-net-pci,netdev=n0 -netdev "user,id=n0,hostfwd=tcp:127.0.0.1:$port-:22" -device virtio-rng-pci "$@" &
}
stop_vm() { [ -f "$PIDF" ] && kill "$(cat "$PIDF")" 2>/dev/null; rm -f "$PIDF"; }
ssh_port() { cat "$D/port" 2>/dev/null || echo 2222; }

case "$CMD" in
  prepare)
    [ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -f "$KEY"
    [ -f "$D/base.img" ] || { log "downloading $IMG_URL"; curl -fL --progress-bar -o "$D/base.img" "$IMG_URL"; }
    sed "s|__SSH_KEY__|$(cat "$KEY.pub")|" "$REPO_ROOT/scripts/vm/guest/cloud-init-user-data" > "$D/user-data"
    printf 'instance-id: fabdesk-linux\nlocal-hostname: fabdesk-linux\n' > "$D/meta-data"
    rm -rf "$D/seed"; mkdir -p "$D/seed"; cp "$D/user-data" "$D/meta-data" "$D/seed/"
    if command -v mkisofs >/dev/null; then mkisofs -quiet -output "$SEED" -volid cidata -joliet -rock "$D/seed"
    elif command -v genisoimage >/dev/null; then genisoimage -quiet -output "$SEED" -volid cidata -joliet -rock "$D/seed"
    else hdiutil makehybrid -quiet -iso -joliet -default-volume-name cidata -o "$SEED" "$D/seed"; fi
    qemu-img create -q -f qcow2 -F qcow2 -b "$D/base.img" "$BASE" 20G 2>/dev/null || { qemu-img convert -O qcow2 "$D/base.img" "$BASE" && qemu-img resize -q "$BASE" 20G; }
    PORT=$(free_port); echo "$PORT" > "$D/port"
    log "first boot (cloud-init installs packages; slow under emulation)"
    boot "$BASE" "$PORT" "$D/prepare-serial.txt"
    trap stop_vm EXIT
    for i in $(seq 1 240); do
      ssh -i "$KEY" "${KOPTS[@]}" -p "$PORT" "$VM_USER@127.0.0.1" test -f .cloud-init-done 2>/dev/null && break; sleep 10
    done
    ssh -i "$KEY" "${KOPTS[@]}" -p "$PORT" "$VM_USER@127.0.0.1" test -f .cloud-init-done || die "cloud-init never finished (see $D/prepare-serial.txt)"
    ssh -i "$KEY" "${KOPTS[@]}" -p "$PORT" "$VM_USER@127.0.0.1" "sudo cloud-init clean --logs; sudo sync; sudo poweroff" >/dev/null 2>&1 || true
    sleep 10; stop_vm; trap - EXIT
    log "base disk ready: $BASE" ;;

  test)
    [ -f "$BASE" ] || "$0" prepare
    FORMAT="${FORMAT:-appimage}"
    case "$FORMAT" in appimage) EXT="AppImage" ;; deb) EXT="deb" ;; *) die "--format appimage|deb" ;; esac
    INSTALLER="$(resolve_installer linux "(x64|amd64|x86_64)" "$EXT")"
    OUT="$(new_result_dir "linux-$FORMAT")"; log "installer: $INSTALLER"; log "results: $OUT"
    stop_vm; rm -f "$OVL"; qemu-img create -q -f qcow2 -F qcow2 -b "$BASE" "$OVL"
    PORT=$(free_port); echo "$PORT" > "$D/port"
    boot "$OVL" "$PORT" "$OUT/serial.txt"
    cleanup() { if [ "$KEEP" = 0 ]; then stop_vm; else warn "VM left running on ssh port $PORT (--keep); use 'linux.sh shell'"; fi; }
    trap cleanup EXIT
    S=(ssh -i "$KEY" "${KOPTS[@]}" -p "$PORT" "$VM_USER@127.0.0.1")
    for i in $(seq 1 120); do "${S[@]}" true 2>/dev/null && break; sleep 5; done
    "${S[@]}" true 2>/dev/null || die "ssh never came up (see $OUT/serial.txt)"
    log "guest up"
    "${S[@]}" "rm -rf ~/fabdesk-test && mkdir -p ~/fabdesk-test/out"
    scp -i "$KEY" "${KOPTS[@]}" -P "$PORT" "$INSTALLER" "$REPO_ROOT/scripts/vm/guest/linux-test.sh" "$VM_USER@127.0.0.1:fabdesk-test/" >/dev/null
    "${S[@]}" "bash ~/fabdesk-test/linux-test.sh ~/fabdesk-test/$(basename "$INSTALLER") ~/fabdesk-test/out" | tee "$OUT/log.txt" || true
    scp -i "$KEY" "${KOPTS[@]}" -P "$PORT" -r "$VM_USER@127.0.0.1:fabdesk-test/out/*" "$OUT/" >/dev/null 2>&1 || true
    finish_report "$OUT" ;;

  shell) exec ssh -i "$KEY" "${KOPTS[@]}" -p "$(ssh_port)" "$VM_USER@127.0.0.1" ;;
  destroy) stop_vm; rm -rf "$D"; log "deleted $D" ;;
  *) usage; exit 1 ;;
esac
