#!/usr/bin/env bash
# --help / --version, then a tiny route on the bundled fixture; then the
# placer (tracemaker-place): --help and a tiny placement on the same fixture,
# checking the log lines and JSON report board_route's floorplan path parses.
# Placer: 4th argument, else beside the binary / in the build tree.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "$SCRIPT_DIR/paths.sh"

binary="$(abs_existing_file "${1:?tracemaker binary}")"
fixture="$(abs_existing_file "${2:-$SCRIPT_DIR/fixtures/smoke.kicad_pcb}")"
out_dir="${3:-${RUNNER_TEMP:-/tmp}/tracemaker-smoke}"
out_dir="$(abs_path "$out_dir")"
mkdir -p "$out_dir"
placer="${4:-}"
if [ -n "$placer" ]; then
  placer="$(abs_existing_file "$placer")"
elif ! placer="$(find_placer "$binary")"; then
  echo "::error::no tracemaker-place beside $binary or in its build tree (pass it as the 4th argument)" >&2
  exit 1
fi

chmod +x "$binary" "$placer" || true

if [ "$(uname -s)" = Darwin ]; then
  echo "== macos probe =="
  file "$binary"
  otool -L "$binary" || true
  # Freshly-linked arm64 binaries on macos-15 can be unrunnable until signed.
  # This is the build-tree copy; package.sh strips and ad-hoc signs last.
  if command -v codesign >/dev/null; then
    codesign --force -s - "$binary" || true
    codesign --force -s - "$placer" || true
  fi
fi

diagnose_if_darwin() {
  if [ "$(uname -s)" != Darwin ]; then
    return 0
  fi
  local target="${1:-$binary}" diag="${TRACEMAKER_DIAG_DIR:-$out_dir/diagnose}"
  if [ "$target" != "$binary" ]; then
    diag="$diag/placer"
  fi
  bash "$SCRIPT_DIR/diagnose-macos.sh" "$target" "$diag" || true
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

echo "== placer help =="
if ! "$placer" --help >"$out_dir/place-help.txt" 2>&1; then
  echo "::error::tracemaker-place --help failed" >&2
  cat "$out_dir/place-help.txt" >&2 || true
  diagnose_if_darwin "$placer"
  exit 1
fi
head -n 8 "$out_dir/place-help.txt"
# The flags board_route's floorplan passes give the placer (floorplan.ts placeGroup).
for flag in --output --mode --time --seed --courtyard-clearance-mm --json; do
  if ! grep -q -- "$flag" "$out_dir/place-help.txt"; then
    echo "::error::tracemaker-place --help does not list $flag (board_route's floorplan passes use it)" >&2
    exit 1
  fi
done

echo "== place fixture =="
placed="$out_dir/placed.kicad_pcb"
set +e
"$placer" "$fixture" -o "$placed" --mode full --time 5 --seed 1 --threads 1 \
  --courtyard-clearance-mm 0.25 --json "$out_dir/place.json" >"$out_dir/place.txt" 2>&1
pcode=$?
set -e
cat "$out_dir/place.txt" || true
if [ "$pcode" != 0 ]; then
  echo "::error::tracemaker-place exited $pcode on the smoke fixture" >&2
  diagnose_if_darwin "$placer"
  exit 1
fi
test -s "$placed"
test -s "$out_dir/place.json"
# floorplan.ts reads these two lines and place.json's fixed_parts.
if ! grep -Eq 'legalisation: [0-9]+ placed, [0-9]+ failed' "$out_dir/place.txt" \
  || ! grep -Eq 'conflicts[[:space:]]+before[[:space:]]+[0-9]+[[:space:]]+after[[:space:]]+[0-9]+[[:space:]]+new [0-9]+' "$out_dir/place.txt"; then
  echo "::error::tracemaker-place output lacks the legalisation / conflicts lines board_route's floorplan path parses" >&2
  exit 1
fi
if ! grep -q '"fixed_parts"' "$out_dir/place.json"; then
  echo "::error::tracemaker-place --json report has no fixed_parts (board_route's floorplan path reads it)" >&2
  exit 1
fi
echo "smoke ok (route exit $code, place exit $pcode)"
