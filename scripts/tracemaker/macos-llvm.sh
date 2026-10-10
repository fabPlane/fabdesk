#!/usr/bin/env bash
# Locate Homebrew LLVM and emit CMake overrides that use its headers and a
# statically linked libc++. Apple clang + SDK libc++ delete from_chars(double)
# until macOS 26; we must not raise CMAKE_OSX_DEPLOYMENT_TARGET to 26.
#
# Run 38005104781: FindSQLite3 sets SQLite3_INCLUDE_DIR to the Xcode SDK
# usr/include. CMake turns that into `-isystem <SDK>/usr/include` *before*
# CMAKE_CXX_FLAGS (`-nostdinc++ -isystem llvm/include/c++/v1`), so clang
# finds SDK stdlib.h/math.h ahead of libc++ wrappers. Only SQLite-using
# targets fail. CMAKE_CXX_STANDARD_INCLUDE_DIRECTORIES is documented to
# appear at the *end* of the include path, so it cannot win that race.
# We copy sqlite3.h into a headers-only directory and still link the
# system /usr/lib/libsqlite3.dylib (Homebrew's sqlite dylib is forbidden).
#
# Sets:
#   MACOS_LIBCXX=llvm-static|system
#   MACOS_LLVM_CMAKE_ARGS  (bash array of extra cmake -D flags)
# shellcheck disable=SC2034

_MACOS_LLVM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

macos_sdk_usr_include() {
  local sdk=""
  if command -v xcrun >/dev/null; then
    sdk="$(xcrun --show-sdk-path 2>/dev/null || true)"
  fi
  if [ -n "$sdk" ] && [ -d "$sdk/usr/include" ]; then
    printf '%s\n' "$sdk/usr/include"
    return 0
  fi
  return 1
}

macos_find_sqlite3_header() {
  local brew_sqlite="" sdk_inc=""
  if [ -n "${TM_SQLITE_HEADER:-}" ] && [ -f "${TM_SQLITE_HEADER}" ]; then
    printf '%s\n' "$TM_SQLITE_HEADER"
    return 0
  fi
  if command -v brew >/dev/null; then
    brew_sqlite="$(brew --prefix sqlite 2>/dev/null || true)"
    if [ -n "$brew_sqlite" ] && [ -f "$brew_sqlite/include/sqlite3.h" ]; then
      printf '%s\n' "$brew_sqlite/include/sqlite3.h"
      return 0
    fi
  fi
  if sdk_inc="$(macos_sdk_usr_include)" && [ -f "$sdk_inc/sqlite3.h" ]; then
    printf '%s\n' "$sdk_inc/sqlite3.h"
    return 0
  fi
  if [ -f /usr/include/sqlite3.h ]; then
    printf '%s\n' /usr/include/sqlite3.h
    return 0
  fi
  return 1
}

# System dylib is allowed (minos <= 15). Homebrew's libsqlite3.dylib is not.
# A static brew libsqlite3.a is acceptable if the system dylib is missing.
macos_sqlite_library() {
  local lib="${TM_SQLITE_LIBRARY:-}"
  if [ -z "$lib" ] && [ -f /usr/lib/libsqlite3.dylib ]; then
    lib=/usr/lib/libsqlite3.dylib
  fi
  if [ -z "$lib" ] && command -v brew >/dev/null; then
    local brew_sqlite
    brew_sqlite="$(brew --prefix sqlite 2>/dev/null || true)"
    if [ -n "$brew_sqlite" ] && [ -f "$brew_sqlite/lib/libsqlite3.a" ]; then
      lib="$brew_sqlite/lib/libsqlite3.a"
    fi
  fi
  if [ -z "$lib" ] || [ ! -f "$lib" ]; then
    echo "::error::no allowed SQLite library (need /usr/lib/libsqlite3.dylib or static libsqlite3.a)" >&2
    return 1
  fi
  case "$lib" in
    /usr/lib/libsqlite3.dylib) ;;
    *.a) ;;
    *)
      echo "::error::refusing $lib — Homebrew sqlite dylibs are not allowed; use /usr/lib/libsqlite3.dylib or libsqlite3.a" >&2
      return 1
      ;;
  esac
  printf '%s\n' "$lib"
}

# Homebrew zstd ships libzstd.a but its CMake config has no zstd::libzstd_static
# (run 38009143938 linked the dylib). Fail configure if the archive is missing.
macos_zstd_static() {
  local lib="${TM_ZSTD_LIBRARY:-}" inc="${TM_ZSTD_INCLUDE_DIR:-}" brew_zstd=""
  if command -v brew >/dev/null; then
    brew_zstd="$(brew --prefix zstd 2>/dev/null || true)"
  fi
  if [ -z "$lib" ] && [ -n "$brew_zstd" ] && [ -f "$brew_zstd/lib/libzstd.a" ]; then
    lib="$brew_zstd/lib/libzstd.a"
  fi
  if [ -z "$inc" ] && [ -n "$brew_zstd" ] && [ -d "$brew_zstd/include" ]; then
    inc="$brew_zstd/include"
  fi
  if [ -z "$lib" ] || [ ! -f "$lib" ]; then
    echo "::error::libzstd.a not found (brew --prefix zstd)/lib/libzstd.a. Homebrew's libzstd.dylib is not allowed." >&2
    return 1
  fi
  case "$lib" in
    *.a) ;;
    *)
      echo "::error::refusing $lib — link static libzstd.a, not a dylib" >&2
      return 1
      ;;
  esac
  MACOS_ZSTD_LIBRARY="$lib"
  MACOS_ZSTD_INCLUDE_DIR="$inc"
  echo "zstd static $lib include=${inc:-none}"
}

# Copy sqlite3.h into dest so FindSQLite3 does not -isystem the whole SDK usr/include.
macos_isolate_sqlite() {
  local dest="${1:?sqlite include dest}"
  local hdr lib
  hdr="$(macos_find_sqlite3_header)" || {
    echo "::error::sqlite3.h not found (SDK usr/include or brew --prefix sqlite/include)" >&2
    return 1
  }
  lib="$(macos_sqlite_library)" || return 1
  mkdir -p "$dest"
  cp "$hdr" "$dest/sqlite3.h"
  if [ -f "$(dirname "$hdr")/sqlite3ext.h" ]; then
    cp "$(dirname "$hdr")/sqlite3ext.h" "$dest/sqlite3ext.h"
  fi
  if [ -f "$dest/stdlib.h" ] || [ -f "$dest/math.h" ]; then
    echo "::error::isolated SQLite include dir $dest must not contain C stdlib headers" >&2
    return 1
  fi
  MACOS_SQLITE_INCLUDE_DIR="$dest"
  MACOS_SQLITE_LIBRARY="$lib"
  echo "SQLite headers from $hdr -> $dest (link $lib)"
}

macos_find_llvm_archive() {
  local prefix="${1:?}" name="${2:?}"
  local d
  # Homebrew llvm: libc++.a + libc++abi.a in lib/c++; libunwind.a in lib/unwind.
  for d in "$prefix/lib/c++" "$prefix/lib/unwind" "$prefix/lib"; do
    if [ -f "$d/$name" ]; then
      printf '%s\n' "$d/$name"
      return 0
    fi
  done
  return 1
}

macos_append_static_dep_cmake_args() {
  local project_include="${_MACOS_LLVM_DIR}/cmake/macos-static-deps.cmake"
  local zstd_config_dir="${_MACOS_LLVM_DIR}/cmake/zstd-static"
  MACOS_LLVM_CMAKE_ARGS+=(
    -DSQLite3_INCLUDE_DIR="$MACOS_SQLITE_INCLUDE_DIR"
    -DSQLite3_LIBRARY="$MACOS_SQLITE_LIBRARY"
    -DTM_ZSTD_LIBRARY="$MACOS_ZSTD_LIBRARY"
    -DTM_ZSTD_INCLUDE_DIR="$MACOS_ZSTD_INCLUDE_DIR"
    -DZSTD_LIBRARY="$MACOS_ZSTD_LIBRARY"
    -DZSTD_INCLUDE_DIR="$MACOS_ZSTD_INCLUDE_DIR"
    -Dzstd_DIR="$zstd_config_dir"
    -DCMAKE_PROJECT_INCLUDE="$project_include"
  )
}

macos_llvm_prepare() {
  local sqlite_dest="${1:-}"
  MACOS_LIBCXX=system
  MACOS_SQLITE_INCLUDE_DIR=""
  MACOS_SQLITE_LIBRARY=""
  MACOS_ZSTD_LIBRARY=""
  MACOS_ZSTD_INCLUDE_DIR=""
  MACOS_LLVM_CMAKE_ARGS=(
    -DTM_WERROR=OFF
    -DCMAKE_OSX_DEPLOYMENT_TARGET=15.0
  )
  export MACOSX_DEPLOYMENT_TARGET=15.0

  if [ -z "$sqlite_dest" ]; then
    echo "::error::macos_llvm_prepare requires a headers-only SQLite include directory (run 38005104781)." >&2
    return 1
  fi
  # Static zstd + isolated SQLite apply on every macOS path, including the
  # Apple clang fallback. Run 38009143938 linked Homebrew libzstd.1.dylib.
  macos_isolate_sqlite "$sqlite_dest" || return 1
  macos_zstd_static || return 1
  macos_append_static_dep_cmake_args

  local prefix=""
  if command -v brew >/dev/null; then
    prefix="$(brew --prefix llvm 2>/dev/null || true)"
  fi
  if [ -z "$prefix" ] || [ ! -x "$prefix/bin/clang++" ]; then
    echo "Homebrew LLVM clang++ not found; using Apple clang + commit-pinned from_chars patch (static zstd=$MACOS_ZSTD_LIBRARY)."
    return 0
  fi

  local inc="$prefix/include/c++/v1"
  local libcxx="" libcxxabi="" libunwind=""
  libcxx="$(macos_find_llvm_archive "$prefix" "libc++.a" || true)"
  libcxxabi="$(macos_find_llvm_archive "$prefix" "libc++abi.a" || true)"
  libunwind="$(macos_find_llvm_archive "$prefix" "libunwind.a" || true)"

  if [ ! -d "$inc" ]; then
    echo "Homebrew LLVM is installed but libc++ headers were not found under $inc; using Apple clang + patch (static zstd=$MACOS_ZSTD_LIBRARY)."
    return 0
  fi
  if [ -z "$libcxx" ]; then
    echo "::error::Homebrew LLVM $prefix has clang++ but no libc++.a (searched lib/c++, lib/unwind, lib). Cannot claim a static libc++ link." >&2
    return 1
  fi
  if [ -z "$libcxxabi" ]; then
    echo "::error::Homebrew LLVM $prefix has libc++.a but no libc++abi.a (searched lib/c++, lib/unwind, lib)." >&2
    return 1
  fi
  if [ -z "$libunwind" ]; then
    echo "::error::Homebrew LLVM $prefix has libc++.a but no libunwind.a (searched lib/c++, lib/unwind, lib). Refusing to risk a Homebrew libunwind.dylib." >&2
    return 1
  fi

  # Homebrew LLVM -nostdinc++ does not pull C stdlib headers through libc++
  # (std::atof needs <cstdlib>; run 38003551366). Force-include the C wrappers
  # used across the tree so one missing transitive include cannot stop ninja.
  local force_includes="-include cstdlib -include cstdio -include cstring -include cmath -include cstdint"
  local cxx_flags="-nostdinc++ -isystem ${inc} ${force_includes}"
  local sdk_inc=""
  if sdk_inc="$(macos_sdk_usr_include)"; then
    # After libc++ wrappers, not before: -idirafter is searched after -isystem
    # and after implicit system dirs. Isolation of sqlite3.h is what removes
    # the SDK -isystem that won in run 38005104781.
    cxx_flags+=" -idirafter ${sdk_inc}"
  fi

  # CMAKE_EXE_LINKER_FLAGS is emitted *before* objects. Archive paths there
  # are skipped by ld64 (no undefined symbols yet). Put -nostdlib++ there
  # and the .a files in CMAKE_<LANG>_STANDARD_LIBRARIES (after objects).
  # force_load libc++.a: Homebrew sets LIBCXX_STATICALLY_LINK_ABI_IN_STATIC_LIBRARY
  # so this archive already contains abi; abi/unwind .a still follow so an
  # older bottle without that merge still links. Do not -L the LLVM lib dir
  # (that would let -lc++ resolve to Homebrew's libc++.dylib).
  local link_flags="-nostdlib++ -Wl,-search_paths_first"
  local std_libs="-Wl,-force_load,${libcxx} ${libcxxabi} ${libunwind}"

  MACOS_LIBCXX=llvm-static
  MACOS_LLVM_CMAKE_ARGS+=(
    -DCMAKE_CXX_COMPILER="$prefix/bin/clang++"
    -DCMAKE_OBJCXX_COMPILER="$prefix/bin/clang++"
    -DCMAKE_CXX_FLAGS="$cxx_flags"
    -DCMAKE_OBJCXX_FLAGS="$cxx_flags"
    -DCMAKE_CXX_STANDARD_INCLUDE_DIRECTORIES="$inc"
    -DCMAKE_OBJCXX_STANDARD_INCLUDE_DIRECTORIES="$inc"
    -DCMAKE_EXE_LINKER_FLAGS="$link_flags"
    -DCMAKE_SHARED_LINKER_FLAGS="$link_flags"
    -DCMAKE_MODULE_LINKER_FLAGS="$link_flags"
    -DCMAKE_CXX_STANDARD_LIBRARIES="$std_libs"
    -DCMAKE_OBJCXX_STANDARD_LIBRARIES="$std_libs"
    -DCMAKE_CXX_IMPLICIT_LINK_LIBRARIES=""
    -DCMAKE_OBJCXX_IMPLICIT_LINK_LIBRARIES=""
  )
  echo "Using Homebrew LLVM $prefix (static libc++=$libcxx abi=$libcxxabi unwind=$libunwind, sqlite include=$MACOS_SQLITE_INCLUDE_DIR lib=$MACOS_SQLITE_LIBRARY, zstd=$MACOS_ZSTD_LIBRARY, deployment target 15.0, TM_WERROR=OFF)"
}
