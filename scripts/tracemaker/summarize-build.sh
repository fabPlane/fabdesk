#!/usr/bin/env bash
# Print a delimited summary of every ninja FAILED target and its first error
# line so a keep-going macOS build (ninja -k 0) is readable in CI.
set -euo pipefail

log="${1:?build log}"
if [ ! -f "$log" ]; then
  echo "========== FABDESK BUILD FAILURE SUMMARY =========="
  echo "no log file: $log"
  echo "========== END SUMMARY =========="
  exit 0
fi

echo "========== FABDESK BUILD FAILURE SUMMARY =========="
echo "log: $log"
failed=0
current=""
first_error=""
flush() {
  if [ -z "$current" ]; then
    return 0
  fi
  echo "FAILED: $current"
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
      first_error=""
      ;;
    *error:*)
      if [ -n "$current" ] && [ -z "$first_error" ]; then
        first_error="$line"
      fi
      ;;
  esac
done < "$log"
flush

if [ "$failed" -eq 0 ]; then
  if grep -qE 'ninja: build stopped|Build failed|error:' "$log"; then
    echo "ninja reported failure; first error lines:"
    grep -E 'error:' "$log" | head -n 20 || true
  else
    echo "no FAILED targets in log"
  fi
else
  echo "failed_targets=$failed"
fi
echo "========== END SUMMARY =========="
