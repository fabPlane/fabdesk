#!/usr/bin/env bash
# Copy non-system shared libraries next to the binary so users do not need a toolchain.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "$SCRIPT_DIR/paths.sh"

binary="$(abs_existing_file "${1:?binary path}")"
libdir="$(abs_path "${2:?lib output directory}")"
notes="${3:-/dev/null}"
if [ "$notes" != /dev/null ]; then
  notes="$(abs_path "$notes")"
fi
mkdir -p "$libdir"

is_system_linux() {
  case "$1" in
    linux-vdso.so*|ld-linux*|libc.so*|libm.so*|libdl.so*|librt.so*|libpthread.so*|libresolv.so*)
      return 0
      ;;
  esac
  return 1
}

is_system_macos() {
  case "$1" in
    /usr/lib/*|/System/Library/*|/Library/Apple/*)
      return 0
      ;;
  esac
  return 1
}

echo "Dynamic libraries for ${binary}:" | tee -a "$notes"
if command -v ldd >/dev/null; then
  ldd "$binary" | tee -a "$notes" || true
  while read -r line; do
    lib="${line%% =>*}"
    lib="${lib##* }"
    dest="${line#* => }"
    dest="${dest%% (*}"
    dest="${dest## }"
    if [ -z "$dest" ] || [ ! -f "$dest" ]; then
      continue
    fi
    if is_system_linux "$(basename "$dest")"; then
      continue
    fi
    cp -L "$dest" "$libdir/"
    echo "bundled $(basename "$dest")" | tee -a "$notes"
  done < <(ldd "$binary" || true)
  if command -v patchelf >/dev/null && [ -n "$(ls -A "$libdir" 2>/dev/null || true)" ]; then
    # $ORIGIN must reach the dynamic linker literally.
    # shellcheck disable=SC2016
    patchelf --set-rpath '$ORIGIN/lib' "$binary"
    echo "patchelf rpath=\$ORIGIN/lib" | tee -a "$notes"
  fi
elif command -v otool >/dev/null; then
  otool -L "$binary" | tee -a "$notes"
  bundled=0
  while read -r line; do
    dest="$(printf '%s' "$line" | awk '{print $1}')"
    [ -f "$dest" ] || continue
    is_system_macos "$dest" && continue
    name="$(basename "$dest")"
    cp -L "$dest" "$libdir/$name"
    install_name_tool -change "$dest" "@executable_path/lib/$name" "$binary"
    echo "bundled $name -> @executable_path/lib/$name" | tee -a "$notes"
    bundled=1
  done < <(otool -L "$binary" | tail -n +2)
  # install_name_tool invalidates ad-hoc signatures; package.sh codesigns last.
  # Do not add an rpath when nothing was bundled (static libc++ / zstd / sqlite).
  if [ "$bundled" -ne 0 ]; then
    install_name_tool -add_rpath "@executable_path/lib" "$binary" 2>/dev/null || true
  fi
else
  echo "no ldd/otool; left the linker default" | tee -a "$notes"
fi

if [ -z "$(ls -A "$libdir" 2>/dev/null || true)" ]; then
  rmdir "$libdir" 2>/dev/null || true
  echo "No extra libraries bundled (header-only / static / system glibc or macOS frameworks)." | tee -a "$notes"
fi
