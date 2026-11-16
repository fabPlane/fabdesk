#!/usr/bin/env bash
# Run once after the private repo's plan supports protection, or after public switch.
set -euo pipefail
cd "$(dirname "$0")/.."
repo=fabPlane/fabdesk
actual=$(gh repo view "$repo" --json nameWithOwner --jq .nameWithOwner)
[ "$actual" = "$repo" ] || { echo "Unexpected repository: $actual" >&2; exit 1; }
# GitHub rejects unsupported private-repo plans with 403; do not change visibility.
gh api --method PUT "repos/$repo/branches/main/protection" \
  --input .github/main-protection.json \
  --jq '{url, enforce_admins: .enforce_admins.enabled, checks: .required_status_checks.contexts, force_pushes: .allow_force_pushes.enabled, deletions: .allow_deletions.enabled}'
