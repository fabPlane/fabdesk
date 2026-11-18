#!/usr/bin/env bash
# Single source of truth for platforms the binary workflow is expected to publish.
# Source this file; do not execute it.
#
# Required platforms (linux, macos-arm64) must be present before a release is
# treated as complete. Optional platforms (windows-x86_64) are still built when
# missing, but after TRACEMAKER_OPTIONAL_FAIL_LIMIT consecutive failures they
# can be reported as waived by platform-status helpers. Manual dispatch builds all platforms.
#
# Override in tests:
#   TRACEMAKER_REQUIRED_PLATFORMS
#   TRACEMAKER_OPTIONAL_PLATFORMS
#   TRACEMAKER_EXPECTED_PLATFORMS (space-separated union; defaults to required + optional)
#   TRACEMAKER_OPTIONAL_FAIL_LIMIT (default 3)

TRACEMAKER_REQUIRED_PLATFORMS="${TRACEMAKER_REQUIRED_PLATFORMS:-linux-x86_64 macos-arm64}"
TRACEMAKER_OPTIONAL_PLATFORMS="${TRACEMAKER_OPTIONAL_PLATFORMS:-windows-x86_64}"
if [ -z "${TRACEMAKER_EXPECTED_PLATFORMS:-}" ]; then
  TRACEMAKER_EXPECTED_PLATFORMS="${TRACEMAKER_REQUIRED_PLATFORMS} ${TRACEMAKER_OPTIONAL_PLATFORMS}"
fi
TRACEMAKER_OPTIONAL_FAIL_LIMIT="${TRACEMAKER_OPTIONAL_FAIL_LIMIT:-3}"

_tm_words() {
  # shellcheck disable=SC2086
  printf '%s\n' $1
}

required_platforms() {
  _tm_words "$TRACEMAKER_REQUIRED_PLATFORMS"
}

optional_platforms() {
  _tm_words "$TRACEMAKER_OPTIONAL_PLATFORMS"
}

expected_platforms() {
  _tm_words "$TRACEMAKER_EXPECTED_PLATFORMS"
}

expected_platforms_csv() {
  expected_platforms | paste -sd, -
}

required_platforms_csv() {
  required_platforms | paste -sd, -
}

optional_platforms_csv() {
  optional_platforms | paste -sd, -
}

# Print expected platforms that are missing from a manifest.json (or none).
# A platform counts as published only when its asset names the placer
# (tracemaker-place ships beside tracemaker since the floorplan port), so a
# release packed before that counts as incomplete.
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
# An asset without "placer" predates tracemaker-place in the archive: rebuild it.
published = {a.get("platform") for a in raw.get("assets", []) if isinstance(a, dict) and a.get("placer")}
missing = [p for p in expected if p not in published]
print(" ".join(missing))
PY
}

# Like missing_expected_platforms, but omit optional platforms waived after
# TRACEMAKER_OPTIONAL_FAIL_LIMIT consecutive failures (platform-status.json).
missing_build_platforms() {
  local manifest="${1:?manifest.json}"
  local status="${2:-}"
  EXPECTED="$TRACEMAKER_EXPECTED_PLATFORMS" \
  OPTIONAL="$TRACEMAKER_OPTIONAL_PLATFORMS" \
  LIMIT="$TRACEMAKER_OPTIONAL_FAIL_LIMIT" \
  STATUS="$status" python3 - "$manifest" <<'PY'
import json, os, pathlib, sys

def waived(path, optional, limit):
    if not path:
        return set()
    p = pathlib.Path(path)
    if not p.is_file():
        return set()
    raw = json.loads(p.read_text(encoding="utf-8"))
    rows = raw.get("platforms", raw if isinstance(raw, dict) else {})
    out = set()
    for plat, row in rows.items():
        if plat not in optional:
            continue
        if not isinstance(row, dict):
            continue
        if row.get("status") != "failed":
            continue
        try:
            attempts = int(row.get("attempts") or 0)
        except (TypeError, ValueError):
            attempts = 0
        if attempts >= limit:
            out.add(plat)
    return out

expected = [p for p in os.environ["EXPECTED"].split() if p]
optional = {p for p in os.environ["OPTIONAL"].split() if p}
try:
    limit = int(os.environ.get("LIMIT") or "3")
except ValueError:
    limit = 3
path = pathlib.Path(sys.argv[1])
if not path.is_file():
    missing = expected
else:
    raw = json.loads(path.read_text(encoding="utf-8"))
    published = {a.get("platform") for a in raw.get("assets", []) if isinstance(a, dict) and a.get("placer")}
    missing = [p for p in expected if p not in published]
skip = waived(os.environ.get("STATUS", ""), optional, limit)
print(" ".join(p for p in missing if p not in skip))
PY
}

waived_optional_platforms() {
  local status="${1:-}"
  OPTIONAL="$TRACEMAKER_OPTIONAL_PLATFORMS" \
  LIMIT="$TRACEMAKER_OPTIONAL_FAIL_LIMIT" \
  python3 - "$status" <<'PY'
import json, os, pathlib, sys
optional = {p for p in os.environ["OPTIONAL"].split() if p}
try:
    limit = int(os.environ.get("LIMIT") or "3")
except ValueError:
    limit = 3
path = pathlib.Path(sys.argv[1]) if sys.argv[1] else None
if not path or not path.is_file():
    raise SystemExit(0)
raw = json.loads(path.read_text(encoding="utf-8"))
rows = raw.get("platforms", raw if isinstance(raw, dict) else {})
waived = []
for plat, row in rows.items():
    if plat not in optional or not isinstance(row, dict):
        continue
    if row.get("status") != "failed":
        continue
    try:
        attempts = int(row.get("attempts") or 0)
    except (TypeError, ValueError):
        attempts = 0
    if attempts >= limit:
        waived.append(plat)
print(" ".join(waived))
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
