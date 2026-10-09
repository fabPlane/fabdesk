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
fi

echo "== help =="
if ! "$binary" --help >"$out_dir/help.txt" 2>&1 && ! "$binary" help >"$out_dir/help.txt" 2>&1; then
  echo "::error::tracemaker --help failed" >&2
  cat "$out_dir/help.txt" >&2 || true
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
  exit 1
fi
test -s "$routed"
echo "smoke ok (exit $code)"
