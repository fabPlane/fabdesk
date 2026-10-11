#!/usr/bin/env bash
# Locate MSYS2 UCRT64 static zstd / sqlite and emit CMake args for Windows.
# Source this file; do not execute it.
# Upstream has no Windows preset. Warnings.cmake is GCC-only (-Wall), so this
# job uses MinGW (UCRT64), not MSVC / clang-cl.

if [ -z "${WINDOWS_CMAKE_ARGS+x}" ]; then
  WINDOWS_CMAKE_ARGS=()
fi

windows_msys_prepare() {
  local prefix="${MINGW_PREFIX:-/ucrt64}"
  if [ ! -d "$prefix" ]; then
    prefix="${MSYSTEM_PREFIX:-$prefix}"
  fi
  if [ ! -d "$prefix" ]; then
    echo "::error::MINGW_PREFIX not found (expected MSYS2 UCRT64 at /ucrt64)" >&2
    return 1
  fi
  WINDOWS_MINGW_PREFIX="$prefix"
  WINDOWS_ZSTD_LIBRARY=""
  WINDOWS_ZSTD_INCLUDE_DIR=""
  WINDOWS_SQLITE_LIBRARY=""
  WINDOWS_SQLITE_INCLUDE_DIR=""
  if [ -f "$prefix/lib/libzstd.a" ]; then
    WINDOWS_ZSTD_LIBRARY="$prefix/lib/libzstd.a"
  fi
  if [ -d "$prefix/include" ]; then
    WINDOWS_ZSTD_INCLUDE_DIR="$prefix/include"
    WINDOWS_SQLITE_INCLUDE_DIR="$prefix/include"
  fi
  if [ -f "$prefix/lib/libsqlite3.a" ]; then
    WINDOWS_SQLITE_LIBRARY="$prefix/lib/libsqlite3.a"
  fi
  if [ -z "$WINDOWS_ZSTD_LIBRARY" ]; then
    echo "::error::static libzstd.a not found under $prefix/lib" >&2
    return 1
  fi
  if [ -z "$WINDOWS_SQLITE_LIBRARY" ]; then
    echo "::warning::static libsqlite3.a not found; FindSQLite3 may pick a DLL"
  fi
  WINDOWS_CMAKE_ARGS=(
    -G Ninja
    -DCMAKE_BUILD_TYPE=RelWithDebInfo
    -DTM_ENABLE_CUDA=OFF
    -DTM_ENABLE_METAL=OFF
    -DTM_BUILD_TESTS=OFF
    -DTM_BUILD_PYTHON=OFF
    -DTM_WERROR=OFF
    -DCMAKE_PREFIX_PATH="$prefix"
    -DCMAKE_PROJECT_INCLUDE="$SCRIPT_DIR/cmake/windows-static-runtime.cmake"
    -DTM_ZSTD_LIBRARY="$WINDOWS_ZSTD_LIBRARY"
    -DTM_WINDOWS_STATIC=1
    -Dzstd_DIR="$SCRIPT_DIR/cmake/zstd-static"
  )
  if [ -n "$WINDOWS_ZSTD_INCLUDE_DIR" ]; then
    WINDOWS_CMAKE_ARGS+=(-DTM_ZSTD_INCLUDE_DIR="$WINDOWS_ZSTD_INCLUDE_DIR")
  fi
  if [ -n "$WINDOWS_SQLITE_LIBRARY" ]; then
    WINDOWS_CMAKE_ARGS+=(-DSQLite3_LIBRARY="$WINDOWS_SQLITE_LIBRARY")
  fi
  if [ -n "$WINDOWS_SQLITE_INCLUDE_DIR" ]; then
    WINDOWS_CMAKE_ARGS+=(-DSQLite3_INCLUDE_DIR="$WINDOWS_SQLITE_INCLUDE_DIR")
  fi
  export WINDOWS_MINGW_PREFIX WINDOWS_ZSTD_LIBRARY WINDOWS_ZSTD_INCLUDE_DIR
  export WINDOWS_SQLITE_LIBRARY WINDOWS_SQLITE_INCLUDE_DIR
}
