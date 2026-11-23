#!/usr/bin/env bash
# Build macOS variants in preference order (tracemaker + tracemaker-place),
# probe and smoke both, publish the first that passes. Variant A = Apple clang + system libc++ (single C++ runtime).
# Variant B = Homebrew LLVM static libc++ (run 6: linked, then SIGABRT on
# --help). Stops at the first smoke success. If every variant fails, leaves
# unpackaged binaries + diagnose-macos.sh output under TRACEMAKER_DIAG_DIR.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "$SCRIPT_DIR/paths.sh"

src="$(abs_existing_dir "${1:?TraceMaker source tree}")"
platform="${2:?platform id}"
fixture="$(abs_existing_file "${3:-$SCRIPT_DIR/fixtures/smoke.kicad_pcb}")"
diag_root="${TRACEMAKER_DIAG_DIR:-${RUNNER_TEMP:-/tmp}/tracemaker-macos-debug}"
diag_root="$(abs_path "$diag_root")"
mkdir -p "$diag_root"

if [[ "$platform" != macos-* ]]; then
  echo "::error::macos-variants.sh is macOS-only (got $platform)" >&2
  exit 1
fi

winner=""
winner_bin=""
winner_placer=""
any_built=0

# Preference order: system libc++ first (Metal/Foundation already load Apple's
# /usr/lib/libc++.1.dylib; a second, statically-linked LLVM libc++ is the
# leading SIGABRT hypothesis from run 38016562996).
for variant in system llvm-static; do
  echo "========== macOS variant ${variant} =========="
  build_dir="$src/build/macos-metal-${variant}"
  variant_diag="$diag_root/${variant}"
  mkdir -p "$variant_diag"
  export TM_MACOS_LIBCXX="$variant"
  export TM_MACOS_BUILD_DIR="$build_dir"

  set +e
  bash "$SCRIPT_DIR/build.sh" "$src" "$platform"
  build_code=$?
  set -e
  if [ -f "$build_dir/fabdesk-build.log" ]; then
    cp "$build_dir/fabdesk-build.log" "$variant_diag/fabdesk-build.log" || true
  fi
  if [ "$build_code" -ne 0 ]; then
    echo "variant ${variant}: build failed (exit $build_code)"
    echo "build_failed" >"$variant_diag/result.txt"
    continue
  fi

  binary="$build_dir/src/app/tracemaker"
  if [ ! -f "$binary" ]; then
    echo "variant ${variant}: build reported success but $binary is missing"
    echo "missing_binary" >"$variant_diag/result.txt"
    continue
  fi
  placer="$build_dir/src/place/tracemaker-place"
  if [ ! -f "$placer" ]; then
    echo "variant ${variant}: build reported success but $placer is missing"
    echo "missing_placer" >"$variant_diag/result.txt"
    continue
  fi
  any_built=1
  cp "$binary" "$variant_diag/tracemaker" || true
  cp "$placer" "$variant_diag/tracemaker-place" || true
  chmod +x "$variant_diag/tracemaker" "$variant_diag/tracemaker-place" || true

  # Same linkage rules for the placer (minos 15, no Homebrew dylibs, libc++ per variant).
  set +e
  bash "$SCRIPT_DIR/verify-macos.sh" "$binary" && bash "$SCRIPT_DIR/verify-macos.sh" "$placer"
  probe_code=$?
  set -e
  if [ "$probe_code" -ne 0 ]; then
    echo "variant ${variant}: linkage probe failed"
    echo "probe_failed" >"$variant_diag/result.txt"
    bash "$SCRIPT_DIR/diagnose-macos.sh" "$binary" "$variant_diag/diagnose" || true
    continue
  fi

  smoke_out="$variant_diag/smoke"
  set +e
  bash "$SCRIPT_DIR/smoke.sh" "$binary" "$fixture" "$smoke_out" "$placer"
  smoke_code=$?
  set -e
  if [ "$smoke_code" -eq 0 ]; then
    echo "variant ${variant}: smoke passed — selected"
    echo "smoke_ok" >"$variant_diag/result.txt"
    winner="$variant"
    winner_bin="$binary"
    winner_placer="$placer"
    break
  fi
  echo "variant ${variant}: smoke failed (exit $smoke_code)"
  echo "smoke_failed" >"$variant_diag/result.txt"
  # smoke.sh already ran diagnose-macos.sh into $smoke_out/diagnose when Darwin.
done

{
  echo "winner=${winner:-none}"
  echo "binary=${winner_bin:-}"
  echo "placer=${winner_placer:-}"
  echo "diag=$diag_root"
} | tee "$diag_root/selection.txt"

if [ -z "$winner" ]; then
  echo "::error::every macOS libc++ variant failed smoke (or failed to build). Unpackaged binaries and abort diagnostics are under $diag_root (artifact tracemaker-macos-arm64-debug)." >&2
  if [ "$any_built" -eq 0 ]; then
    echo "::error::no variant produced a tracemaker binary" >&2
  fi
  exit 1
fi

echo "binary=$winner_bin"
echo "placer=$winner_placer"
echo "macos_variant=$winner"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "binary=$winner_bin" >>"$GITHUB_OUTPUT"
  echo "placer=$winner_placer" >>"$GITHUB_OUTPUT"
  echo "macos_variant=$winner" >>"$GITHUB_OUTPUT"
  echo "diag_dir=$diag_root" >>"$GITHUB_OUTPUT"
fi
