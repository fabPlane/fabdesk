#!/usr/bin/env bash
# Daily fresh-VM installer test for a job host (OpenClaw on agent1). Runs every test this host can
# run against the build fabplane.com currently serves, sequentially, and prints one summary line per
# test. Exits non-zero (so the scheduler announces the output) when any test fails; prints nothing
# beyond the summary on success so a silent run means "all good".
#
#   daily.sh [--tests "linux:appimage linux:deb windows:nsis mac:arm64:dmg"] [--tag vX | --latest]
#
# Memory: VMs run one at a time. FABDESK_VM_MEM_LINUX / FABDESK_VM_MEM_WINDOWS (MiB) default to 4096
# / 6144 and are clamped to leave 3 GiB for the host; the script refuses to start a VM the host cannot
# fit. Hosts without KVM/HVF run everything under emulation, which is slow but works.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTS="${FABDESK_VM_DAILY_TESTS:-}"; SEL=(--latest); EXTRA=()
while [ $# -gt 0 ]; do case "$1" in --tests) TESTS="$2"; shift 2 ;; --tag) SEL=(--tag "$2"); shift 2 ;; --latest) SEL=(--latest); shift ;; *) EXTRA+=("$1"); shift ;; esac; done
if [ -z "$TESTS" ]; then
  TESTS="linux:appimage linux:deb"
  if [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ]; then TESTS="mac:arm64:dmg mac:x64:dmg mac:arm64:zip $TESTS"; fi
  [ -f "${FABDESK_VM_DIR:-$HOME/.fabdesk-vm}/windows-x86_64/base.qcow2" ] && TESTS="$TESTS windows:nsis"
fi
LOG="${FABDESK_VM_DIR:-$HOME/.fabdesk-vm}/daily-$(date +%Y%m%d-%H%M%S).log"; mkdir -p "$(dirname "$LOG")"

# Hardware acceleration: a long-running scheduler (the OpenClaw gateway) was started before its user
# joined the kvm group, so its children cannot open /dev/kvm and every VM falls back to emulation
# (minutes instead of seconds, and Electron gets flaky). Re-exec once through `sg kvm` to pick the
# group up without restarting the scheduler.
# `id -nG` alone reports the groups the process was started with, which for a long-running scheduler
# predate the group change; `id -nG <user>` reads the group database instead.
if [ -e /dev/kvm ] && [ ! -w /dev/kvm ] && [ -z "${FABDESK_VM_SG:-}" ] && id -nG "$(id -un)" | tr " " "\n" | grep -qx kvm; then
  export FABDESK_VM_SG=1
  exec sg kvm -c "$(printf '%q ' "$0" "$@")"
fi
[ -e /dev/kvm ] && { [ -w /dev/kvm ] && echo "accel: kvm" >&2 || echo "accel: emulated (/dev/kvm not writable by $(id -un))" >&2; } || echo "accel: emulated (no /dev/kvm)" >&2

host_mem_mib() {
  if [ "$(uname -s)" = Darwin ]; then echo $(( $(sysctl -n hw.memsize) / 1048576 ))
  else awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo; fi
}
fit_mem() {  # fit_mem <wanted MiB> -> MiB that leaves 3 GiB for the host, or empty when impossible
  local avail; avail="$(host_mem_mib)"; local max=$(( avail - 3072 ))
  if [ "$max" -lt 2048 ]; then echo ""; elif [ "$1" -gt "$max" ]; then echo "$max"; else echo "$1"; fi
}

fails=0; lines=()
for t in $TESTS; do
  IFS=: read -r os a b <<<"$t"
  case "$os" in
    linux)  mem="$(fit_mem "${FABDESK_VM_MEM_LINUX:-4096}")"; cmd=("$HERE/linux.sh" test --format "$a") ;;
    windows) mem="$(fit_mem "${FABDESK_VM_MEM_WINDOWS:-6144}")"; cmd=("$HERE/windows.sh" test --format "$a") ;;
    mac)    mem=""; cmd=("$HERE/mac.sh" test --arch "$a" --format "$b") ;;
    *) lines+=("SKIP  $t (unknown)"); continue ;;
  esac
  if [ "$os" != mac ] && [ -z "$mem" ]; then lines+=("FAIL  $t: host has only $(host_mem_mib) MiB available, not enough for a VM"); fails=$((fails+1)); continue; fi
  start=$(date +%s)
  out="$(FABDESK_VM_MEM="${mem:-}" "${cmd[@]}" "${SEL[@]}" "${EXTRA[@]}" 2>&1)"; rc=$?
  printf '===== %s (rc=%s, %ss)\n%s\n' "$t" "$rc" "$(( $(date +%s) - start ))" "$out" >> "$LOG"
  summary="$(printf '%s\n' "$out" | grep -E '^(PASS|FAIL)' | tail -1)"
  [ -n "$summary" ] || summary="FAIL  $t: no result ($(printf '%s\n' "$out" | grep -v "^\s*$" | tail -1 | cut -c1-160))"
  [ $rc -eq 0 ] || fails=$((fails+1))
  lines+=("$summary  [$(( $(date +%s) - start ))s]")
done
printf '%s\n' "${lines[@]}"
echo "log: $LOG"
[ $fails -eq 0 ] || { echo "$fails installer test(s) failed"; exit 1; }
