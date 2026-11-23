#!/usr/bin/env bash
# Path helpers shared by the TraceMaker release scripts.
# Source this file; do not execute it.

abs_existing_dir() {
  local p="${1:?path}"
  if [ ! -d "$p" ]; then
    echo "::error::not a directory: $p" >&2
    return 1
  fi
  (cd -- "$p" && pwd)
}

abs_existing_file() {
  local p="${1:?path}"
  if [ ! -e "$p" ]; then
    echo "::error::not a file: $p" >&2
    return 1
  fi
  local dir base
  dir="$(cd -- "$(dirname -- "$p")" && pwd)"
  base="$(basename -- "$p")"
  printf '%s/%s\n' "$dir" "$base"
}

# Resolve a path that may not exist yet. Creates the parent directory.
abs_path() {
  local p="${1:?path}"
  if [[ "$p" = /* ]]; then
    printf '%s\n' "$p"
    return 0
  fi
  local dir base
  dir="$(dirname -- "$p")"
  base="$(basename -- "$p")"
  mkdir -p -- "$dir"
  dir="$(cd -- "$dir" && pwd)"
  printf '%s/%s\n' "$dir" "$base"
}

# The placer (tracemaker-place) that belongs to a tracemaker binary: beside it
# (an unpacked archive), else the CMake build tree's src/place next to
# src/app. `windows` (or a binary named *.exe) looks for tracemaker-place.exe
# first. Prints the absolute path, or fails with nothing printed.
find_placer() {
  local binary="${1:?tracemaker binary}" platform="${2:-}" dir names name cand
  dir="$(cd -- "$(dirname -- "$binary")" && pwd)"
  names="tracemaker-place"
  case "$platform:$binary" in
    windows-*:*|*:*.exe|*:*.EXE) names="tracemaker-place.exe tracemaker-place" ;;
  esac
  for name in $names; do
    for cand in "$dir/$name" "$dir/../place/$name"; do
      if [ -f "$cand" ]; then
        abs_existing_file "$cand"
        return 0
      fi
    done
  done
  return 1
}
