#!/usr/bin/env bash
# Single source of truth for platforms the weekly workflow is expected to publish.
# Source this file; do not execute it.
#
# Override with TRACEMAKER_EXPECTED_PLATFORMS (space-separated) in tests.

TRACEMAKER_EXPECTED_PLATFORMS="${TRACEMAKER_EXPECTED_PLATFORMS:-linux-x86_64 macos-arm64}"

expected_platforms() {
  # shellcheck disable=SC2086
  printf '%s\n' $TRACEMAKER_EXPECTED_PLATFORMS
}

expected_platforms_csv() {
  expected_platforms | paste -sd, -
}

# Print expected platforms that are missing from a manifest.json (or none).
missing_expected_platforms() {
  local manifest="${1:?manifest.json}"
  EXPECTED="$TRACEMAKER_EXPECTED_PLATFORMS" python3 - "$manifest" <<'PY'
import json, os, pathlib, sys
expected = [p for p in os.environ["EXPECTED"].split() if p]
path = pathlib.Path(sys.argv[1])
if not path.is_file():
    print(" ".join(expected))
    raise SystemExit(0)
raw = json.loads(path.read_text(encoding="utf-8"))
published = {a.get("platform") for a in raw.get("assets", []) if isinstance(a, dict)}
missing = [p for p in expected if p not in published]
print(" ".join(missing))
PY
}

published_platforms_from_manifest() {
  local manifest="${1:?manifest.json}"
  python3 - "$manifest" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
if not path.is_file():
    raise SystemExit(0)
raw = json.loads(path.read_text(encoding="utf-8"))
plats = sorted({a.get("platform") for a in raw.get("assets", []) if isinstance(a, dict) and a.get("platform")})
print(" ".join(plats))
PY
}

force_rebuild_requested() {
  case "${TRACEMAKER_FORCE:-}" in
    1|true|TRUE|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}
