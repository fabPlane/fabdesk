#!/usr/bin/env bash
# Print file(1) / otool linkage and fail if the binary requires macOS > 15,
# links Homebrew / non-system dylibs, or (when we asked for static LLVM
# libc++) still links any libc++ dylib.
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
    if [ "$(uname -s)" = Darwin ]; then
      bash "$SCRIPT_DIR/diagnose-macos.sh" "$binary" "${TRACEMAKER_DIAG_DIR:-${RUNNER_TEMP:-/tmp}/tracemaker-macos-debug}/probe" || true
    fi
    exit 1
  fi
fi

# Direct LC_LOAD_DYLIB entries. Frameworks pull libobjc / CoreFoundation
# transitively; otool -L only lists what we linked. Allow system /usr/lib
# and /System/Library; reject Homebrew, MacPorts, and any libc++ dylib when
# we asked for a static LLVM libc++.
fail_dylib=0
while read -r dest _; do
  dest="${dest#"${dest%%[![:space:]]*}"}"
  case "$dest" in
    ""|*:)
      continue
      ;;
  esac
  case "$dest" in
    /opt/homebrew/*|/usr/local/*|/opt/local/*|*/Cellar/*)
      echo "::error::binary links non-system $dest (Homebrew/MacPorts dylibs are not allowed; system libsqlite3 is /usr/lib/libsqlite3.dylib)" >&2
      fail_dylib=1
      continue
      ;;
    /usr/lib/libc++.1.dylib|/usr/lib/libc++.dylib|/usr/lib/libc++abi.1.dylib|/usr/lib/libunwind.dylib|/usr/lib/libunwind.1.dylib)
      if [ "$libcxx" = llvm-static ]; then
        echo "::error::asked for static LLVM libc++ but the binary links $dest" >&2
        fail_dylib=1
      fi
      continue
      ;;
    /usr/lib/*|/System/Library/*|/Library/Apple/*)
      continue
      ;;
    *)
      echo "::error::binary links unexpected $dest (allowed: /usr/lib/libSystem.B.dylib, /usr/lib/libsqlite3.dylib, /usr/lib/libobjc.A.dylib, system frameworks)" >&2
      fail_dylib=1
      ;;
  esac
done < <(otool -L "$binary" | tail -n +2)

if [ "$fail_dylib" -ne 0 ]; then
  if [ "$(uname -s)" = Darwin ]; then
    bash "$SCRIPT_DIR/diagnose-macos.sh" "$binary" "${TRACEMAKER_DIAG_DIR:-${RUNNER_TEMP:-/tmp}/tracemaker-macos-debug}/probe" || true
  fi
  exit 1
fi

echo "macos probe ok (libcxx=$libcxx)"
