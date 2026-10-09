#!/usr/bin/env bash
# Print file(1) / otool linkage and fail if the binary requires macOS > 15
# or (when we asked for static LLVM libc++) still links the system libc++.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "$SCRIPT_DIR/paths.sh"

binary="$(abs_existing_file "${1:?tracemaker binary}")"
libcxx="${TM_MACOS_LIBCXX:-system}"

echo "== file =="
file "$binary"
echo "== otool -L =="
otool -L "$binary"
echo "== LC_BUILD_VERSION =="
otool -l "$binary" | awk '
  $1=="cmd" && $2=="LC_BUILD_VERSION" {in_bv=1}
  $1=="cmd" && $2!="LC_BUILD_VERSION" && $2!="LC_VERSION_MIN_MACOSX" {if($2 ~ /^LC_/) in_bv=0}
  $1=="cmd" && $2=="LC_VERSION_MIN_MACOSX" {in_min=1}
  in_bv || in_min {print}
  $1=="minos" || $1=="sdk" || $1=="version" {if(in_min && $1=="version") in_min=0}
'

minos="$(otool -l "$binary" | awk '$1=="minos"{print $2; exit}')"
if [ -z "$minos" ]; then
  minos="$(otool -l "$binary" | awk '$1=="cmd" && $2=="LC_VERSION_MIN_MACOSX"{getline; if($1=="version") print $2; exit}')"
fi
echo "minos=${minos:-unknown}"
if [ -n "$minos" ]; then
  major="${minos%%.*}"
  if [ "$major" -gt 15 ]; then
    echo "::error::binary minos $minos is newer than macOS 15; the owner's Mac cannot run it" >&2
    exit 1
  fi
fi

if [ "$libcxx" = llvm-static ]; then
  if otool -L "$binary" | grep -q '/usr/lib/libc++\.1\.dylib'; then
    echo "::error::asked for static LLVM libc++ but the binary links /usr/lib/libc++.1.dylib" >&2
    exit 1
  fi
fi

echo "macos probe ok (libcxx=$libcxx)"
