#!/usr/bin/env bash
# Resolve DingoOz/TraceMaker to a commit. Skip only when the immutable fabdesk
# release already lists every expected platform that is still scheduled to
# build (unless TRACEMAKER_FORCE=1). Optional platforms (windows-x86_64) that
# have failed TRACEMAKER_OPTIONAL_FAIL_LIMIT times are waived so the weekly
# run does not loop red forever; force rebuilds them again.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=platforms.sh
source "$SCRIPT_DIR/platforms.sh"

UPSTREAM_REPO="${TRACEMAKER_UPSTREAM_REPO:-DingoOz/TraceMaker}"
API="https://api.github.com/repos/${UPSTREAM_REPO}"
INPUT_REF="${1:-}"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-TensorFleet/fabdesk}"

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

if [ -n "$INPUT_REF" ]; then
  UPSTREAM_REF="$INPUT_REF"
else
  UPSTREAM_REF="$(github_json "${API}/releases/latest" | jq -r '.tag_name // empty' || true)"
  if [ -z "$UPSTREAM_REF" ]; then
    UPSTREAM_REF="$(github_json "$API" | jq -r '.default_branch')"
  fi
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

if [ "$FORCE" = true ]; then
  echo "Force rebuild requested; ignoring any existing ${RELEASE_TAG} assets and Windows waivers."
fi

# Record whether the immutable tag exists even when force skips the
# missing-platform calculation. The public mirror job still runs for an
# existing release (including when this run rebuilds nothing).
if command -v gh >/dev/null && [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
  if gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
    RELEASE_EXISTS=true
  fi
fi

if [ "$FORCE" != true ] && [ "$RELEASE_EXISTS" = true ]; then
  work="$(mktemp -d "${TMPDIR:-/tmp}/tm-resolve.XXXXXX")"
  trap 'rm -rf "$work"' EXIT
  status_file=""
  if gh release download "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --pattern platform-status.json --dir "$work" 2>/dev/null \
    && [ -f "$work/platform-status.json" ]; then
    status_file="$work/platform-status.json"
    WAIVED="$(waived_optional_platforms "$status_file")"
  fi
  if gh release download "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --pattern manifest.json --dir "$work" 2>/dev/null \
    && [ -f "$work/manifest.json" ]; then
    PUBLISHED="$(published_platforms_from_manifest "$work/manifest.json")"
    if [ -n "$status_file" ]; then
      MISSING="$(missing_build_platforms "$work/manifest.json" "$status_file")"
    else
      MISSING="$(missing_expected_platforms "$work/manifest.json")"
    fi
    if [ -z "$MISSING" ]; then
      SKIP=true
      if [ -n "$WAIVED" ]; then
        echo "Immutable release ${RELEASE_TAG} is complete for required platforms (have: ${PUBLISHED:-none}); waived optional: ${WAIVED}. Public mirror still runs."
      else
        echo "Immutable release ${RELEASE_TAG} already has every expected platform. Skipping rebuilds; public mirror still runs."
      fi
    else
      echo "Immutable release ${RELEASE_TAG} is incomplete (have: ${PUBLISHED:-none}; missing: ${MISSING}${WAIVED:+; waived: ${WAIVED}})."
    fi
  else
    echo "Immutable release ${RELEASE_TAG} exists but has no manifest.json; treating every expected platform as missing."
  fi
fi

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
