#!/usr/bin/env bash
# Write the Actions summary only. Never mutate an immutable release.
set -euo pipefail

linux_result="${TRACEMAKER_LINUX_RESULT:-skipped}"
macos_result="${TRACEMAKER_MACOS_RESULT:-skipped}"
windows_result="${TRACEMAKER_WINDOWS_RESULT:-skipped}"
publish_result="${TRACEMAKER_PUBLISH_RESULT:-skipped}"

summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
{
  echo "## TraceMaker binaries"
  echo
  echo "| Platform | Job result |"
  echo "|---|---|"
  echo "| linux-x86_64 | \`${linux_result}\` |"
  echo "| macos-arm64 | \`${macos_result}\` |"
  echo "| windows-x86_64 | \`${windows_result}\` |"
  echo
  echo "Publish: \`${publish_result}\`."
  echo
  echo "Windows is best-effort (MSYS2 UCRT64, no upstream preset). A Windows failure does not block linux/macos or fail this workflow. Retry missing platforms with a new manual dispatch; each dispatch creates a fresh immutable version."
} >> "$summary"
