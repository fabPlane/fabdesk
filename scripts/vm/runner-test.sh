#!/usr/bin/env bash
# Runs the installer test directly on a fresh CI runner (GitHub macOS / Ubuntu) instead of inside a
# VM the scripts boot themselves: the runner *is* the fresh machine. Resolves the installer like the
# VM scripts (--tag vX via gh, --latest from fabplane.com, --file), runs guest/<os>-test.sh locally
# and prints the same PASS/FAIL summary; exit status follows the report.
#   runner-test.sh <os: mac|linux> <arch regex> <ext regex> [--tag vX | --latest | --file X]
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
usage() { sed -n 2,7p "${BASH_SOURCE[0]}"; }
OS="${1:?os}"; ARCH_RE="${2:?arch}"; EXT_RE="${3:?ext}"; shift 3
parse_args test "$@"
INSTALLER="$(resolve_installer "$OS" "$ARCH_RE" "$EXT_RE")"
OUT="$(new_result_dir "runner-$OS-$(basename "$INSTALLER" | sed 's/.*-\([a-z0-9_]*\)\.\([A-Za-z]*\)$/\1-\2/')")"
log "installer: $INSTALLER"; log "results: $OUT"
case "$OS" in
  mac)   bash "$VM_SCRIPTS/guest/mac-test.sh" "$INSTALLER" "$OUT" ;;
  linux) bash "$VM_SCRIPTS/guest/linux-test.sh" "$INSTALLER" "$OUT" ;;
  *) die "os must be mac or linux (Windows runners call guest/windows-test.ps1 directly)" ;;
esac
echo "RESULTS_DIR=$OUT" >> "${GITHUB_OUTPUT:-/dev/null}"
finish_report "$OUT"
