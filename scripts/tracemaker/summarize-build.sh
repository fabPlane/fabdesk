#!/usr/bin/env bash
# Print a delimited summary of every ninja FAILED target and its first error
# line so a keep-going macOS build (ninja -k 0) is readable in CI.
# Only emit the FAILURE SUMMARY banner when ninja actually failed — SDK
# warning text contains the substring "error:" (run 38009143938).
set -euo pipefail

log="${1:?build log}"
if [ ! -f "$log" ]; then
  echo "========== FABDESK BUILD FAILURE SUMMARY =========="
  echo "no log file: $log"
  echo "========== END SUMMARY =========="
  exit 0
fi

has_failed_target=0
if grep -q '^FAILED:' "$log"; then
  has_failed_target=1
fi
ninja_stopped=0
if grep -qE 'ninja: build stopped|ninja: error:' "$log"; then
  ninja_stopped=1
fi
if [ "$has_failed_target" -eq 0 ] && [ "$ninja_stopped" -eq 0 ]; then
  exit 0
fi

echo "========== FABDESK BUILD FAILURE SUMMARY =========="
echo "log: $log"

last_progress="$(grep -E '^\[[0-9]+/[0-9]+\]' "$log" | tail -n 1 || true)"
if [ -n "$last_progress" ]; then
  echo "last_progress: $last_progress"
fi

failed=0
current=""
first_error=""
compile_line=""
saw_libcxx_order=0
flush() {
  if [ -z "$current" ]; then
    return 0
  fi
  echo "FAILED: $current"
  if [ -n "$compile_line" ]; then
    echo "  cmd: $compile_line"
  fi
  if [ -n "$first_error" ]; then
    echo "  $first_error"
  else
    echo "  (no error: line captured)"
  fi
  failed=$((failed + 1))
}

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    FAILED:*)
      flush
      current="${line#FAILED: }"
      current="${current#"${current%%[![:space:]]*}"}"
      # ninja 1.12+: "FAILED: [code=1] path"
      if [[ "$current" == \[code=* ]]; then
        current="${current#*] }"
      fi
      first_error=""
      compile_line=""
      ;;
    *error:*)
      if [ -n "$current" ] && [ -z "$first_error" ]; then
        first_error="$line"
      fi
      if [[ "$line" == *"tried including"* ]] || [[ "$line" == *"didn't find libc++"* ]]; then
        saw_libcxx_order=1
      fi
      ;;
    \[[0-9]*/*)
      ;;
    ==========*)
      ;;
    *)
      if [ -n "$current" ] && [ -z "$compile_line" ] && [ -n "$line" ]; then
        compile_line="$line"
      fi
      ;;
  esac
done < "$log"
flush

if [ "$failed" -eq 0 ]; then
  echo "ninja reported failure; first error lines:"
  grep -E 'error:' "$log" | head -n 20 || true
else
  echo "failed_targets=$failed"
fi
if [ "$saw_libcxx_order" -ne 0 ]; then
  echo "hint: libc++ C-wrapper include order (SDK usr/include as -isystem before llvm/include/c++/v1). SQLite-using targets need an isolated sqlite3.h dir, not the Xcode SDK include."
fi
echo "========== END SUMMARY =========="
