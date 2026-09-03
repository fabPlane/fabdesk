#!/usr/bin/env bash
# Fresh Windows installer test in a QEMU VM (Windows 11 arm64 on Apple Silicon via HVF; x86_64 hosts
# use an x64 ISO with KVM/HVF). Windows has no cloud image, so `prepare` performs a one-time unattended
# install from an ISO you supply (Microsoft's official Windows 11 ISO download; the arm64 ISO from
# https://www.microsoft.com/software-download/windows11arm64). Only inbox drivers are used (NVMe disk,
# USB RNDIS network, ramfb display), so no virtio driver ISO is needed.
#
#   scripts/vm/windows.sh prepare --iso ~/Downloads/Win11_24H2_Arm64.iso     # ~20-40 min, once
#   scripts/vm/windows.sh test [--format nsis|portable] [--file X | --tag vX | --latest] [--keep]
#   scripts/vm/windows.sh console                   # open the VM display (test --keep) for a look
#   scripts/vm/windows.sh destroy
#
# `test` boots a throwaway overlay of the base disk with a payload CD (installer + guest/windows-test.ps1).
# The startup agent installed during `prepare` runs the test, which reports back over HTTP to the host
# (10.0.2.2) and powers the VM off. The x64 installer runs under Windows' built-in x64 emulation on arm64.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
usage() { sed -n 2,17p "${BASH_SOURCE[0]}"; }
parse_args "$@"
D="$VM_DIR/windows"; mkdir -p "$D"
BASE="$D/base.qcow2"; OVL="$D/test.qcow2"; VARS="$D/efivars.fd"; PIDF="$D/qemu.pid"
MEM="${FABDESK_VM_MEM:-6144}"
HOST_ARCH="$(uname -m)"
if [ "$HOST_ARCH" = arm64 ] || [ "$HOST_ARCH" = aarch64 ]; then GUEST=aarch64; else GUEST=x86_64; fi
need "qemu-system-$GUEST" "brew install qemu"; need qemu-img "brew install qemu"

efi_code() {
  local p
  for p in /opt/homebrew/share/qemu /usr/local/share/qemu /usr/share/qemu /usr/share/edk2/aarch64 /usr/share/OVMF; do
    if [ "$GUEST" = aarch64 ]; then [ -f "$p/edk2-aarch64-code.fd" ] && { echo "$p/edk2-aarch64-code.fd"; return; }
    else for f in edk2-x86_64-code.fd OVMF_CODE.fd; do [ -f "$p/$f" ] && { echo "$p/$f"; return; }; done; fi
  done; die "no EDK2 firmware found for $GUEST (brew install qemu)"
}
accel() { if [ "$(uname -s)" = Darwin ]; then echo "-accel hvf -cpu host"; elif [ -w /dev/kvm ]; then echo "-accel kvm -cpu host"; else echo "-accel tcg -cpu max"; fi; }
boot() {  # boot <disk> <display: none|cocoa|gtk> <serial log> [extra drives...]
  local disk="$1" disp="$2" logf="$3"; shift 3
  local machine=(-M virt,highmem=on); [ "$GUEST" = x86_64 ] && machine=(-M q35)
  [ -f "$VARS" ] || { if [ "$GUEST" = aarch64 ]; then qemu-img create -q -f raw "$VARS" 64M; else cp "$(dirname "$(efi_code)")/edk2-i386-vars.fd" "$VARS" 2>/dev/null || qemu-img create -q -f raw "$VARS" 4M; fi; }
  # shellcheck disable=SC2046
  "qemu-system-$GUEST" "${machine[@]}" $(accel) -smp 4 -m "$MEM" -display "$disp" -serial "file:$logf" -monitor none -pidfile "$PIDF" \
    -drive "if=pflash,format=raw,readonly=on,file=$(efi_code)" -drive "if=pflash,format=raw,file=$VARS" \
    -device ramfb -device qemu-xhci -device usb-kbd -device usb-tablet \
    -device usb-net,netdev=n0 -netdev user,id=n0 \
    -drive "file=$disk,if=none,id=hd,format=qcow2" -device nvme,drive=hd,serial=fabdesk "$@" &
}
stop_vm() { [ -f "$PIDF" ] && kill "$(cat "$PIDF")" 2>/dev/null; rm -f "$PIDF"; }
wait_off() { local i; for ((i=0; i<$1; i+=5)); do [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null || return 0; sleep 5; done; return 1; }
make_iso() {  # make_iso <dir> <out.iso> <label>
  if command -v mkisofs >/dev/null; then mkisofs -quiet -o "$2" -V "$3" -joliet -rock -udf "$1"
  elif [ "$(uname -s)" = Darwin ]; then hdiutil makehybrid -quiet -iso -joliet -udf -default-volume-name "$3" -o "$2" "$1"
  else die "need mkisofs (genisoimage)"; fi
}

case "$CMD" in
  prepare)
    [ -n "$ISO" ] || die "prepare needs --iso <Windows 11 ISO>"; [ -f "$ISO" ] || die "no such ISO: $ISO"
    [ -f "$BASE" ] && { log "base disk already exists ($BASE); destroy first to rebuild"; exit 0; }
    U="$D/unattend"; rm -rf "$U"; mkdir -p "$U/fabdesk"
    ARCH_TAG=arm64; [ "$GUEST" = x86_64 ] && ARCH_TAG=amd64
    # Generic Windows 11 Pro KMS client key (installs unactivated; fine for a throwaway test VM).
    sed -e "s|__IMAGE_INDEX__|${FABDESK_VM_WIN_IMAGE_INDEX:-6}|" -e "s|__PRODUCT_KEY__|${FABDESK_VM_WIN_KEY:-VK7JG-NPHTM-C97JM-9MPGT-3V66T}|" \
        -e "s|processorArchitecture=\"arm64\"|processorArchitecture=\"$ARCH_TAG\"|g" \
        "$REPO_ROOT/scripts/vm/guest/autounattend.xml" > "$U/autounattend.xml"
    cp "$REPO_ROOT/scripts/vm/guest/windows-agent.cmd" "$U/fabdesk/"
    make_iso "$U" "$D/unattend.iso" FABDESK_UNATTEND
    qemu-img create -q -f qcow2 "$BASE" 64G
    rm -f "$VARS"
    log "installing Windows unattended (window opens; do not interact). Serial log: $D/prepare-serial.txt"
    DISP=cocoa; [ "$(uname -s)" = Darwin ] || DISP=gtk
    boot "$BASE" "$DISP" "$D/prepare-serial.txt" \
      -drive "file=$ISO,if=none,id=cd0,media=cdrom,format=raw,readonly=on" -device usb-storage,drive=cd0,bootindex=1 \
      -drive "file=$D/unattend.iso,if=none,id=cd1,media=cdrom,format=raw,readonly=on" -device usb-storage,drive=cd1
    trap stop_vm EXIT
    # Windows Setup boots from the ISO the first time only when a key is pressed; EDK2 boots the NVMe once
    # it has a bootloader, so the reboots after setup continue the install and the final shutdown ends it.
    wait_off 5400 || die "install did not finish in 90 min"
    trap - EXIT
    log "base disk ready: $BASE" ;;

  test)
    [ -f "$BASE" ] || die "no base disk; run: windows.sh prepare --iso <Win11.iso>"
    FORMAT="${FORMAT:-nsis}"
    case "$FORMAT" in nsis) PAT="exe" ;; portable) PAT="exe" ;; *) die "--format nsis|portable" ;; esac
    INSTALLER="$(resolve_installer win x64 "$PAT")"
    if [ "$FORMAT" = portable ] && [[ "$INSTALLER" != *portable* ]]; then INSTALLER="$(dirname "$INSTALLER")/$(ls "$(dirname "$INSTALLER")" | grep -i portable | head -1)"; fi
    [ -f "$INSTALLER" ] || die "no $FORMAT installer found"
    OUT="$(new_result_dir "windows-$FORMAT")"; log "installer: $INSTALLER"; log "results: $OUT"
    PORT=$(free_port)
    python3 "$REPO_ROOT/scripts/vm/receiver.py" "$PORT" "$OUT" & RECV=$!
    P="$D/payload"; rm -rf "$P"; mkdir -p "$P/fabdesk"
    cp "$INSTALLER" "$P/fabdesk/"; cp "$REPO_ROOT/scripts/vm/guest/windows-test.ps1" "$P/fabdesk/"
    printf '{"installer":"%s","reportUrl":"http://10.0.2.2:%s"}\n' "$(basename "$INSTALLER")" "$PORT" > "$P/fabdesk/config.json"
    make_iso "$P" "$D/payload.iso" FABDESK_PAYLOAD
    stop_vm; rm -f "$OVL"; qemu-img create -q -f qcow2 -F qcow2 -b "$BASE" "$OVL"
    DISP=none; [ "$KEEP" = 1 ] && { DISP=cocoa; [ "$(uname -s)" = Darwin ] || DISP=gtk; }
    boot "$OVL" "$DISP" "$OUT/serial.txt" -drive "file=$D/payload.iso,if=none,id=cd1,media=cdrom,format=raw,readonly=on" -device usb-storage,drive=cd1
    cleanup() { kill $RECV 2>/dev/null || true; if [ "$KEEP" = 0 ]; then stop_vm; else warn "VM left running (--keep)"; fi; }
    trap cleanup EXIT
    log "waiting for the guest to report (timeout ${TIMEOUT}s)"
    for ((i=0; i<TIMEOUT; i+=5)); do [ -f "$OUT/.done" ] && break; sleep 5; done
    [ -f "$OUT/.done" ] || warn "guest did not report within ${TIMEOUT}s (see $OUT/serial.txt; try --keep to watch the display)"
    wait_off 60 || true
    finish_report "$OUT" ;;

  console)
    [ -f "$OVL" ] || die "no test VM; run test --keep"
    stop_vm; boot "$OVL" cocoa "$D/console-serial.txt" -drive "file=$D/payload.iso,if=none,id=cd1,media=cdrom,format=raw,readonly=on" -device usb-storage,drive=cd1; wait ;;
  destroy) stop_vm; rm -rf "$D"; log "deleted $D" ;;
  *) usage; exit 1 ;;
esac
