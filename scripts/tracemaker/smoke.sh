#!/usr/bin/env bash
# --help / --version, then a tiny route on the bundled fixture.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "$SCRIPT_DIR/paths.sh"

binary="$(abs_existing_file "${1:?tracemaker binary}")"
fixture="$(abs_existing_file "${2:-$SCRIPT_DIR/fixtures/smoke.kicad_pcb}")"
out_dir="${3:-${RUNNER_TEMP:-/tmp}/tracemaker-smoke}"
out_dir="$(abs_path "$out_dir")"
mkdir -p "$out_dir"

chmod +x "$binary" || true

if [ "$(uname -s)" = Darwin ]; then
  echo "== macos probe =="
  file "$binary"
  otool -L "$binary" || true
  # Freshly-linked arm64 binaries on macos-15 can be unrunnable until signed.
  # This is the build-tree copy; package.sh strips and ad-hoc signs last.
  if command -v codesign >/dev/null; then
    codesign --force -s - "$binary" || true
  fi
fi

diagnose_if_darwin() {
  if [ "$(uname -s)" != Darwin ]; then
    return 0
  fi
  local diag="${TRACEMAKER_DIAG_DIR:-$out_dir/diagnose}"
  bash "$SCRIPT_DIR/diagnose-macos.sh" "$binary" "$diag" || true
}

echo "== help =="
if ! "$binary" --help >"$out_dir/help.txt" 2>&1 && ! "$binary" help >"$out_dir/help.txt" 2>&1; then
  echo "::error::tracemaker --help failed" >&2
  echo "help.txt ($(wc -c <"$out_dir/help.txt" | tr -d ' ') bytes):" >&2
  cat "$out_dir/help.txt" >&2 || true
  diagnose_if_darwin
  exit 1
fi
head -n 20 "$out_dir/help.txt"

echo "== version =="
if "$binary" version >"$out_dir/version.txt" 2>&1; then
  cat "$out_dir/version.txt"
elif "$binary" --version >"$out_dir/version.txt" 2>&1; then
  cat "$out_dir/version.txt"
else
  echo "no version / --version subcommand; help output is enough"
fi

echo "== route fixture =="
routed="$out_dir/routed.kicad_pcb"
set +e
"$binary" route "$fixture" -o "$routed" --time 15 --work 50000 --no-kb --no-gpu \
  >"$out_dir/route.txt" 2>&1
code=$?
set -e
cat "$out_dir/route.txt" || true
# Upstream: 0 success, 3 partial routing.
if [ "$code" != 0 ] && [ "$code" != 3 ]; then
  echo "::error::tracemaker route exited $code on the smoke fixture" >&2
  diagnose_if_darwin
  exit 1
fi
test -s "$routed"
echo "smoke ok (exit $code)"
