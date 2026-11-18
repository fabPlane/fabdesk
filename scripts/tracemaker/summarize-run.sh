#!/usr/bin/env bash
# Write the Actions summary only. Never mutate an immutable release.
set -euo pipefail

linux_result="${TRACEMAKER_LINUX_RESULT:-skipped}"
macos_result="${TRACEMAKER_MACOS_RESULT:-skipped}"
publish_result="${TRACEMAKER_PUBLISH_RESULT:-skipped}"

summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
{
  echo "## TraceMaker binaries"
  echo
  echo "| Platform | Job result |"
  echo "|---|---|"
  echo "| linux-x86_64 | \`${linux_result}\` |"
  echo "| macos-arm64 | \`${macos_result}\` |"
  echo
  echo "Publish: \`${publish_result}\`."
  echo
  echo "Publication requires both Linux and macOS and an explicit publish=true dispatch. Dry runs upload workflow artifacts only; legacy latest pointers remain unchanged."
} >> "$summary"
