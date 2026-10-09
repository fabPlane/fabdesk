#!/usr/bin/env bash
# Configure and build the tracemaker CLI using upstream CMake presets.
# Linux: cpu-only (no CUDA). macOS: macos-metal with Homebrew LLVM libc++
# (static) and CMAKE_OSX_DEPLOYMENT_TARGET=15.0. Resolve the source tree to
# an absolute path BEFORE cd — a relative TraceMaker/ path after cd looks in
# the wrong directory (run 37997000616).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "$SCRIPT_DIR/paths.sh"
# shellcheck source=macos-llvm.sh
source "$SCRIPT_DIR/macos-llvm.sh"

src="$(abs_existing_dir "${1:?TraceMaker source tree}")"
platform="${2:?platform id}"
jobs="${CMAKE_BUILD_PARALLEL_LEVEL:-4}"

cd "$src"

cmake_extra=()
case "$platform" in
  linux-x86_64)
    preset=cpu-only
    cmake_extra+=(-DTM_BUILD_TESTS=OFF -DTM_BUILD_PYTHON=OFF -DTM_ENABLE_CUDA=OFF)
    ;;
  macos-arm64|macos-x86_64)
    preset=macos-metal
    prefix="${HOMEBREW_PREFIX:-$(brew --prefix)}"
    macos_llvm_prepare
    cmake_extra+=(
      -DCMAKE_PREFIX_PATH="$prefix"
      -DTM_BUILD_TESTS=OFF
      -DTM_BUILD_PYTHON=OFF
      "${MACOS_LLVM_CMAKE_ARGS[@]}"
    )
    bash "$SCRIPT_DIR/apply-macos-patch.sh" "$src"
    if [ -n "${GITHUB_ENV:-}" ]; then
      echo "TM_MACOS_LIBCXX=${MACOS_LIBCXX}" >> "$GITHUB_ENV"
    fi
    printf '%s\n' "${MACOS_LIBCXX}" > "$src/.fabdesk-macos-libcxx"
    ;;
  *)
    echo "::error::No supported CMake preset for $platform (upstream is Linux + macOS only)" >&2
    exit 1
    ;;
esac

cmake --preset "$preset" "${cmake_extra[@]}"

build_dir="$src/build/${preset}"
mkdir -p "$build_dir"
build_log="$build_dir/fabdesk-build.log"
if [[ "$platform" == macos-* ]]; then
  # Keep going so one 10+ minute macOS job reports every missing include / API,
  # not just the first ninja target (run 38003551366 stopped at rule_engine.cpp).
  set +e
  set +o pipefail
  cmake --build --preset "$preset" --target tracemaker --parallel "$jobs" -- -k 0 2>&1 | tee "$build_log"
  build_code="${PIPESTATUS[0]}"
  set -e
  set -o pipefail
  bash "$SCRIPT_DIR/summarize-build.sh" "$build_log"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "build_log=$build_log" >> "$GITHUB_OUTPUT"
  fi
  if [ "$build_code" -ne 0 ]; then
    echo "::error::macOS tracemaker build failed; see the FABDESK BUILD FAILURE SUMMARY and $build_log" >&2
    exit "$build_code"
  fi
else
  cmake --build --preset "$preset" --target tracemaker --parallel "$jobs"
fi

binary="$src/build/${preset}/src/app/tracemaker"
if [ ! -f "$binary" ]; then
  echo "::error::expected $binary after the build" >&2
  echo "build tree:" >&2
  find "$src/build" -name 'tracemaker' -o -name 'tracemaker.exe' >&2 || true
  exit 1
fi
chmod +x "$binary" || true
if [ ! -x "$binary" ]; then
  echo "::error::$binary exists but is not executable" >&2
  exit 1
fi

echo "binary=$binary"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "binary=$binary" >> "$GITHUB_OUTPUT"
fi
