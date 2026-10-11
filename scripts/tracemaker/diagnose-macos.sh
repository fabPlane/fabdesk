#!/usr/bin/env bash
# Best-effort abort diagnostics for a freshly-linked macos-arm64 tracemaker.
# Never fails the caller (exit 0): missing lldb / crash reports must not hide
# the original smoke/probe error. bash 3.2 / BSD-tool safe.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "$SCRIPT_DIR/paths.sh"

if [ "$(uname -s)" != Darwin ]; then
  echo "skip macos abort diagnostics (not Darwin)"
  exit 0
fi

if [ $# -lt 2 ]; then
  echo "usage: diagnose-macos.sh <tracemaker-binary> <out-dir>" >&2
  exit 0
fi

binary="$(abs_existing_file "$1" 2>/dev/null || true)"
out_dir="$(abs_path "$2")"
mkdir -p "$out_dir"

if [ -z "$binary" ]; then
  echo "diagnose-macos: binary missing: $1" | tee "$out_dir/diagnose-error.txt"
  exit 0
fi

cp "$binary" "$out_dir/tracemaker" 2>/dev/null || true
chmod +x "$out_dir/tracemaker" 2>/dev/null || true

echo "== diagnose macos abort: $binary =="

{
  echo "== file =="
  file "$binary" || true
  echo
  echo "== otool -L =="
  otool -L "$binary" || true
  echo
  echo "== LC_LOAD_DYLIB =="
  otool -l "$binary" | awk '
    $1=="cmd" && $2=="LC_LOAD_DYLIB" {p=1}
    $1=="cmd" && $2!="LC_LOAD_DYLIB" && $2 ~ /^LC_/ {p=0}
    p {print}
  ' || true
  echo
  echo "== nm -u (operator new / __cxa_ / libc++) =="
  nm -u "$binary" 2>/dev/null | grep -E 'operator new|operator delete|__cxa_|___cxa_|libc\+\+' | head -n 40 || true
} >"$out_dir/linkage.txt" 2>&1
cat "$out_dir/linkage.txt"

echo
echo "== DYLD_PRINT_LIBRARIES=1 ./tracemaker version (head -80) =="
python3 - "$binary" <<'PY' >"$out_dir/dyld.txt" 2>&1 || true
import os, subprocess, sys

binary = sys.argv[1]
env = os.environ.copy()
env["DYLD_PRINT_LIBRARIES"] = "1"
try:
    r = subprocess.run(
        [binary, "version"],
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
    )
    sys.stdout.write(r.stdout or "")
    sys.stderr.write(r.stderr or "")
    sys.stdout.write("exit=%s\n" % r.returncode)
except subprocess.TimeoutExpired as exc:
    sys.stdout.write(exc.stdout or "")
    sys.stderr.write(exc.stderr or "")
    sys.stderr.write("dyld probe timed out after 15s\n")
except Exception as exc:
    sys.stderr.write("dyld probe failed: %s\n" % exc)
PY
head -n 80 "$out_dir/dyld.txt" || true

echo
if command -v lldb >/dev/null; then
  echo "== lldb -b -o run -o bt -o 'image list' -- ./tracemaker version =="
  python3 - "$binary" <<'PY' >"$out_dir/lldb.txt" 2>&1 || true
import subprocess, sys

binary = sys.argv[1]
cmd = [
    "lldb",
    "-b",
    "-o",
    "run",
    "-o",
    "bt",
    "-o",
    "image list",
    "--",
    binary,
    "version",
]
try:
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    sys.stdout.write(r.stdout or "")
    sys.stderr.write(r.stderr or "")
    sys.stdout.write("lldb_exit=%s\n" % r.returncode)
except subprocess.TimeoutExpired as exc:
    sys.stdout.write(exc.stdout or "")
    sys.stderr.write(exc.stderr or "")
    sys.stderr.write("lldb timed out after 30s\n")
except Exception as exc:
    sys.stderr.write("lldb failed: %s\n" % exc)
PY
  head -n 120 "$out_dir/lldb.txt" || true
else
  echo "lldb not on PATH (Homebrew llvm no longer ships it; Xcode lldb is /usr/bin/lldb)." | tee "$out_dir/lldb.txt"
fi

echo
echo "== crash reports (DiagnosticReports) =="
{
  echo "HOME=$HOME"
  newest=""
  newest_t=0
  for d in "${HOME}/Library/Logs/DiagnosticReports" /Library/Logs/DiagnosticReports; do
    [ -d "$d" ] || continue
    echo "-- $d --"
    ls -lt "$d" 2>/dev/null | head -n 15 || true
    for f in "$d"/tracemaker*.ips "$d"/tracemaker*.crash; do
      [ -f "$f" ] || continue
      t="$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)"
      if [ "$t" -gt "$newest_t" ] 2>/dev/null; then
        newest_t="$t"
        newest="$f"
      fi
    done
  done
  if [ -n "$newest" ]; then
    echo "newest=$newest"
    head -n 80 "$newest"
    cp "$newest" "$out_dir/$(basename "$newest")" 2>/dev/null || true
  else
    echo "no tracemaker .ips/.crash found"
  fi
} >"$out_dir/crash-report.txt" 2>&1 || true
cat "$out_dir/crash-report.txt"

echo "wrote macos abort diagnostics under $out_dir"
exit 0
