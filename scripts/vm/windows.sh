#!/usr/bin/env bash
# Fresh Windows installer test in a QEMU VM. Windows has no cloud image, so `prepare` performs a
# one-time unattended install from an ISO. With no --iso it downloads Microsoft's Windows 11
# Enterprise evaluation ISO (90-day, direct link, no form) for the guest architecture.
#
#   scripts/vm/windows.sh prepare [--guest x86_64|aarch64] [--iso Win11.iso]   # once; x86_64 is emulated on Apple Silicon (slow, hours)
#   scripts/vm/windows.sh test [--format nsis|portable] [--file X | --tag vX | --latest] [--keep]
#   scripts/vm/windows.sh console                   # open the VM display of the last test (--keep)
#   scripts/vm/windows.sh destroy
#
# Guest choice: the Fabdesk Windows build is x64. An x86_64 guest runs it natively and needs only
# inbox drivers (NVMe disk, e1000e NIC, standard VGA), which is what users have; on Apple Silicon it
# runs under TCG emulation (install ~1-3 h, each test ~10-20 min). An aarch64 guest is fast under HVF
# but runs the installer through Windows' own x64 emulation. Default: x86_64.
#
# `test` boots a throwaway overlay of the base disk with a payload CD (installer + guest/windows-test.ps1).
# The startup agent installed during `prepare` runs the test, which reports back over HTTP to the host
# (10.0.2.2) and powers the VM off.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
usage() { sed -n 2,18p "${BASH_SOURCE[0]}"; }
GUEST="${FABDESK_VM_WIN_GUEST:-x86_64}"
# extra flag parsed before the common ones
ARGS=(); while [ $# -gt 0 ]; do case "$1" in --guest) GUEST="$2"; shift 2 ;; *) ARGS+=("$1"); shift ;; esac; done
parse_args "${ARGS[@]}"
[ "$GUEST" = x86_64 ] || [ "$GUEST" = aarch64 ] || die "--guest x86_64|aarch64"
D="$VM_DIR/windows-$GUEST"; mkdir -p "$D"
BASE="$D/base.qcow2"; OVL="$D/test.qcow2"; VARS="$D/efivars.fd"; PIDF="$D/qemu.pid"; MON="$D/monitor.sock"
MEM="${FABDESK_VM_MEM:-8192}"
need "qemu-system-$GUEST" "brew install qemu"; need qemu-img "brew install qemu"
EVAL_X64="https://go.microsoft.com/fwlink/?linkid=2289031"     # Windows 11 Enterprise 24H2 eval, x64, en-US
EVAL_ARM64="https://go.microsoft.com/fwlink/?linkid=2289032"   # same, arm64

efi_code() {
  local p f
  for p in /opt/homebrew/share/qemu /usr/local/share/qemu /usr/share/qemu /usr/share/edk2/aarch64 /usr/share/OVMF; do
    if [ "$GUEST" = aarch64 ]; then [ -f "$p/edk2-aarch64-code.fd" ] && { echo "$p/edk2-aarch64-code.fd"; return; }
    else for f in edk2-x86_64-code.fd OVMF_CODE_4M.fd OVMF_CODE.fd; do [ -f "$p/$f" ] && { echo "$p/$f"; return; }; done; fi
  done; die "no EDK2 firmware found for $GUEST (brew install qemu)"
}
native() { [ "$(uname -s)" = Darwin ] && { [ "$(uname -m)" = arm64 ] && [ "$GUEST" = aarch64 ] || [ "$(uname -m)" = x86_64 ] && [ "$GUEST" = x86_64 ]; }; }
accel() {
  if native; then echo "-accel hvf -cpu host"
  elif [ "$(uname -s)" = Linux ] && [ -w /dev/kvm ] && [ "$(uname -m)" = "$GUEST" ]; then echo "-accel kvm -cpu host"
  elif [ "$GUEST" = x86_64 ]; then echo "-accel tcg,thread=multi -cpu Skylake-Client-v4"   # Win11 wants POPCNT/SSE4.2; a named model avoids TCG 'max' quirks
  else echo "-accel tcg,thread=multi -cpu max"; fi
}
boot() {  # boot <disk> <display: none|cocoa|gtk> <serial log> [extra drives...]
  local disk="$1" disp="$2" logf="$3"; shift 3
  local machine=(-M virt,highmem=on) devs=(-device ramfb -device usb-net,netdev=n0)
  if [ "$GUEST" = x86_64 ]; then machine=(-M q35); devs=(-vga std -device e1000e,netdev=n0); fi
  if [ ! -f "$VARS" ]; then
    if [ "$GUEST" = aarch64 ]; then qemu-img create -q -f raw "$VARS" 64M
    else cp "$(dirname "$(efi_code)")/edk2-i386-vars.fd" "$VARS" 2>/dev/null || cp "$(dirname "$(efi_code)")/OVMF_VARS_4M.fd" "$VARS" 2>/dev/null || qemu-img create -q -f raw "$VARS" 4M; fi
  fi
  rm -f "$MON"
  # shellcheck disable=SC2046
  "qemu-system-$GUEST" "${machine[@]}" $(accel) -smp "${FABDESK_VM_CPUS:-8}" -m "$MEM" -display "$disp" -serial "file:$logf" \
    -monitor "unix:$MON,server,nowait" -pidfile "$PIDF" -rtc base=utc \
    -drive "if=pflash,format=raw,readonly=on,file=$(efi_code)" -drive "if=pflash,format=raw,file=$VARS" \
    -device qemu-xhci -device usb-kbd -device usb-tablet "${devs[@]}" -netdev user,id=n0 \
    -drive "file=$disk,if=none,id=hd,format=qcow2" -device nvme,drive=hd,serial=fabdesk "$@" >"$D/qemu.log" 2>&1 </dev/null &
  # vm_alive/wait_off read the pidfile; give QEMU a moment to write it (fast on KVM, slower under TCG).
  for i in $(seq 1 20); do [ -s "$PIDF" ] && break; sleep 0.5; done
}
mon() { python3 - "$MON" "$1" <<'PY'
import socket, sys, time
s = socket.socket(socket.AF_UNIX); s.settimeout(3)
try:
    s.connect(sys.argv[1]); time.sleep(0.2); s.recv(4096)
    s.sendall((sys.argv[2] + "\n").encode()); time.sleep(0.2)
except Exception: pass
PY
}
stop_vm() {  # SIGTERM, then SIGKILL: a VM left behind keeps the caller's output pipe open
  local pid; pid="$(cat "$PIDF" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null; for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PIDF" "$MON"
}
vm_alive() { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }
wait_off() { local i; for ((i=0; i<$1; i+=5)); do vm_alive || return 0; sleep 5; done; return 1; }
make_iso() {  # make_iso <dir> <out.iso> <label>
  if command -v mkisofs >/dev/null; then mkisofs -quiet -o "$2" -V "$3" -joliet -rock -udf "$1"
  elif command -v genisoimage >/dev/null; then genisoimage -quiet -o "$2" -V "$3" -joliet -rock -udf "$1"
  elif [ "$(uname -s)" = Darwin ]; then hdiutil makehybrid -quiet -iso -joliet -udf -default-volume-name "$3" -o "$2" "$1"
  else die "need mkisofs (genisoimage)"; fi
}
cdrom_args() {  # cdrom_args <id> <iso> [bootindex]
  # q35 AHCI has one unit per port: cd0 -> ide.0, cd1 -> ide.1, ...
  if [ "$GUEST" = x86_64 ]; then echo "-drive file=$2,if=none,id=$1,media=cdrom,format=raw,readonly=on -device ide-cd,drive=$1,bus=ide.${1#cd}${3:+,bootindex=$3}"
  else echo "-drive file=$2,if=none,id=$1,media=cdrom,format=raw,readonly=on -device usb-storage,drive=$1${3:+,bootindex=$3}"; fi
}

case "$CMD" in
  prepare)
    [ -f "$BASE" ] && { log "base disk already exists ($BASE); destroy first to rebuild"; exit 0; }
    EVAL=0
    if [ -z "$ISO" ]; then
      EVAL=1; ISO="$CACHE_DIR/win11-eval-$GUEST.iso"
      URL="$EVAL_X64"; [ "$GUEST" = aarch64 ] && URL="$EVAL_ARM64"
      if [ ! -f "$ISO" ]; then log "downloading Windows 11 Enterprise evaluation ISO ($GUEST, ~5 GB) -> $ISO"; curl -fL --progress-bar -o "$ISO.part" "$URL" && mv "$ISO.part" "$ISO"; fi
    fi
    [ -f "$ISO" ] || die "no such ISO: $ISO"
    U="$D/unattend"; rm -rf "$U"; mkdir -p "$U/fabdesk"
    ARCH_TAG=arm64; [ "$GUEST" = x86_64 ] && ARCH_TAG=amd64
    IDX="${FABDESK_VM_WIN_IMAGE_INDEX:-$([ "$EVAL" = 1 ] && echo 1 || echo 6)}"
    KEY="${FABDESK_VM_WIN_KEY:-$([ "$EVAL" = 1 ] && echo "" || echo VK7JG-NPHTM-C97JM-9MPGT-3V66T)}"   # generic Pro key for retail ISOs (unactivated)
    sed -e "s|__IMAGE_INDEX__|$IDX|" -e "s|processorArchitecture=\"arm64\"|processorArchitecture=\"$ARCH_TAG\"|g" \
        "$VM_SCRIPTS/guest/autounattend.xml" > "$U/autounattend.xml"
    if [ -n "$KEY" ]; then sed -i.bak "s|__PRODUCT_KEY__|$KEY|" "$U/autounattend.xml"; else sed -i.bak 's|<ProductKey><Key>__PRODUCT_KEY__</Key></ProductKey>||' "$U/autounattend.xml"; fi
    rm -f "$U/autounattend.xml.bak"
    cp "$VM_SCRIPTS/guest/windows-agent.cmd" "$U/fabdesk/"
    make_iso "$U" "$D/unattend.iso" FABDESK_UNATTEND
    qemu-img create -q -f qcow2 "$BASE" 64G
    rm -f "$VARS"
    DISP=none; [ "$KEEP" = 1 ] && { DISP=cocoa; [ "$(uname -s)" = Darwin ] || DISP=gtk; }
    log "installing Windows unattended (guest $GUEST, image index $IDX). Serial log: $D/prepare-serial.txt"
    native || warn "emulated guest: expect 1-3 hours"
    # shellcheck disable=SC2046
    boot "$BASE" "$DISP" "$D/prepare-serial.txt" $(cdrom_args cd0 "$ISO" 1) $(cdrom_args cd1 "$D/unattend.iso")
    trap stop_vm EXIT
    # The Windows CD bootloader waits for "Press any key to boot from CD". Under emulation OVMF often
    # reaches that prompt late and times out into the UEFI shell, and later reboots can land there
    # too when NVMe is not enumerated. Press Enter while the screen is blank; qemu-rescue.sh watches
    # for the shell for the whole install and boots the disk / CD from it.
    "$VM_SCRIPTS/qemu-rescue.sh" "$MON" "$PIDF" 15 2>>"$D/prepare-rescue.log" &
    RESCUE=$!
    for i in $(seq 1 120); do
      vm_alive || break
      state="$(python3 "$VM_SCRIPTS/qemu-screen.py" "$MON" "$D/screen.ppm")"
      [ "$state" = other ] && { log "Windows Setup is running"; break; }
      [ "$state" = black ] && mon "sendkey ret"
      sleep 5
    done
    rm -f "$D/screen.ppm"
    wait_off "${FABDESK_VM_INSTALL_TIMEOUT:-14400}" || die "install did not finish in time (see $D/prepare-serial.txt; rerun with --keep to watch)"
    kill $RESCUE 2>/dev/null || true
    trap - EXIT
    log "base disk ready: $BASE" ;;

  test)
    [ -f "$BASE" ] || die "no base disk; run: windows.sh prepare [--guest $GUEST]"
    FORMAT="${FORMAT:-nsis}"
    case "$FORMAT" in nsis|portable) ;; *) die "--format nsis|portable" ;; esac
    INSTALLER="$(resolve_installer win "(x64|amd64|x86_64)" exe)"
    if [ "$FORMAT" = portable ] && [[ "$INSTALLER" != *portable* ]]; then INSTALLER="$(dirname "$INSTALLER")/$(ls "$(dirname "$INSTALLER")" | grep -i portable | head -1)"; fi
    [ -f "$INSTALLER" ] || die "no $FORMAT installer found"
    OUT="$(new_result_dir "windows-$GUEST-$FORMAT")"; log "installer: $INSTALLER"; log "results: $OUT"
    PORT=$(free_port)
    python3 "$VM_SCRIPTS/receiver.py" "$PORT" "$OUT" >/dev/null 2>&1 </dev/null & RECV=$!
    P="$D/payload"; rm -rf "$P"; mkdir -p "$P/fabdesk"
    cp "$INSTALLER" "$P/fabdesk/"; cp "$VM_SCRIPTS/guest/windows-test.ps1" "$P/fabdesk/"
    printf '{"installer":"%s","reportUrl":"http://10.0.2.2:%s"}\n' "$(basename "$INSTALLER")" "$PORT" > "$P/fabdesk/config.json"
    make_iso "$P" "$D/payload.iso" FABDESK_PAYLOAD
    stop_vm; rm -f "$OVL"; qemu-img create -q -f qcow2 -F qcow2 -b "$BASE" "$OVL"
    DISP=none; [ "$KEEP" = 1 ] && { DISP=cocoa; [ "$(uname -s)" = Darwin ] || DISP=gtk; }
    # shellcheck disable=SC2046
    boot "$OVL" "$DISP" "$OUT/serial.txt" $(cdrom_args cd1 "$D/payload.iso")
    cleanup() { kill $RECV 2>/dev/null || true; if [ "$KEEP" = 0 ]; then stop_vm; else warn "VM left running (--keep)"; fi; }
    trap cleanup EXIT
    "$VM_SCRIPTS/qemu-rescue.sh" "$MON" "$PIDF" 20 2>>"$OUT/rescue.log" & RESCUE=$!
    log "waiting for the guest to report (timeout ${TIMEOUT}s)"
    for ((i=0; i<TIMEOUT; i+=5)); do [ -f "$OUT/.done" ] && break; vm_alive || break; sleep 5; done
    kill $RESCUE 2>/dev/null || true
    [ -f "$OUT/.done" ] || warn "guest did not report within ${TIMEOUT}s (see $OUT/serial.txt; try --keep to watch the display)"
    wait_off 60 || true
    finish_report "$OUT" ;;

  console)
    [ -f "$OVL" ] || die "no test VM; run test --keep"
    # shellcheck disable=SC2046
    stop_vm; boot "$OVL" cocoa "$D/console-serial.txt" $(cdrom_args cd1 "$D/payload.iso"); wait ;;
  destroy) stop_vm; rm -rf "$D"; log "deleted $D" ;;
  *) usage; exit 1 ;;
esac
