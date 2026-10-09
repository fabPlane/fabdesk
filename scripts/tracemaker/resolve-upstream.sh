#!/usr/bin/env bash
# Resolve DingoOz/TraceMaker to a commit and skip if fabdesk already published it.
set -euo pipefail

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

SKIP=false
if command -v gh >/dev/null && [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
  if gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
    SKIP=true
  fi
fi

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
  } >> "$GITHUB_OUTPUT"
fi

echo "Resolved ${UPSTREAM_REPO}@${UPSTREAM_REF} -> ${UPSTREAM_COMMIT} (release ${RELEASE_TAG}, skip=${SKIP})"
