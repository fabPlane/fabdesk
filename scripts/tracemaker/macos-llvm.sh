#!/usr/bin/env bash
# Locate Homebrew LLVM and emit CMake overrides that use its headers and a
# statically linked libc++. Apple clang + SDK libc++ delete from_chars(double)
# until macOS 26; we must not raise CMAKE_OSX_DEPLOYMENT_TARGET to 26.
#
# Sets:
#   MACOS_LIBCXX=llvm-static|system
#   MACOS_LLVM_CMAKE_ARGS  (bash array of extra cmake -D flags)
# shellcheck disable=SC2034

macos_llvm_prepare() {
  MACOS_LIBCXX=system
  MACOS_LLVM_CMAKE_ARGS=(
    -DTM_WERROR=OFF
    -DCMAKE_OSX_DEPLOYMENT_TARGET=15.0
  )
  export MACOSX_DEPLOYMENT_TARGET=15.0

  local prefix=""
  if command -v brew >/dev/null; then
    prefix="$(brew --prefix llvm 2>/dev/null || true)"
  fi
  if [ -z "$prefix" ] || [ ! -x "$prefix/bin/clang++" ]; then
    echo "Homebrew LLVM clang++ not found; using Apple clang + commit-pinned from_chars patch."
    return 0
  fi

  local inc="$prefix/include/c++/v1"
  local libcxx="" libcxxabi="" libunwind=""
  local d
  for d in "$prefix/lib/c++" "$prefix/lib"; do
    if [ -z "$libcxx" ] && [ -f "$d/libc++.a" ]; then libcxx="$d/libc++.a"; fi
    if [ -z "$libcxxabi" ] && [ -f "$d/libc++abi.a" ]; then libcxxabi="$d/libc++abi.a"; fi
    if [ -z "$libunwind" ] && [ -f "$d/libunwind.a" ]; then libunwind="$d/libunwind.a"; fi
  done
  if [ ! -d "$inc" ] || [ -z "$libcxx" ]; then
    echo "Homebrew LLVM is installed but libc++.a / headers were not found under $prefix; using Apple clang + patch."
    return 0
  fi

  # Homebrew LLVM -nostdinc++ does not pull C stdlib headers through libc++
  # (std::atof needs <cstdlib>; run 38003551366). Force-include the C wrappers
  # used across the tree so one missing transitive include cannot stop ninja.
  local force_includes="-include cstdlib -include cstdio -include cstring -include cmath -include cstdint"
  local cxx_flags="-nostdinc++ -isystem ${inc} ${force_includes}"
  local link_flags="-nostdlib++ ${libcxx}"
  if [ -n "$libcxxabi" ]; then
    link_flags+=" ${libcxxabi}"
  fi
  if [ -n "$libunwind" ]; then
    link_flags+=" ${libunwind}"
  fi

  MACOS_LIBCXX=llvm-static
  MACOS_LLVM_CMAKE_ARGS+=(
    -DCMAKE_CXX_COMPILER="$prefix/bin/clang++"
    -DCMAKE_OBJCXX_COMPILER="$prefix/bin/clang++"
    -DCMAKE_CXX_FLAGS="$cxx_flags"
    -DCMAKE_OBJCXX_FLAGS="$cxx_flags"
    -DCMAKE_EXE_LINKER_FLAGS="$link_flags"
  )
  echo "Using Homebrew LLVM $prefix (static libc++=$libcxx, deployment target 15.0, TM_WERROR=OFF)"
}
