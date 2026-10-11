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
