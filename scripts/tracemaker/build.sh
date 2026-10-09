#!/usr/bin/env bash
# Configure and build the tracemaker CLI using upstream CMake presets.
# Linux: cpu-only (no CUDA). macOS: macos-metal (system Metal; no Homebrew GPU stack).
set -euo pipefail

src="${1:?TraceMaker source tree}"
platform="${2:?platform id}"
jobs="${CMAKE_BUILD_PARALLEL_LEVEL:-4}"

cd "$src"
case "$platform" in
  linux-x86_64)
    preset=cpu-only
    cmake --preset "$preset" -DTM_BUILD_TESTS=OFF -DTM_BUILD_PYTHON=OFF -DTM_ENABLE_CUDA=OFF
    ;;
  macos-arm64|macos-x86_64)
    preset=macos-metal
    prefix="${HOMEBREW_PREFIX:-$(brew --prefix)}"
    cmake --preset "$preset" \
      -DCMAKE_PREFIX_PATH="$prefix" \
      -DTM_BUILD_TESTS=OFF \
      -DTM_BUILD_PYTHON=OFF
    ;;
  *)
    echo "::error::No supported CMake preset for $platform (upstream is Linux + macOS only)" >&2
    exit 1
    ;;
esac

cmake --build --preset "$preset" --target tracemaker --parallel "$jobs"
binary="$src/build/${preset}/src/app/tracemaker"
if [ ! -x "$binary" ]; then
  echo "::error::expected $binary after the build" >&2
  exit 1
fi
echo "binary=$binary"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "binary=$binary" >> "$GITHUB_OUTPUT"
fi
