#!/usr/bin/env bash
# Resolve an explicitly requested upstream tag or commit.
# Every dispatch gets a new immutable run/attempt tag.
set -euo pipefail

UPSTREAM_REPO="${TRACEMAKER_UPSTREAM_REPO:-DingoOz/TraceMaker}"
API="https://api.github.com/repos/${UPSTREAM_REPO}"
INPUT_REF="${1:-}"
if [ -z "${INPUT_REF//[[:space:]]/}" ]; then
  echo "::error::An explicit upstream tag or commit is required" >&2
  exit 1
fi
UPSTREAM_REF="$INPUT_REF"

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

# run_id + attempt distinguishes retries/rebuilds of the same upstream commit.
BUILD_ID="${GITHUB_RUN_ID:-$(date -u +%Y%m%d%H%M%S)}-${GITHUB_RUN_ATTEMPT:-1}"
RELEASE_TAG="${RELEASE_TAG}-b${BUILD_ID}"

SOURCE_URL="https://github.com/${UPSTREAM_REPO}/archive/${UPSTREAM_COMMIT}.tar.gz"

{
  echo "upstream_repo=$UPSTREAM_REPO"
  echo "upstream_ref=$UPSTREAM_REF"
  echo "upstream_tag=$UPSTREAM_TAG"
  echo "upstream_commit=$UPSTREAM_COMMIT"
  echo "upstream_short=$UPSTREAM_SHORT"
  echo "release_tag=$RELEASE_TAG"
  echo "source_url=$SOURCE_URL"
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
  } >> "$GITHUB_OUTPUT"
fi

echo "Resolved ${UPSTREAM_REPO}@${UPSTREAM_REF} -> ${UPSTREAM_COMMIT} (release ${RELEASE_TAG})"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Resolve"
    echo
    echo "- upstream ref: \`${UPSTREAM_REF}\`"
    echo "- commit: \`${UPSTREAM_COMMIT}\`"
    echo "- release: \`${RELEASE_TAG}\`"
  } >> "$GITHUB_STEP_SUMMARY"
fi
