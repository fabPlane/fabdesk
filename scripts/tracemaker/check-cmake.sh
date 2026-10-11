#!/usr/bin/env bash
# Parse and configure every TraceMaker CMake shim. These files only run on
# macos-15 / windows-latest in the weekly job; a missing `()` (run 38013328567)
# must fail here before anyone dispatches those runners.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -n "${1:-}" ]; then
  mkdir -p "$1"
  WORK="$(cd "$1" && pwd)"
else
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/tm-cmake-check.XXXXXX")"
  trap 'rm -rf "$WORK"' EXIT
fi

cc_bin=""
if command -v cc >/dev/null; then
  cc_bin=cc
elif command -v gcc >/dev/null; then
  cc_bin=gcc
elif command -v clang >/dev/null; then
  cc_bin=clang
fi
have_cmake_tools=1
if ! command -v cmake >/dev/null || [ -z "$cc_bin" ] || ! command -v ar >/dev/null; then
  have_cmake_tools=0
fi
if [ "$have_cmake_tools" -eq 0 ]; then
  if [ "${TM_REQUIRE_CMAKE:-}" = 1 ]; then
    echo "::error::cmake, a C compiler (cc/gcc/clang), and ar are required to exercise scripts/tracemaker/cmake (run 38013328567)" >&2
    exit 1
  fi
  echo "::notice::skipping cmake shim harness; cmake/cc/ar are not on this runner. The hosted TraceMaker scripts job enforces it."
  echo "skip cmake harness (tools missing; hosted job is the gate)"
  exit 0
fi

echo "cmake $(cmake --version | head -n 1) cc=$cc_bin"

stub_src="$SCRIPT_DIR/cmake/harness/stub.c"
mkdir -p "$WORK/lib" "$WORK/include"
"$cc_bin" -c "$stub_src" -o "$WORK/lib/stub.o"
ar rcs "$WORK/lib/libzstd.a" "$WORK/lib/stub.o"
ar rcs "$WORK/lib/libsqlite3.a" "$WORK/lib/stub.o"
ar rcs "$WORK/lib/libc++.a" "$WORK/lib/stub.o"
printf '%s\n' '/* fake zstd.h */' > "$WORK/include/zstd.h"
zstd_a="$WORK/lib/libzstd.a"
inc="$WORK/include"

# cmake -P cannot add_library / project(), so "parse check" is a throwaway
# project that include()s each shim after project(). That is the same parser
# macos-15 cmake uses at configure.
parse_one() {
  local shim="$1"
  local name
  name="$(basename "$shim" .cmake)"
  local d="$WORK/parse-$name"
  rm -rf "$d"
  mkdir -p "$d"
  cat > "$d/CMakeLists.txt" <<EOF
cmake_minimum_required(VERSION 3.19)
set(TM_ZSTD_LIBRARY "${zstd_a}")
set(TM_ZSTD_INCLUDE_DIR "${inc}")
project(parse_${name} NONE)
include("${shim}")
EOF
  cmake -S "$d" -B "$d/b" >"$d/cmake.out" 2>&1 || {
    echo "FAIL cmake parse/include $shim"
    cat "$d/cmake.out"
    return 1
  }
  echo "ok   cmake include $(basename "$shim")"
}

fail=0
shims=()
while IFS= read -r f; do
  case "$f" in
    */harness/*) continue ;;
  esac
  shims+=("$f")
done < <(find "$SCRIPT_DIR/cmake" -name '*.cmake' | sort)

if [ ${#shims[@]} -eq 0 ]; then
  echo "FAIL no .cmake shims under $SCRIPT_DIR/cmake"
  exit 1
fi
for shim in "${shims[@]}"; do
  parse_one "$shim" || fail=1
done

# User-defined functions require parentheses. cmake parses
# `fabdesk_collect_targets _child` as a command named fabdesk_collect_targets
# with a missing "(" (run 38013328567).
# Literal regex: the `${` is a character class, not a shell expansion.
# shellcheck disable=SC2016
if grep -nE '^[[:space:]]*fabdesk_[A-Za-z0-9_]+[[:space:]]+[A-Za-z0-9_./${}"-]' \
  "${shims[@]}"; then
  echo "FAIL cmake user-function call is missing parentheses"
  fail=1
else
  echo "ok   every fabdesk_* call uses parentheses"
fi

harness="$SCRIPT_DIR/cmake/harness"
happy="$WORK/happy"
rm -rf "$happy"
if cmake -S "$harness" -B "$happy" \
  -DTM_ZSTD_LIBRARY="$zstd_a" \
  -DTM_ZSTD_INCLUDE_DIR="$inc" \
  -Dzstd_DIR="$SCRIPT_DIR/cmake/zstd-static" \
  -DCMAKE_PROJECT_INCLUDE="$SCRIPT_DIR/cmake/macos-static-deps.cmake" \
  >"$WORK/happy.out" 2>&1; then
  echo "ok   cmake harness configure (CMAKE_PROJECT_INCLUDE + find_package zstd)"
else
  echo "FAIL cmake harness configure"
  cat "$WORK/happy.out"
  fail=1
fi
if [ -f "$happy/harness-report.txt" ]; then
  if grep -q 'tm_replay LINK_LIBRARIES=' "$happy/harness-report.txt" \
    && grep -q 'zstd::libzstd_shared loc=' "$happy/harness-report.txt"; then
    echo "ok   harness rewrote tm_replay onto zstd::libzstd_static"
  else
    echo "FAIL harness-report.txt is incomplete"
    cat "$happy/harness-report.txt"
    fail=1
  fi
elif [ "$fail" -eq 0 ]; then
  echo "FAIL harness did not write harness-report.txt"
  fail=1
fi

# --trace-expand: same configure, fail on cmake parse errors in the log.
trace="$WORK/trace"
rm -rf "$trace"
if cmake --trace-expand -S "$harness" -B "$trace" \
  -DTM_ZSTD_LIBRARY="$zstd_a" \
  -DTM_ZSTD_INCLUDE_DIR="$inc" \
  -Dzstd_DIR="$SCRIPT_DIR/cmake/zstd-static" \
  -DCMAKE_PROJECT_INCLUDE="$SCRIPT_DIR/cmake/macos-static-deps.cmake" \
  >"$WORK/trace.out" 2>&1; then
  if grep -E 'Parse error|CMake Error' "$WORK/trace.out"; then
    echo "FAIL cmake --trace-expand reported an error"
    fail=1
  else
    echo "ok   cmake --trace-expand of the shims"
  fi
else
  echo "FAIL cmake --trace-expand"
  tail -n 40 "$WORK/trace.out"
  fail=1
fi

missing="$WORK/missing"
rm -rf "$missing"
if cmake -S "$harness" -B "$missing" \
  -DTM_ZSTD_LIBRARY="$WORK/lib/missing-libzstd.a" \
  -Dzstd_DIR="$SCRIPT_DIR/cmake/zstd-static" \
  -DCMAKE_PROJECT_INCLUDE="$SCRIPT_DIR/cmake/macos-static-deps.cmake" \
  >"$WORK/missing.out" 2>&1; then
  echo "FAIL harness accepted a missing libzstd.a"
  fail=1
else
  if grep -q 'TM_ZSTD_LIBRARY\|libzstd.a' "$WORK/missing.out"; then
    echo "ok   harness fatals when libzstd.a is missing"
  else
    echo "FAIL missing-archive configure failed for an unexpected reason"
    cat "$WORK/missing.out"
    fail=1
  fi
fi

touch "$WORK/lib/libzstd.dylib"
dylib="$WORK/dylib"
rm -rf "$dylib"
if cmake -S "$harness" -B "$dylib" \
  -DTM_ZSTD_LIBRARY="$WORK/lib/libzstd.dylib" \
  -Dzstd_DIR="$SCRIPT_DIR/cmake/zstd-static" \
  -DCMAKE_PROJECT_INCLUDE="$SCRIPT_DIR/cmake/macos-static-deps.cmake" \
  >"$WORK/dylib.out" 2>&1; then
  echo "FAIL harness accepted a zstd dylib"
  fail=1
else
  if grep -qi 'dylib\|refusing' "$WORK/dylib.out"; then
    echo "ok   harness fatals on a zstd dylib"
  else
    echo "FAIL dylib configure failed for an unexpected reason"
    cat "$WORK/dylib.out"
    fail=1
  fi
fi

win_happy="$WORK/win-happy"
rm -rf "$win_happy"
if cmake -S "$harness" -B "$win_happy" \
  -DTM_WINDOWS_STATIC=1 \
  -DTM_ZSTD_LIBRARY="$zstd_a" \
  -DTM_ZSTD_INCLUDE_DIR="$inc" \
  -Dzstd_DIR="$SCRIPT_DIR/cmake/zstd-static" \
  -DCMAKE_PROJECT_INCLUDE="$SCRIPT_DIR/cmake/windows-static-runtime.cmake" \
  >"$WORK/win-happy.out" 2>&1; then
  echo "ok   cmake harness configure (windows-static-runtime + find_package zstd)"
else
  echo "FAIL windows cmake harness configure"
  cat "$WORK/win-happy.out"
  fail=1
fi

touch "$WORK/lib/libzstd.dll"
win_dll="$WORK/win-dll"
rm -rf "$win_dll"
if cmake -S "$harness" -B "$win_dll" \
  -DTM_WINDOWS_STATIC=1 \
  -DTM_ZSTD_LIBRARY="$WORK/lib/libzstd.dll" \
  -Dzstd_DIR="$SCRIPT_DIR/cmake/zstd-static" \
  -DCMAKE_PROJECT_INCLUDE="$SCRIPT_DIR/cmake/windows-static-runtime.cmake" \
  >"$WORK/win-dll.out" 2>&1; then
  echo "FAIL windows harness accepted a zstd DLL"
  fail=1
else
  if grep -qi 'dll\|refusing' "$WORK/win-dll.out"; then
    echo "ok   windows harness fatals on a zstd DLL"
  else
    echo "FAIL windows DLL configure failed for an unexpected reason"
    cat "$WORK/win-dll.out"
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "cmake shim checks failed"
  exit 1
fi
echo "cmake shim checks passed"
