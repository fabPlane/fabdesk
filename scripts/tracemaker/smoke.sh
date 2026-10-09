#!/usr/bin/env bash
# --help / --version, then a tiny route on the bundled fixture.
set -euo pipefail

binary="${1:?tracemaker binary}"
fixture="${2:-$(dirname "$0")/fixtures/smoke.kicad_pcb}"
out_dir="${3:-${RUNNER_TEMP:-/tmp}/tracemaker-smoke}"
mkdir -p "$out_dir"

chmod +x "$binary" || true

echo "== help =="
if ! "$binary" --help >"$out_dir/help.txt" 2>&1 && ! "$binary" help >"$out_dir/help.txt" 2>&1; then
  echo "::error::tracemaker --help failed" >&2
  cat "$out_dir/help.txt" >&2 || true
  exit 1
fi
head -n 20 "$out_dir/help.txt"

echo "== version =="
if "$binary" --version >"$out_dir/version.txt" 2>&1; then
  cat "$out_dir/version.txt"
else
  echo "no --version flag; help output is enough"
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
