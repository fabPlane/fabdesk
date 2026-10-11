#!/usr/bin/env bash
# Write the weekly job summary and, when Windows failed, increment
# platform-status.json on the immutable GitHub release. Never exits non-zero
# for a missing Windows binary: required platforms stay published.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=platforms.sh
source "$SCRIPT_DIR/platforms.sh"

release_tag="${TRACEMAKER_RELEASE_TAG:-}"
repo="${GITHUB_REPOSITORY:-TensorFleet/fabdesk}"
linux_result="${TRACEMAKER_LINUX_RESULT:-skipped}"
macos_result="${TRACEMAKER_MACOS_RESULT:-skipped}"
windows_result="${TRACEMAKER_WINDOWS_RESULT:-skipped}"
publish_result="${TRACEMAKER_PUBLISH_RESULT:-skipped}"
missing="${TRACEMAKER_MISSING_PLATFORMS:-}"
published="${TRACEMAKER_PUBLISHED_PLATFORMS:-}"

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
  echo "Publish: \`${publish_result}\`. Previously published: \`${published:-none}\`. Missing this run: \`${missing:-none}\`."
  echo
  echo "Windows is best-effort (MSYS2 UCRT64, no upstream preset). A Windows failure does not block linux/macos or fail this workflow. After ${TRACEMAKER_OPTIONAL_FAIL_LIMIT} consecutive Windows failures on the same immutable tag, Windows is waived so the weekly run can skip instead of looping."
} >> "$summary"

if [ -z "$release_tag" ] || [ -z "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
  echo "summarize-run: no release tag or token; skipped platform-status.json"
  exit 0
fi

if ! command -v gh >/dev/null; then
  echo "summarize-run: gh not on PATH"
  exit 0
fi

if ! gh release view "$release_tag" --repo "$repo" >/dev/null 2>&1; then
  echo "summarize-run: ${release_tag} does not exist yet; no status file to update"
  exit 0
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/tm-status.XXXXXX")"
trap 'rm -rf "$work"' EXIT
status="$work/platform-status.json"
if gh release download "$release_tag" --repo "$repo" --pattern platform-status.json --dir "$work" 2>/dev/null \
  && [ -f "$status" ]; then
  echo "Loaded existing platform-status.json"
else
  printf '%s\n' '{"platforms":{}}' > "$status"
fi

WINDOWS_RESULT="$windows_result" NOW="$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
LIMIT="$TRACEMAKER_OPTIONAL_FAIL_LIMIT" python3 - "$status" <<'PY'
import json, os, pathlib, sys
path = pathlib.Path(sys.argv[1])
raw = json.loads(path.read_text(encoding="utf-8"))
if "platforms" not in raw or not isinstance(raw["platforms"], dict):
    raw["platforms"] = {}
result = os.environ.get("WINDOWS_RESULT", "skipped")
now = os.environ["NOW"]
row = raw["platforms"].get("windows-x86_64")
if not isinstance(row, dict):
    row = {}
if result == "success":
    raw["platforms"].pop("windows-x86_64", None)
elif result == "failure":
    attempts = int(row.get("attempts") or 0) + 1
    raw["platforms"]["windows-x86_64"] = {
        "status": "failed",
        "attempts": attempts,
        "updatedAt": now,
        "note": "build-windows failed; linux/macos stay published",
    }
raw["updatedAt"] = now
path.write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")
print(json.dumps(raw, indent=2))
PY

if [ "$windows_result" = "success" ] || [ "$windows_result" = "failure" ]; then
  gh release upload "$release_tag" "$status" --repo "$repo" --clobber
  echo "Updated platform-status.json on ${release_tag}"
fi

waived="$(waived_optional_platforms "$status" || true)"
if [ -n "$waived" ]; then
  echo "Waived optional platforms (will not rebuild until force=true): ${waived}" >> "$summary"
fi
exit 0
