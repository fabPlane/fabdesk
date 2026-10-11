#!/usr/bin/env bash
# Fail if the Windows binary still depends on a non-system DLL that is not
# sitting next to the executable (or in ./lib). System DLLs are the UCRT /
# Win32 API set. MSYS2 ldd is the probe (same as bundle-libs.sh).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "$SCRIPT_DIR/paths.sh"

binary="$(abs_existing_file "${1:?tracemaker.exe}")"
bindir="$(cd "$(dirname -- "$binary")" && pwd)"

is_system_windows_dll() {
  local base
  base="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$base" in
    kernel32.dll|kernelbase.dll|ntdll.dll|user32.dll|gdi32.dll|shell32.dll|advapi32.dll|ole32.dll|oleaut32.dll|ws2_32.dll|wsock32.dll|secur32.dll|crypt32.dll|bcrypt.dll|bcryptprimitives.dll|normaliz.dll|imm32.dll|comdlg32.dll|comctl32.dll|winmm.dll|iphlpapi.dll|mswsock.dll|dnsapi.dll|userenv.dll|version.dll|shlwapi.dll|setupapi.dll|winspool.drv|ucrtbase.dll|msvcrt.dll|vcruntime140.dll|vcruntime140_1.dll|msvcp140.dll|concrt140.dll|api-ms-win-*.dll|ext-ms-*.dll)
      return 0
      ;;
  esac
  return 1
}

if ! command -v ldd >/dev/null; then
  echo "::warning::ldd not on PATH; skipping Windows DLL probe"
  exit 0
fi

fail=0
echo "Windows DLL probe for ${binary}:"
while read -r line; do
  dest="${line#* => }"
  dest="${dest%% (*}"
  dest="${dest## }"
  name="$(basename -- "${dest:-$line}")"
  [ -n "$name" ] || continue
  case "$line" in
    *not\ found*)
      echo "missing DLL: $line"
      fail=1
      continue
      ;;
  esac
  is_system_windows_dll "$name" && continue
  if [ -f "$bindir/$name" ] || [ -f "$bindir/lib/$name" ]; then
    echo "bundled $name"
    continue
  fi
  echo "::error::non-system DLL is not bundled next to the exe: $name ($dest)"
  fail=1
done < <(ldd "$binary" || true)

if [ "$fail" -ne 0 ]; then
  echo "Windows linkage check failed"
  exit 1
fi
echo "Windows linkage check passed (system DLLs + bundled extras only)"
