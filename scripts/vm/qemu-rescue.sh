#!/usr/bin/env bash
# Watches a QEMU guest's display and, whenever the EDK2 UEFI shell appears, connects all devices and
# launches the Windows boot manager from the installed disk (or, failing that, the CD's EFI image).
# OVMF under emulation regularly misses the CD "press any key" prompt and skips NVMe enumeration.
#   qemu-rescue.sh <monitor.sock> <pidfile> [poll-seconds]   (runs until the VM exits)
#   qemu-rescue.sh --once <monitor.sock>                       (one rescue attempt, no loop)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rescue() {
  local mon="$1" cmds="connect -r\nmap -r\n"
  for n in 0 1 2 3 4 5; do cmds+="FS${n}:\\\\EFI\\\\Microsoft\\\\Boot\\\\bootmgfw.efi\n"; done
  for n in 0 1; do cmds+="FS${n}:\\\\EFI\\\\BOOT\\\\BOOTX64.EFI\n"; done
  python3 "$HERE/qemu-keys.py" "$mon" "$cmds" >/dev/null 2>&1
  # the CD image asks for "any key"; press Enter a few times in case it was the one that ran
  for j in 1 2 3 4 5 6; do python3 "$HERE/qemu-keys.py" "$mon" "\n" >/dev/null 2>&1; sleep 2; done
}
if [ "${1:-}" = "--once" ]; then rescue "$2"; exit 0; fi
MON="$1"; PIDF="$2"; POLL="${3:-20}"; PPM="${MON%.sock}-rescue.ppm"
while [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; do
  if [ "$(python3 "$HERE/qemu-screen.py" "$MON" "$PPM")" = shell ]; then
    echo "$(date +%H:%M:%S) UEFI shell detected: booting the installed disk / CD" >&2
    rescue "$MON"; sleep 30
  fi
  sleep "$POLL"
done
rm -f "$PPM"
