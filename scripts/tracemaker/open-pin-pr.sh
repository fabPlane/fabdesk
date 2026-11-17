#!/usr/bin/env bash
# Runs only after the public mirror has passed hash verification.
set -euo pipefail
manifest="${1:?public manifest}"
pin=packages/tools/src/routers/tracemaker-pin.json
branch=automation/tracemaker-pin
# Always base the one candidate PR on main, including branch dispatches.
candidate="$(mktemp)"
trap 'rm -f "$candidate"' EXIT
python3 scripts/tracemaker/update-pin.py "$manifest" "$candidate"
gh auth setup-git
git fetch origin main
git checkout -B "$branch" origin/main
cp "$candidate" "$pin"
if git diff --quiet -- "$pin"; then exit 0; fi
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git add "$pin"
git commit -m 'Update TraceMaker to smoke-tested immutable build'
previous="$(git ls-remote --heads origin "refs/heads/$branch" | cut -f1)"
git push --force-with-lease="refs/heads/$branch:$previous" origin "$branch"
body="$(mktemp)"
trap 'rm -f "$body" "$candidate"' EXIT
cat > "$body" <<'EOF'
Update the pinned manifest to an immutable public build of DingoOz/TraceMaker.
Every included platform passed router and placer smoke tests. Archives carry
notices, dependency licenses, and a corresponding-source copy. Public archive
hashes were checked after publication. Merging remains a manual decision.
EOF
number="$(gh pr list --base main --head "$branch" --state open --json number --jq '.[0].number // empty')"
if [ -n "$number" ]; then
  gh pr edit "$number" --title 'Update TraceMaker build pin' --body-file "$body"
else
  gh pr create --base main --head "$branch" --title 'Update TraceMaker build pin' --body-file "$body"
fi
