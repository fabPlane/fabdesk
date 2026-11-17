#!/usr/bin/env bash
# Resolve the newest stable upstream release, or an explicit dispatch ref.
# A complete pin skips; every actual build gets a new immutable run/attempt tag.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=platforms.sh
source "$SCRIPT_DIR/platforms.sh"

UPSTREAM_REPO="${TRACEMAKER_UPSTREAM_REPO:-DingoOz/TraceMaker}"
API="https://api.github.com/repos/${UPSTREAM_REPO}"
INPUT_REF="${1:-}"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-fabPlane/fabdesk}"

github_json() {
  local url="$1"
  if [ -n "${GITHUB_TOKEN:-}${GH_TOKEN:-}" ]; then
    curl -fsSL -H "Accept: application/vnd.github+json" \
      -H "Authorization: Bearer ${GITHUB_TOKEN:-$GH_TOKEN}" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "$url"
  else
    curl -fsSL -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "$url"
  fi
}

# Scheduled runs follow upstream's newest published release, never a branch HEAD.
PIN_FILE="${TRACEMAKER_PIN_FILE:-$SCRIPT_DIR/../../packages/tools/src/routers/tracemaker-pin.json}"
if [ -n "$INPUT_REF" ]; then
  UPSTREAM_REF="$INPUT_REF"
else
  UPSTREAM_REF="$(github_json "${API}/releases/latest" | jq -er '.tag_name')"
  # Never downgrade a newer reviewed pin when upstream's latest pointer moves
  # backwards. An incomplete newer pin rebuilds its own upstream tag.
  UPSTREAM_REF="$(python3 - "$PIN_FILE" "$UPSTREAM_REF" <<'PYVERSION'
import json, re, sys
pin = json.load(open(sys.argv[1]))['upstream']['tag']
latest = sys.argv[2]
def version(tag):
    match = re.fullmatch(r'v?(\d+)\.(\d+)\.(\d+)', tag)
    if not match:
        raise ValueError(f'Expected stable release version: {tag}')
    return tuple(map(int, match.groups()))
print(pin if version(pin) > version(latest) else latest)
PYVERSION
)"
fi

COMMIT_JSON="$(github_json "${API}/commits/$(printf '%s' "$UPSTREAM_REF" | jq -sRr @uri)")"
UPSTREAM_COMMIT="$(printf '%s' "$COMMIT_JSON" | jq -r '.sha')"
if [ -z "$UPSTREAM_COMMIT" ] || [ "$UPSTREAM_COMMIT" = "null" ]; then
  echo "::error::Could not resolve ${UPSTREAM_REPO}@${UPSTREAM_REF} to a commit" >&2
  exit 1
fi
UPSTREAM_SHORT="${UPSTREAM_COMMIT:0:7}"

# Prefer an annotated/lightweight tag name when the input is a tag; otherwise sanitize.
if [[ "$UPSTREAM_REF" =~ ^v?[0-9]+\.[0-9]+ ]]; then
  UPSTREAM_TAG="$UPSTREAM_REF"
  RELEASE_TAG="tracemaker-${UPSTREAM_TAG}-${UPSTREAM_SHORT}"
elif [[ "$UPSTREAM_REF" =~ ^[0-9a-f]{7,40}$ ]]; then
  UPSTREAM_TAG="$UPSTREAM_SHORT"
  RELEASE_TAG="tracemaker-${UPSTREAM_SHORT}"
else
  UPSTREAM_TAG="$(printf '%s' "$UPSTREAM_REF" | tr '/ ' '--')"
  RELEASE_TAG="tracemaker-${UPSTREAM_TAG}-${UPSTREAM_SHORT}"
fi

FORCE=false
if force_rebuild_requested; then
  FORCE=true
fi

EXPECTED_CSV="$(expected_platforms_csv)"
MISSING="$(expected_platforms | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
PUBLISHED=""
WAIVED=""
SKIP=false
RELEASE_EXISTS=false

# Skip only a complete pin of this commit. Missing placer/platform triggers a
# whole new build; a versioned manifest is never extended in place.
PIN_COMMIT="$(jq -er '.upstream.commit' "$PIN_FILE")"
if [ "$FORCE" != true ] && [ "$PIN_COMMIT" = "$UPSTREAM_COMMIT" ] && [ -z "$(missing_expected_platforms "$PIN_FILE")" ]; then
  SKIP=true
  MISSING=""
fi
# run_id + attempt distinguishes retries/rebuilds of the same upstream commit.
BUILD_ID="${GITHUB_RUN_ID:-$(date -u +%Y%m%d%H%M%S)}-${GITHUB_RUN_ATTEMPT:-1}"
RELEASE_TAG="${RELEASE_TAG}-b${BUILD_ID}"

MISSING_CSV="$(printf '%s' "$MISSING" | tr ' ' ',')"
PUBLISHED_CSV="$(printf '%s' "$PUBLISHED" | tr ' ' ',')"

SOURCE_URL="https://github.com/${UPSTREAM_REPO}/archive/${UPSTREAM_COMMIT}.tar.gz"

{
  echo "upstream_repo=$UPSTREAM_REPO"
  echo "upstream_ref=$UPSTREAM_REF"
  echo "upstream_tag=$UPSTREAM_TAG"
  echo "upstream_commit=$UPSTREAM_COMMIT"
  echo "upstream_short=$UPSTREAM_SHORT"
  echo "release_tag=$RELEASE_TAG"
  echo "source_url=$SOURCE_URL"
  echo "skip=$SKIP"
  echo "force=$FORCE"
  echo "release_exists=$RELEASE_EXISTS"
  echo "expected_platforms=$EXPECTED_CSV"
  echo "missing_platforms=$MISSING_CSV"
  echo "published_platforms=$PUBLISHED_CSV"
  echo "waived_platforms=${WAIVED}"
}

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "upstream_repo=$UPSTREAM_REPO"
    echo "upstream_ref=$UPSTREAM_REF"
    echo "upstream_tag=$UPSTREAM_TAG"
    echo "upstream_commit=$UPSTREAM_COMMIT"
    echo "upstream_short=$UPSTREAM_SHORT"
    echo "release_tag=$RELEASE_TAG"
    echo "source_url=$SOURCE_URL"
    echo "skip=$SKIP"
    echo "force=$FORCE"
    echo "release_exists=$RELEASE_EXISTS"
    echo "expected_platforms=$EXPECTED_CSV"
    echo "missing_platforms=$MISSING_CSV"
    echo "published_platforms=$PUBLISHED_CSV"
    echo "waived_platforms=${WAIVED}"
  } >> "$GITHUB_OUTPUT"
fi

echo "Resolved ${UPSTREAM_REPO}@${UPSTREAM_REF} -> ${UPSTREAM_COMMIT} (release ${RELEASE_TAG}, skip=${SKIP}, missing=${MISSING_CSV:-none}, waived=${WAIVED:-none}, force=${FORCE}, release_exists=${RELEASE_EXISTS})"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Resolve"
    echo
    echo "- release: \`${RELEASE_TAG}\`"
    echo "- skip: \`${SKIP}\`"
    echo "- release exists: \`${RELEASE_EXISTS}\`"
    echo "- published: \`${PUBLISHED:-none}\`"
    echo "- missing (will build): \`${MISSING:-none}\`"
    echo "- waived optional: \`${WAIVED:-none}\`"
  } >> "$GITHUB_STEP_SUMMARY"
fi
